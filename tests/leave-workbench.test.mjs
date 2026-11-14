// Leaving the Workbench with Side by side open. The real dialog() and the real sideBySide() on a stub DOM, which
// shows the closer reaches onClose; no browser is involved, so scripts/ui-check/verify-audio-sbs.cjs is what shows a
// hash change does it. That driver once set '#memory', which the router reads as the Workbench: nothing was left, and
// the check failed for a leak that had not happened. So the hashes the drivers set are held to the router's own pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

class FakeNode {
  constructor(tag = '') {
    this.tag = tag;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.classList = { add() {}, toggle() {} };
  }
  setAttribute() {}
  addEventListener() {}
  append(...kids) { this.children.push(...kids); }
  replaceChildren() { this.children = []; }
  remove() { this.removed = true; }
  querySelector() { return null; }
  querySelectorAll(sel) { return sel === 'dialog[open]' ? this.children.filter((c) => c.tag === 'dialog' && c.open) : []; }
  focus() {}
  show() { this.open = true; }
  showModal() { this.open = true; }
  close() { this.open = false; } // the close event is never delivered, the worst case of a queued one
}
globalThis.Node = FakeNode;
const docKeys = new Set();
globalThis.document = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
  addEventListener: (type, fn) => { if (type === 'keydown') docKeys.add(fn); },
  removeEventListener: (type, fn) => { if (type === 'keydown') docKeys.delete(fn); },
  querySelector: () => null,
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const uiUrl = new URL('../client/components/ui.js', import.meta.url).href;
const { closeDialogsIn } = await import(uiUrl);
globalThis.__sbs = { previewUrl: () => '/preview', renderDiff: () => new FakeNode('div'), vname: (v) => `#${v.n}`, currentVersion: (b) => b.versions[0], stateLabel: (s) => s };
const source = (await fsp.readFile(new URL('../client/components/compare-side.js', import.meta.url), 'utf8'))
  .replace(/from '\.\/ui\.js';/, `from '${uiUrl}';`)
  .replace(/import \{[^}]*\} from '\.\.\/api\.js';/, 'const { previewUrl } = globalThis.__sbs;')
  .replace(/import \{[^}]*\} from '\.\/version-actions\.js';/, 'const { renderDiff, vname, currentVersion, stateLabel } = globalThis.__sbs;');
const { sideBySide } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('closing the preview area\'s dialogs empties the live targets, with no close event', () => {
  const previewWrap = new FakeNode('div');
  const dock = [];
  const app = {
    state: { narrowPanelOpen: false, bundle: { versions: [{ id: 'v1', n: 1 }], manifest: { entry: 'src/index.html' } } },
    projectId: () => 'p_1',
    isNarrow: () => false,
    layout: () => ({ versionsOpen: { value: false } }),
    api: {},
    workbench: { bus: { resetFrame() {} }, host: () => previewWrap, collapseDock: (c) => { dock.push(c); return false; } },
  };
  const d = sideBySide(app);
  assert.equal(previewWrap.querySelectorAll('dialog[open]')[0], d.node, 'the overlay opens inside the host the Workbench closes');
  assert.equal(app.previewTargets.size, 2);
  assert.equal(docKeys.size, 1);
  closeDialogsIn(previewWrap);
  assert.equal(app.previewTargets.size, 0);
  assert.equal(docKeys.size, 0, 'its Esc listener goes with it');
  assert.deepEqual(dock, [true, false], 'and the dock is put back');
});

test('every hash a UI driver sets is one the router reads', async () => {
  const appSource = await fsp.readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const pattern = new RegExp(appSource.match(/location\.hash\.match\(\/(.+?)\/\)/)[1]);
  assert.equal(pattern.exec('#/memory')?.[1], 'memory');
  const dir = new URL('../scripts/ui-check/', import.meta.url);
  const hashes = [];
  for (const file of await fsp.readdir(dir)) {
    if (!file.endsWith('.cjs')) continue;
    const text = await fsp.readFile(new URL(file, dir), 'utf8');
    for (const m of text.matchAll(/location\.hash\s*=\s*['"]([^'"]*)['"]/g)) hashes.push([file, m[1]]);
  }
  assert.ok(hashes.some(([file]) => file === 'verify-audio-sbs.cjs'), 'the check found the driver this is about');
  for (const [file, hash] of hashes) assert.match(hash, pattern, `${file} sets ${hash}`);
});
