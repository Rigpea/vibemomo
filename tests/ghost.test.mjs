// The ghost marker (client/components/ghost.js): ghostOf on fixtures, then the controller on a stub DOM with a stub
// frame document (the label in its node, the soft outline on a pin's selector and gone on reload, Reload calling the
// Workbench's reload, another project's session drawing nothing), then the real Page and Phone panels mounted on stub
// DOMs in the manner of tests/page-tab.test.mjs and tests/phone-panel.test.mjs: the Page row's dot and the phone's
// label beside its live line. Layout and the real frame are scripts/ui-check/verify-ghost.cjs's to check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import * as ghost from '../client/components/ghost.js';
import * as pages from '../workbenches/page/pages.js';
import * as map from '../workbenches/phone/map.js';

const { ghostOf, buildOfRuns, buildWords, createGhost, GHOST_MS, GHOST_OUTLINE_ID, pageFilesOf } = ghost;

const ROOT = 'C:\\Users\\me\\harbor';
const at = (rel) => `${ROOT}\\${rel.replace(/\//g, '\\')}`;
const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const S1 = { projectId: 'p_1', backend: 'claude-code', model: 'claude-opus-5-5', running: true, endedAt: null };
const PAGE_FILES = ['dist/welcome/index.html', 'dist/welcome/welcome.css', 'dist/welcome/welcome.mjs'];
const base = (over = {}) => ({
  projectId: 'p_1', sessions: { cs_1: S1 }, root: ROOT, now: NOW, entry: 'dist/welcome/index.html', htmlFiles: ['dist/welcome/about.html'],
  pageFiles: PAGE_FILES, ...over,
});

// ---------- the model ----------

test('a file edit on a page file: the label names who, the file, how long ago and "on this page"; the page gets its dot', () => {
  const edits = [
    { sessionId: 'cs_1', name: 'Edit', summary: at('dist/welcome/index.html'), at: NOW - 10000 },
    { sessionId: 'cs_1', name: 'Edit', summary: at('dist/welcome/welcome.css'), at: NOW - 4000 },
  ];
  const m = ghostOf(base({ edits }));
  assert.equal(m.label, 'Claude Code · editing welcome.css · 4 s ago · on this page');
  assert.equal(m.title, 'Claude Code · Opus 5.5 · your login');
  assert.equal(m.file, 'dist/welcome/welcome.css');
  assert.equal(m.onPage, true);
  assert.equal(m.reload, true, 'an edit touched a file the page uses: Reload is offered');
  assert.deepEqual(m.pages, [{ file: 'dist/welcome/index.html', title: 'edited by Claude Code · 10 s ago' }]);
  assert.equal(m.phone, 'Claude Code · editing welcome.css · 4 s ago', 'the phone leaves "on this page" out');
  assert.equal(m.nextAt, NOW - 10000 + GHOST_MS);
  // A file the page does not use: no "on this page", no Reload.
  const other = ghostOf(base({ edits: [{ sessionId: 'cs_1', name: 'Write', summary: at('docs/notes.md'), at: NOW - 1000 }] }));
  assert.equal(other.label, 'Claude Code · editing notes.md · 1 s ago');
  assert.equal(other.reload, false);
  assert.deepEqual(other.pages, []);
});

test('an edit of a file a pin or the readout maps to gives that part; a reload takes it away', () => {
  const edits = [{ sessionId: 'cs_1', name: 'Edit', summary: at('dist/welcome/welcome.css'), at: NOW - 2000 }];
  const pins = [
    { selector: '#case-grid', element: 'ul#case-grid', files: ['dist/welcome/welcome.css:91', 'dist/welcome/index.html:147'] },
    { selector: '#login', element: 'form#login', files: ['dist/welcome/account.mjs:3'] },
  ];
  const readouts = [{ selector: 'body > h1:nth-of-type(1)', element: 'h1', files: ['dist/welcome/welcome.css:12'] }];
  const m = ghostOf(base({ edits, pins, readouts }));
  assert.deepEqual(m.parts.map((p) => [p.selector, p.source, p.file]), [['#case-grid', 'pin', 'dist/welcome/welcome.css'], ['body > h1:nth-of-type(1)', 'readout', 'dist/welcome/welcome.css']]);
  const reloaded = ghostOf(base({ edits, pins, readouts, reloadedAt: NOW - 1000 }));
  assert.deepEqual(reloaded.parts, [], 'the frame loaded after the edit: no outline');
  assert.equal(reloaded.reload, false);
  assert.match(reloaded.label, /editing welcome\.css/, 'the label still says what happened in the last 30 s');
});

test('a non-file call reads as a verb line with no time', () => {
  const edits = [{ sessionId: 'cs_1', name: 'Bash', summary: 'npm run check', at: NOW - 3000 }];
  assert.equal(ghostOf(base({ edits })).label, 'Claude Code · running npm run check');
  assert.equal(ghostOf(base({ edits: [{ sessionId: 'cs_1', name: 'Read', summary: at('client/app.js'), at: NOW }] })).label, 'Claude Code · reading app.js');
  assert.equal(ghostOf(base({ edits: [{ sessionId: 'cs_1', name: 'mcp__atelier__atelier_phone_screenshot', summary: '{}', at: NOW }] })).label, 'Claude Code · phone screenshot');
  assert.equal(ghostOf(base({ edits: [{ sessionId: 'cs_1', name: 'Read', summary: at('dist/welcome/index.html'), at: NOW }] })).reload, false, 'reading is not editing');
});

test('nothing after 30 s; a page dot stays while the run goes on and 30 s after it ends', () => {
  const edits = [{ sessionId: 'cs_1', name: 'Edit', summary: at('dist/welcome/index.html'), at: NOW }];
  const later = ghostOf(base({ edits, now: NOW + GHOST_MS + 1000 }));
  assert.equal(later.label, '');
  assert.deepEqual(later.parts, []);
  assert.equal(later.pages.length, 1, 'the run still goes on: the page keeps its dot until the preview reloads');
  const ended = { cs_1: { ...S1, running: false, endedAt: NOW + 5000 } };
  assert.equal(ghostOf(base({ edits, sessions: ended, now: NOW + 5000 + GHOST_MS - 1 })).pages.length, 1);
  const gone = ghostOf(base({ edits, sessions: ended, now: NOW + 5000 + GHOST_MS + 1 }));
  assert.deepEqual([gone.label, gone.pages, gone.reload, gone.phone, gone.nextAt], ['', [], false, '', null]);
  assert.deepEqual(ghostOf(base({ edits: [] })), { label: '', title: '', file: null, onPage: false, parts: [], pages: [], reload: false, phone: '', nextAt: null });
});

test('a build step gives the phone words; with no session they are the label too', () => {
  const runs = [
    { kind: 'build', projectId: 'p_2', latest: '1 of 3 · cap sync', endedAt: null },
    { kind: 'build', projectId: 'p_1', latest: '2 of 3 · gradlew', endedAt: null },
  ];
  const build = buildOfRuns(runs, 'p_1');
  assert.deepEqual(build, { step: { index: 2, of: 3, label: 'gradlew' } });
  assert.equal(buildWords(buildOfRuns([{ kind: 'build', projectId: 'p_1', latest: null }], 'p_1')), 'Building and installing');
  assert.equal(buildOfRuns([{ kind: 'build', projectId: 'p_1', latest: '3 of 3 · install', endedAt: '2026-11-07T12:00:00Z' }], 'p_1'), null, 'an ended build is not running');
  const m = ghostOf(base({ build }));
  assert.equal(m.phone, 'Building and installing · step 2 of 3 · gradlew');
  assert.equal(m.label, 'Building and installing · step 2 of 3 · gradlew');
  const both = ghostOf(base({ build, edits: [{ sessionId: 'cs_1', name: 'Edit', summary: at('dist/welcome/welcome.css'), at: NOW }] }));
  assert.equal(both.phone, 'Building and installing · step 2 of 3 · gradlew', 'the phone shows the build while it runs');
  assert.match(both.label, /^Claude Code · editing welcome\.css/, 'the preview shows the session');
});

test('another project\'s session, or a session not yet met, draws nothing', () => {
  const edits = [
    { sessionId: 'cs_2', name: 'Edit', summary: at('dist/welcome/index.html'), at: NOW },
    { sessionId: 'cs_3', name: 'Edit', summary: at('dist/welcome/index.html'), at: NOW },
  ];
  const sessions = { cs_1: S1, cs_2: { ...S1, projectId: 'p_2' }, cs_3: { projectId: undefined, running: true } };
  const m = ghostOf(base({ edits, sessions }));
  assert.deepEqual([m.label, m.pages, m.reload, m.phone], ['', [], false, '']);
  assert.equal(ghostOf(base({ edits, sessions, projectId: null })).label, '', 'no project on screen: nothing');
});

test('pageFilesOf reads the document, its scripts and styles, and the resources its window loaded', () => {
  const url = 'http://127.0.0.1:4747/preview/p_1/head/dist/welcome/index.html?t=1';
  const doc = {
    URL: url,
    querySelectorAll: () => [{ src: 'http://127.0.0.1:4747/preview/p_1/head/dist/welcome/welcome.mjs' }, { href: 'welcome.css' }],
    defaultView: { performance: { getEntriesByType: () => [{ name: 'http://127.0.0.1:4747/preview/p_1/head/dist/shared/cards.mjs' }, { name: 'https://fonts.example/x.woff2' }] } },
  };
  assert.deepEqual(pageFilesOf(doc), ['dist/welcome/index.html', 'dist/welcome/welcome.mjs', 'dist/welcome/welcome.css', 'dist/shared/cards.mjs']);
  assert.deepEqual(pageFilesOf(null), []);
});

// ---------- a stub DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { spec, tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, style: {}, hidden: false, title: '', _text: null, rect: { left: 0, top: 0, width: 0, height: 0 } });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  fire(type, e = {}) { const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, target: this, ...e }; for (const fn of this.listeners[type] || []) fn(ev); return ev; }
  contains(n) { return all(this).includes(n); }
  focus() { globalThis.document.activeElement = this; }
  getBoundingClientRect() { return this.rect; }
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
    else if (k.startsWith('aria') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c)));
  return node;
}
const ui = {
  el,
  clear: (node, ...children) => { node._text = null; node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c))); return node; },
  button: (text, { onclick, disabled, title, type = 'button', variant, small, ...rest } = {}) => el('button', { type, onclick, disabled, title, ...rest }, text),
  stateChip: (text, tone, title) => el(`span.chip.tone-${tone}`, { title }, text),
  toast: () => {},
  copyText: async () => true,
};
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const find = (root, pred) => all(root).filter(pred);
const byClass = (root, c) => find(root, (n) => n.classes.has(c));

// The frame's document: elements with ids, boxes and children, as the page-tab test's.
class E {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentElement: null, attrs: {}, id: '', hidden: false, style: {}, ownerDocument: doc, rect: null });
  }
  getAttribute(k) { if (k === 'id') return this.id || null; return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { if (k === 'id') this.id = v; else this.attrs[k] = String(v); }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((k) => k !== this); this.parentElement = null; }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 0, height: 0 }; }
  get textContent() { return ''; }
}
function frameDoc(url = 'http://127.0.0.1:4747/preview/p_1/head/dist/welcome/index.html') {
  const view = { scrollX: 0, scrollY: 40, addEventListener() {}, removeEventListener() {}, location: { hash: '', href: url } };
  const doc = {
    URL: url, defaultView: view, title: '', addEventListener() {}, removeEventListener() {},
    createElement: (tag) => new E(tag, doc),
    getElementById(id) { const walk = (n) => (n.id === id ? n : n.children.map(walk).find(Boolean) || null); return walk(doc.documentElement); },
    querySelectorAll: () => [{ href: 'http://127.0.0.1:4747/preview/p_1/head/dist/welcome/welcome.css' }],
  };
  doc.documentElement = new E('html', doc);
  doc.body = doc.documentElement.appendChild(new E('body', doc));
  const section = doc.body.appendChild(new E('section', doc));
  section.attrs['data-screen'] = 'case';
  section.id = 'case';
  const grid = section.appendChild(new E('ul', doc));
  grid.id = 'case-grid';
  grid.rect = { left: 20, top: 100, width: 300, height: 200 };
  return doc;
}
function makeFrame(doc) {
  const listeners = {};
  return {
    doc, contentDocument: doc, contentWindow: {}, getBoundingClientRect: () => ({ width: 390, height: 700 }),
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    fire(t) { for (const f of listeners[t] || []) f({}); },
  };
}
function makeApp({ sessions = [], pins = [], records = {} } = {}) {
  const topics = new Map();
  const emitted = [];
  const app = {
    state: { projects: [{ id: 'p_1', path: ROOT }, { id: 'p_2', path: 'C:\\Users\\me\\other' }], runs: [] },
    on(topic, fn) { if (!topics.has(topic)) topics.set(topic, new Set()); topics.get(topic).add(fn); return () => topics.get(topic).delete(fn); },
    emit(topic, detail) { if (topic === 'ghost') emitted.push(detail); for (const fn of topics.get(topic) || []) fn(detail); },
    api: {
      consoleSessions: async () => ({ sessions }),
      pageFiles: async () => ({ entry: 'dist/welcome/index.html', siblings: ['dist/welcome/about.html'] }),
      companionPins: async () => ({ pins }),
      consoleGet: async (id) => { if (!records[id]) throw new Error('no record'); return { session: records[id] }; },
    },
    emitted,
  };
  return app;
}
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const chunk = (sessionId, name, summary) => ({ name: 'console.chunk', data: { sessionId, kind: 'tool', name, summary, ms: 1200 } });
const PIN = { id: 'pin_1', source: 'preview', selector: '#case-grid', element: 'ul#case-grid', files: ['dist/welcome/welcome.css:91'] };
const RUNNING = { id: 'cs_1', projectId: 'p_1', backend: 'claude-code', model: 'claude-opus-5-5', status: 'running' };

test('the controller: the label in its node, the soft outline on the pin\'s part, Reload calls the Workbench, a reload clears the outline', async () => {
  let clock = NOW;
  const doc = frameDoc();
  const frame = makeFrame(doc);
  const app = makeApp({ sessions: [RUNNING], pins: [PIN] });
  let reloads = 0;
  const g = createGhost(app, { frame, reload: () => { reloads++; }, h: ui, now: () => clock });
  try {
    await g.setProject({ project: { id: 'p_1' }, manifest: { entry: 'dist/welcome/index.html' } });
    await flush();
    assert.equal(g.node.hidden, true, 'nothing reported yet: no ghost');
    app.emit('console', chunk('cs_1', 'Edit', at('dist/welcome/welcome.css')));
    clock += 3000;
    app.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_1', kind: 'text', text: 'Done.' } }); // text draws again, adds no call
    assert.equal(g.node.hidden, false);
    assert.equal(byClass(g.node, 'ghost-label')[0].textContent, 'Claude Code · editing welcome.css · 3 s ago · on this page');
    assert.equal(byClass(g.node, 'ghost-dot')[0].hidden, false, 'the live dot');
    assert.equal(g.node.title, 'Claude Code · Opus 5.5 · your login');
    const holder = doc.getElementById(GHOST_OUTLINE_ID);
    assert.ok(holder, 'one holder in the frame document');
    assert.equal(holder.parentElement, doc.documentElement, 'outside the page\'s body');
    assert.equal(holder.children.length, 1);
    const box = holder.children[0];
    assert.equal(box.attrs['data-selector'], '#case-grid');
    assert.deepEqual([box.style.left, box.style.top, box.style.width, box.style.height, box.style.opacity, box.style.pointerEvents], ['20px', '140px', '300px', '200px', '0.5', 'none']);
    assert.ok(GHOST_OUTLINE_ID.startsWith(pages.OVERLAY_ID), 'the Page tab reads it as its own (isOurs)');
    const reloadBtn = byClass(g.node, 'ghost-reload')[0];
    assert.equal(reloadBtn.hidden, false);
    assert.equal(reloadBtn.kids[0], 'Reload the preview');
    reloadBtn.fire('click');
    assert.equal(reloads, 1, 'Reload calls the Workbench\'s reload; nothing else reloaded the frame');
    const last = app.emitted.at(-1);
    assert.equal(last.projectId, 'p_1');
    assert.equal(last.model.reload, true);
    // The frame loads again: the outline and Reload go; the label stays for the rest of its 30 s.
    clock += 1000;
    frame.fire('load');
    assert.equal(doc.getElementById(GHOST_OUTLINE_ID), null);
    assert.equal(reloadBtn.hidden, true);
    assert.equal(g.node.hidden, false);
    // 30 s after the call, the label empties.
    clock = NOW + GHOST_MS + 1;
    app.emit('runs');
    assert.equal(g.node.hidden, true);
  } finally { g.destroy(); }
});

test('the controller: a session met mid-run is read once; another project\'s draws nothing; a switch clears the marker', async () => {
  let clock = NOW;
  const doc = frameDoc();
  const frame = makeFrame(doc);
  const app = makeApp({ pins: [PIN], records: { cs_9: { id: 'cs_9', projectId: 'p_2', backend: 'claude-code', status: 'running' }, cs_5: { ...RUNNING, id: 'cs_5' } } });
  const g = createGhost(app, { frame, reload: () => {}, h: ui, now: () => clock });
  try {
    await g.setProject({ project: { id: 'p_1' }, manifest: { entry: 'dist/welcome/index.html' } });
    app.emit('console', chunk('cs_9', 'Edit', at('dist/welcome/welcome.css')));
    await flush();
    assert.equal(g.node.hidden, true, 'a session of another project draws nothing here');
    assert.equal(doc.getElementById(GHOST_OUTLINE_ID), null);
    app.emit('console', chunk('cs_5', 'Bash', 'npm run check'));
    assert.equal(g.node.hidden, true, 'not met yet: its record is being read');
    await flush();
    assert.equal(byClass(g.node, 'ghost-label')[0].textContent, 'Claude Code · running npm run check');
    assert.equal(byClass(g.node, 'ghost-reload')[0].hidden, true);
    // A build of this project, reported as a run: the words go to the phone; the session keeps the preview's label.
    app.state.runs = [{ kind: 'build', projectId: 'p_1', latest: '2 of 3 · gradlew', endedAt: null }];
    app.emit('runs');
    assert.equal(app.emitted.at(-1).model.phone, 'Building and installing · step 2 of 3 · gradlew');
    g.leave();
    assert.equal(g.node.hidden, true, 'the project left the screen: the marker goes');
    assert.equal(app.emitted.at(-1).projectId, null);
    app.emit('console', chunk('cs_5', 'Edit', at('dist/welcome/welcome.css')));
    assert.equal(g.node.hidden, true, 'no project on screen: calls are not kept');
  } finally { g.destroy(); }
});

test('the Workbench puts the ghost in the preview-wrap, outside the frame, and gives it Try as its reload', async () => {
  const src = await fsp.readFile(new URL('../client/views/workbench.js', import.meta.url), 'utf8');
  assert.match(src, /createGhost\(app, \{ frame, reload: \(\) => tryHead\(\)/);
  assert.match(src, /previewWrap\.append\(ui\.ghost\.node\)/);
  assert.match(src, /ui\.ghost\.leave\(\)/);
  assert.match(src, /ui\.ghost\.setProject\(b\)/);
});

// ---------- the Page tab's dot ----------
globalThis.document = { hidden: false, activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = new EventTarget();
const net = { answers: {} };
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = url.replace(/^\/api\/projects\/p_1/, '').replace(/\?.*$/, '') || '/';
  const a = net.answers[`${method} ${path}`];
  const [status, data] = a || [404, { error: { code: 'none', message: `no answer for ${method} ${path}` } }];
  return { ok: status < 400, status, json: async () => data };
};
const pageSource = (await fsp.readFile(new URL('../workbenches/page/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\/components\/ui\.js';/, 'const { el, clear, button, toast, copyText } = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/pages\.js';/, 'const {$1} = globalThis.__pages;');
const phoneSource = (await fsp.readFile(new URL('../workbenches/phone/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\/components\/ui\.js';/, 'const { el, clear, button, stateChip, toast, copyText } = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/map\.js';/, 'const {$1} = globalThis.__map;')
  .replace(/import \{([^}]*)\} from '\/components\/companion-words\.js';/, 'const {$1} = globalThis.__words;')
  .replace(/import \{([^}]*)\} from '\.\/beside\.js';/, 'const {$1} = globalThis.__beside;');
globalThis.__beside = await import('../workbenches/phone/beside.js');
globalThis.__ui = ui;
globalThis.__pages = pages;
globalThis.__map = map;
globalThis.__words = await import('../client/components/companion-words.js');
const pagePanel = await import(`data:text/javascript,${encodeURIComponent(pageSource)}`);
const phonePanel = await import(`data:text/javascript,${encodeURIComponent(phoneSource)}`);

test('the Page tab: a row whose file was edited carries a faint dot with who and when; it goes when the ghost drops it', async () => {
  net.answers = { 'GET /page/files': [200, { entry: 'dist/welcome/index.html', siblings: ['dist/welcome/about.html'] }] };
  const app = makeApp();
  const doc = frameDoc();
  const ctx = {
    projectId: 'p_1', project: { id: 'p_1', ui: {} }, previewFrame: makeFrame(doc),
    app: { ...app, state: { bundle: { project: { id: 'p_1', ui: {} }, versions: [] } }, workbench: { previewRef: () => 'head' } },
    saveUi: async () => ({}), setCount() {},
  };
  const container = el('div');
  pagePanel.mount(container, ctx);
  try {
    await flush();
    const rowsOf = () => byClass(container, 'page-row');
    assert.deepEqual(rowsOf().map((r) => r.dataset.page), ['index.html#case', 'about.html']);
    assert.equal(byClass(container, 'page-ghost').length, 0);
    app.emit('ghost', { projectId: 'p_1', model: { pages: [{ file: 'dist/welcome/about.html', title: 'edited by Claude Code · 4 s ago' }] } });
    let dots = byClass(container, 'page-ghost');
    assert.equal(dots.length, 1);
    assert.equal(rowsOf()[1].contains(dots[0]), true, 'on the edited page\'s row');
    assert.equal(dots[0].title, 'edited by Claude Code · 4 s ago');
    // The same set with a newer time: the title changes in place, the rows are not drawn again.
    const row = rowsOf()[1];
    app.emit('ghost', { projectId: 'p_1', model: { pages: [{ file: 'dist/welcome/about.html', title: 'edited by Claude Code · 5 s ago' }] } });
    assert.equal(rowsOf()[1], row);
    assert.equal(dots[0].title, 'edited by Claude Code · 5 s ago');
    app.emit('ghost', { projectId: 'p_2', model: { pages: [] } });
    assert.equal(byClass(container, 'page-ghost').length, 1, 'another project\'s ghost changes nothing here');
    app.emit('ghost', { projectId: 'p_1', model: { pages: [] } });
    dots = byClass(container, 'page-ghost');
    assert.equal(dots.length, 0, 'the frame reloaded or the run ended 30 s ago: the dot goes');
  } finally { pagePanel.unmount(); }
});

test('the Page tab: a file behind several pages gets one dot, on the shown page\'s row, saying so', async () => {
  net.answers = { 'GET /page/files': [200, { entry: 'dist/welcome/index.html', siblings: [] }] };
  const app = makeApp();
  const doc = frameDoc();
  for (const id of ['bond', 'name']) { const s = doc.body.appendChild(new E('section', doc)); s.attrs['data-screen'] = id; s.id = id; }
  const container = el('div');
  pagePanel.mount(container, {
    projectId: 'p_1', project: { id: 'p_1', ui: {} }, previewFrame: makeFrame(doc),
    app: { ...app, state: { bundle: { project: { id: 'p_1', ui: {} }, versions: [] } }, workbench: { previewRef: () => 'head' } }, saveUi: async () => ({}), setCount() {},
  });
  try {
    await flush();
    const rows = () => byClass(container, 'page-row');
    assert.deepEqual(rows().map((r) => r.dataset.page), ['index.html#case', 'index.html#bond', 'index.html#name']);
    assert.equal(rows()[0].attrs['aria-current'], 'page', 'the case screen is the one shown');
    app.emit('ghost', { projectId: 'p_1', model: { pages: [{ file: 'dist/welcome/index.html', title: 'edited by Claude Code · 4 s ago' }] } });
    const dots = byClass(container, 'page-ghost');
    assert.equal(dots.length, 1, 'one dot for the one file, not one per row');
    assert.ok(rows()[0].contains(dots[0]), 'on the shown page\'s row');
    assert.equal(dots[0].title, 'edited by Claude Code · 4 s ago · the one file behind 3 pages');
    app.emit('ghost', { projectId: 'p_1', model: { pages: [{ file: 'dist/welcome/index.html', title: 'edited by Claude Code · 5 s ago' }] } });
    assert.equal(dots[0].title, 'edited by Claude Code · 5 s ago · the one file behind 3 pages', 'the words tick in place');
    assert.deepEqual(pagePanel.dotRows([{ key: 'a', file: 'x', visible: false }, { key: 'b', file: 'x', visible: false }], [{ file: 'x' }]).get('x'), { key: 'a', shared: 2 }, 'no shown row of the file: its first');
  } finally { pagePanel.unmount(); }
});

test('a Page or Phone panel mounted after the ghost last drew starts from its model', async () => {
  net.answers = { 'GET /page/files': [200, { entry: 'dist/welcome/index.html', siblings: [] }], 'GET /': [404, { error: { code: 'none', message: 'no phone here' } }] };
  const app = makeApp();
  const model = { pages: [{ file: 'dist/welcome/index.html', title: 'edited by Claude Code · 8 s ago' }], phone: 'Claude Code · editing index.html · 8 s ago' };
  const workbench = { previewRef: () => 'head', ghost: () => ({ projectId: 'p_1', model }) };
  const container = el('div');
  pagePanel.mount(container, {
    projectId: 'p_1', project: { id: 'p_1', ui: {} }, previewFrame: makeFrame(frameDoc()),
    app: { ...app, state: { bundle: { project: { id: 'p_1', ui: {} }, versions: [] } }, workbench }, saveUi: async () => ({}), setCount() {},
  });
  const phoneHost = el('div.wbp-host');
  phonePanel.mount(phoneHost, { projectId: 'p_1', manifest: {}, app: { ...app, workbench } });
  try {
    await flush();
    assert.equal(byClass(container, 'page-ghost')[0]?.title, 'edited by Claude Code · 8 s ago');
    assert.equal(byClass(phoneHost, 'phone-ghost')[0].hidden, false);
    assert.equal(byClass(phoneHost, 'ghost-label')[0].textContent, 'Claude Code · editing index.html · 8 s ago');
  } finally { pagePanel.unmount(); phonePanel.unmount(); }
});

test('the Phone screen: the ghost words sit over the image, apart from the live line and Point', async () => {
  globalThis.IntersectionObserver = undefined;
  net.answers = { 'GET /': [404, { error: { code: 'none', message: 'no phone here' } }] };
  const app = makeApp();
  const container = el('div.wbp-host');
  phonePanel.mount(container, { projectId: 'p_1', manifest: { devices: { android: {} } }, app });
  try {
    await flush();
    const screen = byClass(container, 'phone-screen')[0];
    const label = byClass(container, 'phone-ghost')[0];
    const live = byClass(container, 'phone-live')[0];
    assert.equal(label.hidden, true, 'nothing reported: no words');
    app.emit('ghost', { projectId: 'p_1', model: { phone: 'Building and installing · step 2 of 3 · gradlew', title: 'The phone build the studio started' } });
    assert.equal(label.hidden, false);
    assert.equal(byClass(label, 'ghost-label')[0].textContent, 'Building and installing · step 2 of 3 · gradlew');
    assert.equal(screen.kids.indexOf(label), 0, 'first in the screen column, over the image\'s top edge');
    assert.notEqual(label, live, 'the live line is its own node');
    assert.equal(screen.kids.includes(live), true);
    assert.equal(byClass(label, 'phone-live').length + find(label, (n) => n.tag === 'button').length, 0, 'it holds neither the live line nor Point');
    app.emit('ghost', { projectId: 'p_1', model: { phone: 'Claude Code · editing welcome.css · 2 s ago' } });
    assert.equal(byClass(label, 'ghost-label')[0].textContent, 'Claude Code · editing welcome.css · 2 s ago');
    app.emit('ghost', { projectId: 'p_1', model: null });
    assert.equal(label.hidden, true);
  } finally { phonePanel.unmount(); }
});
