// Arranging the dock: the real client/components/dock.js, ./dock-arrange.js and ./stage-side.js, and the phone's
// workbenches/phone/beside.js, on a stub DOM that knows parents, with fake panels (dock.js takes loadPanel). A tab
// lifts after 6 px, a drop reorders and saves project.ui.dockOrder (the whole ui map), a press without movement is
// a click, Alt+Arrow moves and announces, a drop on the stage puts the panel's container beside the preview
// (project.ui.stageSide) and dragging it back returns it, Reset clears both, a project switch applies that
// project's order. The layout by eye is scripts/ui-check/verify-dock-arrange.cjs's.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { orderKinds, moveTo, movedWords, dropAt, LIFT_PX } from '../client/components/dock-arrange.js';
import { createStageSide } from '../client/components/stage-side.js';
import { createBeside } from '../workbenches/phone/beside.js';

// ---------- a stub DOM with parents ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, parentNode: null, rect: null, _text: null });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on = !this.classes.has(c)) => (on ? this.classes.add(c) : this.classes.delete(c)) };
    this.style = { setProperty: (k, v) => { this.style[k] = v; }, removeProperty: (k) => { delete this.style[k]; } };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  fire(type, e = {}) {
    const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...e };
    for (const fn of [...(this.listeners[type] || [])]) fn(ev);
    return ev;
  }
  focus() { document.activeElement = this; }
  setPointerCapture() {}
  get firstChild() { return this.kids[0] ?? null; }
  get textContent() { return this._text ?? this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  set textContent(v) { this.setKids([]); this._text = String(v); }
  getBoundingClientRect() {
    if (this.rect) return this.rect;
    if (this.attrs.role === 'tab' && this.parentNode) { // tabs sit 100 px apart in the tab row at y 500
      const i = this.parentNode.kids.filter((k) => k instanceof N && k.attrs.role === 'tab').indexOf(this);
      return { left: 100 * i, top: 500, width: 100, height: 36 };
    }
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  setKids(list) {
    for (const k of this.kids) if (k instanceof N) k.parentNode = null;
    this.kids = [];
    this._text = null;
    for (const k of list) this.append(k);
  }
  append(...xs) { for (const x of xs) { if (x instanceof N) { x.remove(); x.parentNode = this; } this.kids.push(x instanceof N ? x : String(x)); } }
  insertBefore(x, ref) {
    x.remove();
    x.parentNode = this;
    const i = ref ? this.kids.indexOf(ref) : -1;
    if (i < 0) this.kids.push(x); else this.kids.splice(i, 0, x);
  }
  remove() { const p = this.parentNode; if (!p) return; p.kids = p.kids.filter((k) => k !== this); this.parentNode = null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  all() { return this.kids.filter((k) => k instanceof N).flatMap((k) => [k, ...k.all()]); }
  matches(sel) {
    let m;
    if ((m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/))) {
      const [, k, v] = m;
      if (k.startsWith('data-')) return this.dataset[k.slice(5)] === v;
      return this.attrs[k] === v;
    }
    if (sel.startsWith('.')) return this.classes.has(sel.slice(1));
    return this.tag === sel;
  }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function el(spec, props, ...children) {
  if (props === null || props === undefined || props instanceof N || typeof props !== 'object' || Array.isArray(props)) { children.unshift(props); props = null; }
  const node = new N(spec);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('aria') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.setKids(flatten(children));
  return node;
}
const toasts = [];
const ui = {
  el,
  clear: (node, ...children) => { node.setKids(flatten(children)); return node; },
  button: (text, { onclick, title, small, variant, icon, ...rest } = {}) => el('button', { onclick, title, ...rest }, text),
  loading: (text) => el('div.loading', text),
  toast: (message, opts) => { toasts.push([message, opts?.tone]); },
};

// ---------- the browser around it ----------
const docListeners = {};
globalThis.document = {
  activeElement: null,
  addEventListener(t, f) { (docListeners[t] ||= []).push(f); },
  removeEventListener(t, f) { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); },
};
const docFire = (type, e = {}) => {
  const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...e };
  for (const f of [...(docListeners[type] || [])]) f(ev);
  return ev;
};
const store = {};
globalThis.sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
globalThis.window = { innerHeight: 900, innerWidth: 1500 };
globalThis.location = { origin: 'http://127.0.0.1:4747' };

const source = (await fsp.readFile(new URL('../client/components/dock.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\.\/ui\.js';/, 'const { el, clear, button, loading, toast } = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/companion-words\.js';/, 'const {$1} = globalThis.__words;')
  .replace(/import \{([^}]*)\} from '\.\/dock-arrange\.js';/, 'const {$1} = globalThis.__arrange;');
globalThis.__ui = ui;
globalThis.__words = await import('../client/components/companion-words.js');
globalThis.__arrange = await import('../client/components/dock-arrange.js');
const { createDock, panelKinds } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

// ---------- fake panels: they count mounts, so a move that remounted would show ----------
let mounts = [];
let unmounts = [];
const watched = []; // [kind, ctx] of every watchCount call; stopped: the kinds whose stop ran
const stopped = [];
function fakePanel(kind) {
  if (kind === 'phone') { // the real beside.js around a stand-in screen
    let b = null;
    return { mount(container, ctx) {
      mounts.push(kind);
      const screen = el('div.phone-screen', 'screen');
      const line = el('p.line', { hidden: true });
      const phone = el('div.phone', screen, line);
      const box = el('input');
      container.append(phone);
      b = createBeside({ ctx, screen, phone, line, box, host: container });
      fakes.phone = { screen, phone, line, box };
    }, unmount() { unmounts.push(kind); b?.destroy(); }, update() { b?.place(); } };
  }
  const panel = { mount(container) { mounts.push(kind); container.append(el(`div.fake-${kind}`, kind)); }, unmount() { unmounts.push(kind); } };
  // The terminal reports its running shells before it mounts, as the real panel's watchCount does.
  if (kind === 'terminal') panel.watchCount = (ctx) => { watched.push([kind, ctx]); ctx.setCount(2); return () => stopped.push(kind); };
  return panel;
}
const fakes = {};

function setup({ ui: projectUi = {}, manifest = {}, width = 1500 } = {}) {
  const win = { width };
  const wrap = new N('div.preview-wrap');
  wrap.rect = { left: 0, top: 0, width: 1000, height: 400 }; // the stage, above the tab row at y 500
  const aside = new N('aside.stage-side');
  wrap.append(aside);
  const stageSide = createStageSide({ node: aside, host: wrap, width: () => win.width });
  const patches = [];
  const app = {
    state: { bundle: null },
    api: { patchProject: async (id, body) => { patches.push({ id, ...JSON.parse(JSON.stringify(body)) }); return { ui: body.ui }; } },
  };
  const dock = createDock(app, { bus: {}, frame: { contentWindow: null }, setPreviewWidth() {}, stageHeight: () => 800, stageSide, loadPanel: async (k) => fakePanel(k), kinds: (m) => panelKinds(m, { phone: true }).filter((k) => k !== 'codex') }); // the arranging is the same with or without the Codex tab; the drags below were measured without it
  const open = (id, uiMap, man = manifest) => {
    app.state.bundle = { project: { id, ui: { ...uiMap } }, manifest: man };
    dock.setProject(app.state.bundle);
  };
  open('p_1', projectUi);
  const tablist = dock.node.querySelector('[role="tablist"]');
  const tabsNow = () => tablist.querySelectorAll('[role="tab"]');
  const order = () => tabsNow().map((t) => t.dataset.kind);
  const tab = (k) => tabsNow().find((t) => t.dataset.kind === k);
  const body = dock.node.querySelector('.dock-body');
  const live = dock.node.querySelector('.dock-live');
  const host = (k) => [...body.kids, ...aside.kids].find((c) => c instanceof N && c.classes.has('wbp-host') && c.querySelector(`.fake-${k}`));
  const resize = (w) => { win.width = w; stageSide.measure(); };
  const project = () => app.state.bundle.project;
  /** A pointer drag: press on the tab at its middle, move to (x, y) in steps, release; then the click a browser sends. */
  const dragTab = (k, x, y, { click = true } = {}) => {
    const t = tab(k);
    const r = t.getBoundingClientRect();
    const sx = r.left + 50; const sy = 518;
    t.fire('pointerdown', { button: 0, clientX: sx, clientY: sy, pointerId: 1 });
    docFire('pointermove', { clientX: (sx + x) / 2, clientY: (sy + y) / 2 });
    docFire('pointermove', { clientX: x, clientY: y });
    docFire('pointerup', { clientX: x, clientY: y });
    if (click) t.fire('click');
  };
  return { dock, app, wrap, aside, stageSide, patches, open, order, tab, body, live, host, resize, project, dragTab, tabsNow };
}

beforeEach(() => { mounts = []; unmounts = []; watched.length = 0; stopped.length = 0; toasts.length = 0; for (const k of Object.keys(store)) delete store[k]; for (const k of Object.keys(docListeners)) delete docListeners[k]; document.activeElement = null; });

test('orderKinds: the person\'s order, unknown kinds ignored, a kind it does not name at its default place', () => {
  const kinds = ['companion', 'page', 'source', 'terminal', 'phone'];
  assert.deepEqual(orderKinds(kinds, undefined), kinds);
  assert.deepEqual(orderKinds(kinds, ['terminal', 'companion', 'page', 'source', 'phone']), ['terminal', 'companion', 'page', 'source', 'phone']);
  assert.deepEqual(orderKinds(kinds, ['source', 'audio', 'companion', 'source']), ['source', 'terminal', 'phone', 'companion', 'page'],
    'audio is ignored, the repeat too; terminal and phone follow source as in the default, page follows companion');
  assert.deepEqual(orderKinds(['companion', 'page'], ['page']), ['companion', 'page'], 'nothing before it in the default: first');
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.equal(movedWords(['page', 'companion'], 'page', (k) => k[0].toUpperCase() + k.slice(1)), 'Page moved before Companion');
  assert.equal(movedWords(['companion', 'page'], 'page', (k) => k[0].toUpperCase() + k.slice(1)), 'Page moved after Companion');
  assert.deepEqual(dropAt([{ left: 0, width: 100 }, { left: 200, width: 100 }], 260), { index: 2, line: 300 });
  assert.deepEqual(dropAt([{ left: 0, width: 100 }, { left: 200, width: 100 }], 40), { index: 0, line: 0 });
  assert.equal(LIFT_PX, 6);
});

test('a press without movement stays a click; 5 px does not lift; 6 px lifts the tab', async () => {
  const s = setup();
  await flush();
  assert.deepEqual(s.order(), ['companion', 'page', 'source', 'terminal']);
  const page = s.tab('page');
  page.fire('pointerdown', { button: 0, clientX: 150, clientY: 518 });
  docFire('pointerup', { clientX: 150, clientY: 518 });
  page.fire('click');
  await flush();
  assert.equal(s.tab('page').attrs['aria-selected'], 'true', 'the click selected the tab');
  assert.equal(s.patches.some((p) => 'dockOrder' in p.ui), false, 'and arranged nothing');

  s.tab('source').fire('pointerdown', { button: 0, clientX: 250, clientY: 518 });
  docFire('pointermove', { clientX: 255, clientY: 518 });
  assert.equal(s.tab('source').classes.has('lifted'), false, '5 px: still a press');
  docFire('pointermove', { clientX: 256, clientY: 518 });
  assert.ok(s.tab('source').classes.has('lifted'), '6 px: lifted');
  assert.ok(s.dock.node.classes.has('arranging'));
  docFire('keydown', { key: 'Escape' });
  assert.equal(s.tab('source').classes.has('lifted'), false, 'Esc puts it down where it was');
  assert.deepEqual(s.order(), ['companion', 'page', 'source', 'terminal']);
});

test('a drop reorders, shows the line on the way, saves dockOrder with the whole ui, keeps every panel mounted', async () => {
  const s = setup({ ui: { dockTab: 'page', dockHeight: 300, companionSessionId: 'cs_1' } });
  await flush();
  s.tab('companion').fire('click'); // mount a second panel
  await flush();
  const before = [...mounts];
  const companionHost = s.host('companion');
  const page = s.tab('page');
  page.fire('pointerdown', { button: 0, clientX: 150, clientY: 518 });
  docFire('pointermove', { clientX: 300, clientY: 518 });
  docFire('pointermove', { clientX: 360, clientY: 518 });
  const line = s.dock.node.querySelector('.dock-drop-line');
  assert.equal(line.hidden, false, 'the drop line shows where it will land');
  assert.equal(line.style.left, '400px', 'after the last tab');
  docFire('pointerup', { clientX: 360, clientY: 518 });
  page.fire('click'); // the click a browser sends after the pointerup
  await flush();
  assert.equal(line.hidden, true);
  assert.deepEqual(s.order(), ['companion', 'source', 'terminal', 'page']);
  const saved = s.patches.filter((p) => 'dockOrder' in p.ui).at(-1);
  assert.deepEqual(saved.ui.dockOrder, ['companion', 'source', 'terminal', 'page']);
  assert.equal(saved.ui.dockHeight, 300, 'the whole ui map goes out');
  assert.equal(saved.ui.companionSessionId, 'cs_1');
  assert.equal(s.tab('companion').attrs['aria-selected'], 'true', 'the drop was not a click on Page: the active tab stays');
  assert.deepEqual(mounts, before, 'nothing remounted');
  assert.equal(s.host('companion'), companionHost);
  assert.equal(s.live.textContent, 'Page moved after Terminal');
});

test('Alt+Arrow moves the focused tab one place and announces it; a plain arrow still walks the tabs', async () => {
  const s = setup();
  await flush();
  s.tab('page').focus();
  const ev = s.tab('page').fire('keydown', { key: 'ArrowLeft', altKey: true });
  assert.equal(ev.defaultPrevented, true, 'Alt+Left does not go Back');
  assert.deepEqual(s.order(), ['page', 'companion', 'source', 'terminal']);
  assert.equal(s.live.textContent, 'Page moved before Claude Code');
  assert.equal(document.activeElement, s.tab('page'), 'the focus stays on the moved tab');
  assert.deepEqual(s.patches.at(-1).ui.dockOrder, ['page', 'companion', 'source', 'terminal']);
  s.tab('page').fire('keydown', { key: 'ArrowLeft', altKey: true });
  assert.equal(s.live.textContent, 'Page is already first');
  s.tab('page').fire('keydown', { key: 'ArrowRight', altKey: true });
  s.tab('page').fire('keydown', { key: 'ArrowRight', altKey: true });
  assert.deepEqual(s.order(), ['companion', 'source', 'page', 'terminal']);
  assert.equal(s.live.textContent, 'Page moved before Terminal');
  s.tab('companion').fire('keydown', { key: 'ArrowRight' });
  await flush();
  assert.equal(s.tab('source').attrs['aria-selected'], 'true', 'plain ArrowRight selects the next tab in the drawn order');
});

test('a drop on the stage puts the panel\'s container beside the preview; dragging it back returns it', async () => {
  const s = setup({ ui: { dockTab: 'page' } });
  await flush();
  const pageHost = s.host('page');
  assert.ok(pageHost);
  const page = s.tab('page');
  page.fire('pointerdown', { button: 0, clientX: 150, clientY: 518 });
  docFire('pointermove', { clientX: 500, clientY: 200 });
  assert.equal(s.aside.hidden, false, 'the slot shows as a drop target');
  assert.ok(s.aside.classes.has('drop-target'));
  assert.match(s.aside.querySelector('.side-drop').textContent, /^Beside the preview/);
  docFire('pointerup', { clientX: 500, clientY: 200 });
  page.fire('click');
  await flush();
  assert.equal(s.project().ui.stageSide, 'page');
  assert.equal(s.patches.at(-1).ui.stageSide, 'page');
  assert.equal(pageHost.parentNode, s.aside, 'the same container, moved');
  assert.equal(pageHost.hidden, false);
  assert.deepEqual(mounts, ['page'], 'not remounted');
  assert.equal(s.aside.querySelector('.side-drop'), null, 'the target words are gone');
  assert.ok(s.wrap.classes.has('has-side'));
  assert.ok(s.tab('page').querySelector('.tab-side'), 'the tab carries the beside mark');
  assert.equal(s.tab('page').attrs['aria-selected'], 'true', 'still the active tab');
  assert.equal(s.body.querySelector('.dock-away').textContent, 'Page is beside the preview.');
  const head = s.aside.querySelector('.side-head');
  assert.equal(head.hidden, false);
  assert.equal(head.querySelector('.side-name').textContent, 'Page');

  // back: from the slot's head down onto the tabs
  head.querySelector('.side-handle').fire('pointerdown', { button: 0, clientX: 900, clientY: 20 });
  docFire('pointermove', { clientX: 120, clientY: 300 });
  docFire('pointermove', { clientX: 120, clientY: 518 });
  docFire('pointerup', { clientX: 120, clientY: 518 });
  await flush();
  assert.equal(s.project().ui.stageSide, null);
  assert.equal(pageHost.parentNode, s.body, 'back in the dock body');
  assert.equal(s.aside.hidden, true);
  assert.equal(s.wrap.classes.has('has-side'), false);
  assert.equal(s.tab('page').querySelector('.tab-side'), null);
  assert.equal(s.body.querySelector('.dock-away').hidden, true);
  assert.deepEqual(mounts, ['page']);
  assert.equal(s.live.textContent, 'Page back in the dock');

  // and by keyboard: Alt+Up beside, Alt+Down back
  s.tab('page').fire('keydown', { key: 'ArrowUp', altKey: true });
  assert.equal(pageHost.parentNode, s.aside);
  s.tab('page').fire('keydown', { key: 'ArrowDown', altKey: true });
  assert.equal(pageHost.parentNode, s.body);
});

test('a tab dragged back from the stage by its own tab returns too; one panel in the slot at a time', async () => {
  const s = setup();
  await flush();
  s.dragTab('source', 500, 200);
  await flush();
  const sourceHost = s.host('source');
  assert.equal(sourceHost.parentNode, s.aside);
  s.dragTab('terminal', 500, 200);
  await flush();
  assert.equal(s.project().ui.stageSide, 'terminal');
  assert.equal(sourceHost.parentNode, s.body, 'source went back to the dock');
  assert.equal(s.aside.kids.filter((k) => k.classes?.has('wbp-host')).length, 1, 'one panel beside the preview');
  s.dragTab('terminal', 40, 518);
  await flush();
  assert.equal(s.project().ui.stageSide, null);
  assert.equal(s.order()[0], 'terminal', 'moved to where it was dropped, and back');
  assert.equal(s.aside.hidden, true);
});

test('the width rule: under 1440 px the slot empties into the dock and fills again when wide', async () => {
  const s = setup({ ui: { stageSide: 'source' } });
  await flush();
  const sourceHost = s.host('source') || s.aside.querySelector('.wbp-host');
  assert.equal(sourceHost.parentNode, s.aside, 'a kept stageSide is beside the preview on a wide window');
  s.resize(1200);
  assert.equal(sourceHost.parentNode, s.body);
  assert.equal(s.aside.hidden, true);
  assert.equal(s.project().ui.stageSide, 'source', 'kept');
  s.resize(1500);
  assert.equal(sourceHost.parentNode, s.aside, 'back when wide');
  s.resize(1200);
  s.dragTab('page', 500, 200);
  await flush();
  assert.equal(s.project().ui.stageSide, 'page', 'a drop on a narrow window is kept for later');
  assert.match(toasts.at(-1)[0], /Page goes beside the preview when the window is 1440 px or wider/);
});

test('Reset arrangement clears dockOrder and stageSide with one toast; it shows only when something is arranged', async () => {
  const s = setup();
  await flush();
  const reset = () => s.dock.node.querySelectorAll('button').find((b) => b.textContent === 'Reset arrangement');
  assert.equal(reset(), undefined, 'nothing to reset');
  s.tab('terminal').fire('keydown', { key: 'ArrowLeft', altKey: true });
  s.dragTab('page', 500, 200);
  await flush();
  assert.ok(reset());
  toasts.length = 0;
  reset().fire('click');
  await flush();
  assert.deepEqual(s.order(), ['companion', 'page', 'source', 'terminal']);
  const ui = s.patches.at(-1).ui;
  assert.equal(ui.dockOrder, null);
  assert.equal(ui.stageSide, null);
  assert.equal(s.aside.hidden, true);
  assert.equal(s.host('page').parentNode, s.body);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][0], 'Dock arrangement reset: the default tab order; nothing beside the preview.');
  assert.equal(reset(), undefined);
});

test('a project switch applies that project\'s order and slot; an unknown kind in either is ignored', async () => {
  const s = setup({ ui: { dockOrder: ['terminal', 'companion'], stageSide: 'source' } });
  await flush();
  assert.deepEqual(s.order(), ['terminal', 'companion', 'page', 'source']);
  assert.ok(s.aside.querySelector('.wbp-host'));
  s.open('p_2', { dockOrder: ['audio', 'source', 'zzz', 'companion'], stageSide: 'audio' });
  await flush();
  assert.deepEqual(s.order(), ['source', 'terminal', 'companion', 'page']);
  assert.equal(s.aside.querySelector('.wbp-host'), null, 'p_1\'s panel left the slot; audio is not a kind here');
  assert.equal(s.aside.hidden, true);
  assert.ok(unmounts.includes('source'));
  s.open('p_3', {});
  await flush();
  assert.deepEqual(s.order(), ['companion', 'page', 'source', 'terminal']);
});

test('a tab\'s count before its panel mounts: watchCount reports it, the panel\'s own count takes over at mount, a switch stops it', async () => {
  const s = setup();
  await flush();
  assert.deepEqual(mounts, ['companion'], 'only the active tab\'s panel mounted');
  assert.deepEqual(watched.map(([k]) => k), ['terminal'], 'the one module with a watchCount was asked, once');
  assert.equal(s.tab('terminal').querySelector('.tab-count')?.textContent, '2', 'the number is on the tab with the panel unmounted');
  assert.equal(s.tab('page').querySelector('.tab-count'), null);
  assert.deepEqual(stopped, []);
  s.tab('terminal').fire('click');
  await flush();
  assert.deepEqual(stopped, ['terminal'], 'mounting stops the watcher: the panel reports from here');
  assert.ok(mounts.includes('terminal'));
  watched[0][1].setCount(5);
  assert.equal(s.tab('terminal').querySelector('.tab-count')?.textContent, '5', 'the same setCount, now the panel\'s');
  s.open('p_2', {});
  await flush();
  assert.deepEqual(watched.map(([k]) => k), ['terminal', 'terminal'], 'the new project is watched afresh');
  assert.equal(s.tab('terminal').querySelector('.tab-count')?.textContent, '2');
  s.dock.destroy();
  assert.equal(stopped.length, 2, 'destroy stops the watcher too');
});

test('the phone: its screen keeps the default place, steps aside for a dragged panel, and Reset brings it back', async () => {
  const manifest = { devices: { android: {} } };
  assert.deepEqual(panelKinds(manifest, { phone: true }), ['companion', 'codex', 'page', 'source', 'terminal', 'phone']);
  const s = setup({ manifest });
  await flush();
  assert.equal(fakes.phone.screen.parentNode, s.aside, 'wide: the phone\'s screen is beside by default');
  assert.ok(s.tab('phone').querySelector('.tab-side'));
  s.dragTab('page', 500, 200);
  await flush();
  assert.equal(fakes.phone.screen.parentNode, fakes.phone.phone, 'the screen went home to the Phone tab');
  assert.equal(fakes.phone.box.checked, true, 'the switch still reads as the person set it');
  assert.equal(fakes.phone.line.hidden, false);
  assert.equal(fakes.phone.line.textContent, 'Page is beside the preview; the screen stays here until it comes back.');
  assert.equal(s.host('page').parentNode, s.aside);
  assert.equal(s.tab('phone').querySelector('.tab-side'), null);
  assert.ok(s.tab('page').querySelector('.tab-side'));
  toasts.length = 0;
  s.dock.node.querySelectorAll('button').find((b) => b.textContent === 'Reset arrangement').fire('click');
  await flush();
  assert.equal(s.host('page').parentNode, s.body);
  assert.equal(fakes.phone.screen.parentNode, s.aside, 'the default: the phone beside again');
  assert.equal(fakes.phone.line.textContent, 'The screen is beside the preview.');
  assert.equal(toasts[0][0], 'Dock arrangement reset: the default tab order; the phone\'s screen stays beside the preview (its switch is on).');
  // the Phone tab dragged back to the tabs: its switch goes off with it
  s.dragTab('phone', 120, 518);
  await flush();
  assert.equal(s.project().ui.phoneBeside, false);
  assert.equal(fakes.phone.screen.parentNode, fakes.phone.phone);
  assert.equal(fakes.phone.box.checked, false, 'off with the drag back');
  assert.equal(fakes.phone.line.hidden, true, 'the switch is off: nothing to explain');
  // and onto the stage again: on
  s.dragTab('phone', 500, 200);
  await flush();
  assert.equal(s.project().ui.stageSide, 'phone');
  assert.equal(s.project().ui.phoneBeside, true);
  assert.equal(fakes.phone.screen.parentNode, s.aside);
  assert.ok(mounts.filter((k) => k === 'phone').length === 1, 'the phone panel mounted once');
});

// ---------- the Learning view's dock (t_391f0z2rhl): the same dock with the Companion alone ----------
test('the Learning dock: one Claude Code tab, its own height key, never the Workbench\'s tab, order or slot; clearProject hides it', async () => {
  const view = await fsp.readFile(new URL('../client/views/learning.js', import.meta.url), 'utf8');
  const literal = view.match(/export const LEARNING_DOCK = (\{.*\});/)[1];
  const LEARNING_DOCK = new Function(`return ${literal}`)(); // the options the view really passes
  const patches = [];
  const app = { state: { bundle: null }, api: { patchProject: async (id, body) => { patches.push(JSON.parse(JSON.stringify(body))); return { ui: body.ui }; } } };
  const dock = createDock(app, { ...LEARNING_DOCK, bus: null, frame: null, setPreviewWidth() {}, stageHeight: () => 800, loadPanel: async (k) => fakePanel(k) });
  // The Workbench's arrangement and height are in project.ui: the Learning dock reads none of them.
  app.state.bundle = { project: { id: 'p_1', ui: { dockTab: 'terminal', dockOrder: ['terminal', 'companion'], stageSide: 'companion', dockHeight: 300, learningDockHeight: 420 } }, manifest: { kind: 'game' } };
  dock.setProject(app.state.bundle);
  await flush();
  const tablist = dock.node.querySelector('[role="tablist"]');
  const tabs = () => tablist.querySelectorAll('[role="tab"]');
  assert.deepEqual(tabs().map((t) => t.textContent), ['Claude Code'], 'Companion only: no Page, Source or Terminal');
  assert.equal(tablist.attrs['aria-label'], 'Learning panels');
  assert.equal(tabs()[0].attrs['aria-selected'], 'true', 'the Workbench\'s last tab (terminal) is not this dock\'s');
  assert.deepEqual(mounts, ['companion']);
  assert.equal(dock.node.style['--dock-h'], '420px', 'learningDockHeight, not dockHeight');
  assert.ok(dock.node.querySelector('.dock-grip'), 'the grip is there');
  const btn = (words) => dock.node.querySelectorAll('button').find((b) => b.textContent === words);
  assert.equal(btn('Reset arrangement'), undefined, 'the Workbench\'s dockOrder and stageSide are not offered for reset here');
  // No arranging: a press does not lift, Alt+arrows save nothing.
  assert.equal((tabs()[0].listeners.pointerdown || []).length, 0);
  tabs()[0].fire('keydown', { key: 'ArrowRight', altKey: true });
  tabs()[0].fire('keydown', { key: 'ArrowUp', altKey: true });
  await flush();
  assert.equal(patches.length, 0, 'nothing saved');
  // Hide by the chevron, show again by the tab: dockTab stays the Workbench's.
  dock.node.querySelectorAll('button').find((b) => b.attrs['aria-label'] === 'Hide panel').fire('click');
  assert.ok(dock.node.classes.has('collapsed'));
  tabs()[0].fire('click');
  await flush();
  assert.equal(dock.node.classes.has('collapsed'), false);
  assert.equal(patches.length, 0, 'a click on the tab does not become the Workbench\'s last tab');
  // The grip keeps its own key; a double-click gives the default back under the same key.
  const grip = dock.node.querySelector('.dock-grip');
  grip.fire('keydown', { key: 'ArrowUp' });
  await flush();
  assert.equal(patches.at(-1).ui.dockHeight, 300, 'the Workbench\'s height untouched');
  assert.equal(typeof patches.at(-1).ui.learningDockHeight, 'number');
  grip.fire('dblclick');
  await flush();
  assert.equal(patches.at(-1).ui.learningDockHeight, null);
  assert.equal(patches.at(-1).ui.dockHeight, 300);
  assert.equal(patches.at(-1).ui.dockTab, 'terminal');
  // show('companion') opens a collapsed dock (Ask about this goes into a box the person can see).
  dock.collapse(true);
  assert.equal(await dock.show('companion'), true);
  assert.equal(dock.node.classes.has('collapsed'), false);
  // No project: the panel unmounts (it keeps its box for the next mount) and the dock hides.
  dock.clearProject();
  assert.equal(dock.node.hidden, true);
  assert.deepEqual(unmounts, ['companion']);
  assert.equal(tabs().length, 0);
  dock.setProject(app.state.bundle);
  await flush();
  assert.equal(dock.node.hidden, false);
  assert.deepEqual(mounts, ['companion', 'companion']);
  dock.destroy();
});
