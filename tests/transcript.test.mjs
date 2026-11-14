// The real client/components/transcript.js on a small stub DOM (its ui.js and markdown.js imports swapped, the
// matcher real): rowNodes takes its own label whenever callLabel is not a function, and eventLines no longer hands it
// flatMap's index, which threw "callLabel is not a function" on every finished turn with a tool call (#81).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
function el(spec, props, ...children) {
  if (props === null || props === undefined || props.isNode || typeof props !== 'object' || Array.isArray(props)) { children.unshift(props); props = null; }
  const n = {
    isNode: true, spec, kids: [], attrs: {}, hidden: false,
    setAttribute(k, v) { n.attrs[k] = String(v); }, addEventListener() {},
    append(...more) { n.kids.push(...flatten(more)); },
  };
  for (const [k, v] of Object.entries(props || {})) if (v !== undefined && v !== null && v !== false) n[k] = v;
  n.append(...children);
  return n;
}
globalThis.__tui = { el, stateChip: (text, tone, title) => el(`span.chip.tone-${tone}`, { title }, text) };
globalThis.__tmd = { markdown: (text) => el('div.md', text) };
const source = (await fsp.readFile(new URL('../client/components/transcript.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__tui;')
  .replace(/import \{([^}]*)\} from '\.\/markdown\.js';/, 'const {$1} = globalThis.__tmd;')
  .replace("'./transcript-match.js'", JSON.stringify(new URL('../client/components/transcript-match.js', import.meta.url).href));
const t = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const leaves = (n) => (n?.isNode ? n.kids.flatMap((k) => (typeof k === 'string' ? (n.kids.length === 1 ? [k] : []) : leaves(k))) : []);
const call = { e: { kind: 'tool', name: 'Read', summary: 'copy.mjs' }, result: null, denied: false };

test('rowNodes labels a call with name · summary when callLabel is not a function', () => {
  for (const bad of [undefined, null, 0, 3, 'label', {}]) {
    assert.deepEqual(leaves(el('div', t.rowNodes(call, bad))), ['Read · copy.mjs'], `callLabel ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(leaves(el('div', t.rowNodes(call, (e) => `verb ${e.name}`))), ['verb Read'], 'a function is used');
  const denied = { ...call, denied: { kind: 'denied', name: 'Read' } };
  assert.match(leaves(el('div', t.rowNodes(denied, 1)))[0], /^denied: Read · copy\.mjs$/);
  assert.match(leaves(el('div', t.rowNodes({ orphan: { kind: 'denied', name: 'Bash', summary: 'rm' }, tone: 'warn' }, null)))[0], /^denied: Bash · rm$/);
});

test('eventLines draws every call of a finished turn, the second and later ones too', () => {
  const events = [
    { kind: 'tool', id: 'a', name: 'Read', summary: 'copy.mjs', ms: 900 },
    { kind: 'tool-result', id: 'a', name: 'Read', ok: true, summary: '40 lines' },
    { kind: 'tool', id: 'b', name: 'Edit', summary: 'welcome.mjs', ms: 4000 },
    { kind: 'tool-result', id: 'b', name: 'Edit', ok: false, summary: 'no match' },
  ];
  const lines = leaves(t.eventLines(events));
  assert.deepEqual(lines, ['Read · copy.mjs', '40 lines', 'failed: Edit · welcome.mjs']);
});
