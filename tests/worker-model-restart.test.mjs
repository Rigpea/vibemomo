// The studio's default worker model across a server restart (server/lib/worker-model.mjs, server/lib/workers.mjs).
// Risks covered: the default is in the registry, so a fresh server process answers the stored model; a change made
// while the server runs reaches the next worker started with no restart; the worker's console session record shows the
// model. A real server process on a private port with the fake claude, started twice on the same data folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-worker-model-restart-'));
await fsp.mkdir(path.join(root, 'projects'), { recursive: true });
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

let child = null;
let base = null;
async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(port), ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects'), ATELIER_PID_FILE: path.join(root, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exit = code; });
  const t0 = Date.now();
  while (exit === null && Date.now() - t0 < 30000) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start on ${base} after ${Date.now() - t0} ms (exit ${exit}): ${stderr.slice(-500)}`);
}
async function stopServer() {
  if (!child) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await gone;
  child = null;
}
const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
/** Start the task in a worker and answer its console session record once the fake claude's turn has ended. */
async function workerRecord(projectId, taskId, body = {}) {
  const out = await api('POST', `/api/projects/${projectId}/workers`, { taskId, ...body });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  let rec = (await api('GET', `/api/console/sessions/${out.data.sessionId}`)).data;
  for (let i = 0; i < 100 && (rec.status === 'running' || rec.turns.length < 2); i++) {
    await new Promise((r) => setTimeout(r, 150));
    rec = (await api('GET', `/api/console/sessions/${out.data.sessionId}`)).data;
  }
  // The turn-end hook frees the folder a moment after the record is saved; the next start must not queue behind it.
  for (let i = 0; i < 100 && (await api('GET', `/api/projects/${projectId}/workers`)).data.active; i++) await new Promise((r) => setTimeout(r, 50));
  return { started: out.data, rec };
}

after(async () => {
  await stopServer();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

test('the stored studio default survives a restart, and a change while the server runs reaches the next worker', async () => {
  await startServer();
  const project = (await api('POST', '/api/projects', { name: 'Restart Room', kind: 'web-app' })).data.project;
  const taskOf = async (request) => (await api('POST', `/api/projects/${project.id}/tasks`, { request })).data.id;
  const first = await taskOf('First round.');
  const second = await taskOf('Second round.');
  assert.deepEqual((await api('GET', '/api/settings/worker-model')).data.studio, { stored: null, fallback: 'claude-fable-5-2', model: 'claude-fable-5-2' }, 'a new studio stores none');
  assert.equal((await api('PUT', '/api/settings/worker-model', { workerModel: 'claude-sonnet-5-5' })).status, 200);

  await stopServer();
  await startServer(); // a fresh process on the same data folder
  assert.deepEqual((await api('GET', '/api/settings/worker-model')).data.studio, { stored: 'claude-sonnet-5-5', fallback: 'claude-fable-5-2', model: 'claude-sonnet-5-5' }, 'read from the registry after the restart');
  const levels = (await api('GET', `/api/projects/${project.id}/worker-model?task=${first}`)).data;
  assert.deepEqual(levels.effective, { model: 'claude-sonnet-5-5', source: 'studio', words: 'studio default', backend: 'claude-code', label: 'claude-sonnet-5-5' });

  const a = await workerRecord(project.id, first);
  assert.deepEqual([a.started.model, a.started.modelSource, a.rec.model, a.rec.worker], ['claude-sonnet-5-5', 'studio', 'claude-sonnet-5-5', true], 'the worker\'s session record shows the stored default');
  assert.equal(a.rec.turns[1].model, 'claude-sonnet-5-5', 'the CLI was started with --model claude-sonnet-5-5');

  // Changed while this server runs: the next worker starts on it, with no restart between.
  assert.equal((await api('PATCH', '/api/settings', { workerModel: 'claude-haiku-5-5' })).data.workerModel, 'claude-haiku-5-5', 'the settings route stores it through the same check');
  const b = await workerRecord(project.id, second);
  assert.deepEqual([b.started.model, b.started.modelSource, b.rec.model], ['claude-haiku-5-5', 'studio', 'claude-haiku-5-5']);
  assert.equal((await api('GET', `/api/console/sessions/${a.started.sessionId}`)).data.model, 'claude-sonnet-5-5', 'the earlier worker\'s record keeps its model');

  // Cleared: nothing stored, the built-in default again.
  assert.equal((await api('PATCH', '/api/settings', { workerModel: null })).status, 200);
  assert.deepEqual((await api('GET', '/api/settings/worker-model')).data.studio, { stored: null, fallback: 'claude-fable-5-2', model: 'claude-fable-5-2' });
  const usage = (await api('GET', '/api/workers/usage')).data;
  assert.deepEqual(usage.windows[0].rows.map((r) => [r.kind, r.model, r.sessions, r.turns]).sort(), [['worker', 'claude-haiku-5-5', 1, 1], ['worker', 'claude-sonnet-5-5', 1, 1]], 'the tally counts both workers from their records');
});
