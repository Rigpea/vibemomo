// The real client/components/compare-side.js with stubs for the DOM: what opening and closing it does to the narrow
// overlay, the Esc listener and the focus, and where a frame's events go. No browser is involved, so nothing here says
// real key events take this path; scripts/ui-check/verify-audio-sbs.cjs does that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const node = () => ({ classList: { add() {}, toggle() {} }, addEventListener() {}, style: {} });
const makeEl = (tag, ...rest) => {
  const n = node();
  n.tag = tag;
  if (tag === 'iframe') {
    n.contentWindow = { addEventListener() {}, removeEventListener() {}, focus() {} };
    n.listeners = {};
    n.addEventListener = (type, fn) => { n.listeners[type] = fn; };
  }
  n.rest = rest;
  return n;
};
const frames = [];
const buttons = [];
globalThis.__sbs = {
  el: (tag, ...rest) => { const n = makeEl(tag, ...rest); if (tag === 'iframe') frames.push(n); return n; },
  clear() {},
  button: (label, attrs = {}) => { const n = { ...node(), label, attrs }; buttons.push(n); return n; },
  select: () => node(),
  toast() {},
  loading: () => node(),
  dialog: ({ onClose }) => {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    let closed = false;
    const close = () => { if (closed) return; closed = true; onClose?.(); resolve(); };
    return { close, done, node: node() };
  },
  previewStart: (await import('../client/api.js')).previewStart, // the real one: what each frame opens is tested below
  renderDiff: () => node(),
  vname: (v) => `#${v.n}`,
  currentVersion: (b) => b.versions[0],
  stateLabel: (s) => s,
};
const source = (await fsp.readFile(new URL('../client/components/compare-side.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\.\/ui\.js';/, 'const { el, clear, button, dialog, select, toast, loading } = globalThis.__sbs;')
  .replace(/import \{[^}]*\} from '\.\.\/api\.js';/, 'const { previewStart } = globalThis.__sbs;')
  .replace(/import \{[^}]*\} from '\.\/version-actions\.js';/, 'const { renderDiff, vname, currentVersion, stateLabel } = globalThis.__sbs;');
const { sideBySide } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const tick = () => new Promise((r) => setImmediate(r));

function setup({ narrow = false, panelOpen = false, open = undefined } = {}) {
  frames.length = 0;
  const docListeners = new Set();
  const winListeners = new Set();
  const focusButton = { focused: 0, focus() { this.focused++; } };
  const page = { modal: false };
  globalThis.document = {
    activeElement: null,
    addEventListener: (type, fn) => { if (type === 'keydown') docListeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'keydown') docListeners.delete(fn); },
    querySelector: (sel) => {
      if (sel === 'dialog:modal') return page.modal ? {} : null;
      if (sel.includes('Side by side compare')) return focusButton;
      return null;
    },
    body: node(),
  };
  globalThis.window = {
    addEventListener: (type, fn) => { if (type === 'message') winListeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') winListeners.delete(fn); },
  };
  const received = [];
  const frameResets = [];
  const toggled = [];
  const app = {
    state: { narrowPanelOpen: panelOpen, bundle: { versions: [{ id: 'v1', n: 1 }], manifest: { entry: 'src/index.html' } } },
    projectId: () => app.pid,
    pid: 'p_1',
    isNarrow: () => narrow,
    layout: () => ({ versionsOpen: { value: false } }),
    toggleLayout: (key, value) => { toggled.push([key, value]); },
    api: { compare: async () => ({ files: [], diff: '', a: {}, b: {} }) },
    workbench: { bus: { receiveFrame: (frame, msg) => received.push([frame, msg]), resetFrame: (frame) => frameResets.push(frame) }, host: () => node(), collapseDock: () => false },
  };
  const d = sideBySide(app, open);
  const key = (e) => { const out = { key: 'Escape', defaultPrevented: false, prevented: 0, preventDefault() { this.prevented++; }, ...e }; [...docListeners].forEach((fn) => fn(out)); return out; };
  return { d, app, docListeners, winListeners, focusButton, page, received, frameResets, toggled, key };
}

test('a frame\'s own Reload clears only that frame\'s events on the bus', () => {
  const s = setup();
  assert.deepEqual(s.frameResets, ['A', 'B'], 'opening loads both');
  s.frameResets.length = 0;
  buttons.findLast((b) => b.label === 'Reload' && b.attrs['aria-label'] === 'Reload A').attrs.onclick();
  assert.deepEqual(s.frameResets, ['A']);
});

// A version can keep another entry than the one atelier.json names today (the first phone project's #29 opened on its
// looks page), so a version's frame asks for the version's bare root and the server answers with that version's entry.
test('a version\'s frame opens on the version\'s own entry (its bare root), the working tree on the current entry', () => {
  setup({ open: { a: 'v1', b: 'head' } });
  const [a, b] = frames;
  assert.match(a.src, /^\/preview\/p_1\/v1\/\?sbs=a&t=\d+$/, 'no entry of today\'s manifest in a version\'s address');
  assert.match(b.src, /^\/preview\/p_1\/head\/src\/index\.html\?sbs=b&t=\d+$/);
});

test('a narrow window with the overlay open: opening closes it, and only then', () => {
  assert.deepEqual(setup({ narrow: true, panelOpen: true }).toggled, [['collabCollapsed', true]]);
  assert.deepEqual(setup({ narrow: true, panelOpen: false }).toggled, []);
  assert.deepEqual(setup({ narrow: false, panelOpen: false }).toggled, []);
});

test('one document listener while open: Esc closes, the listener goes, focus returns to the toolbar button', async () => {
  const s = setup();
  assert.equal(s.docListeners.size, 1);
  const e = s.key();
  assert.equal(e.prevented, 1);
  assert.equal(s.docListeners.size, 0);
  await tick();
  assert.equal(s.focusButton.focused, 1);
});

test('other keys, an Esc already used and a modal on top leave it open', async () => {
  const s = setup();
  s.key({ key: 'a' });
  s.key({ defaultPrevented: true });
  s.page.modal = true;
  s.key();
  await tick();
  assert.equal(s.docListeners.size, 1);
  assert.equal(s.focusButton.focused, 0);
  s.page.modal = false;
  s.key();
  assert.equal(s.docListeners.size, 0);
});

test('any close returns focus and removes the listener; a project switch does not take the focus', async () => {
  const s = setup();
  s.d.close();
  await tick();
  assert.equal(s.docListeners.size, 0);
  assert.equal(s.focusButton.focused, 1);
  const other = setup();
  other.app.pid = 'p_2';
  other.d.close();
  await tick();
  assert.equal(other.docListeners.size, 0);
  assert.equal(other.focusButton.focused, 0);
});

test('the two frames are live targets while it is open, and no longer once it closes', () => {
  const s = setup();
  assert.equal(s.app.previewTargets.size, 2);
  s.d.close();
  assert.equal(s.app.previewTargets.size, 0);
});

test('a frame\'s event reaches the bus with its letter; a stranger\'s and a non-event do not', () => {
  const s = setup();
  const [a, b] = frames;
  const say = (source, data) => [...s.winListeners].forEach((fn) => fn({ source, data }));
  const msg = { type: 'atelier:event', name: 'blip', data: { how: 'key' } };
  say(a.contentWindow, msg);
  say(b.contentWindow, msg);
  say({}, msg);
  say(a.contentWindow, { type: 'atelier:ready' });
  assert.deepEqual(s.received.map(([frame]) => frame), ['A', 'B']);
  assert.equal(s.received[0][1], msg);
});
