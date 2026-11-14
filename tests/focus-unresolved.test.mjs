// Focus > Unresolved: the real renderFocus on a stub DOM, so the groups, Resolve all and Show all run with their
// clicks and the PATCH they send. No browser is involved; scripts/ui-check/verify-unresolved.cjs is what shows the look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

class FakeNode {
  constructor(tag = '') { this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.attrs = {}; this.on = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { this.on[type] = fn; }
  removeEventListener() {}
  append(...kids) { this.children.push(...kids); }
  replaceChildren() { this.children = []; }
  remove() {}
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  get text() { return this.value ?? this.children.map((c) => c.text).join(''); }
  set text(v) { this.value = v; }
}
globalThis.Node = FakeNode;
globalThis.document = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => toasts,
};
const toasts = new FakeNode('div'); // ui.js keeps the first host it gets
const toastWords = () => toasts.children.map((t) => t.text);
FakeNode.prototype.showModal = function showModal() { this.open = true; this.modal = true; };
FakeNode.prototype.show = function show() { this.open = true; this.modal = false; };
FakeNode.prototype.close = function close() { this.open = false; };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 0;

const { renderFocus, showDriftDiff, nextInRail } = await import('../client/components/focus.js');
const { groupUnresolved, focusAfterResolve, focusAfterResolveAll } = await import('../client/components/unresolved-groups.js');
const { dialog } = await import('../client/components/ui.js');

const walk = (node, pick, out = []) => { if (pick(node)) out.push(node); for (const c of node.children || []) walk(c, pick, out); return out; };
const has = (name) => (n) => (n.className || '').split(' ').includes(name);

function studio(items, tasks = []) {
  const project = { id: 'p_1', name: 'Room', unresolved: items };
  const patches = [];
  const app = {
    projectId: () => 'p_1',
    state: { bundle: { project, versions: [], releases: [], tasks }, projects: [{ id: 'p_1', kind: 'game' }] },
    api: { patchProject: async (_id, partial) => { patches.push(partial); return { ...project, ...partial }; } },
    emit() {},
    loadStudio() {},
  };
  return { app, patches, host: new FakeNode('div') };
}
function read(host) {
  const sec = walk(host, (n) => n.attrs?.['aria-label'] === 'Unresolved')[0];
  const buttons = walk(sec, (n) => n.tag === 'button');
  return {
    count: walk(sec, has('focus-head'))[0].children[1]?.text,
    rows: walk(sec, has('unresolved')).flatMap((ul) => ul.children.map((li) => li.children[0].text)),
    lines: walk(sec, has('unresolved-from')).map((n) => n.children[0].text),
    labels: buttons.map((b) => b.text).filter((t) => t !== 'Resolve' && t !== 'Add'),
    press: (label) => buttons.find((b) => b.text === label).on.click(),
    resolveFirst: () => buttons.find((b) => b.text === 'Resolve').on.click(),
    toggle: buttons.find((b) => /^Show /.test(b.text)),
  };
}
const carried = (id, taskId, taskTitle) => ({ id, text: id, taskId, ...(taskTitle ? { taskTitle } : {}) });
const LONG = [
  carried('a1', 't_a', 'Task A'), { id: 'mine', text: 'mine' }, carried('a2', 't_a', 'Task A'),
  carried('b1', 't_b', 'Task B'), carried('b2', 't_b', 'Task B'), carried('b3', 't_b', 'Task B'), carried('b4', 't_b', 'Task B'),
  carried('c1', 't_c', 'Task C'),
];

test('more than five: typed first, five rows, whole-group counts, the count stays the total', () => {
  const { app, host } = studio(LONG);
  renderFocus(host, app);
  const seen = read(host);
  assert.equal(seen.count, '8');
  assert.deepEqual(seen.rows, ['mine', 'a1', 'a2', 'b1', 'b2']);
  assert.deepEqual(seen.lines, ['From task: Task A · 2 items', 'From task: Task B · 4 items']);
  assert.deepEqual(seen.labels, ['Resolve all 2', 'Resolve all 4', 'Show all 8']);
  assert.equal(seen.toggle.attrs['aria-expanded'], 'false');
});

test('Show all opens everything, survives a redraw and closes again; a group of one has no Resolve all', () => {
  const { app, host } = studio(LONG);
  renderFocus(host, app);
  read(host).press('Show all 8');
  let seen = read(host);
  assert.equal(seen.rows.length, 8);
  assert.deepEqual(seen.labels, ['Resolve all 2', 'Resolve all 4', 'Show first 5']);
  assert.ok(seen.lines.includes('From task: Task C · 1 item'));
  assert.equal(seen.toggle.attrs['aria-expanded'], 'true');
  renderFocus(host, app); // a live refresh rebuilds the section
  assert.equal(read(host).rows.length, 8);
  read(host).press('Show first 5');
  assert.equal(read(host).rows.length, 5);
});

test('Resolve all sends the ids of the whole group, also the rows the cut left out, and no list', async () => {
  const { app, host, patches } = studio(LONG);
  renderFocus(host, app);
  read(host).press('Resolve all 4');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(patches[0], { unresolvedResolve: ['b1', 'b2', 'b3', 'b4'] });
});

test('one Resolve sends that item\'s id and no list', async () => {
  const { app, host, patches } = studio(LONG);
  renderFocus(host, app);
  read(host).resolveFirst();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(patches[0], { unresolvedResolve: ['mine'] });
});

// What follows a press: a stub that redraws on emit, finds controls by data-edit and tracks the focus.
function live(items) {
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return 0; };
  const s = studio(items);
  const { app, host } = s;
  host.querySelectorAll = () => walk(host, (n) => n.dataset?.edit);
  host.contains = (n) => !!n && walk(host, (x) => x === n).length > 0;
  let list = items;
  app.api.patchProject = async (_id, partial) => {
    s.patches.push(partial);
    list = [...list.filter((u) => !(partial.unresolvedResolve || []).includes(u.id)), ...(partial.unresolvedAdd || []).map((a, i) => ({ id: `new${i}`, text: a.text }))];
    return { ...app.state.bundle.project, unresolved: list };
  };
  app.emit = () => renderFocus(host, app);
  document.activeElement = document.body;
  renderFocus(host, app);
  s.settle = async () => { await new Promise((r) => setImmediate(r)); frames.splice(0).forEach((fn) => fn()); };
  s.control = (key) => walk(host, (n) => n.dataset?.edit === key)[0];
  if (s.control('unresolved-all')?.text === 'Show first 5') s.control('unresolved-all').on.click(); // Show all is kept per project id, across tests
  return s;
}
FakeNode.prototype.focus = function focus() { document.activeElement = this; };
FakeNode.prototype.contains = function contains(n) { return !!n && walk(this, (x) => x === n).length > 0; };

const focusAfter = async (s, key) => { s.control(key).on.click(); await s.settle(); return document.activeElement?.dataset?.edit; };
const GROUPED = [
  { id: 'mine1', text: 'mine1' }, { id: 'mine2', text: 'mine2' },
  carried('a1', 't_a', 'Task A'), carried('a2', 't_a', 'Task A'), carried('a3', 't_a', 'Task A'),
  carried('c1', 't_c', 'Task C'),
  carried('d1', 't_d', 'Task D'), carried('d2', 't_d', 'Task D'),
];

test('after a Resolve the focus goes to the next item\'s text, else the next group\'s heading, else Add', async () => {
  const s = live(GROUPED);
  s.control('unresolved-all').on.click();
  assert.equal(await focusAfter(s, 'resolve-a3'), 'group:t_c', 'last of a group of three: its Resolve all stays out too');
  assert.equal(await focusAfter(s, 'resolve-a1'), 'item:a2');
  assert.equal(await focusAfter(s, 'resolve-a2'), 'group:t_c', 'the group is gone');
  assert.equal(await focusAfter(s, 'resolve-c1'), 'group:t_d');
  assert.equal(await focusAfter(s, 'resolve-mine1'), 'item:mine2');
  assert.equal(await focusAfter(s, 'resolve-mine2'), 'group:t_d', 'the last typed item: the first group follows');
  assert.equal(await focusAfter(s, 'resolve-d2'), 'unresolved-add', 'one left and no group after it');
});

test('an Enter on what holds the focus resolves nothing, and Tab from an item\'s text reaches its Resolve', async () => {
  const s = live(GROUPED);
  s.control('unresolved-all').on.click();
  await focusAfter(s, 'resolve-a1');
  const text = document.activeElement;
  assert.notEqual(text.tag, 'button');
  assert.equal(text.attrs.tabIndex, -1, 'held by script only, so Tab does not stop on every row');
  assert.equal(text.on.click, undefined, 'nothing to press');
  const row = walk(s.host, (n) => n.tag === 'li' && n.children.includes(text))[0];
  assert.equal(row.children.indexOf(s.control('resolve-a2')), row.children.indexOf(text) + 1, 'the next stop in reading order');
  assert.equal(walk(s.host, (n) => n.dataset?.edit === 'group:t_c')[0].attrs.tabIndex, -1);
});

test('the rule on its own: the keys in order, for each place an item can stand', () => {
  const a = carried('a1', 't_a', 'A');
  const a2 = carried('a2', 't_a', 'A');
  const a3 = carried('a3', 't_a', 'A');
  const c = carried('c1', 't_c', 'C');
  const d = carried('d1', 't_d', 'D');
  const d2 = carried('d2', 't_d', 'D');
  const mine = { id: 'm1', text: 'm1' };
  const mine2 = { id: 'm2', text: 'm2' };
  const view = groupUnresolved([mine, mine2, a, a2, a3, c, d, d2]);
  const [groupA, groupC, groupD] = view.groups;
  const afterA = ['group:t_c', 'group:t_d', 'unresolved-add'];
  assert.deepEqual(focusAfterResolve(view, a), ['item:a2', 'item:a3', ...afterA], 'the next item first');
  assert.deepEqual(focusAfterResolve(view, a3), afterA, 'last of the group, two left');
  assert.deepEqual(focusAfterResolve(view, c), ['group:t_d', 'unresolved-add'], 'its only item');
  assert.deepEqual(focusAfterResolve(view, d2), ['unresolved-add'], 'last of the last group, one left');
  assert.deepEqual(focusAfterResolve(view, mine), ['item:m2', 'group:t_a', ...afterA], 'the next typed item, then the groups');
  assert.deepEqual(focusAfterResolve(view, mine2).slice(0, 2), ['group:t_a', 'group:t_c'], 'the last typed item: the first group');
  assert.deepEqual(focusAfterResolveAll(view, groupA), afterA);
  assert.deepEqual(focusAfterResolveAll(view, groupC), ['group:t_d', 'unresolved-add']);
  assert.deepEqual(focusAfterResolveAll(view, groupD), ['unresolved-add']);
});

test('after a Resolve all the focus goes to the next group\'s heading, else Add', async () => {
  const s = live(GROUPED);
  s.control('unresolved-all').on.click();
  assert.equal(await focusAfter(s, 'resolve-all-t_a'), 'group:t_c', 'a group of one has a heading too');
  const again = live([carried('a1', 't_a', 'Task A'), carried('a2', 't_a', 'Task A'), carried('d1', 't_d', 'Task D'), carried('d2', 't_d', 'Task D')]);
  assert.equal(await focusAfter(again, 'resolve-all-t_a'), 'group:t_d');
  assert.equal(await focusAfter(again, 'resolve-all-t_d'), 'unresolved-add');
});

// verify-unresolved.cjs:137-148, in a window that paints late or not at all (show: false): no frame ever runs here.
test('the focus lands with the redraw, not on a later frame: the driver\'s four presses', async () => {
  const s = live(['A', 'B', 'C', 'G'].map((n) => carried(n, 't_a', 'Group A')).concat(carried('D', 't_b', 'Group B'), carried('E', 't_c', 'Group C'), carried('F', 't_c', 'Group C')));
  s.control('unresolved-all').on.click();
  const pressed = async (key) => { s.control(key).on.click(); await new Promise((r) => setImmediate(r)); return document.activeElement?.dataset?.edit; };
  assert.equal(await pressed('resolve-A'), 'item:B', 'the next item\'s text');
  assert.equal(await pressed('resolve-G'), 'group:t_b', 'the last of a group that still has two: the next group\'s heading');
  assert.equal(await pressed('resolve-all-t_a'), 'group:t_b', 'the next group\'s heading');
  assert.equal(await pressed('resolve-all-t_c'), 'unresolved-add', 'no group after it');
});

test('a move by the person while the save is on its way wins', async () => {
  const s = live(GROUPED);
  s.control('unresolved-all').on.click();
  s.control('resolve-a1').on.click();
  s.control('resolve-mine1').focus();
  await s.settle();
  assert.equal(document.activeElement?.dataset?.edit, 'resolve-mine1');
});

test('the next item is found when the cut hid it until this redraw', async () => {
  const s = live([{ id: 'x1', text: 'x1' }, { id: 'x2', text: 'x2' }, { id: 'x3', text: 'x3' }, { id: 'x4', text: 'x4' }, { id: 'x5', text: 'x5' }, { id: 'x6', text: 'x6' }]);
  assert.equal(s.control('item:x6'), undefined, 'the sixth is behind Show all');
  assert.equal(await focusAfter(s, 'resolve-x5'), 'item:x6');
});

test('the toggle keeps the focus also when the click did not focus it', () => {
  const s = live(LONG);
  document.activeElement = document.body;
  s.control('unresolved-all').on.click();
  assert.equal(document.activeElement, s.control('unresolved-all'));
  assert.equal(document.activeElement.text, 'Show first 5');
  s.control('unresolved-all').on.click();
  assert.equal(document.activeElement.text, 'Show all 8');
});

test('Resolve and Add leave an open edit form alone, and the caret in it', async () => {
  const s = live(GROUPED);
  const edit = walk(s.host, (n) => n.dataset?.edit === 'piece')[0];
  edit.on.click();
  const form = walk(s.host, (n) => n.tag === 'form' && n.on.keydown)[0];
  assert.ok(form, 'the form is open');
  const field = walk(form, (n) => n.tag === 'input')[0];
  field.value = 'Half typed';
  document.activeElement = field;

  s.control('resolve-mine1').on.click();
  await s.settle();
  assert.deepEqual(s.patches.at(-1), { unresolvedResolve: ['mine1'] });
  assert.equal(walk(s.host, (n) => n === form).length, 1, 'Resolve keeps the form');
  assert.equal(field.value, 'Half typed');
  assert.equal(document.activeElement, field, 'and the caret stays in it');

  s.control('unresolved-add').value = 'A question';
  walk(s.host, (n) => n.tag === 'form' && n.on.submit)
    .find((n) => walk(n, (x) => x.dataset?.edit === 'unresolved-add').length).on.submit({ preventDefault() {} });
  await s.settle();
  assert.deepEqual(s.patches.at(-1), { unresolvedAdd: [{ text: 'A question' }] });
  assert.equal(walk(s.host, (n) => n === form).length, 1, 'Add keeps the form');
  assert.equal(document.activeElement, field);
  document.activeElement = document.body;
  walk(form, (n) => n.tag === 'button' && n.text === 'Cancel')[0].on.click(); // the form's state is module-wide
});

test('Add keeps the focus in its field and empties it; words typed there survive a redraw until then', async () => {
  const s = live([]);
  const field = s.control('unresolved-add');
  field.value = 'Half a question';
  field.on.input({ target: field });
  document.activeElement = field;
  renderFocus(s.host, s.app); // a live refresh rebuilds the section
  assert.equal(s.control('unresolved-add').attrs.value, 'Half a question', 'el() sets value as the attribute');
  assert.equal(document.activeElement, s.control('unresolved-add'));
  s.control('unresolved-add').value = 'Half a question';
  walk(s.host, (n) => n.tag === 'form' && n.on.submit)
    .find((n) => walk(n, (x) => x.dataset?.edit === 'unresolved-add').length).on.submit({ preventDefault() {} });
  await s.settle();
  assert.deepEqual(s.patches, [{ unresolvedAdd: [{ text: 'Half a question' }] }]);
  assert.equal(s.control('unresolved-add').attrs.value, '');
  assert.equal(document.activeElement, s.control('unresolved-add'));
});

test('a refused change keeps the list, the words and the focus', async () => {
  const s = live([]);
  s.app.api.patchProject = async () => { throw new Error('refused'); };
  const field = s.control('unresolved-add');
  field.value = 'Kept';
  field.on.input({ target: field });
  document.activeElement = field;
  walk(s.host, (n) => n.tag === 'form' && n.on.submit)
    .find((n) => walk(n, (x) => x.dataset?.edit === 'unresolved-add').length).on.submit({ preventDefault() {} });
  await s.settle();
  assert.equal(s.control('unresolved-add'), field, 'no redraw');
  assert.equal(field.value, 'Kept');
  assert.equal(document.activeElement, field);
  field.on.input({ target: { value: '' } }); // the draft is module-wide
});

// The tester's three questions: "R17 test question twoR17 test question three", because the field emptied only at the answer.
function slowAdd() {
  const s = live([]);
  const real = s.app.api.patchProject;
  const waiting = [];
  s.app.api.patchProject = (id, partial) => new Promise((resolve, reject) => {
    waiting.push({ partial, answer: () => real(id, partial).then(resolve), refuse: () => reject(new Error('refused')) });
  });
  s.waiting = waiting;
  s.field = () => s.control('unresolved-add');
  s.type = (text) => { const f = s.field(); f.value = text; f.on.input({ target: f }); };
  s.enter = () => walk(s.host, (n) => n.tag === 'form' && n.on.submit)
    .find((n) => walk(n, (x) => x.dataset?.edit === 'unresolved-add').length).on.submit({ preventDefault() {} });
  document.activeElement = s.field();
  return s;
}
const clearDraft = (s) => s.type(''); // the draft is module-wide

test('Add empties the field on Enter, before the answer, so quick questions stay apart', async () => {
  const s = slowAdd();
  for (const text of ['one', 'two', 'three']) {
    s.type(text);
    s.enter();
    assert.equal(s.field().value, '', `empty right after Enter on ${text}`);
  }
  assert.deepEqual(s.waiting.map((w) => w.partial), [{ unresolvedAdd: [{ text: 'one' }] }, { unresolvedAdd: [{ text: 'two' }] }, { unresolvedAdd: [{ text: 'three' }] }]);
  s.type('four, half typed');
  for (const w of s.waiting.splice(0)) { w.answer(); await s.settle(); }
  assert.equal(s.field().attrs.value, 'four, half typed', 'an answer leaves what was typed since');
  assert.equal(document.activeElement, s.field());
  clearDraft(s);
});

test('a refused Add puts the words back and says so', async () => {
  const s = slowAdd();
  s.type('Kept');
  s.enter();
  assert.equal(s.field().value, '');
  renderFocus(s.host, s.app); // a live refresh on the way must not bring it back early
  assert.equal(s.field().attrs.value, '');
  s.waiting.pop().refuse();
  await s.settle();
  assert.equal(s.field().value, 'Kept');
  assert.equal(toastWords().at(-1), 'Could not save the question; it is back in the field: refused');
  renderFocus(s.host, s.app);
  assert.equal(s.field().attrs.value, 'Kept', 'a redraw keeps it');
  clearDraft(s);
});

test('a refused Add does not join or overwrite what was typed since: the toast holds its words', async () => {
  const s = slowAdd();
  s.type('First');
  s.enter();
  s.type('Second');
  s.waiting.pop().refuse();
  await s.settle();
  assert.equal(s.field().value, 'Second');
  assert.match(toastWords().at(-1), /^Could not save “First”; the field holds what you typed since: refused/);
  clearDraft(s);
});

test('a refused Add on a project the person has left goes back to that project\'s field', async () => {
  const s = slowAdd();
  s.type('Elsewhere');
  s.enter();
  const bundle = s.app.state.bundle;
  s.app.state.bundle = { project: { id: 'p_2' } };
  s.waiting.pop().refuse();
  await s.settle();
  assert.equal(s.field().value, '', 'the open field is not the question\'s project');
  assert.match(toastWords().at(-1), /^Could not save “Elsewhere” on .*Add field: refused/);
  s.app.state.bundle = bundle;
  renderFocus(s.host, s.app);
  assert.equal(s.field().attrs.value, 'Elsewhere');
  clearDraft(s);
});

test('a draft on another project does not count: the words go back to the failing project, and the other draft stays', async () => {
  const s = slowAdd();
  s.type('For Room');
  s.enter();
  const bundle = s.app.state.bundle;
  // The person moves to Room Three and types there while Room's question is still on its way.
  s.app.state.bundle = { project: { id: 'p_3', name: 'Room Three', unresolved: [] }, versions: [], releases: [], tasks: [] };
  s.app.projectId = () => 'p_3';
  renderFocus(s.host, s.app);
  s.type('Half typed in Three');
  s.waiting.pop().refuse();
  await s.settle();
  assert.match(toastWords().at(-1), /^Could not save “For Room” on .*it is back in that project's Add field: refused/);
  assert.doesNotMatch(toastWords().at(-1), /typed since/);
  assert.equal(s.field().value, 'Half typed in Three', 'the open field is left alone');
  renderFocus(s.host, s.app);
  assert.equal(s.field().attrs.value, 'Half typed in Three', 'and a redraw keeps it');
  clearDraft(s);
  s.app.state.bundle = bundle;
  s.app.projectId = () => 'p_1';
  renderFocus(s.host, s.app);
  assert.equal(s.field().attrs.value, 'For Room', 'back in the failing project\'s field');
  clearDraft(s);
});

const lastDialog = () => document.body.children.at(-1);
const pressIn = (node, label) => walk(node, (n) => n.tag === 'button' && n.text === label)[0].on.click();

test('a release row is named by its visible text, and the notes stay a title on its child', () => {
  const { app, host } = studio([]);
  app.state.bundle.versions = [{ id: 'v_1', n: 1, label: 'First' }];
  app.state.bundle.releases = [{ id: 'r1', versionId: 'v_1', createdAt: '2026-11-04', readinessSummary: 'x', notes: 'The notes', artifact: { path: '/work/room.zip' } }];
  renderFocus(host, app);
  const [row] = walk(host, has('releases'))[0].children;
  assert.equal(row.attrs['aria-label'], '#1 First · room.zip · 2026-11-04');
  assert.equal(row.attrs.title, undefined);
  assert.equal(row.children[0].text, '#1 First · room.zip · 2026-11-04');
  assert.equal(row.children[0].attrs.title, 'The notes\n\n/work/room.zip');
});

/** The diff of a.js open over its path button, the focus inside the dialog. */
async function openDiff() {
  const s = live([]);
  s.app.api.templateDriftDiff = async () => ({ diff: 'the diff' });
  const pathButton = new FakeNode('button');
  pathButton.isConnected = true;
  document.activeElement = pathButton;
  showDriftDiff(s.app, 'a.js', 'drift-diff-a.js');
  const d = lastDialog();
  const loadingWords = d.text;
  await s.settle();
  document.activeElement = d;
  return { d, pathButton, loadingWords };
}

test('the template diff opens modal with a Close button, and Close gives the focus back', async () => {
  const { d, pathButton, loadingWords } = await openDiff();
  assert.equal(d.modal, true, 'showModal: the top layer, so nothing paints over it');
  assert.ok(loadingWords.includes('Loading…'));
  assert.ok(d.text.includes('the diff'));
  pressIn(d, 'Close');
  assert.equal(d.open, false);
  assert.equal(document.activeElement, pathButton);
});

test('Esc on the template diff closes it and gives the focus back, once', async () => {
  const { d, pathButton } = await openDiff();
  // A modal dialog hears Esc from the browser as cancel, not as a keydown: this is what the press delivers.
  assert.equal(d.on.keydown, undefined);
  let refused = false;
  d.on.cancel({ preventDefault() { refused = true; } });
  assert.equal(refused, true, 'the browser\'s own close is replaced by the dialog\'s');
  assert.equal(d.open, false);
  assert.equal(document.activeElement, pathButton);
  // The close event d.close() queued arrives after the person moved on: it must not take the focus again.
  const elsewhere = new FakeNode('input');
  document.activeElement = elsewhere;
  d.on.close();
  assert.equal(document.activeElement, elsewhere);
});

test('a close from outside the buttons (the close event alone) gives the focus back too', async () => {
  const { d, pathButton } = await openDiff();
  d.on.close();
  assert.equal(document.activeElement, pathButton);
});

test('the stub tells modal from non-modal, and a non-modal dialog takes Esc as a real keydown', () => {
  const opener = new FakeNode('button');
  opener.isConnected = true;
  document.activeElement = opener;
  const { node } = dialog({ title: 'Overlay', body: 'x', modal: false, parent: new FakeNode('div') });
  assert.equal(node.modal, false, 'so the modal assertions above can fail');
  document.activeElement = node;
  node.on.keydown({ key: 'a', preventDefault() {} });
  assert.equal(node.open, true, 'another key leaves it open');
  node.on.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(node.open, false);
  assert.equal(document.activeElement, opener);
});

// #72 took the fade off dialogs: at opacity 0 a top-layer dialog shows the page through its first frames.
const SEE_THROUGH = (block) => [...block.matchAll(/(?:^|[;\s])opacity\s*:\s*([\d.]+)/g)].some((m) => Number(m[1]) < 1);

/** The selectors of rules whose subject is a dialog itself and that start it see-through: an opacity of its own, or
 *  an animation whose first keyframe has one. A backdrop or what sits inside a dialog does not count. */
function dialogFades(css) {
  const rules = [];
  const faded = new Set();
  const read = (text) => {
    for (let i = 0; i < text.length;) {
      const open = text.indexOf('{', i);
      if (open < 0) return;
      let end = open + 1;
      for (let depth = 1; depth; end++) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0;
      const head = text.slice(i, open).trim().split(';').at(-1).trim();
      const inner = text.slice(open + 1, end - 1);
      const keyframes = head.match(/^@keyframes\s+(\S+)/);
      if (keyframes) {
        const first = [...inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(([, at, block]) => at.split(',').some((a) => /^(from|0%)$/.test(a.trim())) && SEE_THROUGH(block));
        if (first) faded.add(keyframes[1]);
      } else if (head.startsWith('@')) read(inner);
      else rules.push({ head, inner });
      i = end;
    }
  };
  read(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const isDialog = (selector) => {
    const subject = selector.trim().split(/[\s>+~]+/).at(-1);
    return /(^dialog|\.dialog)(?![\w-])/.test(subject) && !subject.includes('::');
  };
  const animates = (inner) => [...inner.matchAll(/animation(?:-name)?\s*:\s*([^;]+)/g)].some((m) => m[1].split(/[\s,]+/).some((word) => faded.has(word)));
  return { dialogRules: rules.filter((r) => r.head.split(',').some(isDialog)), fades: rules.filter((r) => r.head.split(',').some(isDialog) && (SEE_THROUGH(r.inner) || animates(r.inner))).map((r) => r.head) };
}

test('the rule on its own: it sees the fade #72 removed, and leaves toasts, backdrops and children alone', () => {
  const pop = '@keyframes pop { from { opacity: 0; transform: translateY(4px); } }';
  assert.deepEqual(dialogFades(`.dialog[open] { display: flex; animation: pop 160ms ease-out; } ${pop}`).fades, ['.dialog[open]']);
  assert.deepEqual(dialogFades(`${pop} dialog { animation-name: pop; }`).fades, ['dialog'], 'keyframes on either side');
  assert.deepEqual(dialogFades('.dialog { opacity: 0; }').fades, ['.dialog']);
  assert.deepEqual(dialogFades('.dialog { animation: half 1s; } @keyframes half { 0%, 50% { opacity: .5; } }').fades, ['.dialog']);
  assert.deepEqual(dialogFades('@media (min-width: 1px) { .dialog { animation: pop 1s; } } @keyframes pop { 0% { opacity: 0 } }').fades, ['.dialog'], 'inside an at-rule');
  assert.deepEqual(dialogFades(`.toast { animation: pop 1s; } .dialog::backdrop { animation: pop 1s; } .dialog-body { opacity: 0.5; } .dialog .spinner { opacity: 0; } ${pop}`).fades, []);
  assert.deepEqual(dialogFades('.dialog { animation: rise 1s; opacity: 1; } @keyframes rise { from { transform: translateY(4px); } to { opacity: 0; } }').fades, [], 'only the first frame shows the page through');
});

test('no stylesheet under client/ starts a dialog see-through', async () => {
  const dir = new URL('../client/', import.meta.url);
  const names = (await fsp.readdir(dir, { recursive: true })).filter((n) => n.endsWith('.css'));
  assert.ok(names.includes('styles.css'), names.join());
  const css = (await Promise.all(names.map((n) => fsp.readFile(new URL(n.replaceAll('\\', '/'), dir), 'utf8')))).join('\n');
  const { dialogRules, fades } = dialogFades(css);
  assert.ok(dialogRules.some((r) => r.head === '.dialog[open]' && r.inner.includes('animation')), 'the rule that opens a dialog was read');
  assert.deepEqual(fades, []);
});

test('after a live refresh rebuilt the row, Close gives the focus to the new path button', async () => {
  const s = live([]);
  s.app.api.templateDriftDiff = async () => ({ diff: 'the diff' });
  const gone = new FakeNode('button');
  gone.isConnected = false;
  document.activeElement = gone;
  showDriftDiff(s.app, 'a.js', 'drift-diff-a.js');
  await s.settle();
  const rebuilt = new FakeNode('button');
  rebuilt.dataset.edit = 'drift-diff-a.js';
  s.host.children.push(rebuilt);
  document.activeElement = document.body;
  pressIn(lastDialog(), 'Close');
  await s.settle();
  assert.equal(document.activeElement, rebuilt);
});

function removing(projects, id) {
  const s = studio([]);
  const calls = [];
  s.app.state.projects = projects.map((p) => ({ kind: 'game', ...p }));
  s.app.state.bundle.project = { id, name: projects.find((p) => p.id === id).name, unresolved: [] };
  s.app.projectId = () => id;
  s.app.api.removeProject = async (pid) => { calls.push(`remove ${pid}`); };
  s.app.selectProject = async (pid) => { calls.push(`select ${pid}`); };
  s.app.loadStudio = async () => { calls.push('studio'); };
  s.app.loadBundle = async () => { calls.push('bundle'); };
  document.activeElement = document.body;
  renderFocus(s.host, s.app);
  pressIn(s.host, 'Remove from studio');
  return { ...s, calls, words: lastDialog().text };
}

test('the rule on its own: the next row, else the one above, else nothing', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextInRail(rows, 'a').id, 'b');
  assert.equal(nextInRail(rows, 'b').id, 'c', 'not simply the first project');
  assert.equal(nextInRail(rows, 'c').id, 'b');
  assert.equal(nextInRail([{ id: 'a' }], 'a'), null);
});

test('Remove says which project comes next and goes to it, not to the first in the rail', async () => {
  const s = removing([{ id: 'a', name: 'Room One' }, { id: 'b', name: 'Room Two' }, { id: 'c', name: 'Room Three' }], 'b');
  assert.ok(s.words.includes('The studio shows Room Three next.'), s.words);
  pressIn(lastDialog(), 'Remove from studio');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.calls, ['remove b', 'select c', 'studio']);
  assert.deepEqual(s.app.state.projects.map((p) => p.id), ['a', 'c'], 'gone from the rail by the switch');
});

test('Keep it removes nothing; the last project leaves the empty state', async () => {
  const kept = removing([{ id: 'a', name: 'Room One' }, { id: 'b', name: 'Room Two' }], 'b');
  assert.ok(kept.words.includes('The studio shows Room One next.'), kept.words);
  pressIn(lastDialog(), 'Keep it');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(kept.calls, []);

  const only = removing([{ id: 'a', name: 'Room One' }], 'a');
  assert.ok(only.words.includes('No project is left'), only.words);
  pressIn(lastDialog(), 'Remove from studio');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(only.calls, ['remove a', 'studio', 'bundle']);
});

test('five or fewer have no disclosure; old items take their title from the tasks or read as earlier', () => {
  const { app, host } = studio([carried('old', 't_old'), carried('gone', 't_gone')], [{ id: 't_old', title: 'Old task' }]);
  renderFocus(host, app);
  const seen = read(host);
  assert.equal(seen.toggle, undefined);
  assert.deepEqual(seen.lines, ['From task: Old task · 1 item', 'From earlier tasks · 1 item']);
});

test('an empty list says so and shows no count', () => {
  const { app, host } = studio([]);
  renderFocus(host, app);
  const seen = read(host);
  assert.equal(seen.count, undefined);
  assert.deepEqual(seen.rows, []);
  assert.ok(walk(host, (n) => n.attrs?.['aria-label'] === 'Unresolved')[0].text.includes('Nothing open.'));
});
