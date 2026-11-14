// The real dialog() from client/components/ui.js with a stub DOM whose native close() queues an event that never
// arrives, the worst case of a queued close event. No browser is involved: scripts/ui-check/verify-audio-sbs.cjs
// checks the frames in a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

class FakeNode {
  constructor(tag = '') {
    this.tag = tag;
    this.isConnected = true;
    this.classList = { add() {}, toggle() {} };
    this.style = {};
    this.listeners = {};
    this.children = [];
  }
  setAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...kids) { this.children.push(...kids); }
  remove() { this.removed = true; }
  querySelector() { return null; }
  focus() { this.focused = (this.focused || 0) + 1; }
  show() { this.open = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.nativeCloses = (this.nativeCloses || 0) + 1; } // the close event is never delivered
}
globalThis.Node = FakeNode;
globalThis.document = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
};

const { dialog, closeDialogsIn } = await import('../client/components/ui.js');

function open() {
  const opener = new FakeNode('button');
  document.activeElement = opener;
  const closes = [];
  const d = dialog({ title: 'T', body: new FakeNode('div'), modal: false, parent: new FakeNode('div'), onClose: (v) => closes.push(v) });
  return { d, closes, opener, root: { querySelectorAll: () => (d.node.open ? [d.node] : []) } };
}

test('closeDialogsIn runs onClose before it returns, with no close event, once, and leaves the focus alone', async () => {
  const { d, closes, opener, root } = open();
  closeDialogsIn(root);
  assert.equal(closes.length, 1, 'onClose ran without waiting for the close event');
  assert.equal(d.node.open, false);
  assert.equal(d.node.removed, true);
  assert.equal(opener.focused, undefined, 'the person is leaving: the opener does not take the focus');
  await d.done;
  closeDialogsIn(root);
  d.close();
  d.node.listeners.close.forEach((fn) => fn());
  assert.equal(closes.length, 1, 'later closes and a late close event do nothing');
});

test('a plain close still hands the focus back to the opener', () => {
  const { d, closes, opener } = open();
  d.close('v');
  assert.deepEqual(closes, ['v']);
  assert.equal(opener.focused, 1);
});

test('the Workbench closes its overlays through closeDialogsIn, on both paths', async () => {
  const source = await fsp.readFile(new URL('../client/views/workbench.js', import.meta.url), 'utf8');
  assert.equal(source.match(/closeDialogsIn\(ui\.previewWrap\)/g)?.length, 2);
  assert.doesNotMatch(source, /dialog\[open\]'\)\.forEach/, 'a native close would leave onClose to a queued event');
});
