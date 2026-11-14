// The New project dialog with the real ui.js on a stub DOM: the folder field's label, and an import of a folder the
// studio already holds, refused inside the dialog. The stub has no layout; the look is for scripts/ui-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag = '') { this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.attrs = {}; this.on = {}; this.parent = null; this.classList = { add() {}, remove() {}, toggle() {} }; this.value = ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.on[type] ||= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.on[type] || []) fn(event); }
  append(...kids) { for (const kid of kids) { kid.parent = this; this.children.push(kid); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  get isConnected() { return true; }
  get textContent() { return this.tag === '#text' ? this.text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.append(document.createTextNode(v)); }
}
globalThis.Node = FakeNode;
const toasts = new FakeNode('div');
globalThis.document = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
  getElementById: () => toasts,
};
globalThis.window = {};

const { newProjectDialog } = await import('../client/components/new-project.js');
const { request } = await import('../client/api.js');

const walk = (node, pick, out = []) => { if (pick(node)) out.push(node); node.children.forEach((c) => walk(c, pick, out)); return out; };
const settle = () => new Promise((r) => setImmediate(r));

/** Opens the dialog on its import side, with `answer` as the server's reply to an import. */
function opened(answer, projects = [{ id: 'p_plain', name: 'plain-site' }]) {
  toasts.children = [];
  const calls = [];
  const app = {
    state: { templates: [], projects },
    api: { createProject: async () => { throw new Error('not here'); }, importProject: async (body) => { calls.push(['import', body.path]); return answer(body); } },
    loadStudio: async () => { calls.push(['studio']); },
    selectProject: async (id) => { calls.push(['select', id]); },
    go: (view) => { calls.push(['go', view]); },
  };
  newProjectDialog(app);
  const d = document.body.children.at(-1);
  const pressed = (label) => walk(d, (n) => n.tag === 'button' && n.textContent === label)[0];
  pressed('Import a folder').fire('click');
  const folder = walk(d, (n) => n.tag === 'input' && n.attrs.placeholder?.includes('my-existing-project'))[0];
  const submit = async (path) => {
    folder.value = path;
    folder.fire('input');
    walk(d, (n) => n.tag === 'form')[0].fire('submit', { preventDefault() {} });
    await settle();
  };
  return { app, d, calls, folder, pressed, submit, status: () => walk(d, (n) => n.attrs.role === 'status')[0] };
}

const refusal = () => Object.assign(new Error('Already in the studio as plain-site'), { code: 'already_registered', status: 409, project: { id: 'p_plain', name: 'plain-site' } });

test('the folder field has a label that names it, and keeps its placeholder', () => {
  const { d, folder } = opened(() => ({}));
  const label = walk(d, (n) => n.tag === 'label' && n.attrs.htmlFor === folder.id)[0];
  assert.ok(folder.id, 'field() gave it an id');
  assert.equal(label?.textContent, 'Folder');
  assert.match(folder.attrs.placeholder, /my-existing-project/);
});

test('a registered folder is refused inside the dialog, under the field, with no toast', async () => {
  const s = opened(() => { throw refusal(); });
  await s.submit('C:\\work\\plain-site');
  assert.equal(s.d.open, true, 'the dialog stays open');
  assert.equal(s.folder.value, 'C:\\work\\plain-site');
  assert.equal(s.status().textContent, 'Already in the studio as plain-siteShow plain-site');
  assert.equal(s.status().parent, s.folder.parent, 'in the folder\'s own field');
  assert.deepEqual(toasts.children, []);
});

test('Show closes the dialog and switches to that project', async () => {
  const s = opened(() => { throw refusal(); });
  await s.submit('C:\\work\\plain-site');
  s.pressed('Show plain-site').fire('click');
  await settle();
  assert.equal(s.d.open, false);
  assert.deepEqual(s.calls.slice(1), [['select', 'p_plain'], ['go', 'workbench']]);
  assert.deepEqual(toasts.children, []);
});

test('Show on a project the client has not listed yet loads the list first', async () => {
  const s = opened(() => { throw refusal(); }, []);
  await s.submit('C:\\work\\plain-site');
  s.pressed('Show plain-site').fire('click');
  await settle();
  assert.deepEqual(s.calls.slice(1), [['studio'], ['select', 'p_plain'], ['go', 'workbench']]);
});

test('a long name is cut on the button only, and its accessible name is whole', async () => {
  const long = 'A project with a name far too long for one button';
  const s = opened(() => { throw Object.assign(new Error(`Already in the studio as ${long}`), { code: 'already_registered', project: { id: 'p_long', name: long } }); });
  await s.submit('C:\\work\\long');
  const show = walk(s.d, (n) => n.tag === 'button' && n.textContent.startsWith('Show '))[0];
  assert.equal(show.textContent, 'Show A project with a name far…');
  assert.equal(show.attrs['aria-label'], `Show ${long}`);
});

test('changing the path takes the refusal away: it was about the path that was there', async () => {
  const s = opened(() => { throw refusal(); });
  await s.submit('C:\\work\\plain-site');
  assert.ok(s.status().textContent);
  s.folder.value = 'C:\\work\\other';
  s.folder.fire('input');
  assert.equal(s.status().textContent, '');
});

test('other errors keep the toast and show no refusal; a refusal goes when the next answer is another error', async () => {
  let answer = () => { throw refusal(); };
  const s = opened(() => answer());
  await s.submit('C:\\work\\plain-site');
  answer = () => { throw Object.assign(new Error('No such folder'), { code: 'not_found' }); };
  walk(s.d, (n) => n.tag === 'form')[0].fire('submit', { preventDefault() {} });
  await settle();
  assert.equal(s.status().textContent, '');
  assert.deepEqual(toasts.children.map((t) => [t.textContent, t.dataset.prefix]), [['Import: No such folder', 'Import']]);
});

test('a successful import clears the earlier Import error and closes the dialog', async () => {
  let answer = () => { throw Object.assign(new Error('No such folder'), { code: 'not_found' }); };
  const s = opened(() => answer());
  await s.submit('C:\\work\\typo');
  assert.equal(toasts.children.length, 1);
  answer = () => ({ project: { id: 'p_new', name: 'Room' } });
  await s.submit('C:\\work\\room');
  assert.deepEqual(toasts.children.map((t) => t.textContent), ['Imported Room']);
  assert.equal(s.d.open, false);
  assert.deepEqual(s.calls.slice(-3), [['studio'], ['select', 'p_new'], ['go', 'workbench']]);
});

test('the client keeps what the server\'s 409 says about the project', async () => {
  // The shape of tests/http.test.mjs assertNamesProject, which runs against the real server.
  const body = { error: { code: 'already_registered', message: 'Already in the studio as plain-site' }, projectId: 'p_plain', name: 'plain-site', message: 'Already in the studio as plain-site' };
  globalThis.fetch = async () => ({ ok: false, status: 409, text: async () => JSON.stringify(body) });
  const err = await request('POST', '/api/projects/import', {}).catch((e) => e);
  assert.equal(err.code, 'already_registered');
  assert.equal(err.message, 'Already in the studio as plain-site');
  assert.deepEqual(err.project, { id: 'p_plain', name: 'plain-site' });
  assert.equal(err.name, 'Error', 'the Error keeps its own name');
});
