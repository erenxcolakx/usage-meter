import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAgent, codexAgent, highest, newWarnings, statusText, untilReset, windowLabel, windowLine } from '../../src/format.ts';

const NOW = Date.UTC(2026, 9, 21, 12);
const MIN = 60_000;

test('windows are labelled by their length', () => {
  assert.equal(windowLabel(300, 'x'), '5h');
  assert.equal(windowLabel(10080, 'x'), '7d');
  assert.equal(windowLabel(90, 'x'), '90m');
  assert.equal(windowLabel(null, 'now'), 'now');
});

test('reset times read as a countdown', () => {
  assert.equal(untilReset(NOW + 5 * MIN, NOW), 'resets in 5m');
  assert.equal(untilReset(NOW + 134 * MIN, NOW), 'resets in 2h 14m');
  assert.equal(untilReset(NOW + (3 * 1440 + 4 * 60) * MIN, NOW), 'resets in 3d 4h');
  assert.equal(untilReset(NOW - MIN, NOW), 'resets now');
  assert.equal(untilReset(null, NOW), 'reset time unknown');
});

test('Claude and Codex windows that have reset are left out', () => {
  const claude = claudeAgent({ fiveHour: { usedPercent: 32, resetsAt: NOW - MIN }, sevenDay: { usedPercent: 14.4, resetsAt: NOW + 5 * 1440 * MIN }, observedAt: NOW }, NOW)!;
  assert.deepEqual(claude.windows.map((w) => w.label), ['7d']);
  assert.equal(claudeAgent({ fiveHour: { usedPercent: 1, resetsAt: NOW - 1 }, sevenDay: null, observedAt: NOW }, NOW), null);
  assert.equal(claudeAgent(null, NOW), null);
  const codex = codexAgent({ observedAt: NOW, windows: [{ usedPercent: 8, resetsAt: NOW + MIN * 100, windowMinutes: 300 }, { usedPercent: 3, resetsAt: NOW + 6 * 1440 * MIN, windowMinutes: 10080 }] }, NOW)!;
  assert.equal(statusText([codex]), 'Codex 5h 8% 7d 3%');
  assert.deepEqual(codex.windows.map((w) => w.name), ['5-hour', 'Weekly']);
});

test('the status text joins agents and rounds percentages', () => {
  const claude = claudeAgent({ fiveHour: { usedPercent: 31.6, resetsAt: NOW + MIN }, sevenDay: { usedPercent: 14.4, resetsAt: NOW + MIN }, observedAt: NOW }, NOW)!;
  const codex = codexAgent({ observedAt: NOW, windows: [{ usedPercent: 8, resetsAt: null, windowMinutes: 300 }] }, NOW)!;
  assert.equal(statusText([claude, codex]), 'Claude 5h 32% 7d 14%   Codex 5h 8%');
  assert.equal(highest([claude, codex]), 31.6);
  assert.equal(windowLine(claude.windows[0]!, NOW), '5-hour: 32% used · resets in 1m');
});

test('a warning comes once per window, and again for the next one', () => {
  const at = (resetsAt: number, used: number) => [claudeAgent({ fiveHour: { usedPercent: used, resetsAt }, sevenDay: null, observedAt: NOW }, NOW)!];
  const warned = new Set<string>();
  assert.deepEqual(newWarnings(at(NOW + 60 * MIN, 80), 85, warned, NOW), []);
  assert.equal(newWarnings(at(NOW + 60 * MIN, 86), 85, warned, NOW).length, 1);
  assert.deepEqual(newWarnings(at(NOW + 60 * MIN, 99), 85, warned, NOW), []);
  assert.equal(newWarnings(at(NOW + 360 * MIN, 90), 85, warned, NOW).length, 1);
  assert.deepEqual(newWarnings(at(NOW + 720 * MIN, 100), 0, new Set(), NOW), [], '0 turns warnings off');
});
