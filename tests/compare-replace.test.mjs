// Replacing one Side by side with another from a task row, in the order task-list.js does it: closeDialogsIn, then
// wb.sideBySide, which awaits an import. The real dialog() and the real sideBySide() on a stub DOM with a tracked focus.
// No browser is involved; scripts/ui-check/verify-sbs-focus.cjs reads document.activeElement in the real client.
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
    this.isConnected = true;
  }
  setAttribute() {}
  addEventListener() {}
  append(...kids) { for (const k of kids) if (k != null) this.children.push(k); }
  replaceChildren() { this.children = []; }
  remove() { this.isConnected = false; this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  all(pick, out = []) { for (const c of this.children) { if (c instanceof FakeNode) { if (pick(c)) out.push(c); c.all(pick, out); } } return out; }
  querySelector(sel) { return sel.includes('select') ? this.all((n) => n.tag === 'select')[0] || null : null; }
  querySelectorAll(sel) { return sel === 'dialog[open]' ? this.children.filter((c) => c.tag === 'dialog' && c.open) : []; }
  focus() { document.activeElement = this; log.push(this.name || this.tag); }
  show() { this.open = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const log = [];
const toolbarButton = new FakeNode('button');
toolbarButton.name = 'toolbar';
globalThis.Node = FakeNode;
globalThis.document = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
  addEventListener() {},
  removeEventListener() {},
  querySelector: (sel) => (sel.includes('Side by side compare') ? toolbarButton : null),
  getElementById: () => new FakeNode('div'),
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const uiUrl = new URL('../client/components/ui.js', import.meta.url).href;
const { closeDialogsIn } = await import(uiUrl);
globalThis.__sbs = { previewUrl: () => '/preview', renderDiff: () => new FakeNode('div'), vname: (v) => `#${v.n}`, currentVersion: (b) => b.versions[0], stateLabel: (s) => s };
const source = (await fsp.readFile(new URL('../client/components/compare-side.js', import.meta.url), 'utf8'))
  .replace(/from '\.\/ui\.js';/, `from '${uiUrl}';`)
  .replace(/import \{[^}]*\} from '\.\.\/api\.js';/, 'const { previewUrl } = globalThis.__sbs;')
  .replace(/import \{[^}]*\} from '\.\/version-actions\.js';/, 'const { renderDiff, vname, currentVersion, stateLabel } = globalThis.__sbs;');
const moduleUrl = `data:text/javascript,${encodeURIComponent(source)}`;

test('a second Side by side from a task row: the focus passes the toolbar and ends in the new overlay', async () => {
  const previewWrap = new FakeNode('div');
  const app = {
    state: { narrowPanelOpen: false, bundle: { versions: [{ id: 'v1', n: 1 }, { id: 'v2', n: 2 }], manifest: { entry: 'src/index.html' } } },
    projectId: () => 'p_1',
    isNarrow: () => false,
    layout: () => ({ versionsOpen: { value: false } }),
    api: { compare: async () => ({ files: [], diff: '', a: {}, b: {} }) },
    workbench: { bus: { resetFrame() {} }, host: () => previewWrap, collapseDock: () => false },
  };
  // version-actions.js sideBySideCompare, the path wb.sideBySide takes.
  const sideBySideCompare = async (opts) => {
    const { sideBySide } = await import(moduleUrl);
    return sideBySide(app, opts);
  };
  const row = new FakeNode('button');
  row.name = 'task row';
  row.focus();
  const first = await sideBySideCompare({ a: 'v1', b: 'v2' });
  assert.equal(document.activeElement.tag, 'select', 'the first overlay takes the focus');

  row.focus();
  log.length = 0;
  closeDialogsIn(previewWrap); // compareVersions in client/components/task-list.js
  const second = await sideBySideCompare({ a: 'v1', b: 'v2' });
  await new Promise((r) => setImmediate(r));

  assert.equal(first.node.isConnected, false);
  assert.deepEqual(log, ['toolbar', 'select'], 'the old overlay hands the focus back first, then the new one takes it');
  assert.ok(second.node.all((n) => n === document.activeElement).length === 1, 'the focus is inside the new overlay');
});
