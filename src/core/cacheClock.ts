// When a session's prompt cache runs out, and what coming back after that costs.
//
// Claude Code sends the whole conversation with every request. While the prompt
// cache is warm those tokens are billed at a tenth of the input price; once it has
// expired the next request writes them again at 1.25 times (5-minute cache) or 2
// times (1-hour cache) the price. Each response in the transcript says which of
// the two it wrote, so the lifetime is read from the data, not assumed.
//
// A response that reads the cache refreshes it, so the cache ends one lifetime
// after the last response. The cost is a ratio to a warm turn plus the number of
// tokens that would be written again; turning that into a share of the plan's limit
// needs the window's own weights, which the caller has (see usageForecast).

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { messageUsage, parseLine, type MessageUsage } from './transcript.ts';

export const CACHE_5M_MS = 5 * 60_000;
export const CACHE_1H_MS = 60 * 60_000;

/** Price of cached input relative to plain input, and of a cache write by lifetime. */
const READ = 0.1;
const WRITE_5M = 1.25;
const WRITE_1H = 2;

export interface CacheClock {
  /** Time of the response that last used or wrote the cache (ms). */
  lastAt: number;
  ttlMs: number;
  /** When the cache runs out (ms). */
  expiresAt: number;
  /** Tokens the next request sends as context. */
  contextTokens: number;
  model: string | null;
}

/** The clock for a session from its responses, oldest first; null when none carries usage. */
export function cacheClock(usages: readonly MessageUsage[]): CacheClock | null {
  const last = usages.at(-1);
  if (!last) return null;
  let ttlMs = CACHE_5M_MS;
  for (let i = usages.length - 1; i >= Math.max(0, usages.length - 12); i--) {
    const t = usages[i]!.tokens;
    if (t.cacheWrite1h > 0) {
      ttlMs = CACHE_1H_MS;
      break;
    }
    if (t.cacheWrite5m > 0) break;
  }
  const t = last.tokens;
  return { lastAt: last.time, ttlMs, expiresAt: last.time + ttlMs, contextTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead, model: last.model };
}

export type CacheState = 'warm' | 'expiring' | 'cold';

/** `expiring` in the last minute or a fifth of the lifetime, whichever is shorter. */
export function cacheState(c: CacheClock, now: number): CacheState {
  if (now >= c.expiresAt) return 'cold';
  return c.expiresAt - now <= Math.min(60_000, c.ttlMs / 5) ? 'expiring' : 'warm';
}

export interface ColdCost {
  /** Tokens written again instead of read. */
  rewrittenTokens: number;
  /** What the next request costs relative to the same request with a warm cache, for the context alone. */
  timesWarm: number;
  /** Extra cost over a warm request, in input tokens of the model's own price. */
  extraInputTokens: number;
}

/** The cost of the next request if the cache has run out; null when there is no context to rewrite. */
export function coldCost(c: CacheClock): ColdCost | null {
  if (c.contextTokens <= 0) return null;
  const write = c.ttlMs >= CACHE_1H_MS ? WRITE_1H : WRITE_5M;
  return { rewrittenTokens: c.contextTokens, timesWarm: write / READ, extraInputTokens: c.contextTokens * (write - READ) };
}

const TAIL = 2 * 1024 * 1024;

/** The clock of the session in a transcript, read from the end of the file. */
export async function readCacheClock(file: string): Promise<CacheClock | null> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - TAIL);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    // A read that starts mid-file begins with a partial line.
    if (start > 0) lines.shift();
    const byId = new Map<string, MessageUsage>();
    for (const line of lines) {
      const e = parseLine(line);
      const u = e && e.isSidechain !== true ? messageUsage(e) : null;
      if (u) byId.set(u.id, u);
    }
    return cacheClock([...byId.values()].sort((a, b) => a.time - b.time));
  } finally {
    await fh.close();
  }
}

/**
 * The transcript written to most recently under Claude Code's projects folder: the
 * session the user is working in. Subagent transcripts sit deeper and are not looked at.
 * Null when none changed within `withinMs`.
 */
export async function latestTranscript(projectsDir: string, now = Date.now(), withinMs = 6 * 3600_000): Promise<{ file: string; mtimeMs: number } | null> {
  let best: { file: string; mtimeMs: number } | null = null;
  const dirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const m = await stat(file).then((x) => x.mtimeMs, () => 0);
      if (m >= now - withinMs && (!best || m > best.mtimeMs)) best = { file, mtimeMs: m };
    }
  }
  return best;
}
