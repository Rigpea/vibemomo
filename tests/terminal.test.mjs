// Terminal (docs/ARCHITECTURE.md section 8) against a real shell on this machine (pwsh/powershell on
// Windows, $SHELL elsewhere). Risks covered: the shell echoes; the child env carries no API key;
// the 9th terminal is refused; close really ends the process; a stream attach replays scrollback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTerminals, loadPty, terminalEnv } from '../server/lib/terminal.mjs';

let ptyReason = null;
try { await loadPty(); } catch (err) { ptyReason = err.message; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-term-'));
const studioDir = path.join(root, 'studio');
const projectDir = path.join(root, 'project');
fs.mkdirSync(studioDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
const win = process.platform === 'win32';

const made = [];
function setup(opts = {}) {
  const events = [];
  const t = createTerminals({
    studioDir,
    loadProject: async (id) => ({ path: projectDir, project: { id } }),
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test-should-not-leak', STUDIO_ANTHROPIC_API_KEY: 'sk-ant-studio-should-not-leak', ...(opts.env || {}) },
    emit: (type, payload) => events.push({ type, payload }),
    ...opts,
  });
  made.push(t);
  return { t, events };
}
after(async () => {
  for (const t of made) t.closeAll();
  // Shells that were just killed may still hold their cwd for a moment on Windows.
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir; the OS cleans it */ }
});

/** Fake ServerResponse that collects SSE writes. */
function fakeRes() {
  const res = { writes: [], headers: null, closeFns: [], ended: false };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (s) => { res.writes.push(String(s)); return true; };
  res.end = () => { res.ended = true; };
  res.on = (ev, fn) => { if (ev === 'close') res.closeFns.push(fn); };
  res.text = () => res.writes.map((w) => (w.startsWith('data: ') ? JSON.parse(w.slice(6)).d : '')).join('');
  return res;
}

async function until(pred, ms = 8000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a real shell echoes typed input and starts in the project folder', { skip: ptyReason || false, timeout: 15000 }, async () => {
  const { t } = setup();
  const info = await t.open({ projectId: 'p_test', cols: 100, rows: 30 });
  assert.match(info.id, /^term_[a-z0-9]+$/);
  assert.equal(info.cwd, projectDir);
  assert.ok(info.pid > 0);
  const res = fakeRes();
  t.attach(info.id, res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  t.write(info.id, 'echo PTY_OK\r');
  assert.ok(await until(() => /PTY_OK[\s\S]*PTY_OK/.test(res.text()) || res.text().split('PTY_OK').length > 2), `no PTY_OK in: ${res.text().slice(-400)}`);
  assert.doesNotThrow(() => t.resize(info.id, 120, 40));
  assert.throws(() => t.resize(info.id, 1, 40), /2\.\.500/);
  assert.throws(() => t.write(info.id, 'x'.repeat(64 * 1024 + 1)), /at most/);
  t.close(info.id);
});

test('the child env has no API keys but has ATELIER_PROJECT and ATELIER_STUDIO', { skip: ptyReason || false, timeout: 15000 }, async () => {
  const { t } = setup();
  const info = await t.open({ projectId: 'p_envtest', cols: 120, rows: 30 });
  const res = fakeRes();
  t.attach(info.id, res);
  const cmd = win
    ? 'echo "K=[$env:ANTHROPIC_API_KEY][$env:STUDIO_ANTHROPIC_API_KEY] P=$env:ATELIER_PROJECT S=$env:ATELIER_STUDIO"\r'
    : 'echo "K=[$ANTHROPIC_API_KEY][$STUDIO_ANTHROPIC_API_KEY] P=$ATELIER_PROJECT S=$ATELIER_STUDIO"\r';
  t.write(info.id, cmd);
  assert.ok(await until(() => /K=\[\]\[\] P=p_envtest/.test(res.text())), `output: ${res.text().slice(-600)}`);
  assert.doesNotMatch(res.text(), /should-not-leak/);
  assert.ok(res.text().replace(/\s+/g, '').includes(studioDir.replace(/\s+/g, '')) || res.text().includes('S='), 'ATELIER_STUDIO echoed');
  t.close(info.id);
});

test('the 9th terminal is refused with 409 terminal_limit; close ends the process', { skip: ptyReason || false, timeout: 30000 }, async () => {
  const { t } = setup();
  const shell = win ? 'cmd.exe' : undefined; // cheap shells for the count
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await t.open({ cols: 80, rows: 24, shell }));
  assert.equal(t.list().length, 8);
  assert.ok(t.list().every((x) => x.cwd === studioDir));
  await assert.rejects(t.open({ cols: 80, rows: 24, shell }), (err) => err.status === 409 && err.code === 'terminal_limit');
  const first = ids[0];
  assert.ok(alive(first.pid), 'shell is running before close');
  t.close(first.id);
  assert.ok(!t.list().some((x) => x.id === first.id), 'closed terminal is no longer listed');
  assert.ok(await until(() => !alive(first.pid)), `process ${first.pid} still alive after close`);
  assert.throws(() => t.write(first.id, 'x'), (err) => err.status === 404);
  for (const x of ids.slice(1)) t.close(x.id);
  assert.equal(t.list().length, 0);
});

test('attach replays the scrollback first, then streams; exit is reported', { skip: ptyReason || false, timeout: 15000 }, async () => {
  const { t, events } = setup();
  const info = await t.open({ cols: 100, rows: 30 });
  const live = fakeRes();
  t.attach(info.id, live);
  t.write(info.id, 'echo REPLAY_MARK\r');
  assert.ok(await until(() => live.text().split('REPLAY_MARK').length > 2), 'marker echoed');
  const late = fakeRes();
  t.attach(info.id, late);
  assert.ok(late.writes.length >= 1);
  assert.match(late.writes[0], /^data: /);
  assert.match(JSON.parse(late.writes[0].slice(6)).d, /REPLAY_MARK/, 'first event carries the scrollback');
  assert.equal(JSON.parse(late.writes[0].slice(6)).replay, true, 'the scrollback event is marked as a replay');
  late.closeFns.forEach((fn) => fn()); // client disconnect
  t.write(info.id, 'exit\r');
  assert.ok(await until(() => live.writes.some((w) => w.startsWith('event: exit'))), 'exit event sent');
  const exitEv = live.writes.find((w) => w.startsWith('event: exit'));
  assert.equal(typeof JSON.parse(exitEv.split('data: ')[1]).code, 'number');
  const listed = t.list().find((x) => x.id === info.id);
  assert.equal(listed.exited, true);
  assert.ok(events.some((e) => e.type === 'terminal.changed' && e.payload.exited));
  t.close(info.id);
});

test('unknown ids are 404 and bad sizes are 400', { skip: ptyReason || false }, async () => {
  const { t } = setup();
  assert.throws(() => t.write('term_nope', 'x'), (err) => err.status === 404);
  assert.throws(() => t.close('../etc'), (err) => err.status === 404);
  await assert.rejects(t.open({ cols: 0, rows: 10 }), (err) => err.status === 400);
});

test('terminalEnv drops API keys and host Claude Code session markers, keeps CLAUDE_CONFIG_DIR', () => {
  const out = terminalEnv({ PATH: 'p', anthropic_api_key: 'k', STUDIO_ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'e', CLAUDE_PID: '1', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CONFIG_DIR: 'C:/cfg', CLAUDE_CODE_USE_BEDROCK: '1' }, { projectId: 'p_x', studioDir: 'S' });
  assert.deepEqual(Object.keys(out).sort(), ['ATELIER_PROJECT', 'ATELIER_STUDIO', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'COLORTERM', 'PATH']);
  assert.equal(out.ATELIER_PROJECT, 'p_x');
});
