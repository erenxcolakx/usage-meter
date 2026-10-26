import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectStatusLine,
  OWN_SH_COMMAND,
  windowsCommand,
  withOwnStatusLine,
  withoutOurStatusLine,
  withWrappedStatusLine,
  WINDOWS_SCRIPT_TEXT,
} from '../../src/statusLineSetup.ts';

const settings = (o: unknown) => JSON.stringify(o);

test('no settings file, or one without a status line, can take ours; other keys stay', () => {
  assert.deepEqual(inspectStatusLine(null), { kind: 'none' });
  assert.deepEqual(inspectStatusLine('{"model":"x","statusLine":null}'), { kind: 'none' });
  const out = withOwnStatusLine('{"model":"x","permissions":{"allow":["Bash"]}}', OWN_SH_COMMAND)!;
  assert.deepEqual(JSON.parse(out), { model: 'x', permissions: { allow: ['Bash'] }, statusLine: { type: 'command', command: OWN_SH_COMMAND } });
  assert.deepEqual(inspectStatusLine(out), { kind: 'ours' });
  assert.deepEqual(JSON.parse(withOwnStatusLine(null, 'c')!), { statusLine: { type: 'command', command: 'c' } });
});

test('settings that are not a JSON object, and a status line of someone else, are never replaced', () => {
  for (const bad of ['{ nope', '[]', '"x"', '12']) {
    assert.deepEqual(inspectStatusLine(bad), { kind: 'invalid' });
    assert.equal(withOwnStatusLine(bad, 'c'), null);
    assert.equal(withoutOurStatusLine(bad), null);
  }
  const theirs = settings({ statusLine: { type: 'command', command: 'my-line' } });
  assert.deepEqual(inspectStatusLine(theirs), { kind: 'other', command: 'my-line' });
  assert.equal(withOwnStatusLine(theirs, 'c'), null);
  assert.equal(withoutOurStatusLine(theirs), null);
  assert.deepEqual(inspectStatusLine(settings({ statusLine: 'oops' })), { kind: 'other', command: null });
});

test("wrapping keeps the user's command and fields, and removing gives them back exactly", () => {
  const command = 'bash ~/.claude/line.sh --color # comment';
  const theirs = settings({ model: 'x', statusLine: { type: 'command', command, padding: 2, refreshInterval: 5 } });
  const wrapped = withWrappedStatusLine(theirs)!;
  assert.deepEqual(inspectStatusLine(wrapped), { kind: 'wrapped', existing: command });
  assert.equal(JSON.parse(wrapped).statusLine.padding, 2);
  assert.equal(withWrappedStatusLine(wrapped), null, 'not wrapped twice');
  assert.deepEqual(JSON.parse(withoutOurStatusLine(wrapped)!), JSON.parse(theirs));
  const own = withOwnStatusLine('{"a":1}', OWN_SH_COMMAND)!;
  assert.deepEqual(JSON.parse(withoutOurStatusLine(own)!), { a: 1 });
});

test('the Windows command points at the script with forward slashes', () => {
  const c = windowsCommand('C:\\Users\\a b\\.paneherd-meter\\write-status.ps1');
  assert.equal(c, 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/a b/.paneherd-meter/write-status.ps1"');
  assert.deepEqual(inspectStatusLine(settings({ statusLine: { type: 'command', command: c } })), { kind: 'ours' });
  assert.match(WINDOWS_SCRIPT_TEXT, /"rate_limits"/);
  assert.match(WINDOWS_SCRIPT_TEXT, /Remove-Item -Force \$tmp/, 'a report that cannot be moved into place leaves no temporary file');
});

// The command itself, run by a real shell the way Claude Code runs it. Needs sh; skipped where there is none.
const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
const haveSh = sh.status === 0 && sh.stdout.trim() === 'ok';

function run(command: string, input: string, home: string) {
  return spawnSync('sh', ['-c', command], { input, encoding: 'utf8', env: { ...process.env, HOME: home } });
}

test('the command saves input that carries limits, and only that', { skip: !haveSh }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'meter-home-'));
  try {
    const dir = path.join(home, '.paneherd-meter');
    const withLimits = '{"model":{"id":"x"},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1900000000}}}';
    const r1 = run(OWN_SH_COMMAND, withLimits, home);
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout, '', 'prints nothing');
    assert.equal(readFileSync(path.join(dir, 'status.json'), 'utf8'), withLimits);
    run(OWN_SH_COMMAND, '{"model":{"id":"x"}}', home);
    assert.equal(readFileSync(path.join(dir, 'status.json'), 'utf8'), withLimits, 'input without limits leaves the report alone');
    assert.deepEqual(readdirSync(dir), ['status.json'], 'no temporary files left');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a wrapped command still shows the user's own status line from the same input", { skip: !haveSh }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'meter-home-'));
  try {
    const wrapped = JSON.parse(withWrappedStatusLine(settings({ statusLine: { type: 'command', command: 'wc -c # count' } }))!).statusLine.command as string;
    const input = '{"rate_limits":{"seven_day":{"used_percentage":3,"resets_at":1900000000}}}';
    const r = run(wrapped, input, home);
    assert.equal(r.stdout.trim(), String(input.length));
    assert.equal(readFileSync(path.join(home, '.paneherd-meter', 'status.json'), 'utf8'), input);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
