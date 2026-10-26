# Changelog

## 0.1.2

- Keeps the shared Claude Code usage report current for Paneherd and the status bar.

## 0.1.1

- Windows: the status line script no longer leaves `status.json.<number>` files in `~/.paneherd-meter` when another process is reading the report at that moment; it drops the copy and the next update replaces the report. An existing script is updated when the extension starts.

## 0.1.0

- First release: Claude Code and Codex 5-hour and weekly limits in the status bar, with reset times, a warning past a percentage you choose (85% by default) and a quick pick with details.
- Codex limits are read from its session logs. Claude Code limits are saved by a small status line command that the extension adds to Claude Code's settings when you ask, wraps around an existing status line when you allow it, and removes again on request.
