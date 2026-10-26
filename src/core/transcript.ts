// Claude Code transcripts: <config>/projects/<dir>/<uuid>.jsonl, one JSON entry per line.
//
// The format is owned by Claude Code. This module is the one place that finds the
// files and decides what an entry means, so the session list and content search
// agree on which text is conversation (what the human typed and what Claude wrote
// back) and which is tool traffic, metadata or bookkeeping.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Entry {
  type?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  isMeta?: unknown;
  /** Subagent traffic recorded in the parent transcript. */
  isSidechain?: unknown;
  /** The summary Claude Code writes when it compacts a conversation. */
  isCompactSummary?: unknown;
  customTitle?: unknown;
  aiTitle?: unknown;
  lastPrompt?: unknown;
  message?: { content?: unknown; id?: unknown; model?: unknown; usage?: unknown };
}

export interface TranscriptFile {
  id: string;
  file: string;
  size: number;
  mtime: number;
}

/** Every session transcript under `projectsDir`, most recently modified first. */
export async function transcriptFiles(projectsDir: string): Promise<TranscriptFile[]> {
  let dirs;
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const full = path.join(projectsDir, d.name);
    let entries;
    try {
      entries = await readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const id = f.name.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(id)) continue;
      const file = path.join(full, f.name);
      try {
        const st = await stat(file);
        files.push({ id, file, size: st.size, mtime: st.mtimeMs });
      } catch {
        // removed between readdir and stat
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

export function parseLines(text: string, dropFirst: boolean): Entry[] {
  const lines = text.split(/\r?\n/);
  if (dropFirst) lines.shift(); // starts mid-line
  const out: Entry[] = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (e) out.push(e);
  }
  return out;
}

/** One transcript line, or null for a blank, truncated or non-object line. */
export function parseLine(line: string): Entry | null {
  if (!line) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Entry) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function textBlocks(c: unknown[], sep: string): string {
  return c
    .filter((x): x is { type: 'text'; text: string } => (x as { type?: unknown })?.type === 'text' && typeof (x as { text?: unknown }).text === 'string')
    .map((x) => x.text)
    .join(sep);
}

/** Text the human typed, or '' for tool results, meta, subagent and compaction entries and local-command wrappers. */
export function humanText(e: Entry): string {
  if (e.type !== 'user' || e.isMeta === true || e.isSidechain === true || e.isCompactSummary === true) return '';
  const c = e.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && !c.some((x) => (x as { type?: unknown })?.type === 'tool_result')) text = textBlocks(c, ' ');
  // Slash commands and their output are recorded as <command-name>… / <local-command-…> wrappers.
  return text.startsWith('<') ? '' : text;
}

/** What Claude wrote back to the human: its text blocks, not thinking or tool calls. */
export function assistantText(e: Entry): string {
  if (e.type !== 'assistant' || e.isSidechain === true) return '';
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? textBlocks(c, '\n\n') : '';
}

/** Entry time in ms since epoch, or null when absent or unparseable. */
export function entryTime(e: Entry): number | null {
  const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

export interface TokenCounts {
  input: number;
  /** Cache writes with a 5-minute and a 1-hour lifetime. */
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface MessageUsage {
  /** API message id. Claude Code writes one entry per content block, all with the same id and usage. */
  id: string;
  model: string | null;
  time: number;
  tokens: TokenCounts;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Tokens an API response used, for assistant entries (subagents included) that carry them. */
export function messageUsage(e: Entry): MessageUsage | null {
  if (e.type !== 'assistant') return null;
  const m = e.message;
  const id = str(m?.id);
  const time = entryTime(e);
  const u = m?.usage;
  if (!id || time === null || !u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const split = o.cache_creation && typeof o.cache_creation === 'object' ? (o.cache_creation as Record<string, unknown>) : null;
  const write = count(o.cache_creation_input_tokens);
  const write1h = split ? Math.min(write, count(split.ephemeral_1h_input_tokens)) : 0;
  return {
    id,
    model: str(m?.model),
    time,
    tokens: { input: count(o.input_tokens), cacheWrite5m: write - write1h, cacheWrite1h: write1h, cacheRead: count(o.cache_read_input_tokens), output: count(o.output_tokens) },
  };
}
