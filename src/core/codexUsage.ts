// Codex plan usage limits, as Codex records them in its session logs.
//
// Codex writes each session to <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl.
// After every response a `token_count` event carries `rate_limits`: `primary`
// and `secondary` windows, each with `used_percent` (0–100), `window_minutes`
// and `resets_at` (Unix seconds; older Codex wrote `resets_in_seconds`). The
// limits are the account's, so the newest report in any session stands for all.

import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LimitWindow } from './usageLimits.ts';

export interface CodexLimitWindow extends LimitWindow {
  /** Length of the window, or null when Codex did not say. */
  windowMinutes: number | null;
}

export interface CodexLimits {
  /** Primary first; one or two. */
  windows: CodexLimitWindow[];
  /** When Codex wrote the report (ms). */
  observedAt: number;
}

/** Where Codex keeps its sessions: $CODEX_HOME/sessions, else ~/.codex/sessions. */
export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const codexHome = env.CODEX_HOME?.trim();
  return path.join(codexHome || path.join(home, '.codex'), 'sessions');
}

function codexWindow(v: unknown, observedAt: number): CodexLimitWindow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const used = o.used_percent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
  const at = num(o.resets_at);
  const inSeconds = num(o.resets_in_seconds);
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt: at !== null ? at * 1000 : inSeconds !== null ? observedAt + inSeconds * 1000 : null,
    windowMinutes: num(o.window_minutes),
  };
}

/** The limits in one rollout line, or null when it carries none. */
export function parseCodexLimits(line: string): CodexLimits | null {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (!e || typeof e !== 'object') return null;
  const entry = e as Record<string, unknown>;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'token_count') return null;
  const rl = payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(time)) return null;
  const o = rl as Record<string, unknown>;
  const windows = [codexWindow(o.primary, time), codexWindow(o.secondary, time)].filter((w): w is CodexLimitWindow => w !== null);
  return windows.length ? { windows, observedAt: time } : null;
}

/** How many of the newest day folders are looked through; a session resumed from longer ago is missed. */
const DAYS = 14;
const TAIL = 256 * 1024;
const MAX_TAIL = 4 * 1024 * 1024;

/** The last limits report in a file, read from the end. */
async function lastLimits(file: string, size: number): Promise<CodexLimits | null> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    for (let len = Math.min(TAIL, size); ; len = Math.min(len * 4, size, MAX_TAIL)) {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, size - len);
      const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
      // The first line may be cut off, unless the read started at the beginning.
      const from = len < size ? 1 : 0;
      for (let i = lines.length - 1; i >= from; i--) {
        const line = lines[i]!;
        if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) continue;
        const limits = parseCodexLimits(line);
        if (limits) return limits;
      }
      if (len >= size || len >= MAX_TAIL) return null;
    }
  } finally {
    await fh.close();
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

interface Read {
  mtime: number;
  size: number;
  limits: CodexLimits | null;
}

/**
 * The newest limits Codex has written. Reads only the session that changed last,
 * and only again once it changes.
 */
export class CodexLimitsReader {
  readonly #dir: string;
  #read = new Map<string, Read>();

  constructor(sessionsDir: string) {
    this.#dir = sessionsDir;
  }

  async read(): Promise<CodexLimits | null> {
    const files: { file: string; mtime: number; size: number }[] = [];
    let days = 0;
    outer: for (const y of await subdirs(this.#dir)) {
      for (const m of await subdirs(path.join(this.#dir, y))) {
        for (const d of await subdirs(path.join(this.#dir, y, m))) {
          const day = path.join(this.#dir, y, m, d);
          let names: string[];
          try {
            names = await readdir(day);
          } catch {
            continue;
          }
          for (const name of names) {
            if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
            const file = path.join(day, name);
            try {
              const s = await stat(file);
              files.push({ file, mtime: s.mtimeMs, size: s.size });
            } catch {
              // Removed while listing.
            }
          }
          if (++days >= DAYS) break outer;
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    // A session with an API key, or one that has not had a reply yet, has no limits: try the next.
    const seen = new Map<string, Read>();
    try {
      for (const f of files.slice(0, 5)) {
        const known = this.#read.get(f.file);
        const r = known && known.mtime === f.mtime && known.size === f.size ? known : { ...f, limits: await lastLimits(f.file, f.size) };
        seen.set(f.file, r);
        if (r.limits) return r.limits;
      }
      return null;
    } finally {
      this.#read = seen;
    }
  }
}
