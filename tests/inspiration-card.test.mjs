// A link card's node never carries an href that is not http or https (t_pc4228bm15). Risk covered: a card read back
// from .studio/inspiration.json can hold any address (a file edited by hand, an imported folder), and a javascript:
// address in an href would run in the studio's own page when clicked. The server leaves such a card out of its answer
// (tests/inspiration.test.mjs); this is the view's own check, run with the real cardNode on a stub DOM, for a card
// that reaches it some other way. The server and the view use one function, httpUrl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

class FakeNode {
  constructor(tag = '') { this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.attrs = {}; this.on = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { this.on[type] = fn; }
  removeEventListener() {}
  append(...kids) { this.children.push(...kids); }
  replaceChildren() { this.children = []; }
  remove() {}
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  get childNodes() { return this.children; }
  get text() { return this.value ?? this.children.map((c) => c.text).join(''); }
  set text(v) { this.value = v; }
}
globalThis.Node = FakeNode;
globalThis.document = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.text = text; return n; },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => null,
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { cardNode } = await import('../client/components/inspiration-card.js');
const { httpUrl } = await import('../client/components/inspiration-words.js');

const walk = (node, pick, out = []) => { if (pick(node)) out.push(node); for (const c of node.children || []) walk(c, pick, out); return out; };
const ctx = { projectId: 'p_1', onEdit() {}, onRemove() {}, onMove() {}, onPick() {}, onPicking() {} };
const link = (url, more = {}) => ({ id: 'ins_link00001', kind: 'link', url, title: 'Click me', description: '', site: 'example.com', image: null, preview: { ok: true }, tags: [], why: '', ...more });

const GOOD = ['https://linear.app/method', 'http://example.com/', 'HTTPS://Example.com/a?b=c#d', 'https://example.com/a b'];
const BAD = [
  'javascript:alert(1)', 'JaVaScRiPt:alert(document.domain)', ' javascript:alert(1)', '\tjavascript:alert(1)', '\u0001javascript:alert(1)', 'java\tscript:alert(1)',
  'javascript://example.com/%0aalert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///C:/Windows/win.ini', 'blob:https://example.com/1',
  '//evil.example/x', '/api/state', 'evil.example', 'https:evil.example', 'http://', ' https://example.com/', '', null, undefined, 7, ['https://example.com/'], { href: 'https://example.com/' },
];

test('httpUrl: the address itself when it is http or https, null for every other scheme, spelling or type', () => {
  for (const url of GOOD) assert.equal(httpUrl(url), url, url);
  for (const url of BAD) assert.equal(httpUrl(url), null, JSON.stringify(url));
});

test('a link card with an http or https address is a link that opens in a new tab without handing the window over', () => {
  for (const url of GOOD) {
    const li = cardNode(link(url), ctx);
    const anchors = walk(li, (n) => n.tag === 'a');
    assert.equal(anchors.length, 1, url);
    assert.deepEqual([anchors[0].attrs.href, anchors[0].attrs.target, anchors[0].attrs.rel, anchors[0].text], [url, '_blank', 'noopener noreferrer', 'Click me']);
  }
});

test('a link card with a javascript: address, or any address that is not http or https, has no link and no href: its words stay as words', () => {
  for (const url of BAD) {
    const li = cardNode(link(url), ctx);
    const what = JSON.stringify(url);
    assert.deepEqual(walk(li, (n) => n.tag === 'a'), [], `no anchor for ${what}`);
    // The only hrefs left in the card are its two icons' own sprite references (#i-edit, #i-trash).
    assert.deepEqual(walk(li, (n) => 'href' in n.attrs || 'href' in n).map((n) => [n.tag, n.attrs.href]), [['use', '#i-edit'], ['use', '#i-trash']], `no href from the card for ${what}`);
    const title = walk(li, (n) => (n.className || '').split(' ').includes('inspo-title'));
    assert.equal(title.length, 1, what);
    assert.deepEqual([title[0].tag, title[0].text, title[0].attrs.title], ['span', 'Click me', 'Not an http or https address, so it is not opened as a link']);
    assert.equal(title[0].on.click, undefined, 'and nothing happens on a click');
  }
  // With no title the address shows as text (and in the card's name), never as an attribute a browser would follow.
  const bare = cardNode(link('javascript:alert(1)', { title: '' }), ctx);
  const span = walk(bare, (n) => (n.className || '').split(' ').includes('inspo-title'))[0];
  assert.deepEqual([span.tag, span.text], ['span', 'javascript:alert(1)']);
  const holding = walk(bare, (n) => Object.values(n.attrs).some((v) => String(v).includes('javascript:'))).flatMap((n) => Object.keys(n.attrs).filter((k) => String(n.attrs[k]).includes('javascript:')));
  assert.deepEqual(holding, ['aria-label'], 'only the name read aloud holds the words');
});

test('the server reads the record with the same function, and no other place of the view makes an href from a card', async () => {
  const read = (rel) => fsp.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
  const server = await read('server/lib/inspiration.mjs');
  assert.match(server, /import \{ httpUrl \} from '\.\.\/\.\.\/client\/components\/inspiration-words\.js';/);
  assert.match(server, /const validCard = \(c\) => [^\n]*\(c\.kind !== 'link' \|\| httpUrl\(c\.url\) !== null\);/);
  const card = await read('client/components/inspiration-card.js');
  assert.equal(card.match(/el\('a[.']/g).length, 1, 'the card makes one anchor');
  assert.match(card, /const href = httpUrl\(card\.url\);/);
  assert.match(card, /href \? el\('a\.inspo-title', \{ href, target: '_blank', rel: 'noopener noreferrer', title: href \}, words\)/, 'whose href is the checked address');
  assert.doesNotMatch(card, /href: card\.|innerHTML|window\.open/);
  for (const rel of ['client/views/inspiration.js', 'client/components/inspiration-edit.js']) {
    assert.doesNotMatch(await read(rel), /el\('a[.']|href:|innerHTML|window\.open/, `${rel} makes no link and opens nothing`);
  }
});
