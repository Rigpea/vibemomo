// Focused tests for the concrete risks: persistence, version restoration,
// project isolation, memory correction, task routing, interruption recovery,
// and studio data migration. Runs against temp folders, never the real data dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-test-'));
process.env.ATELIER_DATA_DIR = path.join(root, 'data');
process.env.ATELIER_PROJECTS_DIR = path.join(root, 'projects');

const projects = await import('../server/lib/projects.mjs');
const versions = await import('../server/lib/versions.mjs');
const memory = await import('../server/lib/memory.mjs');
const tasks = await import('../server/lib/tasks.mjs');
const briefing = await import('../server/lib/briefing.mjs');
const registry = await import('../server/lib/registry.mjs');
const git = await import('../server/lib/git.mjs');

const deps = {
  checkpoint: (ctx, o) => versions.checkpoint(ctx, o),
  adoptHead: (ctx, o) => versions.adoptHead(ctx, o),
  regenerate: (id) => briefing.regenerate(id),
};

let a, b;
before(async () => {
  await fsp.mkdir(process.env.ATELIER_PROJECTS_DIR, { recursive: true });
  a = await projects.createProject({ name: 'Alpha Room', kind: 'game', template: 'game-room-one' }, deps);
  b = await projects.createProject({ name: 'Beta Notes', kind: 'web-app' }, deps);
});
after(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

const tuningFile = (ctx) => path.join(ctx.path, 'src', 'tuning.js');
/** The CLI's JSON; checkpoint prints a "#n label (id)" line above it. */
const cliJson = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('\n{') + 1));

test('persistence: records survive a reload from disk', async () => {
  await projects.patchProject(a.project.id, { purpose: 'learn movement feel', currentPiece: { title: 'Jump feel', why: 'first thing you touch', acceptance: ['jump height feels right'] } });
  const reloaded = await projects.loadProject(a.project.id);
  assert.equal(reloaded.project.purpose, 'learn movement feel');
  assert.equal(reloaded.project.currentPiece.title, 'Jump feel');
  const reg = await registry.loadRegistry();
  assert.ok(reg.projects.find((p) => p.id === a.project.id));
});

test('versions: change -> checkpoint -> compare -> restore keeps a way back', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const original = await fsp.readFile(tuningFile(ctx), 'utf8');
  assert.match(original, /"jumpVelocity": 760/);
  await fsp.writeFile(tuningFile(ctx), original.replace('"jumpVelocity": 760', '"jumpVelocity": 900'));
  const ch = await versions.changes(ctx.path);
  assert.equal(ch.dirty, true);
  assert.ok(ch.files.some((f) => f.path.endsWith('tuning.js')));
  const v2 = await versions.checkpoint(ctx, { label: 'Higher jump', state: 'experiment' });
  assert.equal(v2.n, 2);
  await assert.rejects(() => versions.checkpoint(ctx, { label: 'nothing' }), (e) => e.code === 'nothing_changed');
  await assert.rejects(() => versions.checkpoint(ctx, { label: 'Odd role', role: 'winner' }), (e) => e.code === 'invalid_input');
  const cmp =await versions.compare(ctx, a.version.id, v2.id);
  assert.equal(cmp.files.length, 1);
  assert.ok(cmp.diff.includes('-  "jumpVelocity": 760') && cmp.diff.includes('+  "jumpVelocity": 900'));
  // dirty tree before restore -> safety checkpoint is taken
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')).replace('900', '950'));
  const r = await versions.restore(ctx, a.version.id);
  assert.ok(r.safetyVersionId, 'safety version recorded');
  assert.match(await fsp.readFile(tuningFile(ctx), 'utf8'), /"jumpVelocity": 760/);
  const list = await versions.listVersions(ctx.path);
  assert.equal(list.length, 3);
  // way back: restore the safety version brings 950 back
  await versions.restore(ctx, r.safetyVersionId);
  assert.match(await fsp.readFile(tuningFile(ctx), 'utf8'), /"jumpVelocity": 950/);
  await versions.restore(ctx, v2.id);
  assert.match(await fsp.readFile(tuningFile(ctx), 'utf8'), /"jumpVelocity": 900/);
});

test('versions: the star is one per project; clearing it leaves none, other projects keep theirs', async () => {
  const c = await projects.loadProject((await projects.createProject({ name: 'Star Room', kind: 'web-app' }, deps)).project.id);
  const d = await projects.loadProject((await projects.createProject({ name: 'Other Room', kind: 'web-app' }, deps)).project.id);
  const add = async (ctx, label) => {
    await fsp.writeFile(path.join(ctx.path, `${label}.txt`), label);
    return versions.checkpoint(ctx, { label });
  };
  const v1 = await add(c, 'one');
  const v2 = await add(c, 'two');
  const other = await add(d, 'elsewhere');
  await versions.patchVersion(d.path, other.id, { userPreferred: true });

  const stars = async (ctx) => (await versions.listVersions(ctx.path)).filter((v) => v.userPreferred).map((v) => v.id);
  await versions.patchVersion(c.path, v1.id, { userPreferred: true });
  assert.deepEqual(await stars(c), [v1.id]);
  const starred = await versions.patchVersion(c.path, v2.id, { userPreferred: true });
  assert.equal(starred.userPreferred, true, 'the patched version comes back starred');
  assert.deepEqual(await stars(c), [v2.id], 'starring moves the star');

  await versions.patchVersion(c.path, v1.id, { note: 'a note, no star' });
  assert.deepEqual(await stars(c), [v2.id], 'a patch that does not star leaves the star alone');
  await versions.patchVersion(c.path, v2.id, { userPreferred: false });
  assert.deepEqual(await stars(c), [], 'clearing the star stars nothing else');
  assert.deepEqual(await stars(d), [other.id], 'another project keeps its star');
});

test('isolation: restoring project A never touches project B', async () => {
  const ctxB = await projects.loadProject(b.project.id);
  const idx = path.join(ctxB.path, 'src', 'index.html');
  await fsp.writeFile(idx, '<!doctype html><title>beta changed</title>');
  const ctxA = await projects.loadProject(a.project.id);
  await versions.restore(ctxA, a.version.id);
  assert.equal(await fsp.readFile(idx, 'utf8'), '<!doctype html><title>beta changed</title>');
  const chB = await versions.changes(ctxB.path);
  assert.equal(chB.dirty, true);
  const chA = await versions.changes(ctxA.path);
  assert.equal(chA.dirty, false);
});

test('memory: correction supersedes and retrieval drops the old record on both stores', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const rec = await memory.addMemory({ kind: 'observation', scope: 'project', text: 'Heavy movement suits this game', tags: ['feel'], status: 'inferred', provenance: { source: 'claude-code' } }, { projectPath: ctx.path, projectId: ctx.project.id });
  let hits = await memory.listMemory({ scope: 'project', projectPath: ctx.path, projectId: ctx.project.id, q: 'heavy movement' });
  assert.equal(hits[0].id, rec.id);
  const corrected = await memory.correctMemory(rec.id, { text: 'Floaty, light movement suits this game' }, { projectPath: ctx.path, actor: 'user' });
  assert.equal(corrected.record.supersedes, rec.id);
  assert.equal(corrected.retracted.status, 'retracted');
  assert.equal(corrected.record.status, 'explicit');
  hits = await memory.listMemory({ scope: 'project', projectPath: ctx.path, projectId: ctx.project.id, q: 'movement' });
  assert.ok(hits.every((h) => h.id !== rec.id));
  assert.ok(hits.some((h) => h.id === corrected.record.id));
  // Claude Code side: the briefing file carries the corrected text only
  await briefing.regenerate(ctx.project.id);
  const brief = await fsp.readFile(path.join(ctx.path, '.studio', 'BRIEFING.md'), 'utf8');
  assert.ok(brief.includes('Floaty, light movement'));
  assert.ok(!brief.includes('Heavy movement suits'));
  // deletion removes it from retrieval entirely
  await memory.deleteMemory(corrected.record.id, { projectPath: ctx.path });
  hits = await memory.listMemory({ scope: 'project', projectPath: ctx.path, projectId: ctx.project.id, q: 'movement' });
  assert.ok(hits.every((h) => h.id !== corrected.record.id));
  await briefing.regenerate(ctx.project.id);
  const brief2 = await fsp.readFile(path.join(ctx.path, '.studio', 'BRIEFING.md'), 'utf8');
  assert.ok(!brief2.includes('Floaty, light movement'));
});

test('tasks: routing to Claude Code, CLI-style start/finish, ingest, interruption', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { title: 'Lower gravity', request: 'Make falls slower', mode: 'handle', acceptance: ['gravity below 2000'] });
  assert.equal(task.status, 'ready');
  assert.equal(task.route, 'claude-code');
  assert.ok(task.context.baseSha);
  const { brief } = await tasks.getTask(ctx.path, task.id);
  assert.ok(brief.includes('task start ' + task.id));
  assert.ok(brief.includes('gravity below 2000'));
  // CLAUDE.md names the open task
  await briefing.regenerate(ctx.project.id);
  assert.ok((await fsp.readFile(path.join(ctx.path, 'CLAUDE.md'), 'utf8')).includes(task.id));
  await tasks.startTask(ctx.path, task.id);
  let t = (await tasks.getTask(ctx.path, task.id)).task;
  assert.equal(t.status, 'working');
  // simulate a crash: heartbeat stale by 31 minutes
  assert.equal(tasks.effectiveStatus({ ...t, heartbeatAt: new Date(Date.now() - 31 * 60000).toISOString() }), 'interrupted');
  // work + finish via the CLI path
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')).replace('"gravity": 2200', '"gravity": 1800'));
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Gravity 2200 -> 1800', verification: ['selfcheck passed'], decisions: ['Gravity stays under 2000 | falls felt too abrupt'] });
  assert.equal(fin.task.status, 'review');
  assert.equal(fin.version.origin, 'claude-code');
  assert.equal(fin.version.taskId, task.id);
  const ing = await tasks.ingestTask(ctx, task.id);
  assert.equal(ing.task.status, 'done');
  assert.equal(ing.evidence.versionFound, true);
  assert.ok(ing.evidence.filesChanged.some((f) => f.endsWith('tuning.js')));
  assert.equal(ing.decisions.length, 1);
  assert.equal(ing.decisions[0].reason, 'falls felt too abrupt');
  // finishing without a summary is refused; cancelled tasks cannot restart
  await assert.rejects(() => tasks.finishTask(ctx, task.id, { summary: '' }), (e) => e.code === 'invalid_input');
  const t2 = await tasks.createTask(ctx, { request: 'Throwaway', mode: 'explore' });
  await tasks.cancelTask(ctx.path, t2.id);
  await assert.rejects(() => tasks.startTask(ctx.path, t2.id), (e) => e.code === 'task_closed');
});

test('finish on a clean tree: no version, no files, and ingest closes the task without one', async () => {
  const ctx = await projects.loadProject(a.project.id);
  // HEAD holds a version from before this task (another task's result)
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')) + '\n// earlier work\n');
  const earlier = await versions.checkpoint(ctx, { label: 'Earlier work', origin: 'claude-code', taskId: 't_other' });
  const task = await tasks.createTask(ctx, { request: 'Change nothing' });
  await tasks.startTask(ctx.path, task.id);
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Nothing to do', filesChanged: ['src/claimed.js'], decisions: ['Keep it | no need'] });
  assert.equal(fin.version, null);
  assert.equal(fin.result.versionId, null);
  assert.equal(fin.result.resultSha, null);
  assert.deepEqual(fin.result.filesChanged, []);
  assert.match(fin.result.note, /No file changed/);
  assert.equal(fin.task.status, 'review');
  assert.equal((await versions.listVersions(ctx.path)).at(-1).id, earlier.id, 'no version was added');
  const ing = await tasks.ingestTask(ctx, task.id);
  assert.equal(ing.task.status, 'done');
  assert.equal(ing.version, null);
  assert.equal(ing.evidence.versionFound, false);
  assert.deepEqual(ing.evidence.commitsSinceBase, []);
  assert.deepEqual(ing.evidence.filesChanged, []);
  assert.equal(ing.decisions[0].versionId, null);
  assert.equal((await versions.getVersion(ctx.path, earlier.id)).taskId, 't_other', 'the other task keeps its version');
});

test('finish on a clean tree after another task moved HEAD names no version; its own checkpoint is kept', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const idle = await tasks.createTask(ctx, { request: 'Wait while another task lands' });
  const explore = await tasks.createTask(ctx, { request: 'Try two options', mode: 'explore' });
  await tasks.startTask(ctx.path, idle.id);
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')) + '\n// landed meanwhile\n');
  const other = await versions.checkpoint(ctx, { label: 'Landed meanwhile', origin: 'claude-code', taskId: 't_other' });
  const idleFin = await tasks.finishTask(ctx, idle.id, { summary: 'Nothing' });
  assert.equal(idleFin.version, null);
  assert.equal(idleFin.result.versionId, null);
  assert.equal(idleFin.result.resultSha, null);
  assert.deepEqual(idleFin.result.filesChanged, []);
  assert.equal(idleFin.result.note, `The files on disk are those of version #${other.n} (another task's); nothing was kept for this task.`);
  const idleEvents = await fsp.readFile(path.join(ctx.path, '.studio', 'tasks', idle.id, 'events.jsonl'), 'utf8');
  assert.ok(idleEvents.includes(JSON.stringify(idleFin.result.note).slice(1, -1)), 'the finished event says the same');
  assert.deepEqual((await tasks.ingestTask(ctx, idle.id)).evidence.commitsSinceBase, [], 'the other task\'s commit is not this task\'s');
  // an explore task checkpoints through the CLI (no taskId) and finishes on a clean tree: that work is its result
  await tasks.startTask(ctx.path, explore.id);
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')) + '\n// option B\n');
  const option = await versions.checkpoint(ctx, { label: 'Option B', origin: 'claude-code' });
  assert.notEqual(option.id, other.id);
  const fin = await tasks.finishTask(ctx, explore.id, { summary: 'Two options' });
  assert.equal(fin.result.versionId, option.id);
  assert.equal(fin.result.note, undefined);
});

test('explore: a clean finish lists every option, tagged or newer than the start, and names them', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const cli = (...args) => cliJson(execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), ...args, '--project', ctx.project.id], { encoding: 'utf8', env: process.env }));
  const option = async (text, ...flags) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return cli('checkpoint', '--label', text, ...flags);
  };
  await fsp.appendFile(tuningFile(ctx), '\n// before the explore task\n');
  const before = await versions.checkpoint(ctx, { label: 'Before the task', origin: 'user' });
  const task = await tasks.createTask(ctx, { request: 'Try two jumps', mode: 'explore' });
  // tagged counts whatever its time: this one is made before the task starts
  const tagged = await option('Option A', '--task', task.id);
  assert.equal(tagged.taskId, task.id);
  assert.equal((await versions.getVersion(ctx.path, tagged.version)).taskId, task.id);
  await tasks.startTask(ctx.path, task.id);
  const plain = await option('Option B');
  assert.equal((await versions.getVersion(ctx.path, plain.version)).taskId, null);
  // a mistyped id tags nothing
  await fsp.appendFile(tuningFile(ctx), '\n// refused\n');
  assert.throws(() => cli('checkpoint', '--label', 'Refused', '--task', 't_nope'), /--task needs a task of this project/);
  // a path to a real task.json is not a task of this project, even when it leads back here
  for (const id of [`../tasks/${task.id}`, `..\\tasks\\${task.id}`, `./${task.id}`, '.', '..']) {
    assert.throws(() => cli('checkpoint', '--label', 'Refused', '--task', id), /--task needs a task of this project/, id);
  }
  await git.git(ctx.path, ['checkout', '-q', '--', '.']);
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Two jumps' });
  assert.deepEqual(fin.result.versionIds, [tagged.version, plain.version], 'oldest first, nothing from before the task');
  assert.ok(!fin.result.versionIds.includes(before.id));
  assert.equal(fin.result.versionId, plain.version);
  const detail = await tasks.getTask(ctx.path, task.id);
  assert.deepEqual(detail.versionNames, { [tagged.version]: `#${tagged.n} Option A`, [plain.version]: `#${plain.n} Option B` });
  assert.deepEqual(detail.events.at(-1).data.versionIds, fin.result.versionIds);
  // recording the result makes every option the task's, so a later task cannot count one as its own
  await tasks.ingestTask(ctx, task.id);
  assert.equal((await versions.getVersion(ctx.path, plain.version)).taskId, task.id);
  // a closed task takes no more versions: its result is already recorded
  const versionCount = (await versions.listVersions(ctx.path)).length;
  await fsp.appendFile(tuningFile(ctx), '\n// after the task closed\n');
  assert.equal((await tasks.getTask(ctx.path, task.id)).task.status, 'done');
  assert.throws(() => cli('checkpoint', '--label', 'Refused', '--task', task.id), new RegExp(`--task needs an open task: ${task.id} is done`));
  const cancelled = await tasks.createTask(ctx, { request: 'Never mind', mode: 'explore' });
  await tasks.cancelTask(ctx.path, cancelled.id);
  assert.throws(() => cli('checkpoint', '--label', 'Refused', '--task', cancelled.id), new RegExp(`--task needs an open task: ${cancelled.id} is cancelled`));
  assert.equal((await versions.listVersions(ctx.path)).length, versionCount, 'a refusal keeps nothing');
  await git.git(ctx.path, ['checkout', '-q', '--', '.']);
  // the prompt and the brief both ask for the flag, on explore tasks only
  assert.ok(tasks.consolePrompt(task.id, 'explore', 'v_x').includes(`checkpoint --task ${task.id} --label`));
  assert.ok(!tasks.consolePrompt(task.id, 'handle').includes('checkpoint --task'));
  assert.ok(detail.brief.includes(`checkpoint --task ${task.id} --label`));
});

test('explore: options made from the base through the CLI are siblings; a clean finish on the base lists them', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const cli = (...args) => cliJson(execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), ...args, '--project', ctx.project.id], { encoding: 'utf8', env: process.env }));
  const option = async (text, taskId) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return cli('checkpoint', '--label', text, '--task', taskId);
  };
  await fsp.appendFile(tuningFile(ctx), '\n// the base of the branches\n');
  const base = await versions.checkpoint(ctx, { label: 'The base', origin: 'user' });
  const task = await tasks.createTask(ctx, { request: 'Try two real alternatives', mode: 'explore' });
  assert.equal(task.context.baseVersionId, base.id);
  // both prompts name the base and ask for a restore between options
  for (const text of [(await tasks.getTask(ctx.path, task.id)).brief, tasks.consolePrompt(task.id, 'explore', base.id)]) {
    assert.ok(text.includes(`The task's base is version ${base.id}`));
    assert.ok(text.includes(`checkpoint --task ${task.id} --label`));
    assert.ok(text.includes(`restore ${base.id}`));
    assert.ok(text.includes('finish on a clean tree'));
  }
  const noBase = tasks.consolePrompt(task.id, 'explore');
  assert.ok(noBase.includes(`task handover ${task.id}`), 'a base with no version comes from the studio');
  assert.ok(!noBase.includes('checkpoint --label'), 'never from a checkpoint of the session');
  assert.ok(!tasks.consolePrompt(task.id, 'handle', base.id).includes('restore'), 'only explore tasks are asked');

  await tasks.startTask(ctx.path, task.id);
  const first = await option('Option A', task.id);
  const back = cli('restore', base.id);
  assert.deepEqual(back, { restoredTo: { version: base.id, n: base.n, sha: base.sha, label: 'The base' }, safetyVersionId: null });
  assert.equal(await git.headSha(ctx.path), base.sha);
  const second = await option('Option B', task.id);
  assert.equal((await versions.getVersion(ctx.path, first.version)).role, 'option');
  assert.equal(await git.isAncestor(ctx.path, first.sha, second.sha), false, 'siblings in git');
  assert.equal(await git.isAncestor(ctx.path, second.sha, first.sha), false, 'siblings in git');

  // a dirty tree is kept as a safety copy, which never counts as the task's
  await fsp.appendFile(tuningFile(ctx), '\n// not kept\n');
  const dirty = cli('restore', base.id);
  assert.ok(dirty.safetyVersionId);
  const safety = await versions.getVersion(ctx.path, dirty.safetyVersionId);
  assert.equal(safety.origin, 'restore-safety');

  // a wrong id moves nothing, also one that is another project's
  const other = await projects.loadProject(b.project.id);
  const elsewhere = (await versions.listVersions(other.path))[0];
  for (const id of ['v_nope', elsewhere.id]) assert.throws(() => cli('restore', id), /is not a version of Alpha Room/);
  assert.equal(await git.headSha(ctx.path), base.sha);

  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Two options' });
  assert.deepEqual(fin.result.versionIds, [first.version, second.version]);
  assert.equal(fin.result.versionId, second.version);
  assert.equal(fin.result.resultSha, second.sha);
  assert.equal(fin.result.note, undefined);
  assert.equal(await git.headSha(ctx.path), base.sha, 'the finish leaves the tree on the base');
  assert.equal((await versions.listVersions(ctx.path)).at(-1).id, safety.id, 'no version was added');
  const ing = await tasks.ingestTask(ctx, task.id);
  assert.equal((await versions.getVersion(ctx.path, base.id)).taskId, null);
  assert.equal((await versions.getVersion(ctx.path, safety.id)).taskId, null);
  // HEAD is back on the base, and the two options are the task's own work: the safety copy is not
  assert.deepEqual(ing.evidence.commitsSinceBase.map((c) => c.sha).sort(), [first.sha, second.sha].sort());
  assert.deepEqual(ing.evidence.filesChanged, ['src/tuning.js']);
  const ingested = (await tasks.getTask(ctx.path, task.id)).events.at(-1);
  assert.equal(ingested.type, 'ingested');
  assert.deepEqual(ingested.data.versionIds, [first.version, second.version]);
  assert.equal(ingested.data.commits, 2);
  assert.equal(ingested.data.files, 1);
});

test('versions that share a commit count it once, and a task with no versionIds keeps base..HEAD', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const keep = async (text, taskId) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return versions.checkpoint(ctx, { label: text, origin: 'claude-code', taskId });
  };
  const task = await tasks.createTask(ctx, { request: 'One on top of the other', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  const lower = await keep('Lower', task.id);
  const upper = await keep('Upper', task.id);
  await tasks.finishTask(ctx, task.id, { summary: 'A line of two' });
  const ing = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual(ing.evidence.commitsSinceBase.map((c) => c.sha), [lower.sha, upper.sha]);

  // an older record: its result names one sha and no list
  const older = await tasks.createTask(ctx, { request: 'From before versionIds' });
  await tasks.startTask(ctx.path, older.id);
  const made = await keep('Older', older.id);
  const finished = await tasks.finishTask(ctx, older.id, { summary: 'Old shape' });
  const { versionIds, ...oldShape } = finished.result;
  assert.deepEqual(versionIds, [made.id]);
  await fsp.writeFile(path.join(ctx.path, '.studio', 'tasks', older.id, 'result.json'), JSON.stringify(oldShape));
  const oldIngest = await tasks.ingestTask(ctx, older.id);
  assert.deepEqual(oldIngest.evidence.commitsSinceBase.map((c) => c.sha), [made.sha]);
});

test('sessions are told to use #n, and checkpoint prints it on its first line', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const words = 'refer to versions by their number, #n, as the checkpoint command prints it';
  const task = await tasks.createTask(ctx, { request: 'Words about numbers', mode: 'explore' });
  assert.ok((await tasks.getTask(ctx.path, task.id)).brief.includes(words), 'the explore brief');
  assert.ok(tasks.consolePrompt(task.id, 'explore', 'v_x').includes(words), 'the explore prompt');
  assert.ok(tasks.consolePrompt(task.id, 'handle').includes(words), 'the other prompts');
  await fsp.appendFile(tuningFile(ctx), '\n// printed\n');
  const stdout = execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), 'checkpoint', '--label', 'Printed', '--project', ctx.project.id], { encoding: 'utf8', env: process.env });
  const made = cliJson(stdout);
  assert.equal(stdout.split('\n')[0].trim(), `#${made.n} Printed (${made.version})`);
});

test('the task list gives each result the number of every version, also an older result and a version that is gone', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { request: 'Numbers in the list', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  await fsp.appendFile(tuningFile(ctx), '\n// numbered\n');
  const made = await versions.checkpoint(ctx, { label: 'Numbered', origin: 'claude-code', taskId: task.id });
  await tasks.finishTask(ctx, task.id, { summary: 'One' });
  const read = async () => (await tasks.listTasks(ctx.path)).find((t) => t.id === task.id).result;
  assert.deepEqual((await read()).versionNumbers, [made.n]);
  const stored = path.join(ctx.path, '.studio', 'tasks', task.id, 'task.json');
  const record = JSON.parse(await fsp.readFile(stored, 'utf8'));
  assert.equal(record.result.versionNumbers, undefined, 'derived for the list, never stored');
  await fsp.writeFile(stored, JSON.stringify({ ...record, result: { ...record.result, versionIds: undefined } }));
  assert.deepEqual((await read()).versionNumbers, [made.n], 'a result from before versionIds');
  await fsp.writeFile(stored, JSON.stringify({ ...record, result: { ...record.result, versionIds: ['v_gone', made.id] } }));
  assert.deepEqual((await read()).versionNumbers, [null, made.n]);
  await tasks.cancelTask(ctx.path, task.id);
});

test('a version the person kept while a task worked is never the task\'s, and ingest leaves it alone', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { request: 'Work while the person keeps a version' });
  await tasks.startTask(ctx.path, task.id);
  await fsp.appendFile(tuningFile(ctx), '\n// kept by the person\n');
  const kept = await versions.checkpoint(ctx, { label: 'Keep', origin: 'user' });
  assert.equal(kept.taskId, null);
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Nothing of my own' });
  assert.deepEqual(fin.result.versionIds, []);
  assert.equal(fin.result.versionId, null);
  assert.equal(fin.version, null);
  assert.equal(fin.result.note, `The files on disk are those of version #${kept.n} (kept by you); nothing was kept for this task.`);
  await tasks.ingestTask(ctx, task.id);
  assert.equal((await versions.getVersion(ctx.path, kept.id)).taskId, null);

  // a result from before this rule can still name it: ingest leaves it alone all the same
  const older = await tasks.createTask(ctx, { request: 'A result from an older studio' });
  await fsp.appendFile(tuningFile(ctx), '\n// kept again\n');
  const again = await versions.checkpoint(ctx, { label: 'Keep again', origin: 'user' });
  const finished = await tasks.finishTask(ctx, older.id, { summary: 'Old result' });
  const file = path.join(ctx.path, '.studio', 'tasks', older.id, 'result.json');
  await fsp.writeFile(file, JSON.stringify({ ...finished.result, versionId: again.id, versionIds: [again.id], resultSha: again.sha }));
  await tasks.ingestTask(ctx, older.id);
  assert.equal((await versions.getVersion(ctx.path, again.id)).taskId, null);
});

test('an untagged version counts only as a session\'s, in HEAD\'s history and with files other than the base\'s', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const keep = async (text) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return versions.checkpoint(ctx, { label: text, origin: 'claude-code' });
  };
  const original = await fsp.readFile(tuningFile(ctx), 'utf8');
  const task = await tasks.createTask(ctx, { request: 'Untagged rules' });
  const base = await versions.versionAtHead(ctx.path);
  await tasks.startTask(ctx.path, task.id);
  const away = await keep('Left behind by a restore');
  await versions.restore(ctx, base.id);
  const stays = await keep('Stays in the line');
  await fsp.writeFile(tuningFile(ctx), original);
  const backToBase = await versions.checkpoint(ctx, { label: 'Edited back', origin: 'claude-code' });
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Untagged' });
  assert.deepEqual(fin.result.versionIds, [stays.id]);
  assert.ok(!fin.result.versionIds.includes(away.id), 'not in HEAD\'s history');
  assert.ok(!fin.result.versionIds.includes(backToBase.id), 'the same files as the base');
});

test('a finish that also checkpoints keeps every option before it, also one restored away from, and is marked as the finish', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const keep = async (text, taskId) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return versions.checkpoint(ctx, { label: text, origin: 'claude-code', taskId });
  };
  const task = await tasks.createTask(ctx, { request: 'Try again', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  const first = await keep('First', task.id);
  const away = await keep('Restored away from', task.id);
  await git.git(ctx.path, ['reset', '-q', '--hard', first.sha]);
  await fsp.appendFile(tuningFile(ctx), '\n// left on disk\n');
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Last one left on disk' });
  assert.notEqual(fin.version.id, first.id);
  assert.deepEqual(fin.result.versionIds, [first.id, away.id, fin.version.id]);
  assert.equal(fin.result.versionId, fin.version.id);
  assert.equal(fin.version.role, 'finish');
  assert.equal(first.role, undefined, 'a version made without a role has none');
  const listed = (await tasks.listTasks(ctx.path)).find((t) => t.id === task.id).result;
  assert.deepEqual(listed.versionRoles, [null, null, 'finish']);
  assert.deepEqual((await tasks.getTask(ctx.path, task.id)).task.result.versionRoles, [null, null, 'finish'], 'the row\'s detail too');
  const stored = JSON.parse(await fsp.readFile(path.join(ctx.path, '.studio', 'tasks', task.id, 'task.json'), 'utf8'));
  assert.equal(stored.result.versionRoles, undefined, 'derived on read, never stored');
  const ing = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual(ing.task.result.versionRoles, [null, null, 'finish'], 'the Record the result dialog too');
  assert.deepEqual(ing.task.result.versionNumbers, [first.n, away.n, fin.version.n]);
});

test('handover: the base is the version at handover, the brief and the prompt name it, and the finish compares to it', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { request: 'Left ready while I keep a version', mode: 'explore' });
  const created = task.context.baseVersionId;
  await tasks.questionTask(ctx.path, task.id, 'Which one?');
  await tasks.answerTask(ctx.path, task.id, 'The second');
  await fsp.appendFile(tuningFile(ctx), '\n// kept before the handover\n');
  const kept = await versions.checkpoint(ctx, { label: 'Kept before the handover', origin: 'user' });

  const handed = await tasks.handOverTask(ctx, task.id);
  assert.equal(handed.moved, true);
  assert.equal(handed.task.context.baseVersionId, kept.id);
  assert.equal(handed.task.context.baseSha, kept.sha);
  const prompt = tasks.consolePrompt(task.id, task.mode, handed.task.context.baseVersionId);
  const detail = await tasks.getTask(ctx.path, task.id);
  for (const text of [detail.brief, prompt]) {
    assert.ok(text.includes(`restore ${kept.id}`));
    assert.ok(!text.includes(`restore ${created}`));
  }
  assert.ok(detail.brief.includes(`Current source version: #${kept.n} "Kept before the handover"`));
  assert.ok(detail.brief.includes('A: The second'), 'an answer survives the new brief');
  const moved = detail.events.filter((e) => e.type === 'base_moved');
  assert.deepEqual(moved.map((e) => e.data.text), [`to #${kept.n}, the version at handover`]);
  assert.equal(moved[0].actor, 'studio');

  // a second handover with nothing new moves nothing
  assert.equal((await tasks.handOverTask(ctx, task.id)).moved, false);
  assert.equal((await tasks.getTask(ctx.path, task.id)).events.filter((e) => e.type === 'base_moved').length, 1);

  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Nothing came of it' });
  assert.equal(fin.result.note, tasks.NO_CHANGE_NOTE, 'compared to the handover base, not the one at creation');
  await tasks.cancelTask(ctx.path, task.id);
});

test('a session\'s work is not a base: a started task keeps its base at a second handover; a reopen after closing moves it', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { request: 'Interrupted with an option at HEAD', mode: 'explore' });
  const base = task.context.baseVersionId;
  await tasks.startTask(ctx.path, task.id);
  await fsp.appendFile(tuningFile(ctx), '\n// option left at HEAD\n');
  const option = await versions.checkpoint(ctx, { label: 'Option at HEAD', origin: 'claude-code', taskId: task.id, role: 'option' });
  assert.equal((await tasks.handOverTask(ctx, task.id)).moved, false);
  assert.equal((await tasks.reopenTask(ctx, task.id)).context.baseVersionId, base, 'an unfinished session\'s option');

  // the person keeps something else while it waits: that is not the task's, so the base follows
  await fsp.appendFile(tuningFile(ctx), '\n// the person moved on\n');
  const kept = await versions.checkpoint(ctx, { label: 'The person moved on', origin: 'user' });
  assert.equal((await tasks.handOverTask(ctx, task.id)).task.context.baseVersionId, kept.id);

  await tasks.finishTask(ctx, task.id, { summary: 'One option' });
  await tasks.ingestTask(ctx, task.id);
  await fsp.appendFile(tuningFile(ctx), '\n// after it closed\n');
  const later = await versions.checkpoint(ctx, { label: 'After it closed', origin: 'user' });
  const reopened = await tasks.reopenTask(ctx, task.id);
  assert.equal(reopened.status, 'ready');
  assert.equal(reopened.context.baseVersionId, later.id);
  const afterReopen = await tasks.getTask(ctx.path, task.id);
  assert.ok(afterReopen.brief.includes(`restore ${later.id}`));
  assert.equal(afterReopen.events.filter((e) => e.type === 'base_moved').at(-1).data.text, `to #${later.n}, the version at reopen`);
  await tasks.cancelTask(ctx.path, task.id);
  assert.equal((await tasks.handOverTask(ctx, task.id)).moved, false, 'a closed task is handed to no one');
});

test('a handle task\'s base moves too, and a hand commit by its interrupted session stays that session\'s', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { request: 'Handle it' });
  await fsp.appendFile(tuningFile(ctx), '\n// by hand, before the handover\n');
  const sha = await git.commitAll(ctx.path, 'by hand before');
  const before = (await versions.listVersions(ctx.path)).length;
  const handed = await tasks.handOverTask(ctx, task.id);
  assert.equal(handed.task.context.baseVersionId, null);
  assert.equal(handed.task.context.baseSha, sha);
  assert.equal((await versions.listVersions(ctx.path)).length, before, 'only an explore task gets a kept base');
  assert.equal((await tasks.getTask(ctx.path, task.id)).events.find((e) => e.type === 'base_moved').data.text, `to commit ${sha.slice(0, 8)}, the commit at handover`);

  await tasks.startTask(ctx.path, task.id);
  await fsp.appendFile(tuningFile(ctx), '\n// by hand, in the session\n');
  await git.commitAll(ctx.path, 'by hand during');
  assert.equal((await tasks.handOverTask(ctx, task.id)).moved, false);
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Committed by hand' });
  assert.equal(fin.version.role, 'finish');
  assert.deepEqual(fin.result.filesChanged, ['src/tuning.js']);
});

test('a base with no version is kept by the studio at handover, named in the prompt, and never an option', async () => {
  const made = await projects.createProject({ name: 'No Version Base', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const scratch = path.join(ctx.path, 'scratch.txt');
  const keep = async (text, taskId) => {
    await fsp.appendFile(scratch, `${text}\n`);
    return versions.checkpoint(ctx, { label: text, origin: 'claude-code', taskId, role: 'option' });
  };

  // a clean tree on a commit with no record: the commit is adopted, nothing new is committed
  await fsp.writeFile(scratch, 'by hand\n');
  const sha = await git.commitAll(ctx.path, 'by hand');
  const task = await tasks.createTask(ctx, { request: 'One two three four five six seven eight. And more.', mode: 'explore' });
  assert.equal(task.context.baseVersionId, null);
  const unhanded = (await tasks.getTask(ctx.path, task.id)).brief;
  assert.ok(unhanded.includes(`task handover ${task.id}`), 'a brief read with no handover says how to get a base');
  assert.ok(!unhanded.includes('checkpoint --label'));
  const { task: handed, moved } = await tasks.handOverTask(ctx, task.id);
  assert.equal(moved, true);
  const base = await versions.versionAtHead(ctx.path);
  assert.equal(await git.headSha(ctx.path), sha, 'no empty commit');
  assert.equal(base.label, 'Base for One two three four five six');
  assert.equal(base.origin, 'studio');
  assert.equal(base.taskId, null);
  assert.equal(handed.context.baseVersionId, base.id);
  const prompt = tasks.consolePrompt(task.id, 'explore', handed.context.baseVersionId);
  assert.ok(prompt.includes(`restore ${base.id}`));
  assert.ok(!prompt.includes('checkpoint --label'));
  assert.ok((await tasks.getTask(ctx.path, task.id)).brief.includes(`restore ${base.id}`));

  await tasks.startTask(ctx.path, task.id);
  const first = await keep('First', task.id);
  await versions.restore(ctx, base.id);
  const second = await keep('Second', task.id);
  await versions.restore(ctx, base.id);
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Two options' });
  assert.deepEqual(fin.result.versionIds, [first.id, second.id], 'the base is not listed');
  await tasks.ingestTask(ctx, task.id);
  assert.equal((await versions.getVersion(ctx.path, base.id)).taskId, null);

  // a dirty tree on a commit with no record: what is on disk is the base
  await fsp.appendFile(scratch, 'by hand again\n');
  await git.commitAll(ctx.path, 'by hand again');
  await fsp.appendFile(scratch, 'not committed\n');
  const dirty = await tasks.createTask(ctx, { request: 'Short title', mode: 'explore' });
  const again = await tasks.handOverTask(ctx, dirty.id);
  const dirtyBase = await versions.getVersion(ctx.path, again.task.context.baseVersionId);
  assert.equal(dirtyBase.label, 'Base for Short title');
  assert.deepEqual(dirtyBase.filesChanged, ['scratch.txt']);
  assert.equal((await versions.changes(ctx.path)).dirty, false);

  // through the CLI, as a session from Copy command is told to
  const copied = await tasks.createTask(ctx, { request: 'From a copied command', mode: 'explore' });
  await fsp.appendFile(scratch, 'by hand a third time\n');
  await git.commitAll(ctx.path, 'by hand a third time');
  const stdout = execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), 'task', 'handover', copied.id, '--project', ctx.project.id], { encoding: 'utf8', env: process.env });
  const third = await versions.versionAtHead(ctx.path);
  assert.equal(stdout.trim(), `task ${copied.id}: the base is #${third.n} ${third.label} (${third.id}), and the brief says so now`);
});

test('a started explore task keeps its bare base: edits and hand commits are not a base; clean on the base commit it is adopted', async () => {
  const made = await projects.createProject({ name: 'Bare Base Stays', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const scratch = path.join(ctx.path, 'scratch.txt');
  await fsp.writeFile(scratch, 'by hand\n');
  const sha = await git.commitAll(ctx.path, 'by hand');
  const count = async () => (await versions.listVersions(ctx.path)).length;
  const before = await count();

  // first run from Copy command, interrupted with edits: the second handover keeps nothing and moves nothing
  const task = await tasks.createTask(ctx, { request: 'Interrupted with edits', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  await fsp.appendFile(scratch, 'half done\n');
  const handed = await tasks.handOverTask(ctx, task.id);
  assert.equal(handed.moved, false);
  assert.deepEqual([handed.task.context.baseVersionId, handed.task.context.baseSha], [null, sha]);
  assert.equal(await count(), before, 'no Base for the half-done tree');
  assert.equal((await versions.changes(ctx.path)).dirty, true, 'the edits are still only on disk');
  const stdout = execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), 'task', 'handover', task.id, '--project', ctx.project.id], { encoding: 'utf8', env: process.env });
  const keptWords = `The task's base is commit ${sha.slice(0, 8)} with no version: this started task already has work on it. Go on from the files on disk; options made from here cannot be restored to a base, so they sit in one line.`;
  assert.equal(stdout.trim(), `task ${task.id}: ${keptWords}`);
  // the brief the session is told to read again says the same, and no longer sends it back to the handover
  await tasks.noteTask(ctx.path, task.id, 'still here');
  const keptBrief = (await tasks.getTask(ctx.path, task.id)).brief;
  assert.ok(keptBrief.includes(keptWords), 'the brief says the base stays');
  assert.ok(!keptBrief.includes('writes its id into the brief'), 'the false sentence is gone');
  assert.ok(keptBrief.includes(`checkpoint --task ${task.id} --label`), 'it still says how to keep an option');
  const keptPrompt = tasks.consolePrompt(task.id, 'explore', null, sha);
  assert.ok(keptPrompt.includes(keptWords) && !keptPrompt.includes('writes its id into the brief'), 'the Chat prompt too');

  // the same with the edits committed by hand
  const committed = await git.commitAll(ctx.path, 'half done, by hand');
  const later = await tasks.handOverTask(ctx, task.id);
  assert.equal(later.moved, false);
  assert.equal(later.task.context.baseSha, sha);
  assert.equal(await count(), before);
  assert.equal(await git.headSha(ctx.path), committed);
  await tasks.cancelTask(ctx.path, task.id);

  // task start ran first, as a command copied before the handover came first still does: no work yet, so the session gets its base
  const fresh = await tasks.createTask(ctx, { request: 'Started before its handover', mode: 'explore' });
  await tasks.startTask(ctx.path, fresh.id);
  const first = await tasks.handOverTask(ctx, fresh.id);
  assert.equal(first.moved, true);
  const base = await versions.getVersion(ctx.path, first.task.context.baseVersionId);
  assert.equal(base.sha, committed, 'adopted, with no commit');
  assert.equal(await git.headSha(ctx.path), committed);
  assert.ok((await tasks.getTask(ctx.path, fresh.id)).brief.includes(`restore ${base.id}`));
});

test('a kept bare base rewrites the brief with its answers; a clean started task is not told it has work; a reopen is not either', async () => {
  const made = await projects.createProject({ name: 'Kept Brief', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const scratch = path.join(ctx.path, 'scratch.txt');
  await fsp.writeFile(scratch, 'by hand\n');
  await git.commitAll(ctx.path, 'by hand');
  const task = await tasks.createTask(ctx, { request: 'Answered, then interrupted', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  await tasks.questionTask(ctx.path, task.id, 'Which way?');
  await tasks.answerTask(ctx.path, task.id, 'That way');
  // started and clean on the base: the handover can still give it a version, so the old sentence is the true one
  assert.ok((await tasks.getTask(ctx.path, task.id)).brief.includes('writes its id into the brief'));
  await fsp.appendFile(scratch, 'half done\n');
  assert.equal((await tasks.handOverTask(ctx, task.id)).reason, 'kept');
  const { brief } = await tasks.getTask(ctx.path, task.id);
  assert.ok(brief.includes('this started task already has work on it'));
  assert.ok(brief.trimEnd().endsWith('A: That way'), 'the answer survives');
  // a reopen moves a closed task's base to a commit: a handover can adopt that, so it has no work to speak of
  await git.commitAll(ctx.path, 'half done, by hand');
  await tasks.finishTask(ctx, task.id, { summary: 'Left by hand' });
  await tasks.ingestTask(ctx, task.id);
  await fsp.appendFile(scratch, 'after it closed\n');
  await git.commitAll(ctx.path, 'after it closed');
  await tasks.reopenTask(ctx, task.id);
  assert.ok(!(await tasks.getTask(ctx.path, task.id)).brief.includes('already has work on it'));
  assert.equal((await tasks.handOverTask(ctx, task.id)).reason, 'moved');
});

test('task handover says what is true of a closed task, a kept base and a base whose record is gone', async () => {
  const made = await projects.createProject({ name: 'Handover Words', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const handover = (id) => execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), 'task', 'handover', id, '--project', ctx.project.id], { encoding: 'utf8', env: process.env }).trim();
  const scratch = path.join(ctx.path, 'scratch.txt');
  await fsp.writeFile(scratch, 'by hand\n');
  const sha = await git.commitAll(ctx.path, 'by hand');

  // closed, with no base version: nothing is claimed about work on it
  const cancelled = await tasks.createTask(ctx, { request: 'Cancelled', mode: 'explore' });
  await tasks.cancelTask(ctx.path, cancelled.id);
  assert.equal((await tasks.handOverTask(ctx, cancelled.id)).reason, 'closed');
  assert.equal(handover(cancelled.id), `task ${cancelled.id} is Cancelled; nothing to hand over`);
  const review = await tasks.createTask(ctx, { request: 'In review', mode: 'explore' });
  await tasks.finishTask(ctx, review.id, { summary: 'Nothing' });
  assert.equal(handover(review.id), `task ${review.id} is Ready to try; nothing to hand over`);

  // kept with no version, on a started explore task with work on it
  const started = await tasks.createTask(ctx, { request: 'Started', mode: 'explore' });
  await tasks.startTask(ctx.path, started.id);
  await fsp.appendFile(scratch, 'half done\n');
  assert.equal(handover(started.id), `task ${started.id}: The task's base is commit ${sha.slice(0, 8)} with no version: this started task already has work on it. Go on from the files on disk; options made from here cannot be restored to a base, so they sit in one line.`);
  await tasks.cancelTask(ctx.path, started.id);
  await git.commitAll(ctx.path, 'half done');

  // a base version whose record is gone, on a task that is otherwise fine
  const recorded = await versions.adoptHead(ctx, { label: 'Soon gone', origin: 'import' });
  const lost = await tasks.createTask(ctx, { request: 'Lost record' });
  assert.equal(lost.context.baseVersionId, recorded.id);
  const file = path.join(ctx.path, '.studio', 'versions.json');
  const list = JSON.parse(await fsp.readFile(file, 'utf8'));
  await fsp.writeFile(file, JSON.stringify(list.filter((v) => v.id !== recorded.id), null, 2));
  assert.equal(handover(lost.id), `task ${lost.id}: the base is commit ${recorded.sha.slice(0, 8)}; its base version record is gone`);
});

test('a brief from before the handover step gains it when read, keeps its answers, and a closed task\'s stays as it was', async () => {
  const made = await projects.createProject({ name: 'Old Brief', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const briefFile = (id) => path.join(ctx.path, '.studio', 'tasks', id, 'brief.md');
  const makeOld = async (id, tail = '') => {
    const lines = (await fsp.readFile(briefFile(id), 'utf8')).split('\n');
    const at = lines.findIndex((l) => l.includes(`task handover ${id}`));
    lines.splice(at, 2); // the step and its explanation
    const old = lines.join('\n') + tail;
    assert.ok(!old.includes(`task handover ${id}`));
    await fsp.writeFile(briefFile(id), old);
    return old;
  };
  const answer = '\n## Answer from the user (2026-11-01T00:00:00.000Z)\nQ: Which?\nA: The first\n';
  const task = await tasks.createTask(ctx, { request: 'An old task that mentions task handover in its request' });
  await makeOld(task.id, answer);
  const { brief } = await tasks.getTask(ctx.path, task.id);
  const handover = brief.indexOf(`task handover ${task.id}`);
  assert.ok(handover >= 0, 'the step is listed, though the request already held the words');
  assert.ok(handover < brief.indexOf(`task start ${task.id}`), 'before the start');
  assert.ok(brief.endsWith(answer), 'the answer is still the end of it');
  assert.equal(await fsp.readFile(briefFile(task.id), 'utf8'), brief, 'written back');
  assert.equal((await tasks.getTask(ctx.path, task.id)).brief, brief, 'a second read changes nothing');

  const closed = await tasks.createTask(ctx, { request: 'Closed before the step' });
  const old = await makeOld(closed.id);
  await tasks.cancelTask(ctx.path, closed.id);
  assert.equal((await tasks.getTask(ctx.path, closed.id)).brief, old);

  // an answer and a catch-up at the same moment: neither loses the answer
  const both = await tasks.createTask(ctx, { request: 'Answered while being read' });
  await makeOld(both.id);
  await tasks.questionTask(ctx.path, both.id, 'Now?');
  await Promise.all([tasks.answerTask(ctx.path, both.id, 'Now'), tasks.getTask(ctx.path, both.id)]);
  const after = (await tasks.getTask(ctx.path, both.id)).brief;
  assert.ok(after.includes('A: Now') && after.includes(`task handover ${both.id}`));
});

test('a reopened handle task counts both rounds, each finish from its own base', async () => {
  const made = await projects.createProject({ name: 'Two Rounds', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const task = await tasks.createTask(ctx, { request: 'Two rounds' });
  const base = task.context.baseSha;
  await fsp.writeFile(path.join(ctx.path, 'x.txt'), 'x\n');
  const f1 = (await tasks.finishTask(ctx, task.id, { summary: 'Round one' })).version;
  assert.equal(f1.baseSha, base, 'a finish records the base it counts from');
  assert.deepEqual((await tasks.ingestTask(ctx, task.id)).evidence.filesChanged, ['x.txt']);
  assert.equal((await tasks.reopenTask(ctx, task.id)).context.baseSha, f1.sha);

  await fsp.writeFile(path.join(ctx.path, 'y.txt'), 'y\n');
  const f2 = (await tasks.finishTask(ctx, task.id, { summary: 'Round two' })).version;
  assert.equal(f2.baseSha, f1.sha);
  const { evidence } = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual([...evidence.filesChanged].sort(), ['x.txt', 'y.txt']);
  assert.deepEqual(evidence.commitsSinceBase.map((c) => c.sha).sort(), [f1.sha, f2.sha].sort());

  // a third round by hand: the adopted commit carries its base too
  await tasks.reopenTask(ctx, task.id);
  await fsp.writeFile(path.join(ctx.path, 'z.txt'), 'z\n');
  await git.commitAll(ctx.path, 'by hand');
  const f3 = (await tasks.finishTask(ctx, task.id, { summary: 'Round three' })).version;
  assert.equal(f3.baseSha, f2.sha, 'an adopted hand commit records it as well');
  const third = (await tasks.ingestTask(ctx, task.id)).evidence;
  assert.deepEqual([...third.filesChanged].sort(), ['x.txt', 'y.txt', 'z.txt']);
  assert.deepEqual(third.commitsSinceBase.map((c) => c.sha).sort(), [f1.sha, f2.sha, f3.sha].sort());
});

test('the copied command, the Chat prompt, the brief and the generated CLAUDE.md all put task handover before task start', async () => {
  const made = await projects.createProject({ name: 'Order Of Steps', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const task = await tasks.createTask(ctx, { request: 'Check the order of the first two steps' });
  const inOrder = (text, label) => {
    const handover = text.indexOf(`task handover ${task.id}`);
    assert.ok(handover >= 0, `${label} names the handover`);
    assert.ok(handover < text.indexOf(`task start ${task.id}`), `${label} puts it first`);
  };
  const open = tasks.openPrompt(task.id);
  assert.ok(open.indexOf('"task handover"') >= 0 && open.indexOf('"task handover"') < open.indexOf('"task start"'), 'the copied prompt');
  inOrder(tasks.consolePrompt(task.id, 'handle'), 'the Chat prompt');
  inOrder((await tasks.getTask(ctx.path, task.id)).brief, 'the brief');
  await briefing.regenerate(ctx.project.id);
  inOrder(await fsp.readFile(path.join(ctx.path, 'CLAUDE.md'), 'utf8'), 'CLAUDE.md');
  // Copy command builds its text in the client: it must be the server's prompt word for word
  const client = await fsp.readFile(new URL('../client/components/task-list.js', import.meta.url), 'utf8');
  assert.ok(client.includes(tasks.openPrompt('${tid}')), 'task-list.js holds the same prompt as openPrompt');
  // what those words ask for, on a clean tree: the handover changes nothing the second time, and the start follows
  await tasks.handOverTask(ctx, task.id);
  const before = (await tasks.getTask(ctx.path, task.id)).task.context;
  assert.equal((await tasks.handOverTask(ctx, task.id)).moved, false);
  assert.deepEqual((await tasks.getTask(ctx.path, task.id)).task.context, before);
  assert.equal((await tasks.startTask(ctx.path, task.id)).status, 'working');
  await tasks.cancelTask(ctx.path, task.id);
});

test('a --project path or working folder that differs by case finds the project', { skip: process.platform === 'win32' ? false : 'folders differ by case only on Windows' }, async () => {
  const ctx = await projects.loadProject(a.project.id);
  const list = (args, cwd) => execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), 'task', 'list', ...args], { encoding: 'utf8', env: process.env, cwd });
  const expected = list(['--project', ctx.project.id]);
  for (const folder of [ctx.path.toUpperCase(), ctx.path.toLowerCase()]) {
    assert.notEqual(folder, ctx.path);
    assert.equal(list(['--project', folder]), expected, `--project ${folder}`);
    assert.equal(list([], folder), expected, `working folder ${folder}`);
  }
  const elsewhere = spawnSync(process.execPath, [path.resolve('bin/atelier.mjs'), 'task', 'list', '--project', `${ctx.path.toUpperCase()}-OTHER`], { encoding: 'utf8', env: process.env });
  assert.notEqual(elsewhere.status, 0);
  assert.match(elsewhere.stderr, /No registered project matches/);
});

test('compare cuts an over-long diff on a whole character, at no more than the limit', async () => {
  const dir = await fsp.mkdtemp(path.join(root, 'cut-'));
  execFileSync('git', ['init', '-q', dir]);
  const file = path.join(dir, 'text.txt');
  await fsp.writeFile(file, 'start\n');
  const first = await git.commitAll(dir, 'first');
  await fsp.writeFile(file, `${'é€😀'.repeat(200)}\n`);
  const second = await git.commitAll(dir, 'second');
  const whole = await git.diffSummary(dir, first, second);
  assert.equal(whole.truncated, false);
  const size = Buffer.byteLength(whole.diff);
  const seen = new Set();
  // one whole round of the 2, 3 and 4 byte characters, so the limit lands inside each kind and on a boundary
  for (let maxDiffBytes = size - 12; maxDiffBytes < size; maxDiffBytes++) {
    const { diff, truncated } = await git.diffSummary(dir, first, second, { maxDiffBytes });
    assert.equal(truncated, true);
    const bytes = Buffer.byteLength(diff);
    assert.ok(bytes <= maxDiffBytes, `${bytes} bytes against a limit of ${maxDiffBytes}`);
    assert.ok(maxDiffBytes - bytes < 4, 'steps back no further than one character');
    assert.ok(!diff.includes('�'), `no broken character at a limit of ${maxDiffBytes}`);
    assert.ok(whole.diff.startsWith(diff), 'the kept text is the diff\'s own beginning');
    seen.add(maxDiffBytes - bytes);
  }
  assert.ok(seen.size > 1, 'some limits did land inside a character');
  // the fault itself: a cut by characters after measuring bytes lets multibyte text run past the limit
  const large = await git.diffSummary(dir, first, second, { maxDiffBytes: 1000 });
  assert.ok(Buffer.byteLength(large.diff) <= 1000);
});

test('no base_moved event while the sha stays: a commit that gained a version gives the task its id quietly', async () => {
  const made = await projects.createProject({ name: 'Quiet Base', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const scratch = path.join(ctx.path, 'scratch.txt');
  await fsp.writeFile(scratch, 'by hand\n');
  const sha = await git.commitAll(ctx.path, 'by hand');
  const baseMoved = async (id) => (await tasks.getTask(ctx.path, id)).events.filter((e) => e.type === 'base_moved');

  const task = await tasks.createTask(ctx, { request: 'A bare base' });
  assert.equal(task.context.baseVersionId, null);
  const recorded = await versions.adoptHead(ctx, { label: 'Recorded later', origin: 'import' });
  const handed = await tasks.handOverTask(ctx, task.id);
  assert.deepEqual([handed.task.context.baseVersionId, handed.task.context.baseSha], [recorded.id, sha]);
  assert.deepEqual(await baseMoved(task.id), []);
  assert.ok((await tasks.getTask(ctx.path, task.id)).brief.includes(`#${recorded.n} "Recorded later"`), 'the brief names the version');
  assert.equal((await tasks.handOverTask(ctx, task.id)).moved, false);

  // the studio keeping a base on the same commit moves nothing either
  await fsp.appendFile(scratch, 'again\n');
  const next = await git.commitAll(ctx.path, 'again');
  const explore = await tasks.createTask(ctx, { request: 'A kept base', mode: 'explore' });
  const kept = await tasks.handOverTask(ctx, explore.id);
  assert.equal(kept.moved, true, 'the brief changed');
  assert.equal(kept.task.context.baseSha, next);
  assert.ok(kept.task.context.baseVersionId);
  assert.deepEqual(await baseMoved(explore.id), []);

  // a sha that does move still says so
  await fsp.appendFile(scratch, 'moved\n');
  const moved = await versions.checkpoint(ctx, { label: 'Moved on', origin: 'user' });
  await tasks.handOverTask(ctx, explore.id);
  assert.deepEqual((await baseMoved(explore.id)).map((e) => e.data.text), [`to #${moved.n}, the version at handover`]);
});

test('ingest counts each version from its own base after a reopen moved the task\'s past its older options', async () => {
  const made = await projects.createProject({ name: 'Own Bases', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const cli = (...args) => cliJson(execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), ...args, '--project', ctx.project.id], { encoding: 'utf8', env: process.env }));
  const write = (name) => fsp.writeFile(path.join(ctx.path, name), `${name}\n`);
  const b0 = await versions.versionAtHead(ctx.path);
  const task = await tasks.createTask(ctx, { request: 'Two options, a reopen, one more', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  const option = async (file) => {
    await write(file);
    return versions.getVersion(ctx.path, cli('checkpoint', '--label', file, '--task', task.id).version);
  };
  const a = await option('a.txt');
  await versions.restore(ctx, b0.id);
  const b = await option('b.txt');
  assert.deepEqual([a.baseSha, b.baseSha], [b0.sha, b0.sha], 'the task\'s base when each was made');
  await versions.restore(ctx, b0.id);

  await write('only-f.txt'); // what the finish keeps
  const finish = (await tasks.finishTask(ctx, task.id, { summary: 'Two options and what was left' })).version;
  await tasks.ingestTask(ctx, task.id);
  const reopened = await tasks.reopenTask(ctx, task.id);
  assert.equal(reopened.context.baseSha, finish.sha, 'the base moved to the finish');

  await tasks.startTask(ctx.path, task.id);
  const c = await option('c.txt');
  assert.equal(c.baseSha, finish.sha);
  await versions.restore(ctx, finish.id);

  // A record from before the field counts from where it left the task's base.
  const file = path.join(ctx.path, '.studio', 'versions.json');
  const list = JSON.parse(await fsp.readFile(file, 'utf8'));
  delete list.find((v) => v.id === a.id).baseSha;
  await fsp.writeFile(file, JSON.stringify(list, null, 2));

  const fin = await tasks.finishTask(ctx, task.id, { summary: 'One more' });
  assert.ok(fin.result.versionIds.includes(finish.id), 'the finish is still listed as the task\'s');
  const { evidence } = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual([...evidence.filesChanged].sort(), ['a.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(evidence.commitsSinceBase.map((x) => x.sha).sort(), [a.sha, b.sha, c.sha].sort());
});

test('restore answers 409 commit_gone with the number when a record has no sha, and writes nothing', async () => {
  const made = await projects.createProject({ name: 'No Sha', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const file = path.join(ctx.path, '.studio', 'versions.json');
  const list = JSON.parse(await fsp.readFile(file, 'utf8'));
  const { sha, ...lacking } = list[0];
  const record = { ...lacking, id: 'v_nosha', n: 2 };
  await fsp.writeFile(file, JSON.stringify([...list, record], null, 2));
  await fsp.writeFile(path.join(ctx.path, 'dirty.txt'), 'not kept\n');
  await assert.rejects(versions.restore(ctx, 'v_nosha'), (err) => err.status === 409 && err.code === 'commit_gone' && err.message.startsWith('#2 '));
  assert.equal((await versions.listVersions(ctx.path)).length, 2, 'no safety copy');
  assert.equal(await git.headSha(ctx.path), sha);
});

test('ingest gives an untagged option of an explore task its role, and leaves other tasks\' versions without one', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const keep = async (text, extra) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return versions.checkpoint(ctx, { label: text, origin: 'claude-code', ...extra });
  };
  const task = await tasks.createTask(ctx, { request: 'One tagged, one not', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  const tagged = await keep('Tagged', { taskId: task.id, role: 'option' });
  const plain = await keep('Plain', {});
  assert.equal(plain.role, undefined);
  await tasks.finishTask(ctx, task.id, { summary: 'Mixed' });
  await tasks.ingestTask(ctx, task.id);
  const after = await versions.getVersion(ctx.path, plain.id);
  assert.equal(after.taskId, task.id);
  assert.equal(after.role, 'option');
  assert.equal((await versions.getVersion(ctx.path, tagged.id)).role, 'option');

  const handle = await tasks.createTask(ctx, { request: 'Not an explore task' });
  await tasks.startTask(ctx.path, handle.id);
  const own = await keep('Handled', {});
  await tasks.finishTask(ctx, handle.id, { summary: 'Done' });
  await tasks.ingestTask(ctx, handle.id);
  const handled = await versions.getVersion(ctx.path, own.id);
  assert.equal(handled.taskId, handle.id);
  assert.equal(handled.role, undefined);
});

test('restore refuses a version whose commit is gone, names it, and writes nothing', async () => {
  const made = await projects.createProject({ name: 'Gone Commit', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  const file = path.join(ctx.path, '.studio', 'versions.json');
  const list = JSON.parse(await fsp.readFile(file, 'utf8'));
  const sha = 'deadbeef'.repeat(5);
  await fsp.writeFile(file, JSON.stringify([...list, { ...list[0], id: 'v_gone', n: list.length + 1, sha, label: 'Lost one' }]));
  await fsp.writeFile(path.join(ctx.path, 'dirty.txt'), 'must stay as it is\n');
  const head = await git.headSha(ctx.path);
  const versionsBefore = await fsp.readFile(file, 'utf8');
  const history = path.join(ctx.path, '.studio', 'history.jsonl');
  const historyBefore = await fsp.readFile(history, 'utf8').catch(() => '');
  const line = `#${list.length + 1} Lost one: its commit deadbee is not in this repository`;

  await assert.rejects(versions.restore(ctx, 'v_gone'), (err) => err.message === line && err.status === 409);
  assert.throws(
    () => execFileSync(process.execPath, [path.resolve('bin/atelier.mjs'), 'restore', 'v_gone', '--project', ctx.project.id], { encoding: 'utf8', env: process.env, stdio: 'pipe' }),
    (err) => err.stderr.includes(line),
  );
  assert.equal(await git.headSha(ctx.path), head);
  assert.equal(await fsp.readFile(file, 'utf8'), versionsBefore);
  assert.equal(await fsp.readFile(history, 'utf8').catch(() => ''), historyBefore);
  assert.equal(await fsp.readFile(path.join(ctx.path, 'dirty.txt'), 'utf8'), 'must stay as it is\n');
});

test('HEAD on another task\'s version does not hide this task\'s options', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const keep = async (text, taskId) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return versions.checkpoint(ctx, { label: text, origin: 'claude-code', taskId });
  };
  const task = await tasks.createTask(ctx, { request: 'Try once more', mode: 'explore' });
  await tasks.startTask(ctx.path, task.id);
  const mine = await keep('Mine', task.id);
  await keep('Theirs', 't_other');
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'One option, then another task landed' });
  assert.deepEqual(fin.result.versionIds, [mine.id]);
  assert.equal(fin.result.versionId, mine.id);
  assert.equal(fin.result.resultSha, mine.sha);
  assert.equal(fin.result.note, undefined);
});

test('finish after a reset to an older commit that has a version names that version, whoever made it', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const keep = async (text, taskId) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return versions.checkpoint(ctx, { label: text, origin: 'claude-code', taskId });
  };
  const unnamed = await keep('kept by the person');
  const named = await keep('kept by another task', 't_other');
  await keep('the newest');
  const count = (await versions.listVersions(ctx.path)).length;
  for (const target of [named, unnamed]) {
    const task = await tasks.createTask(ctx, { request: 'Go back to an older version' });
    await tasks.startTask(ctx.path, task.id);
    await git.git(ctx.path, ['reset', '-q', '--hard', target.sha]);
    const fin = await tasks.finishTask(ctx, task.id, { summary: 'Went back' });
    assert.equal(fin.version, null);
    assert.equal(fin.result.versionId, null);
    assert.deepEqual(fin.result.filesChanged, []);
    assert.equal(fin.result.note, `The files on disk are those of version #${target.n} (an earlier version); nothing was kept for this task.`);
    assert.equal((await tasks.ingestTask(ctx, task.id)).version, null);
  }
  assert.equal((await versions.listVersions(ctx.path)).length, count);
});

test('ingest carries result.unresolved into the project list, the same text only once', async () => {
  const ctx = await projects.loadProject(a.project.id);
  await projects.patchProject(a.project.id, { unresolved: ['Already open'] });
  const task = await tasks.createTask(ctx, { request: 'Leave two questions open' });
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')) + '\n// unresolved test\n');
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Done with questions', unresolved: ['Should the jump have a sound?', ' Already open ', 'Should the jump have a sound?', ''] });
  assert.equal(fin.result.unresolved.length, 3);
  // ctx predates this edit: ingest must not write its stale copy over it
  await projects.patchProject(a.project.id, { purpose: 'changed during the task' });
  const ing = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual(ing.unresolved.map((u) => u.text), ['Should the jump have a sound?']);
  let { project } = await projects.loadProject(a.project.id);
  assert.deepEqual(project.unresolved.map((u) => u.text), ['Already open', 'Should the jump have a sound?']);
  const added = project.unresolved[1];
  assert.match(added.id, /^u_/);
  assert.ok(added.createdAt);
  assert.equal(added.taskId, task.id);
  assert.equal(added.taskTitle, task.title);
  assert.ok(task.title);
  assert.ok(added.at);
  assert.equal(project.unresolved[0].taskId, undefined); // what the person typed stays unstamped
  assert.equal(project.purpose, 'changed during the task');
  assert.deepEqual((await tasks.getTask(ctx.path, task.id)).task.ingest.unresolvedIds, [added.id]);
  // a second ingest adds nothing (see the next test); the items reach the briefing
  assert.deepEqual((await tasks.ingestTask(ctx, task.id)).unresolved, []);
  ({ project } = await projects.loadProject(a.project.id));
  assert.equal(project.unresolved.length, 2);
  await briefing.regenerate(a.project.id);
  const md = await fsp.readFile(path.join(ctx.path, '.studio', 'BRIEFING.md'), 'utf8');
  assert.ok(md.includes(`## Unresolved\n- Already open\n- From task: ${task.title} · 1 item (${task.id})\n  - Should the jump have a sound?\n`), md);
  // Focus resolves a group by sending the list without it: the rest keep their stamps through the PATCH
  const kept = { id: 'u_kept', text: 'From another task', taskId: 't_other', taskTitle: 'Other', at: '2026-11-04T00:00:00.000Z', createdAt: '2026-11-04T00:00:00.000Z' };
  project = await projects.patchProject(a.project.id, { unresolved: [...project.unresolved, kept] });
  project = await projects.patchProject(a.project.id, { unresolved: project.unresolved.filter((u) => u.taskId !== task.id) });
  assert.deepEqual(project.unresolved.map((u) => u.text), ['Already open', 'From another task']);
  assert.deepEqual(project.unresolved[1], kept);
  await projects.patchProject(a.project.id, { unresolved: [], purpose: 'learn movement feel' });
});

test('the briefing names a carried item without a title from the tasks, and reads an empty list as none', () => {
  const lines = briefing.unresolvedLines([
    { text: 'Typed' }, 'Plain string', { text: 'Old', taskId: 't_old' }, { text: 'Gone', taskId: 't_gone' },
  ], [{ id: 't_old', title: 'Old task' }]);
  assert.equal(lines, '- Typed\n- Plain string\n- From task: Old task · 1 item (t_old)\n  - Old\n- From earlier tasks · 1 item\n  - Gone');
  assert.equal(briefing.unresolvedLines([]), '- _none_');
  assert.equal(briefing.unresolvedLines(undefined), '- _none_');
});

test('a second ingest of a done task changes nothing; a decision repeated in a result is recorded once', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const decisionsFile = path.join(ctx.path, '.studio', 'decisions.json');
  const eventsFile = (id) => path.join(ctx.path, '.studio', 'tasks', id, 'events.jsonl');
  const stored = async () => JSON.parse(await fsp.readFile(decisionsFile, 'utf8'));
  const before = (await stored()).length;
  const task = await tasks.createTask(ctx, { request: 'Decide twice' });
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')) + '\n// decision test\n');
  await tasks.finishTask(ctx, task.id, { summary: 'Decided', decisions: ['Same call | first reason', 'Other call | why', 'Same call | second reason'] });
  const first = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual(first.decisions.map((d) => d.text), ['Same call', 'Other call']);
  assert.equal(first.decisions[0].reason, 'first reason');
  assert.equal((await stored()).length, before + 2);

  const eventsBefore = await fsp.readFile(eventsFile(task.id), 'utf8');
  const taskBefore = (await tasks.getTask(ctx.path, task.id)).task;
  const second = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual(second.decisions, []);
  assert.deepEqual(second.unresolved, []);
  const { storedStatus, ...recordBefore } = taskBefore; // getTask adds storedStatus to what it reads
  assert.equal(storedStatus, 'done');
  assert.deepEqual(second.task, recordBefore, 'returned as it is');
  assert.equal(second.version.id, first.version.id);
  assert.deepEqual(second.evidence, first.evidence);
  assert.deepEqual((await tasks.getTask(ctx.path, task.id)).task, taskBefore, 'nothing rewritten');
  assert.equal(await fsp.readFile(eventsFile(task.id), 'utf8'), eventsBefore, 'no new event');
  assert.equal((await stored()).length, before + 2);

  // a reopened task can be recorded again, and its decisions still count once
  await tasks.reopenTask(ctx, task.id);
  await tasks.finishTask(ctx, task.id, { summary: 'Decided again', decisions: ['Same call | third reason', 'New call | later'] });
  assert.deepEqual((await tasks.ingestTask(ctx, task.id)).decisions.map((d) => d.text), ['New call']);
  assert.equal((await stored()).length, before + 3);
});

test('finish after a hand commit on a clean tree records that commit and makes no empty one', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { request: 'Commit against the prompt' });
  const original = await fsp.readFile(tuningFile(ctx), 'utf8');
  await fsp.writeFile(tuningFile(ctx), `${original}\n// hand commit\n`);
  const handSha = await git.commitAll(ctx.path, 'by hand');
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Committed by hand' });
  assert.equal(await git.headSha(ctx.path), handSha, 'no commit was added');
  assert.equal(fin.version.sha, handSha);
  assert.equal(fin.version.taskId, task.id);
  assert.deepEqual(fin.version.filesChanged, ['src/tuning.js']);
  assert.deepEqual(fin.result.filesChanged, ['src/tuning.js']);
  assert.equal(fin.result.versionId, fin.version.id);
  assert.equal(fin.result.note, undefined);
  const listed = (await versions.listVersions(ctx.path)).find((v) => v.id === fin.version.id);
  assert.deepEqual(listed.filesChanged, ['src/tuning.js']);
  assert.equal(await git.git(ctx.path, ['rev-parse', `atelier/${fin.version.id}^{commit}`]).then((s) => s.trim()), handSha, 'the version is tagged like any other');
  const ing = await tasks.ingestTask(ctx, task.id);
  assert.deepEqual(ing.evidence.filesChanged, fin.version.filesChanged, 'the version and the evidence agree');

  // commits that net to no change: no version, and still no commit from the finish
  const undone = await tasks.createTask(ctx, { request: 'Change it and change it back' });
  const count = (await versions.listVersions(ctx.path)).length;
  const current = await fsp.readFile(tuningFile(ctx), 'utf8');
  await fsp.writeFile(tuningFile(ctx), `${current}\n// undone\n`);
  await git.commitAll(ctx.path, 'there');
  await fsp.writeFile(tuningFile(ctx), current);
  const backSha = await git.commitAll(ctx.path, 'and back');
  const none = await tasks.finishTask(ctx, undone.id, { summary: 'Back where it was' });
  assert.equal(none.version, null);
  assert.equal(none.result.note, `The files on disk match the task's base, though HEAD moved from ${undone.context.baseSha.slice(0, 8)} to ${backSha.slice(0, 8)} (2 commits apart); nothing was kept as a version.`);
  assert.equal(await git.headSha(ctx.path), backSha);
  assert.equal((await versions.listVersions(ctx.path)).length, count);
});

test('finish after a hand reset to an older commit no version names says HEAD moved, with no version', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const commit = async (text) => {
    await fsp.appendFile(tuningFile(ctx), `\n// ${text}\n`);
    return git.commitAll(ctx.path, text);
  };
  const older = await commit('older');
  const middle = await commit('middle');
  await commit('newer');
  const newest = await commit('newest');
  const count = (await versions.listVersions(ctx.path)).length;
  const finishAfterReset = async (baseSha, target) => {
    const task = await tasks.createTask(ctx, { request: 'Go back by hand' });
    assert.equal(task.context.baseSha, baseSha);
    await git.git(ctx.path, ['reset', '-q', '--hard', target]);
    const fin = await tasks.finishTask(ctx, task.id, { summary: 'Went back' });
    assert.equal(await git.headSha(ctx.path), target, 'the finish adds no commit');
    assert.equal(fin.version, null);
    assert.equal(fin.result.versionId, null);
    assert.equal(fin.result.resultSha, null);
    assert.deepEqual(fin.result.filesChanged, []);
    const events = await fsp.readFile(path.join(ctx.path, '.studio', 'tasks', task.id, 'events.jsonl'), 'utf8');
    assert.ok(events.includes(fin.result.note), 'the finished event says the same');
    assert.equal((await tasks.ingestTask(ctx, task.id)).version, null);
    return fin.result.note;
  };
  assert.equal(await finishAfterReset(newest, middle), `The files on disk differ from the task's base: HEAD moved from ${newest.slice(0, 8)} to ${middle.slice(0, 8)} (2 commits apart); nothing was kept as a version.`);
  assert.equal(await finishAfterReset(middle, older), `The files on disk differ from the task's base: HEAD moved from ${middle.slice(0, 8)} to ${older.slice(0, 8)} (1 commit apart); nothing was kept as a version.`);
  assert.equal((await versions.listVersions(ctx.path)).length, count);
});

test('taskIdFromPath reads tasks/<id>/... with either separator', () => {
  assert.equal(tasks.taskIdFromPath('tasks/t_abc/task.json'), 't_abc');
  assert.equal(tasks.taskIdFromPath('tasks\\t_abc\\result.json'), 't_abc');
  assert.equal(tasks.taskIdFromPath('tasks/t_abc/sub/file.txt'), 't_abc');
  for (const f of ['tasks', 'tasks/t_abc', 'tasks/', 'tasks//x', 'memory/tasks/x.json', 'project.json', '', null, undefined]) assert.equal(tasks.taskIdFromPath(f), null, String(f));
});

test('shortLabel cuts at a word boundary and shows the cut, at most 80 chars', () => {
  assert.equal(tasks.shortLabel('Lower gravity'), 'Lower gravity');
  const long = 'Server: a Chat session can report back on a task (allowed node commands, denials visible, Run with Claude Code here)';
  const l = tasks.shortLabel(long, 80);
  assert.ok(l.length <= 80, l);
  assert.ok(l.endsWith('…'), l);
  const head = l.slice(0, -1);
  assert.ok(long.startsWith(head) && /[\s,;:.]/.test(long[head.length]), `cut at a word end: "${l}"`);
  // one very long word: a hard cut, still within the limit and still marked
  assert.equal(tasks.shortLabel('x'.repeat(100), 80), `${'x'.repeat(79)}…`);
  // text that fits exactly is not cut; a word ending exactly at the limit is kept whole
  assert.equal(tasks.shortLabel('abc def', 7), 'abc def');
  assert.equal(tasks.shortLabel('abc def ghi', 8), 'abc def…');
  // never two ellipses, never punctuation before the mark
  assert.equal(tasks.shortLabel('wait… and then some more', 8), 'wait…');
  assert.equal(tasks.shortLabel('first, second third', 9), 'first…');
  assert.equal(tasks.shortLabel('  a   b  ', 80), 'a b');
});

test('tasks: a title made from the request ends on a word, however long the sentence', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const words = 'Rows should keep their text when the panel is narrow and the list is long and the window is small and nothing else is open at the time';
  const noStop = await tasks.createTask(ctx, { request: words });
  assert.ok(noStop.title.length <= 120, noStop.title);
  assert.ok(noStop.title.endsWith('…'), noStop.title);
  const head = noStop.title.slice(0, -1);
  assert.ok(words.startsWith(`${head} `), `cut at a space: "${noStop.title}"`);
  // a sentence that fits is the whole title, unmarked, even past the old 90-character search
  const sentence = 'Rows should keep their text when the panel is narrow and the list is long and the window is small.';
  const fits = await tasks.createTask(ctx, { request: `${sentence} Then check the rest.` });
  assert.equal(fits.title, sentence);
  // a given title is cut the same way
  const given = await tasks.createTask(ctx, { title: words, request: 'Short request' });
  assert.equal(given.title, noStop.title);
  for (const t of [noStop, fits, given]) await tasks.cancelTask(ctx.path, t.id);
});

test('tasks: the brief carries the task own acceptance; the current piece is context', async () => {
  const ctx = await projects.loadProject(a.project.id);
  assert.equal(ctx.project.currentPiece.title, 'Jump feel');
  const own = await tasks.createTask(ctx, { request: 'Lower the music volume a little', acceptance: ['music is quieter', ''] });
  assert.deepEqual(own.acceptance, ['music is quieter']);
  const b1 = (await tasks.getTask(ctx.path, own.id)).brief;
  const accept = b1.split('## Acceptance conditions\n')[1].split('\n\n')[0];
  assert.equal(accept, '- music is quieter');
  const ctxSection = b1.split('## Current piece (context)\n')[1].split('\n## ')[0];
  assert.match(ctxSection, /- Current piece: Jump feel/);
  assert.match(ctxSection, /- jump height feels right/);
  assert.match(ctxSection, /- Next release: /);
  assert.ok(b1.indexOf('## Project') < b1.indexOf('## Current piece (context)'));
  assert.ok(!b1.includes('## Current piece and next release'));
  // none given: no copy of the current piece, a plain instruction instead
  const bare = await tasks.createTask(ctx, { request: 'Lower the music volume a little' });
  assert.deepEqual(bare.acceptance, []);
  const b2 = (await tasks.getTask(ctx.path, bare.id)).brief;
  assert.equal(b2.split('## Acceptance conditions\n')[1].split('\n\n')[0], '- none stated; verify what the request asks for');
  // the Chat prompt asks for task question instead of guessing
  const prompt = tasks.consolePrompt(bare.id);
  assert.match(prompt, new RegExp('task question ' + bare.id + ' "…"\` and stop; do not guess and do not finish with the question unanswered'));
  assert.match(prompt, /task handover .* task start .* task note .* task finish /);
  // Claude Code's command safety check refuses these, so the prompt says so up front
  assert.ok(prompt.includes('Run one simple command per call in this folder: no cd, no ; or && chains, no shell variables; when a step needs more than one command, write a small script file under the project folder, run it with node <file>, and delete it before you finish, because the finish checkpoint commits every file.'));
  assert.ok(!prompt.includes('node -e'), 'the prompt no longer suggests node -e');
  // node is unrestricted, so staying in the folders is something the prompt asks for
  assert.ok(prompt.includes('Stay inside this project folder and the folders named for this task; do not read files elsewhere.'));
  // the allowed git rules match as typed, so git -C was refused in every session that tried it
  assert.ok(prompt.includes('Run git without -C: the allowed rules match git status, git diff, git log and git show as typed, so git -C <path> is refused.'));
  for (const t of [own, bare]) await tasks.cancelTask(ctx.path, t.id);
});

test('tasks: version named after the title, files from the request, inspiration only as typed', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const title = 'Make the jump feel floatier by slowing the fall a little, keeping the run speed as it is now';
  // the project has an inspiration; a task must not inherit it
  const task = await tasks.createTask({ ...ctx, project: { ...ctx.project, inspiration: 'Project-wide inspiration' } }, { title, request: 'Change src/tuning.js and check src/game.js; see src/tuning.js again.', mode: 'handle' });
  assert.deepEqual(task.context.files, ['src/tuning.js', 'src/game.js']);
  assert.equal(task.inspiration, '');
  const { brief } = await tasks.getTask(ctx.path, task.id);
  assert.match(brief, /## Relevant files\n- src\/tuning\.js\n- src\/game\.js\n/);
  assert.ok(!brief.includes('start from the entry file'));
  assert.ok(!brief.includes('## Inspiration'));
  const plain = await tasks.createTask(ctx, { request: 'Make it nicer', inspiration: 'Celeste dashes', files: ['src/game.js'] });
  assert.equal(plain.inspiration, 'Celeste dashes');
  assert.deepEqual(plain.context.files, ['src/game.js']);
  const none = await tasks.createTask(ctx, { request: 'Make it nicer' });
  assert.ok((await tasks.getTask(ctx.path, none.id)).brief.includes('- start from the entry file'));
  await fsp.writeFile(tuningFile(ctx), (await fsp.readFile(tuningFile(ctx), 'utf8')) + '\n// floatier\n');
  const fin = await tasks.finishTask(ctx, task.id, { summary: 'Gravity 1800 -> 1500 and a longer apex hang; the run speed is unchanged' });
  assert.equal(fin.version.label, tasks.shortLabel(title, 80));
  assert.ok(fin.version.label.endsWith('…'), fin.version.label);
  assert.ok(title.startsWith(fin.version.label.slice(0, -1)));
  assert.match(fin.version.note, /Gravity 1800 -> 1500/);
  for (const t of [plain, none]) await tasks.cancelTask(ctx.path, t.id);
});

test('needs-input: a question pauses the task and the answer lands in the brief', async () => {
  const ctx = await projects.loadProject(a.project.id);
  const task = await tasks.createTask(ctx, { request: 'Add coyote time toggle', mode: 'teach' });
  await tasks.startTask(ctx.path, task.id);
  await tasks.questionTask(ctx.path, task.id, 'Should the toggle be on by default?');
  assert.equal((await tasks.getTask(ctx.path, task.id)).task.status, 'needs-input');
  await tasks.answerTask(ctx.path, task.id, 'Yes, on by default');
  const { task: t, brief } = await tasks.getTask(ctx.path, task.id);
  assert.equal(t.status, 'working', 'a started task goes back to working after an answer');
  assert.ok(brief.includes('Yes, on by default'));
});

test('studio upgrade: registry migration runs forward and keeps data', async () => {
  const migrated = registry.migrate({ schemaVersion: 0, projects: [{ id: 'p_x', name: 'Old', path: 'C:/old', kind: 'game' }] });
  assert.equal(migrated.schemaVersion, registry.SCHEMA_VERSION);
  assert.equal(migrated.projects[0].id, 'p_x');
  assert.ok(migrated.settings.apiUtility.model);
});

test('confinement: file access cannot escape the project or touch .studio', async () => {
  const ctx = await projects.loadProject(a.project.id);
  await assert.rejects(() => projects.readProjectPath(ctx.path, '../atelier/package.json'), (e) => e.code === 'path_outside_project');
  await assert.rejects(() => projects.writeProjectPath(ctx.path, '.studio/project.json', '{}'), (e) => e.code === 'path_forbidden');
  await assert.rejects(() => projects.writeProjectPath(ctx.path, '.git/config', ''), (e) => e.code === 'path_forbidden');
});
