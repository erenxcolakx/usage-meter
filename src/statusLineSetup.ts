// The status line command that lets Claude Code's rate limits reach this extension.
//
// Claude Code hands `rate_limits` only to a status line command, on stdin. Ours
// keeps that input in ~/.paneherd-meter/status.json, but only when it carries
// limits, so a session without them never overwrites a report with a blank.
// Settings are edited as JSON text: everything else in the file is kept as it is.

export const METER_DIR = '.paneherd-meter';
export const STATUS_FILE = 'status.json';
export const WINDOWS_SCRIPT = 'write-status.ps1';

const SH_FILE = `"$HOME/${METER_DIR}/${STATUS_FILE}"`;
/** Reads stdin into $i and keeps it if it has limits. Leaves the input in $i. */
const SH_WRITE = `mkdir -p "$HOME/${METER_DIR}"; i=$(cat); case "$i" in *'"rate_limits"'*) printf '%s' "$i" > ${SH_FILE}.$$ && mv ${SH_FILE}.$$ ${SH_FILE};; esac`;
const SH_WRAP_HEAD = `${SH_WRITE}; printf '%s' "$i" | (`;
const SH_WRAP_TAIL = '\n)';

/** What goes in a Windows status line command: PowerShell reads forward slashes, Git Bash eats backslashes. */
export function windowsCommand(scriptPath: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replace(/\\/g, '/')}"`;
}

/** The PowerShell script the Windows command runs. */
export const WINDOWS_SCRIPT_TEXT = `$t = [Console]::In.ReadToEnd()
if ($t -match '"rate_limits"') {
  $d = Join-Path $env:USERPROFILE '${METER_DIR}'
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  $f = Join-Path $d '${STATUS_FILE}'
  $tmp = "$f.$PID"
  [IO.File]::WriteAllText($tmp, $t, (New-Object Text.UTF8Encoding $false))
  try { Move-Item -Force $tmp $f -ErrorAction Stop } catch { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
}
`;

export const OWN_SH_COMMAND = SH_WRITE;

/** The user's own command, run after ours has taken its copy of the input. Not offered on Windows. */
export function wrapCommand(existing: string): string {
  return `${SH_WRAP_HEAD}${existing}${SH_WRAP_TAIL}`;
}

export type StatusLineState =
  | { kind: 'none' }
  /** Ours alone. */
  | { kind: 'ours' }
  /** The user's own command, run behind ours. */
  | { kind: 'wrapped'; existing: string }
  /** Someone else's, which we do not touch unless asked to wrap it. */
  | { kind: 'other'; command: string | null }
  /** Settings that are not a JSON object: nothing is changed. */
  | { kind: 'invalid' };

function parse(text: string | null): Record<string, unknown> | null {
  if (text === null || text.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isOurs = (command: string): boolean => command === OWN_SH_COMMAND || (command.includes(`${METER_DIR}/${WINDOWS_SCRIPT}`) && /^powershell\b/.test(command));

/** What a settings file (its text, or null when it does not exist) says about the status line. */
export function inspectStatusLine(text: string | null): StatusLineState {
  const o = parse(text);
  if (!o) return { kind: 'invalid' };
  const sl = o.statusLine;
  if (sl === undefined || sl === null) return { kind: 'none' };
  const command = typeof sl === 'object' && !Array.isArray(sl) && typeof (sl as Record<string, unknown>).command === 'string' ? ((sl as Record<string, unknown>).command as string) : null;
  if (command === null) return { kind: 'other', command: null };
  if (isOurs(command)) return { kind: 'ours' };
  if (command.startsWith(SH_WRAP_HEAD) && command.endsWith(SH_WRAP_TAIL)) return { kind: 'wrapped', existing: command.slice(SH_WRAP_HEAD.length, command.length - SH_WRAP_TAIL.length) };
  return { kind: 'other', command };
}

const write = (o: Record<string, unknown>): string => `${JSON.stringify(o, null, 2)}\n`;

/** Settings with our status line command, or null when the text is not settings or already has a status line. */
export function withOwnStatusLine(text: string | null, command: string): string | null {
  const o = parse(text);
  if (!o || (o.statusLine !== undefined && o.statusLine !== null)) return null;
  return write({ ...o, statusLine: { type: 'command', command } });
}

/** Settings whose status line command runs behind ours; its other fields (padding, refreshInterval) stay. */
export function withWrappedStatusLine(text: string): string | null {
  const o = parse(text);
  if (!o || inspectStatusLine(text).kind !== 'other') return null;
  const sl = o.statusLine as Record<string, unknown>;
  if (typeof sl.command !== 'string') return null;
  return write({ ...o, statusLine: { ...sl, command: wrapCommand(sl.command) } });
}

/** Settings without what we added: our own status line is removed, a wrapped one is given back as it was. */
export function withoutOurStatusLine(text: string): string | null {
  const o = parse(text);
  const state = inspectStatusLine(text);
  if (!o) return null;
  if (state.kind === 'ours') {
    const { statusLine: _gone, ...rest } = o;
    return write(rest);
  }
  if (state.kind === 'wrapped') return write({ ...o, statusLine: { ...(o.statusLine as Record<string, unknown>), command: state.existing } });
  return null;
}
