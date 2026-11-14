// The real client/components/task-list.js, task-activity.js, transcript.js, transcript-match.js and companion-words.js
// on a stub DOM: a task row's Activity (who runs it, the intent, the state line, the session's tool calls as
// time · verb · file rows), its live growth from the app's 'console' topic, and the failed read with Retry.
// No browser is involved; scripts/ui-check/verify-task-activity.cjs looks at the real Task tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

// ---------- a stub DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { spec, tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, title: '' });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: () => {} };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, e = {}) { const ev = { preventDefault() {}, target: this, ...e }; for (const fn of this.listeners[type] || []) fn(ev); }
  append(...more) { this.kids.push(...flatten(more).map((c) => (c instanceof N ? c : String(c)))); }
  querySelector() { return null; }
  focus() {}
}
function el(spec, props, ...children) {
  if (props === null || props === undefined || props instanceof N || typeof props !== 'object' || Array.isArray(props)) { children.unshift(props); props = null; }
  const node = new N(spec);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('aria') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c)));
  return node;
}
const stub = () => el('span');
const ui = {
  el,
  clear: (n, ...kids) => { n.kids = flatten(kids).map((c) => (c instanceof N ? c : String(c))); return n; },
  button: (label, props = {}) => el('button', { onclick: props.onclick }, label),
  chip: stub,
  stateChip: (text, tone, title) => el(`span.chip.tone-${tone}`, { title }, text),
  ago: () => 'now', when: () => 'then', toast() {}, toastError() {}, dialog() {}, confirmDialog() {}, closeDialogsIn() {},
  textarea: stub, field: stub, copyText() {}, loading: stub, empty: stub, shortLabel: (x) => x,
};
globalThis.__ui = ui;
globalThis.__md = { markdown: (text) => el('div.md', text) };
globalThis.requestAnimationFrame = () => {};
const href = (p) => JSON.stringify(new URL(p, import.meta.url).href);

const transcriptSource = (await fsp.readFile(new URL('../client/components/transcript.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/markdown\.js';/, 'const {$1} = globalThis.__md;')
  .replace("'./transcript-match.js'", href('../client/components/transcript-match.js'));
globalThis.__transcript = await import(`data:text/javascript,${encodeURIComponent(transcriptSource)}`);
const activitySource = (await fsp.readFile(new URL('../client/components/task-activity.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/transcript\.js';/, 'const {$1} = globalThis.__transcript;')
  .replace("'./transcript-match.js'", href('../client/components/transcript-match.js'))
  .replace("'./companion-words.js'", href('../client/components/companion-words.js'))
  .replace("'./source-words.js'", href('../client/components/source-words.js'));
globalThis.__activity = await import(`data:text/javascript,${encodeURIComponent(activitySource)}`);
const listSource = (await fsp.readFile(new URL('../client/components/task-list.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{ markdown \} from '\.\/markdown\.js';/, 'const { markdown } = globalThis.__md;')
  .replace("'./status-words.js'", href('../client/components/status-words.js'))
  .replace(/import \{([^}]*)\} from '\.\/task-activity\.js';/, 'const {$1} = globalThis.__activity;');
const { createTaskList, departmentWords } = await import(`data:text/javascript,${encodeURIComponent(listSource)}`);
const { TERMINAL_LINE } = globalThis.__activity;

const tick = () => new Promise((r) => setImmediate(r));
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const text = (n) => (n instanceof N ? (n.hidden ? '' : n.kids.map(text).join('')) : String(n ?? ''));
const bySpec = (root, spec) => all(root).filter((n) => n.spec === spec);

// ---------- the studio around it ----------
const AT = '2026-11-07T10:00:00.000Z';
const STORED = {
  id: 'cs_one', backend: 'claude-code', model: 'claude-opus-5-5', status: 'idle', taskId: 't_a', title: 'Task t_a',
  turns: [
    { role: 'user', text: 'go', at: AT },
    { role: 'assistant', text: 'Read the copy.', at: '2026-11-07T10:00:30.000Z', events: [
      { kind: 'tool', id: 'u1', name: 'Read', summary: 'client/copy.mjs', ms: 4000 },
      { kind: 'tool-result', id: 'u1', name: 'Read', ok: true, summary: '120 lines', detail: 'export const COPY = {\n  hello: "hi",\n};' },
      { kind: 'status', name: 'status', summary: 'thinking' },
    ] },
    { role: 'user', text: 'and now?', at: '2026-11-07T10:01:00.000Z' },
    { role: 'assistant', text: 'Done.', at: '2026-11-07T10:01:40.000Z', events: [
      { kind: 'tool', id: 'u2', name: 'Grep', summary: 'spacing', ms: 19000 },
      { kind: 'tool', id: 'u3', name: 'Edit', summary: 'client/theme.ts', ms: 23000 },
      { kind: 'tool-result', id: 'u3', name: 'Edit', ok: true, summary: 'edited' },
    ] },
  ],
};

/** A list with the app's own pieces: console events go through app.on, sessions come from the given map. */
function studio({ sessions = {}, listed = [], fail = null, openSource = undefined, projects = [] } = {}) {
  const subs = new Set();
  const reads = [];
  const app = {
    state: { bundle: null, projects },
    projectId: () => 'p',
    openSource,
    on: (topic, fn) => { assert.equal(topic, 'console'); subs.add(fn); return () => subs.delete(fn); },
    api: {
      task: async () => ({ task: { id: 't_a', status: 'working', request: 'r', mode: 'handle' }, events: [], brief: 'b', versionNames: {} }),
      consoleSessions: async () => listed,
      consoleGet: async (id) => { reads.push(id); if (fail?.()) throw new Error('session file unreadable'); return { session: structuredClone(sessions[id]) }; },
    },
  };
  const list = createTaskList(app);
  const emit = (name, data) => subs.forEach((fn) => fn({ name, data }));
  return { app, list, emit, reads, subs };
}
const handed = (sid) => ({ type: 'handed_to_console', actor: 'studio', ts: AT, data: { sessionId: sid } });
const row = (list, tid) => all(list.node).find((n) => n.spec === 'article.task' && n.dataset.tid === tid);
const activityOf = (list, tid) => bySpec(row(list, tid), 'details.more.task-activity')[0];
const open = (d) => { d.open = true; d.fire('toggle', { target: d }); };
const rowLines = (d) => bySpec(d, 'div.turn-events.traj')[0]?.kids.filter((k) => !k.classes.has('tool-result') && k.tag !== 'pre').map(text) || [];
const stateLine = (d) => text(bySpec(d, 'div.activity-state')[0]).replace(/\s+/g, ' ').trim();

test('intentLine: the request\'s first sentence when it says more than the title; nothing when it is the title or there is no request', async () => {
  const { intentLine, firstSentenceOf } = globalThis.__activity;
  assert.equal(intentLine, (await import('../client/components/companion-words.js')).intentLine, 'the same helper the server puts on task summaries');
  assert.equal(firstSentenceOf('Give the header room. Then the footer.'), 'Give the header room.');
  assert.equal(firstSentenceOf('Keep v1.2 as it is\nMore below'), 'Keep v1.2 as it is', 'a dot inside a word does not end the sentence; the first line does');
  assert.equal(firstSentenceOf('Why is it slow? Look at the loop.'), 'Why is it slow?');
  assert.equal(intentLine({ title: 'Give the header room', request: 'Give the header room. The case screen is cramped.' }), null, 'the title made from the request');
  assert.equal(intentLine({ title: 'Give the header room', request: 'give the header room!' }), null, 'case and end marks aside');
  assert.equal(intentLine({ title: 'Give the header room' }), null, 'a list row without the request');
  assert.equal(intentLine({ title: 'Case header spacing', request: 'Give the case screen\'s header room to breathe.\nSee pin 1.' }), 'Give the case screen\'s header room to breathe.');
  const long = `${'Very '.repeat(30)}long first sentence that the title cut.`;
  assert.equal(intentLine({ title: `${long.slice(0, 117)}…`, request: long }), long, 'a cut title: the whole sentence shows');
});

test('a stored session: who runs it, the intent, the state, three rows timed from the run and a result that opens', async () => {
  const { list, reads } = studio({ sessions: { cs_one: STORED } });
  list.render([{ id: 't_a', title: 'Give the header room', status: 'review', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  const d = activityOf(list, 't_a');
  assert.equal(text(bySpec(d, 'summary')[0]), 'Activity', 'not read yet: no number claimed');
  assert.ok(!d.open, 'closed by default');
  assert.deepEqual(reads, [], 'nothing is read before the line is opened');
  open(d);
  await tick();
  const now = activityOf(list, 't_a');
  assert.equal(text(bySpec(now, 'summary')[0]), 'Activity · 3 tool calls');
  assert.equal(text(bySpec(now, 'p.meta.activity-who')[0]), 'Claude Code · Opus 5.5 · your login');
  assert.equal(bySpec(now, 'p.activity-intent').length, 0, 'the title is the intent here: no line repeats it');
  list.render([{ id: 't_a', title: 'Give the header room', intent: 'The h1 sits on the subtitle.', status: 'review', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  assert.equal(text(bySpec(activityOf(list, 't_a'), 'p.activity-intent')[0]), 'The h1 sits on the subtitle.', 'a bundle summary\'s intent from the server');
  list.render([{ id: 't_a', title: 'Give the header room', intent: null, request: 'Not read: the summary says null', status: 'review', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  assert.equal(bySpec(activityOf(list, 't_a'), 'p.activity-intent').length, 0, 'a summary\'s null is the answer');
  list.render([{ id: 't_a', title: 'Give the header room', status: 'review', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  assert.match(stateLine(now), /^Done · /);
  assert.deepEqual(rowLines(now), ['00:04 · Read · copy.mjs', '00:19 · Search · “spacing”', '00:23 · Edit · theme.ts'], 'a pattern is quoted, so it does not read as a file');
  const line = bySpec(now, 'div.tool-result.disclosure')[0];
  const pre = bySpec(now, 'pre.tool-detail')[0];
  assert.equal(pre.hidden, true);
  line.fire('click');
  assert.equal(pre.hidden, false);
  assert.ok(text(pre).includes('hello: "hi"'), 'the full result');
  // A redraw keeps the Activity open and the result open.
  list.render([{ id: 't_a', title: 'Give the header room', status: 'review', updatedAt: 'y', lastEvent: handed('cs_one') }]);
  const again = activityOf(list, 't_a');
  assert.ok(again.open);
  assert.equal(bySpec(again, 'pre.tool-detail')[0].hidden, false);
  list.destroy();
});

test('no session, no Activity line; a terminal handover says the studio cannot see it', () => {
  const { list } = studio();
  list.render([
    { id: 't_a', title: 'A', status: 'ready', updatedAt: 'x' },
    { id: 't_b', title: 'B', status: 'working', updatedAt: 'x', lastEvent: { type: 'opened', actor: 'studio', ts: AT, data: { launched: true } } },
  ]);
  assert.equal(activityOf(list, 't_a'), undefined);
  assert.ok(!text(row(list, 't_a')).includes('Activity'));
  assert.equal(activityOf(list, 't_b'), undefined);
  assert.equal(text(bySpec(row(list, 't_b'), 'p.meta.task-activity-none')[0]), TERMINAL_LINE);
  list.destroy();
});

test('a listed session with no turns: no tool calls yet, Idle · not started', async () => {
  const { list } = studio({ sessions: { cs_new: { id: 'cs_new', model: 'claude-opus-5-5', status: 'idle', taskId: 't_a', turns: [] } }, listed: [{ id: 'cs_new', taskId: 't_a', status: 'idle' }] });
  list.render([{ id: 't_a', title: 'A', status: 'ready', updatedAt: 'x' }]);
  await tick(); // the sessions list arrives and the list redraws
  const d = activityOf(list, 't_a');
  open(d);
  await tick();
  const now = activityOf(list, 't_a');
  assert.equal(text(bySpec(now, 'summary')[0]), 'Activity · no tool calls yet');
  assert.equal(stateLine(now), 'Idle · not started');
  list.destroy();
});

test('live: a chunk adds a row and the state reads Working; another session changes nothing; done settles to Done', async () => {
  const running = { ...structuredClone(STORED), status: 'running', turns: [...STORED.turns, { role: 'user', text: 'more', at: new Date(Date.now() - 3000).toISOString() }] };
  const sessions = { cs_one: running };
  const { list, emit, reads } = studio({ sessions, listed: [{ id: 'cs_one', taskId: 't_a', status: 'running' }] });
  const task = { id: 't_a', title: 'A', status: 'working', updatedAt: 'x', lastEvent: handed('cs_one') };
  list.render([task]);
  await tick();
  await tick();
  let d = activityOf(list, 't_a');
  assert.ok(d.open, 'a running session opens by itself');
  assert.deepEqual(reads, ['cs_one'], 'read at once, once');
  assert.match(stateLine(d), /^Working · 00:0\d · thinking$/);

  emit('console.chunk', { sessionId: 'cs_one', kind: 'tool', id: 'u9', name: 'Read', summary: 'client/copy.mjs', ms: 2000 });
  d = activityOf(list, 't_a');
  assert.equal(rowLines(d).at(-1), '00:02 · Read · copy.mjs');
  assert.match(stateLine(d), /^Working · 00:0\d · Read copy\.mjs$/);
  assert.equal(text(bySpec(d, 'summary')[0]), 'Activity · 4 tool calls');

  emit('console.chunk', { sessionId: 'cs_one', kind: 'tool-result', id: 'u9', name: 'Read', ok: true, summary: '12 lines', detail: 'the whole file' });
  const line = bySpec(d, 'div.tool-result.disclosure').at(-1);
  line.fire('click');
  emit('console.chunk', { sessionId: 'cs_other', kind: 'tool', id: 'x', name: 'Write', summary: 'elsewhere.js', ms: 1 });
  assert.equal(text(bySpec(d, 'summary')[0]), 'Activity · 4 tool calls', 'another session changes nothing');
  emit('console.chunk', { sessionId: 'cs_one', kind: 'tool', id: 'u10', name: 'Edit', summary: 'client/copy.mjs', ms: 5000 });
  assert.equal(bySpec(d, 'pre.tool-detail').find((p) => text(p) === 'the whole file').hidden, false, 'an opened result stays open across the redraw');
  assert.deepEqual(reads, ['cs_one'], 'no fetch per chunk');

  // The run ends: the record now holds the turn, and is read once more.
  sessions.cs_one = { ...running, status: 'idle', turns: [...running.turns, { role: 'assistant', text: 'All set.', at: new Date().toISOString(), events: [
    { kind: 'tool', id: 'u9', name: 'Read', summary: 'client/copy.mjs', ms: 2000 },
    { kind: 'tool-result', id: 'u9', name: 'Read', ok: true, summary: '12 lines', detail: 'the whole file' },
    { kind: 'tool', id: 'u10', name: 'Edit', summary: 'client/copy.mjs', ms: 5000 },
  ] }] };
  emit('console.done', { sessionId: 'cs_one' });
  await tick();
  assert.deepEqual(reads, ['cs_one', 'cs_one']);
  d = activityOf(list, 't_a');
  assert.equal(stateLine(d), 'Done · just now');
  assert.equal(text(bySpec(d, 'summary')[0]), 'Activity · 5 tool calls');
  assert.equal(bySpec(d, 'pre.tool-detail').find((p) => text(p) === 'the whole file').hidden, false, 'still open after the record is read again');
  list.destroy();
});

test('a question at the end reads Needs you with its first words', async () => {
  const asks = structuredClone(STORED);
  asks.turns.at(-1).text = 'I changed the spacing.\n\nShould the header keep its rule or lose it?';
  const { list } = studio({ sessions: { cs_one: asks } });
  list.render([{ id: 't_a', title: 'A', status: 'working', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  open(activityOf(list, 't_a'));
  await tick();
  assert.equal(stateLine(activityOf(list, 't_a')), 'Needs you · Should the header keep its rule or lose it?');
  list.destroy();
});

test('a failed read says so with Retry, and Retry reads again', async () => {
  let failing = true;
  const { list, reads } = studio({ sessions: { cs_one: STORED }, fail: () => failing });
  list.render([{ id: 't_a', title: 'A', status: 'review', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  open(activityOf(list, 't_a'));
  await tick();
  const d = activityOf(list, 't_a');
  assert.equal(text(bySpec(d, 'p.small.activity-error')[0]), 'Activity could not be read: session file unreadable');
  const retry = bySpec(d, 'button').find((b) => text(b) === 'Retry');
  failing = false;
  retry.fire('click');
  await tick();
  assert.equal(reads.length, 2);
  assert.equal(text(bySpec(activityOf(list, 't_a'), 'summary')[0]), 'Activity · 3 tool calls');
  list.destroy();
});

test('a row\'s file name is a button that opens the file in the Source tab; a search, a path outside the project and another project\'s task stay text', async () => {
  const opened = [];
  const session = structuredClone(STORED);
  session.turns.at(-1).events.push(
    { kind: 'tool', id: 'u4', name: 'Write', summary: 'C:\\Work\\proj\\src\\New.js', ms: 25000 },
    { kind: 'tool', id: 'u5', name: 'Read', summary: 'C:\\Elsewhere\\secret.txt', ms: 26000 },
    { kind: 'tool', id: 'u6', name: 'mcp__atelier__atelier_read_file', summary: '{"path":"docs/a.md"}', ms: 27000 },
  );
  const { list } = studio({ sessions: { cs_one: session }, openSource: (o) => opened.push(o), projects: [{ id: 'p', path: 'c:/work/proj' }] });
  list.render([{ id: 't_a', projectId: 'p', title: 'A', status: 'review', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  open(activityOf(list, 't_a'));
  await tick();
  const d = activityOf(list, 't_a');
  assert.deepEqual(rowLines(d), ['00:04 · Read · copy.mjs', '00:19 · Search · “spacing”', '00:23 · Edit · theme.ts', '00:25 · Write · New.js', '00:26 · Read · secret.txt', '00:27 · Read · path docs/a.md'], 'the words are unchanged');
  const buttons = bySpec(d, 'button').map(text);
  assert.deepEqual(buttons, ['copy.mjs', 'theme.ts', 'New.js', 'path docs/a.md'], 'the search and the file outside the project have none');
  for (const b of bySpec(d, 'button')) b.fire('click');
  assert.deepEqual(opened, [{ path: 'client/copy.mjs' }, { path: 'client/theme.ts' }, { path: 'src/New.js' }, { path: 'docs/a.md' }]);
  list.destroy();

  // Another project's task (one list across projects): actions act on the active project, so no buttons.
  const other = studio({ sessions: { cs_one: STORED }, openSource: (o) => opened.push(o) });
  other.list.render([{ id: 't_a', projectId: 'p_other', title: 'A', status: 'review', updatedAt: 'x', lastEvent: handed('cs_one') }]);
  open(activityOf(other.list, 't_a'));
  await tick();
  assert.deepEqual(bySpec(activityOf(other.list, 't_a'), 'button'), []);
  other.list.destroy();
});

test('destroy unsubscribes from the console topic', () => {
  const { list, subs } = studio();
  assert.equal(subs.size, 1);
  list.destroy();
  assert.equal(subs.size, 0);
});

test('a task row names its department beside when it was updated; a task without one says nothing of it', () => {
  const { list } = studio();
  list.render([
    { id: 't_a', title: 'Tidy the labels', status: 'ready', updatedAt: 'x', department: { id: 'docs', name: 'Docs and writing' } },
    { id: 't_b', title: 'Grid air', status: 'ready', updatedAt: 'x' },
  ]);
  const meta = (tid) => text(bySpec(row(list, tid), 'span.task-meta')[0]);
  assert.match(meta('t_a'), /^Docs and writing department · updated /);
  assert.ok(!/department/.test(meta('t_b')), meta('t_b'));
  assert.equal(departmentWords({ department: { id: 'backend', name: 'Backend' } }), 'Backend department');
  assert.equal(departmentWords({}), null);
});
