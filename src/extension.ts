import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { claudeConfigDir, claudeProjectsDir, CodexLimitsReader, codexSessionsDir, latestTranscript, readCacheClock, type CacheClock, type CodexLimits, type UsageLimits } from './core/index.ts';
import { meterDir, readClaudeLimits } from './claudeStatus.ts';
import { cacheBarText, cacheLines, claudeAgent, codexAgent, highest, newWarnings, statusText, windowLine, type MeterAgent } from './format.ts';
import {
  inspectStatusLine,
  OWN_SH_COMMAND,
  WINDOWS_SCRIPT,
  WINDOWS_SCRIPT_TEXT,
  windowsCommand,
  withOwnStatusLine,
  withoutOurStatusLine,
  withWrappedStatusLine,
} from './statusLineSetup.ts';

const ASKED_KEY = 'usageMeter.askedClaude';
const TICK_MS = 15_000;
const CODEX_EVERY = 2;
/** Looking for the newest transcript touches every project folder, so it happens once in this many ticks. */
const TRANSCRIPT_EVERY = 4;
const ABOUT_URL = 'https://paneherd.com/?from=usage-meter';
const GUIDE_URL = 'https://paneherd.com/guides/claude-code-usage-running-out-fast';

const settingsFile = () => path.join(claudeConfigDir(), 'settings.json');

async function readSettings(): Promise<string | null> {
  try {
    return await readFile(settingsFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Written beside the file and moved over it, so Claude Code never reads half of it. */
async function writeSettings(text: string): Promise<void> {
  const file = settingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.paneherd-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

export function activate(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'usageMeter.show';
  const cfg = () => vscode.workspace.getConfiguration('usageMeter');
  const codex = new CodexLimitsReader(codexSessionsDir());
  const warned = new Set<string>();
  let claudeLimits: UsageLimits | null = null;
  let codexLimits: CodexLimits | null = null;
  let ticks = 0;
  let agents: MeterAgent[] = [];
  let clock: CacheClock | null = null;
  let transcript: { file: string; mtimeMs: number } | null = null;
  let readMtime = 0;

  /** The Claude side is on when settings.json carries our command. */
  const claudeOn = async (): Promise<boolean> => {
    try {
      const k = inspectStatusLine(await readSettings()).kind;
      return k === 'ours' || k === 'wrapped';
    } catch {
      return false;
    }
  };

  // A script an earlier version wrote stays what it was unless it is brought up to date here.
  if (process.platform === 'win32') {
    const script = path.join(meterDir(), WINDOWS_SCRIPT);
    void readFile(script, 'utf8')
      .then((old) => (old === WINDOWS_SCRIPT_TEXT ? undefined : writeFile(script, WINDOWS_SCRIPT_TEXT)))
      .catch(() => undefined);
  }

  const render = () => {
    const now = Date.now();
    const cache = cfg().get<boolean>('showCache', true) ? clock : null;
    const bar = cacheBarText(cache, now);
    agents = [cfg().get<boolean>('showClaude', true) ? claudeAgent(claudeLimits, now) : null, cfg().get<boolean>('showCodex', true) ? codexAgent(codexLimits, now) : null].filter(
      (a): a is MeterAgent => a !== null,
    );
    if (agents.length === 0 && !bar) {
      item.text = '$(pulse) Usage';
      item.tooltip = 'Usage Meter: no Claude Code or Codex limits yet. Click for how to show them.';
      item.backgroundColor = undefined;
      item.show();
      return;
    }
    item.text = `$(pulse) ${[statusText(agents), bar && `$(clock) ${bar}`].filter(Boolean).join('   ')}`;
    const md = new vscode.MarkdownString(undefined, true);
    for (const a of agents) {
      md.appendMarkdown(`**${a.agent}**\n\n`);
      for (const w of a.windows) md.appendMarkdown(`- ${windowLine(w, now)}\n`);
      md.appendMarkdown('\n');
    }
    for (const line of cacheLines(cache, now)) md.appendMarkdown(`${line}

`);
    md.appendMarkdown('Click for details.');
    item.tooltip = md;
    const top = highest(agents);
    item.backgroundColor = top >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground') : top >= cfg().get<number>('warnAt', 85) && top > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.show();
    for (const text of newWarnings(agents, cfg().get<number>('warnAt', 85), warned, now)) void vscode.window.showWarningMessage(text);
  };

  const refresh = async () => {
    claudeLimits = await readClaudeLimits();
    if (ticks % CODEX_EVERY === 0) codexLimits = await codex.read().catch(() => codexLimits);
    if (cfg().get<boolean>('showCache', true)) {
      if (ticks % TRANSCRIPT_EVERY === 0 || !transcript) transcript = await latestTranscript(claudeProjectsDir()).catch(() => null);
      const m = transcript ? await stat(transcript.file).then((s) => s.mtimeMs, () => 0) : 0;
      if (!transcript || m === 0) clock = null;
      else if (m !== readMtime) {
        readMtime = m;
        clock = await readCacheClock(transcript.file).catch(() => clock);
      }
    }
    ticks++;
    render();
  };

  const enableClaude = async () => {
    let text: string | null;
    try {
      text = await readSettings();
    } catch (err) {
      void vscode.window.showErrorMessage(`Usage Meter could not read ${settingsFile()}: ${(err as Error).message}`);
      return;
    }
    const state = inspectStatusLine(text);
    if (state.kind === 'invalid') {
      void vscode.window.showErrorMessage(`${settingsFile()} is not valid JSON, so Usage Meter left it alone. Fix it and try again.`);
      return;
    }
    if (state.kind === 'ours' || state.kind === 'wrapped') {
      void vscode.window.showInformationMessage('Claude Code limits are already on. They show after Claude Code\'s next reply.');
      return;
    }
    let next: string | null;
    if (state.kind === 'none') {
      let command = OWN_SH_COMMAND;
      if (process.platform === 'win32') {
        const script = path.join(meterDir(), WINDOWS_SCRIPT);
        await mkdir(meterDir(), { recursive: true });
        await writeFile(script, WINDOWS_SCRIPT_TEXT);
        command = windowsCommand(script);
      }
      next = withOwnStatusLine(text, command);
    } else {
      if (process.platform === 'win32' || state.command === null) {
        void vscode.window.showInformationMessage('You already have a Claude Code status line, so Usage Meter did not change it. Codex limits still show. Wrapping an existing status line is not available on Windows yet.');
        return;
      }
      const wrap = 'Wrap it';
      const pick = await vscode.window.showWarningMessage(
        'You already have a Claude Code status line',
        { modal: true, detail: `Usage Meter can save Claude's limits and then run your command exactly as before. "Stop reading Claude limits" puts your command back.\n\n${state.command}` },
        wrap,
      );
      if (pick !== wrap) return;
      next = withWrappedStatusLine(text!);
    }
    if (next === null) {
      void vscode.window.showErrorMessage('Usage Meter could not change the Claude Code settings.');
      return;
    }
    await writeSettings(next);
    void vscode.window.showInformationMessage('Claude Code limits are on. They show after Claude Code\'s next reply (Pro and Max plans).');
    void refresh();
  };

  const disableClaude = async () => {
    let text: string | null;
    try {
      text = await readSettings();
    } catch {
      return;
    }
    const next = text === null ? null : withoutOurStatusLine(text);
    if (next === null) {
      void vscode.window.showInformationMessage('Usage Meter has not changed your Claude Code settings.');
      return;
    }
    await writeSettings(next);
    void vscode.window.showInformationMessage('Usage Meter stopped reading Claude Code limits and put your settings back.');
  };

  const show = async () => {
    const now = Date.now();
    const on = await claudeOn();
    type Pick = vscode.QuickPickItem & { run?: () => void | Thenable<unknown> };
    const items: Pick[] = [];
    for (const a of agents) {
      items.push({ label: a.agent, kind: vscode.QuickPickItemKind.Separator });
      for (const w of a.windows) items.push({ label: `$(pulse) ${windowLine(w, now)}` });
    }
    const cacheInfo = cfg().get<boolean>('showCache', true) ? cacheLines(clock, now) : [];
    if (cacheInfo.length) {
      items.push({ label: 'Prompt cache', kind: vscode.QuickPickItemKind.Separator });
      for (const line of cacheInfo) items.push({ label: `$(clock) ${line}` });
    }
    if (agents.length || cacheInfo.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    if (on) items.push({ label: '$(debug-stop) Stop reading Claude limits', description: 'puts your Claude Code settings back', run: disableClaude });
    else items.push({ label: '$(add) Show Claude Code limits', description: 'adds a status line command to Claude Code\'s settings', run: enableClaude });
    items.push({ label: '$(book) Why does Claude Code usage run out so fast?', run: () => vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL)) });
    items.push({ label: '$(gear) Settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'usageMeter') });
    items.push({ label: '$(home) Paneherd: run these agents side by side', run: () => vscode.env.openExternal(vscode.Uri.parse(ABOUT_URL)) });
    const pick = await vscode.window.showQuickPick(items, { title: 'Usage Meter', placeHolder: agents.length ? 'Claude Code and Codex limits' : 'No limits to show yet' });
    await pick?.run?.();
  };

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('usageMeter.show', show),
    vscode.commands.registerCommand('usageMeter.enableClaude', enableClaude),
    vscode.commands.registerCommand('usageMeter.disableClaude', disableClaude),
    vscode.commands.registerCommand('usageMeter.refresh', refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usageMeter')) render();
    }),
  );
  const timer = setInterval(() => void refresh(), TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh();

  // Offer the Claude side once, and only when there is a Claude Code to read from.
  void (async () => {
    if (context.globalState.get<boolean>(ASKED_KEY)) return;
    if (await claudeOn()) return;
    if (!(await stat(claudeConfigDir()).then(() => true, () => false))) return;
    await context.globalState.update(ASKED_KEY, true);
    const yes = 'Show Claude limits';
    const pick = await vscode.window.showInformationMessage(
      'Usage Meter shows Codex limits as they are. For Claude Code it needs to add a small status line command to Claude\'s settings (nothing is sent anywhere). Do that now?',
      yes,
      'Not now',
    );
    if (pick === yes) await enableClaude();
  })();
}

export function deactivate(): void {}
