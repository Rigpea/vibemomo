// The run registry (server/lib/runs.mjs; docs/ARCHITECTURE.md section 16) and the hooks that report to it: a Chat
// session through the fake claude CLI, a build and a boot through a fake adb runner, a real shell when node-pty loads,
// and a utility run with a fake API client. Risks covered: a run nobody reported never shows; each change is one
// runs.changed; finished runs go after 24 h and past 50 per project; a restart says since when it knows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunRegistry, runs as studioRuns, sessionEnd, sessionName, toolWords, shellName, firstWords, KEEP_MS } from '../server/lib/runs.mjs';
import { createConsole } from '../server/lib/console.mjs';
import { createAndroid, resetBuilds } from '../server/lib/devices/android.mjs';
import { createTerminals, loadPty } from '../server/lib/terminal.mjs';
import { createUtility } from '../server/api-utility/index.mjs';
import { durationWords } from '../client/components/run-words.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-runs-'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp */ } });

/** A registry on a clock the test moves, with every event it emits. */
function registry(opts = {}) {
  let clock = Date.parse('2026-11-07T10:00:00.000Z');
  const events = [];
  const r = createRunRegistry({ emit: (type, payload) => events.push({ type, payload }), now: () => clock, ...opts });
  return { r, events, tick: (ms) => { clock += ms; }, now: () => clock };
}

async function until(pred, ms = 10000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((res) => setTimeout(res, step));
  }
  return false;
}

// ---------- the registry ----------

test('start, update and end: one runs.changed per change, none for a call that changes nothing', () => {
  const { r, events, tick } = registry();
  const row = r.start({ id: 'cr_1', kind: 'session', projectId: 'p_a', name: 'Give the header room' });
  assert.deepEqual([row.id, row.kind, row.projectId, row.state, row.endedAt, row.latest, row.waitsFor], ['cr_1', 'session', 'p_a', 'Working', null, null, null]);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].type, events[0].payload.projectId, events[0].payload.run.id], ['runs.changed', 'p_a', 'cr_1']);
  tick(5000);
  r.update('cr_1', { latest: 'Read copy.mjs' });
  assert.equal(events.length, 2);
  r.update('cr_1', { latest: 'Read copy.mjs' });
  assert.equal(events.length, 2, 'the same latest again is no change');
  assert.equal(r.get('cr_1').latestAt, '2026-11-07T10:00:05.000Z');
  tick(60000);
  const done = r.end('cr_1', { state: 'Done' });
  assert.deepEqual([done.state, done.endedAt], ['Done', '2026-11-07T10:01:05.000Z']);
  assert.equal(events.length, 3);
  assert.equal(r.end('cr_1', { state: 'Failed', reason: 'late' }), null, 'a run ends once');
  assert.equal(r.update('cr_1', { latest: 'after the end' }), null);
  assert.equal(events.length, 3);
  assert.equal(r.end('cr_unknown', { state: 'Done' }), null, 'a run nobody started is not invented');
  assert.throws(() => r.start({ kind: 'robot', name: 'x' }), /kind/);
  assert.throws(() => r.end(r.start({ kind: 'utility', name: 'x' }).id, { state: 'Working' }), /ends/);
});

test('the list: one project or all; running first, then the newest ended', () => {
  const { r, tick } = registry();
  r.start({ id: 'a1', kind: 'build', projectId: 'p_a', name: 'Build and install' });
  tick(1000);
  r.start({ id: 'b1', kind: 'terminal', projectId: 'p_b', name: 'pwsh' });
  tick(1000);
  r.start({ id: 'a2', kind: 'utility', projectId: 'p_a', name: 'release-notes' });
  tick(1000);
  r.end('a1', { state: 'Failed', reason: 'Step 2 (gradlew) exited with 1' });
  assert.deepEqual(r.list({ projectId: 'p_a' }).runs.map((x) => x.id), ['a2', 'a1']);
  assert.deepEqual(r.list({ projectId: 'all' }).runs.map((x) => x.id), ['a2', 'b1', 'a1']);
  assert.deepEqual(r.list().runs.map((x) => x.id), ['a2', 'b1', 'a1'], 'no id is all');
  const shell = r.list({ projectId: 'p_b' }).runs[0];
  assert.equal(shell.latest, 'open under a minute', 'a shell says how long it has been open');
  tick(4 * 60000);
  assert.equal(r.get('b1').latest, 'open 4 min');
});

test('finished runs are kept 24 hours and at most 50 per project; running ones stay', () => {
  const { r, tick } = registry();
  r.start({ id: 'live', kind: 'terminal', projectId: 'p_a', name: 'pwsh' });
  for (let i = 0; i < 53; i++) { r.start({ id: `u${i}`, kind: 'utility', projectId: 'p_a', name: `u${i}` }); tick(10); r.end(`u${i}`, { state: 'Done' }); }
  r.start({ id: 'other', kind: 'utility', projectId: 'p_b', name: 'other' });
  r.end('other', { state: 'Done' });
  const a = r.list({ projectId: 'p_a' }).runs;
  assert.equal(a.filter((x) => x.endedAt).length, 50, 'the cap keeps 50 finished per project');
  assert.ok(!a.some((x) => ['u0', 'u1', 'u2'].includes(x.id)), 'the oldest three went');
  assert.ok(a.some((x) => x.id === 'live'));
  assert.equal(r.list({ projectId: 'p_b' }).runs.length, 1, 'another project keeps its own');
  tick(KEEP_MS + 1000);
  assert.deepEqual(r.list({ projectId: 'all' }).runs.map((x) => x.id), ['live'], 'after 24 h only the running shell is left');
});

test('the note: a studio younger than 24 h says since when it knows; after that the window is whole', () => {
  const { r, tick } = registry();
  assert.equal(r.list().note, 'since the studio started at 2026-11-07T10:00:00.000Z');
  tick(KEEP_MS);
  assert.equal(r.list().note, null);
  assert.equal(r.list().since, '2026-11-07T10:00:00.000Z');
});

// ---------- the words ----------

test('words: tool calls, shells, session names and how a turn ended', () => {
  assert.equal(toolWords('Read', 'C:\\work\\harbor\\copy.mjs'), 'Read copy.mjs');
  assert.equal(toolWords('Bash', 'npm test'), 'Run npm test');
  assert.equal(toolWords('Grep', 'spacing'), 'Search “spacing”', 'a pattern is quoted, so it does not read as a file');
  assert.equal(toolWords('mcp__atelier__atelier_phone_screenshot', '{}'), 'Phone screenshot');
  assert.equal(shellName('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh');
  assert.equal(shellName('/bin/bash'), 'bash');
  assert.equal(sessionName({ taskId: 't_1', title: 'Task · Give the header room', model: 'claude-opus-5-5' }), 'Give the header room');
  assert.equal(sessionName({ title: 'Why is the dock tall?', model: 'claude-opus-5-5' }), 'Why is the dock tall?');
  assert.equal(sessionName({ title: '', model: 'claude-opus-5-5' }), 'claude-opus-5-5');
  assert.deepEqual(sessionEnd({ text: 'Done.\n\nShall I keep the old header as an option?' }), { state: 'Waiting for you', reason: 'Shall I keep the old header as an option?', waitsFor: 'you' });
  assert.deepEqual(sessionEnd({ text: 'Changed two files.' }), { state: 'Done', reason: null, waitsFor: null });
  assert.deepEqual(sessionEnd({ cancelled: true }), { state: 'Stopped', reason: 'you stopped it', waitsFor: null });
  assert.equal(sessionEnd({ timedOut: true, cancelled: true, error: 'timed out after 600000 ms' }).reason, 'timed out after 600000 ms');
  assert.deepEqual(sessionEnd({ isError: true, error: 'claude exited with 1: boom\nmore' }), { state: 'Failed', reason: 'claude exited with 1: boom', waitsFor: null });
  assert.equal(firstWords('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
  assert.deepEqual([durationWords(30000), durationWords(4 * 60000), durationWords(65 * 60000), durationWords(120 * 60000)], ['under a minute', '4 min', '1 h 5 min', '2 h']);
});

// ---------- the hooks ----------

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

test('a Chat session: Working with its last tool call, then Waiting for you with the question; three events', { timeout: 20000 }, async () => {
  const { r, events } = registry({ now: () => Date.now() });
  const dir = path.join(root, 'console');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(path.join(projectDir, '.studio'), { recursive: true });
  const consoleEvents = [];
  const c = createConsole({
    dataDir: path.join(dir, 'data'), studioDir: dir, loadProject: async (id) => ({ path: projectDir, project: { id } }),
    getSettings: async () => ({}), emit: (type, payload) => consoleEvents.push({ type, payload }),
    env: { ...process.env, ATELIER_CLAUDE_BIN: FAKE }, runs: r,
  });
  const s = await c.createSession({ projectId: 'p_s', title: 'Task · Give the header room', taskId: 't_abc', department: 'Frontend' });
  assert.equal(s.department, 'Frontend', 'a task-bound session keeps its task\'s department name');
  assert.equal((await c.createSession({ projectId: 'p_s', title: 'Free chat', department: 'Frontend' })).department, null, 'no task, no department');
  const { runId } = await c.send(s.id, { text: 'ASK_ME about the header' });
  assert.ok(await until(() => consoleEvents.some((e) => e.type === 'console.done' && e.payload.runId === runId)), 'the turn finished');
  const row = r.get(runId);
  assert.deepEqual([row.kind, row.projectId, row.name, row.department, row.state, row.reason, row.waitsFor, row.latest],
    ['session', 'p_s', 'Give the header room', 'Frontend', 'Waiting for you', 'Shall I keep the old header as an option?', 'you', 'Read CLAUDE.md']);
  assert.ok(row.endedAt);
  const mine = events.filter((e) => e.payload.run.id === runId);
  assert.deepEqual(mine.map((e) => e.payload.run.state), ['Working', 'Working', 'Waiting for you'], 'started, the tool call, the end');
  // A plain answer is Done.
  const next = await c.send(s.id, { text: 'thanks' });
  assert.ok(await until(() => r.get(next.runId)?.endedAt));
  assert.equal(r.get(next.runId).state, 'Done');
});

/** adb answers of an emulator that comes online after a few polls. */
function fakeDevice(folder, { stream, bootAfter = 3 } = {}) {
  const SDK = path.join(root, 'sdk');
  const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
  const EMULATOR = path.join(SDK, 'emulator', 'emulator.exe');
  let polls = 0;
  let props = 0;
  let clock = 0;
  const texts = { [path.join(folder, 'capacitor.config.json')]: JSON.stringify({ appId: 'com.example.app', webDir: 'dist' }) };
  const files = new Set([ADB, EMULATOR, path.join(folder, 'android', 'gradlew.bat')]);
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  const deps = {
    run: async (command, args) => {
      const line = (args[0] === '-s' ? args.slice(2) : args).join(' ');
      if (line === 'devices') { polls++; return ok(polls < bootAfter ? 'List of devices attached\n\n' : 'List of devices attached\nemulator-5554\tdevice\n'); }
      if (line === 'emu avd name') return ok('Test_AVD\r\nOK\r\n');
      if (line === 'shell getprop sys.boot_completed') return ok(bootAfter && ++props < 3 ? '0\n' : '1\n');
      return { code: 1, stdout: '', stderr: `no answer for ${line}` };
    },
    isFile: (p) => files.has(p) || Object.hasOwn(texts, p),
    isDir: () => false,
    readText: async (p) => { if (Object.hasOwn(texts, p)) return texts[p]; throw new Error('ENOENT'); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    start: () => ({ pid: 1, state: () => ({ exited: false, code: null, error: null }) }),
    stream: stream || (async () => ({ code: 0, error: null })),
  };
  return createAndroid({ projectPath: folder, projectId: 'p_dev', dataDir: path.join(root, 'data'), manifest: { devices: { android: { avd: 'Test_AVD' } } }, settings: { devices: { android: { sdkRoot: SDK } } }, deps, env: {}, platform: 'win32' });
}

test('a build: the step in words while it runs, Failed with the failed step; a boot: serial up, then Done', async () => {
  resetBuilds();
  const events = [];
  studioRuns.setEmit((type, payload) => events.push({ type, payload }));
  const folder = path.join(root, 'device-project');
  fs.mkdirSync(folder, { recursive: true });
  const seen = [];
  const stream = async (command) => {
    seen.push(studioRuns.list({ projectId: 'p_dev' }).runs.find((x) => x.kind === 'build').latest);
    return { code: /gradlew/.test(command) ? 1 : 0, error: null };
  };
  const out = await fakeDevice(folder, { stream }).build({});
  assert.equal(out.ok, false);
  assert.deepEqual(seen, ['1 of 3 · npx cap sync android', '2 of 3 · gradlew assembleDebug --console=plain']);
  const build = studioRuns.list({ projectId: 'p_dev' }).runs.find((x) => x.kind === 'build');
  assert.deepEqual([build.name, build.state, build.reason], ['Build and install', 'Failed', 'Step 2 (gradlew assembleDebug --console=plain) exited with 1']);
  assert.equal(events.filter((e) => e.payload.run.id === build.id).length, 4, 'started, step 1, step 2, failed');

  const boot = await fakeDevice(folder).boot({ pollMs: 1000 });
  assert.equal(boot.ok, true, JSON.stringify(boot));
  const dev = studioRuns.list({ projectId: 'p_dev' }).runs.find((x) => x.kind === 'device');
  assert.deepEqual([dev.name, dev.state, dev.latest], ['Test_AVD', 'Done', 'booted emulator-5554']);
  const latests = events.filter((e) => e.payload.run.id === dev.id).map((e) => e.payload.run.latest);
  assert.deepEqual(latests, ['starting the emulator', 'serial up (emulator-5554), waiting for boot_completed', 'booted emulator-5554']);
  // An emulator already booted is no run: nothing started, nothing to report.
  const before = studioRuns.list({ projectId: 'p_dev' }).runs.length;
  assert.equal((await fakeDevice(folder, { bootAfter: 0 }).boot()).already, true);
  assert.equal(studioRuns.list({ projectId: 'p_dev' }).runs.length, before);
  studioRuns.setEmit(null);
});

let ptyReason = null;
try { await loadPty(); } catch (err) { ptyReason = err.message; }

test('a shell: Working while open, Stopped with its exit code, or Stopped · closed; one end each', { skip: ptyReason || false, timeout: 20000 }, async () => {
  const { r, events } = registry({ now: () => Date.now() });
  const studioDir = path.join(root, 'term-studio');
  fs.mkdirSync(studioDir, { recursive: true });
  const t = createTerminals({ studioDir, loadProject: async () => ({ path: studioDir }), runs: r });
  const win = process.platform === 'win32';
  const a = await t.open({ projectId: 'p_t', cols: 80, rows: 24, shell: win ? 'cmd.exe' : undefined });
  assert.deepEqual([r.get(a.id).kind, r.get(a.id).state, r.get(a.id).name], ['terminal', 'Working', win ? 'cmd' : shellName(a.shell)]);
  t.write(a.id, 'exit 3\r');
  assert.ok(await until(() => r.get(a.id)?.endedAt), 'the shell ended by itself');
  assert.deepEqual([r.get(a.id).state, r.get(a.id).reason], ['Stopped', 'exit code 3']);
  t.close(a.id);
  assert.equal(r.get(a.id).reason, 'exit code 3', 'closing an exited shell keeps the end it reported');
  const b = await t.open({ projectId: 'p_t', cols: 80, rows: 24, shell: win ? 'cmd.exe' : undefined });
  t.close(b.id);
  assert.deepEqual([r.get(b.id).state, r.get(b.id).reason], ['Stopped', 'closed']);
  assert.match(r.get(b.id).latest, /^closed after /);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(events.filter((e) => e.payload.run.id === b.id && e.payload.run.endedAt).length, 1, 'the kill after close is no second end');
  t.closeAll();
});

test('a utility run: calling, then Done; a provider error is Failed with its words; a session\'s own call is no row', async () => {
  const { r } = registry({ now: () => Date.now() });
  const dataDir = path.join(root, 'utility');
  fs.mkdirSync(dataDir, { recursive: true });
  let fail = false;
  const clientFactory = () => ({ messages: { create: async () => {
    if (fail) { const e = new Error('bad request'); e.status = 400; throw e; }
    return { content: [{ type: 'text', text: JSON.stringify({ reply: 'hello' }) }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' };
  } } });
  const u = createUtility({ dataDir, getApiKey: () => 'sk-ant-test', getModel: () => 'claude-haiku-5-5', clientFactory, runs: r });
  const input = { messages: [{ role: 'user', text: 'hi' }], context: '' };
  const ok = await u.run('console-chat', { projectId: 'p_u', input });
  const row = r.get(ok.runId);
  assert.deepEqual([row.kind, row.name, row.state, row.latest], ['utility', 'console-chat', 'Done', 'answered after 1 attempt']);
  fail = true;
  const err = await u.run('console-chat', { projectId: 'p_u', input }).catch((e) => e);
  assert.equal(r.get(err.runId).state, 'Failed');
  assert.match(r.get(err.runId).reason, /^provider error: 400/);
  fail = false;
  const quiet = await u.run('console-chat', { projectId: 'p_u', input }, { track: false });
  assert.equal(r.get(quiet.runId), null);
});
