// Skills by department: client/components/skill-departments.js on its own (the many-to-many map and its ops, the
// suggestion for a skill no department holds, the groups, the filter, the worker's paragraph), then the server side on
// temp folders: the map kept in the registry (one op at a time), a task created with a department, its brief, and the
// first message a worker gets, naming the department's skills with their descriptions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import * as d from '../client/components/skill-departments.js';
import { categoryOf } from '../client/components/skill-words.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-depts-'));
process.env.ATELIER_DATA_DIR = path.join(root, 'data');
process.env.ATELIER_PROJECTS_DIR = path.join(root, 'projects');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
after(() => fsp.rm(root, { recursive: true, force: true }).catch(() => {}));

// The server modules are imported here, before the first test is registered, not between the pure tests and the server
// ones: node --test runs a top-level after() as soon as the tests registered so far have finished, so tests registered
// after a top-level await ran once the hook above had removed their temp folder, or while Windows was still removing
// it (ENOENT or EPERM on the registry's first write: 2 of 2 full runs on 2026-11-11, 2 of about 16 solo runs before;
// docs/DECISIONS.md row 145).
const projects = await import('../server/lib/projects.mjs');
const versions = await import('../server/lib/versions.mjs');
const briefing = await import('../server/lib/briefing.mjs');
const tasks = await import('../server/lib/tasks.mjs');
const departments = await import('../server/lib/departments.mjs');
const registry = await import('../server/lib/registry.mjs');
const { createWorkers } = await import('../server/lib/workers.mjs');

const skill = (name, description, extra = {}) => ({ name, description, path: `/s/${name}`, source: { kind: 'user' }, ...categoryOf({ name, description, ...extra }), ...extra });

// ---------- the pure parts ----------
test('nothing stored gives the six starting departments, empty; a stored list is cleaned, not replaced', () => {
  const start = d.normalizeDepartments(undefined);
  assert.deepEqual(start.map((x) => x.name), ['Design', 'UX', 'Frontend', 'Backend', 'QA and review', 'Docs and writing']);
  assert.ok(start.every((x) => Array.isArray(x.skills) && !x.skills.length));
  assert.deepEqual(d.normalizeDepartments([]), [], 'an emptied list stays empty: the person removed them all');
  assert.deepEqual(d.normalizeDepartments([{ id: 'a', name: '  Sound\n design ', skills: ['x', 'x', '', 3] }, { id: 'a', name: 'Dup' }, { name: 'no id' }, null]),
    [{ id: 'a', name: 'Sound design', skills: ['x', '3'] }]);
});

test('the map is many-to-many: one skill in several departments, each department its own set', () => {
  let list = d.normalizeDepartments(undefined);
  list = d.applyDepartmentOp(list, { action: 'place', id: 'design', skill: 'dataviz', member: true });
  list = d.applyDepartmentOp(list, { action: 'place', id: 'frontend', skill: 'dataviz', member: true });
  list = d.applyDepartmentOp(list, { action: 'place', id: 'frontend', skill: 'react-kit', member: true });
  list = d.applyDepartmentOp(list, { action: 'place', id: 'design', skill: 'dataviz', member: true });
  assert.deepEqual(d.departmentsOf(list, 'dataviz').map((x) => x.id), ['design', 'frontend']);
  assert.deepEqual(list.find((x) => x.id === 'frontend').skills, ['dataviz', 'react-kit']);
  assert.deepEqual(list.find((x) => x.id === 'design').skills, ['dataviz'], 'placing twice keeps one entry');
  const out = d.applyDepartmentOp(list, { action: 'place', id: 'design', skill: 'dataviz', member: false });
  assert.deepEqual(d.departmentsOf(out, 'dataviz').map((x) => x.id), ['frontend'], 'taken out of one, still in the other');
  assert.deepEqual(d.departmentsOf(list, 'dataviz').map((x) => x.id), ['design', 'frontend'], 'the old list is not touched');
});

test('add, rename and remove; names unique in any case; refusals carry a code', () => {
  let list = d.normalizeDepartments(undefined);
  list = d.applyDepartmentOp(list, { action: 'add', name: 'Sound' });
  list = d.applyDepartmentOp(list, { action: 'add', name: 'Sound  FX' });
  assert.deepEqual(list.slice(-2).map((x) => [x.id, x.name]), [['sound', 'Sound'], ['sound-fx', 'Sound FX']]);
  list = d.applyDepartmentOp(list, { action: 'place', id: 'qa', skill: 'code-review', member: true });
  list = d.applyDepartmentOp(list, { action: 'rename', id: 'qa', name: 'Review' });
  assert.deepEqual(list.find((x) => x.id === 'qa'), { id: 'qa', name: 'Review', skills: ['code-review'] }, 'a rename keeps the id and the skills');
  assert.equal(d.applyDepartmentOp(list, { action: 'rename', id: 'qa', name: 'review' }).find((x) => x.id === 'qa').name, 'review', 'a department may change its own case');
  const code = (op) => { try { d.applyDepartmentOp(list, op); return 'ok'; } catch (err) { return err.code; } };
  assert.equal(code({ action: 'add', name: 'design' }), 'name_taken');
  assert.equal(code({ action: 'rename', id: 'ux', name: 'SOUND' }), 'name_taken');
  assert.equal(code({ action: 'add', name: '   ' }), 'invalid_input');
  assert.equal(code({ action: 'add', name: 'x'.repeat(d.NAME_MAX + 1) }), 'invalid_input');
  assert.equal(code({ action: 'remove', id: 'nope' }), 'not_found');
  assert.equal(code({ action: 'place', id: 'ux', skill: 'a' }), 'invalid_input', 'member must be said');
  assert.equal(code({ action: 'drop' }), 'invalid_input');
  list = d.applyDepartmentOp(list, { action: 'remove', id: 'qa' });
  assert.equal(d.departmentsOf(list, 'code-review').length, 0, 'removing a department unplaces what only it held');
  assert.equal(d.departmentId('Design', list), 'design-2', 'a new id never takes one in use');
});

test('the suggestion: from the skill\'s own category, only for unplaced skills, gone when its department is', () => {
  let list = d.normalizeDepartments(undefined);
  assert.equal(d.suggestDepartment(skill('dataviz', 'Charts, colour and typography'), list)?.id, 'design');
  assert.equal(d.suggestDepartment(skill('code-review', 'Review the diff for bugs'), list)?.id, 'qa');
  assert.equal(d.suggestDepartment(skill('postgres-helper', 'Database schema and SQL'), list)?.id, 'backend');
  assert.equal(d.suggestDepartment(skill('zzz', 'Nothing in particular'), list), null, 'Other suggests nothing');
  list = d.applyDepartmentOp(list, { action: 'rename', id: 'design', name: 'Visual' });
  assert.equal(d.suggestDepartment(skill('dataviz', 'Charts'), list)?.name, 'Visual', 'a renamed starting department still gets its category');
  list = d.applyDepartmentOp(list, { action: 'add', name: 'Design' });
  assert.equal(d.suggestDepartment(skill('dataviz', 'Charts'), list)?.id, 'design-2', 'a department named like the category wins');
  list = d.applyDepartmentOp(d.normalizeDepartments(undefined), { action: 'remove', id: 'design' });
  assert.equal(d.suggestDepartment(skill('dataviz', 'Charts'), list), null, 'its department removed: no suggestion');

  const skills = [skill('dataviz', 'Charts and colour'), skill('react-kit', 'React components'), skill('docx', 'Word documents')];
  let map = d.normalizeDepartments(undefined);
  map = d.applyDepartmentOp(map, { action: 'place', id: 'design', skill: 'dataviz', member: true });
  map = d.applyDepartmentOp(map, { action: 'place', id: 'frontend', skill: 'dataviz', member: true });
  const { groups, unplaced } = d.groupByDepartment(skills, map);
  assert.deepEqual(groups.map((g) => [g.department.id, g.skills.map((s) => s.name)]),
    [['design', ['dataviz']], ['ux', []], ['frontend', ['dataviz']], ['backend', []], ['qa', []], ['docs', []]], 'a shared skill under each of its departments; empty ones kept');
  assert.deepEqual(unplaced.map((u) => [u.skill.name, u.suggested?.id]), [['docx', 'docs'], ['react-kit', 'frontend']], 'unplaced, by name, each with its suggestion');
  assert.deepEqual(d.filterByWords(skills, map, 'frontend').map((s) => s.name), ['dataviz', 'react-kit'], 'the filter reads departments and suggestions');
  assert.deepEqual(d.filterByWords(skills, map, 'docs word').map((s) => s.name), ['docx']);
});

test('Place all: several skills placed in one op, each once; the Unplaced folder sorted by suggestion', () => {
  let list = d.normalizeDepartments(undefined);
  list = d.applyDepartmentOp(list, { action: 'place', id: 'design', skill: 'dataviz', member: true });
  list = d.applyDepartmentOp(list, { action: 'place', id: 'design', skills: ['dataviz', 'palette', 'palette', ' tone '], member: true });
  assert.deepEqual(list.find((x) => x.id === 'design').skills, ['dataviz', 'palette', 'tone'], 'no name twice, the old ones kept first');
  list = d.applyDepartmentOp(list, { action: 'place', id: 'design', skills: ['dataviz', 'tone'], member: false });
  assert.deepEqual(list.find((x) => x.id === 'design').skills, ['palette']);
  const code = (op) => { try { d.applyDepartmentOp(list, op); return 'ok'; } catch (err) { return err.code; } };
  assert.equal(code({ action: 'place', id: 'design', skills: [], member: true }), 'invalid_input');
  assert.equal(code({ action: 'place', id: 'design', skills: ['ok', ''], member: true }), 'invalid_input', 'one bad name refuses the whole op');

  const skills = [skill('dataviz', 'Charts and colour'), skill('palette', 'Colour palettes'), skill('react-kit', 'React components'), skill('zzz', 'Nothing in particular')];
  const { unplaced } = d.groupByDepartment(skills, d.normalizeDepartments(undefined));
  assert.deepEqual(d.unplacedBySuggestion(unplaced, d.normalizeDepartments(undefined)).map((g) => [g.department?.id ?? null, g.skills.map((s) => s.name)]),
    [['design', ['dataviz', 'palette']], ['frontend', ['react-kit']], [null, ['zzz']]], 'in the departments\' order, then the skills with none');
});

test('the worker\'s paragraph names the department and lists its skills with their descriptions', () => {
  const text = d.departmentPrompt({ name: 'Design', found: [{ name: 'dataviz', description: 'Charts that read as one system.' }, { name: 'tone', description: '' }], missing: ['gone-skill'] });
  assert.match(text, /^Department: Design\. This task belongs to the studio's Design department\. Its skills are:\n- dataviz: Charts that read as one system\.\n- tone: no description written\.\n/);
  assert.match(text, /Use these skills for this work/);
  assert.match(text, /Every installed skill stays available/, 'it guides rather than hides');
  assert.match(text, /not installed where this project's sessions can see them: gone-skill\./);
  assert.match(d.departmentPrompt({ name: 'UX' }), /has no skills placed yet/);
  assert.match(d.departmentPrompt({ name: 'UX', gone: true }), /has since been removed/);
});

// ---------- the server: the registry, a task with a department, the worker's first message ----------
async function writeSkill(dir, name, description) {
  await fsp.mkdir(path.join(dir, name), { recursive: true });
  await fsp.writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it.\n`);
}

test('the map lives in the registry\'s settings; quick ops in a row all land', async () => {
  assert.equal((await departments.loadDepartments()).length, 6);
  await Promise.all(['a', 'b', 'c', 'd'].map((s) => departments.changeDepartments({ action: 'place', id: 'design', skill: s, member: true })));
  const reg = await registry.loadRegistry();
  assert.deepEqual(reg.settings.skillDepartments.find((x) => x.id === 'design').skills.sort(), ['a', 'b', 'c', 'd'], 'no op overwrote another');
  await assert.rejects(departments.changeDepartments({ action: 'add', name: 'design' }), (err) => err.status === 409 && err.code === 'name_taken');
  await assert.rejects(departments.changeDepartments({ action: 'remove', id: 'zz' }), (err) => err.status === 404);
  await departments.changeDepartments({ action: 'place', id: 'design', skill: 'c', member: false });
  await departments.changeDepartments({ action: 'place', id: 'design', skill: 'd', member: false });
  assert.deepEqual((await departments.loadDepartments()).find((x) => x.id === 'design').skills.sort(), ['a', 'b']);
});

test('a task carries its department; the brief and the worker\'s first message name its skills', async () => {
  await fsp.mkdir(process.env.ATELIER_PROJECTS_DIR, { recursive: true });
  const deps = { checkpoint: (ctx, o) => versions.checkpoint(ctx, o), adoptHead: (ctx, o) => versions.adoptHead(ctx, o), regenerate: (id) => briefing.regenerate(id) };
  const made = await projects.createProject({ name: 'Dept Room', kind: 'web-app' }, deps);
  const ctx = await projects.loadProject(made.project.id);
  await writeSkill(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills'), 'dataviz', 'Charts that read as one system, in light and dark.');
  await writeSkill(path.join(ctx.path, '.claude', 'skills'), 'tone-check', 'Check contrast against the design tokens.');
  await writeSkill(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills'), 'docx', 'Word documents.');
  for (const s of ['dataviz', 'tone-check', 'not-here']) await departments.changeDepartments({ action: 'place', id: 'ux', skill: s, member: true });

  const task = await tasks.createTask(ctx, { request: 'Make the empty state friendlier.', department: 'ux' });
  assert.deepEqual(task.department, { id: 'ux', name: 'UX' });
  assert.deepEqual((await tasks.createTask(ctx, { request: 'By name.', department: 'ux' })).department, { id: 'ux', name: 'UX' });
  assert.deepEqual((await tasks.createTask(ctx, { request: 'Any case.', department: 'qa AND review' })).department, { id: 'qa', name: 'QA and review' });
  assert.equal((await tasks.createTask(ctx, { request: 'None.' })).department, undefined);
  await assert.rejects(tasks.createTask(ctx, { request: 'Unknown.', department: 'Marketing' }), (err) => err.status === 400 && /No department named Marketing/.test(err.message));

  const { brief } = await tasks.getTask(ctx.path, task.id);
  assert.match(brief, /^Department: \*\*UX\*\*$/m);
  assert.match(brief, /## Department\nDepartment: UX\. .*Its skills are:\n- dataviz: Charts that read as one system, in light and dark\.\n- tone-check: Check contrast/s);
  assert.ok(!brief.includes('- docx'), 'a skill of another department is not listed');

  // The worker: its first message is the task prompt, then the department's paragraph.
  const sent = [];
  const consoleSvc = { createSession: async (o) => ({ id: 'cs_w', ...o }), send: async (id, { text }) => { sent.push({ id, text }); return { runId: 'cr_1' }; } };
  const workers = createWorkers({ consoleSvc, tasks, loadProject: () => projects.loadProject(made.project.id) });
  await workers.start(made.project.id, task.id);
  const first = sent[0].text;
  assert.ok(first.startsWith(`Work on studio task ${task.id}`), 'the task prompt comes first');
  assert.match(first, /\n\nDepartment: UX\. This task belongs to the studio's UX department\. Its skills are:\n- dataviz: Charts that read as one system, in light and dark\.\n- tone-check: Check contrast against the design tokens\.\nUse these skills for this work/);
  assert.match(first, /not installed where this project's sessions can see them: not-here\./);

  // Renamed later: the worker reads the department by its id, under its new name; removed: it is told so.
  await departments.changeDepartments({ action: 'rename', id: 'ux', name: 'Experience' });
  assert.match(await tasks.departmentParagraph(ctx.path, task), /^Department: Experience\./);
  await departments.changeDepartments({ action: 'remove', id: 'ux' });
  assert.match(await tasks.departmentParagraph(ctx.path, task), /department UX, which has since been removed/);
  assert.equal(await tasks.departmentParagraph(ctx.path, { id: 't_x' }), '', 'no department, no paragraph');
});
