// Claude.ai plan usage limits, as Claude Code reports them in its status line input.
//
// Claude Code passes `rate_limits` to the status line command for Pro/Max
// subscribers after the first API response: `five_hour` (the current session)
// and `seven_day` (the week), each with `used_percentage` (0–100) and
// `resets_at` (Unix seconds). Either window can be missing. The limits belong
// to the account, so any pane's latest report stands for all of them.

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface LimitWindow {
  /** 0–100. */
  usedPercent: number;
  /** ms since epoch, or null when Claude did not say. */
  resetsAt: number | null;
}

export interface UsageLimits {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** When the report arrived (ms). */
  observedAt: number;
}

function limitWindow(v: unknown): LimitWindow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const used = o.used_percentage;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  const resets = o.resets_at;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt: typeof resets === 'number' && Number.isFinite(resets) && resets > 0 ? resets * 1000 : null,
  };
}

/** The limits in one status line input, or null when it carries none. */
export function parseUsageLimits(body: unknown, now: number): UsageLimits | null {
  const rl = body && typeof body === 'object' ? (body as Record<string, unknown>).rate_limits : undefined;
  if (!rl || typeof rl !== 'object') return null;
  const o = rl as Record<string, unknown>;
  const fiveHour = limitWindow(o.five_hour);
  const sevenDay = limitWindow(o.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay, observedAt: now } : null;
}

/**
 * The report the Usage Meter's status line keeps in `<home>/.paneherd-meter/status.json`, stamped
 * with when the file was written. Claude Code sessions outside a pane write it too, so it can be
 * newer than the last report a pane sent. Paneherd also writes here when a pane reports, so the
 * Usage Meter stays current. `rateLimits` is the raw object, for storing.
 */
export async function readMeterReport(home: string): Promise<{ limits: UsageLimits; rateLimits: unknown } | null> {
  const file = path.join(home, '.paneherd-meter', 'status.json');
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const body: unknown = JSON.parse(text.replace(/^﻿/, ''));
    const limits = parseUsageLimits(body, info.mtimeMs);
    return limits ? { limits, rateLimits: (body as { rate_limits: unknown }).rate_limits } : null;
  } catch {
    return null;
  }
}

/**
 * Save `rate_limits` for the Usage Meter (and for Paneherd's own poll). Written beside the file and
 * moved over it, so a reader never sees a half-written report. No-op when `rateLimits` is missing.
 */
export async function writeMeterReport(home: string, rateLimits: unknown): Promise<void> {
  if (rateLimits === undefined || rateLimits === null || typeof rateLimits !== 'object') return;
  const dir = path.join(home, '.paneherd-meter');
  const file = path.join(dir, 'status.json');
  const text = JSON.stringify({ rate_limits: rateLimits });
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}`;
  await writeFile(tmp, text);
  try {
    await rename(tmp, file);
  } catch {
    try {
      await writeFile(file, text);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
}

/** A window whose reset time has passed no longer says anything about current usage. */
export function isWindowCurrent(w: LimitWindow, now: number): boolean {
  return w.resetsAt === null || w.resetsAt > now;
}

/**
 * The Usage Meter extension's own status line, which only saves Claude's input to a file. A pane's
 * --settings status line can stand in for it. One that wraps the user's command (its input is piped
 * on into `( … )`) is theirs, and stays.
 */
function isUsageMeterOnly(value: unknown): boolean {
  const command = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).command : undefined;
  return typeof command === 'string' && command.includes('.paneherd-meter') && !command.includes('| (');
}

export type OwnStatusLine =
  | { kind: 'none' }
  | { kind: 'set'; file: string }
  /** A settings file could not be read as JSON, so whether it sets one is unknown. */
  | { kind: 'unknown'; file: string };

/**
 * Whether the user or the project configures a status line of its own. A pane's
 * --settings status line would replace it, so the grid installs one only on "none".
 */
export async function findOwnStatusLine(configDir: string, cwd: string): Promise<OwnStatusLine> {
  const files = [path.join(configDir, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { kind: 'unknown', file };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      return { kind: 'unknown', file };
    }
    const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).statusLine : undefined;
    if (value !== undefined && value !== null && !isUsageMeterOnly(value)) return { kind: 'set', file };
  }
  return { kind: 'none' };
}
