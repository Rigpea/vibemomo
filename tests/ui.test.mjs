// The toasts of client/components/ui.js on a stub DOM: an error stays until dismissed, or until its own action succeeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag = '') { this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.parent = null; }
  setAttribute(k, v) { this[k] = v; }
  addEventListener() {}
  append(...kids) { for (const kid of kids) { kid.parent = this; this.children.push(kid); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  get textContent() { return this.tag === '#text' ? this.text : this.children.map((c) => c.textContent).join(''); }
}
globalThis.Node = FakeNode;
const host = new FakeNode('div');
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
  getElementById: () => host,
};

const { toast, toastError, chip } = await import('../client/components/ui.js');
const words = () => host.children.map((t) => t.textContent);
const quick = { tone: 'ok', timeout: 0 };

test('an error toast carries its prefix; one without a prefix carries none', () => {
  host.children = [];
  assert.equal(toastError(new Error('no such folder'), 'Import').dataset.prefix, 'Import');
  assert.equal(toastError(new Error('plain')).dataset.prefix, undefined);
  assert.deepEqual(words(), ['Import: no such folder', 'plain']);
});

test('success clears the earlier errors of its own action, and only those', () => {
  host.children = [];
  toastError(new Error('one'), 'Import');
  toastError(new Error('two'), 'Import');
  toastError(new Error('other'), 'New project');
  toastError(new Error('none'));
  toast('A note', quick);
  toast('Imported Room', { ...quick, clears: 'Import' });
  assert.deepEqual(words(), ['New project: other', 'none', 'A note', 'Imported Room']);
});

test('without clears every error stays, and nothing else clears them', () => {
  host.children = [];
  toastError(new Error('one'), 'Import');
  toast('Saved', quick);
  toast('Created', { ...quick, clears: 'New project' });
  assert.deepEqual(words(), ['Import: one', 'Saved', 'Created']);
});

test('a chip shows the words it is given, or its state\'s label, with the same tone', () => {
  assert.equal(chip('review', 'Status in Room').textContent, 'Ready to try');
  const named = chip('review', 'Status in Room', 'Room: ready to try');
  assert.equal(named.textContent, 'Room: ready to try');
  assert.equal(named.title, 'Status in Room');
  assert.equal(named.className, 'chip tone-ok');
});
