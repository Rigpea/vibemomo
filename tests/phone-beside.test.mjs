// The phone's screen beside the preview: the real workbenches/phone/panel.js, ./beside.js and
// client/components/stage-side.js on a stub DOM that knows parents (the phone panel tests' stub, plus append,
// insertBefore and remove). One screen node moves between the Phone tab and the stage's side slot: at 1440 px it goes
// beside, at 1416 px it comes back (24 px of hysteresis); the switch keeps it in the tab; taps and Point work on it
// there; unmount and a project switch take it out of the slot. Layout is scripts/ui-check/verify-phone-beside.cjs's.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import * as map from '../workbenches/phone/map.js';
import { createStageSide, wideFor, BESIDE_MIN, BESIDE_HYSTERESIS } from '../client/components/stage-side.js';

// ---------- a stub DOM with parents ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, disabled: false, value: '', open: false, src: '', alt: '', title: '', checked: false, parentNode: null });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) };
    this.scrollTop = 0; this.clientHeight = 100; this.scrollHeight = 100;
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
    this.naturalWidth = 0; this.naturalHeight = 0;
    this._text = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  fire(type, e = {}) {
    const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...e };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  focus() { document.activeElement = this; }
  getBoundingClientRect() { return this.rect; }
  get textContent() { return this._text ?? this.kids.map(textOf).join(' '); }
  set textContent(v) { this._text = String(v); this.setKids([]); }
  setKids(list) {
    for (const k of this.kids) if (k instanceof N && k.parentNode === this) k.parentNode = null;
    this.kids = [];
    for (const k of list) this.append(k);
  }
  append(...xs) {
    for (const x of xs) {
      if (x instanceof N) { x.remove(); x.parentNode = this; this.kids.push(x); } else this.kids.push(String(x));
    }
  }
  insertBefore(x, ref) {
    x.remove();
    const i = this.kids.indexOf(ref);
    x.parentNode = this;
    if (i < 0) this.kids.push(x); else this.kids.splice(i, 0, x);
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.kids = p.kids.filter((k) => k !== this);
    this.parentNode = null;
  }
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
  node.setKids(flatten(children));
  return node;
}
const toasts = [];
const ui = {
  el,
  clear: (node, ...children) => { node._text = null; node.setKids(flatten(children)); return node; },
  button: (text, { onclick, disabled, title, type = 'button', variant, small, ...rest } = {}) => el('button', { type, onclick, disabled, title, ...rest }, text),
  stateChip: (text, tone, title) => el(`span.chip.tone-${tone}`, { title }, text),
  toast: (message, opts) => { toasts.push([message, opts?.tone]); },
  copyText: async () => true,
};
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const find = (root, pred) => all(root).filter(pred);
const byClass = (root, c) => find(root, (n) => n.classes.has(c));
const buttonNamed = (root, text) => find(root, (n) => n.tag === 'button' && n.kids[0] === text)[0];

// ---------- the browser around it ----------
let observer = null;
globalThis.document = { hidden: false, activeElement: null, listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); } };
globalThis.IntersectionObserver = class { constructor(cb) { this.cb = cb; this.targets = []; observer = this; } observe(t) { this.targets.push(t); } disconnect() { this.targets = []; } };
globalThis.EventSource = class { constructor() { this.listeners = {}; } addEventListener() {} close() {} };
const loaders = [];
globalThis.Image = class extends N { constructor() { super('img'); loaders.push(this); } };
const arrive = (w = 1080, h = 2400) => { const l = loaders.at(-1); l.naturalWidth = w; l.naturalHeight = h; l.fire('load'); return l; };
const net = { calls: [], answers: {} };
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  net.calls.push({ method, url, body });
  const path = url.replace(/^\/api\/projects\/p_1\/phone/, '').replace(/\?.*$/, '') || '/';
  const a = net.answers[`${method} ${path}`];
  const [status, data] = typeof a === 'function' ? a(body) : a || [404, { error: { code: 'none', message: `no answer for ${method} ${path}` } }];
  return { ok: status < 400, status, json: async () => data };
};

const source = (await fsp.readFile(new URL('../workbenches/phone/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\/components\/ui\.js';/, 'const { el, clear, button, stateChip, toast, copyText } = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/map\.js';/, 'const {$1} = globalThis.__map;')
  .replace(/import \{([^}]*)\} from '\/components\/companion-words\.js';/, 'const {$1} = globalThis.__words;')
  .replace(/import \{([^}]*)\} from '\.\/beside\.js';/, 'const {$1} = globalThis.__beside;');
globalThis.__ui = ui;
globalThis.__map = map;
globalThis.__words = await import('../client/components/companion-words.js');
globalThis.__beside = await import('../workbenches/phone/beside.js');
const panel = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const TOOLS = { sdkRoot: 'C:\\sdk', adb: { path: 'adb.exe', found: true, source: 'settings', reason: null }, emulator: { path: 'emulator.exe', found: true, source: 'settings', reason: null } };
const STATUS = { providers: [{
  ok: true, id: 'android', label: 'Android', available: true, reason: null, tools: TOOLS,
  config: { avd: 'Pixel_7', appId: 'com.example.app', activity: '.MainActivity', build: null },
  build: { state: 'none', note: 'No build since the studio started' },
  devices: [{ serial: 'emulator-5554', state: 'device', emulator: true, avd: 'Pixel_7', booted: true }], target: 'emulator-5554',
  app: { appId: 'com.example.app', serial: 'emulator-5554', installed: true, running: true, pid: 4242 },
}] };
const INSPECT = {
  ok: true, serial: 'emulator-5554', pid: 4242, page: { url: 'https://localhost/#/start' },
  point: { device: { x: 540, y: 1200 }, dpr: 2.625, inset: 63, css: { x: 205.71, y: 433.14 } },
  element: { tag: 'button', id: 'start', classes: ['btn'], text: 'Start', selector: '#start', url: 'https://localhost/#/start', nodeName: 'BUTTON' },
  candidates: [{ file: 'src/index.html', line: 12, matched: ['start'] }], searched: 'src',
};

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };

/** The Workbench's stage around the panel: the preview-wrap, its aside, a window W px wide, and the project. */
async function setup(t, { width = 1200, ui: projectUi = {}, slot = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  net.answers = { 'GET /': [200, STATUS] };
  const win = { width };
  const wrap = new N('div.preview-wrap');
  const aside = new N('aside.stage-side');
  wrap.append(aside);
  const stageSide = slot ? createStageSide({ node: aside, host: wrap, width: () => win.width }) : null;
  const project = { id: 'p_1', ui: { ...projectUi } };
  const saves = [];
  const ctx = {
    projectId: 'p_1', manifest: { devices: { android: {} } }, app: {}, stageSide,
    project, // the dock's ctx reads app.state.bundle.project through a getter; a switch replaces it
    async saveUi(partial) { project.ui = { ...project.ui, ...partial }; saves.push({ ui: { ...project.ui } }); return project.ui; },
  };
  const container = new N('div.wbp-host');
  panel.mount(container, ctx);
  await flush();
  const n = panel._state().nodes;
  const resize = (w) => { win.width = w; stageSide.measure(); };
  const posts = (path) => net.calls.filter((c) => c.method === 'POST' && c.url.endsWith(path)).map((c) => c.body);
  return { container, wrap, aside, stageSide, ctx, project, saves, n, resize, posts };
}

afterEach(() => { panel.unmount(); net.calls.length = 0; toasts.length = 0; loaders.length = 0; document.hidden = false; });

test('wideFor: wide from 1440 px, narrow again at 1416 px or less, the last answer between', () => {
  assert.equal(BESIDE_MIN, 1440);
  assert.equal(BESIDE_HYSTERESIS, 24);
  assert.equal(wideFor(1440, false), true);
  assert.equal(wideFor(1439, false), false);
  assert.equal(wideFor(1430, true), true, 'inside the band a wide window stays wide');
  assert.equal(wideFor(1417, true), true);
  assert.equal(wideFor(1416, true), false);
  assert.equal(wideFor(1430, false), false, 'and a narrow one stays narrow');
  assert.equal(wideFor(NaN, true), true);
});

test('the screen node moves to the slot at 1440 and back into the tab at 1416, the same node, nothing reloaded', async (t) => {
  const s = await setup(t, { width: 1200 });
  const screen = s.n.screen;
  assert.equal(screen.parentNode, s.n.phone, 'narrow: the screen is in the tab');
  assert.equal(s.aside.hidden, true);
  assert.equal(s.wrap.classes.has('has-side'), false);
  assert.equal(s.n.besideLine.hidden, true);
  t.mock.timers.tick(0);
  arrive();
  const src = s.n.img.src;
  const frames = loaders.length;

  s.resize(1440);
  assert.equal(screen.parentNode, s.aside, 'wide: the screen sits beside the preview');
  assert.deepEqual(s.aside.kids, [screen], 'one screen in the slot');
  assert.equal(s.aside.hidden, false);
  assert.ok(s.wrap.classes.has('has-side'), 'the preview gives up the slot\'s width');
  assert.equal(s.n.besideLine.hidden, false);
  assert.equal(s.n.besideLine.textContent, 'The screen is beside the preview.');
  assert.ok(s.container.classes.has('beside'));
  assert.ok(byClass(s.n.phone, 'phone-side')[0], 'the controls stay in the tab');
  assert.equal(byClass(s.container, 'phone-img').length, 0, 'the tab holds no second screen');
  assert.equal(byClass(s.aside, 'phone-img')[0], s.n.img, 'the image itself moved');
  assert.equal(byClass(s.aside, 'phone-live')[0], s.n.live, 'with its live line');
  assert.equal(s.n.img.src, src, 'the image kept its frame');
  assert.equal(loaders.length, frames, 'and no frame was asked for by the move');

  s.resize(1430);
  assert.equal(screen.parentNode, s.aside, 'inside the 24 px band it stays');
  s.resize(1416);
  assert.equal(screen.parentNode, s.n.phone, 'at 1416 it comes back');
  assert.equal(s.n.phone.kids[0], screen, 'to its place, first in the tab');
  assert.equal(s.aside.hidden, true);
  assert.deepEqual(s.aside.kids, []);
  assert.equal(s.wrap.classes.has('has-side'), false);
  assert.equal(s.n.besideLine.hidden, true);
  assert.equal(s.container.classes.has('beside'), false);
  assert.equal(s.n.img.src, src);
});

test('the switch saves phoneBeside through saveUi and keeps the screen in the tab at every width', async (t) => {
  const s = await setup(t, { width: 1500 });
  assert.equal(s.n.besideBox.checked, true, 'on by default');
  assert.equal(s.n.screen.parentNode, s.aside);
  s.n.besideBox.checked = false;
  s.n.besideBox.fire('change');
  await flush();
  assert.deepEqual(s.saves.at(-1), { ui: { phoneBeside: false } }, 'the whole ui map, merged');
  assert.equal(s.n.screen.parentNode, s.n.phone, 'off: back in the tab');
  assert.equal(s.aside.hidden, true);
  s.resize(1200);
  s.resize(1600);
  assert.equal(s.n.screen.parentNode, s.n.phone, 'and it stays there when the window is wide again');
  s.n.besideBox.checked = true;
  s.n.besideBox.fire('change');
  await flush();
  assert.equal(s.project.ui.phoneBeside, true);
  assert.equal(s.n.screen.parentNode, s.aside, 'on again: beside');
});

test('a project whose switch is off starts with the screen in the tab; other ui keys survive the save', async (t) => {
  const s = await setup(t, { width: 1600, ui: { phoneBeside: false, dockTab: 'phone' } });
  assert.equal(s.n.besideBox.checked, false);
  assert.equal(s.n.screen.parentNode, s.n.phone);
  assert.equal(s.aside.hidden, true);
  s.n.besideBox.checked = true;
  s.n.besideBox.fire('change');
  await flush();
  assert.deepEqual(s.saves.at(-1), { ui: { phoneBeside: true, dockTab: 'phone' } });
});

test('a tap on the moved image posts input with the same mapping as in the tab', async (t) => {
  const s = await setup(t, { width: 1200 });
  net.answers['POST /input'] = (body) => [200, { ok: true, command: JSON.stringify(body) }];
  t.mock.timers.tick(0);
  arrive();
  s.n.img.rect = { left: 10, top: 20, width: 270, height: 600 };
  s.n.img.fire('pointerdown', { button: 0, clientX: 145, clientY: 320, timeStamp: 0, pointerId: 1 });
  s.n.img.fire('pointerup', { clientX: 145, clientY: 320, timeStamp: 50 });
  s.resize(1500);
  // Beside the preview the image is drawn elsewhere and at another size; the mapping follows its box.
  s.n.img.rect = { left: 1200, top: 60, width: 324, height: 720 };
  s.n.img.fire('pointerdown', { button: 0, clientX: 1362, clientY: 420, timeStamp: 100, pointerId: 1 });
  s.n.img.fire('pointerup', { clientX: 1362, clientY: 420, timeStamp: 150 });
  s.n.img.fire('keydown', { key: 'Escape' });
  await flush();
  assert.deepEqual(s.posts('/phone/input'), [{ type: 'tap', x: 540, y: 1200 }, { type: 'tap', x: 540, y: 1200 }, { type: 'key', key: 'back' }]);
});

test('Point mode on the moved image: the crosshair class, a tap reads the element, Esc on the screen leaves it', async (t) => {
  const s = await setup(t, { width: 1500 });
  net.answers['POST /inspect'] = [200, INSPECT];
  t.mock.timers.tick(0);
  arrive();
  assert.equal(s.n.screen.parentNode, s.aside);
  buttonNamed(s.container, 'Point mode').fire('click');
  assert.ok(s.n.img.classes.has('pointing'), 'the crosshair applies beside the preview too');
  s.n.img.rect = { left: 1200, top: 60, width: 324, height: 720 };
  s.n.img.fire('pointerdown', { button: 0, clientX: 1362, clientY: 420, timeStamp: 0, pointerId: 1 });
  s.n.img.fire('pointerup', { clientX: 1362, clientY: 420, timeStamp: 40 });
  await flush();
  assert.deepEqual(s.posts('/phone/inspect'), [{ x: 540, y: 1200 }]);
  assert.deepEqual(s.posts('/phone/input'), []);
  assert.match(byClass(s.container, 'phone-readout')[0].textContent, /button#start\.btn/, 'the readout is in the tab');
  s.resize(1200);
  assert.ok(s.n.img.classes.has('pointing'), 'a move keeps Point mode');
  assert.match(byClass(s.container, 'phone-readout')[0].textContent, /button#start\.btn/, 'and the readout');
  s.resize(1500);
  const esc = s.n.screen.fire('keydown', { key: 'Escape' });
  assert.equal(esc.defaultPrevented, true);
  assert.equal(buttonNamed(s.container, 'Point mode').attrs['aria-pressed'], 'false', 'Esc beside the preview leaves Point mode');
});

test('beside the preview the stream runs with the Phone tab hidden; out of sight in both places it stops', async (t) => {
  const s = await setup(t, { width: 1500 });
  t.mock.timers.tick(0);
  arrive();
  observer.cb([{ target: s.container, isIntersecting: false }, { target: s.n.screen, isIntersecting: true }]);
  const before = loaders.length;
  t.mock.timers.tick(300);
  assert.equal(loaders.length, before + 1, 'the next frame is asked for: the screen is on screen beside the preview');
  arrive();
  s.resize(1200); // back into a hidden tab
  observer.cb([{ target: s.n.screen, isIntersecting: false }]);
  const after = loaders.length;
  t.mock.timers.tick(1000);
  assert.equal(loaders.length, after, 'nothing more while neither place is on screen');
});

test('unmount takes the screen out of the slot', async (t) => {
  const s = await setup(t, { width: 1500 });
  assert.equal(s.n.screen.parentNode, s.aside);
  panel.unmount();
  assert.deepEqual(s.aside.kids, []);
  assert.equal(s.aside.hidden, true);
  assert.equal(s.wrap.classes.has('has-side'), false);
  s.resize(1200);
  s.resize(1600);
  assert.deepEqual(s.aside.kids, [], 'a later width change puts nothing back');
});

test('a project switch empties the slot: the Workbench empties it at leave, and the old panel never puts it back', async (t) => {
  const s = await setup(t, { width: 1500 });
  assert.equal(s.n.screen.parentNode, s.aside);
  s.stageSide.empty(); // workbench.js leaveProject
  assert.deepEqual(s.aside.kids, []);
  assert.equal(s.aside.hidden, true);
  s.ctx.project = { id: 'p_2', ui: {} }; // the bundle is now the other project's
  s.resize(1200);
  s.resize(1600);
  assert.deepEqual(s.aside.kids, [], 'the old project\'s screen does not come back beside the new preview');
  assert.equal(s.n.screen.parentNode, s.n.phone, 'it went home to the old tab, which the dock unmounts next');
  const wb = await fsp.readFile(new URL('../client/views/workbench.js', import.meta.url), 'utf8');
  const leave = wb.slice(wb.indexOf('function leaveProject'), wb.indexOf('function tryHead'));
  assert.match(leave, /ui\.stageSide\.empty\(\)/, 'leaveProject empties the slot');
  assert.match(wb, /new ResizeObserver\(\(\) => stageSide\.measure\(\)\)/, 'a ResizeObserver on the Workbench decides');
  assert.match(wb, /el\('div\.preview-wrap', skip, frame, overlay, sideNode\)/, 'the slot lives in the preview-wrap');
});

test('without a slot (another host) the screen stays in the tab and nothing moves', async (t) => {
  const s = await setup(t, { width: 1600, slot: false });
  assert.equal(s.n.screen.parentNode, s.n.phone);
  assert.equal(s.n.besideLine.hidden, true);
});

test('the dock mounts the Phone panel hidden on a wide window so the screen can sit beside the preview', async () => {
  const dock = await fsp.readFile(new URL('../client/components/dock.js', import.meta.url), 'utf8');
  assert.match(dock, /function ensureBeside\(\)/);
  assert.match(dock, /phoneBeside === false\) return;/);
  assert.match(dock, /stageSide\?\.on\(\(\) => \{ ensureBeside\(\); placeSide\(\); \}\)/);
  assert.match(dock, /stageSide,\n/, 'panels get ctx.stageSide');
});
