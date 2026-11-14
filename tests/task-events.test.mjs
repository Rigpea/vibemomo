// The real client/components/task-list.js with a stubbed DOM: the Events part of an open task row. No browser is
// involved, so nothing here says how it looks; scripts/ui-check/verify-events.cjs does that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

function el(spec, props, ...children) {
  if (props !== null && props !== undefined && (typeof props !== 'object' || props.isNode || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const n = { isNode: true, spec, kids: [], on: {}, dataset: {}, classList: { contains: () => false }, querySelector: () => null, append(...more) { n.kids.push(...more.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)); } };
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on') && typeof v === 'function') n.on[k.slice(2)] = v;
    else if (v !== false && v !== null && v !== undefined) n[k] = v;
  }
  n.append(...children);
  return n;
}
const stub = () => el('span');
globalThis.__taskList = { el, clear: (n, ...kids) => { n.kids = []; n.append(...kids); return n; }, button: (label, props = {}) => el('button', { onclick: props.onclick }, label), chip: stub, stateChip: stub, ago: () => 'now', when: () => 'then', toast() {}, toastError() {}, dialog() {}, confirmDialog() {}, closeDialogsIn() {}, textarea: stub, field: stub, copyText() {}, loading: stub, empty: stub, shortLabel: (x) => x, markdown: stub };
const source = (await fsp.readFile(new URL('../client/components/task-list.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__taskList;')
  .replace(/import \{ markdown \} from '\.\/markdown\.js';/, 'const { markdown } = globalThis.__taskList;')
  .replace("'./status-words.js'", JSON.stringify(new URL('../client/components/status-words.js', import.meta.url).href))
  // The Activity part has its own test (tests/task-activity.test.mjs): here it draws nothing.
  .replace(/import \{ createActivity \} from '\.\/task-activity\.js';/, 'const createActivity = () => ({ begin() {}, end() {}, node: () => null, destroy() {} });');
const { createTaskList } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
globalThis.requestAnimationFrame = () => {};
const tick = () => new Promise((r) => setImmediate(r));

const walk = (n, out = []) => { if (n?.isNode) { out.push(n); n.kids.forEach((k) => walk(k, out)); } return out; };
const text = (n) => (n?.isNode ? n.kids.map(text).join('') : String(n ?? ''));
const kin = (n, spec) => n.kids.filter((k) => k?.isNode && k.spec === spec);

/** An open row with n notes; returns the list and a reader for its Events part. */
async function openRow(events) {
  const app = { state: { bundle: null, projects: [] }, projectId: () => 'p', api: { task: async () => ({ task: { id: 't', status: 'done', request: 'r', mode: 'teach' }, events, brief: 'b', versionNames: {} }) } };
  const list = createTaskList(app);
  list.render([{ id: 't', title: 'T', status: 'done', updatedAt: 'x' }]);
  list.expand('t');
  await tick();
  const read = () => {
    const outer = walk(list.node).find((n) => n.spec === 'details.more' && text(kin(n, 'summary')[0]).startsWith('Events'));
    const wrap = outer.kids.find((k) => k.spec === 'div');
    const inner = wrap && kin(wrap, 'details.more')[0];
    const rows = (ul) => ul.kids.map((li) => text(li.kids[1]));
    return { outer, inner, summary: text(kin(outer, 'summary')[0]), wrap, earlier: inner ? rows(kin(inner, 'ul.events')[0]) : [], recent: wrap ? rows(kin(wrap, 'ul.events')[0]) : [] };
  };
  return { list, read };
}
const notes = (n) => Array.from({ length: n }, (_, i) => ({ type: 'note', actor: 'claude-code', ts: 't', data: { text: `note ${i + 1}` } }));

/** An open row whose detail is given, with the app's own stubs. */
async function openDetail(detail, row = {}) {
  const app = { state: { bundle: null, projects: [] }, projectId: () => 'p', api: { task: async () => detail } };
  const list = createTaskList(app);
  list.render([{ id: 't', title: 'T', updatedAt: 'x', status: detail.task.status, result: detail.task.result, ...row }]);
  list.expand('t');
  await tick();
  return list;
}
const NAMES = { v_8: '#8 Option A', v_9: '#9 Option B' };
const eventLines = (list) => walk(list.node).filter((n) => n.spec === 'span.events-what').map(text);

test('finished and ingested name every version in order; a single version keeps its label', async () => {
  const result = { summary: 's', versionId: 'v_9', versionIds: ['v_8', 'v_9'] };
  const events = [
    { type: 'finished', actor: 'claude-code', ts: 't', data: { versionId: 'v_9', versionIds: ['v_8', 'v_9'] } },
    { type: 'ingested', actor: 'studio', ts: 't', data: { versionId: 'v_9', versionIds: ['v_8', 'v_9'], commits: 2, files: 1 } },
    { type: 'note', actor: 'x', ts: 't', data: { versionId: 'v_8' } },
  ];
  const list = await openDetail({ task: { id: 't', status: 'done', request: 'r', mode: 'explore', result }, events, brief: 'b', versionNames: NAMES });
  assert.deepEqual(eventLines(list), ['finished · claude-code → #8, #9', 'ingested · studio → #8, #9', 'note · x → #8 Option A']);
});

test('an ingested event from before it recorded versionIds reads the result\'s list', async () => {
  const result = { summary: 's', versionId: 'v_9', versionIds: ['v_8', 'v_9'] };
  const events = [{ type: 'ingested', actor: 'studio', ts: 't', data: { versionId: 'v_9', commits: 1, files: 1 } }];
  const list = await openDetail({ task: { id: 't', status: 'done', request: 'r', mode: 'explore', result }, events, brief: 'b', versionNames: NAMES });
  assert.deepEqual(eventLines(list), ['ingested · studio → #8, #9']);
});

test('a cancelled row: no produced, no Try it or Compare, the result readable with its sentence', async () => {
  const result = { summary: 'What it did before', versionId: 'v_8', versionIds: ['v_8', 'v_9'], versionNumbers: [8, 9] };
  const list = await openDetail({ task: { id: 't', status: 'cancelled', request: 'r', mode: 'handle', result }, events: [], brief: 'b', versionNames: NAMES });
  const nodes = walk(list.node);
  const body = text(list.node);
  assert.ok(!text(nodes.find((n) => n.spec === 'span.task-meta')).includes('produced'));
  assert.ok(body.includes('What it did before'));
  assert.ok(body.includes('Cancelled; the result above was recorded before the cancel.'));
  const labels = nodes.filter((n) => n.spec === 'button').map(text);
  assert.ok(labels.includes('Reopen'), labels);
  assert.ok(!labels.includes('Try it') && !labels.includes('Compare side by side'), labels);
});

/** An open row whose Workbench records what Try it asks of it. */
async function rowWithWorkbench(task, view = 'workbench') {
  const shown = [];
  const went = [];
  const app = {
    state: { bundle: null, projects: [], view },
    projectId: () => 'p',
    go: (to) => went.push(to),
    workbench: { viewVersion: (vid) => shown.push(vid), host: () => null },
    api: { task: async () => ({ task, events: [], brief: 'b', versionNames: NAMES }) },
  };
  const list = createTaskList(app);
  list.render([{ updatedAt: 'x', title: 'T', ...task }]);
  list.expand(task.id);
  await tick();
  const nodes = walk(list.node);
  const buttons = nodes.filter((n) => n.spec === 'button');
  return {
    shown,
    went,
    labels: buttons.map(text),
    meta: text(nodes.find((n) => n.spec === 'span.task-meta')),
    tryIt: () => buttons.find((b) => text(b) === 'Try it').on.click(),
  };
}
const MADE = { summary: 's', versionId: 'v_9', versionIds: ['v_8', 'v_9'], versionNumbers: [8, 9], versionRoles: ['finish', 'finish'] };

test('Try it on a cancelled row with roles makes the same call as on a finished one: the Workbench previews the version', async () => {
  const cancelled = await rowWithWorkbench({ id: 't', status: 'cancelled', request: 'r', mode: 'handle', result: MADE });
  assert.ok(cancelled.meta.includes('produced #8, #9 · cancelled after'), cancelled.meta);
  cancelled.tryIt();
  assert.deepEqual(cancelled.shown, ['v_9']);
  assert.deepEqual(cancelled.went, [], 'already in the Workbench');

  const done = await rowWithWorkbench({ id: 't', status: 'done', request: 'r', mode: 'handle', result: MADE });
  done.tryIt();
  assert.deepEqual(done.shown, cancelled.shown);
  assert.ok(done.labels.includes('Compare side by side'), done.labels);
  assert.ok(!cancelled.labels.includes('Compare side by side'), 'Compare stays on a done row');
  assert.ok(cancelled.labels.includes('Reopen'), cancelled.labels);
});

test('Try it on a cancelled row from another view goes to the Workbench; on an explore task it opens the last option, not the leftover', async () => {
  const away = await rowWithWorkbench({ id: 't', status: 'cancelled', request: 'r', mode: 'handle', result: MADE }, 'tasks');
  away.tryIt();
  assert.deepEqual(away.went, ['workbench']);
  assert.deepEqual(away.shown, ['v_9']);

  const result = { summary: 's', versionId: 'v_10', versionIds: ['v_8', 'v_9', 'v_10'], versionNumbers: [8, 9, 10], versionRoles: ['option', 'option', 'finish'] };
  const explore = await rowWithWorkbench({ id: 't', status: 'cancelled', request: 'r', mode: 'explore', result });
  assert.ok(explore.meta.includes('produced #8, #9 · and a leftover #10 · cancelled after'), explore.meta);
  explore.tryIt();
  assert.deepEqual(explore.shown, ['v_9']);
});

test('a cancelled row without a real role offers no Try it: no list, or the all-null list the server fills on read', async () => {
  const { versionRoles, ...old } = MADE;
  for (const result of [old, { ...old, versionRoles: [null, null] }]) {
    const row = await rowWithWorkbench({ id: 't', status: 'cancelled', request: 'r', mode: 'handle', result });
    assert.ok(!row.labels.includes('Try it'), row.labels);
    assert.ok(!row.meta.includes('produced'), row.meta);
    assert.ok(row.labels.includes('Reopen'), row.labels);
  }
});

test('a row of another project names its versions from the list alone', () => {
  const app = { state: { bundle: null, projects: [] }, projectId: () => 'p', api: {} };
  const list = createTaskList(app, { allProjects: true });
  list.render([{ id: 't', title: 'T', status: 'done', updatedAt: 'x', projectId: 'other', projectName: 'Other', result: { versionId: 'v_9', versionIds: ['v_8', 'v_9'], versionNumbers: [8, 9] } }]);
  assert.ok(text(walk(list.node).find((n) => n.spec === 'span.task-meta')).includes('produced #8, #9'));
});

test('a leftover: the row names it apart, and one option leaves nothing to compare', async () => {
  const result = { summary: 's', versionId: 'v_9', versionIds: ['v_8', 'v_9'], versionNumbers: [8, 9], versionRoles: ['option', 'finish'] };
  const list = await openDetail({ task: { id: 't', status: 'review', request: 'r', mode: 'explore', result }, events: [], brief: 'b', versionNames: NAMES }, { mode: 'explore' });
  const nodes = walk(list.node);
  assert.ok(text(nodes.find((n) => n.spec === 'span.task-meta')).includes('produced #8 · and a leftover #9'));
  const labels = nodes.filter((n) => n.spec === 'button').map(text);
  assert.ok(labels.includes('Try it'), labels);
  assert.ok(!labels.includes('Compare side by side'), labels);
});

test('a base moved line says it once, in new records and in the ones written before', async () => {
  const events = [
    { type: 'base_moved', actor: 'studio', ts: 't', data: { text: 'to #8, the version at handover' } },
    { type: 'base_moved', actor: 'studio', ts: 't', data: { text: 'base moved to #9' } },
    { type: 'note', actor: 'x', ts: 't', data: { text: 'base moved to #9' } },
  ];
  const list = await openDetail({ task: { id: 't', status: 'done', request: 'r', mode: 'handle' }, events, brief: 'b', versionNames: {} });
  assert.deepEqual(eventLines(list), ['base moved · studio — to #8, the version at handover', 'base moved · studio — to #9', 'note · x — base moved to #9']);
});

test('15 events: all there oldest first, the first 3 behind a closed "3 earlier" above the last 12', async () => {
  const { read } = await openRow(notes(15));
  const { summary, inner, wrap, earlier, recent } = read();
  assert.equal(summary, 'Events · 15');
  assert.equal(text(kin(inner, 'summary')[0]), '3 earlier');
  assert.ok(!inner.open);
  assert.equal(wrap.kids.indexOf(inner), 0, 'the disclosure comes first');
  assert.deepEqual(earlier.map((x) => x.split('— ')[1]), ['note 1', 'note 2', 'note 3']);
  assert.equal(recent.length, 12);
  assert.equal(recent[0].split('— ')[1], 'note 4');
  assert.equal(recent[11].split('— ')[1], 'note 15');
});

test('12 events: no disclosure', async () => {
  const { read } = await openRow(notes(12));
  assert.equal(read().inner, undefined);
  assert.equal(read().recent.length, 12);
});

test('a long note keeps its full text and its time keeps its own column', async () => {
  const long = `start\n${'word '.repeat(2000)}end`;
  const { read } = await openRow([{ type: 'note', actor: 'claude-code', ts: 't', data: { text: long } }]);
  assert.equal(read().recent[0], `note · claude-code — ${long}`);
  const li = kin(read().wrap, 'ul.events')[0].kids[0];
  assert.equal(li.kids[0].spec, 'span.events-when');
});

test('a note arriving at an open row lands last, with Events and "n earlier" still open', async () => {
  const events = notes(15);
  const { list, read } = await openRow(events);
  read().outer.on.toggle({ target: { open: true } });
  read().inner.on.toggle({ target: { open: true } });
  events.push({ type: 'note', actor: 'claude-code', ts: 't', data: { text: 'arrived while reading' } });
  list.invalidate('t'); // what client/views/tasks.js does on task.changed
  await tick();
  const seen = read();
  assert.equal(seen.summary, 'Events · 16');
  assert.equal(seen.recent.at(-1).split('— ')[1], 'arrived while reading');
  assert.equal(seen.outer.open, true);
  assert.equal(seen.inner.open, true);
});

test('a redraw keeps Events and "n earlier" as the person left them', async () => {
  const { list, read } = await openRow(notes(15));
  const set = (node, open) => node.on.toggle({ target: { open } });
  set(read().outer, true);
  set(read().inner, true);
  list.invalidate('t');
  await tick();
  assert.equal(read().outer.open, true);
  assert.equal(read().inner.open, true);
  set(read().inner, false);
  list.invalidate('t');
  await tick();
  assert.equal(read().outer.open, true);
  assert.ok(!read().inner.open);
});
