// Codex workers (docs/ARCHITECTURE.md section 17, decision row 182): a worker model of codex:<model>[@<effort>] hands
// a studio task to a session of the person's Codex CLI. Risks covered: the stored form is read the same by the server
// and the client and refused when malformed or not offered; the finish a sandboxed worker records (it cannot write
// .git) becomes a version only through the studio, with Codex named as its origin; a worker session is workspace-write
// and nothing else, with no key in its env; the manager's tools and the usage tally name the backend, model and effort
// and say Codex reports no cost; and the whole path through a real server with the fake Codex CLI ends in a version
// and a report, or in a truthful "did not finish". The real CLI is never run here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-codex-worker-'));
process.env.ATELIER_DATA_DIR = path.join(root, 'data');
process.env.ATELIER_PROJECTS_DIR = path.join(root, 'projects');

const projects = await import('../server/lib/projects.mjs');
const versions = await import('../server/lib/versions.mjs');
const briefing = await import('../server/lib/briefing.mjs');
const git = await import('../server/lib/git.mjs');
const tasks = await import('../server/lib/tasks.mjs');
const models = await import('../server/lib/models.mjs');
const { checkCodexWorker, workerModelLevels, studioWorkerModelOf } = await import('../server/lib/worker-model.mjs');
const { tallyUsage, usageText, CODEX_NO_COST } = await import('../server/lib/usage.mjs');
const { createTools, modelProp, ranOn, ranWords, codexOfferWords, workerModelText, CODEX_WORKER_NOTE, CODEX_REPORT_NOTE } = await import('../server/lib/mcp/tools.mjs');
const { CODEX_FINISH_NOTE } = await import('../server/lib/workers.mjs');
const words = await import('../client/components/worker-model-words.js');
const focus = await import('../client/components/focus.js');
const { sessionBrainLine } = await import('../client/components/companion-words.js');
const { eventWords } = await import('../client/components/status-words.js');

const deps = { checkpoint: (ctx, o) => versions.checkpoint(ctx, o), adoptHead: (ctx, o) => versions.adoptHead(ctx, o), regenerate: (id) => briefing.regenerate(id) };
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

let p; // a real project with its own git repository, for the finish a worker records
let child = null;
let BASE = null;
const e2e = path.join(root, 'e2e');
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
/** A private server whose Codex is the fake CLI and whose CODEX_HOME is empty (so the built-in model list applies). */
async function startServer(extra = {}) {
  await stopServer(); // a test that failed before its own stop must not leave a server behind
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  await fsp.mkdir(path.join(e2e, 'projects'), { recursive: true });
  await fsp.mkdir(path.join(e2e, 'codex-home'), { recursive: true });
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(port), ATELIER_DATA_DIR: path.join(e2e, 'data'), ATELIER_PROJECTS_DIR: path.join(e2e, 'projects'), ATELIER_PID_FILE: path.join(e2e, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(e2e, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'sk-must-not-reach-codex',
      ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs'), ATELIER_CODEX_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-codex.mjs'), CODEX_HOME: path.join(e2e, 'codex-home'), FAKE_CODEX_LOGIN: 'chatgpt', ...extra },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exit = code; });
  const t0 = Date.now();
  while (exit === null && Date.now() - t0 < 30000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start on ${BASE} after ${Date.now() - t0} ms (exit ${exit}): ${stderr.slice(-500)}`);
}
async function stopServer() {
  if (!child) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await gone;
  child = null;
}
/** Start the task and wait until its worker's turn has ended and the folder is free again. */
async function runWorker(projectId, taskId, body = {}) {
  const out = await api('POST', `/api/projects/${projectId}/workers`, { taskId, ...body });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  let rec = (await api('GET', `/api/console/sessions/${out.data.sessionId}`)).data;
  for (let i = 0; i < 200 && (rec.status === 'running' || rec.turns.length < 2); i++) {
    await new Promise((r) => setTimeout(r, 150));
    rec = (await api('GET', `/api/console/sessions/${out.data.sessionId}`)).data;
  }
  for (let i = 0; i < 200 && (await api('GET', `/api/projects/${projectId}/workers`)).data.active; i++) await new Promise((r) => setTimeout(r, 50));
  return { started: out.data, rec };
}
const heldNow = async () => { try { return JSON.parse(await fsp.readFile(path.join(e2e, 'data', 'workers.json'), 'utf8')).held.map((h) => h.text); } catch { return []; } };
/** The held reports once there are at least n: the turn-end hook keeps the version and writes the report after the folder is free. */
async function heldReports(n = 1) {
  let held = await heldNow();
  for (let i = 0; i < 300 && held.length < n; i++) { await new Promise((r) => setTimeout(r, 100)); held = await heldNow(); }
  return held;
}

before(async () => {
  await fsp.mkdir(process.env.ATELIER_PROJECTS_DIR, { recursive: true });
  p = await projects.createProject({ name: 'Codex Room', kind: 'web-app' }, deps);
});
after(async () => {
  await stopServer();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

test('the stored form: a Claude Code id or codex:<model>[@<effort>]; malformed values are a 400 and count as none; the client reads it the same', () => {
  assert.deepEqual(models.parseWorkerModel('claude-opus-5-5'), { backend: 'claude-code', model: 'claude-opus-5-5' });
  assert.deepEqual(models.parseWorkerModel('codex:gpt-6-astra@xhigh'), { backend: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
  assert.deepEqual(models.parseWorkerModel('codex:gpt-6.1-sol'), { backend: 'codex', model: 'gpt-6.1-sol', effort: null });
  assert.equal(models.codexWorkerValue('gpt-6-astra', 'xhigh'), 'codex:gpt-6-astra@xhigh');
  assert.equal(models.codexWorkerValue('gpt-6-astra'), 'codex:gpt-6-astra');
  const bad = ['codex:', 'codex:@high', 'codex:--dangerously-bypass-approvals-and-sandbox', 'codex:gpt 6', 'codex:gpt-6-astra@', 'codex:gpt-6-astra@X HIGH', 'codex:gpt-6-astra@high@low', 'gpt-6-astra', 'Codex:gpt-6-astra', 7, null, {}];
  for (const v of bad) assert.equal(models.parseWorkerModel(v), null, String(v));
  for (const v of bad.filter((x) => typeof x === 'string')) assert.throws(() => models.checkWorkerModel(v), (err) => err.status === 400 && /workerModel must be one of claude-fable-5-2, .*, or default \(got .*\); or codex:<model> or codex:<model>@<effort> for a worker on the Codex CLI$/.test(err.message), v);
  assert.equal(models.checkWorkerModel('codex:gpt-6-astra@xhigh'), 'codex:gpt-6-astra@xhigh');
  assert.equal(models.ownWorkerModel({ workerModel: 'codex:gpt-6-astra@xhigh' }), 'codex:gpt-6-astra@xhigh');
  assert.equal(models.ownWorkerModel({ workerModel: 'codex:--flag' }), null, 'a value edited in by hand that is not well formed counts as none');
  assert.deepEqual(models.resolveWorkerModel({ task: {}, project: { workerModel: 'codex:gpt-6-astra@xhigh' } }), { model: 'codex:gpt-6-astra@xhigh', source: 'project' });
  assert.deepEqual(models.resolveWorkerModel({ studioDefault: 'codex:gpt-6-astra' }), { model: 'codex:gpt-6-astra', source: 'studio' });
  assert.deepEqual(models.resolveWorkerModel(), { model: 'claude-fable-5-2', source: 'studio' }, 'with nothing set a worker is Claude Code on the built-in default');
  assert.equal(models.workerWords('codex:gpt-6-astra@xhigh'), 'Codex gpt-6-astra at xhigh effort');
  assert.equal(models.workerWords('codex:gpt-6-astra'), 'Codex gpt-6-astra at the effort Codex is configured with');
  assert.equal(models.workerWords('claude-opus-5-5'), 'claude-opus-5-5', 'a Claude Code model reads as its id, as before');
  assert.equal(models.workerModelWords({ workerModel: 'codex:gpt-6-astra@xhigh' }), 'Codex gpt-6-astra at xhigh effort (set for this project)');
  // The client's reader agrees with the server's on every value above.
  for (const v of ['claude-opus-5-5', 'codex:gpt-6-astra@xhigh', 'codex:gpt-6.1-sol', ...bad]) assert.deepEqual(words.parseWorker(v), models.parseWorkerModel(v), String(v));
  const levels = workerModelLevels({ studio: studioWorkerModelOf({ workerModel: 'codex:gpt-6-astra@xhigh' }), project: { id: 'p_x', name: 'X', record: {} }, task: null });
  assert.deepEqual(levels.effective, { model: 'codex:gpt-6-astra@xhigh', source: 'studio', words: 'studio default', backend: 'codex', label: 'Codex gpt-6-astra at xhigh effort', codexModel: 'gpt-6-astra', effort: 'xhigh' });
});

test('a Codex worker model must be one Codex offers on this machine: the tab\'s own 400 names its models and efforts', async () => {
  const choices = { models: [{ id: 'gpt-6-astra', efforts: ['low', 'high', 'xhigh'] }, { id: 'gpt-6-luna', efforts: ['low'] }] };
  assert.equal(await checkCodexWorker('codex:gpt-6-astra@xhigh', { choices }), 'codex:gpt-6-astra@xhigh');
  assert.equal(await checkCodexWorker('codex:gpt-6-astra', { choices }), 'codex:gpt-6-astra');
  await assert.rejects(() => checkCodexWorker('codex:gpt-7@low', { choices }), (err) => err.status === 400 && err.message === 'model must be one of gpt-6-astra, gpt-6-luna');
  await assert.rejects(() => checkCodexWorker('codex:gpt-6-luna@xhigh', { choices }), (err) => err.status === 400 && /^effort must be one of low for gpt-6-luna/.test(err.message));
  for (const v of ['claude-opus-5-5', 'default', null, 'gpt-5']) assert.equal(await checkCodexWorker(v, { choices }), v, 'anything that is not a Codex value passes through to the form check');
});

test('a worker that cannot write .git records its finish; only the studio makes it a version, with Codex as its origin', async () => {
  const ctx = await projects.loadProject(p.project.id);
  assert.equal(await git.canWrite(ctx.path), true, 'this test process can write the repository');
  assert.equal(await git.canWrite(root), true, 'a folder that is no repository has nothing to guard');
  const task = await tasks.createTask(ctx, { request: 'Add a note file.', title: 'Add a note file' });
  await tasks.handOverTask(ctx, task.id);
  await tasks.startTask(ctx.path, task.id, 'codex');
  await fsp.mkdir(path.join(ctx.path, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(ctx.path, 'notes', 'hello.txt'), 'hello from the worker\n');
  const before = (await versions.listVersions(ctx.path)).length;

  // In the sandbox (canWrite false): no commit is tried, the finish is recorded and the task stays working.
  const out = await tasks.finishOrRequest(ctx, task.id, { summary: 'Added notes/hello.txt', verification: ['read it back', ''], unresolved: [], decisions: ['kept it plain | no reason to style it'], actor: 'codex' }, { canWrite: async () => false });
  assert.equal(out.deferred, true);
  assert.deepEqual([out.request.summary, out.request.verification, out.request.decisions, out.request.actor], ['Added notes/hello.txt', ['read it back'], ['kept it plain | no reason to style it'], 'codex']);
  let read = await tasks.getTask(ctx.path, task.id);
  assert.deepEqual([read.task.status, read.task.result ?? null, (await versions.listVersions(ctx.path)).length], ['working', null, before], 'no version, no result, still working: status comes from evidence');
  const asked = read.events.at(-1);
  assert.deepEqual([asked.type, asked.actor], ['finish_requested', 'codex']);
  assert.match(asked.data.text, /^Added notes\/hello\.txt \(recorded; the studio keeps the version when the worker's turn ends\)$/);
  assert.equal((await tasks.readFinishRequest(ctx.path, task.id)).summary, 'Added notes/hello.txt');

  // The studio's half: the checkpoint and the result, the version's origin Codex, the record gone.
  const done = await tasks.completeFinishRequest(ctx, task.id);
  assert.equal(done.task.status, 'review');
  assert.deepEqual([done.version.origin, done.version.taskId, done.version.role], ['codex', task.id, 'finish']);
  assert.ok(done.version.filesChanged.some((f) => (f.path || f) === 'notes/hello.txt'), JSON.stringify(done.version.filesChanged));
  assert.deepEqual([done.result.summary, done.result.verification, done.result.decisions, done.result.versionId], ['Added notes/hello.txt', ['read it back'], ['kept it plain | no reason to style it'], done.version.id]);
  read = await tasks.getTask(ctx.path, task.id);
  assert.deepEqual([read.events.at(-1).type, read.events.at(-1).actor], ['finished', 'codex']);
  assert.equal(await tasks.readFinishRequest(ctx.path, task.id), null, 'the record is spent');
  assert.equal(await tasks.completeFinishRequest(ctx, task.id), null, 'nothing recorded: nothing to complete');
  assert.equal((await versions.changes(ctx.path)).dirty, false);

  // Where .git is writable the CLI's finish is the finish itself, as it always was, and a request left behind is spent by it.
  const second = await tasks.createTask(ctx, { request: 'Second note.', title: 'Second note' });
  await tasks.handOverTask(ctx, second.id);
  await tasks.startTask(ctx.path, second.id);
  await tasks.requestFinish(ctx.path, second.id, { summary: 'stale words from an earlier round' }, 'codex');
  await fsp.writeFile(path.join(ctx.path, 'notes', 'second.txt'), 'second\n');
  const direct = await tasks.finishOrRequest(ctx, second.id, { summary: 'Added the second note', actor: 'claude-code' });
  assert.deepEqual([direct.deferred, direct.task.status, direct.version.origin, direct.result.summary], [false, 'review', 'claude-code', 'Added the second note']);
  assert.equal(await tasks.readFinishRequest(ctx.path, second.id), null);
  await assert.rejects(() => tasks.requestFinish(ctx.path, second.id, { summary: '' }), (err) => err.status === 400);
  assert.equal(tasks.actorOf({ ATELIER_ACTOR: 'codex' }), 'codex');
  assert.equal(tasks.actorOf({ ATELIER_ACTOR: 'someone-else' }), 'claude-code');
  assert.equal(tasks.actorOf({}), 'claude-code');
});

test('the studio CLI records its caller: ATELIER_ACTOR=codex makes a Codex session\'s events Codex\'s; a writable repository still finishes directly', async () => {
  const ctx = await projects.loadProject(p.project.id);
  const task = await tasks.createTask(ctx, { request: 'Third note.', title: 'Third note' });
  const cli = (env, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atelier.mjs'), ...args], { cwd: ctx.path, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(cli({ ATELIER_ACTOR: 'codex' }, 'task', 'handover', task.id).status, 0);
  assert.equal(cli({ ATELIER_ACTOR: 'codex' }, 'task', 'start', task.id).status, 0);
  assert.equal(cli({ ATELIER_ACTOR: 'codex' }, 'task', 'note', task.id, 'from the sandbox').status, 0);
  await fsp.writeFile(path.join(ctx.path, 'notes', 'third.txt'), 'third\n');
  const fin = cli({ ATELIER_ACTOR: 'codex' }, 'task', 'finish', task.id, '--summary', 'Added the third note', '--verification', 'read it');
  assert.equal(fin.status, 0, fin.stderr);
  assert.match(fin.stdout, /"status": "review \(Ready to try\)"/, 'this process can write .git, so the CLI finished directly');
  const { events } = await tasks.getTask(ctx.path, task.id);
  assert.deepEqual(events.filter((e) => ['started', 'note', 'finished'].includes(e.type)).map((e) => [e.type, e.actor]), [['started', 'codex'], ['note', 'codex'], ['finished', 'codex']]);
  assert.equal((await versions.listVersions(ctx.path)).at(-1).origin, 'codex');
  const set = cli({}, 'project', 'set', 'worker-model', 'codex:--bad');
  assert.notEqual(set.status, 0);
  assert.match(set.stderr, /workerModel must be one of .*or codex:<model> or codex:<model>@<effort>/);
});

test('usage: Codex sessions are counted apart from Claude Code\'s, by model and effort, with tokens and no cost', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const at = (h) => new Date(now - h * 3600 * 1000).toISOString();
  const records = [
    { id: 'cs_1', backend: 'claude-code', worker: true, model: 'claude-fable-5-2', turns: [{ role: 'user', at: at(2) }, { role: 'assistant', at: at(1), model: 'claude-fable-5-2', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.5 }] },
    { id: 'cs_2', backend: 'codex', worker: true, model: 'gpt-6-astra', effort: 'xhigh', turns: [{ role: 'user', at: at(3) }, { role: 'assistant', at: at(2), backend: 'codex', model: 'gpt-6-astra', effort: 'xhigh', login: 'chatgpt', usage: { input_tokens: 1000, output_tokens: 40, cache_read_input_tokens: 900, reasoning_output_tokens: 12 } }] },
    { id: 'cs_3', backend: 'codex', worker: false, model: 'gpt-6-astra', effort: 'low', turns: [{ role: 'assistant', at: at(30), backend: 'codex', login: 'api-key' }] },
  ];
  const tally = tallyUsage(records, { now });
  assert.deepEqual([tally.sessionsRead, tally.codexSessionsRead], [1, 2]);
  const day = tally.windows[0];
  assert.deepEqual([day.sessions, day.turns, day.rows.length], [1, 1, 1], 'Claude Code\'s counts hold no Codex turn');
  assert.deepEqual(day.codex, { sessions: 1, turns: 1, apiKeyTurns: 0, rows: [{ kind: 'worker', model: 'gpt-6-astra', effort: 'xhigh', turns: 1, turnsWithTokens: 1, tokens: { input: 1000, output: 40, cachedInput: 900, reasoningOutput: 12 }, sessions: 1 }] });
  assert.deepEqual([tally.windows[1].codex.sessions, tally.windows[1].codex.turns, tally.windows[1].codex.apiKeyTurns], [2, 2, 1]);
  assert.equal('costUsd' in day.codex.rows[0], false, 'a Codex row has no cost field at all');
  const text = usageText(tally);
  assert.match(text, /\nCodex, counted apart \(the person's Codex CLI login, not Claude Code's plan\): 1 session, 1 turn\.\n- gpt-6-astra at xhigh effort · Codex workers: 1 session, 1 turn · tokens: in 1,000 \(of which cached 900\), out 40 \(of which reasoning 12\) · cost: none \(Codex reports no cost\)\n/);
  assert.match(text, /- gpt-6-astra at low effort · the Codex tab and other Codex sessions: 1 session, 1 turn · tokens: not recorded · cost: none \(Codex reports no cost\)\n1 of these turns ran on an API key saved in Codex, which OpenAI bills/);
  assert.match(text, new RegExp(`\\nCodex \\(2 session records read\\): ${CODEX_NO_COST}, so there is no cost figure for it`));
  assert.match(usageText(tallyUsage([], { now })), /Codex, counted apart .*: no turn of a studio Codex session ended in this window\./);
});

test('the manager\'s tools word a Codex worker: the model input is a described string, and what ran names backend, model and effort', () => {
  const prop = modelProp('Set it.');
  assert.equal('enum' in prop, false, 'Codex\'s models are read from the machine, so the input is not an enum');
  assert.match(prop.description, /^Set it\. One of claude-fable-5-2, .* for a Claude Code worker; or, for a worker on the person's Codex CLI and its saved login, codex:<model>@<effort> .* for example codex:gpt-6-astra@xhigh; or default\./);
  const offer = { models: [{ id: 'gpt-6-astra', efforts: ['low', 'xhigh'] }], defaults: { model: 'gpt-6-astra', effort: 'xhigh' } };
  assert.equal(codexOfferWords(offer), ' Codex offers on this machine: gpt-6-astra (low, xhigh). Codex is configured with gpt-6-astra at xhigh.');
  assert.ok(modelProp('Set it.', offer).description.endsWith(codexOfferWords(offer)));
  assert.equal(codexOfferWords(null), '');
  assert.equal(ranWords({ backend: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }), 'Codex gpt-6-astra at xhigh effort');
  assert.equal(ranWords({ model: 'claude-opus-5-5', effort: 'high' }), 'claude-opus-5-5');
  assert.equal(ranOn({ backend: 'codex', model: 'gpt-6-astra', effort: 'xhigh', sandbox: 'workspace-write' }), 'Codex gpt-6-astra at xhigh effort, sandbox workspace-write');
  assert.equal(ranOn({ backend: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }), 'Claude Code claude-opus-5-5 at high effort');
  assert.equal(ranOn({ model: 'claude-opus-5-5' }), 'Claude Code claude-opus-5-5', 'an event from before the backend and effort were recorded');
  assert.equal(ranOn({}), 'a worker, model not recorded');
  assert.match(workerModelText({ studio: { model: 'claude-fable-5-2', stored: null }, project: { name: 'X', model: 'codex:gpt-6-astra@xhigh' }, task: null, effective: { model: 'codex:gpt-6-astra@xhigh', words: 'set for this project' } }),
    /^Worker model now: project X: Codex gpt-6-astra at xhigh effort · studio default: claude-fable-5-2 \(built in; none stored\)\. The next worker of X, on a task with no model of its own, starts on Codex gpt-6-astra at xhigh effort \(set for this project\)\.$/);
  for (const part of ['workspace-write sandbox', 'cannot commit', 'cannot write outside it or reach the internet', 'cannot run a project\'s checks when they need the person\'s own account', 'Unity batch mode finds no licence', 'by the person or by a Claude Code worker on a follow-up task', 'cannot take an explore task', 'not pointed at the task\'s department skills', 'Codex reports no cost']) assert.ok(CODEX_WORKER_NOTE.includes(part), part);
  for (const part of ['a check that needs the person\'s own account', 'did not run there', 'not pointed at the department\'s skills', 'before you accept']) assert.ok(CODEX_REPORT_NOTE.includes(part), part);
  const tools = createTools({ studio: 'http://127.0.0.1:1', project: 'p_x' });
  for (const name of ['atelier_start_task', 'atelier_set_worker_model']) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t.description.includes(CODEX_WORKER_NOTE), `${name} tells the manager what a Codex worker cannot do`);
    assert.equal(typeof t.listSchema, 'function', `${name} lists Codex's models live`);
  }
  assert.match(tools.find((x) => x.name === 'atelier_worker_usage').description, /Codex sessions .* are counted apart .* and no cost, because Codex reports none/);
});

test('the client: the Focus panel offers Codex models with an effort, keeps what is stored, and rows say who ran a task', () => {
  const status = { cli: true, loggedIn: true, models: [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'high', 'xhigh'] }, { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low'] }], defaults: { model: 'gpt-6-astra', effort: 'xhigh' } };
  assert.equal(focus.workerModelText({ workerModel: 'codex:gpt-6-astra@xhigh' }, {}), 'Codex · gpt-6-astra · xhigh effort');
  assert.equal(focus.workerModelText({ workerModel: 'codex:gpt-6-astra@xhigh' }, {}, status), 'Codex · GPT-6-Astra · xhigh effort');
  assert.equal(focus.workerModelText({}, { workerModel: 'codex:gpt-6-astra' }), 'Codex · gpt-6-astra · Codex\'s configured effort (studio default)');
  assert.equal(focus.workerModelText({}, {}), 'Fable 5.2 (studio default)', 'with nothing set a worker is Claude Code');
  assert.equal(focus.storedStudioDefault({ workerModel: 'codex:gpt-6-astra@xhigh' }), 'codex:gpt-6-astra@xhigh');
  assert.equal(focus.storedStudioDefault({ workerModel: 'codex:--bad' }), null);
  const choices = focus.workerModelChoices({}, status, null);
  assert.deepEqual(choices.slice(-2), [['codex:gpt-6-astra', 'Codex · GPT-6-Astra'], ['codex:gpt-6-luna', 'Codex · GPT-6-Luna']], 'the Codex models follow the Claude Code ones');
  assert.deepEqual(choices[0], ['default', 'Studio default (Fable 5.2)']);
  assert.deepEqual(focus.workerModelChoices({}, null, 'codex:gpt-9@high').at(-1), ['codex:gpt-9', 'Codex · gpt-9'], 'not read: a stored Codex model is still offered');
  assert.deepEqual(focus.workerModelChoices({}, { cli: false, models: status.models }, null).filter(([v]) => v.startsWith('codex:')), [], 'no CLI: no Codex model is offered');
  assert.deepEqual(words.workerPick('codex:gpt-6-astra@xhigh'), { model: 'codex:gpt-6-astra', effort: 'xhigh' });
  assert.deepEqual(words.workerPick('codex:gpt-6-astra'), { model: 'codex:gpt-6-astra', effort: '' });
  assert.deepEqual(words.workerPick('claude-opus-5-5'), { model: 'claude-opus-5-5', effort: '' });
  assert.deepEqual(words.workerPick(undefined), { model: 'default', effort: '' });
  assert.equal(words.workerValue('codex:gpt-6-astra', 'xhigh'), 'codex:gpt-6-astra@xhigh');
  assert.equal(words.workerValue('codex:gpt-6-astra', ''), 'codex:gpt-6-astra');
  assert.equal(words.workerValue('claude-opus-5-5', 'xhigh'), 'claude-opus-5-5', 'an effort left in the hidden select never rides a Claude Code model');
  assert.equal(words.workerValue('default', 'low'), 'default');
  assert.deepEqual(words.codexWorkerEfforts(status, 'codex:gpt-6-astra'), [['', 'Effort Codex is configured with (xhigh)'], ['low', 'low effort'], ['high', 'high effort'], ['xhigh', 'xhigh effort']]);
  assert.deepEqual(words.codexWorkerEfforts(status, 'codex:gpt-6-luna', 'max').at(-1), ['max', 'max effort'], 'a stored effort the list lacks stays chosen');
  assert.deepEqual(focus.workerModelPatch({}, words.workerValue('codex:gpt-6-astra', 'xhigh')), { workerModel: 'codex:gpt-6-astra@xhigh' });
  assert.deepEqual(focus.workerModelPatch({ workerModel: 'codex:gpt-6-astra@xhigh' }, 'codex:gpt-6-astra@xhigh'), {}, 'unchanged: no field');
  assert.deepEqual(focus.studioDefaultPatch({ workerModel: 'codex:gpt-6-astra' }, 'default'), { workerModel: null });
  assert.match(words.codexWorkerHint(status), /workspace-write sandbox: it cannot commit \(the studio keeps its version\), reach the internet, run checks that need your own account \(a Unity compile or test\) or take an explore task\.$/);
  assert.equal(words.codexWorkerHint({ cli: true, loggedIn: false, problem: 'Codex is signed out on this machine: run `codex login`.' }), 'Codex is signed out on this machine: run `codex login`.');
  assert.equal(sessionBrainLine({ backend: 'codex', model: 'gpt-6-astra', effort: 'xhigh', sandbox: 'workspace-write' }), 'Codex · gpt-6-astra · xhigh effort · sandbox workspace-write');
  assert.equal(sessionBrainLine({ backend: 'claude-code', model: 'claude-opus-5-5' }), 'Claude Code · Opus 5.5 · your login');
  assert.equal(eventWords('handed_to_console', { backend: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }), 'handed to Codex (gpt-6-astra, xhigh effort)');
  assert.equal(eventWords('handed_to_console', { model: 'claude-opus-5-5' }), 'handed to Claude Code');
  assert.equal(eventWords('finish_requested'), 'finish recorded');
});

test('through a real server with the fake Codex CLI: a task set to codex:gpt-6-astra@low is carried out by a Codex worker and ends in a version and a studio report', async () => {
  await startServer({ FAKE_CODEX_WORKER: 'finish' });
  const project = (await api('POST', '/api/projects', { name: 'Codex Works', kind: 'web-app' })).data.project;
  const tid = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Create notes/hello.txt.', title: 'Add a note file' })).data.id;

  // Every scope takes a Codex model through its own route; what Codex does not offer here is refused and nothing is stored.
  for (const [method, url, body] of [['PUT', '/api/settings/worker-model', { workerModel: 'codex:gpt-nope@low' }], ['PATCH', `/api/projects/${project.id}`, { workerModel: 'codex:gpt-nope' }], ['PUT', `/api/projects/${project.id}/tasks/${tid}/worker-model`, { workerModel: 'codex:gpt-6-astra@enormous' }], ['POST', `/api/projects/${project.id}/workers`, { taskId: tid, workerModel: 'codex:gpt-nope' }], ['POST', `/api/projects/${project.id}/tasks`, { request: 'Never made.', workerModel: 'codex:gpt-nope' }]]) {
    const out = await api(method, url, body);
    assert.equal(out.status, 400, `${method} ${url}`);
    assert.match(out.data.error.message, /^(model must be one of gpt-6\.1-sol, gpt-6-astra, |effort must be one of low, medium, high, xhigh for gpt-6-astra)/, `${method} ${url}`);
  }
  const levels = (await api('GET', `/api/projects/${project.id}/worker-model?task=${tid}`)).data;
  assert.deepEqual([levels.effective.model, levels.effective.backend], ['claude-fable-5-2', 'claude-code'], 'the refusals stored nothing: Claude Code is still the default');
  assert.ok(levels.codex.models.some((m) => m.id === 'gpt-6-astra' && m.efforts.includes('xhigh')), 'the route lists what a Codex worker model may name');

  const tools = createTools({ studio: BASE, project: project.id });
  const set = await tools.find((t) => t.name === 'atelier_set_worker_model').run({ scope: 'project', model: 'codex:gpt-6-astra@low' });
  assert.match(set, /: its workers start on Codex gpt-6-astra at low effort when their task names no model\. Worker model now: project .*: Codex gpt-6-astra at low effort · studio default: claude-fable-5-2 \(built in; none stored\)\. The next worker of .* starts on Codex gpt-6-astra at low effort \(set for this project\)\./);
  assert.ok(set.includes(' A Codex worker runs the person\'s Codex CLI on the login saved there'), 'the answer says what a Codex worker is, once');
  assert.equal(/Codex is not ready/.test(set), false, 'the fake CLI is found and signed in');
  assert.match((await api('GET', `/api/briefing?projectId=${project.id}`)).data.markdown, /- Worker model: Codex gpt-6-astra at low effort \(set for this project\)/);
  const schema = await tools.find((t) => t.name === 'atelier_set_worker_model').listSchema();
  assert.match(schema.properties.model.description, / Codex offers on this machine: gpt-6\.1-sol \(low, medium, high, xhigh\); gpt-6-astra \(low, medium, high, xhigh\); /);

  const started = await tools.find((t) => t.name === 'atelier_start_task').run({ task: tid });
  assert.match(started, new RegExp(`^Task ${tid} in .* went to a worker \\(session cs_[a-z0-9]+\\) on Codex gpt-6-astra at low effort \\(set for this project\\), the Codex CLI in its workspace-write sandbox\\.`));
  const sid = started.match(/session (cs_[a-z0-9]+)/)[1];
  let rec = (await api('GET', `/api/console/sessions/${sid}`)).data;
  for (let i = 0; i < 200 && (rec.status === 'running' || rec.turns.length < 2); i++) { await new Promise((r) => setTimeout(r, 150)); rec = (await api('GET', `/api/console/sessions/${sid}`)).data; }
  for (let i = 0; i < 200 && (await api('GET', `/api/projects/${project.id}/workers`)).data.active; i++) await new Promise((r) => setTimeout(r, 50));
  const held = await heldReports(1); // written once the studio kept the version
  assert.deepEqual([rec.backend, rec.model, rec.effort, rec.sandbox, rec.worker, rec.taskId, rec.tools], ['codex', 'gpt-6-astra', 'low', 'workspace-write', true, tid, null]);
  const turn = rec.turns[1];
  assert.equal(turn.isError, undefined, turn.error);
  const line = (word) => turn.events.filter((e) => e.kind === 'status' && e.summary.startsWith(`${word} `)).map((e) => e.summary);
  assert.deepEqual(line('argv'), ['argv ["exec","--json","--skip-git-repo-check","-m","gpt-6-astra","-c","model_reasoning_effort=\\"low\\"","-c","sandbox_mode=\\"workspace-write\\"","-"]'], 'workspace-write and nothing else: no bypass, no approval flag, no added folder');
  assert.deepEqual(line('env'), ['env OPENAI_API_KEY=absent CODEX_API_KEY=absent ANTHROPIC_API_KEY=absent CLAUDECODE=absent CLAUDE_CODE_ENTRYPOINT=absent'], 'the server had OPENAI_API_KEY; the worker did not');
  assert.deepEqual(line('actor'), ['actor ATELIER_ACTOR=codex CODEX_ACCESS_TOKEN=absent']);
  assert.deepEqual(line('mcp'), [], 'a worker gets no studio tools');
  assert.match(rec.turns[0].text, new RegExp(`^Work on studio task ${tid} in this folder\\.`), 'the record keeps the task prompt alone');

  // The task: started and noted by Codex, its finish recorded by the worker and kept by the studio as a version.
  const { task, events, versionNames } = (await api('GET', `/api/projects/${project.id}/tasks/${tid}`)).data;
  assert.equal(task.status, 'review');
  const kinds = events.map((e) => `${e.type}:${e.actor}`);
  for (const k of ['handed_to_console:companion', 'started:codex', 'finish_requested:codex', 'finished:codex']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(' ')}`);
  assert.ok(kinds.indexOf('finish_requested:codex') < kinds.indexOf('finished:codex'));
  const handed = events.find((e) => e.type === 'handed_to_console');
  assert.deepEqual([handed.data.backend, handed.data.model, handed.data.effort, handed.data.sandbox, handed.data.modelSource, handed.data.worker], ['codex', 'gpt-6-astra', 'low', 'workspace-write', 'project', true]);
  const versionsNow = (await api('GET', `/api/projects/${project.id}/versions`)).data;
  const version = versionsNow.find((v) => v.id === task.result.versionId);
  assert.deepEqual([version.origin, version.taskId], ['codex', tid]);
  assert.equal(await fsp.readFile(path.join(e2e, 'projects', 'codex-works', 'notes', 'hello.txt'), 'utf8'), 'hello from the worker\n');
  assert.equal((await api('GET', `/api/projects/${project.id}/changes`)).data.dirty, false, 'the work is committed: the tree is clean');
  const report = await tools.find((t) => t.name === 'atelier_task_report').run({ task: tid });
  assert.match(report, /\nWorker model: the next worker of this task would start on Codex gpt-6-astra at low effort \(set for this project\)\. Ran on: Codex gpt-6-astra at low effort, sandbox workspace-write \(20\d\d-/);
  assert.ok(report.includes(`\n${CODEX_REPORT_NOTE}\nRequest: `), 'the report says once how to read a Codex worker\'s result');
  assert.match(report, new RegExp(`\\nResult: Added notes/hello\\.txt\\nVersion: ${versionNames[task.result.versionId].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nVerified: read the file back`));
  // No manager session started it and the project has no Companion session, so the report is held, whole.
  assert.equal(held.length, 1);
  assert.match(held[0], new RegExp(`^\\[Studio report: not from the person\\] Worker report for task ${tid} "Add a note file": finished, ready to review\\. Summary: Added notes/hello\\.txt Version: #2 Add a note file\\. Verified: read the file back\\.`));
  assert.ok(held[0].includes(`${CODEX_FINISH_NOTE} Review it: `), 'a Codex worker\'s finished report says what its sandbox could not have checked');

  // Usage: the Codex worker is counted apart and has no cost; Claude Code's counts hold nothing.
  const usage = await tools.find((t) => t.name === 'atelier_worker_usage').run({});
  assert.match(usage, /\nLast 24 hours: no turn of a studio Claude Code session ended in this window\.\nCodex, counted apart \(the person's Codex CLI login, not Claude Code's plan\): 1 session, 1 turn\.\n- gpt-6-astra at low effort · Codex workers: 1 session, 1 turn · tokens: in 500 \(of which cached 400\), out 20 \(of which reasoning 5\) · cost: none \(Codex reports no cost\)\n/);

  // An explore task is refused a Codex worker by the route, with the sentence that says what to do.
  const explore = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Try two layouts.', mode: 'explore' })).data.id;
  const refused = await api('POST', `/api/projects/${project.id}/workers`, { taskId: explore });
  assert.deepEqual([refused.status, refused.data.error.code], [409, 'codex_no_explore']);
  assert.match(refused.data.error.message, /^An explore task cannot go to a Codex worker: .* Set a Claude Code model for this task/);
  assert.equal((await api('GET', `/api/projects/${project.id}/tasks/${explore}`)).data.events.some((e) => e.type === 'handed_to_console'), false);
  await stopServer();
});

test('through a real server: a Codex worker that is refused a command, or asks, or finds Codex signed out, ends in a truthful report and never a hang', async () => {
  await startServer({ FAKE_CODEX_WORKER: 'refused' });
  const project = (await api('POST', '/api/projects', { name: 'Codex Stops', kind: 'web-app' })).data.project;
  assert.equal((await api('PATCH', `/api/projects/${project.id}`, { workerModel: 'codex:gpt-6-astra' })).status, 200);
  const tid = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Compile the game.', title: 'Compile check' })).data.id;
  const before = (await heldNow()).length; // the first test's report may be held in the same data folder
  const { started, rec } = await runWorker(project.id, tid);
  let held = await heldReports(before + 1);
  assert.deepEqual([started.backend, started.model, started.effort], ['codex', 'gpt-6-astra', null], 'no effort named and none configured: Codex\'s own default, said as none');
  assert.equal(rec.turns[1].isError, undefined);
  assert.equal((await api('GET', `/api/projects/${project.id}/tasks/${tid}`)).data.task.status, 'working', 'no finish was recorded, so none was kept');
  assert.match(held.at(-1), new RegExp(`Worker report for task ${tid} "Compile check": did not finish: its turn ended without finishing \\(status working\\); its last words: ".*The compile check cannot run in this sandbox, so I stopped\\."\\. One of its commands failed or was refused; the last: \`bash tools/compile\\.sh\` → mkdir: cannot create directory .*Permission denied.*\\. Decide whether to send it back`));
  await stopServer();

  await startServer({ FAKE_CODEX_WORKER: 'question' });
  const asked = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Colour the note.', title: 'Colour the note' })).data.id;
  await runWorker(project.id, asked);
  held = await heldReports(before + 2);
  const q = (await api('GET', `/api/projects/${project.id}/tasks/${asked}`)).data;
  assert.equal(q.task.status, 'needs-input');
  assert.deepEqual(q.events.filter((e) => e.type === 'question').map((e) => e.actor), ['codex']);
  assert.match(held.at(-1), new RegExp(`Worker report for task ${asked} "Colour the note": stopped with a question: "Which colour should the note be\\?"`));
  await stopServer();

  // Signed out: the start is refused with what to do, before a session exists or the task is handed over.
  await startServer({ FAKE_CODEX_LOGIN: 'out', FAKE_CODEX_WORKER: 'finish' });
  const third = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Another note.', title: 'Another note' })).data.id;
  const out = await api('POST', `/api/projects/${project.id}/workers`, { taskId: third });
  assert.deepEqual([out.status, out.data.error.code], [503, 'console_codex_signed_out']);
  assert.match(out.data.error.message, /^Codex is signed out on this machine: run `codex login` in a terminal/);
  const t = (await api('GET', `/api/projects/${project.id}/tasks/${third}`)).data;
  assert.deepEqual([t.task.status, t.events.some((e) => e.type === 'handed_to_console'), (await api('GET', `/api/projects/${project.id}/workers`)).data.active], ['ready', false, null]);
  const set = await createTools({ studio: BASE, project: project.id }).find((x) => x.name === 'atelier_set_worker_model').run({ scope: 'task', task: third, model: 'codex:gpt-6-astra@high' });
  assert.match(set, / Codex is not ready on this machine: Codex is signed out on this machine: run `codex login` in a terminal/, 'setting a Codex model says when Codex cannot run now');
  await stopServer();
});
