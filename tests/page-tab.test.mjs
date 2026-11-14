// The Page dock tab on stub DOMs: workbenches/page/pages.js read against a stub frame document (Harbor's data-screen
// sections, a one-page document, headings only), and the real workbenches/page/panel.js mounted on a stub panel DOM
// over that document: the outline at the part's box and gone on deselect, Point's readout from a synthetic click,
// the preview pin, the aura saved and shown, the not-readable state, and Point handing over to the Phone's.
// Layout and the real frame are scripts/ui-check/verify-page.cjs's to check.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import * as pages from '../workbenches/page/pages.js';
import os from 'node:os';
import path from 'node:path';
import { checkPin, contextPack } from '../server/lib/companion.mjs';

// ---------- a stub frame document ----------
class E {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], nodes: [], parentElement: null, attrs: {}, id: '', hidden: false, style: {}, ownerDocument: doc, rect: null, _text: '' });
    const cls = new Set();
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), [Symbol.iterator]: () => cls[Symbol.iterator]() };
  }
  getAttribute(k) { if (k === 'id') return this.id || null; if (k === 'hidden') return this.hidden ? '' : null; return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { if (k === 'id') this.id = v; else if (k === 'hidden') this.hidden = true; else this.attrs[k] = String(v); }
  set className(v) { for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c); }
  appendChild(c) { c.parentElement = this; this.children.push(c); this.nodes.push(c); return c; }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter((k) => k !== this); this.parentElement.nodes = this.parentElement.nodes.filter((k) => k !== this); } this.parentElement = null; }
  get nodeType() { return 1; }
  get childNodes() { return this.nodes; } // text nodes and elements in the order h() was given them
  get firstChild() { return this.children[0] || null; }
  get textContent() { return [this._text, ...this.children.map((c) => c.textContent)].join(' '); }
  set textContent(v) { this._text = String(v); this.children = []; this.nodes = [{ nodeType: 3, nodeValue: String(v) }]; }
  getBoundingClientRect() {
    if (this.rect) return this.rect;
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}
/** h('section', { id, hidden, 'data-screen', 'aria-label', class, rect }, ...children or text) */
function makeDoc(url = 'http://127.0.0.1:4747/preview/p_1/head/dist/welcome/index.html') {
  const listeners = {};
  const view = { scrollX: 0, scrollY: 0, location: { hash: '', href: url }, listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); },
    fire(type, ev) { for (const f of this.listeners[type] || []) f(ev); return ev; } };
  const doc = {
    URL: url, defaultView: view, listeners, title: '',
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    createElement: (tag) => new E(tag, doc),
    getElementById(id) { const walk = (n) => (n.id === id ? n : n.children.map(walk).find(Boolean) || null); return walk(doc.documentElement); },
    fire(type, ev) { for (const f of listeners[type] || []) f(ev); return ev; },
  };
  doc.documentElement = new E('html', doc);
  doc.body = doc.documentElement.appendChild(new E('body', doc));
  doc.h = (tag, props = {}, ...kids) => {
    const n = new E(tag, doc);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'rect') n.rect = v;
      else if (k === 'class') n.className = v;
      else if (k === 'hidden') n.hidden = !!v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) { if (typeof k === 'string') { n._text += k; n.nodes.push({ nodeType: 3, nodeValue: k }); } else n.appendChild(k); }
    return n;
  };
  doc.put = (...kids) => { for (const k of kids) doc.body.appendChild(k); return doc; };
  return doc;
}

/** Harbor's shape: screens as data-screen sections, one shown, routed by hash. */
function harbor() {
  const d = makeDoc();
  const { h } = d;
  d.put(
    h('section', { class: 'screen', 'data-screen': 'account', hidden: true }, h('h1', {}, 'Your account'), h('form', { id: 'login' })),
    h('section', { class: 'screen', 'data-screen': 'case', id: 'case' },
      h('header', { class: 'case-head' }, h('h2', {}, 'The case')),
      h('div', {}, h('ul', { id: 'case-grid', class: 'case-pockets', 'aria-label': 'Event grid', rect: { left: 20, top: 140, width: 300, height: 220 } },
        h('li', { class: 'pocket', rect: { left: 24, top: 150, width: 140, height: 90 } }, 'Lantern festival'),
        h('li', { class: 'pocket' }, 'Night market'))),
      h('nav', { 'aria-label': 'Navigation' }, h('a', { href: '#account' }, 'Account')),
      h('script', {}, 'ignored')),
  );
  return d;
}

test('pagesOf: Harbor\'s data-screen sections are numbered, named from their headings, and the shown one is marked', () => {
  const d = harbor();
  const list = pages.pagesOf(d, d.URL, { siblings: ['dist/welcome/index.html', 'dist/welcome/about.html'] });
  assert.deepEqual(list.map((p) => [p.n, p.name, p.key, p.hash, p.visible]), [
    ['01', 'Your account', 'index.html#account', '#account', false],
    ['02', 'The case', 'index.html#case', '#case', true],
    ['03', 'about.html', 'about.html', null, false],
  ]);
  // The hash names a hidden screen: the shown one stays the visible page.
  assert.equal(pages.pagesOf(d, `${d.URL}#account`).find((p) => p.visible).slug, 'case');
  // Once the account screen is the shown one and the hash names it, it is the visible page.
  d.body.children[0].hidden = false;
  d.body.children[1].hidden = true;
  assert.equal(pages.pagesOf(d, `${d.URL}#account`).find((p) => p.visible).name, 'Your account');
});

test('pagesOf: a one-page document is one page named by its heading; a headings-only document by its first heading', () => {
  const one = makeDoc('http://x/preview/p_1/head/src/index.html');
  one.put(one.h('main', {}, one.h('h1', {}, 'Quick  Notes'), one.h('p', {}, 'text')));
  assert.deepEqual(pages.pagesOf(one, one.URL).map((p) => [p.n, p.name, p.key, p.visible, p.hash]), [['01', 'Quick Notes', 'index.html', true, null]]);

  const heads = makeDoc('http://x/preview/p_1/head/index.html');
  heads.put(heads.h('h1', {}, 'Title'), heads.h('p', {}, 'one'), heads.h('h2', {}, 'Sub'));
  const [only] = pages.pagesOf(heads, heads.URL);
  assert.equal(only.name, 'Title');
  assert.equal(only.element, heads.body);
  assert.deepEqual(pages.partsOf(only.element).map((p) => [p.name, p.tag, p.selector]), [['Title', 'h1', 'body > h1:nth-of-type(1)'], ['Sub', 'h2', 'body > h2:nth-of-type(1)']]);

  const sections = makeDoc('http://x/preview/p_1/head/index.html');
  sections.put(sections.h('main', {}, sections.h('section', { id: 'intro' }, sections.h('h2', {}, 'Intro')), sections.h('section', { id: 'more', hidden: true })));
  assert.deepEqual(pages.pagesOf(sections, sections.URL).map((p) => [p.name, p.visible]), [['Intro', true], ['more', false]]);
  assert.deepEqual(pages.pagesOf({}, 'x'), [], 'no body, no pages');
});

test('names read as a person hears them: a heading broken by <br> keeps its space, an aria-hidden mark is left out, an empty heading falls back to data-screen', () => {
  // Real headings of the app this shape comes from: "Choose your<br>companion<span aria-hidden="true">.</span>" read "Choose yourcompanion." on 2026-11-07,
  // and the field guide's empty heading plus its aria-hidden "." named page 11 ".".
  const doc = makeDoc();
  const h = doc.h;
  doc.put(
    h('section', { 'data-screen': 'choose', id: 'choose' }, h('h1', { id: 'choose-title' }, 'Choose your', h('br'), 'companion', h('span', { 'aria-hidden': 'true' }, '.'))),
    h('section', { 'data-screen': 'field-guide', hidden: true }, h('h1', { id: 'field-guide-title' }, h('span', { id: 'field-guide-heading' }), h('span', { 'aria-hidden': 'true' }, '.'))),
  );
  const list = pages.pagesOf(doc, doc.URL);
  assert.deepEqual(list.map((p) => p.name), ['Choose your companion', 'field-guide']);
  assert.equal(pages.partsOf(list[0].element)[0].name, 'Choose your companion');
  assert.equal(pages.spokenText(null), '');
  assert.equal(pages.spokenText({ textContent: '  no   child nodes ' }), 'no child nodes', 'a stub without childNodes gives its textContent');
});

test('pageRef: the entry file plus the shown page\'s hash, never the preview URL with its cache-buster', () => {
  const url = 'http://127.0.0.1:4747/preview/p_1/head/dist/welcome/index.html?t=1794012590488#bond';
  assert.equal(pages.pageRef({ url, page: { key: 'index.html#choose', name: 'Choose' } }), 'dist/welcome/index.html#choose', 'the shown page wins over a hash the page did not answer to');
  assert.equal(pages.pageRef({ url, page: { key: 'index.html', name: 'Index' } }), 'dist/welcome/index.html#bond', 'a page with no screen keeps the URL\'s hash');
  assert.equal(pages.pageRef({ url: 'https://localhost/welcome/index.html#case' }), 'https://localhost/welcome/index.html#case', 'not a preview URL: as it is');
  assert.equal(pages.pageRef({}), '');
});

test('partsOf: two levels of landmarks, headings and named groups, each with a selector that finds it again', () => {
  const d = harbor();
  const shown = pages.pagesOf(d, d.URL).find((p) => p.visible);
  const parts = pages.partsOf(shown.element);
  assert.deepEqual(parts.map((p) => [p.name, p.tag, p.selector]), [
    ['The case', 'header', '#case > header:nth-of-type(1)'],
    ['Event grid', 'ul', '#case-grid'],
    ['Navigation', 'nav', '#case > nav:nth-of-type(1)'],
  ]);
  assert.deepEqual(parts[0].children.map((c) => [c.name, c.tag]), [['The case', 'h2']]);
  for (const p of parts) assert.equal(pages.elementAt(d, p.selector), p.element, p.selector);
  assert.equal(pages.selectorOf(d.body.children[1].children[1].children[0].children[1]), '#case-grid > li:nth-of-type(2)');
  const hidden = pages.partsOf(d.body.children[0]);
  assert.deepEqual(hidden.map((p) => p.name), ['Your account', 'login'], 'a hidden page still lists its own parts when asked');
});

test('footerLine, auraLine and the aura lines of preview pins say only what is recorded', () => {
  const v4 = { id: 'v4', n: 4, verified: { by: 'manual' } };
  const v5 = { id: 'v5', n: 5 };
  assert.equal(pages.footerLine({ versions: [v4, v5], ref: 'head', current: v4, dirty: false, width: 390.4 }), 'Preview · #4 · 390 px · verified');
  assert.equal(pages.footerLine({ versions: [v4, v5], ref: 'head', current: v4, dirty: true, width: 1200 }), 'Preview · files on disk · 1200 px · not verified');
  assert.equal(pages.footerLine({ versions: [v4, v5], ref: 'v5', current: v4, width: 0 }), 'Preview · #5 · width unknown · not verified');
  const ui = { pageInView: { key: 'index.html#case', name: 'The case' }, pages: { 'index.html#case': { aura: ' calm,  careful ' } } };
  assert.equal(pages.auraLine(ui), 'Aura of The case: calm, careful');
  assert.equal(pages.auraLine({ ...ui, pages: {} }), null, 'no note, no line');
  assert.equal(pages.auraLine({}), null);
  const pins = [{ source: 'phone', pageKey: 'index.html#case' }, { source: 'preview', pageKey: 'index.html#case', pageName: 'The case' }, { source: 'preview', pageKey: 'index.html#account' }];
  assert.deepEqual(pages.auraLinesForPins(ui, pins), ['Aura of The case: calm, careful']);
});

test('the companion\'s context pack carries the aura of the page in view, and nothing when no note is kept', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-aura-'));
  try {
    await fsp.mkdir(path.join(dir, 'src'));
    await fsp.writeFile(path.join(dir, 'src', 'index.html'), '<h1>Hi</h1>');
    await fsp.writeFile(path.join(dir, 'src', 'about.html'), '<h1>About</h1>');
    const project = { id: 'p_1', name: 'Harbor', ui: { pageInView: { key: 'index.html#case', name: 'The case' }, pages: { 'index.html#case': { aura: 'careful' } } } };
    const pack = await contextPack({ project, manifest: { kind: 'web-app', entry: 'src/index.html' }, path: dir });
    assert.match(pack, /\nOther pages beside it: src\/about\.html\nAura of The case: careful\nOpen pins: none\n/);
    const none = await contextPack({ project: { ...project, ui: { pageInView: project.ui.pageInView } }, manifest: { entry: 'src/index.html' }, path: dir });
    assert.doesNotMatch(none, /Aura/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------- the panel on a stub panel DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, disabled: false, value: '', title: '' });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) };
    this.rect = { left: 0, top: 0, width: 1000, height: 300 };
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
const toasts = [];
const copied = [];
const opened = []; // app.openSource calls
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
const buttonNamed = (root, text) => find(root, (n) => n.tag === 'button' && n.kids[0] === text)[0];

globalThis.document = { activeElement: null };
globalThis.window = new EventTarget();
const net = { calls: [], answers: {} };
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  net.calls.push({ method, url, body });
  const path = url.replace(/^\/api\/projects\/p_1/, '');
  const a = net.answers[`${method} ${path}`];
  const [status, data] = typeof a === 'function' ? a(body) : a || [404, { error: { code: 'none', message: `no answer for ${method} ${path}` } }];
  return { ok: status < 400, status, json: async () => data };
};

const source = (await fsp.readFile(new URL('../workbenches/page/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\/components\/ui\.js';/, 'const { el, clear, button, toast, copyText } = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/pages\.js';/, 'const {$1} = globalThis.__pages;');
globalThis.__ui = ui;
globalThis.__pages = pages;
const panel = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };

function setup({ doc = harbor(), frame: frameOver = {}, ui: projUi = {} } = {}) {
  net.calls = [];
  net.answers = {
    'GET /page/files': [200, { entry: 'dist/welcome/index.html', siblings: [] }],
    'POST /page/inspect': [200, { ok: true, candidates: [{ file: 'dist/welcome/index.html', line: 12, matched: ['pocket', 'Lantern festival'] }], searched: 'dist/welcome' }],
    'POST /companion/pins': (body) => [200, { id: 'pin_1', ...body }],
  };
  toasts.length = 0;
  copied.length = 0;
  opened.length = 0;
  const project = { id: 'p_1', name: 'Harbor', ui: { ...projUi } };
  const saves = [];
  const frameListeners = {};
  const frame = {
    contentDocument: doc, contentWindow: {}, getBoundingClientRect: () => ({ width: 390, height: 700 }),
    addEventListener(t, f) { (frameListeners[t] ||= []).push(f); }, removeEventListener(t, f) { frameListeners[t] = (frameListeners[t] || []).filter((x) => x !== f); },
    fire(t) { for (const f of frameListeners[t] || []) f({}); },
    ...frameOver,
  };
  const busListeners = {};
  const bundle = { project, versions: [{ id: 'v3', n: 3 }], changes: { sinceVersionId: 'v3', dirty: false } };
  const ctx = {
    projectId: 'p_1', get project() { return project; }, previewFrame: frame,
    bus: { on(name, fn) { (busListeners[name] ||= []).push(fn); return () => {}; } },
    app: { state: { bundle }, workbench: { previewRef: () => 'head' }, openSource: (o) => { opened.push(o); return Promise.resolve(true); } },
    saveUi: async (partial) => { saves.push(partial); project.ui = { ...project.ui, ...partial }; return project.ui; },
    setCount: (n) => { ctx.count = n; },
  };
  const container = el('div');
  panel.mount(container, ctx);
  return { container, ctx, doc, frame, project, saves, busListeners };
}

afterEach(() => panel.unmount());

test('the panel lists the numbered pages with the visible one marked, its parts, and the footer line', async () => {
  const p = setup();
  await flush();
  const rows = byClass(p.container, 'page-row');
  assert.deepEqual(rows.map((r) => [byClass(r, 'page-name')[0].kids[0], byClass(r, 'page-n')[0].kids[0], r.attrs['aria-current']]), [['Your account', '01', 'false'], ['The case', '02', 'page']]);
  assert.deepEqual(byClass(p.container, 'page-part').map((b) => b.kids[0].kids[0]), ['The case', 'The case', 'Event grid', 'Navigation']);
  assert.equal(byClass(p.container, 'page-footer')[0].textContent, 'Preview · #3 · 390 px · not verified');
  assert.equal(p.ctx.count, 2);
  assert.deepEqual(p.saves[0], { pageInView: { key: 'index.html#case', name: 'The case' } }, 'the visible page is remembered for the companion');
});

test('selecting a part outlines it on the preview at its box with its label; deselect, a reload and unmount remove it', async () => {
  const p = setup();
  await flush();
  p.doc.defaultView.scrollY = 30;
  const grid = find(p.container, (n) => n.dataset.selector === '#case-grid')[0];
  grid.fire('click');
  const overlay = p.doc.getElementById(pages.OVERLAY_ID);
  assert.ok(overlay, 'one outline in the frame document');
  assert.equal(overlay.parentElement, p.doc.documentElement);
  assert.deepEqual([overlay.style.position, overlay.style.left, overlay.style.top, overlay.style.width, overlay.style.height, overlay.style.pointerEvents], ['absolute', '20px', '170px', '300px', '220px', 'none']);
  assert.equal(overlay.firstChild.textContent.trim(), 'Event grid selected');
  // It follows a scroll.
  p.doc.defaultView.scrollY = 0;
  for (const f of p.doc.listeners.scroll || []) f({});
  assert.equal(p.doc.getElementById(pages.OVERLAY_ID).style.top, '140px');
  const again = find(p.container, (n) => n.dataset.selector === '#case-grid')[0];
  assert.equal(again.attrs['aria-selected'], 'true');
  again.fire('click');
  assert.equal(p.doc.getElementById(pages.OVERLAY_ID), null, 'a second click deselects and removes the outline');

  find(p.container, (n) => n.dataset.selector === '#case-grid')[0].fire('click');
  p.frame.fire('load');
  assert.equal(p.doc.getElementById(pages.OVERLAY_ID), null, 'a frame load drops the selection');
  find(p.container, (n) => n.dataset.selector === '#case-grid')[0].fire('click');
  panel.unmount();
  assert.equal(p.doc.getElementById(pages.OVERLAY_ID), null, 'unmount (a project switch) removes it');
});

test('Point: a click in the frame is held back, read, searched for and shown; Pin posts a preview pin', async () => {
  const p = setup();
  await flush();
  buttonNamed(p.container, 'Point').fire('click');
  assert.equal(buttonNamed(p.container, 'Point').attrs['aria-pressed'], 'true');
  const li = p.doc.getElementById('case-grid').children[0];
  for (const type of ['pointerdown', 'click']) {
    const ev = { type, target: li, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
    p.doc.defaultView.fire(type, ev); // capture on the frame's window, the top of the path
    assert.equal(ev.prevented, true, `${type} does not reach the page`);
  }
  await flush();
  const ask = net.calls.find((c) => c.method === 'POST' && c.url.endsWith('/page/inspect'));
  assert.deepEqual(ask.body, { selector: '#case-grid > li:nth-of-type(1)', id: null, classes: ['pocket'], text: 'Lantern festival', page: 'dist/welcome/index.html' });
  const readout = byClass(p.container, 'page-readout')[0].textContent;
  assert.match(readout, /li\.pocket/);
  assert.match(readout, /Lantern festival/);
  assert.match(readout, /The case/);
  assert.ok(p.doc.getElementById(pages.OVERLAY_ID), 'the pointed element is outlined');
  // The file candidate opens in the Source tab at its line (decision row 67 revised); Copy beside the list copies.
  buttonNamed(p.container, 'dist/welcome/index.html:12').fire('click');
  assert.deepEqual(opened, [{ path: 'dist/welcome/index.html', line: 12 }]);
  assert.deepEqual(copied, [], 'a click copies nothing');
  buttonNamed(p.container, 'Copy').fire('click');
  await flush();
  assert.deepEqual(copied, ['dist/welcome/index.html:12']);
  assert.match(toasts.at(-1)[0], /^Copied 1 file as file:line$/);

  buttonNamed(p.container, 'Copy for a task').fire('click');
  await flush();
  assert.match(copied.at(-1), /^Preview point: The case \(dist\/welcome\/index\.html#case\)\nElement: li\.pocket \(selector #case-grid > li:nth-of-type\(1\)\)\nText: "Lantern festival"\nFiles:\n- dist\/welcome\/index\.html:12/);

  buttonNamed(p.container, 'Pin').fire('click');
  await flush();
  const pinCall = net.calls.find((c) => c.url.endsWith('/companion/pins'));
  assert.deepEqual(pinCall.body, {
    source: 'preview', element: 'li.pocket', text: 'Lantern festival', selector: '#case-grid > li:nth-of-type(1)', point: null,
    files: ['dist/welcome/index.html:12'], page: 'dist/welcome/index.html#case', pageKey: 'index.html#case', pageName: 'The case',
  });
  // The server stores it as it is: a preview pin with no device point.
  const stored = checkPin(pinCall.body);
  assert.equal(stored.source, 'preview');
  assert.equal(stored.point, null);
  assert.equal(stored.pageKey, 'index.html#case');
  assert.match(toasts.at(-1)[0], /Pinned li\.pocket/);

  // Esc in the frame leaves Point; the next click reaches the page.
  p.doc.defaultView.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(buttonNamed(p.container, 'Point').attrs['aria-pressed'], 'false');
  const free = { type: 'click', target: li, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  p.doc.defaultView.fire('click', free);
  assert.equal(free.prevented, false);
});

test('Esc anywhere in the studio leaves Point, not only with the focus in the panel or the frame', async () => {
  const p = setup();
  await flush();
  buttonNamed(p.container, 'Point').fire('click');
  assert.equal(buttonNamed(p.container, 'Point').attrs['aria-pressed'], 'true');
  globalThis.window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(buttonNamed(p.container, 'Point').attrs['aria-pressed'], 'false');
  panel.unmount();
  globalThis.window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); // nothing listens after unmount
});

test('Point on the preview and the Phone\'s Point are never both on', async () => {
  const p = setup();
  await flush();
  buttonNamed(p.container, 'Point').fire('click');
  globalThis.window.dispatchEvent(new CustomEvent('atelier:point-mode', { detail: { owner: 'phone' } }));
  assert.equal(buttonNamed(p.container, 'Point').attrs['aria-pressed'], 'false');
  const seen = [];
  const listen = (e) => seen.push(e.detail.owner);
  globalThis.window.addEventListener('atelier:point-mode', listen);
  buttonNamed(p.container, 'Point').fire('click');
  globalThis.window.removeEventListener('atelier:point-mode', listen);
  assert.deepEqual(seen, ['page'], 'turning it on tells the Phone panel to turn its own off');
});

test('the aura: saved per page in project.ui.pages, shown for the visible page, and carried as one line', async () => {
  const p = setup();
  await flush();
  const area = find(p.container, (n) => n.tag === 'textarea')[0];
  assert.equal(area.value, '');
  assert.match(byClass(p.container, 'page-aura-label')[0].textContent, /Aura · The case/);
  area.value = 'calm, a little careful';
  area.fire('input', { target: area });
  assert.match(byClass(p.container, 'page-aura')[0].textContent, /Not saved/);
  buttonNamed(p.container, 'Save').fire('click');
  await flush();
  assert.deepEqual(p.saves.at(-1), { pages: { 'index.html#case': { aura: 'calm, a little careful' } } });
  assert.equal(find(p.container, (n) => n.tag === 'textarea')[0].value, 'calm, a little careful', 'shown again from the record');
  assert.match(byClass(p.container, 'page-aura')[0].textContent, /Saved/);
  assert.equal(pages.auraLine(p.project.ui), 'Aura of The case: calm, a little careful');
  // Emptied and saved: the note goes, and with it the line.
  const area2 = find(p.container, (n) => n.tag === 'textarea')[0];
  area2.value = '  ';
  buttonNamed(p.container, 'Save').fire('click');
  await flush();
  assert.deepEqual(p.saves.at(-1), { pages: {} });
  assert.equal(pages.auraLine(p.project.ui), null);
});

test('not readable: another origin, no document or no body says so in plain words and shows no tree', async () => {
  for (const [frame, why] of [
    [{ contentDocument: null, contentWindow: {} }, 'the page in the frame is from another origin'],
    [{ contentDocument: { URL: 'http://127.0.0.1:4747/preview/p_1/head/x.html', body: null }, contentWindow: {} }, 'the document has no body'],
    [{ contentDocument: { URL: 'about:blank', body: {} }, contentWindow: {} }, 'the preview is not loaded'],
  ]) {
    const p = setup({ frame });
    await flush();
    const note = byClass(p.container, 'page-unreadable')[0];
    assert.equal(note.hidden, false);
    assert.equal(note.textContent, `The preview is not readable from here: ${why}.`);
    assert.equal(byClass(p.container, 'page-cols')[0].hidden, true);
    assert.equal(byClass(p.container, 'page-part').length, 0);
    panel.unmount();
  }
});
