// The Inspiration view's pure parts and its wiring (t_dfs23bojle; docs/DESIGN.md section 10). Risks covered: what is
// typed or pasted becomes the right kind of card (a link, a hex color, a note) and plain words are never mistaken for
// a color; a move by keyboard or by drop names the card it lands before, among the cards on screen; the grid's span
// follows a card's height; the tab, its key, the stylesheet and the live event are wired; the view keeps the rules
// of DESIGN.md (one primary button, tags as words, motion within the token, hover behind a hover query).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { detectKind, addLabel, normalizeHex, readUrl, parseTags, tagsInUse, filterCards, tagChoices, stepTarget, dropTarget, moved, spanFor, estimateHeight, cardName, imageAlt, linkMeta, fileProblem, rgbToHex, fileUrl, countWords, removeWords } from '../client/components/inspiration-words.js';
import { checkHex, checkTags } from '../server/lib/inspiration.mjs';

const read = (rel) => fsp.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('detectKind: a link, a hex color or a note; words that only look like hex stay words', () => {
  assert.deepEqual(detectKind('  https://linear.app/method  '), { kind: 'link', url: 'https://linear.app/method' });
  assert.deepEqual(detectKind('www.are.na/blog'), { kind: 'link', url: 'https://www.are.na/blog' });
  assert.deepEqual(detectKind('#D6A455'), { kind: 'color', hex: '#d6a455' });
  assert.deepEqual(detectKind('#abc'), { kind: 'color', hex: '#aabbcc' });
  assert.deepEqual(detectKind('d6a455'), { kind: 'color', hex: '#d6a455' });
  for (const words of ['added', 'facade', 'bad', 'see https://linear.app for the states', 'notes.txt', 'linear.app', 'ftp://x.example/a', '#d6a4', 'warm charcoal, one accent']) {
    assert.deepEqual(detectKind(words), { kind: 'note', text: words }, words);
  }
  assert.equal(detectKind('   '), null);
  assert.equal(readUrl('http://'), null);
  assert.deepEqual(['Add', 'Add link', 'Add color', 'Add note'], [null, { kind: 'link' }, { kind: 'color' }, { kind: 'note' }].map(addLabel));
  // The field and the server read a hex and a tag the same way.
  for (const v of ['#ABC', 'abc', '#A1b2C3', ' 232221 ']) assert.equal(normalizeHex(v), checkHex(v), v);
  assert.equal(normalizeHex('amber'), null);
  assert.deepEqual(parseTags(' Layout, #MOOD ,layout,, two  words '), checkTags([' Layout', ' #MOOD ', 'layout', '', ' two  words ']));
});

const CARDS = [
  { id: 'a', kind: 'image', file: 'a.png', width: 1200, height: 800, tags: ['layout', 'warm'], why: 'the grid breathes', name: 'shot.png' },
  { id: 'b', kind: 'note', text: 'Quiet surfaces', tags: ['mood'], why: '' },
  { id: 'c', kind: 'color', hex: '#d6a455', name: 'amber', tags: ['color', 'warm'], why: '' },
  { id: 'd', kind: 'link', url: 'https://linear.app/method', title: '', site: 'linear.app', image: null, preview: { ok: false, reason: 'No preview: the page answered 403' }, tags: [], why: '' },
];
const DEFAULTS = ['color', 'layout', 'type', 'motion', 'mood'];

test('tags: the ones in use with their counts, the default set first; the filter; the choices an edit offers', () => {
  assert.deepEqual(tagsInUse(CARDS, DEFAULTS), [{ tag: 'color', count: 1 }, { tag: 'layout', count: 1 }, { tag: 'mood', count: 1 }, { tag: 'warm', count: 2 }]);
  assert.deepEqual(tagsInUse([], DEFAULTS), [], 'a default tag no card has is not offered as a filter');
  assert.deepEqual(filterCards(CARDS, 'warm').map((c) => c.id), ['a', 'c']);
  assert.deepEqual(filterCards(CARDS, null).length, 4);
  assert.deepEqual(tagChoices(DEFAULTS, CARDS, ['mine']), ['color', 'layout', 'type', 'motion', 'mood', 'warm', 'mine']);
});

test('moves: one step by keyboard, a drop before or after a card, and the order a move gives', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.equal(stepTarget(ids, 'c', -1), 'b');
  assert.equal(stepTarget(ids, 'a', -1), undefined, 'already first');
  assert.equal(stepTarget(ids, 'b', 1), 'd', 'later: before the card after the next');
  assert.equal(stepTarget(ids, 'c', 1), null, 'to the end');
  assert.equal(stepTarget(ids, 'd', 1), undefined, 'already last');
  assert.equal(dropTarget(ids, 'a', 'c', false), 'c');
  assert.equal(dropTarget(ids, 'a', 'c', true), 'd');
  assert.equal(dropTarget(ids, 'a', 'd', true), null, 'after the last is the end');
  assert.equal(dropTarget(ids, 'a', 'b', false), undefined, 'before its own neighbour changes nothing');
  assert.equal(dropTarget(ids, 'b', 'a', true), undefined);
  assert.equal(dropTarget(ids, 'b', 'b', true), undefined);
  assert.equal(dropTarget(ids, 'x', 'b', true), undefined);
  assert.deepEqual(moved(ids, 'a', 'c'), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moved(ids, 'a', null), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moved(ids, 'd', 'a'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moved(ids, 'a', 'gone'), ids, 'a card that is not there moves nothing');
  // Among filtered cards the target is still a card on screen, so the server's "before" means the same.
  assert.equal(stepTarget(['a', 'c'], 'a', 1), null);
});

test('the grid: a span from a height; a first guess from the image ratio and the words', () => {
  assert.equal(spanFor(186), 50, '(186 + 14) / 4');
  assert.equal(spanFor(187), 51, 'rounded up, so cards never overlap');
  assert.equal(spanFor(0), 4);
  const wide = estimateHeight({ kind: 'image', width: 1200, height: 600, tags: [], why: '' }, 300);
  const tall = estimateHeight({ kind: 'image', width: 600, height: 1200, tags: [], why: '' }, 300);
  assert.deepEqual([wide, tall], [152, 602]);
  assert.ok(estimateHeight({ kind: 'image', width: 100, height: 5000, tags: [] }, 300) <= 2.2 * 300 + 2, 'a very tall picture is a guess within bounds');
  assert.ok(estimateHeight(CARDS[0], 300) > 200 + 40, 'the why and the tags add to the picture');
  assert.ok(estimateHeight(CARDS[2], 300) >= 96 + 20);
  assert.ok(estimateHeight({ kind: 'note', text: 'x'.repeat(2000), tags: [], why: '' }, 300) <= 14 * 21 + 40, 'a long note is clamped as the card clamps it');
});

test('the words: a card\'s name, an image\'s alt, a link\'s meta, the count line, the remove question, the size sentence', () => {
  assert.deepEqual(CARDS.map(cardName), ['Image: the grid breathes', 'Note: Quiet surfaces', 'Color #d6a455 amber', 'Link: https://linear.app/method']);
  assert.equal(imageAlt(CARDS[0]), 'the grid breathes');
  assert.equal(imageAlt({ kind: 'image', name: 'shot.png', why: '' }), 'shot.png');
  assert.equal(imageAlt({ kind: 'link', title: 'Linear Method', why: '' }), 'Preview of Linear Method');
  assert.equal(linkMeta(CARDS[3]), 'linear.app · No preview: the page answered 403');
  assert.equal(linkMeta({ site: 'Linear', preview: { ok: true } }), 'Linear');
  assert.equal(countWords('Harbor', 6, 6, null), 'Harbor · 6 cards');
  assert.equal(countWords('Harbor', 1, 1, null), 'Harbor · 1 card');
  assert.equal(countWords('Harbor', 6, 2, 'layout'), 'Harbor · 2 of 6 cards · layout');
  assert.equal(removeWords(CARDS[0], 'Harbor'), "Remove this image from Harbor's board? Its image file goes from .studio/inspiration.");
  assert.equal(removeWords(CARDS[1], ''), 'Remove this note from the board?');
  assert.equal(fileProblem({ name: 'big.png', size: 9 * 1024 * 1024 }, { imageBytes: 8 * 1024 * 1024 }), 'An image on the board is at most 8.0 MB; big.png is 9.0 MB');
  assert.equal(fileProblem({ name: 'ok.png', size: 8 * 1024 * 1024 }, { imageBytes: 8 * 1024 * 1024 }), null);
  assert.equal(fileProblem({ name: 'x.exe', size: 10 }, { imageBytes: 100 }), null, 'what a file is, the server reads from its bytes');
  assert.equal(rgbToHex(214, 164.6, 85), '#d6a455');
  assert.equal(rgbToHex(-4, 300, 0), '#00ff00');
  assert.equal(fileUrl('p_1', 'ins_abc12345.png', '2026-11-13T00:00:00.000Z'), '/api/projects/p_1/inspiration/files/ins_abc12345.png?v=2026-11-13T00%3A00%3A00.000Z');
});

test('the tab sits after Learning with key 3; the stylesheet, the route, the event and studio.show are wired', async () => {
  const app = await read('client/app.js');
  const html = await read('client/index.html');
  assert.match(html, /<a href="#\/learning"[^\n]*\n\s*<a href="#\/inspiration" data-view="inspiration" title="Inspiration \(3\): the project's board of design references">Inspiration<\/a>\n\s*<a href="#\/claude-code" data-view="claude-code" title="Claude Code \(4\)">/);
  assert.match(html, /<link rel="stylesheet" href="\/inspiration\.css">/);
  assert.match(app, /inspiration: \(\) => import\('\.\/views\/inspiration\.js'\)/);
  assert.match(app, /es\.addEventListener\('inspiration\.changed', \(e\) => emit\('inspiration', data\(e\)\)\)/);
  assert.match(app, /\['1 – 8', 'Workbench · Learning · Inspiration · Claude Code · Tasks · Memory · Budget · Settings'\]/);
  const { VIEW_ROUTES } = await import('../client/components/studio-show.js');
  assert.equal(VIEW_ROUTES.inspiration, 'inspiration');
  const api = await read('client/api.js');
  for (const call of ['inspiration: (id) => get(', 'addInspiration: (id, card) => post(', 'patchInspiration: (id, cardId, b) => patch(', 'moveInspiration: (id, b) => post(', 'removeInspiration: (id, cardId) => del(']) assert.ok(api.includes(call), call);
});

test('the view keeps the design rules: one primary button, tags as words, motion within the token, hover behind a hover query', async () => {
  const view = await read('client/views/inspiration.js');
  const card = await read('client/components/inspiration-card.js');
  const edit = await read('client/components/inspiration-edit.js');
  const css = await read('client/inspiration.css');
  assert.equal(view.match(/variant: 'primary'/g).length, 1, 'Add is the view\'s one primary button');
  assert.doesNotMatch(view + card, /stateChip|\.chip|chip\(/, 'a tag is a word, never a chip');
  assert.match(card, /el\('p\.inspo-tags', card\.tags\.join\(' · '\)\)/);
  for (const file of [view, card, edit]) assert.ok(file.split('\n').length <= 500, 'files stay under about 500 lines');
  // Every transition names its properties and runs on the studio's token (140 ms; 0 with reduced motion).
  const transitions = [...css.matchAll(/transition: ([^;]+);/g)].map((m) => m[1]);
  assert.ok(transitions.length >= 4);
  for (const t of transitions) { assert.doesNotMatch(t, /\ball\b/, t); for (const part of t.split(',')) assert.match(part.trim(), /^(opacity|border-color|background|color) var\(--t\) ease-out$/, part); }
  assert.doesNotMatch(css, /@keyframes|animation:/, 'nothing here animates by keyframes');
  assert.doesNotMatch(css.match(/\.inspo-pick-mark \{[^}]*\}/)[0] + css.match(/\.inspo-pick-read \{[^}]*\}/)[0], /transition/, 'what follows the pointer is not animated');
  const outsideHoverQuery = css.replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, '');
  assert.doesNotMatch(outsideHoverQuery, /:hover/, 'hover styles only where a pointer can hover');
  assert.match(css, /@media \(hover: none\) \{ \.inspo-actions \{ opacity: 1; \} \}/, 'a touch screen shows the actions');
  // The board's classes are its own: .insp-* is the task inspector's (views.css), whose serif title once dressed a link card.
  const others = (await read('client/views.css')) + (await read('client/styles.css')) + (await read('client/learning.css'));
  assert.doesNotMatch(others, /\.inspo\b/, 'no other stylesheet styles the board');
  for (const m of css.matchAll(/\.(insp-[a-z-]+)/g)) assert.fail(`${m[1]} is the task inspector's prefix`);
  assert.doesNotMatch(view + card + edit, /['.]insp-/, 'nor does the view use the inspector\'s classes');
  // Colours are tokens; the eyedropper's mark alone is white ringed in black, to show on any picture.
  assert.equal(css.replace(/\.inspo-pick-mark \{[^}]*\}/, '').match(/#[0-9a-f]{3,6}\b/gi), null, 'colours come from the tokens');
  // The board: packed by height in board order, so the reading order is the tab order.
  const { GRID_ROW } = await import('../client/components/inspiration-words.js');
  assert.match(css, new RegExp(`\\.inspo-board \\{[^}]*grid-auto-rows: ${GRID_ROW}px; grid-auto-flow: row dense;`), 'the span is counted in the row unit the grid uses');
  // An echo of this window's own change redraws nothing, and a redraw gives the focus back to the card that held it.
  assert.match(view, /const same = !me\.error && me\.cards !== null && snapshot === me\.snapshot;/);
  assert.match(view, /const keepId = focusId \|\| me\.board\.querySelector\('\.inspo-card:focus-within'\)\?\.dataset\.card \|\| null;/);
  // Paste and drop work anywhere on the view; the server's sentence is what a refusal shows.
  assert.match(view, /document\.addEventListener\('paste', onPaste\)/);
  assert.match(view, /root\.addEventListener\('drop', /);
  assert.match(view, /catch \(err\) \{\n    toastError\(err, 'Inspiration'\);/);
  assert.match(view, /confirmDialog\(\{ title: 'Remove card', message, confirm: 'Remove', variant: 'danger', cancel: 'Keep it' \}\)/, 'removal asks once');
  assert.match(view, /: removeWords\(card, projectName\(\)\);/, 'an app board\'s card names its project');
  assert.match(card, /rel: 'noopener noreferrer'/, 'a link opens without handing the studio window over');
});
