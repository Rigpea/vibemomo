// The per-project worker model (server/lib/models.mjs): a project's .studio/project.json may name the model its workers
// start on; none means the studio default; a model the studio does not offer is refused and changes nothing; the CLI
// reads and sets it; the briefing and the Focus panel show it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-worker-model-'));
process.env.ATELIER_DATA_DIR = path.join(root, 'data');
process.env.ATELIER_PROJECTS_DIR = path.join(root, 'projects');

const projects = await import('../server/lib/projects.mjs');
const versions = await import('../server/lib/versions.mjs');
const briefing = await import('../server/lib/briefing.mjs');
const { CONSOLE_MODELS, WORKER_MODEL, checkWorkerModel, workerModelOf, workerModelWords, resolveWorkerModel } = await import('../server/lib/models.mjs');
const workerModel = await import('../server/lib/worker-model.mjs');
const tasks = await import('../server/lib/tasks.mjs');
const consoleMod = await import('../server/lib/console.mjs');
const workersMod = await import('../server/lib/workers.mjs');
const { workerModelPatch, workerModelText, workerModelChoices, studioDefaultChoices, studioDefaultPatch, WORKER_DEFAULT } = await import('../client/components/focus.js');
const { COMPANION_MODELS } = await import('../client/components/companion-words.js');

const deps = {
  checkpoint: (ctx, o) => versions.checkpoint(ctx, o),
  adoptHead: (ctx, o) => versions.adoptHead(ctx, o),
  regenerate: (id) => briefing.regenerate(id),
};
const record = async (id) => JSON.parse(await fsp.readFile(path.join((await projects.loadProject(id)).path, '.studio', 'project.json'), 'utf8'));
const cli = (...args) => spawnSync(process.execPath, [path.resolve('bin/atelier.mjs'), ...args], { encoding: 'utf8', env: process.env });

let p;
before(async () => {
  await fsp.mkdir(process.env.ATELIER_PROJECTS_DIR, { recursive: true });
  p = await projects.createProject({ name: 'Model Room', kind: 'web-app' }, deps);
});
after(async () => { await fsp.rm(root, { recursive: true, force: true }).catch(() => {}); });

test('one model list: the console, the default and the client agree', () => {
  assert.equal(consoleMod.CONSOLE_MODELS, CONSOLE_MODELS, 'console.mjs re-exports the list from models.mjs');
  assert.equal(workersMod.WORKER_MODEL, 'claude-fable-5-2', 'the studio default is Fable 5.2 (decision row 143)');
  assert.equal(WORKER_MODEL, WORKER_DEFAULT, 'the Focus panel names the same default');
  assert.deepEqual(COMPANION_MODELS.map(([id]) => id).sort(), [...CONSOLE_MODELS].sort(), 'the client offers the ids the server accepts');
});

test('checkWorkerModel: a listed id stays, default and null clear, anything else is a 400 naming the choices', () => {
  assert.equal(checkWorkerModel('claude-fable-5-2'), 'claude-fable-5-2');
  for (const v of [null, undefined, '', 'default']) assert.equal(checkWorkerModel(v), null);
  for (const v of ['claude-opus-4', 'opus', 42, ['claude-fable-5-2'], { id: 'x' }]) {
    assert.throws(() => checkWorkerModel(v), (err) => err.status === 400 && /workerModel must be one of claude-fable-5-2, .*claude-haiku-5-5, or default/.test(err.message));
  }
  assert.equal(workerModelOf({}), 'claude-fable-5-2');
  assert.equal(workerModelOf({ workerModel: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');
  assert.equal(workerModelOf({ workerModel: 'hand-typed' }), 'claude-fable-5-2', 'a value edited in by hand that the studio does not offer falls back');
  assert.equal(workerModelWords({}), 'claude-fable-5-2 (studio default)');
  assert.equal(workerModelWords({ workerModel: 'claude-opus-5-5' }), 'claude-opus-5-5 (set for this project)');
});

test('patchProject: no field by default, a valid model is stored, default removes it, an invalid one changes nothing', async () => {
  const id = p.project.id;
  assert.equal('workerModel' in (await record(id)), false, 'a new project has no worker model: the studio default');
  await projects.patchProject(id, { workerModel: 'claude-opus-5-5' });
  assert.equal((await record(id)).workerModel, 'claude-opus-5-5');
  const before = await record(id);
  await assert.rejects(() => projects.patchProject(id, { purpose: 'should not land', workerModel: 'claude-opus-4' }), (err) => err.status === 400 && /workerModel must be one of/.test(err.message));
  const afterRefusal = await record(id);
  assert.deepEqual(afterRefusal, before, 'a refused patch writes nothing, not even its other fields');
  await projects.patchProject(id, { workerModel: null });
  assert.equal('workerModel' in (await record(id)), false, 'null clears it back to the default');
  await projects.patchProject(id, { workerModel: 'claude-haiku-5-5' });
  await projects.patchProject(id, { workerModel: 'default' });
  assert.equal('workerModel' in (await record(id)), false, "'default' clears it too");
  await projects.patchProject(id, { purpose: 'other fields leave it alone' });
  assert.equal('workerModel' in (await record(id)), false);
});

test('the CLI reads and sets it, refuses a bad id without writing, and the briefing and projects list show it', async () => {
  const id = p.project.id;
  let r = cli('project', 'get', 'worker-model', '--project', id);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worker model: claude-fable-5-2 \(studio default\)/);
  r = cli('project', 'set', 'worker-model', 'claude-opus-5-5', '--project', id);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worker model: claude-opus-5-5 \(set for this project\)\. It applies to the next worker started/);
  assert.equal((await record(id)).workerModel, 'claude-opus-5-5');
  const md = await fsp.readFile(path.join(p.path || (await projects.loadProject(id)).path, '.studio', 'BRIEFING.md'), 'utf8');
  assert.match(md, /- Worker model: claude-opus-5-5 \(set for this project\)/, 'the briefing was regenerated with the new line');
  r = cli('projects');
  assert.match(r.stdout, new RegExp(`${id} .*worker claude-opus-5-5 \\(set for this project\\)`));
  r = cli('project', 'set', 'worker-model', 'gpt-5', '--project', id);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /workerModel must be one of .* \(got "gpt-5"\)/);
  assert.equal((await record(id)).workerModel, 'claude-opus-5-5', 'the refused value changed nothing');
  r = cli('project', 'set', 'worker-model', '--project', id);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs a model/);
  r = cli('project', 'set', 'worker-model', 'default', '--project', id);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude-fable-5-2 \(studio default\)/);
  assert.equal('workerModel' in (await record(id)), false);
});

test('three levels: the task\'s own model, else the project\'s, else the studio default; hand-typed values count as none', () => {
  const studioDefault = 'claude-sonnet-5-5';
  assert.deepEqual(resolveWorkerModel({ task: { workerModel: 'claude-haiku-5-5' }, project: { workerModel: 'claude-opus-5-5' }, studioDefault }), { model: 'claude-haiku-5-5', source: 'task' });
  assert.deepEqual(resolveWorkerModel({ task: {}, project: { workerModel: 'claude-opus-5-5' }, studioDefault }), { model: 'claude-opus-5-5', source: 'project' });
  assert.deepEqual(resolveWorkerModel({ task: { workerModel: 'typed-by-hand' }, project: {}, studioDefault }), { model: 'claude-sonnet-5-5', source: 'studio' });
  assert.deepEqual(resolveWorkerModel({ project: { workerModel: 7 }, studioDefault: 'nope' }), { model: WORKER_MODEL, source: 'studio' }, 'a stored default the studio does not offer falls back to the built-in');
  assert.deepEqual(resolveWorkerModel(), { model: WORKER_MODEL, source: 'studio' });
  assert.equal(workerModelWords({}, 'claude-sonnet-5-5'), 'claude-sonnet-5-5 (studio default)');
});

test('the studio default lives in the registry\'s settings: stored, read back by a fresh read, cleared; a bad id is a 400 that writes nothing', async () => {
  const registryFile = path.join(process.env.ATELIER_DATA_DIR, 'registry.json');
  const onDisk = async () => JSON.parse(await fsp.readFile(registryFile, 'utf8')).settings;
  assert.deepEqual(await workerModel.loadStudioWorkerModel(), { stored: null, fallback: WORKER_MODEL, model: WORKER_MODEL }, 'nothing stored: the built-in');
  assert.deepEqual(await workerModel.saveStudioWorkerModel('claude-sonnet-5-5'), { stored: 'claude-sonnet-5-5', fallback: WORKER_MODEL, model: 'claude-sonnet-5-5' });
  assert.equal((await onDisk()).workerModel, 'claude-sonnet-5-5', 'written to registry.json, so a restart reads it');
  assert.equal((await workerModel.loadStudioWorkerModel()).model, 'claude-sonnet-5-5');
  const departments = (await onDisk()).skillDepartments;
  await assert.rejects(() => workerModel.saveStudioWorkerModel('gpt-5'), (err) => err.status === 400 && /workerModel must be one of claude-fable-5-2, .*claude-haiku-5-5, or default \(got "gpt-5"\)/.test(err.message));
  assert.equal((await onDisk()).workerModel, 'claude-sonnet-5-5', 'the refused value changed nothing');
  assert.deepEqual((await onDisk()).skillDepartments, departments, 'the other settings stay');

  // The briefing and the CLI read the stored default; a project's own model still outranks it.
  const id = p.project.id;
  await briefing.regenerate(id);
  const folder = (await projects.loadProject(id)).path;
  assert.match(await fsp.readFile(path.join(folder, '.studio', 'BRIEFING.md'), 'utf8'), /- Worker model: claude-sonnet-5-5 \(studio default\)/);
  assert.match(cli('project', 'get', 'worker-model', '--project', id).stdout, /worker model: claude-sonnet-5-5 \(studio default\)/);
  assert.match(cli('projects').stdout, new RegExp(`${id} .*worker claude-sonnet-5-5 \\(studio default\\)`));
  await projects.patchProject(id, { workerModel: 'claude-opus-5-5' });
  assert.match(cli('project', 'get', 'worker-model', '--project', id).stdout, /worker model: claude-opus-5-5 \(set for this project\)/);
  await projects.patchProject(id, { workerModel: null });

  assert.deepEqual(workerModel.studioWorkerModelOf({ workerModel: 'typed-by-hand' }), { stored: null, fallback: WORKER_MODEL, model: WORKER_MODEL }, 'a value edited in by hand counts as none');
  for (const clear of ['default', null]) {
    await workerModel.saveStudioWorkerModel('claude-haiku-5-5');
    assert.deepEqual(await workerModel.saveStudioWorkerModel(clear), { stored: null, fallback: WORKER_MODEL, model: WORKER_MODEL });
    assert.equal('workerModel' in (await onDisk()), false, 'cleared: the field is gone');
  }
});

test('a task keeps its own model: given at create, set and cleared after, each change an event; a bad id is a 400 that writes nothing', async () => {
  const ctx = await projects.loadProject(p.project.id);
  await assert.rejects(() => tasks.createTask(ctx, { request: 'Never made.', workerModel: 'claude-opus-4' }), (err) => err.status === 400 && /workerModel must be one of .* \(got "claude-opus-4"\)/.test(err.message));
  assert.equal((await tasks.listTasks(ctx.path)).length, 0, 'a refused create writes no task');
  const plain = await tasks.createTask(ctx, { request: 'Plain task.' });
  assert.equal('workerModel' in plain, false, 'none given: no field');
  const own = await tasks.createTask(ctx, { request: 'Routine sweep.', workerModel: 'claude-haiku-5-5' });
  assert.equal(own.workerModel, 'claude-haiku-5-5');
  assert.equal((await tasks.getTask(ctx.path, own.id)).task.workerModel, 'claude-haiku-5-5', 'stored on the task record');

  const set = await tasks.setTaskWorkerModel(ctx.path, plain.id, 'claude-opus-5-5', 'companion');
  assert.deepEqual([set.changed, set.task.workerModel], [true, 'claude-opus-5-5']);
  assert.equal((await tasks.setTaskWorkerModel(ctx.path, plain.id, 'claude-opus-5-5')).changed, false, 'the same model again changes nothing');
  await assert.rejects(() => tasks.setTaskWorkerModel(ctx.path, plain.id, 'opus'), (err) => err.status === 400 && /workerModel must be one of/.test(err.message));
  assert.equal((await tasks.getTask(ctx.path, plain.id)).task.workerModel, 'claude-opus-5-5', 'the refused value changed nothing');
  const cleared = await tasks.setTaskWorkerModel(ctx.path, plain.id, 'default', 'companion');
  assert.deepEqual([cleared.changed, 'workerModel' in cleared.task], [true, false]);
  const events = (await tasks.getTask(ctx.path, plain.id)).events.filter((e) => e.type === 'worker_model');
  assert.deepEqual(events.map((e) => [e.actor, e.data.model, e.data.before]), [['companion', 'claude-opus-5-5', null], ['companion', null, 'claude-opus-5-5']]);
  await assert.rejects(() => tasks.setTaskWorkerModel(ctx.path, 't_nothere1', 'default'), (err) => err.status === 404);

  const levels = workerModel.workerModelLevels({ studio: workerModel.studioWorkerModelOf({ workerModel: 'claude-sonnet-5-5' }), project: { id: 'p_x', name: 'X', record: { workerModel: 'claude-opus-5-5' } }, task: own });
  assert.deepEqual([levels.studio.model, levels.project.model, levels.task.model, levels.effective], ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', { model: 'claude-haiku-5-5', source: 'task', words: 'set for this task', backend: 'claude-code', label: 'claude-haiku-5-5' }]);
});

test('Focus panel: the identity line and the form send workerModel only when it changed', () => {
  // The studio default in the line and in the select's first choice is the one the settings hold now.
  const stored = { workerModel: 'claude-sonnet-5-5' };
  assert.equal(workerModelText({}, stored), 'Sonnet 5.5 (studio default)');
  assert.equal(workerModelText({ workerModel: 'claude-opus-5-5' }, stored), 'Opus 5.5');
  assert.deepEqual(workerModelChoices(stored)[0], ['default', 'Studio default (Sonnet 5.5)']);
  assert.deepEqual(workerModelChoices({ workerModel: 'typed-by-hand' })[0], ['default', 'Studio default (Fable 5.2)'], 'a stored value the studio does not offer reads as the built-in');
  assert.deepEqual(studioDefaultChoices()[0], ['default', 'Built in (Fable 5.2)']);
  assert.equal(studioDefaultChoices().length, COMPANION_MODELS.length + 1);
  assert.equal(studioDefaultPatch(stored, 'claude-sonnet-5-5'), null, 'unchanged: nothing is sent to the settings');
  assert.equal(studioDefaultPatch({}, 'default'), null);
  assert.deepEqual(studioDefaultPatch({}, 'claude-haiku-5-5'), { workerModel: 'claude-haiku-5-5' });
  assert.deepEqual(studioDefaultPatch(stored, 'default'), { workerModel: null }, 'Built in clears the stored default');
  assert.equal(workerModelText({}), 'Fable 5.2 (studio default)');
  assert.equal(workerModelText({ workerModel: 'claude-opus-5-5' }), 'Opus 5.5');
  assert.deepEqual(workerModelChoices()[0], ['default', 'Studio default (Fable 5.2)']);
  assert.deepEqual(workerModelPatch({}, 'default'), {}, 'unchanged: no field, so saving the name or purpose never touches it');
  assert.deepEqual(workerModelPatch({ workerModel: 'claude-opus-5-5' }, 'claude-opus-5-5'), {});
  assert.deepEqual(workerModelPatch({}, 'claude-opus-5-5'), { workerModel: 'claude-opus-5-5' });
  assert.deepEqual(workerModelPatch({ workerModel: 'claude-opus-5-5' }, 'default'), { workerModel: null });
});
