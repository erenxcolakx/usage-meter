# Changelog

## 0.2.0

- Prompt cache clock: the tooltip and the quick pick say when the prompt cache of the Claude Code session you are working in runs out, and what the next reply costs after that (the whole context is sent again at 12.5 or 20 times the price of a warm one). The status bar shows `cache 4 min` only in the last 10 minutes, and `cache cold` once it has run out. The cache lifetime (5 minutes or 1 hour) is read from the session's own transcript. New setting `usageMeter.showCache` turns it off.

## 0.1.2

- Keeps the shared Claude Code usage report current for Paneherd and the status bar.

## 0.1.1

- Windows: the status line script no longer leaves `status.json.<number>` files in `~/.paneherd-meter` when another process is reading the report at that moment; it drops the copy and the next update replaces the report. An existing script is updated when the extension starts.

## 0.1.0

- First release: Claude Code and Codex 5-hour and weekly limits in the status bar, with reset times, a warning past a percentage you choose (85% by default) and a quick pick with details.
- Codex limits are read from its session logs. Claude Code limits are saved by a small status line command that the extension adds to Claude Code's settings when you ask, wraps around an existing status line when you allow it, and removes again on request.
