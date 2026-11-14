// The splitter (client/components/splitter.js) on a stub node: a pointer drag applies the clamped size while moving
// and saves once at the end, the sign turns a right panel's drag around, the arrow keys step and save, and nothing
// happens on a move without a press.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

class N {
  constructor(spec) { this.spec = spec; this.attrs = {}; this.listeners = {}; this.classes = new Set(spec.split('.').slice(1)); this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  fire(t, e = {}) { const ev = { preventDefault() { ev.prevented = true; }, ...e }; for (const f of this.listeners[t] || []) f(ev); return ev; }
}
const el = (spec, props = {}) => { const n = new N(spec); for (const [k, v] of Object.entries(props)) { if (k.startsWith('aria') || k === 'role') n.setAttribute(k, v); else n[k] = v; } return n; };
globalThis.__ui = { el };
const source = (await fsp.readFile(new URL('../client/components/splitter.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;');
const { createSplitter } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

function harness(opts) {
  let size = opts.size ?? 236;
  const applied = [];
  const saved = [];
  const node = createSplitter({ read: () => size, apply: (px) => { size = px; applied.push(px); }, save: (px) => saved.push(px), ...opts });
  return { node, applied, saved, size: () => size };
}

test('a left column: the drag applies the width as the pointer moves right, clamped, and saves once at the end', () => {
  const h = harness({ axis: 'x', sign: 1, min: 180, max: 480, label: 'Width of the pages column' });
  assert.equal(h.node.attrs.role, 'separator');
  assert.equal(h.node.attrs['aria-orientation'], 'vertical');
  h.node.fire('pointermove', { clientX: 300 });
  assert.deepEqual(h.applied, [], 'a move without a press does nothing');
  h.node.fire('pointerdown', { button: 0, clientX: 236, pointerId: 1 });
  assert.ok(h.node.classes.has('dragging'));
  h.node.fire('pointermove', { clientX: 286 });
  h.node.fire('pointermove', { clientX: 336 });
  h.node.fire('pointermove', { clientX: 900 });
  assert.deepEqual(h.applied, [286, 336, 480], 'applied as it goes, the last clamped to the max');
  assert.deepEqual(h.saved, []);
  h.node.fire('pointerup', { clientX: 900 });
  assert.deepEqual(h.saved, [480], 'saved once at the end');
  assert.equal(h.node.classes.has('dragging'), false);
});

test('a right panel: sign -1 turns a drag to the left into a wider panel; the min holds', () => {
  const h = harness({ axis: 'x', sign: -1, min: 280, max: 600, size: 340 });
  h.node.fire('pointerdown', { button: 0, clientX: 1000, pointerId: 1 });
  h.node.fire('pointermove', { clientX: 940 });
  assert.equal(h.size(), 400, '60 px to the left: 60 px wider');
  h.node.fire('pointermove', { clientX: 1500 });
  assert.equal(h.size(), 280, 'far to the right: the min');
  h.node.fire('pointercancel');
  assert.deepEqual(h.saved, [280]);
});

test('a section below the handle: sign -1 on the y axis, and the arrow keys step and save', () => {
  const h = harness({ axis: 'y', sign: -1, min: 96, max: 420, size: 156, step: 16 });
  assert.equal(h.node.attrs['aria-orientation'], 'horizontal');
  h.node.fire('pointerdown', { button: 0, clientY: 600, pointerId: 2 });
  h.node.fire('pointermove', { clientY: 560 });
  h.node.fire('pointerup', { clientY: 560 });
  assert.deepEqual([h.size(), h.saved], [196, [196]], 'dragged up 40 px: 40 px taller');
  const up = h.node.fire('keydown', { key: 'ArrowUp' });
  assert.equal(h.size(), 212, 'ArrowUp: one step taller');
  assert.ok(up.prevented);
  h.node.fire('keydown', { key: 'ArrowDown' });
  assert.equal(h.size(), 196);
  h.node.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(h.size(), 196, 'the other axis’ keys do nothing');
  assert.deepEqual(h.saved, [196, 212, 196], 'each key saves');
  assert.equal(h.node.attrs['aria-valuemin'], '96');
  assert.equal(h.node.attrs['aria-valuemax'], '420');
});

test('a second button does not start a drag', () => {
  const h = harness({ axis: 'x', sign: 1, min: 100, max: 500 });
  h.node.fire('pointerdown', { button: 2, clientX: 10, pointerId: 3 });
  h.node.fire('pointermove', { clientX: 200 });
  assert.deepEqual(h.applied, []);
});
