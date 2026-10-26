# Claude Code & Codex Usage Meter

Your Claude Code and Codex usage limits in the status bar: how much of the 5-hour and weekly allowance you have used, and when each resets. A warning appears before you run out.

```
Claude 5h 32% 7d 14%   Codex 5h 8% 7d 3%
```

Hover for the reset times. Click for details and settings. The item turns yellow at your warning percentage (85% by default) and red at 95%.

## Setup

- **Codex**: nothing to do. The limits are read from the session logs Codex writes on this computer (`~/.codex/sessions`, or `$CODEX_HOME`). They update after each Codex reply.
- **Claude Code**: Claude Code reports its limits only to a *status line* command, so the first time you run the extension it offers to add one to Claude Code's `settings.json` (*Usage Meter: Show Claude Code Limits*). The command saves Claude Code's status line input to `~/.paneherd-meter/status.json`, and only when that input carries limits.
  - If you have no status line, the extension adds its own, which prints nothing.
  - If you already have one, the extension leaves it alone unless you say *Wrap it*: it then runs your command exactly as before, after saving its copy. On Windows, wrapping is not available yet.
  - *Usage Meter: Stop Reading Claude Code Limits* puts your settings back as they were.
  - Claude Code shows limits to claude.ai **Pro and Max** subscribers, after the first reply of a session. API-key users have none to show.

## Prompt cache clock

Claude Code sends the whole conversation with every reply. While the prompt cache is warm those tokens cost a tenth of the input price; after a break longer than the cache lasts they are written again at 1.25 times (5-minute cache) or 2 times (1-hour cache) the price, so a long conversation can use a noticeable share of your limit in one reply. The tooltip shows when the cache of the session you are working in runs out and how big that rewrite would be. The status bar adds `cache 4 min` only in the last 10 minutes, and `cache cold` once it has run out. The lifetime is read from the session's own transcript, so it is the one your plan really gets. It reads the newest transcript under `~/.claude/projects` on this computer and nothing else. Turn it off with `usageMeter.showCache`.

## What it does not do

- It sends nothing anywhere and has no account or telemetry. It reads files on this computer, and the only file it writes outside this extension's own folder is Claude Code's `settings.json`, when you ask.
- It does not call any Anthropic or OpenAI service, and does not use your login tokens.
- Figures are what Claude Code and Codex report. If a window has reset since the last reply, it is hidden until the next one.

## Settings

| Setting | Default | |
|---|---|---|
| `usageMeter.showClaude` | on | Show Claude Code's limits |
| `usageMeter.showCodex` | on | Show Codex's limits |
| `usageMeter.showCache` | on | Prompt cache clock for the session you are working in |
| `usageMeter.warnAt` | 85 | Warn once per window past this percentage; `0` turns it off |

## More on the limits

[What the Claude Code usage limit is](https://paneherd.com/claude-code-usage-limit), [when it resets](https://paneherd.com/claude-code-usage-reset-time), [rate limit vs usage limit](https://paneherd.com/claude-code-rate-limit) and [Codex's limits](https://paneherd.com/codex-cli-usage-limit).

## Why does Claude Code usage run out so fast?

Long conversations, cache misses after a break, forgotten scheduled tasks and subagents are the usual causes. [This guide](https://paneherd.com/guides/claude-code-usage-running-out-fast) goes through them and shows how `/usage` finds yours.

## From the makers of Paneherd

[Paneherd](https://paneherd.com/?utm_source=usage-meter&utm_medium=readme) runs Claude Code, Codex, Copilot, Gemini and Cursor agents side by side in split panes, with one inbox for permission prompts, usage limits per pane, and a phone remote. This meter is free and works on its own.
