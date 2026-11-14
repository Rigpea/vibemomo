// HTTP-level checks against a real server process on a private port with a
// temp data dir: preview confinement, budget pause behavior, task ingest guard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { releaseNotesDraft, MAX_NOTES_BYTES } from '../client/components/release-notes.js';
import { localDateTime } from '../server/lib/paths.mjs';
import { startFakeCdp } from './fixtures/fake-cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A port free right now, chosen by the system: a fixed range can hold something else (4800 did on this machine). */
const PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const BASE =`http://127.0.0.1:${PORT}`;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-http-'));
let child;

const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, type: res.headers.get('content-type') };
};

const cliEnv = { ...process.env, ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects') };
/** A version tagged with a task, the way a session makes one: the versions route cannot. The whole record, with its role from the task's mode. */
const checkpointForTask = async (id, label, taskId) => {
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/atelier.mjs', 'checkpoint', '--project', id, '--label', label, '--task', taskId], { cwd: ROOT, env: cliEnv, windowsHide: true });
  const made = JSON.parse(stdout.slice(stdout.indexOf('\n{') + 1));
  return (await api('GET', `/api/projects/${id}/versions`)).data.find((v) => v.id === made.version);
};
/** The record as it was before versions had roles: tagged by its task, role absent. */
const dropRole = async (id, version) => {
  const folder = (await api('GET', '/api/projects')).data.find((p) => p.id === id).path;
  const file = path.join(folder, '.studio', 'versions.json');
  const list = JSON.parse(await fsp.readFile(file, 'utf8'));
  delete list.find((v) => v.id === version.id).role;
  await fsp.writeFile(file, JSON.stringify(list, null, 2));
  const { role, ...rest } = version;
  return rest;
};

const folderIs = (a, b) => a.toLowerCase() === b.toLowerCase();
/** The import's 409 says the project's name, not its internal id; error keeps the shape client/api.js reads. */
const assertNamesProject = (answer, id, name) => {
  const message = `Already in the studio as ${name}`;
  assert.deepEqual(answer.data, { error: { code: 'already_registered', message }, projectId: id, name, message });
};

/** The SSE lines that reach a listener while run() and a moment after it: enough for fs.watch and its 60 ms of quiet. */
const eventsDuring = async (run) => {
  const listening = new AbortController();
  const stream = await fetch(`${BASE}/api/events`, { signal: listening.signal });
  const seen = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream.body) seen.push(decoder.decode(chunk));
  })().catch(() => {});
  try {
    await run();
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    listening.abort();
    await reading;
  }
  return seen.join('').split('\n').filter((line) => line.startsWith('data:'));
};

const STUDIO_PID_FILE = path.join(ROOT, '.local', 'server.pid');
const readStudioPidFile = () => fsp.readFile(STUDIO_PID_FILE, 'utf8').catch(() => null);
let studioPidBefore = null;

let cdp; // the fake WebView DevTools endpoint; fake-adb's forward answers its port
before(async () => {
  await fsp.mkdir(path.join(root, 'projects'), { recursive: true });
  studioPidBefore = await readStudioPidFile();
  cdp = await startFakeCdp();
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    // ATELIER_PID_FILE keeps this test server from overwriting the real studio's .local/server.pid.
    // ATELIER_ADB is a command line: the runner splits it into node and the fake's path.
    env: { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects'), ATELIER_PID_FILE: path.join(root, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs'), ATELIER_CODEX_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-codex.mjs'), CODEX_HOME: path.join(root, 'codex-home'), FAKE_CODEX_LOGIN: 'chatgpt', OPENAI_API_KEY: 'sk-must-not-reach-codex', ATELIER_ADB: `"${process.execPath}" "${path.join(ROOT, 'tests', 'fixtures', 'fake-adb.mjs')}"`, FAKE_ADB_CDP_PORT: String(cdp.port) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exit = code; });
  const startedAt = Date.now();
  // 30 s, not 10: the other test files are running git at the same time. A server that exited is not waited for.
  while (exit === null && Date.now() - startedAt < 30000) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // It has failed now and then in a full run: say why, port taken or slow start.
  throw new Error(`server did not start on port ${PORT} after ${Date.now() - startedAt} ms (exit ${exit}): ${stderr.slice(-500)}`);
});
test('health names the server process; a test server leaves the studio pid file alone', async () => {
  const { data } = await api('GET', '/api/health');
  assert.equal(data.pid, child.pid);
  assert.equal(data.platform, process.platform);
  assert.equal(data.port, PORT);
  const own = JSON.parse(await fsp.readFile(path.join(root, 'server.pid'), 'utf8'));
  assert.deepEqual([own.pid, own.port, own.platform], [child.pid, PORT, process.platform]);
  assert.equal(await readStudioPidFile(), studioPidBefore, '.local/server.pid must not be rewritten by a test server');
});

// First in the file on purpose: later tests add records. A preference is something the person said, so a new
// installation is given none, and no amounts of anyone's budget in words.
test('a fresh data folder starts with no memory: starting the server writes no preference for the person', async () => {
  const all = await api('GET', '/api/memory?scope=all&includeRetracted=1&limit=200');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data, []);
  const data = path.join(root, 'data');
  const names = await fsp.readdir(data);
  assert.equal(names.includes('seeded.json'), false, 'no seed marker');
  assert.deepEqual(await fsp.readdir(path.join(data, 'memory')).catch(() => []), [], 'no record file, no log');
});

after(async () => {
  child?.kill();
  await cdp?.close();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

let projectId;
let versionId;
test('create a project from the game template over HTTP', async () => {
  const r = await api('POST', '/api/projects', { name: 'Http Room', kind: 'game', template: 'game-room-one' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  projectId = r.data.project.id;
  versionId = r.data.version.id;
  const bundle = await api('GET', `/api/projects/${projectId}`);
  assert.equal(bundle.data.versions.length, 1);
  assert.equal(bundle.data.changes.dirty, false);
});

test('preview serves head and version files and refuses escapes', async () => {
  const head = await fetch(`${BASE}/preview/${projectId}/head/`);
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/html/);
  const js = await fetch(`${BASE}/preview/${projectId}/head/src/game.js`);
  assert.equal(js.status, 200);
  const ver = await fetch(`${BASE}/preview/${projectId}/${versionId}/src/index.html`);
  assert.equal(ver.status, 200);
  const esc = await fetch(`${BASE}/preview/${projectId}/head/..%2F..%2Fpackage.json`);
  assert.ok([400, 404].includes(esc.status));
  const studio = await fetch(`${BASE}/preview/${projectId}/head/.studio/project.json`);
  assert.ok([400, 404].includes(studio.status), 'records are not served as preview files');
});

test('budget pause blocks utilities only; retrieval, versions and tasks keep working', async () => {
  const paused = await api('PATCH', '/api/budget', { paused: true });
  assert.equal(paused.data.paused, true);
  const run = await api('POST', '/api/utility/explain', { input: { question: 'q', material: 'm' } });
  assert.equal(run.status, 402);
  assert.equal(run.data.error.code, 'budget_paused');
  assert.match(run.data.error.message, /^API utilities are paused \(by you on \d{4}-\d{2}-\d{2}\)\. Resume them in Budget to run this\. Nothing was spent\.$/);
  const added = await api('POST', '/api/memory', { kind: 'preference', scope: 'user', text: 'Connect each piece to the next release.', tags: ['release'] });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const mem = await api('GET', '/api/memory?scope=user&q=release');
  assert.equal(mem.status, 200);
  assert.ok(Array.isArray(mem.data) && mem.data.some((m) => m.id === added.data.id));
  assert.ok(mem.data.every((m) => m.text.toLowerCase().includes('release') || m.tags.includes('release')));
  const task = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Paused handoff', request: 'Still routable while paused', mode: 'handle' });
  assert.equal(task.status, 200);
  assert.equal(task.data.status, 'ready');
  const ingest = await api('POST', `/api/projects/${projectId}/tasks/${task.data.id}/ingest`);
  assert.equal(ingest.status, 409);
  assert.equal(ingest.data.error.code, 'no_result');
  const resumed = await api('PATCH', '/api/budget', { paused: false });
  assert.equal(resumed.data.paused, false);
  const nokey = await api('POST', '/api/utility/explain', { input: { question: 'q', material: 'm' } });
  assert.equal(nokey.status, 503);
  assert.equal(nokey.data.error.code, 'not_configured');
});

test('checkpoint over HTTP returns 409 with the existing version when nothing changed', async () => {
  const r = await api('POST', `/api/projects/${projectId}/versions`, { label: 'no-op' });
  assert.equal(r.status, 409);
  assert.equal(r.data.existing.id, versionId);
  const w = await api('PUT', `/api/projects/${projectId}/files`, { path: 'src/tuning.js', content: 'window.ATELIER_TUNING = {\n  "maxSpeed": 320\n};\n' });
  assert.equal(w.status, 200);
  const r2 = await api('POST', `/api/projects/${projectId}/versions`, { label: 'Faster', state: 'experiment' });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.n, 2);
  const cmp = await api('GET', `/api/projects/${projectId}/compare?a=${versionId}&b=${r2.data.id}`);
  assert.equal(cmp.data.files.length, 1);
  const bad = await api('PUT', `/api/projects/${projectId}/files`, { path: '../x.txt', content: 'no' });
  assert.equal(bad.status, 400);
});

test('build produces a zip with a sha256 and a release record', async () => {
  const r = await api('POST', `/api/projects/${projectId}/build`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.release.workbench.note, 'static game build (open index.html to play)');
  assert.match(r.data.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.data.artifact.bytes > 1000);
  const st = await fsp.stat(r.data.artifact.path);
  assert.equal(st.size, r.data.artifact.bytes);
  const rel = await api('GET', `/api/projects/${projectId}/releases`);
  assert.equal(rel.data.length, 1);
});

test('task handoff: refused addDirs are 400 and leave no session behind; a good folder runs', async () => {
  const task = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'addDirs check', request: 'Look and report', mode: 'handle' });
  const tid = task.data.id || task.data.task.id;
  const sessions = async () => (await api('GET', `/api/console/sessions?projectId=${projectId}`)).data;
  const before = (await sessions()).length;
  for (const addDirs of [['C:\\'], ['C:'], [path.parse(root).root], [path.join(root, 'projects', 'missing')], 'x']) {
    const r = await api('POST', `/api/projects/${projectId}/tasks/${tid}/console`, { addDirs });
    assert.equal(r.status, 400, JSON.stringify([addDirs, r.data]));
    assert.equal(r.data.error.code, 'invalid_input');
    if (Array.isArray(addDirs)) assert.ok(r.data.error.message.includes(addDirs[0]), r.data.error.message);
  }
  assert.equal((await sessions()).length, before, 'a refusal makes no session');
  const ok = await api('POST', `/api/projects/${projectId}/tasks/${tid}/console`, { addDirs: [path.join(ROOT, 'templates')] });
  assert.ok(ok.status < 300, JSON.stringify(ok.data));
  for (let i = 0; i < 100; i++) {
    const rec = (await api('GET', `/api/console/sessions/${ok.data.sessionId}`)).data;
    if (rec.status === 'idle' && rec.turns.length === 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual((await api('GET', `/api/console/sessions/${ok.data.sessionId}`)).data.addDirs, [path.join(ROOT, 'templates')]);
  await api('DELETE', `/api/console/sessions/${ok.data.sessionId}`);
  await api('PATCH', `/api/projects/${projectId}/tasks/${tid}`, { action: 'cancel' });
});

test('console over HTTP: backends, a fake claude turn (202 then idle), api refusal shape, settings.console merge', async () => {
  const b = await api('GET', '/api/console/backends');
  assert.equal(b.status, 200);
  assert.deepEqual(b.data.backends.map((x) => [x.id, x.available]), [['claude-code', true], ['api', false], ['command', false], ['codex', true]]);
  const st = await api('GET', '/api/settings');
  assert.deepEqual(st.data.console, { command: '', commandMode: 'stdin', timeoutMs: 600000, claudePath: '', codexPath: '', terminalFont: '' });
  const s = await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId, model: 'claude-opus-5-5' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const sent = await api('POST', `/api/console/sessions/${s.data.id}/send`, { text: 'Hello there' });
  assert.equal(sent.status, 202);
  assert.match(sent.data.runId, /^cr_/);
  let rec;
  for (let i = 0; i < 100; i++) {
    rec = (await api('GET', `/api/console/sessions/${s.data.id}`)).data;
    if (rec.status === 'idle' && rec.turns.length === 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(Object.keys(rec.turns[1].modelUsage), ['claude-opus-5-5']);
  assert.match(rec.turns[1].text, /echo: Hello there/);
  const list = await api('GET', `/api/console/sessions?projectId=${projectId}`);
  assert.equal(list.data.length, 1);

  // addDirs over the wire: the server's own roots are wired in, and a refusal is 400 invalid_input.
  const outside = await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId, addDirs: [path.parse(root).root] });
  assert.equal(outside.status, 400, JSON.stringify(outside.data));
  assert.equal(outside.data.error.code, 'invalid_input');
  assert.ok(outside.data.error.message.includes(path.parse(root).root), outside.data.error.message);
  const inStudio = await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId, addDirs: [path.join(ROOT, 'templates')] });
  assert.equal(inStudio.status, 200, JSON.stringify(inStudio.data));
  assert.deepEqual(inStudio.data.addDirs, [path.join(ROOT, 'templates')]);
  await api('DELETE', `/api/console/sessions/${inStudio.data.id}`);

  const a = await api('POST', '/api/console/sessions', { backend: 'api' });
  const refused = await api('POST', `/api/console/sessions/${a.data.id}/send`, { text: 'hi' });
  assert.equal(refused.status, 503);
  assert.equal(refused.data.error.code, 'not_configured');
  const cmd = await api('POST', '/api/console/sessions', { backend: 'command' });
  const nocmd = await api('POST', `/api/console/sessions/${cmd.data.id}/send`, { text: 'hi' });
  assert.equal(nocmd.status, 400);
  assert.equal(nocmd.data.error.code, 'console_no_command');

  const patched = await api('PATCH', '/api/settings', { console: { command: 'ollama run llama3.2' } });
  assert.deepEqual(patched.data.console, { command: 'ollama run llama3.2', commandMode: 'stdin', timeoutMs: 600000, claudePath: '', codexPath: '', terminalFont: '' });
  assert.ok(patched.data.apiUtility, 'other settings survive');
  const bad = await api('PATCH', '/api/settings', { console: { commandMode: 'pipe' } });
  assert.equal(bad.status, 400);
  const del = await api('DELETE', `/api/console/sessions/${s.data.id}`);
  assert.equal(del.status, 200);
  assert.equal((await api('GET', `/api/console/sessions/${s.data.id}`)).status, 404);
});

test('codex over HTTP: the status route, a session that is read-only by default, a fake codex turn, a refused sandbox', async () => {
  const st = await api('GET', '/api/console/codex');
  assert.equal(st.status, 200);
  assert.deepEqual([st.data.cli, st.data.loggedIn, st.data.login, st.data.problem], [true, true, 'chatgpt', null]);
  assert.equal(st.data.source, 'built-in', 'the test CODEX_HOME holds no models_cache.json');
  assert.deepEqual(st.data.defaults, { model: null, effort: null });
  assert.deepEqual(st.data.sandboxes, ['read-only', 'workspace-write']);
  const bad = await api('POST', '/api/console/sessions', { backend: 'codex', projectId, sandbox: 'danger-full-access' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /sandbox must be read-only or workspace-write/);
  const s = await api('POST', '/api/console/sessions', { backend: 'codex', projectId, tools: 'studio', title: 'Codex · test' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.deepEqual([s.data.backend, s.data.sandbox, s.data.model, s.data.tools], ['codex', 'read-only', null, 'studio']);
  const sent = await api('POST', `/api/console/sessions/${s.data.id}/send`, { text: 'Second opinion please' });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  let rec;
  for (let i = 0; i < 100; i++) {
    rec = (await api('GET', `/api/console/sessions/${s.data.id}`)).data;
    if (rec.status === 'idle' && rec.turns.length === 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(rec.turns.length, 2, JSON.stringify(rec.turns));
  const turn = rec.turns[1];
  assert.equal(turn.backend, 'codex');
  assert.match(turn.text, /echo: You are answering in the Codex tab[\s\S]*Second opinion please/);
  assert.ok(turn.events.some((e) => e.kind === 'status' && /^env OPENAI_API_KEY=absent /.test(e.summary)), 'the server\'s OPENAI_API_KEY did not reach the child');
  assert.ok(turn.events.some((e) => e.kind === 'status' && /^mcp mcp_servers\.atelier\.env=\{ATELIER_SESSION_ID="cs_/.test(e.summary)));
  assert.match(rec.codexThreadId, /^[0-9a-f-]{36}$/);
  const patched = await api('PATCH', `/api/console/sessions/${s.data.id}`, { sandbox: 'workspace-write' });
  assert.equal(patched.data.sandbox, 'workspace-write');
  assert.equal((await api('PATCH', `/api/console/sessions/${s.data.id}`, { sandbox: 'off' })).status, 400);
  assert.equal((await api('PATCH', '/api/settings', { console: { codexPath: 7 } })).status, 400);
  await api('DELETE', `/api/console/sessions/${s.data.id}`);
});

test('settings.console.terminalFont: a string up to 120 chars, anything else is 400', async () => {
  const ok = await api('PATCH', '/api/settings', { console: { terminalFont: 'Cascadia Mono, monospace' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.console.terminalFont, 'Cascadia Mono, monospace');
  assert.equal((await api('PATCH', '/api/settings', { console: { terminalFont: 12 } })).status, 400);
  assert.equal((await api('PATCH', '/api/settings', { console: { terminalFont: 'x'.repeat(121) } })).status, 400);
  await api('PATCH', '/api/settings', { console: { terminalFont: '', command: '' } });
});

test('POST tasks/:tid/console hands a task to a Chat session that may run the studio CLI', async () => {
  const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Slow the falls a little so the jump feels floatier', request: 'Edit src/tuning.js; the loop lives in src/game.js.', mode: 'handle' });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const tid = t.data.id;
  const r = await api('POST', `/api/projects/${projectId}/tasks/${tid}/console`, { model: 'claude-fable-5-1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.sessionId, /^cs_/);
  assert.match(r.data.runId, /^cr_/);
  let rec;
  for (let i = 0; i < 100; i++) {
    rec = (await api('GET', `/api/console/sessions/${r.data.sessionId}`)).data;
    if (rec.status === 'idle' && rec.turns.length === 2) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(rec.taskId, tid);
  assert.equal(rec.title, 'Task · Slow the falls a little so the jump feels floatier');
  assert.equal(rec.model, 'claude-fable-5-1');
  assert.equal(rec.permissionMode, 'acceptEdits');
  assert.equal(rec.allowStudioCli, true);
  const first = rec.turns[0].text;
  assert.ok(first.includes(`.studio/tasks/${tid}/brief.md`));
  for (const verb of ['handover', 'start', 'note', 'question', 'finish']) assert.ok(first.includes(`atelier.mjs" task ${verb} ${tid}`), verb);
  const argv = rec.turns[1].events.find((e) => e.kind === 'status' && e.summary.startsWith('argv '));
  assert.ok(argv && argv.summary.includes('"--allowedTools","Bash(node:*)","Bash(npm run:*)","Bash(npm test:*)","Bash(git status:*)","Bash(git diff:*)","Bash(git log:*)","Bash(git show:*)","--disallowedTools","PowerShell"'), argv?.summary);
  const got = await api('GET', `/api/projects/${projectId}/tasks/${tid}`);
  const handed = got.data.events.find((e) => e.type === 'handed_to_console');
  assert.deepEqual(handed && { actor: handed.actor, data: handed.data }, { actor: 'studio', data: { sessionId: r.data.sessionId } });
  // an invalid model falls back to Opus; a closed task is refused
  const r2 = await api('POST', `/api/projects/${projectId}/tasks/${tid}/console`, { model: 'gpt-x' });
  assert.equal((await api('GET', `/api/console/sessions/${r2.data.sessionId}`)).data.model, 'claude-opus-5-5');
  await api('PATCH', `/api/projects/${projectId}/tasks/${tid}`, { action: 'cancel' });
  const closed = await api('POST', `/api/projects/${projectId}/tasks/${tid}/console`, {});
  assert.equal(closed.status, 409);
  assert.equal(closed.data.error.code, 'task_closed');
  for (const id of [r.data.sessionId, r2.data.sessionId]) {
    for (let i = 0; i < 100 && (await api('GET', `/api/console/sessions/${id}`)).data.status !== 'idle'; i++) await new Promise((res) => setTimeout(res, 100));
    await api('DELETE', `/api/console/sessions/${id}`);
  }
});

test('GET task names the versions its result and events mention; ids it cannot find are left out', async () => {
  const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Name my version', request: 'Change the tuning', mode: 'handle' });
  const tid = t.data.id;
  assert.deepEqual((await api('GET', `/api/projects/${projectId}/tasks/${tid}`)).data.versionNames, {});
  await api('PUT', `/api/projects/${projectId}/files`, { path: 'src/tuning.js', content: `window.ATELIER_TUNING = {\n  "maxSpeed": ${300 + Math.floor(Math.random() * 1000)}.5\n};\n` });
  const cli = spawn(process.execPath, ['bin/atelier.mjs', 'task', 'finish', tid, '--project', projectId, '--summary', 'Tuned'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects') },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await new Promise((res) => cli.on('exit', res)), 0);
  const { data: bundle } = await api('GET', `/api/projects/${projectId}`);
  const made = bundle.versions.find((v) => v.taskId === tid);
  assert.ok(made, 'the finish checkpointed a version');
  await fsp.appendFile(path.join(bundle.entry.path, '.studio', 'tasks', tid, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'note', actor: 'test', data: { versionId: 'v_gone' } }) + '\n');
  const got = await api('GET', `/api/projects/${projectId}/tasks/${tid}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.task.result.versionId, made.id);
  assert.deepEqual(got.data.versionNames, { [made.id]: `#${made.n} Name my version` });
  assert.deepEqual(got.data.task.result.versionIds, [made.id]);
  // every list route carries the numbers, so a row says "produced #n" without the detail
  const inList = (list) => list.find((x) => x.id === tid).result.versionNumbers;
  assert.deepEqual(inList((await api('GET', `/api/projects/${projectId}/tasks`)).data), [made.n]);
  assert.deepEqual(inList((await api('GET', '/api/tasks')).data.tasks), [made.n]);
  assert.deepEqual(inList((await api('GET', `/api/projects/${projectId}`)).data.tasks), [made.n]);
  await api('POST', `/api/projects/${projectId}/tasks/${tid}/ingest`);
});

test('every task list carries startedAt and finishedAt, so the version strip needs no detail fetch', async () => {
  const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'When did I run', request: 'Change the tuning again', mode: 'handle' });
  const tid = t.data.id;
  const lists = async () => [
    (await api('GET', `/api/projects/${projectId}/tasks`)).data,
    (await api('GET', '/api/tasks')).data.tasks,
    (await api('GET', `/api/projects/${projectId}`)).data.tasks,
  ].map((list) => list.find((x) => x.id === tid));
  for (const row of await lists()) {
    assert.equal(row.startedAt ?? null, null, 'not started');
    assert.equal(row.finishedAt ?? null, null, 'not finished');
  }
  const run = (...args) => promisify(execFile)(process.execPath, ['bin/atelier.mjs', 'task', ...args, tid, '--project', projectId], { cwd: ROOT, env: cliEnv, windowsHide: true });
  await run('start');
  await api('PUT', `/api/projects/${projectId}/files`, { path: 'src/tuning.js', content: `window.ATELIER_TUNING = {\n  "maxSpeed": ${300 + Math.floor(Math.random() * 1000)}.25\n};\n` });
  await promisify(execFile)(process.execPath, ['bin/atelier.mjs', 'task', 'finish', tid, '--project', projectId, '--summary', 'Tuned again'], { cwd: ROOT, env: cliEnv, windowsHide: true });
  const detail = (await api('GET', `/api/projects/${projectId}/tasks/${tid}`)).data.task;
  assert.ok(detail.startedAt && detail.result.finishedAt);
  for (const row of await lists()) {
    assert.equal(row.startedAt, detail.startedAt);
    assert.equal(row.finishedAt, detail.result.finishedAt);
  }
  await api('POST', `/api/projects/${projectId}/tasks/${tid}/ingest`);
});

test('vendor/xterm serves exactly three allowlisted files; terminal routes validate input', async () => {
  for (const [p, type] of [['/vendor/xterm/xterm.js', /javascript/], ['/vendor/xterm/addon-fit.js', /javascript/], ['/vendor/xterm/xterm.css', /text\/css/]]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type);
    await r.arrayBuffer();
  }
  for (const p of ['/vendor/xterm/', '/vendor/xterm/package.json', '/vendor/xterm/..%2F..%2Fpackage.json', '/vendor/node-pty/package.json', '/vendor/']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 404, p);
    await r.text();
  }
  const list = await api('GET', '/api/terminal');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data));
  assert.equal((await api('POST', '/api/terminal/term_nope/input', { data: 'x' })).status, 404);
  assert.equal((await api('POST', '/api/terminal', { cols: 1, rows: 10 })).status, 400);
  assert.equal((await api('DELETE', '/api/terminal/term_nope')).status, 404);
});

test('GET /api/runs: one project or all, a terminal as a Working row then Stopped · closed; a bad id is 400', async () => {
  const all = await api('GET', '/api/runs');
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.data.runs));
  assert.match(all.data.note, /^since the studio started at \d{4}-/, 'a young server says since when it knows');
  assert.equal(all.data.keepHours, 24);
  assert.equal((await api('GET', '/api/runs?projectId=..%2Fx')).status, 400);
  const opened = await api('POST', '/api/terminal', { projectId, cols: 80, rows: 24 });
  if (opened.status === 503) return; // node-pty cannot load here: no shell, no row (tests/runs.test.mjs covers the registry)
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const mine = await api('GET', `/api/runs?projectId=${projectId}`);
  const row = mine.data.runs.find((r) => r.id === opened.data.id);
  assert.ok(row, 'the shell is a run of its project');
  assert.deepEqual([row.kind, row.state, row.endedAt, row.projectId], ['terminal', 'Working', null, projectId]);
  assert.match(row.latest, /^open /);
  assert.ok(mine.data.runs.every((r) => r.projectId === projectId), 'one project lists only its own runs');
  assert.equal((await api('DELETE', `/api/terminal/${opened.data.id}`)).status, 200);
  const after = (await api('GET', '/api/runs?projectId=all')).data.runs.find((r) => r.id === opened.data.id);
  assert.deepEqual([after.state, after.reason], ['Stopped', 'closed']);
  assert.ok(after.endedAt);
});

test('GET /api/guide serves docs/GUIDE.md as markdown text', async () => {
  const r = await fetch(BASE + '/api/guide');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/markdown/);
  const text = await r.text();
  assert.equal(text, await fsp.readFile(path.join(ROOT, 'docs', 'GUIDE.md'), 'utf8'));
});

test('observed balance date entered as YYYY-MM-DD comes back unchanged', async () => {
  const saved = await api('PATCH', '/api/budget', { observed: { balanceUsd: 150, asOf: '2026-11-04' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.observed.asOf, '2026-11-04');
  assert.equal((await api('GET', '/api/budget')).data.observed.asOf, '2026-11-04');
  await api('PATCH', '/api/budget', { observed: { balanceUsd: null } });
});

// A complete 16-bit PCM WAV of `frames` silent mono samples at 44100 Hz.
const wavBytes = (frames) => {
  const b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + frames * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(frames * 2, 40);
  return b;
};
const renderBody = (over = {}) => ({ id: 'blip', wav: wavBytes(4410).toString('base64'), seconds: 0.1, peak: 0.25, sampleRate: 44100, ...over });

test('audio render: writes a valid WAV under dist/audio, answers with its facts, stays out of versions and survives restore', async () => {
  const { data: bundle } = await api('GET', `/api/projects/${projectId}`);
  const r = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const bytes = 44 + 4410 * 2;
  const { staleAgainstTuning, tuningUnknown, mtime, ...saved } = r.data;
  assert.deepEqual(saved, { path: 'dist/audio/blip.wav', bytes, seconds: 0.1, peak: 0.25, sampleRate: 44100 });
  assert.equal(staleAgainstTuning, false);
  assert.equal(typeof tuningUnknown, 'boolean');
  const file = path.join(bundle.entry.path, 'dist', 'audio', 'blip.wav');
  assert.equal(mtime, (await fsp.stat(file)).mtime.toISOString(), 'the answer carries the time of the file itself');
  const written = await fsp.readFile(file);
  assert.deepEqual(written, wavBytes(4410));
  assert.deepEqual((await fsp.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  assert.equal((await api('GET', `/api/projects/${projectId}/changes`)).data.dirty, false, 'a render does not dirty the project');
  const restored = await api('POST', `/api/projects/${projectId}/restore`, { versionId: bundle.versions[0].id });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.deepEqual(await fsp.readFile(file), written, 'a render survives Restore');
  const again = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ wav: wavBytes(10).toString('base64') }));
  assert.equal(again.data.bytes, 64, 'a second render replaces the first');
});

test('audio render: a body that is not RIFF/WAVE or not base64 is 400 and writes nothing', async () => {
  const notWav = Buffer.from('this is not a wave file at all').toString('base64');
  for (const wav of [notWav, Buffer.from('RIFF').toString('base64'), 'not base64 !!!', 12]) {
    const r = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ id: 'refused', wav }));
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.error.code, 'invalid_input');
  }
  const { data: bundle } = await api('GET', `/api/projects/${projectId}`);
  await assert.rejects(fsp.stat(path.join(bundle.entry.path, 'dist', 'audio', 'refused.wav')));
});

test('audio render: an id with a slash, dots, capitals or a Windows device name is 400', async () => {
  for (const id of ['a/b', '../evil', '..', 'a.b', 'a\\b', 'Blip', '-a', '', 'a'.repeat(42), 'a\n', 'con', 'nul', 'com1', 7]) {
    const r = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ id }));
    assert.equal(r.status, 400, JSON.stringify([id, r.data]));
  }
  for (const over of [{ seconds: 'x' }, { peak: -1 }, { peak: null }, { sampleRate: 0 }, { tuning: 3 }, { tuning: [1] }, { tuning: null }, { tuning: { a: 'x'.repeat(64 * 1024) } }]) {
    assert.equal((await api('POST', `/api/projects/${projectId}/audio/render`, renderBody(over))).status, 400, JSON.stringify(over).slice(0, 60));
  }
});

test('audio render: a peak above full scale is 400 and names the peak; full scale itself is written', async () => {
  const over = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ id: 'loud', peak: 1.5 }));
  assert.equal(over.status, 400, JSON.stringify(over.data));
  assert.match(over.data.error.message, /peak must be at most 1.*1\.5/);
  const { data: bundle } = await api('GET', `/api/projects/${projectId}`);
  await assert.rejects(fsp.stat(path.join(bundle.entry.path, 'dist', 'audio', 'loud.wav')));
  assert.equal((await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ id: 'loud', peak: 1 }))).status, 200);
});

test('audio render: exactly 20 MB is written; one byte more and a body over the limit are 413 with a clear message', async () => {
  const MB20 = 20 * 1024 * 1024;
  const atCap = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ id: 'big', wav: wavBytes((MB20 - 44) / 2).toString('base64') }));
  assert.equal(atCap.status, 200, JSON.stringify(atCap.data));
  assert.equal(atCap.data.bytes, MB20);
  const over = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ id: 'big', wav: Buffer.concat([wavBytes((MB20 - 44) / 2), Buffer.alloc(1)]).toString('base64') }));
  assert.equal(over.status, 413, JSON.stringify(over.data));
  assert.match(over.data.error.message, /larger than 20 MB/);
  const huge = await api('POST', `/api/projects/${projectId}/audio/render`, renderBody({ id: 'big', wav: 'A'.repeat(30 * 1024 * 1024) }));
  assert.equal(huge.status, 413, JSON.stringify(huge.data));
  assert.match(huge.data.error.message, /too large/);
  const other = await api('PUT', `/api/projects/${projectId}/files`, { path: 'src/x.txt', content: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal(other.status, 413, 'every other route keeps the 4 MB limit');
});

test('audio renders: the list reads each file, and the read returns its bytes', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Renders', kind: 'audio', template: 'audio-sound-sketch' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.project?.id || created.data.id;
  const url = `/api/projects/${id}/audio/renders`;
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  assert.deepEqual((await api('GET', url)).data, [], 'no dist/audio yet: an empty list');
  assert.equal((await api('GET', `${url}/blip`)).status, 404);

  const wav = wavBytes(4410);
  wav.writeInt16LE(-8192, 44 + 100 * 2);
  wav.writeInt16LE(4096, 44 + 200 * 2);
  // The product's own numbers are wrong on purpose: the list reads the file.
  assert.equal((await api('POST', `/api/projects/${id}/audio/render`, renderBody({ wav: wav.toString('base64'), seconds: 9, peak: 0.9, sampleRate: 8000 }))).status, 200);
  const [entry, ...rest] = (await api('GET', url)).data;
  assert.deepEqual(rest, []);
  const { mtime, ...facts } = entry;
  assert.deepEqual(facts, { id: 'blip', path: 'dist/audio/blip.wav', bytes: wav.length, staleAgainstTuning: false, tuningUnknown: true, seconds: 0.1, peak: 0.25, sampleRate: 44100 });
  assert.ok(!Number.isNaN(Date.parse(mtime)));

  const res = await fetch(`${BASE}${url}/blip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), wav, 'byte for byte');

  // What Build/Export would skip is not a render; a file that is not 16-bit PCM is listed with why, and does not cost the others.
  const audioDir = path.join(bundle.entry.path, 'dist', 'audio');
  await fsp.writeFile(path.join(audioDir, 'tick.wav.abc123.tmp'), 'partial');
  await fsp.writeFile(path.join(audioDir, 'tick.tuning.json'), '{}');
  await fsp.writeFile(path.join(audioDir, 'blip.tuning.json.abc123.tmp'), '{');
  await fsp.mkdir(path.join(audioDir, 'folder.wav'));
  await fsp.writeFile(path.join(audioDir, 'Not-A-Cue.wav'), wav);
  await fsp.writeFile(path.join(audioDir, 'broken.wav'), Buffer.from('RIFF0000WAVE', 'latin1'));
  const list = (await api('GET', url)).data;
  assert.deepEqual(list.map((f) => f.id), ['blip', 'broken']);
  assert.equal(list[1].error, 'no fmt chunk');
  assert.equal(list[1].seconds, undefined);

  for (const bad of ['..%2F..%2Fatelier', 'a.b', 'con', 'Blip']) {
    assert.equal((await api('GET', `${url}/${bad}`)).status, bad.startsWith('..') ? 404 : 400, bad);
  }
});

test('audio renders: the stale flag compares values with the sidecar, never file times', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Renders Values', kind: 'audio', template: 'audio-sound-sketch' });
  const id = created.data.project?.id || created.data.id;
  const url = `/api/projects/${id}/audio/renders`;
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  const manifest = JSON.parse(await fsp.readFile(path.join(bundle.entry.path, 'atelier.json'), 'utf8'));
  const tuningPath = path.join(bundle.entry.path, manifest.tuning);
  const text = await fsp.readFile(tuningPath, 'utf8');
  const values = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const audioDir = path.join(bundle.entry.path, 'dist', 'audio');
  const sidecar = path.join(audioDir, 'blip.tuning.json');
  const blip = async () => (await api('GET', url)).data[0];
  // The product answers with every key it has, so one more than the file holds is the ordinary case.
  const rendered = { ...values, onlyInTheProduct: 1 };

  const saved = await api('POST', `/api/projects/${id}/audio/render`, renderBody({ tuning: rendered }));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.staleAgainstTuning, false);
  assert.equal(saved.data.tuningUnknown, false);
  assert.deepEqual(JSON.parse(await fsp.readFile(sidecar, 'utf8')), rendered, 'written beside the file');
  assert.deepEqual((await fsp.readdir(audioDir)).sort(), ['blip.tuning.json', 'blip.wav'], 'no temp file left');
  assert.equal((await api('GET', `/api/projects/${id}/changes`)).data.dirty, false, 'a sidecar does not dirty the project');
  assert.equal((await blip()).staleAgainstTuning, false);

  // Save to file at the same values: the tuning file is now newer than the render, and the render still holds.
  const later = new Date(Date.now() + 60000);
  await fsp.writeFile(tuningPath, text);
  await fsp.utimes(tuningPath, later, later);
  assert.equal((await blip()).staleAgainstTuning, false, 'a newer file at the same values');

  const [key] = Object.keys(values).filter((k) => typeof values[k] === 'number');
  const changed = { ...values, [key]: values[key] / 2 };
  await fsp.writeFile(tuningPath, text.replace(/\{[\s\S]*\}/, JSON.stringify(changed)));
  assert.equal((await blip()).staleAgainstTuning, true, 'a changed value');
  const laterStill = new Date(later.getTime() + 60000);
  await fsp.utimes(path.join(audioDir, 'blip.wav'), laterStill, laterStill);
  assert.equal((await blip()).staleAgainstTuning, true, 'a newer render at other values is still stale');

  // A render at values the file does not hold (applied live, not saved) says so in its own answer.
  const live = await api('POST', `/api/projects/${id}/audio/render`, renderBody({ tuning: values }));
  assert.equal(live.data.staleAgainstTuning, true);
  await fsp.writeFile(tuningPath, text);
  assert.equal((await blip()).staleAgainstTuning, false, 'and saving those values settles it');

  // A key only the file holds is one the product ignored.
  await fsp.writeFile(tuningPath, text.replace(/\{[\s\S]*\}/, JSON.stringify({ ...values, unknownToTheProduct: 9 })));
  assert.equal((await blip()).staleAgainstTuning, false);
  await fsp.writeFile(tuningPath, text);

  // A product that sends no tuning must not inherit the last render's values.
  await api('POST', `/api/projects/${id}/audio/render`, renderBody());
  await assert.rejects(fsp.stat(sidecar));
  const unknown = await blip();
  assert.deepEqual([unknown.staleAgainstTuning, unknown.tuningUnknown], [false, true], 'missing sidecar: unknown, not stale');

  await fsp.writeFile(sidecar, 'not json');
  assert.equal((await blip()).tuningUnknown, true, 'a sidecar that cannot be read is unknown too');
});

test('audio renders: a manifest without a readable tuning file says nothing about the tuning', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Renders Two', kind: 'audio', template: 'audio-sound-sketch' });
  const id = created.data.project?.id || created.data.id;
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  const manifestPath = path.join(bundle.entry.path, 'atelier.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await api('POST', `/api/projects/${id}/audio/render`, renderBody());
  for (const tuning of [undefined, '../../outside.js', 'src/missing.js']) {
    await fsp.writeFile(manifestPath, JSON.stringify({ ...manifest, tuning }));
    const r = await api('GET', `/api/projects/${id}/audio/renders`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data[0].staleAgainstTuning, false, String(tuning));
    assert.equal(r.data[0].tuningUnknown, false, String(tuning));
  }
});

const zipEntries = async (zipPath) => unzipSync(new Uint8Array(await fsp.readFile(zipPath)));
const wavsIn = (entries) => Object.keys(entries).filter((f) => f.includes('/audio/')).map((f) => f.split('/').slice(1).join('/')).sort();

test('audio build: renders travel in the zip under audio/ and the note counts them; none means no audio folder', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Sketch', kind: 'audio', template: 'audio-sound-sketch' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.project.id;
  const build = async () => {
    const r = await api('POST', `/api/projects/${id}/build`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };

  const bare = await build();
  assert.equal(bare.release.workbench.note, 'static copy, no rendered files yet');
  const bareEntries = await zipEntries(bare.artifact.path);
  assert.deepEqual(wavsIn(bareEntries), []);
  assert.ok(Object.keys(bareEntries).some((f) => f.endsWith('/index.html')), 'the static copy is there');
  assert.ok(Object.keys(bareEntries).some((f) => f.endsWith('/VERSION.txt')));
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  await assert.rejects(fsp.stat(path.join(bare.artifact.unpacked, 'audio')), 'no empty audio folder');

  const wav = wavBytes(441);
  const saved = await api('POST', `/api/projects/${id}/audio/render`, renderBody({ id: 'tap', wav: wav.toString('base64'), tuning: { tapVolume: 0.35 } }));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  // Neither a render's leftover temp file nor a folder that looks like a render is a rendered file; nor is its sidecar.
  const audioDir = path.join(bundle.entry.path, 'dist', 'audio');
  await fsp.stat(path.join(audioDir, 'tap.tuning.json'));
  await fsp.writeFile(path.join(audioDir, 'tick.wav.abc123.tmp'), 'partial');
  await fsp.mkdir(path.join(audioDir, 'folder.wav'));

  const one = await build();
  assert.equal(one.release.workbench.note, 'static copy + 1 rendered file');
  assert.equal(one.artifact.files, bare.artifact.files + 1);
  const oneEntries = await zipEntries(one.artifact.path);
  assert.deepEqual(wavsIn(oneEntries), ['audio/tap.wav'], 'no sidecar in the export');
  assert.deepEqual(Buffer.from(Object.entries(oneEntries).find(([f]) => f.endsWith('/audio/tap.wav'))[1]), wav);

  // A .wav the list never names is not exported either, and the note counts it.
  await fsp.writeFile(path.join(audioDir, 'Not-A-Cue.wav'), wav);
  await fsp.writeFile(path.join(audioDir, 'con.wav'), wav);
  const skipping = await build();
  assert.equal(skipping.release.workbench.note, 'static copy + 1 rendered file, 2 skipped by name');
  assert.deepEqual(wavsIn(await zipEntries(skipping.artifact.path)), ['audio/tap.wav']);
  assert.deepEqual((await api('GET', `/api/projects/${id}/audio/renders`)).data.map((f) => f.id), ['tap'], 'the same names as the list');
  await fsp.rm(path.join(audioDir, 'Not-A-Cue.wav'));
  await fsp.rm(path.join(audioDir, 'con.wav'));

  await api('POST', `/api/projects/${id}/audio/render`, renderBody({ id: 'blip' }));
  const two = await build();
  assert.equal(two.release.workbench.note, 'static copy + 2 rendered files');
  assert.deepEqual(wavsIn(await zipEntries(two.artifact.path)), ['audio/blip.wav', 'audio/tap.wav']);
  assert.equal((await api('GET', `/api/projects/${id}/changes`)).data.dirty, false, 'a build leaves the project clean');
});

test('audio build: a missing source folder is still 400 no_source_dir', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Sketch Two', kind: 'audio', template: 'audio-sound-sketch' });
  const id = created.data.project.id;
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  const manifestPath = path.join(bundle.entry.path, 'atelier.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, JSON.stringify({ ...manifest, build: { ...manifest.build, dir: 'missing' } }, null, 2));
  assert.equal((await api('POST', `/api/projects/${id}/versions`, { label: 'Point the build at nothing' })).status, 200);
  const r = await api('POST', `/api/projects/${id}/build`, {});
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.error.code, 'no_source_dir');
});

test('release notes: the typed text is in the zip and on the record, apart from the readiness count', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Notes', kind: 'game', template: 'game-room-one' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.project.id;
  const first = await api('POST', `/api/projects/${id}/build`, {});
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.release.notes, '');
  assert.ok(!Object.keys(await zipEntries(first.data.artifact.path)).some((f) => f.endsWith('/RELEASE-NOTES.md')), 'no notes, no file');

  const keep = async (speed, label, note) => {
    assert.equal((await api('PUT', `/api/projects/${id}/files`, { path: 'src/tuning.js', content: `window.ATELIER_TUNING = {\n  "maxSpeed": ${speed}\n};\n` })).status, 200);
    const v = await api('POST', `/api/projects/${id}/versions`, { label, note, state: 'selected' });
    assert.equal(v.status, 200, JSON.stringify(v.data));
    return v.data;
  };
  await keep(310, 'Quicker start', 'Less wind-up');
  const head = await keep(330, 'Higher jump');

  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  const draft = await api('GET', `/api/projects/${id}/release-notes-draft?version=${head.id}`);
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const notes = releaseNotesDraft(draft.data);
  assert.equal(notes, `Changes since #1 "${bundle.versions[0].label}"\n#2 Quicker start\n  Less wind-up\n#3 Higher jump`);

  const r = await api('POST', `/api/projects/${id}/build`, { notes });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const entries = await zipEntries(r.data.artifact.path);
  const file = Object.keys(entries).find((f) => f.endsWith('/RELEASE-NOTES.md'));
  assert.ok(file, 'RELEASE-NOTES.md is in the zip');
  const lines = Buffer.from(entries[file]).toString('utf8').trimEnd().split('\n');
  assert.equal(lines[0], '# Http Notes: #3 Higher jump');
  assert.ok(lines.includes('#2 Quicker start') && lines.includes('  Less wind-up') && lines.includes('#3 Higher jump'), lines.join('|'));

  const records = (await api('GET', `/api/projects/${id}/releases`)).data;
  assert.equal(records.at(-1).builtLocal, localDateTime(records.at(-1).createdAt), 'the record reads the local clock');
  assert.equal(lines.at(-1), `${records.at(-1).builtLocal} · ${head.sha}`);
  assert.equal(records.at(-1).notes, notes, 'the record keeps the text as typed');
  assert.match(records.at(-1).readinessSummary, /^(Readiness at export: \d+ of \d+ items met|No readiness checklist at export)$/);
  assert.equal(records.at(-1).notes.includes('Readiness'), false);
  assert.equal((await api('GET', `/api/projects/${id}/changes`)).data.dirty, false, 'a build leaves the project clean');
});

test('release notes: the count comes from the ticks, whitespace is no notes, too much or not text is 400 and spares the last export', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Notes Two', kind: 'game', template: 'game-room-one' });
  const id = created.data.project.id;
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  const manifestPath = path.join(bundle.entry.path, 'atelier.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, JSON.stringify({ ...manifest, readiness: ['Runs', 'Sounds right'] }, null, 2));
  assert.equal((await api('POST', `/api/projects/${id}/versions`, { label: 'Add a checklist' })).status, 200);
  assert.equal((await api('PATCH', `/api/projects/${id}`, { ui: { ...bundle.project.ui, readiness: { Runs: true } } })).status, 200);

  const blank = await api('POST', `/api/projects/${id}/build`, { notes: ' \n ' });
  assert.equal(blank.status, 200, JSON.stringify(blank.data));
  assert.equal(blank.data.release.notes, '');
  assert.equal(blank.data.release.readinessSummary, 'Readiness at export: 1 of 2 items met');
  assert.ok(!Object.keys(await zipEntries(blank.data.artifact.path)).some((f) => f.endsWith('/RELEASE-NOTES.md')));

  const atLimit = await api('POST', `/api/projects/${id}/build`, { notes: 'x'.repeat(MAX_NOTES_BYTES) });
  assert.equal(atLimit.status, 200, JSON.stringify(atLimit.data));
  for (const notes of ['x'.repeat(MAX_NOTES_BYTES + 1), 'é'.repeat(MAX_NOTES_BYTES / 2 + 1), 42]) {
    const r = await api('POST', `/api/projects/${id}/build`, { notes });
    assert.equal(r.status, 400, JSON.stringify(r.data).slice(0, 200));
    assert.equal(r.data.error.code, 'invalid_input');
  }
  await fsp.stat(atLimit.data.artifact.unpacked);
  assert.equal((await api('GET', `/api/projects/${id}/releases`)).data.length, 2, 'a refusal records no release');
});

test('release notes draft: two branches from one base list only the exported version\'s ancestors', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Branches', kind: 'game', template: 'game-room-one' });
  const id = created.data.project.id;
  const keep = async (speed, label, note = '') => {
    assert.equal((await api('PUT', `/api/projects/${id}/files`, { path: 'src/tuning.js', content: `window.ATELIER_TUNING = {\n  "maxSpeed": ${speed}\n};\n` })).status, 200);
    const v = await api('POST', `/api/projects/${id}/versions`, { label, note });
    assert.equal(v.status, 200, JSON.stringify(v.data));
    return v.data;
  };
  const restore = async (v) => assert.equal((await api('POST', `/api/projects/${id}/restore`, { versionId: v.id })).status, 200);
  const draftOf = async (v) => {
    const r = await api('GET', `/api/projects/${id}/release-notes-draft?version=${v.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };

  const base = await keep(301, 'Base');
  const released = await api('POST', `/api/projects/${id}/build`, {});
  assert.equal(released.status, 200, JSON.stringify(released.data));
  const optionA = await keep(302, 'Option A', 'Not chosen');
  await restore(base);
  const optionB = await keep(303, 'Option B');
  const optionC = await keep(304, 'Option C on B');
  assert.ok(optionA.n < optionB.n && optionB.n < optionC.n, 'A sits between the base and the chosen branch by number');

  const second = await draftOf(optionC);
  assert.deepEqual(second.versions.map((v) => v.id), [optionB.id, optionC.id], 'oldest first, and not the option on the other branch');
  assert.equal(second.since.id, base.id);
  assert.equal(second.releasedAs, null);
  assert.equal(releaseNotesDraft(second), `Changes since #${base.n} "Base"\n#${optionB.n} Option B\n#${optionC.n} Option C on B`);
  assert.deepEqual((await draftOf(optionA)).versions.map((v) => v.id), [optionA.id], 'the other branch has only its own');
  assert.deepEqual((await draftOf(optionB)).versions.map((v) => v.id), [optionB.id], 'a version stops at itself');

  // Export the second branch, then that same version again: one honest line.
  const notes = releaseNotesDraft(second);
  const exported = await api('POST', `/api/projects/${id}/build`, { notes });
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  const again = await draftOf(optionC);
  assert.deepEqual(again.versions, []);
  assert.equal(releaseNotesDraft(again), `This version was released as http-branches-v${optionC.n}.zip on ${exported.data.release.builtLocal}; no changes since.`);

  // Behind the last release, and the other branch measured from it.
  assert.equal(releaseNotesDraft(await draftOf(base)), `No changes since #${optionC.n} "Option C on B": this version is older than that release.`);
  assert.deepEqual((await draftOf(optionA)).versions.map((v) => v.id), [optionA.id]);

  const missing = await api('GET', `/api/projects/${id}/release-notes-draft?version=v_nope`);
  assert.equal(missing.status, 404);
  const none = await api('GET', `/api/projects/${id}/release-notes-draft`);
  assert.equal(none.status, 400);
  assert.equal(none.data.error.code, 'invalid_input');
});

test('release notes draft: a release on one branch and an export of a lower-numbered sibling', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Sibling', kind: 'game', template: 'game-room-one' });
  const id = created.data.project.id;
  const keep = async (speed, label) => {
    assert.equal((await api('PUT', `/api/projects/${id}/files`, { path: 'src/tuning.js', content: `window.ATELIER_TUNING = {\n  "maxSpeed": ${speed}\n};\n` })).status, 200);
    const v = await api('POST', `/api/projects/${id}/versions`, { label });
    assert.equal(v.status, 200, JSON.stringify(v.data));
    return v.data;
  };
  const restore = async (v) => assert.equal((await api('POST', `/api/projects/${id}/restore`, { versionId: v.id })).status, 200);

  // The shape of Sound Sketch: an option off the base, then the branch that was released, numbered above it.
  const base = await keep(311, 'Base');
  const option = await keep(312, 'Option off the base');
  await restore(base);
  const chosen = await keep(313, 'Chosen');
  assert.equal((await api('POST', `/api/projects/${id}/build`, {})).status, 200);
  assert.ok(option.n < chosen.n, 'the exported version has the lower number');

  await restore(option);
  const r = await api('GET', `/api/projects/${id}/release-notes-draft?version=${option.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.since.id, chosen.id);
  assert.equal(r.data.sibling, true);
  assert.deepEqual(r.data.versions.map((v) => v.id), [option.id], 'back to the merge base: the base itself is in both');
  assert.equal(releaseNotesDraft(r.data), `Changes since #${chosen.n} (a sibling of this version; what this version has that #${chosen.n} does not)\n#${option.n} Option off the base`);

  // Not siblings: an ancestor of the release, and a version on top of it.
  const behind = (await api('GET', `/api/projects/${id}/release-notes-draft?version=${base.id}`)).data;
  assert.equal(behind.sibling, false);
  assert.equal(releaseNotesDraft(behind), `No changes since #${chosen.n} "Chosen": this version is older than that release.`);
  await restore(chosen);
  const ahead = await keep(314, 'On top');
  const onTop = (await api('GET', `/api/projects/${id}/release-notes-draft?version=${ahead.id}`)).data;
  assert.equal(onTop.sibling, false);
  assert.equal(releaseNotesDraft(onTop), `Changes since #${chosen.n} "Chosen"\n#${ahead.n} On top`);
});

test('template drift over HTTP: a fresh project is up to date, a changed file is named, a blank project has no template', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Drift', kind: 'audio', template: 'audio-sound-sketch' });
  const id = created.data.project.id;
  assert.equal(created.data.project.template.name, 'audio-sound-sketch');
  const fresh = await api('GET', `/api/projects/${id}/template-drift`);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.data.template, 'audio-sound-sketch');
  assert.equal(fresh.data.behind, 0);
  assert.match(fresh.data.note, /may be your own change/);
  assert.equal((await api('PUT', `/api/projects/${id}/files`, { path: 'src/style.css', content: 'body { color: red }\n' })).status, 200);
  const changed = (await api('GET', `/api/projects/${id}/template-drift`)).data;
  assert.equal(changed.behind, 1);
  assert.deepEqual(changed.files.filter((f) => !f.same).map((f) => f.path), ['src/style.css']);
  const diff = await api('GET', `/api/projects/${id}/template-drift/diff?path=${encodeURIComponent('src/style.css')}`);
  assert.equal(diff.status, 200, JSON.stringify(diff.data));
  assert.match(diff.data.diff, /^\+body \{ color: red \}$/m);
  for (const rel of ['README.md', 'src/tuning.js', '../secret']) {
    const refused = await api('GET', `/api/projects/${id}/template-drift/diff?path=${encodeURIComponent(rel)}`);
    assert.equal(refused.status, 400, rel);
    assert.equal(refused.data.error?.code ?? refused.data.code, 'not_in_drift', JSON.stringify(refused.data));
  }

  const blank = await api('POST', '/api/projects', { name: 'Http Blank Drift', kind: 'web-app' });
  const none = await api('GET', `/api/projects/${blank.data.project.id}/template-drift`);
  assert.equal(none.status, 200);
  assert.equal(none.data.template, null);
});

test('a template can be set after the fact: an existing one of the project\'s kind, stored as createProject stores it', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Late Template', kind: 'audio' });
  const id = created.data.project.id;
  assert.equal(created.data.project.template, undefined);

  const refused = async (template) => {
    const r = await api('PATCH', `/api/projects/${id}`, { template });
    assert.equal(r.status, 400, JSON.stringify(template));
    assert.equal(r.data.error.code, 'invalid_input');
  };
  await refused({ name: 'no-such-template' });
  await refused({ name: 'game-room-one' }); // exists, wrong kind
  await refused({ name: '../templates/audio-sound-sketch' });
  await refused({ name: 'audio-sound-sketch/.' });
  await refused({});
  await refused('audio-sound-sketch');
  assert.equal((await api('GET', `/api/projects/${id}`)).data.project.template, undefined, 'a refusal stores nothing');

  const before = Date.now();
  const set = await api('PATCH', `/api/projects/${id}`, { template: { name: 'audio-sound-sketch', at: '2000-01-01T00:00:00.000Z', projectName: 'Claimed', extra: 1 } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const { name, at, projectName, ...rest } = set.data.template;
  assert.equal(name, 'audio-sound-sketch');
  assert.equal(projectName, 'Http Late Template');
  assert.ok(Date.parse(at) >= before - 1000, 'the server stamps the time');
  assert.deepEqual(rest, {});

  const drift = (await api('GET', `/api/projects/${id}/template-drift`)).data;
  assert.equal(drift.template, 'audio-sound-sketch');
  assert.equal(drift.available, true);
  assert.ok(drift.behind > 0, 'a blank project is behind the template it now names');

  const unset = await api('PATCH', `/api/projects/${id}`, { template: null });
  assert.equal(unset.status, 200, JSON.stringify(unset.data));
  assert.ok(!('template' in unset.data), 'the record is gone, not null');
  const stored = (await api('GET', `/api/projects/${id}`)).data.project;
  assert.ok(!('template' in stored));
  assert.equal((await api('GET', `/api/projects/${id}/template-drift`)).data.template, null);
  assert.equal((await api('PATCH', `/api/projects/${id}`, { template: null })).status, 200, 'unsetting no record is no error');
});

test('unresolved by id: two stale clients, one adds four while the other resolves an earlier group, and all four survive', async () => {
  const id = (await api('POST', '/api/projects', { name: 'Http Stale Clients', kind: 'audio' })).data.project.id;
  const carried = (n) => ({ text: `old ${n}`, taskId: 't_old', taskTitle: 'Old task' });
  const seeded = (await api('PATCH', `/api/projects/${id}`, { unresolved: ['typed', carried(1), carried(2)] })).data.unresolved;
  const group = seeded.filter((u) => u.taskId === 't_old').map((u) => u.id);
  assert.equal(group.length, 2);

  // Both drew the same list. Together, so neither sees the other's write.
  const stale = await Promise.all([
    ...[1, 2, 3, 4].map((n) => api('PATCH', `/api/projects/${id}`, { unresolvedAdd: [{ text: `new ${n}` }] })),
    api('PATCH', `/api/projects/${id}`, { unresolvedResolve: group }),
  ]);
  for (const r of stale) assert.equal(r.status, 200, JSON.stringify(r.data));
  const list = (await api('GET', `/api/projects/${id}`)).data.project.unresolved;
  assert.deepEqual(list.map((u) => u.text).sort(), ['new 1', 'new 2', 'new 3', 'new 4', 'typed']);
  assert.equal(new Set(list.map((u) => u.id)).size, 5, 'each has its own id');
  assert.ok(list.every((u) => u.id && u.createdAt && !u.taskId), 'added items read as typed');
  assert.equal(list.find((u) => u.text === 'typed').id, seeded[0].id, 'what stays keeps its id');

  // The same order one after the other: an id that is gone is no error and changes nothing.
  const again = await api('PATCH', `/api/projects/${id}`, { unresolvedResolve: [...group, 'u_never'] });
  assert.equal(again.status, 200);
  assert.equal(again.data.unresolved.length, 5);
  assert.ok(!('unresolvedResolve' in again.data) && !('unresolvedAdd' in again.data), 'the operations are not stored');

  // The plain list stays for existing callers.
  assert.deepEqual((await api('PATCH', `/api/projects/${id}`, { unresolved: ['only this'] })).data.unresolved.map((u) => u.text), ['only this']);
});

test('unresolved by id: a malformed operation is 400 and stores nothing', async () => {
  const id = (await api('POST', '/api/projects', { name: 'Http Bad Operations', kind: 'audio' })).data.project.id;
  await api('PATCH', `/api/projects/${id}`, { unresolved: ['stays'] });
  for (const partial of [{ unresolvedAdd: 'text' }, { unresolvedAdd: ['text'] }, { unresolvedAdd: [{ text: '   ' }] }, { unresolvedAdd: [{}] }, { unresolvedAdd: [null] }, { unresolvedResolve: 'u_1' }, { unresolvedResolve: [1] }]) {
    const r = await api('PATCH', `/api/projects/${id}`, partial);
    assert.equal(r.status, 400, JSON.stringify(partial));
    assert.equal(r.data.error.code, 'invalid_input');
  }
  assert.deepEqual((await api('GET', `/api/projects/${id}`)).data.project.unresolved.map((u) => u.text), ['stays']);
});

test('a change under .studio reaches the event stream right after the project is created', async () => {
  const listening = new AbortController();
  const stream = await fetch(`${BASE}/api/events`, { signal: listening.signal });
  const seen = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream.body) seen.push(decoder.decode(chunk));
  })().catch(() => {});
  try {
    const created = (await api('POST', '/api/projects', { name: 'Http Watched At Once', kind: 'audio' })).data;
    const id = created.project.id;
    const made = (await api('POST', `/api/projects/${id}/tasks`, { title: 'Watched', request: 'x', mode: 'handle' })).data;
    const tid = made.id || made.task.id;
    const folder = (await api('GET', '/api/projects')).data.find((p) => p.id === id).path;
    // What the CLI's note does, from outside the server. Well inside the 15 s of the periodic scan.
    await fsp.appendFile(path.join(folder, '.studio', 'tasks', tid, 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), type: 'note', actor: 'test', data: { text: 'outside' } })}\n`);
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await new Promise((r) => setTimeout(r, 50));
      found = seen.join('').split('\n').some((line) => line.startsWith('data:') && line.includes(`"taskId":"${tid}"`) && line.includes('events.jsonl'));
    }
    assert.ok(found, `no task.changed for the append in ${seen.join('').slice(-400)}`);
  } finally {
    listening.abort();
    await reading;
  }
});

test('release notes draft: options of one explore task in one line of commits are siblings', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Options', kind: 'game', template: 'game-room-one' });
  const id = created.data.project.id;
  const taskOf = async (mode) => (await api('POST', `/api/projects/${id}/tasks`, { title: `Options ${mode}`, mode, request: 'Two options' })).data;
  const keep = async (speed, label, taskId) => {
    assert.equal((await api('PUT', `/api/projects/${id}/files`, { path: 'src/tuning.js', content: `window.ATELIER_TUNING = {\n  "maxSpeed": ${speed}\n};\n` })).status, 200);
    if (taskId) return dropRole(id, await checkpointForTask(id, label, taskId)); // Sound Sketch's options have no role
    const v = await api('POST', `/api/projects/${id}/versions`, { label });
    assert.equal(v.status, 200, JSON.stringify(v.data));
    return v.data;
  };
  const build = async () => assert.equal((await api('POST', `/api/projects/${id}/build`, {})).status, 200);
  const restore = async (v) => assert.equal((await api('POST', `/api/projects/${id}/restore`, { versionId: v.id })).status, 200);
  const draft = async (v) => (await api('GET', `/api/projects/${id}/release-notes-draft?version=${v.id}`)).data;

  // The shape of Sound Sketch #9 to #11: no Restore between options, so #second sits on top of #first in git.
  const base = await keep(321, 'Base');
  const explore = await taskOf('explore');
  const first = await keep(322, 'First option', explore.id);
  const second = await keep(323, 'Second option', explore.id);
  assert.equal(second.parentId, first.id, 'one line of commits');
  await build();

  await restore(first);
  const r = await draft(first);
  assert.equal(r.since.id, second.id);
  assert.equal(r.sibling, true);
  assert.deepEqual(r.versions.map((v) => v.id), [first.id]);
  assert.equal(releaseNotesDraft(r), `Changes since #${second.n} (a sibling of this version; what this version has that #${second.n} does not)\n#${first.n} First option`);
  assert.equal((await draft(base)).sibling, false, 'the base of the options is not one of them');

  // The other way round: the first option released, the second exported.
  await build();
  const other = await draft(second);
  assert.equal(other.since.id, first.id);
  assert.equal(other.sibling, true);
  assert.deepEqual(other.versions.map((v) => v.id), [second.id]);
  const again = await draft(first);
  assert.equal(again.sibling, false, 'the released option itself');
  assert.ok(again.releasedAs);

  // The same line from a task that is not exploring is one version after another.
  await restore(second);
  const handle = await taskOf('handle');
  const third = await keep(324, 'Third step', handle.id);
  const fourth = await keep(325, 'Fourth step', handle.id);
  await build();
  const older = await draft(third);
  assert.equal(older.sibling, false);
  assert.deepEqual(older.versions, []);
  assert.equal(releaseNotesDraft(older), `No changes since #${fourth.n} "Fourth step": this version is older than that release.`);
});

test('release notes draft: a finish checkpoint is no option, and options with a role answer to git', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http Finish', kind: 'game', template: 'game-room-one' });
  const id = created.data.project.id;
  const write = async (speed) => assert.equal((await api('PUT', `/api/projects/${id}/files`, { path: 'src/tuning.js', content: `window.ATELIER_TUNING = {\n  "maxSpeed": ${speed}\n};\n` })).status, 200);
  const keep = async (speed, label, taskId, role) => {
    await write(speed);
    const v = await checkpointForTask(id, label, taskId);
    assert.equal(v.role, 'option', 'the task is exploring');
    return role ? v : dropRole(id, v);
  };
  const build = async () => assert.equal((await api('POST', `/api/projects/${id}/build`, {})).status, 200);
  const restore = async (v) => assert.equal((await api('POST', `/api/projects/${id}/restore`, { versionId: v.id })).status, 200);
  const draft = async (v) => (await api('GET', `/api/projects/${id}/release-notes-draft?version=${v.id}`)).data;
  const task = (await api('POST', `/api/projects/${id}/tasks`, { title: 'Finish after options', mode: 'explore', request: 'Two options' })).data;

  // Options with no role sit in one line (decision 43 still holds for them); the finish keeps what is left on disk.
  const optionA = await keep(331, 'Option A', task.id);
  await build();
  const optionB = await keep(332, 'Option B', task.id);
  await write(333);
  const cli = spawn(process.execPath, ['bin/atelier.mjs', 'task', 'finish', task.id, '--project', id, '--summary', 'Left on disk'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects') },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await new Promise((res) => cli.on('exit', res)), 0);
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  const finish = bundle.versions.at(-1);
  assert.equal(finish.taskId, task.id);
  assert.equal(finish.role, 'finish');

  const r = await draft(finish);
  assert.equal(r.since.id, optionA.id);
  assert.equal(r.sibling, false);
  assert.deepEqual(r.versions.map((v) => v.id), [optionB.id, finish.id]);
  assert.equal(releaseNotesDraft(r), `Changes since #${optionA.n} "Option A"\n#${optionB.n} Option B\n#${finish.n} Finish after options\n  Task ${task.id}: Left on disk`);
  assert.equal((await draft(optionB)).sibling, true, 'the two without a role stay siblings');

  // Options with a role: real siblings say so, and one built on the other is not one.
  const later = (await api('POST', `/api/projects/${id}/tasks`, { title: 'Real branches', mode: 'explore', request: 'Two options' })).data;
  const base = finish;
  const left =await keep(341, 'Left', later.id, 'option');
  const onLeft = await keep(342, 'On left', later.id, 'option');
  await restore(left);
  await build();
  const onTop = await draft(onLeft);
  assert.equal(onTop.sibling, false);
  assert.deepEqual(onTop.versions.map((v) => v.id), [onLeft.id]);
  await restore(base);
  const right = await keep(343, 'Right', later.id, 'option');
  const apart = await draft(right);
  assert.equal(apart.since.id, left.id);
  assert.equal(apart.sibling, true);
  assert.deepEqual(apart.versions.map((v) => v.id), [right.id]);
});

test('the versions route takes label, note and state from the body; the rest is not the client\'s to say', async () => {
  const id = (await api('POST', '/api/projects', { name: 'Http Route Fields', kind: 'game', template: 'game-room-one' })).data.project.id;
  const task = (await api('POST', `/api/projects/${id}/tasks`, { title: 'Not this way', mode: 'explore', request: 'x' })).data;
  assert.equal((await api('PUT', `/api/projects/${id}/files`, { path: 'src/tuning.js', content: 'window.ATELIER_TUNING = {\n  "maxSpeed": 351\n};\n' })).status, 200);
  const r = await api('POST', `/api/projects/${id}/versions`, { label: 'Mine', note: 'A note', state: 'selected', taskId: task.id, role: 'option', origin: 'claude-code', pieceTitle: 'Not mine', force: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.label, r.data.note, r.data.state], ['Mine', 'A note', 'selected']);
  assert.deepEqual([r.data.origin, r.data.taskId, r.data.role], ['user', null, undefined]);
  assert.notEqual(r.data.pieceTitle, 'Not mine');
  assert.equal((await api('POST', `/api/projects/${id}/versions`, { label: 'Again', force: true })).status, 409, 'force is not taken either');
  assert.equal((await api('POST', `/api/projects/${id}/versions`, { label: 'Odd role', role: 'winner', state: 'nonsense' })).status, 400, 'state is still checked');
});

test('PATCH ui merges one level deep: a partial map keeps the other keys, null removes one, a non-map is refused; task summaries carry intent', async () => {
  const created = (await api('POST', '/api/projects', { name: 'Http Ui Merge', kind: 'game', template: 'game-room-one' })).data;
  const id = created.project.id;
  const ui = async () => (await api('GET', `/api/projects/${id}`)).data.project.ui;
  assert.equal((await api('PATCH', `/api/projects/${id}`, { ui: { dockTab: 'phone', dockHeight: 420, companionSessionId: 'cs_1', pageInView: { key: 'index.html', name: 'Start' } } })).status, 200);
  // The whole-map send the dock makes, and the partial send a script made on 2026-11-07 that used to wipe the rest.
  const partial = await api('PATCH', `/api/projects/${id}`, { ui: { pages: {} } });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.data.ui, { layout: {}, dockTab: 'phone', dockHeight: 420, companionSessionId: 'cs_1', pageInView: { key: 'index.html', name: 'Start' }, pages: {} }, 'the other keys stay');
  assert.deepEqual(await ui(), partial.data.ui, 'as stored');
  const removed = await api('PATCH', `/api/projects/${id}`, { ui: { companionSessionId: null, dockHeight: 300 } });
  assert.equal(removed.status, 200);
  assert.equal('companionSessionId' in removed.data.ui, false, 'null removes the key');
  assert.equal(removed.data.ui.dockHeight, 300);
  assert.equal(removed.data.ui.dockTab, 'phone');
  assert.deepEqual((await api('PATCH', `/api/projects/${id}`, { ui: { pages: { 'index.html': { aura: 'plain' } } } })).data.ui.pages, { 'index.html': { aura: 'plain' } }, 'one level: a nested map is replaced whole');
  for (const bad of ['x', 3, ['a'], null]) {
    const r = await api('PATCH', `/api/projects/${id}`, { ui: bad });
    assert.equal(r.status, 400, `ui ${JSON.stringify(bad)} is refused`);
    assert.equal(r.data.error.code, 'invalid_input');
  }
  assert.equal((await ui()).dockTab, 'phone', 'a refused send changed nothing');
  // A companion session's model, mode and effort change between turns; an attachment is saved inside the project.
  const ses = (await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId: id, model: 'claude-opus-5-5', tools: 'studio', context: 'companion', effort: 'high' })).data;
  assert.equal(ses.effort, 'high');
  const changed = await api('PATCH', `/api/console/sessions/${ses.id}`, { model: 'claude-sonnet-5-5', permissionMode: 'plan', effort: null });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.deepEqual([changed.data.model, changed.data.permissionMode, changed.data.effort], ['claude-sonnet-5-5', 'plan', null]);
  assert.equal((await api('PATCH', `/api/console/sessions/${ses.id}`, { effort: 'huge' })).status, 400);
  assert.equal((await api('PATCH', `/api/console/sessions/${ses.id}`, { permissionMode: 'yolo' })).status, 400);
  assert.equal((await api('PATCH', `/api/console/sessions/${ses.id}`, { title: 'x' })).status, 400, 'only the three fields');
  const att = await api('POST', `/api/projects/${id}/companion/attachments`, { name: 'my shot.png', type: 'image/png', data: Buffer.from('PNG-bytes').toString('base64') });
  assert.equal(att.status, 200, JSON.stringify(att.data));
  assert.match(att.data.path, /^\.studio\/attachments\/\d{8}-\d{6}-my_shot\.png$/);
  assert.equal(att.data.bytes, 9);
  assert.equal(await fsp.readFile(path.join(created.entry.path, att.data.path), 'utf8'), 'PNG-bytes', 'saved inside the project');
  assert.equal((await api('POST', `/api/projects/${id}/companion/attachments`, { name: '', data: 'QQ==' })).status, 400);
  assert.equal((await api('POST', `/api/projects/${id}/companion/attachments`, { name: 'x.bin', data: 'not base64 at all!!' })).status, 400);
  // The bundle's task summaries carry intent: the request's first sentence when it says more than the title.
  const spoken = (await api('POST', `/api/projects/${id}/tasks`, { title: 'Tighten the title spacing', request: 'The h1 sits too close to the subtitle; give it room.\nSee the case screen.', mode: 'handle' })).data;
  const named = (await api('POST', `/api/projects/${id}/tasks`, { request: 'Give the footer room. Then the header.', mode: 'handle' })).data;
  const summaries = (await api('GET', `/api/projects/${id}`)).data.tasks;
  assert.equal(summaries.find((t) => t.id === spoken.id).intent, 'The h1 sits too close to the subtitle; give it room.');
  assert.equal(summaries.find((t) => t.id === named.id).intent, null, 'the title is that sentence: no intent');
  assert.equal('request' in summaries.find((t) => t.id === spoken.id), false, 'no request rides the bundle');
});

test('remove then import brings the project back: its id, records, versions and task rows', async () => {
  const created = (await api('POST', '/api/projects', { name: 'Http Back Again', kind: 'game', template: 'game-room-one' })).data;
  const id = created.project.id;
  const folder = created.entry.path;
  const piece = { title: 'The jump', why: 'It is the game', acceptance: ['Feels right'] };
  assert.equal((await api('PATCH', `/api/projects/${id}`, { purpose: 'A purpose worth keeping', audience: 'Me', currentPiece: piece, ui: { layout: { dock: 3 } }, unresolvedAdd: [{ text: 'Still open' }] })).status, 200);
  const task = (await api('POST', `/api/projects/${id}/tasks`, { title: 'An old row', mode: 'handle', request: 'x' })).data;
  const versionsBefore = (await api('GET', `/api/projects/${id}/versions`)).data;

  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 200);
  assert.equal((await api('GET', `/api/projects/${id}`)).status, 404);
  assert.ok(!(await api('GET', '/api/tasks')).data.tasks.some((t) => t.id === task.id));

  // Name: what the dialog fills in from the folder when the person typed nothing.
  const back = await api('POST', '/api/projects/import', { path: folder, name: path.basename(folder) });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.project.id, id, 'the same id: every record that names it stays right');
  assert.equal(back.data.version.id, versionsBefore.at(-1).id, 'HEAD already has its version');
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  assert.equal(bundle.project.name, 'Http Back Again');
  assert.equal(bundle.project.purpose, 'A purpose worth keeping');
  assert.equal(bundle.project.audience, 'Me');
  assert.deepEqual(bundle.project.currentPiece, piece);
  assert.deepEqual(bundle.project.ui, { layout: { dock: 3 } });
  assert.equal(bundle.project.template.name, 'game-room-one');
  assert.deepEqual(bundle.project.unresolved.map((u) => u.text), ['Still open']);
  assert.deepEqual(bundle.versions.map((v) => v.id), versionsBefore.map((v) => v.id), 'no second record of one commit');
  assert.deepEqual(bundle.tasks.map((t) => t.id), [task.id]);
  const entry = (await api('GET', '/api/projects')).data.find((p) => p.id === id);
  assert.deepEqual([entry.name, entry.kind, entry.createdAt], ['Http Back Again', 'game', created.project.createdAt]);
  assert.equal((await api('GET', '/api/tasks')).data.tasks.find((t) => t.id === task.id).projectId, id);
  const already = await api('POST', '/api/projects/import', { path: folder });
  assert.equal(already.status, 409, 'already registered');
  assertNamesProject(already, id, 'Http Back Again');

  // Records that lack a field take the default for that field alone.
  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 200);
  const file = path.join(folder, '.studio', 'project.json');
  const { components, ...lacking } = JSON.parse(await fsp.readFile(file, 'utf8'));
  await fsp.writeFile(file, JSON.stringify(lacking));
  const filled = (await api('POST', '/api/projects/import', { path: folder })).data.project;
  assert.deepEqual([filled.components, filled.purpose], [[], 'A purpose worth keeping']);

  // A copy of a registered folder is its own project: a new id, the copied records, its own rows.
  const copy = path.join(path.dirname(folder), 'http-back-again-copy');
  await fsp.cp(folder, copy, { recursive: true });
  const copied = await api('POST', '/api/projects/import', { path: copy });
  assert.equal(copied.status, 200, JSON.stringify(copied.data));
  assert.notEqual(copied.data.project.id, id);
  assert.equal(copied.data.project.purpose, 'A purpose worth keeping');
  const rows = (await api('GET', '/api/tasks')).data.tasks.filter((t) => t.id === task.id).map((t) => t.projectId).sort();
  assert.deepEqual(rows, [id, copied.data.project.id].sort());
});

const gitIn = async (folder, ...args) => (await promisify(execFile)('git', args, { cwd: folder, windowsHide: true })).stdout.trim();

test('a hand commit made while the project was removed: import adds one Imported version at HEAD and keeps the earlier ones', async () => {
  const created = (await api('POST', '/api/projects', { name: 'Http Hand Commit', kind: 'audio' })).data;
  const id = created.project.id;
  const folder = created.entry.path;
  const before = (await api('GET', `/api/projects/${id}/versions`)).data;
  assert.ok(before.length >= 1);
  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 200);

  await fsp.writeFile(path.join(folder, 'by-hand.txt'), 'made away from the studio\n');
  await gitIn(folder, 'add', 'by-hand.txt');
  await gitIn(folder, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'A hand commit');
  const head = await gitIn(folder, 'rev-parse', 'HEAD');
  assert.notEqual(head, before.at(-1).sha);

  const back = await api('POST', '/api/projects/import', { path: folder, name: path.basename(folder) });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.project.id, id);
  const after = (await api('GET', `/api/projects/${id}/versions`)).data;
  assert.deepEqual(after.slice(0, before.length), before, 'the earlier versions stand as they were');
  assert.equal(after.length, before.length + 1);
  const made = after.at(-1);
  assert.deepEqual([made.label, made.origin, made.sha, made.n, made.id], ['Imported version', 'import', head, before.length + 1, back.data.version.id]);
  assert.equal(await gitIn(folder, 'rev-parse', `atelier/${made.id}^{commit}`), head, 'the tag a Restore goes by');

  // HEAD now has its version: another round adds nothing.
  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 200);
  const again = await api('POST', '/api/projects/import', { path: folder, name: path.basename(folder) });
  assert.equal(again.data.version.id, made.id);
  assert.deepEqual((await api('GET', `/api/projects/${id}/versions`)).data.map((v) => v.id), after.map((v) => v.id));
});

test('a damaged project.json: import starts from defaults under a FRESH id, keeps a .corrupt copy, and versions and task rows stay', async () => {
  const created = (await api('POST', '/api/projects', { name: 'Http Damaged', kind: 'game', template: 'game-room-one' })).data;
  const id = created.project.id;
  const folder = created.entry.path;
  assert.equal((await api('PATCH', `/api/projects/${id}`, { purpose: 'Lost with the file', unresolvedAdd: [{ text: 'Lost too' }] })).status, 200);
  const task = (await api('POST', `/api/projects/${id}/tasks`, { title: 'A row in the folder', mode: 'handle', request: 'x' })).data;
  const versions = (await api('GET', `/api/projects/${id}/versions`)).data;
  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 200);

  const studio = path.join(folder, '.studio');
  const file = path.join(studio, 'project.json');
  await fsp.writeFile(file, '{ not json');
  const name = path.basename(folder); // what the dialog fills in; nothing stored says otherwise any more
  const back = await api('POST', '/api/projects/import', { path: folder, name });
  assert.equal(back.status, 200, JSON.stringify(back.data));

  const fresh = back.data.project.id;
  assert.match(fresh, /^p_[a-z0-9]+$/);
  assert.notEqual(fresh, id, 'the stored id went with the file');
  assert.equal((await api('GET', `/api/projects/${id}`)).status, 404);
  const copies = (await fsp.readdir(studio)).filter((n) => n.startsWith('project.json.corrupt-'));
  assert.equal(copies.length, 1, copies.join());
  assert.equal(await fsp.readFile(path.join(studio, copies[0]), 'utf8'), '{ not json', 'the damaged words are kept');
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).id, fresh, 'project.json is whole again');

  const { data: bundle } = await api('GET', `/api/projects/${fresh}`);
  assert.deepEqual([bundle.project.name, bundle.project.kind], [name, 'game'], 'the name is the dialog\'s, the kind the manifest\'s');
  assert.notEqual(bundle.project.purpose, 'Lost with the file');
  assert.deepEqual(bundle.project.unresolved, []);
  assert.deepEqual(bundle.versions.map((v) => v.id), versions.map((v) => v.id), 'versions.json is its own file; HEAD already has its version');
  assert.equal(back.data.version.id, versions.at(-1).id);
  assert.deepEqual(bundle.tasks.map((t) => t.id), [task.id]);
  assert.equal((await api('GET', '/api/tasks')).data.tasks.find((t) => t.id === task.id).projectId, fresh);
});

test('a registered folder under a case-different path is the same folder: 409 with its id, one row, the same records', { skip: process.platform !== 'win32' && 'paths differ by case only on Windows' }, async () => {
  const created = (await api('POST', '/api/projects', { name: 'Http Case Path', kind: 'audio' })).data;
  const id = created.project.id;
  const folder = created.entry.path;
  const flipped = (/[a-z]/.test(folder[0]) ? folder[0].toUpperCase() : folder[0].toLowerCase()) + folder.slice(1);
  assert.notEqual(flipped, folder);
  const again = await api('POST', '/api/projects/import', { path: flipped });
  assert.equal(again.status, 409, JSON.stringify(again.data));
  assert.ok(JSON.stringify(again.data).includes(id), 'the answer names the registered id');
  assertNamesProject(again, id, 'Http Case Path');
  assert.equal((await api('GET', '/api/projects')).data.filter((p) => folderIs(p.path, folder)).length, 1);
  assert.equal(JSON.parse(await fsp.readFile(path.join(folder, '.studio', 'project.json'), 'utf8')).id, id);
});

test('a junction to a registered folder is the same folder: 409 naming it, one row, the same id', async () => {
  const created = (await api('POST', '/api/projects', { name: 'Http Junction', kind: 'audio' })).data;
  const id = created.project.id;
  const folder = created.entry.path;
  const link = path.join(path.dirname(folder), 'http-junction-link');
  await fsp.symlink(folder, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const again = await api('POST', '/api/projects/import', { path: link });
    assert.equal(again.status, 409, JSON.stringify(again.data));
    assertNamesProject(again, id, 'Http Junction');
    assert.deepEqual((await api('GET', '/api/projects')).data.filter((p) => p.id === id).map((p) => p.path), [folder]);
    assert.ok(!(await api('GET', '/api/projects')).data.some((p) => folderIs(p.path, link)), 'no row for the link');
    assert.equal(JSON.parse(await fsp.readFile(path.join(folder, '.studio', 'project.json'), 'utf8')).id, id);
  } finally {
    await fsp.rm(link, { recursive: false, force: true }).catch(() => fsp.rmdir(link));
  }
});

test('a removed project emits nothing from its folder, and importing it back watches once', async () => {
  const created = (await api('POST', '/api/projects', { name: 'Http Watched Once', kind: 'audio' })).data;
  const id = created.project.id;
  const task = (await api('POST', `/api/projects/${id}/tasks`, { title: 'Watched', request: 'x', mode: 'handle' })).data;
  const log = path.join(created.entry.path, '.studio', 'tasks', task.id, 'events.jsonl');
  const note = (text) => fsp.appendFile(log, `${JSON.stringify({ ts: new Date().toISOString(), type: 'note', actor: 'test', data: { text } })}\n`);
  const about = (lines) => lines.filter((line) => line.includes(`"taskId":"${task.id}"`) && line.includes('events.jsonl'));
  // The listening itself is checked first: a stream that saw nothing proves nothing below.
  assert.equal(about(await eventsDuring(() => note('registered'))).length, 1);

  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 200);
  assert.deepEqual(about(await eventsDuring(() => note('removed'))), []);

  const back = await api('POST', '/api/projects/import', { path: created.entry.path });
  assert.equal(back.data.project.id, id);
  assert.equal(about(await eventsDuring(() => note('back'))).length, 1);

  // The same folder under another id: the old watcher is gone and only the new id speaks.
  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 200);
  const file = path.join(created.entry.path, '.studio', 'project.json');
  const { id: oldId, ...noId } = JSON.parse(await fsp.readFile(file, 'utf8'));
  await fsp.writeFile(file, JSON.stringify(noId));
  const renewed = (await api('POST', '/api/projects/import', { path: created.entry.path })).data.project.id;
  assert.notEqual(renewed, oldId);
  const lines = about(await eventsDuring(() => note('new id')));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].includes(`"projectId":"${renewed}"`));
});

test('release notes draft: a project never released says First release and lists its history', async () => {
  const created = await api('POST', '/api/projects', { name: 'Http First', kind: 'game', template: 'game-room-one' });
  const id = created.data.project.id;
  const { data: bundle } = await api('GET', `/api/projects/${id}`);
  const r = await api('GET', `/api/projects/${id}/release-notes-draft?version=${bundle.versions[0].id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.since, null);
  assert.equal(r.data.earlierRelease, false);
  assert.ok(releaseNotesDraft(r.data).startsWith(`First release\n#1 ${bundle.versions[0].label}`));
});

test('GET /api/tasks lists tasks across every registered project with the project name', async () => {
  const { status, data } = await api('GET', '/api/tasks');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.tasks));
  for (const t of data.tasks) {
    assert.ok(t.projectId && t.projectName, 'each task names its project');
    assert.ok(t.id && t.status, 'each task carries id and status');
  }
});

// ---------- phone routes over tests/fixtures/fake-adb.mjs (ATELIER_ADB) and fake-cdp.mjs ----------
let phoneId;
test('phone: a project without a device provider answers 404; with a capacitor.config.json, the fake adb devices and the android config', async () => {
  const made = await api('POST', '/api/projects', { name: 'Phone Probe', kind: 'web-app' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  phoneId = made.data.project.id;
  const none = await api('GET', `/api/projects/${phoneId}/phone`);
  assert.equal(none.status, 404);
  assert.equal(none.data.error.code, 'no_device_provider');
  assert.deepEqual((await api('GET', `/api/projects/${phoneId}`)).data.manifest.devices, {});

  await api('PUT', `/api/projects/${phoneId}/files`, { path: 'capacitor.config.json', content: JSON.stringify({ appId: 'com.example.probe', webDir: 'src' }) });
  await api('PUT', `/api/projects/${phoneId}/files`, { path: 'src/index.html', content: '<button id="start" class="btn primary">Start the round now</button>\n' });
  const r = await api('GET', `/api/projects/${phoneId}/phone`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [android] = r.data.providers;
  assert.equal(android.id, 'android');
  assert.equal(android.available, true, android.reason);
  assert.equal(android.tools.adb.source, 'env');
  assert.deepEqual(android.devices, [
    { serial: 'emulator-5554', state: 'device', emulator: true, avd: 'Fake_Pixel', booted: true },
    { serial: '0123456789ABCDEF', state: 'offline', emulator: false, booted: false },
  ]);
  assert.deepEqual(android.app, { appId: 'com.example.probe', serial: 'emulator-5554', installed: true, running: true, pid: 4242 });
  assert.equal(android.config.appId, 'com.example.probe');
  assert.deepEqual(android.config.inferred, ['appId', 'webDir']);
  assert.equal(android.emulatorLog, path.join(root, 'data', 'devices', phoneId, 'emulator.log'), 'the emulator log is under the data dir, not in the project');
  const bundle = (await api('GET', `/api/projects/${phoneId}`)).data;
  assert.equal(bundle.manifest.devices.android.appId, 'com.example.probe');
  assert.equal((await api('POST', `/api/projects/${phoneId}/phone/launch?provider=ios`)).status, 404, 'iOS does not apply: no ios/ folder');
  assert.equal((await api('GET', `/api/projects/${phoneId}/phone/screenshot?provider=nokia`)).status, 400);
});

test('phone: /input with a bad type answers 400, a tap reaches adb; the screenshot is the PNG', async () => {
  const bad = await api('POST', `/api/projects/${phoneId}/phone/input`, { type: 'pinch' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'invalid_input');
  const tap = await api('POST', `/api/projects/${phoneId}/phone/input`, { type: 'tap', x: 3, y: 4 });
  assert.equal(tap.status, 200, JSON.stringify(tap.data));
  assert.deepEqual([tap.data.ok, tap.data.command], [true, 'input tap 3 4']);
  const shot = await fetch(`${BASE}/api/projects/${phoneId}/phone/screenshot`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  assert.equal(shot.headers.get('cache-control'), 'private, max-age=60', 'each URL is its own; the panel\'s visible image reuses the offscreen load');
  const png = Buffer.from(await shot.arrayBuffer());
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [10, 20]);
});

test('phone: /inspect on the fake answers the mapped point, the element and its file', async () => {
  const r = await api('POST', `/api/projects/${phoneId}/phone/inspect`, { x: 5, y: 12 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true, JSON.stringify(r.data));
  assert.deepEqual(r.data.point, { device: { x: 5, y: 12 }, dpr: 1, inset: 2, screenHeight: 20, css: { x: 5, y: 10 } });
  assert.equal(r.data.element.selector, '#start');
  assert.deepEqual(r.data.candidates, [{ file: 'src/index.html', line: 1, matched: ['start', 'btn', 'primary', 'Start the round now'] }]);
  const bad = await api('POST', `/api/projects/${phoneId}/phone/inspect`, { x: 'left' });
  assert.equal(bad.status, 400);
});

test('phone: the build log is an event stream that ends at once when no build has run; GET /build says none', async () => {
  const res = await fetch(`${BASE}/api/projects/${phoneId}/phone/build/log`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text(); // the server ends the stream, so this returns
  assert.match(text, /^event: end\ndata: \{"state":"none"\}/);
  const st = await api('GET', `/api/projects/${phoneId}/phone/build`);
  assert.equal(st.data.state, 'none');
});

test('settings: devices.android is validated and saved; the devices route says where adb was found', async () => {
  for (const body of [{ devices: { android: { sdkRoot: 'a\nb' } } }, { devices: { android: { sdkRoot: 'x'.repeat(401) } } }, { devices: { android: { adbPath: 'C:\\adb' } } }, { devices: { android: { javaHome: 5 } } }, { devices: [] }]) {
    assert.equal((await api('PATCH', '/api/settings', body)).status, 400, JSON.stringify(body));
  }
  const saved = await api('PATCH', '/api/settings', { devices: { android: { sdkRoot: 'C:\\Android\\Sdk' } } });
  assert.equal(saved.status, 200);
  await api('PATCH', '/api/settings', { devices: { android: { javaHome: 'C:\\jdk' } } });
  const { data } = await api('GET', '/api/settings');
  assert.deepEqual(data.devices.android, { sdkRoot: 'C:\\Android\\Sdk', javaHome: 'C:\\jdk', nodeRoot: '' });
  const where = await api('GET', '/api/settings/devices');
  assert.equal(where.status, 200);
  assert.equal(where.data.android.adb.found, true);
  assert.equal(where.data.android.adb.source, 'env');
});

// ---------- companion (docs/ARCHITECTURE.md section 12): pins and the first message's context pack ----------
test('companion pins: POST stores the Pin shape in .studio/pins.json, GET lists, DELETE removes; each change is a pins.changed event', async () => {
  const pin = {
    source: 'phone', element: 'button#start.btn.primary', text: 'Start the round now', selector: '#start',
    point: { device: { x: 5, y: 12 }, css: { x: 5, y: 10 } }, files: ['src/index.html:1'], page: 'https://localhost/',
  };
  let made;
  const lines = await eventsDuring(async () => { made = await api('POST', `/api/projects/${phoneId}/companion/pins`, pin); });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.match(made.data.id, /^pin_/);
  assert.deepEqual({ ...made.data, id: undefined, createdAt: undefined }, { ...pin, note: '', id: undefined, createdAt: undefined });
  assert.ok(lines.some((l) => l.includes('"added"') && l.includes(made.data.id)), lines.join('\n'));
  const folder = (await api('GET', '/api/projects')).data.find((p) => p.id === phoneId).path;
  const stored = JSON.parse(await fsp.readFile(path.join(folder, '.studio', 'pins.json'), 'utf8'));
  assert.deepEqual(stored.pins.map((p) => p.id), [made.data.id]);
  assert.deepEqual((await api('GET', `/api/projects/${phoneId}/companion/pins`)).data.pins.map((p) => p.element), ['button#start.btn.primary']);

  for (const bad of [{ ...pin, source: 'mouse' }, { ...pin, element: '' }, { ...pin, files: 'src/index.html:1' }, { ...pin, point: { device: { x: 'left', y: 1 } } }, { ...pin, text: 'x'.repeat(501) }]) {
    const r = await api('POST', `/api/projects/${phoneId}/companion/pins`, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.data.error.code, 'invalid_input');
  }
  assert.equal((await api('DELETE', `/api/projects/${phoneId}/companion/pins/pin_nothere`)).status, 404);
  assert.equal((await api('GET', '/api/projects/p_nothere/companion/pins')).status, 404);
  const removed = await api('DELETE', `/api/projects/${phoneId}/companion/pins/${made.data.id}`);
  assert.deepEqual(removed.data, { removed: made.data.id });
  assert.deepEqual((await api('GET', `/api/projects/${phoneId}/companion/pins`)).data.pins, []);
});

// ---------- the Page tab (server/lib/page.mjs; docs/ARCHITECTURE.md section 13) ----------
test('page: the entry\'s sibling pages, and POST /page/inspect answering candidates inside the entry folder and refusing a path outside', async () => {
  await api('PUT', `/api/projects/${phoneId}/files`, { path: 'src/about.html', content: '<h1>About</h1>\n<p class="lede">Start the round now, or later.</p>\n' });
  const files = await api('GET', `/api/projects/${phoneId}/page/files`);
  assert.equal(files.status, 200, JSON.stringify(files.data));
  assert.deepEqual(files.data, { entry: 'src/index.html', siblings: ['src/about.html'] });

  const asked = await api('POST', `/api/projects/${phoneId}/page/inspect`, { selector: '#start', id: 'start', classes: ['btn', 'primary'], text: 'Start the round now' });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.equal(asked.data.searched, 'src');
  assert.deepEqual(asked.data.candidates[0], { file: 'src/index.html', line: 1, matched: ['start', 'btn', 'primary', 'Start the round now'] });
  assert.ok(asked.data.candidates.some((c) => c.file === 'src/about.html' && c.line === 2), 'the text also matches the sibling page');
  const byPage = await api('POST', `/api/projects/${phoneId}/page/inspect`, { classes: ['lede'], page: 'src/about.html' });
  assert.deepEqual(byPage.data.candidates.map((c) => `${c.file}:${c.line}`), ['src/about.html:2']);

  for (const page of ['../outside.html', 'capacitor.config.json', '/etc/passwd']) {
    const r = await api('POST', `/api/projects/${phoneId}/page/inspect`, { id: 'start', page });
    assert.equal(r.status, 400, `${page}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error.code, /^path_outside_(entry|project)$/, page);
  }
  assert.equal((await api('POST', `/api/projects/${phoneId}/page/inspect`, {})).status, 400, 'nothing to search for');
  assert.equal((await api('POST', `/api/projects/${phoneId}/page/inspect`, { classes: 'btn' })).status, 400);
  assert.equal((await api('POST', '/api/projects/p_nothere/page/inspect', { id: 'start' })).status, 404);
});

test('a companion session over HTTP: the first message carries the context pack with the pins and the phone line, the second does not', async () => {
  await api('PATCH', `/api/projects/${phoneId}`, { purpose: 'A probe for the phone routes', direction: 'Plain and quick' });
  // The Page tab's aura for the page it last saw: the pack carries it as one line.
  const ui = (await api('GET', `/api/projects/${phoneId}`)).data.project.ui || {};
  await api('PATCH', `/api/projects/${phoneId}`, { ui: { ...ui, pageInView: { key: 'index.html', name: 'Start' }, pages: { 'index.html': { aura: 'quick and plain' } } } });
  const pin = await api('POST', `/api/projects/${phoneId}/companion/pins`, { source: 'phone', element: 'span.mini-case-label', text: 'Case one', files: ['src/index.html:1'] });
  assert.equal((await api('POST', '/api/console/sessions', { backend: 'claude-code', context: 'companion' })).status, 400, 'a companion needs a project');
  assert.equal((await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId: phoneId, context: 'everything' })).status, 400);
  const s = await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId: phoneId, model: 'claude-opus-5-5', permissionMode: 'acceptEdits', tools: 'studio', context: 'companion', title: 'Companion · Phone Probe' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.deepEqual([s.data.context, s.data.tools, s.data.title], ['companion', 'studio', 'Companion · Phone Probe']);
  const turnOf = async (n) => {
    let rec;
    for (let i = 0; i < 100; i++) {
      rec = (await api('GET', `/api/console/sessions/${s.data.id}`)).data;
      if (rec.status === 'idle' && rec.turns.length === n) return rec;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no answer: ${JSON.stringify(rec)}`);
  };
  assert.equal((await api('POST', `/api/console/sessions/${s.data.id}/send`, { text: 'What is on the screen?' })).status, 202);
  const first = await turnOf(2);
  const echo = first.turns[1].text; // the fake claude echoes what reached its stdin
  assert.match(echo, /Studio context \(sent with the first message/);
  assert.match(echo, /Project: Phone Probe \(p_\w+\), web-app, folder /);
  assert.match(echo, /Purpose: A probe for the phone routes/);
  assert.match(echo, /Direction: Plain and quick/);
  assert.match(echo, /Web entry: src\/index\.html/);
  assert.match(echo, /\nOther pages beside it: src\/about\.html\nAura of Start: quick and plain\n/);
  assert.match(echo, /Open pins: 1\n- Pin 1 · span\.mini-case-label · src\/index\.html:1 · "Case one"/);
  // The tools chip depends on whether this machine has an emulator where the settings point; the rest is the fake adb's.
  assert.match(echo, /\nPhone: Android: (Tools found|emulator missing) · Booted · Fake_Pixel · App running · Build idle\n/);
  assert.match(echo, /---\s+What is on the screen\?/);
  assert.equal(first.turns[0].text, 'What is on the screen?', 'the thread keeps the person\'s words');
  assert.ok(first.turns[0].contextPack > 5 && first.turns[0].contextPack <= 60, String(first.turns[0].contextPack));
  assert.equal(first.turns[1].contextUsed, 'the studio context');
  await api('POST', `/api/console/sessions/${s.data.id}/send`, { text: 'And the next part?' });
  const second = await turnOf(4);
  assert.doesNotMatch(second.turns[3].text, /Studio context/);
  assert.match(second.turns[3].text, /echo: And the next part\?/);
  assert.equal(second.turns[3].contextUsed, undefined);
  const listed = (await api('GET', `/api/console/sessions?projectId=${phoneId}`)).data.find((x) => x.id === s.data.id);
  assert.equal(listed.context, 'companion');
  assert.equal(listed.asks, false, 'the echo does not end on a question');
  await api('DELETE', `/api/projects/${phoneId}/companion/pins/${pin.data.id}`);
});

test('the studio Claude Code sign-in: an API key is 400, a token is saved and never returned, auth reads the CLI in the runs\' env, empty removes (decision row 129)', async () => {
  const bad = await api('POST', '/api/secrets/claude-token', { token: 'sk-ant-api03-not-this-one-please' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'invalid_token');
  const before = await api('GET', '/api/console/auth?fresh=1');
  assert.equal(before.status, 200);
  assert.deepEqual({ saved: before.data.studioToken.saved, loggedIn: before.data.loggedIn, authMethod: before.data.authMethod }, { saved: false, loggedIn: false, authMethod: 'none' });
  const ok = await api('POST', '/api/secrets/claude-token', { token: 'sk-ant-oat01-http-test-token-0123456789' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.saved, true);
  assert.match(ok.data.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ loggedIn: ok.data.status.loggedIn, authMethod: ok.data.status.authMethod }, { loggedIn: true, authMethod: 'oauth_token' });
  for (const r of [ok, await api('GET', '/api/console/auth'), await api('GET', '/api/state'), await api('GET', '/api/settings')]) assert.ok(!JSON.stringify(r.data).includes('http-test-token'), 'the token is never returned');
  const off = await api('POST', '/api/secrets/claude-token', { token: '' });
  assert.equal(off.status, 200);
  assert.equal(off.data.saved, false);
  assert.equal(off.data.status.loggedIn, false);
});
