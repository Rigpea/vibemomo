// The Task panel's form with the real renderCollab on a stub DOM: what it says, and what a project switch leaves in it.
// The stub has no layout, so scripts/ui-check/verify-switch-export.cjs covers the same switch in a real window.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag = '') {
    this.tag = tag;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.value = '';
  }
  setAttribute(k, v) { this[k] = v; }
  removeAttribute(k) { delete this[k]; }
  addEventListener() {}
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  focus() {}
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.tag === '#text' ? this.text : this.children.map((c) => c.textContent).join(''); }
}
globalThis.Node = FakeNode;
globalThis.document = {
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
  querySelector: () => null,
};
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => {};

const { renderCollab } = await import('../client/components/collab.js');

const walk = (n, out = []) => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
const host = new FakeNode('div');
const app = {
  state: { bundle: null, projects: [] },
  projectId: () => 'p_1',
  api: { consoleSessions: async () => [] },
  toggleLayout() {},
  newProject() {},
};
renderCollab(host, app);
const nodes = walk(host);
const [request, acceptance] = nodes.filter((n) => n.tag === 'textarea');
const inspiration = nodes.find((n) => n.tag === 'input');
const mode = nodes.find((n) => n.tag === 'select' && n['aria-label'] === 'How Claude Code works with you');
const department = nodes.find((n) => n.tag === 'select' && n['aria-label'] === 'Department whose skills the worker uses');
const fill = () => { request.value = 'Make the jump snappier'; inspiration.value = 'A game'; acceptance.value = 'Feels quick'; mode.value = 'explore'; department.value = 'design'; };
const switchProject = () => renderCollab(host, app, { reset: true });

test('the button says the form only creates a task, and the sentence says how it runs', () => {
  const button = nodes.find((n) => n.type === 'submit');
  assert.equal(button.textContent, 'Create task');
  assert.ok(nodes.some((n) => n.textContent === 'Nothing runs until you hand it over: Run with Claude Code here on its row.'));
});

test('the button names the project the task goes to, also right after a switch that keeps the request', () => {
  const button = nodes.find((n) => n.type === 'submit');
  const projects = [{ id: 'p_1', name: 'Room One' }, { id: 'p_2', name: 'Room Two' }];
  let active = 'p_1';
  app.projectId = () => active;
  app.state.projects = projects;
  try {
    renderCollab(host, app);
    assert.equal(button.textContent, 'Create task on Room One');
    assert.equal(button['aria-label'], 'Create task on Room One', 'its accessible name is its full words');
    assert.equal(button.title, undefined, 'nothing was cut: no title');
    fill();
    active = 'p_2'; // selectProject has dropped the bundle: the name comes from the rail's list
    switchProject();
    assert.equal(request.value, 'Make the jump snappier');
    assert.equal(button.textContent, 'Create task on Room Two');
    assert.ok(nodes.some((n) => n.textContent === 'Nothing runs until you hand it over: Run with Claude Code here on its row.'));

    app.state.bundle = { project: { id: 'p_2', name: 'Renamed Room' }, tasks: [] };
    renderCollab(host, app);
    assert.equal(button.textContent, 'Create task on Renamed Room', 'a rename reaches it through the bundle');
    assert.equal(button.disabled, false);

    app.state.bundle = { project: { id: 'p_2', name: 'A project with a name far too long for one button' }, tasks: [] };
    renderCollab(host, app);
    assert.equal(button.textContent, 'Create task on A project with a name far…');
    assert.equal(button.title, 'A project with a name far too long for one button');
    assert.equal(button['aria-label'], 'Create task on A project with a name far too long for one button');

    app.state.bundle = { project: { id: 'p_2', name: 'Room Two' }, tasks: [] };
    renderCollab(host, app);
    assert.equal(button.title, undefined, 'a name that fits again drops the title');
  } finally {
    app.projectId = () => 'p_1';
    app.state.projects = [];
    app.state.bundle = null;
    renderCollab(host, app);
  }
  assert.equal(button.textContent, 'Create task', 'no project known: nothing to name');
  assert.equal(button['aria-label'], 'Create task');
});

test('a switch with no request puts the mode back on the default', () => {
  fill();
  request.value = '   ';
  switchProject();
  assert.equal(mode.value, 'handle');
  assert.equal(department.value, '', 'the department goes back to None too');
  assert.equal(request.value, '');
  assert.equal(inspiration.value, '');
  assert.equal(acceptance.value, '');
});

test('a switch with a request still in the field keeps the request and the mode', () => {
  fill();
  switchProject();
  assert.equal(request.value, 'Make the jump snappier');
  assert.equal(mode.value, 'explore');
  assert.equal(inspiration.value, 'A game');
  assert.equal(acceptance.value, 'Feels quick');
});
