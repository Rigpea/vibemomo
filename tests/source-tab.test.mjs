// The Source dock tab: client/components/source-words.js on its own, the files route's text flag and cut
// (server/lib/projects.mjs readProjectPath) on real temp files, and the real workbenches/source/panel.js mounted on a
// stub panel DOM with a stub api: the tree from a folder answer, a folder listed only when opened, a file opened at a
// line with that line marked and scrolled to, the cut and not-text lines, the changed dots and the path line, a saved
// change re-read with its scroll kept, the keys, and nothing written. The Phone and Page readouts' buttons and the
// Activity rows are in their own tests (phone-panel, page-tab, task-activity); layout is scripts/ui-check/verify-source.cjs's.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as words from '../client/components/source-words.js';
import { readProjectPath } from '../server/lib/projects.mjs';

// ---------- the pure parts ----------
test('projectRel: relative paths as they are, absolute ones under the project made relative, anything outside refused', () => {
  assert.equal(words.projectRel('src/app.js', 'C:/proj'), 'src/app.js');
  assert.equal(words.projectRel('./src//app.js'), 'src/app.js');
  assert.equal(words.projectRel('C:\\Proj\\src\\app.js', 'c:\\proj'), 'src/app.js', 'a drive path compares without case');
  assert.equal(words.projectRel('/home/me/proj/a.md', '/home/me/proj/'), 'a.md');
  assert.equal(words.projectRel('/home/me/Proj/a.md', '/home/me/proj'), null, 'a POSIX path keeps its case');
  assert.equal(words.projectRel('C:\\projects\\a.md', 'C:\\proj'), null, 'a sibling folder with the same start');
  assert.equal(words.projectRel('../secret.txt', 'C:/proj'), null);
  assert.equal(words.projectRel('C:/elsewhere/a.js', ''), null, 'no project path, no absolute path');
  assert.equal(words.projectRel('', 'C:/proj'), null);
  assert.equal(words.projectRel(null), null);
});

test('fileOfEvent: only calls that act on a file name one', () => {
  assert.equal(words.fileOfEvent({ name: 'Read', summary: 'src/a.js' }), 'src/a.js');
  assert.equal(words.fileOfEvent({ name: 'MultiEdit', summary: ' C:\\p\\a.js ' }), 'C:\\p\\a.js');
  assert.equal(words.fileOfEvent({ name: 'mcp__atelier__atelier_read_file', summary: '{"path":"docs/a.md"}' }), 'docs/a.md');
  assert.equal(words.fileOfEvent({ name: 'Grep', summary: 'spacing' }), null);
  assert.equal(words.fileOfEvent({ name: 'Bash', summary: 'npm test' }), null);
  assert.equal(words.fileOfEvent({ name: 'Read', summary: '' }), null);
});

test('linesOf, the cut words, changedFrom and the scroll', () => {
  assert.deepEqual(words.linesOf({ content: 'a\r\nb\n' }), ['a', 'b'], 'a final newline is not a line');
  assert.deepEqual(words.linesOf({ content: '' }), ['']);
  assert.deepEqual(words.linesOf({ content: 'a\nb\npart', truncated: true }), ['a', 'b'], 'a cut file drops its partial last line');
  assert.equal(words.cutWords({ shownBytes: 409600, bytes: 1572864 }), 'Cut at 400 KB of 1.5 MB: the rest of the file is not shown here.');
  assert.equal(words.gutterOf(3), '1\n2\n3');
  assert.equal(words.lineIn(3, 3), 3);
  assert.equal(words.lineIn(4, 3), null);
  assert.equal(words.lineIn(0, 3), null);
  assert.equal(words.scrollFor(30, 300), 29 * words.LINE_PX - 100);
  assert.equal(words.scrollFor(1, 300), 0);
  const c = words.changedFrom({ versions: [{ id: 'v3', n: 3 }], changes: { sinceVersionId: 'v3', files: [{ path: 'src/ui/a.js', status: 'M' }, { path: 'gone.js', status: 'D' }, { path: 'new.txt', status: '?' }] } });
  assert.deepEqual([...c.files], ['src/ui/a.js', 'new.txt'], 'a deleted file has no row to mark');
  assert.deepEqual([...c.folders], ['src', 'src/ui']);
  assert.equal(c.fileWords, 'changed since #3');
  assert.equal(c.folderWords, 'holds files changed since #3');
  assert.equal(words.changedFrom({ changes: { files: [] } }).fileWords, 'changed since the last version');
  assert.equal(words.changedFrom(null).files.size, 0);
  assert.equal(words.isToolFolder({ name: '.github', type: 'dir' }), true);
  assert.equal(words.isToolFolder({ name: '__pycache__', type: 'dir' }), true);
  assert.equal(words.isToolFolder({ name: 'node_modules', type: 'dir' }), true);
  assert.equal(words.isToolFolder({ name: 'dist', type: 'dir' }), false);
  assert.equal(words.isToolFolder({ name: '.env', type: 'file' }), false, 'a file is never a tool folder');
});

test('the files route: text: false for a binary or non-UTF-8 file, and with max a long file is cut at a whole character', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-source-'));
  try {
    await fsp.writeFile(path.join(dir, 'a.txt'), 'héllo\n');
    await fsp.writeFile(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await fsp.writeFile(path.join(dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1
    await fsp.writeFile(path.join(dir, 'long.txt'), `${'é'.repeat(10)}\nmore`); // 2 bytes per é
    const a = await readProjectPath(dir, 'a.txt', { max: 100 });
    assert.deepEqual([a.content, a.text, a.truncated, a.bytes], ['héllo\n', true, undefined, 7]);
    assert.equal((await readProjectPath(dir, 'logo.png')).text, false);
    assert.equal((await readProjectPath(dir, 'latin1.txt')).text, false);
    const cut = await readProjectPath(dir, 'long.txt', { max: 5 }); // the 5th byte is half an é
    assert.deepEqual([cut.content, cut.text, cut.truncated, cut.shownBytes, cut.bytes], ['éé', true, true, 5, 25]);
    const plain = await readProjectPath(dir, 'long.txt');
    assert.equal(plain.truncated, undefined, 'without max the answer is as before');
    assert.equal(plain.text, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------- the panel on a stub panel DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, disabled: false, value: '', title: '', style: {}, scrollTop: 0, scrollLeft: 0 });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) };
    this._text = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  fire(type, e = {}) {
    const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, target: this, ...e };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  contains(n) { return all(this).includes(n); }
  focus() { globalThis.document.activeElement = this; }
  get textContent() { return this._text ?? this.kids.map(textOf).join(' '); }
  set textContent(v) { this._text = String(v); this.kids = []; }
}
const textOf = (n) => (typeof n === 'string' ? n : n.hidden ? '' : n.textContent);
function el(spec, props, ...children) {
  if (props === null || props === undefined || props instanceof N || typeof props !== 'object' || Array.isArray(props)) { children.unshift(props); props = null; }
  const node = new N(spec);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'class') node.classes.add(v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('aria') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c)));
  return node;
}
const toasts = [];
const copied = [];
const ui = {
  el,
  clear: (node, ...children) => { node._text = null; node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c))); return node; },
  button: (text, { onclick, disabled, title, type = 'button', variant, small, ...rest } = {}) => el('button', { type, onclick, disabled, title, ...rest }, text),
  toast: (message, opts) => { toasts.push([message, opts?.tone]); },
  copyText: async (text) => { copied.push(text); return true; },
};
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const find = (root, pred) => all(root).filter(pred);
const byClass = (root, c) => find(root, (n) => n.classes.has(c));
const one = (root, c) => byClass(root, c)[0];
const buttonNamed = (root, text) => find(root, (n) => n.tag === 'button' && n.kids[0] === text)[0];

globalThis.document = { activeElement: null, hidden: false };
globalThis.window = new EventTarget();

const href = (p) => JSON.stringify(new URL(p, import.meta.url).href);
const source = (await fsp.readFile(new URL('../workbenches/source/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\/components\/ui\.js';/, 'const { el, clear, button, toast, copyText } = globalThis.__ui;')
  .replace("'/components/source-words.js'", href('../client/components/source-words.js'));
globalThis.__ui = ui;
const panel = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };

const forty = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
function disk() {
  return {
    '': { type: 'dir', entries: [{ name: '.github', type: 'dir' }, { name: '__pycache__', type: 'dir' }, { name: 'dist', type: 'dir' }, { name: 'src', type: 'dir' }, { name: 'big.js', type: 'file' }, { name: 'index.html', type: 'file' }, { name: 'logo.png', type: 'file' }] },
    '.github': { type: 'dir', entries: [{ name: 'workflows', type: 'dir' }] },
    '.github/workflows': { type: 'dir', entries: [{ name: 'ci.yml', type: 'file' }] },
    '.github/workflows/ci.yml': { type: 'file', content: 'on: push\n', text: true, bytes: 9 },
    __pycache__: { type: 'dir', entries: [{ name: 'a.pyc', type: 'file' }] },
    dist: { type: 'dir', entries: [{ name: 'welcome', type: 'dir' }, { name: '.cache', type: 'dir' }] },
    'dist/.cache': { type: 'dir', entries: [] },
    src: { type: 'dir', entries: [{ name: 'app.js', type: 'file' }, { name: 'empty', type: 'dir' }] },
    'src/empty': { type: 'dir', entries: [] },
    'src/app.js': { type: 'file', content: forty, text: true, bytes: 400 },
    'index.html': { type: 'file', content: '<h1>Hi</h1>\n', text: true, bytes: 12 },
    'logo.png': { type: 'file', content: '\uFFFDPNG', text: false, bytes: 6 },
    'big.js': { type: 'file', content: 'a\nb\nc\nhalf a li', text: true, truncated: true, shownBytes: 409600, bytes: 2 * 1024 * 1024 },
  };
}

function setup({ changes = { sinceVersionId: 'v3', dirty: false, files: [] } } = {}) {
  toasts.length = 0;
  copied.length = 0;
  const files = disk();
  const reads = [];
  const writes = [];
  const subs = {};
  const bundle = { project: { id: 'p_1', name: 'Proj' }, versions: [{ id: 'v3', n: 3 }], changes };
  const net = { changes: structuredClone(changes), changesAsked: 0, bundleLoads: 0 };
  const api = {
    async readFile(id, p, max) {
      assert.equal(id, 'p_1');
      reads.push([p, max ?? null]);
      const a = files[p];
      if (!a) throw new Error(`No such path: ${p}`);
      return structuredClone({ path: p, ...a });
    },
    async writeFile(...args) { writes.push(args); throw new Error('the Source tab must not write'); },
    async changes() { net.changesAsked++; return structuredClone(net.changes); },
  };
  const app = {
    state: { bundle, projects: [{ id: 'p_1', path: 'C:\\proj' }] },
    on(topic, fn) { (subs[topic] ||= []).push(fn); return () => { subs[topic] = subs[topic].filter((f) => f !== fn); }; },
    loadBundle() { net.bundleLoads++; },
  };
  const ctx = { projectId: 'p_1', api, app };
  const container = el('div');
  panel.mount(container, ctx);
  const rows = () => byClass(container, 'source-item');
  const row = (p) => rows().find((r) => r.dataset.path === p);
  const tree = one(container, 'source-tree');
  const key = (k, target, extra = {}) => tree.fire('keydown', { key: k, target, ...extra });
  return { container, ctx, files, reads, writes, subs, bundle, net, rows, row, tree, key, n: panel._state().nodes };
}

afterEach(() => panel.unmount());

test('the tree lists the top folder with folders closed (dist shown) and lists a folder only when it is opened', async () => {
  const p = setup();
  await flush();
  assert.deepEqual(p.rows().map((r) => [r.dataset.path, r.dataset.type, r.attrs['aria-level'], r.attrs['aria-expanded']]), [
    ['dist', 'dir', '1', 'false'], ['src', 'dir', '1', 'false'], ['big.js', 'file', '1', undefined], ['index.html', 'file', '1', undefined], ['logo.png', 'file', '1', undefined],
  ]);
  assert.deepEqual(p.reads, [['', null]], 'only the top folder is listed');
  assert.equal(p.rows()[0].tabIndex, 0, 'one row in the tab order');
  assert.ok(p.rows().slice(1).every((r) => r.tabIndex === -1));
  assert.equal(p.n.note.textContent, 'Choose a file in the tree to read it here.');
  assert.equal(p.n.text.hidden, true);

  p.row('src').fire('click');
  await flush();
  assert.deepEqual(p.reads.at(-1), ['src', null]);
  assert.equal(p.row('src').attrs['aria-expanded'], 'true');
  assert.deepEqual(p.rows().map((r) => r.dataset.path), ['dist', 'src', 'src/app.js', 'src/empty', 'big.js', 'index.html', 'logo.png']);
  assert.equal(p.row('src/app.js').attrs['aria-level'], '2');
  p.row('src/empty').fire('click');
  await flush();
  assert.ok(byClass(p.container, 'source-empty').some((n) => n.textContent === 'Empty folder'));
  p.row('src').fire('click');
  await flush();
  assert.deepEqual(p.rows().map((r) => r.dataset.path), ['dist', 'src', 'big.js', 'index.html', 'logo.png'], 'closed again, with no new read');
  assert.equal(p.reads.filter(([x]) => x === 'src').length, 1);
});

test('tool folders (.github, __pycache__, dist/.cache) are left out behind a Show row; Show lists them, Hide puts them back, a file inside one shows them', async () => {
  const p = setup();
  await flush();
  const toolsButton = () => one(p.container, 'source-tools').kids[0];
  assert.deepEqual(p.rows().map((r) => r.dataset.path), ['dist', 'src', 'big.js', 'index.html', 'logo.png'], 'the two top tool folders are not rows');
  assert.equal(one(p.container, 'source-tools').hidden, false);
  assert.equal(toolsButton().kids[0], '2 tool folders hidden · Show');
  assert.equal(toolsButton().attrs['aria-pressed'], 'false');
  p.row('dist').fire('click');
  await flush();
  assert.deepEqual(p.rows().map((r) => r.dataset.path), ['dist', 'dist/welcome', 'src', 'big.js', 'index.html', 'logo.png'], 'dist/.cache is left out too');
  assert.equal(toolsButton().kids[0], '3 tool folders hidden · Show', 'the open folder\'s counts with the top\'s');
  toolsButton().fire('click');
  await flush();
  assert.deepEqual(p.rows().map((r) => r.dataset.path), ['.github', '__pycache__', 'dist', 'dist/welcome', 'dist/.cache', 'src', 'big.js', 'index.html', 'logo.png']);
  assert.equal(toolsButton().kids[0], 'Tool folders shown · Hide');
  assert.equal(toolsButton().attrs['aria-pressed'], 'true');
  assert.deepEqual(p.reads.map(([x]) => x), ['', 'dist'], 'showing lists nothing new');
  toolsButton().fire('click');
  await flush();
  assert.deepEqual(p.rows().map((r) => r.dataset.path), ['dist', 'dist/welcome', 'src', 'big.js', 'index.html', 'logo.png']);
  // A file inside a tool folder, opened from elsewhere (an Activity row, studio.show): the folders show so its row is there.
  panel.command({ open: { path: '.github/workflows/ci.yml', line: 1 } });
  await flush();
  assert.ok(p.rows().map((r) => r.dataset.path).includes('.github/workflows/ci.yml'), 'the file\'s row is in the tree');
  assert.equal(p.row('.github/workflows/ci.yml').attrs['aria-selected'], 'true');
  assert.equal(toolsButton().kids[0], 'Tool folders shown · Hide');
  assert.equal(p.n.path.textContent, '.github/workflows/ci.yml');
});

test('a file opened at a line: numbered, the line marked and scrolled to, the path line with Copy path, the row selected', async () => {
  const p = setup();
  await flush();
  panel.command({ open: { path: 'C:\\proj\\src\\app.js', line: 30 } }); // an absolute path inside the project
  await flush();
  assert.deepEqual(p.reads.slice(1), [['src', null], ['src/app.js', words.CUT_BYTES]], 'the folder above is listed, the file read with the cut');
  assert.equal(p.n.text.hidden, false);
  assert.equal(p.n.gutter.textContent.split('\n').length, 40);
  assert.equal(p.n.gutter.textContent.split('\n')[29], '30');
  assert.equal(p.n.code.textContent.split('\n')[29], 'line 30');
  assert.equal(p.n.mark.hidden, false);
  assert.equal(p.n.mark.dataset.line, '30');
  assert.equal(p.n.mark.style.top, `${29 * words.LINE_PX}px`);
  assert.equal(p.n.text.scrollTop, words.scrollFor(30, undefined), 'scrolled so the line is in view');
  assert.equal(p.n.path.textContent, 'src/app.js');
  assert.equal(p.n.pathMeta.textContent, 'line 30');
  assert.equal(p.n.text.attrs['aria-label'], 'src/app.js, read-only, 40 lines');
  assert.equal(p.row('src/app.js').attrs['aria-selected'], 'true');
  assert.equal(p.row('src/app.js').tabIndex, 0, 'the opened file is the tree\'s tab stop');
  assert.equal(p.n.note.textContent, '');
  buttonNamed(p.container, 'Copy path').fire('click');
  await flush();
  assert.deepEqual(copied, ['src/app.js']);

  // A line past the end marks nothing and says so; no line scrolls to the top.
  panel.command({ open: { path: 'index.html', line: 9 } });
  await flush();
  assert.equal(p.n.mark.hidden, true);
  assert.equal(p.n.note.textContent, 'Line 9 is past the end: the file has 1 line.');
  panel.command({ open: { path: 'src/app.js' } });
  await flush();
  assert.equal(p.n.mark.hidden, true);
  assert.equal(p.n.text.scrollTop, 0);
  assert.equal(p.n.pathMeta.textContent, '');
});

test('a file over 400 KB is cut with a line saying so; a file that is not text says Not a text file and shows nothing', async () => {
  const p = setup();
  await flush();
  p.row('big.js').fire('click');
  await flush();
  assert.equal(p.n.note.textContent, 'Cut at 400 KB of 2.0 MB: the rest of the file is not shown here.');
  assert.equal(p.n.gutter.textContent, '1\n2\n3', 'the partial last line is not numbered');
  assert.equal(p.n.text.hidden, false);
  p.row('logo.png').fire('click');
  await flush();
  assert.equal(p.n.note.textContent, 'Not a text file');
  assert.equal(p.n.text.hidden, true);
  assert.equal(p.n.code.textContent, '');
  assert.equal(p.n.path.textContent, 'logo.png');
  // A path the project does not hold, and one outside it.
  panel.command({ open: { path: 'src/gone.js', line: 2 } });
  await flush();
  assert.equal(p.n.note.textContent, 'Could not open src/gone.js: No such path: src/gone.js');
  panel.command({ open: { path: '../secret.txt' } });
  await flush();
  assert.equal(p.n.note.textContent, 'Could not open ../secret.txt: ../secret.txt is not inside this project');
  assert.ok(!p.reads.some(([x]) => x.includes('secret')), 'nothing outside the project is asked for');
});

test('changed files carry a dot titled changed since #n, their folders one too, and the path line says it', async () => {
  const p = setup({ changes: { sinceVersionId: 'v3', dirty: true, files: [{ path: 'src/app.js', status: 'M' }, { path: 'index.html', status: 'M' }] } });
  await flush();
  const dot = (r) => byClass(r, 'source-dot')[0];
  assert.equal(dot(p.row('src')).title, 'holds files changed since #3');
  assert.equal(dot(p.row('index.html')).attrs['aria-label'], 'changed since #3');
  assert.equal(dot(p.row('dist')), undefined);
  assert.equal(dot(p.row('big.js')), undefined);
  panel.command({ open: { path: 'src/app.js', line: 2 } });
  await flush();
  assert.equal(dot(p.row('src/app.js')).title, 'changed since #3');
  assert.equal(p.n.pathMeta.textContent, 'line 2 · changed since #3');
});

test('a saved change on disk: the bundle refresh moves the dots and re-reads the shown file keeping its scroll', async () => {
  const p = setup();
  await flush();
  panel.command({ open: { path: 'src/app.js', line: 30 } });
  await flush();
  p.n.text.scrollTop = 123;
  p.n.text.scrollLeft = 7;
  p.files['src/app.js'].content = forty.replace('line 30', 'line thirty');
  p.bundle.changes = { sinceVersionId: 'v3', dirty: true, files: [{ path: 'src/app.js', status: 'M' }] };
  panel.update();
  await flush();
  assert.equal(p.n.code.textContent.split('\n')[29], 'line thirty');
  assert.deepEqual([p.n.text.scrollTop, p.n.text.scrollLeft], [123, 7], 'the scroll is kept');
  assert.ok(byClass(p.row('src/app.js'), 'source-dot')[0], 'the file gained its dot');
  assert.equal(p.n.mark.dataset.line, '30', 'the line stays marked');

  // The project.changed event names the shown file (the studio wrote it): read again.
  p.files['src/app.js'].content = 'one\ntwo';
  for (const fn of p.subs['project.changed'] || []) fn({ projectId: 'p_1', file: 'src/app.js' });
  await flush();
  assert.equal(p.n.code.textContent, 'one\ntwo');
  for (const fn of p.subs['project.changed'] || []) fn({ projectId: 'p_other', file: 'src/app.js' });
  const before = p.reads.length;
  await flush();
  assert.equal(p.reads.length, before, 'another project\'s event reads nothing');

  // Back from an editor: the window's focus asks for the changes and loads the bundle when they differ.
  p.net.changes = { sinceVersionId: 'v3', dirty: true, files: [{ path: 'src/app.js', status: 'M' }, { path: 'index.html', status: 'M' }] };
  globalThis.window.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(p.net.changesAsked, 1);
  assert.equal(p.net.bundleLoads, 1);
  p.net.changes = p.bundle.changes;
  globalThis.window.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(p.net.bundleLoads, 1, 'the same changes load nothing');
  assert.deepEqual(p.writes, [], 'nothing was written');
});

test('keys: arrows walk the rows, Right opens a folder and Left closes it, Enter opens a file, Tab goes to the text', async () => {
  const p = setup();
  await flush();
  p.key('ArrowDown', p.row('dist'));
  assert.equal(globalThis.document.activeElement, p.row('src'));
  p.key('ArrowRight', p.row('src'));
  await flush();
  assert.equal(p.row('src').attrs['aria-expanded'], 'true');
  p.key('ArrowRight', p.row('src'));
  assert.equal(globalThis.document.activeElement, p.row('src/app.js'), 'Right on an open folder goes to its first row');
  p.key('ArrowLeft', p.row('src/app.js'));
  assert.equal(globalThis.document.activeElement, p.row('src'), 'Left on a file goes to its folder');
  p.key('ArrowLeft', p.row('src'));
  assert.equal(p.row('src').attrs['aria-expanded'], 'false', 'Left on an open folder closes it');
  p.key('End', p.row('src'));
  assert.equal(globalThis.document.activeElement, p.row('logo.png'));
  p.key('Home', p.row('logo.png'));
  assert.equal(globalThis.document.activeElement, p.row('dist'));
  const tabEarly = p.key('Tab', p.row('dist'));
  assert.equal(tabEarly.defaultPrevented, false, 'with no file shown Tab goes on as usual');
  p.key('ArrowDown', p.row('dist'));
  p.key('ArrowDown', p.row('src'));
  p.key('ArrowDown', p.row('big.js'));
  const enter = p.key('Enter', p.row('index.html'));
  assert.equal(enter.defaultPrevented, true);
  await flush();
  assert.equal(p.n.path.textContent, 'index.html');
  assert.equal(globalThis.document.activeElement, p.row('index.html'), 'the focus stays on the row');
  const tab = p.key('Tab', p.row('index.html'));
  assert.equal(tab.defaultPrevented, true);
  assert.equal(globalThis.document.activeElement, p.n.text, 'Tab moves to the text');
  assert.equal(p.key('Tab', p.row('index.html'), { shiftKey: true }).defaultPrevented, false, 'Shift+Tab is left alone');
});

test('the tab is a viewer: the text is a read-only region, there is no field, and unmount stops listening', async () => {
  const p = setup();
  await flush();
  panel.command({ open: { path: 'index.html' } });
  await flush();
  assert.equal(p.n.text.attrs.role, 'region');
  assert.equal(find(p.container, (n) => ['textarea', 'input'].includes(n.tag) || n.contentEditable).length, 0);
  panel.unmount();
  assert.deepEqual(p.subs['project.changed'], [], 'the project.changed listener is gone');
  globalThis.window.dispatchEvent(new Event('focus')); // nothing listens after unmount
  await flush();
  assert.equal(p.net.changesAsked, 0);
  assert.deepEqual(p.writes, []);
});
