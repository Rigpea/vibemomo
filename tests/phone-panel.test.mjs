// The real workbenches/phone/panel.js and map.js on a stub DOM, as tests/audio-panel.test.mjs does: the chips
// a status answer gives, the buttons its state allows, a pointer on the screen as device pixels, tap versus
// swipe, keys, Point mode's readout, the iPhone line, the build log, and every timer gone on unmount.
// Layout and the real image are scripts/ui-check/verify-phone.cjs's to check.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import * as map from '../workbenches/phone/map.js';

// ---------- a stub DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, disabled: false, value: '', open: false, src: '', alt: '', title: '' });
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
  toast: (message, opts) => { toasts.push([message, opts?.tone]); },
  copyText: async (text) => { copied.push(text); return true; },
};
const toasts = [];
const copied = [];
const opened = []; // app.openSource calls
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const find = (root, pred) => all(root).filter(pred);
const byClass = (root, c) => find(root, (n) => n.classes.has(c));
const buttonNamed = (root, text) => find(root, (n) => n.tag === 'button' && n.kids[0] === text)[0];

// ---------- the browser around it ----------
let observer = null;
const sources = [];
globalThis.document = { hidden: false, activeElement: null, listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); } };
globalThis.IntersectionObserver = class { constructor(cb) { this.cb = cb; this.on = true; observer = this; } observe() {} disconnect() { this.on = false; } };
globalThis.EventSource = class {
  constructor(url) { Object.assign(this, { url, closed: false, listeners: {} }); sources.push(this); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  close() { this.closed = true; }
  say(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  end(obj) { for (const f of this.listeners.end || []) f({ data: JSON.stringify(obj) }); }
};
// The offscreen Image the panel loads each frame through: tests fire its load or error by hand.
const loaders = [];
globalThis.Image = class extends N { constructor() { super('img'); loaders.push(this); } };
/** The frame in flight arrives at w x h: its natural size, then load. */
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
globalThis.__beside = await import('../workbenches/phone/beside.js');
globalThis.__ui = ui;
globalThis.__map = map;
globalThis.__words = await import('../client/components/companion-words.js');
const panel = await import(`data:text/javascript,${encodeURIComponent(source)}`);

// ---------- status answers ----------
const TOOLS = { sdkRoot: 'C:\\sdk', adb: { path: 'C:\\sdk\\platform-tools\\adb.exe', found: true, source: 'settings', reason: null }, emulator: { path: 'C:\\sdk\\emulator\\emulator.exe', found: true, source: 'settings', reason: null } };
const EMU = { serial: 'emulator-5554', state: 'device', emulator: true, avd: 'Pixel_7', booted: true };
const android = (over = {}) => ({
  ok: true, id: 'android', label: 'Android', available: true, reason: null,
  tools: TOOLS, config: { avd: 'Pixel_7', appId: 'com.example.app', activity: '.MainActivity', build: null },
  build: { state: 'none', note: 'No build since the studio started' },
  devices: [EMU], target: 'emulator-5554',
  app: { appId: 'com.example.app', serial: 'emulator-5554', installed: true, running: true, pid: 4242 },
  ...over,
});
const IOS = { ok: true, id: 'ios', label: 'iPhone', available: false, code: 'needs_mac', reason: 'The iPhone simulator runs only on macOS; connect a Mac to use it.', projectSetUp: true, note: 'The project is set up for iOS (it has an ios/ folder).' };

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };

async function setup(t, status = { providers: [android()] }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  net.answers = { 'GET /': typeof status === 'function' ? status : [200, status] };
  const container = new N('div.wbp-host');
  opened.length = 0;
  panel.mount(container, { projectId: 'p_1', manifest: { devices: { android: {} } }, app: { openSource: (o) => { opened.push(o); return Promise.resolve(true); } } });
  await flush();
  const img = byClass(container, 'phone-img')[0];
  img.rect = { left: 10, top: 20, width: 270, height: 600 };
  const chips = () => Object.fromEntries(find(container, (n) => n.dataset.chip).map((c) => [c.dataset.chip, c]));
  const posts = (path) => net.calls.filter((c) => c.method === 'POST' && c.url.endsWith(path)).map((c) => c.body);
  /** The first frame: its request goes out and a 1080 x 2400 screenshot arrives. */
  const frame = () => { t.mock.timers.tick(0); arrive(); };
  return { container, img, chips, posts, frame };
}

afterEach(() => { panel.unmount(); net.calls.length = 0; sources.length = 0; toasts.length = 0; copied.length = 0; loaders.length = 0; document.hidden = false; });

// ---------- the pure helpers ----------
test('a point on the drawn image maps to device pixels by naturalWidth / drawn width, clamped to the screen', () => {
  const rect = { left: 10, top: 20, width: 270, height: 600 };
  const nat = { naturalWidth: 1080, naturalHeight: 2400 };
  assert.deepEqual(map.toDevice({ clientX: 145, clientY: 320 }, rect, nat), { x: 540, y: 1200 });
  assert.deepEqual(map.toDevice({ clientX: 10, clientY: 20 }, rect, nat), { x: 0, y: 0 });
  assert.deepEqual(map.toDevice({ clientX: 400, clientY: 900 }, rect, nat), { x: 1079, y: 2399 });
  assert.equal(map.toDevice({ clientX: 1, clientY: 1 }, { ...rect, width: 0 }, nat), null, 'an image with no size yet maps nothing');
  assert.equal(map.toDevice({ clientX: 1, clientY: 1 }, rect, { naturalWidth: 0, naturalHeight: 0 }), null);
});

test('a press and release within 8 px is a tap where the press began; further is a swipe with its duration', () => {
  const rect = { left: 0, top: 0, width: 100, height: 200 };
  const nat = { naturalWidth: 1000, naturalHeight: 2000 };
  assert.deepEqual(map.gestureFrom({ clientX: 50, clientY: 50, t: 0 }, { clientX: 55, clientY: 56, t: 90 }, rect, nat), { type: 'tap', x: 500, y: 500 });
  assert.deepEqual(map.gestureFrom({ clientX: 50, clientY: 150, t: 1000 }, { clientX: 50, clientY: 50, t: 1240 }, rect, nat), { type: 'swipe', x: 500, y: 1500, x2: 500, y2: 500, ms: 240 });
  assert.equal(map.gestureFrom({ clientX: 0, clientY: 0, t: 0 }, { clientX: 90, clientY: 0, t: 0 }, rect, nat).ms, 1, 'the route takes 1 ms at least');
  assert.equal(map.gestureFrom({ clientX: 0, clientY: 0, t: 0 }, { clientX: 90, clientY: 0, t: 60000 }, rect, nat).ms, 10000, 'and 10 s at most');
});

test('the live line is measured from the frames that arrived, and says what it is', () => {
  assert.equal(map.rateLine([1000]), null);
  assert.equal(map.rateLine([0, 333, 666, 1000]), 'Live, about 3 frames a second: still screenshots from the device, not video');
  assert.equal(map.rateLine([0, 1000, 2000]), 'Live, about 1.0 frame a second: still screenshots from the device, not video');
});

test('actionsFor: each button applies only when the state allows it, with the reason when not', () => {
  const a = map.actionsFor(android());
  assert.deepEqual([a.boot.enabled, a.build.enabled, a.launch.enabled, a.stop.enabled], [false, true, true, true]);
  assert.match(a.boot.why, /Pixel_7 is already up/);
  const off = map.actionsFor(android({ devices: [], target: null, app: { appId: 'com.example.app', serial: null, installed: null, running: null, pid: null } }));
  assert.deepEqual([off.boot.enabled, off.build.enabled, off.launch.enabled, off.stop.enabled], [true, false, false, false]);
  assert.match(off.build.why, /Boot a device first/);
  assert.equal(map.actionsFor(android({ config: { ...android().config, avd: null }, devices: [], target: null })).boot.why, 'No AVD named: set devices.android.avd in atelier.json');
  assert.match(map.actionsFor(android({ app: { ...android().app, installed: false, running: false } })).launch.why, /not installed/);
  assert.match(map.actionsFor(android({ devices: [{ serial: 'R5CT', state: 'device', emulator: false, booted: true }], target: 'R5CT' })).stop.why, /phone over USB/);
  assert.match(map.actionsFor(android({ build: { state: 'running' } })).build.why, /running/);
  assert.equal(map.actionsFor(android(), { boot: true }).boot.enabled, false);
});

// ---------- the panel ----------
test('the chips come from the status answer, each with an accessible name', async (t) => {
  const p = await setup(t, { providers: [android({ build: { state: 'failed', endedAt: '2026-11-06T10:05:00.000Z', step: { index: 2, of: 3, label: 'gradlew assembleDebug --console=plain' }, exitCode: 1, message: 'Step 2 (gradlew assembleDebug --console=plain) exited with 1' } })] });
  const c = p.chips();
  assert.deepEqual(Object.keys(c), ['tools', 'device', 'app', 'build']);
  assert.equal(c.tools.kids[0], 'Tools found');
  assert.equal(c.device.kids[0], 'Booted · Pixel_7');
  assert.equal(c.app.kids[0], 'App running');
  assert.match(c.build.kids[0], /^Build failed · \S/);
  assert.ok(c.build.classes.has('tone-danger'));
  for (const chip of Object.values(c)) assert.match(chip.attrs['aria-label'], /^(Tools|Device|App|Build): /);
  assert.match(c.app.attrs['aria-label'], /pid 4242 on emulator-5554/);
  assert.equal(byClass(p.container, 'phone-chips')[0].attrs['aria-label'], 'Phone status');
});

test('adb missing: the chip and the path tried, the device unknown, every action off', async (t) => {
  const tools = { ...TOOLS, adb: { path: 'C:\\nowhere\\platform-tools\\adb.exe', found: false, source: 'settings', reason: 'adb not found at C:\\nowhere\\platform-tools\\adb.exe' } };
  const p = await setup(t, { providers: [android({ tools, available: false, reason: tools.adb.reason, devices: [], target: null, app: null })] });
  const c = p.chips();
  assert.equal(c.tools.kids[0], 'adb missing');
  assert.equal(c.device.kids[0], 'Device unknown');
  assert.equal(c.app.kids[0], 'App not checked');
  const line = byClass(p.container, 'phone-tools')[0];
  assert.equal(line.hidden, false);
  assert.match(line.textContent, /C:\\nowhere\\platform-tools\\adb\.exe/);
  for (const name of ['Boot', 'Build and install', 'Launch', 'Stop']) assert.equal(buttonNamed(p.container, name).disabled, true, name);
  assert.match(buttonNamed(p.container, 'Boot').title, /adb not found/);
  assert.match(byClass(p.container, 'phone-noscreen')[0].textContent, /No screen: adb is missing/);
});

test('buttons follow the state: booted with the app installed, then no device', async (t) => {
  const p = await setup(t, { providers: [android({ app: { ...android().app, running: false, pid: null } })] });
  const state = () => ['Boot', 'Build and install', 'Launch', 'Stop'].map((n) => buttonNamed(p.container, n).disabled);
  assert.deepEqual(state(), [true, false, false, false]);
  assert.equal(p.chips().app.kids[0], 'App installed');
  net.answers['GET /'] = [200, { providers: [android({ devices: [], target: null, app: { appId: 'com.example.app', serial: null, installed: null, running: null, pid: null } })] }];
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(state(), [false, true, true, true]);
  assert.equal(p.chips().device.kids[0], 'No device');
});

test('a button posts its route and reads the status again; a refusal shows its reason', async (t) => {
  const p = await setup(t);
  net.answers['POST /launch'] = [200, { ok: true, serial: 'emulator-5554', component: 'com.example.app/.MainActivity' }];
  const before = net.calls.filter((c) => c.method === 'GET').length;
  buttonNamed(p.container, 'Launch').fire('click');
  assert.equal(buttonNamed(p.container, 'Launch').disabled, true, 'off while its request is out');
  await flush();
  assert.deepEqual(p.posts('/phone/launch'), [{}]);
  assert.equal(net.calls.filter((c) => c.method === 'GET').length, before + 1, 'the status is read again');
  assert.match(p.container.textContent, /Launched com\.example\.app\/\.MainActivity/);
  net.answers['POST /stop'] = [200, { ok: false, code: 'stop_failed', message: 'emu kill on emulator-5554: KO' }];
  buttonNamed(p.container, 'Stop').fire('click');
  await flush();
  assert.match(p.container.textContent, /Stop: emu kill on emulator-5554: KO/);
});

test('a press on the screen is a tap in device pixels, a drag a swipe; keys and text go through their routes', async (t) => {
  const p = await setup(t);
  p.frame();
  net.answers['POST /input'] = (body) => [200, { ok: true, command: JSON.stringify(body) }];
  p.img.fire('pointerdown', { button: 0, clientX: 145, clientY: 320, timeStamp: 1000, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 150, clientY: 322, timeStamp: 1080 });
  p.img.fire('pointerdown', { button: 0, clientX: 145, clientY: 500, timeStamp: 2000, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 145, clientY: 200, timeStamp: 2300 });
  const keyDown = p.img.fire('keydown', { key: 'ArrowUp' });
  p.img.fire('keydown', { key: 'Escape' });
  p.img.fire('keydown', { key: 'a' });
  byClass(p.container, 'phone-text')[0].value = 'hello there';
  find(p.container, (n) => n.tag === 'form')[0].fire('submit');
  await flush();
  assert.deepEqual(p.posts('/phone/input'), [
    { type: 'tap', x: 540, y: 1200 },
    { type: 'swipe', x: 540, y: 1920, x2: 540, y2: 720, ms: 300 },
    { type: 'key', key: 'up' },
    { type: 'key', key: 'back' },
    { type: 'text', text: 'hello there' },
  ]);
  assert.equal(keyDown.defaultPrevented, true, 'an arrow does not scroll the panel');
  assert.equal(byClass(p.container, 'phone-text')[0].value, '', 'sent text leaves the field');
  assert.match(p.img.attrs['aria-label'], /^Screen of Pixel_7 \(emulator-5554\)/);
  assert.equal(p.img.tabIndex, 0);
});

test('a refused input says why in the panel', async (t) => {
  const p = await setup(t);
  net.answers['POST /input'] = [400, { error: { code: 'invalid_input', message: 'adb input text types plain ASCII only (letters, digits, punctuation, spaces)' } }];
  byClass(p.container, 'phone-text')[0].value = 'héllo';
  find(p.container, (n) => n.tag === 'form')[0].fire('submit');
  await flush();
  assert.match(p.container.textContent, /Not sent: adb input text types plain ASCII only/);
  assert.equal(byClass(p.container, 'phone-text')[0].value, 'héllo', 'the words stay to be fixed');
});

const INSPECT = {
  ok: true, serial: 'emulator-5554', pid: 4242, page: { url: 'https://localhost/#/start' },
  point: { device: { x: 540, y: 1200 }, dpr: 2.625, inset: 63, css: { x: 205.71, y: 433.14 } },
  element: { tag: 'button', id: 'start', classes: ['btn', 'primary'], text: 'Start the round now', selector: '#start', url: 'https://localhost/#/start', nodeName: 'BUTTON' },
  candidates: [
    { file: 'src/index.html', line: 12, matched: ['start', 'btn', 'primary'] },
    { file: 'src/app.js', line: 40, matched: ['start'] },
    { file: 'src/style.css', line: 7, matched: ['btn'] },
    { file: 'src/more.js', line: 3, matched: ['primary'] },
  ],
  searched: 'src',
};

test('Point mode: a tap reads the element instead of reaching the phone; a file opens in the Source tab, Copy copies them; Copy for a task takes three', async (t) => {
  const p = await setup(t);
  p.frame();
  net.answers['POST /inspect'] = [200, INSPECT];
  const toggle = buttonNamed(p.container, 'Point mode');
  toggle.fire('click');
  assert.equal(toggle.attrs['aria-pressed'], 'true');
  p.img.fire('pointerdown', { button: 0, clientX: 145, clientY: 320, timeStamp: 0, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 145, clientY: 320, timeStamp: 50 });
  await flush();
  assert.deepEqual(p.posts('/phone/inspect'), [{ x: 540, y: 1200 }]);
  assert.deepEqual(p.posts('/phone/input'), [], 'nothing went to the phone');
  const readout = byClass(p.container, 'phone-readout')[0];
  const text = readout.textContent;
  for (const want of ['button#start.btn.primary', 'Start the round now', 'https://localhost/#/start', 'device (540, 1200)']) assert.ok(text.includes(want), want);
  const files = find(readout, (n) => n.tag === 'button' && /:\d+$/.test(n.kids[0]));
  assert.deepEqual(files.map((b) => b.kids[0]), ['src/index.html:12', 'src/app.js:40', 'src/style.css:7', 'src/more.js:3']);
  files[1].fire('click');
  await flush();
  assert.deepEqual(opened, [{ path: 'src/app.js', line: 40 }], 'a click opens the file at its line');
  assert.deepEqual(copied, [], 'and copies nothing');
  buttonNamed(readout, 'Copy').fire('click');
  await flush();
  assert.deepEqual(copied, ['src/index.html:12\nsrc/app.js:40\nsrc/style.css:7\nsrc/more.js:3']);
  assert.match(toasts.at(-1)[0], /^Copied 4 files as file:line$/);
  buttonNamed(readout, 'Copy for a task').fire('click');
  await flush();
  const block = copied[1];
  assert.match(block, /^Phone point: device \(540, 1200\) on emulator-5554, page CSS \(205\.71, 433\.14\)/);
  assert.match(block, /Element: button#start\.btn\.primary \(selector #start\)/);
  assert.match(block, /Text: "Start the round now"/);
  assert.match(block, /- src\/index\.html:12 \(matches start, btn, primary\)\n- src\/app\.js:40 \(matches start\)\n- src\/style\.css:7 \(matches btn\)$/);
  assert.doesNotMatch(block, /more\.js/);
});

test('Pin posts the readout to the companion pins route as the stored shape, and says where it went', async (t) => {
  const p = await setup(t);
  p.frame();
  net.answers['POST /inspect'] = [200, INSPECT];
  net.answers['POST /api/projects/p_1/companion/pins'] = (body) => [200, { id: 'pin_1', ...body, createdAt: '2026-11-06T12:00:00.000Z' }];
  buttonNamed(p.container, 'Point mode').fire('click');
  p.img.fire('pointerdown', { button: 0, clientX: 145, clientY: 320, timeStamp: 0, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 145, clientY: 320, timeStamp: 50 });
  await flush();
  const readout = byClass(p.container, 'phone-readout')[0];
  buttonNamed(readout, 'Pin').fire('click');
  await flush();
  const sent = net.calls.filter((c) => c.method === 'POST' && c.url === '/api/projects/p_1/companion/pins').map((c) => c.body);
  assert.deepEqual(sent, [{
    source: 'phone', element: 'button#start.btn.primary', text: 'Start the round now', selector: '#start',
    point: { device: { x: 540, y: 1200 }, css: { x: 205.71, y: 433.14 } },
    files: ['src/index.html:12', 'src/app.js:40', 'src/style.css:7', 'src/more.js:3'], page: 'https://localhost/#/start',
  }]);
  assert.deepEqual(toasts.at(-1), ['Pinned button#start.btn.primary: it is listed under the Companion thread', 'ok']);
  net.answers['POST /api/projects/p_1/companion/pins'] = [409, { error: { code: 'too_many_pins', message: 'A project keeps at most 50 pins; remove one first' } }];
  buttonNamed(readout, 'Pin').fire('click');
  await flush();
  assert.deepEqual(toasts.at(-1), ['Pin: A project keeps at most 50 pins; remove one first', 'danger']);
});

test('command({ point }) from studio.show: on and off at once on a booted phone', async (t) => {
  const p = await setup(t);
  const toggle = () => buttonNamed(p.container, 'Point mode').attrs['aria-pressed'];
  panel.command({ point: true });
  assert.equal(toggle(), 'true');
  panel.command({ point: false });
  assert.equal(toggle(), 'false');
});

const booting = () => ({ providers: [android({ devices: [{ ...EMU, booted: false }] })] });
test('command({ point: true }) before boot waits for the status that says booted', async (t) => {
  const q = await setup(t, booting());
  const pressed = () => buttonNamed(q.container, 'Point mode').attrs['aria-pressed'];
  panel.command({ point: true });
  assert.equal(pressed(), 'false', 'no Point mode before the device is up');
  assert.ok(q.container.textContent.includes('Point mode turns on once the phone is up.'));
  net.answers['GET /'] = [200, { providers: [android()] }];
  t.mock.timers.tick(map.POLL_MS);
  await flush();
  assert.equal(pressed(), 'true', 'the next status that says booted turns it on');
});

test('command({ point: false }) before boot cancels a waiting on', async (t) => {
  const r = await setup(t, booting());
  panel.command({ point: true });
  panel.command({ point: false });
  net.answers['GET /'] = [200, { providers: [android()] }];
  t.mock.timers.tick(map.POLL_MS);
  await flush();
  assert.equal(buttonNamed(r.container, 'Point mode').attrs['aria-pressed'], 'false', 'an off before the boot cancels the wish');
});

test('Point mode says in plain words when nothing is there, and Esc leaves it', async (t) => {
  const p = await setup(t);
  p.frame();
  net.answers['POST /inspect'] = [200, { ok: false, code: 'no_webview_socket', message: 'No WebView DevTools socket for com.example.app (pid 4242); a debug build has one once its WebView loads' }];
  buttonNamed(p.container, 'Point mode').fire('click');
  p.img.fire('pointerdown', { button: 0, clientX: 100, clientY: 100, timeStamp: 0, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 100, clientY: 100, timeStamp: 10 });
  await flush();
  assert.match(byClass(p.container, 'phone-readout')[0].textContent, /Nothing found: this screen has no web page to read\. It is a native screen, or the app has no debuggable WebView\./);
  net.answers['POST /inspect'] = [200, { ...INSPECT, element: null, candidates: [] }];
  p.img.fire('pointerdown', { button: 0, clientX: 100, clientY: 100, timeStamp: 0, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 100, clientY: 100, timeStamp: 10 });
  await flush();
  assert.match(byClass(p.container, 'phone-readout')[0].textContent, /Nothing found under this point in the page\./);
  p.img.fire('keydown', { key: 'Escape' });
  assert.equal(buttonNamed(p.container, 'Point mode').attrs['aria-pressed'], 'true', 'the image leaves Esc to the panel while pointing');
  p.container.fire('keydown', { key: 'Escape' });
  assert.equal(buttonNamed(p.container, 'Point mode').attrs['aria-pressed'], 'false');
  await flush();
  assert.deepEqual(p.posts('/phone/input'), [], 'that Esc was not Back');
});

test('the iPhone line is the route\'s reason, with no button and no frame; without iOS there is none', async (t) => {
  const p = await setup(t, { providers: [android(), IOS] });
  const line = byClass(p.container, 'phone-ios')[0];
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, 'iPhone: The iPhone simulator runs only on macOS; connect a Mac to use it. The project is set up for iOS (it has an ios/ folder).');
  assert.equal(line.kids.length, 0, 'text only: nothing inside it');
  assert.equal(find(p.container, (n) => n.tag === 'img').length, 1, 'one screen, the Android one');
  panel.unmount();
  t.mock.timers.reset();
  const q = await setup(t);
  assert.equal(byClass(q.container, 'phone-ios')[0].hidden, true);
});

test('only iOS: no Android chips, the reason line says so, and no screen is drawn', async (t) => {
  const p = await setup(t, { providers: [IOS] });
  assert.deepEqual(Object.keys(p.chips()), []);
  assert.match(p.container.textContent, /No Android provider applies to this project\./);
  assert.equal(p.img.hidden, true);
  assert.equal(net.calls.filter((c) => c.url.includes('/screenshot')).length, 0);
});

test('a status that cannot be read leaves no chip standing and every action off', async (t) => {
  const p = await setup(t);
  assert.equal(Object.keys(p.chips()).length, 4);
  net.answers['GET /'] = [404, { error: { code: 'no_device_provider', message: 'No device provider applies: the project has no android/ or ios/ folder' } }];
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(Object.keys(p.chips()), []);
  assert.match(p.container.textContent, /Phone status not read: No device provider applies/);
  for (const name of ['Boot', 'Build and install', 'Launch', 'Stop', 'Point mode']) assert.equal(buttonNamed(p.container, name).disabled, true, name);
});

test('the screen reloads 300 ms after each frame while visible and booted; hidden stops it and the poll', async (t) => {
  const p = await setup(t);
  assert.equal(loaders.length, 0);
  t.mock.timers.tick(0);
  assert.equal(loaders.length, 1);
  assert.match(loaders[0].src, /^\/api\/projects\/p_1\/phone\/screenshot\?t=\d+$/);
  assert.equal(p.img.src, '', 'the visible image waits for the offscreen load');
  t.mock.timers.tick(1000);
  assert.equal(loaders.length, 1, 'no new frame before the last one arrived');
  arrive();
  assert.equal(p.img.src, loaders[0].src, 'the loaded frame is swapped in');
  assert.equal(p.img.hidden, false);
  t.mock.timers.tick(299);
  assert.equal(loaders.length, 1);
  t.mock.timers.tick(1);
  assert.equal(loaders.length, 2);
  arrive();
  assert.equal(p.img.src, loaders[1].src);
  assert.match(byClass(p.container, 'phone-live')[0].textContent, /^Live/);
  // the dock hides the tab
  observer.cb([{ isIntersecting: false }]);
  const made = loaders.length;
  const gets = net.calls.length;
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(loaders.length, made, 'no frame while hidden');
  assert.equal(net.calls.length, gets, 'no status poll while hidden');
  observer.cb([{ isIntersecting: true }]);
  await flush();
  assert.equal(net.calls.length, gets + 1, 'shown again: the status at once');
  t.mock.timers.tick(0);
  assert.equal(loaders.length, made + 1);
  assert.match(loaders.at(-1).src, /screenshot\?t=/);
});

test('the visible src changes only after the offscreen load fires; a frame in flight when the screen stops is dropped', async (t) => {
  const p = await setup(t);
  p.frame();
  assert.equal(p.img.src, loaders[0].src);
  // Two frames in one millisecond share a URL, so the shown one is marked to tell them apart.
  p.img.src = 'shown-frame';
  t.mock.timers.tick(300);
  assert.equal(loaders.length, 2, 'the next frame is asked for');
  const next = loaders[1];
  assert.equal(p.img.src, 'shown-frame', 'while it loads the visible image keeps the last frame');
  assert.equal(p.img.hidden, false);
  next.naturalWidth = 1080; next.naturalHeight = 2400;
  next.fire('load');
  assert.equal(p.img.src, next.src, 'swapped once loaded');
  // Hidden while a frame is in flight: when it lands nothing changes.
  t.mock.timers.tick(300);
  const late = loaders.at(-1);
  observer.cb([{ isIntersecting: false }]);
  const shown = p.img.src;
  late.naturalWidth = 1080; late.naturalHeight = 2400;
  late.fire('load');
  assert.equal(p.img.src, shown);
});

test('a tap while the next frame loads still maps with the last frame\'s size, and Point mode still posts inspect', async (t) => {
  const p = await setup(t);
  net.answers['POST /input'] = (body) => [200, { ok: true, command: JSON.stringify(body) }];
  net.answers['POST /inspect'] = [200, INSPECT];
  p.frame();
  t.mock.timers.tick(300); // the next frame is in flight
  assert.ok(loaders.at(-1).listeners.load?.length, 'a load is pending');
  p.img.naturalWidth = 0; p.img.naturalHeight = 0; // as a browser may read it while a src changes
  p.img.fire('pointerdown', { button: 0, clientX: 145, clientY: 320, timeStamp: 0, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 145, clientY: 320, timeStamp: 40 });
  buttonNamed(p.container, 'Point mode').fire('click');
  p.img.fire('pointerdown', { button: 0, clientX: 145, clientY: 320, timeStamp: 100, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 145, clientY: 320, timeStamp: 140 });
  await flush();
  assert.deepEqual(p.posts('/phone/input'), [{ type: 'tap', x: 540, y: 1200 }]);
  assert.deepEqual(p.posts('/phone/inspect'), [{ x: 540, y: 1200 }]);
  assert.match(byClass(p.container, 'phone-readout')[0].textContent, /button#start\.btn\.primary/);
});

test('Point mode with another app in front shows the route\'s sentence', async (t) => {
  const p = await setup(t);
  p.frame();
  const message = 'com.example.app is not on the screen: com.google.android.apps.nexuslauncher is';
  net.answers['POST /inspect'] = [200, { ok: false, code: 'not_in_front', message, front: 'com.google.android.apps.nexuslauncher' }];
  buttonNamed(p.container, 'Point mode').fire('click');
  p.img.fire('pointerdown', { button: 0, clientX: 100, clientY: 100, timeStamp: 0, pointerId: 1 });
  p.img.fire('pointerup', { clientX: 100, clientY: 100, timeStamp: 10 });
  await flush();
  assert.equal(byClass(p.container, 'phone-readout')[0].textContent, message);
});

test('a point maps through object-fit: contain when the box is wider than the frame', () => {
  // A 1080 x 2400 frame in a 400 x 600 box: drawn 270 x 600, centred, 65 px each side.
  const rect = { left: 0, top: 0, width: 400, height: 600 };
  const nat = { naturalWidth: 1080, naturalHeight: 2400 };
  assert.deepEqual(map.toDevice({ clientX: 65, clientY: 0 }, rect, nat), { x: 0, y: 0 });
  assert.deepEqual(map.toDevice({ clientX: 200, clientY: 300 }, rect, nat), { x: 540, y: 1200 });
  assert.deepEqual(map.toDevice({ clientX: 10, clientY: 300 }, rect, nat), { x: 0, y: 1200 }, 'the margin clamps to the edge');
});

test('a screenshot that fails reads the route\'s reason and stops until the next status', async (t) => {
  const p = await setup(t);
  net.answers['GET /screenshot'] = [503, { error: { code: 'screenshot_failed', message: 'screencap on emulator-5554: device offline' } }];
  t.mock.timers.tick(0);
  loaders.at(-1).fire('error');
  await flush();
  assert.match(byClass(p.container, 'phone-noscreen')[0].textContent, /No screen: screencap on emulator-5554: device offline/);
  const made = loaders.length;
  t.mock.timers.tick(1000);
  assert.equal(loaders.length, made);
  t.mock.timers.tick(4000);
  await flush();
  t.mock.timers.tick(0);
  assert.equal(loaders.length, made + 1, 'the next status starts it again');
  assert.match(loaders.at(-1).src, /screenshot\?t=/);
});

test('the build log follows the event stream, keeps 400 lines and names the failing step\'s exit code', async (t) => {
  const p = await setup(t);
  net.answers['POST /build'] = [200, { ok: true, started: true, log: '/api/projects/p_1/phone/build/log?provider=android' }];
  buttonNamed(p.container, 'Build and install').fire('click');
  await flush();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, '/api/projects/p_1/phone/build/log');
  const log = find(p.container, (n) => n.tag === 'details')[0];
  assert.equal(log.open, true, 'the log opens for a build the person started');
  const pre = byClass(p.container, 'phone-log-lines')[0];
  for (let i = 0; i < 450; i++) sources[0].say({ line: `line ${i}` });
  const lines = pre.textContent.split('\n');
  assert.equal(lines.length, 400);
  assert.equal(lines[0], 'line 50');
  sources[0].end({ state: 'failed', startedAt: 'a', endedAt: '2026-11-06T10:05:00.000Z', step: { index: 2, of: 3, label: 'gradlew assembleDebug --console=plain' }, exitCode: 1, message: 'Step 2 (gradlew assembleDebug --console=plain) exited with 1' });
  assert.equal(sources[0].closed, true);
  assert.match(log.textContent, /Failed at step 2 of 3 \(gradlew assembleDebug --console=plain\) · exit code 1/);
});

test('the log keeps its place when the person scrolled up, and follows when at the bottom', async (t) => {
  const p = await setup(t, { providers: [android({ build: { state: 'running', startedAt: 's1', step: { index: 1, of: 3, label: 'npx cap sync android' } } })] });
  assert.equal(sources.length, 1, 'a build already running is followed on mount');
  assert.equal(p.chips().build.kids[0], 'Building · step 1 of 3');
  const pre = byClass(p.container, 'phone-log-lines')[0];
  pre.scrollHeight = 500; pre.clientHeight = 100; pre.scrollTop = 400;
  sources[0].say({ line: 'a' });
  assert.equal(pre.scrollTop, 500, 'at the bottom: follows');
  pre.scrollTop = 100;
  pre.scrollHeight = 600;
  sources[0].say({ line: 'b' });
  assert.equal(pre.scrollTop, 100, 'scrolled up: stays');
});

test('unmount clears every timer and closes the log stream', async (t) => {
  const p = await setup(t, { providers: [android({ build: { state: 'running', startedAt: 's1' } })] });
  t.mock.timers.tick(0);
  const state = panel._state();
  assert.ok(state.poll, 'the poll is armed');
  arrive();
  assert.ok(state.frameTimer, 'the next frame is armed');
  panel.unmount();
  assert.equal(state.poll, null);
  assert.equal(state.frameTimer, null);
  assert.equal(state.loader, null);
  assert.equal(sources[0].closed, true);
  assert.equal(observer.on, false);
  assert.deepEqual(document.listeners.visibilitychange, []);
  const made = loaders.length;
  const calls = net.calls.length;
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(loaders.length, made);
  assert.equal(net.calls.length, calls);
});

test('a draw that throws shows one danger note with Retry, logs once, and a draw that works takes it away', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const broken = android();
  Object.defineProperty(broken, 'tools', { enumerable: true, get() { throw new Error('tools went missing'); } });
  let answer = { providers: [broken] };
  const { container } = await setup(t, () => [200, answer]);
  const note = () => find(container, (n) => n.classes.has('note') && n.classes.has('danger'))[0];
  assert.equal(note().hidden, false);
  assert.equal(note().attrs.role, 'alert');
  assert.match(note().textContent.replace(/\s+/g, ' '), /^The phone view could not be drawn: tools went missing\. Retry$/);
  panel.update(); // the same failure drawn again
  await flush();
  assert.equal(logged.mock.callCount(), 1, 'one console.error for one failure');
  answer = { providers: [android()] };
  buttonNamed(note(), 'Retry').fire('click');
  await flush();
  assert.equal(note().hidden, true);
});
