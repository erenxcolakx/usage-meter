// How the limits read in the status bar and its tooltip.

import { cacheState, coldCost, type CacheClock, type CodexLimits, type LimitWindow, type UsageLimits } from './core/index.ts';

export interface MeterWindow {
  /** "5h", "7d" or similar. */
  label: string;
  /** "5-hour", "Weekly" or similar. */
  name: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface MeterAgent {
  agent: 'Claude' | 'Codex';
  windows: MeterWindow[];
}

const current = (w: LimitWindow, now: number): boolean => w.resetsAt === null || w.resetsAt > now;

/** "5h" for 300 minutes, "7d" for a week, "90m" for odd ones. */
export function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const NAMES: Record<string, string> = { '5h': '5-hour', '7d': 'Weekly' };

export function claudeAgent(l: UsageLimits | null, now: number): MeterAgent | null {
  if (!l) return null;
  const windows: MeterWindow[] = [];
  if (l.fiveHour && current(l.fiveHour, now)) windows.push({ label: '5h', name: '5-hour', ...l.fiveHour });
  if (l.sevenDay && current(l.sevenDay, now)) windows.push({ label: '7d', name: 'Weekly', ...l.sevenDay });
  return windows.length ? { agent: 'Claude', windows } : null;
}

export function codexAgent(l: CodexLimits | null, now: number): MeterAgent | null {
  if (!l) return null;
  const windows = l.windows
    .filter((w) => current(w, now))
    .map((w, i): MeterWindow => {
      const label = windowLabel(w.windowMinutes, i === 0 ? 'now' : 'week');
      return { label, name: NAMES[label] ?? label, usedPercent: w.usedPercent, resetsAt: w.resetsAt };
    });
  return windows.length ? { agent: 'Codex', windows } : null;
}

const pct = (n: number): string => `${Math.round(n)}%`;

/** "Claude 5h 32% 7d 14%   Codex 5h 8%". */
export function statusText(agents: MeterAgent[]): string {
  return agents.map((a) => `${a.agent} ${a.windows.map((w) => `${w.label} ${pct(w.usedPercent)}`).join(' ')}`).join('   ');
}

/** The highest percentage anywhere, for coloring the item. */
export function highest(agents: MeterAgent[]): number {
  return agents.reduce((m, a) => a.windows.reduce((n, w) => Math.max(n, w.usedPercent), m), 0);
}

/** "resets in 2h 14m", "resets in 3d 4h", "resets in 5m", "resets now". */
export function untilReset(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'reset time unknown';
  const min = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (min < 1) return 'resets now';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return `resets in ${d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

/** One line per window, for the tooltip and the quick pick. */
export function windowLine(w: MeterWindow, now: number): string {
  return `${w.name}: ${pct(w.usedPercent)} used · ${untilReset(w.resetsAt, now)}`;
}

/**
 * Windows that crossed `warnAt` and were not warned about yet. A window is
 * identified by its reset time, so the next one warns again.
 */
export function newWarnings(agents: MeterAgent[], warnAt: number, warned: Set<string>, now: number): string[] {
  if (warnAt <= 0) return [];
  const out: string[] = [];
  for (const a of agents) {
    for (const w of a.windows) {
      const key = `${a.agent}:${w.label}:${w.resetsAt ?? 'none'}`;
      if (w.usedPercent < warnAt || warned.has(key)) continue;
      warned.add(key);
      out.push(`${a.agent}: ${pct(w.usedPercent)} of the ${w.name.toLowerCase()} limit used, ${untilReset(w.resetsAt, now)}.`);
    }
  }
  return out;
}

/** Cache minutes shown in the status bar itself: only this close to the end, so a warm cache stays out of the way. */
export const CACHE_BAR_MINUTES = 10;
/** A cache that ran out this long ago belongs to a session nobody is working in; it is not worth a mention. */
const CACHE_DORMANT_MS = 6 * 3600_000;

function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min >= 120 ? `${Math.round(min / 60)} h` : min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** "cache 4 min" or "cache cold" for the status bar, or null while it has no need to be there. */
export function cacheBarText(c: CacheClock | null, now: number): string | null {
  if (!c) return null;
  const left = c.expiresAt - now;
  if (left > 0) return left <= CACHE_BAR_MINUTES * 60_000 ? `cache ${span(left)}` : null;
  return -left <= CACHE_DORMANT_MS ? 'cache cold' : null;
}

/** Tooltip and quick-pick lines about the prompt cache; empty when there is no session to talk about. */
export function cacheLines(c: CacheClock | null, now: number): string[] {
  if (!c) return [];
  const state = cacheState(c, now);
  const cost = coldCost(c);
  const rewrite = cost ? `the next reply sends ${thousands(cost.rewrittenTokens)} tokens of context again at ${cost.timesWarm}× the price of a warm one` : null;
  if (state === 'cold') {
    const ago = now - c.expiresAt;
    return ago > CACHE_DORMANT_MS ? [] : [`Prompt cache: ran out ${span(ago)} ago${rewrite ? `; ${rewrite}` : ''}.`];
  }
  const head = `Prompt cache: ${state === 'expiring' ? 'about to run out' : 'warm'}, runs out in ${span(c.expiresAt - now)} (${c.ttlMs >= 3600_000 ? '1-hour' : '5-minute'} cache).`;
  return rewrite ? [head, `After that, ${rewrite}.`] : [head];
}
