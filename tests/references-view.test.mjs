// The references' pure parts and their wiring into the Inspiration view (t_yrm68pllr3; docs/DESIGN.md section 13).
// Risks covered: the list groups by kind in the server's order; the search reads titles, text and tags and needs
// every word; the tag filter and the search narrow together; an edit sends only what changed; a long text is cut for
// the list and says how to see the rest; the part is reached by its own address and the board's paste and drop stand
// still while it is shown; the view keeps DESIGN.md's rules (one primary button in sight, one Copy button on a
// prompt, no chip, tokens only, motion within the token, hover behind a hover query).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { KIND_WORDS, KIND_ONE, kindWord, LANGUAGES, HAS_TEXT, refName, refLabel, linkMeta, hostOf, lineCount, searchWords, matchesSearch, filterRefs, tagsInUse, parseTags, groupRefs, shownOrder, countWords, clampLines, isLong, moreWords, formPatch, removeWords, SHOWN_LINES, EMPTY_WORDS, NO_MATCH_WORDS, USE_HINT } from '../client/components/references-words.js';
import { REF_KINDS, LANGUAGE, TEXT_MAX } from '../server/lib/references.mjs';

const read = (rel) => fsp.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

const REFS = [
  { id: 'ref_n1', kind: 'note', title: '', text: 'Chips are for states only.', useFor: '', source: 'docs/DESIGN.md', tags: ['design'] },
  { id: 'ref_p1', kind: 'prompt', title: 'Review a diff', text: 'Review this diff.\nName each fault.', useFor: 'a second opinion', source: '', tags: ['review', 'method'] },
  { id: 'ref_s1', kind: 'snippet', title: 'Atomic write', text: 'await fsp.rename(tmp, file);', language: 'js', useFor: 'every record write', source: '', tags: ['records'] },
  { id: 'ref_l1', kind: 'link', title: 'MCP tools', url: 'https://www.example.com/docs/mcp', site: 'Example Docs', description: 'How tools are listed.', preview: { ok: true }, useFor: '', source: '', tags: ['mcp', 'design'] },
  { id: 'ref_l2', kind: 'link', title: '', url: 'https://www.example.com/pricing', site: '', preview: { ok: false, reason: 'No preview: the page answered 403' }, useFor: '', source: '', tags: [] },
];

test('the list: by kind in the server\'s order, a kind with none left out; names, the count line and the words', () => {
  assert.deepEqual(Object.keys(KIND_WORDS), REF_KINDS, 'the client names every kind the server takes, in its order');
  assert.deepEqual(Object.keys(KIND_ONE), REF_KINDS);
  assert.deepEqual(HAS_TEXT, Object.keys(TEXT_MAX), 'the kinds with a text are the ones the server limits');
  for (const l of LANGUAGES) assert.match(l, LANGUAGE, `${l} is a language the server takes`);
  assert.deepEqual(groupRefs(REFS, REF_KINDS).map((g) => [g.kind, g.entries.map((e) => e.id)]), [['link', ['ref_l1', 'ref_l2']], ['snippet', ['ref_s1']], ['prompt', ['ref_p1']], ['note', ['ref_n1']]]);
  assert.deepEqual(shownOrder(REFS, REF_KINDS), ['ref_l1', 'ref_l2', 'ref_s1', 'ref_p1', 'ref_n1']);
  assert.deepEqual(groupRefs([], REF_KINDS), []);
  assert.equal(kindWord('snippet'), 'Snippets');
  assert.equal(refName(REFS[3]), 'MCP tools');
  assert.equal(refName(REFS[4]), 'https://www.example.com/pricing', 'a link with no title is named by its address');
  assert.equal(refName(REFS[0]), 'Chips are for states only.', 'a note with no title by its first line');
  assert.equal(refName({ kind: 'note', text: '\n\n  second line first  \nthird' }), 'second line first');
  assert.ok(refName({ kind: 'note', text: 'w '.repeat(200) }).length <= 80);
  assert.equal(refLabel(REFS[2]), 'Snippet: Atomic write');
  assert.equal(hostOf('https://www.example.com/a'), 'example.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(linkMeta(REFS[3]), 'Example Docs');
  assert.equal(linkMeta(REFS[4]), 'example.com · No preview: the page answered 403', 'a page that gave nothing says why');
  assert.equal(countWords('Harbor', 5, 5), 'Harbor · 5 references');
  assert.equal(countWords('Harbor', 1, 1), 'Harbor · 1 reference');
  assert.equal(countWords('', 0, 0), '0 references');
  assert.equal(countWords('Harbor', 5, 2, { tag: 'design' }), 'Harbor · 2 of 5 references · design');
  assert.equal(countWords('Harbor', 5, 1, { tag: 'design', search: ' mcp ' }), 'Harbor · 1 of 5 references · design · “mcp”');
  assert.equal(removeWords(REFS[1], 'Harbor'), "Remove this prompt from Harbor's references? Claude will no longer get it in a brief.");
  assert.equal(removeWords(REFS[0], ''), 'Remove this note from the references? Claude will no longer get it in a brief.');
  assert.match(EMPTY_WORDS, /^No references yet\. A reference is something to build from/);
  assert.match(NO_MATCH_WORDS, /^No reference matches\./);
  assert.match(USE_HINT, /^Optional\./);
});

test('search: titles, text and tags (and the rest of an entry), every word, any order, any case; with the tag filter', () => {
  assert.deepEqual(searchWords('  Atomic   WRITE '), ['atomic', 'write']);
  const ids = (opts) => filterRefs(REFS, opts).map((e) => e.id);
  assert.deepEqual(ids({}), REFS.map((e) => e.id), 'nothing asked leaves everything, in the order given');
  assert.deepEqual(ids({ search: 'atomic' }), ['ref_s1'], 'a title');
  assert.deepEqual(ids({ search: 'RENAME' }), ['ref_s1'], 'a text');
  assert.deepEqual(ids({ search: 'method' }), ['ref_p1'], 'a tag');
  assert.deepEqual(ids({ search: 'opinion' }), ['ref_p1'], 'the use-it-for line');
  assert.deepEqual(ids({ search: 'pricing' }), ['ref_l2'], 'a link\'s address');
  assert.deepEqual(ids({ search: 'fault diff' }), ['ref_p1'], 'every word, in any order');
  assert.deepEqual(ids({ search: 'fault atomic' }), [], 'not one word here and one there');
  assert.deepEqual(ids({ search: 'snippet' }), ['ref_s1'], 'a kind');
  assert.deepEqual(ids({ tag: 'design' }), ['ref_n1', 'ref_l1']);
  assert.deepEqual(ids({ tag: 'design', search: 'mcp' }), ['ref_l1'], 'both narrow together');
  assert.deepEqual(ids({ tag: 'nothing' }), []);
  assert.equal(matchesSearch(REFS[0], ''), true);
  assert.deepEqual(tagsInUse(REFS), [{ tag: 'design', count: 2 }, { tag: 'mcp', count: 1 }, { tag: 'method', count: 1 }, { tag: 'records', count: 1 }, { tag: 'review', count: 1 }], 'by name, with how many carry each');
  assert.deepEqual(parseTags(' MCP, #docs ,, mcp , file  system '), ['mcp', 'docs', 'file system']);
});

test('a long text shows its first lines and says how to see the rest', () => {
  const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.equal(lineCount(code), 30);
  assert.equal(lineCount(''), 0);
  assert.deepEqual(clampLines(code, SHOWN_LINES.snippet), { text: code.split('\n').slice(0, 12).join('\n'), cut: true, lines: 30 });
  assert.deepEqual(clampLines('a\nb', 12), { text: 'a\nb', cut: false, lines: 2 });
  assert.equal(isLong({ kind: 'snippet', text: code }), true);
  assert.equal(isLong({ kind: 'snippet', text: 'x'.repeat(5000) }), false, 'one long line of code scrolls sideways; it is not cut');
  assert.equal(isLong({ kind: 'prompt', text: 'word '.repeat(200) }), true, 'a long paragraph wraps past the lines shown');
  assert.equal(isLong({ kind: 'note', text: 'short' }), false);
  assert.equal(moreWords({ kind: 'snippet', text: code }, false), 'Show all 30 lines');
  assert.equal(moreWords({ kind: 'prompt', text: code }, false), 'Show all');
  assert.equal(moreWords({ kind: 'snippet', text: code }, true), 'Show less');
});

test('formPatch: a new entry sends the fields of its kind; an edit sends only what changed', () => {
  assert.deepEqual(formPatch(null, { kind: 'link', title: '', url: ' https://example.com/a ', text: 'left from another kind', language: 'js', useFor: '  the  docs ', source: '', tags: 'MCP, #docs' }),
    { kind: 'link', title: '', useFor: 'the docs', source: '', tags: ['mcp', 'docs'], url: 'https://example.com/a' }, 'a link sends no text and no language');
  assert.deepEqual(formPatch(null, { kind: 'snippet', title: ' Atomic  write ', url: 'https://x.example', text: '  const a = 1;\r\n  ', language: ' JS ', useFor: '', source: '', tags: '' }),
    { kind: 'snippet', title: 'Atomic write', useFor: '', source: '', tags: [], text: '  const a = 1;', language: 'js' }, 'code keeps its indentation; no address is sent');
  assert.deepEqual(formPatch(null, { kind: 'note', title: '', text: 'A note', language: 'js', useFor: '', source: '', tags: '' }), { kind: 'note', title: '', useFor: '', source: '', tags: [], text: 'A note' });
  const same = { title: 'Atomic write', text: REFS[2].text, language: 'js', useFor: 'every record write', source: '', tags: 'records' };
  assert.deepEqual(formPatch(REFS[2], same), {}, 'nothing changed, nothing sent');
  assert.deepEqual(formPatch(REFS[2], { ...same, kind: 'note' }), {}, 'an entry keeps its kind whatever the form says');
  assert.deepEqual(formPatch(REFS[2], { ...same, tags: 'records, fs', useFor: '' }), { useFor: '', tags: ['records', 'fs'] });
  assert.deepEqual(formPatch(REFS[2], { ...same, text: 'await rename(tmp, file);', language: '' }), { text: 'await rename(tmp, file);', language: '' });
  assert.deepEqual(formPatch(REFS[3], { title: 'MCP tools', url: 'https://www.example.com/docs/tools', useFor: '', source: '', tags: 'mcp, design' }), { url: 'https://www.example.com/docs/tools' });
  assert.deepEqual(formPatch(REFS[3], { title: '', url: REFS[3].url, useFor: '', source: '', tags: 'mcp, design' }), { title: '' }, 'an emptied title is sent, and the dialog asks for the page\'s own');
});

test('the references are a part of the Inspiration view with their own address; the route, the event and the calls are wired', async () => {
  const app = await read('client/app.js');
  const view = await read('client/views/inspiration.js');
  const api = await read('client/api.js');
  const edit = await read('client/components/references-edit.js');
  for (const call of ['references: (id) => get(', 'addReference: (id, entry) => post(', 'patchReference: (id, refId, b) => patch(', 'removeReference: (id, refId) => del(']) assert.ok(api.includes(call), call);
  assert.match(app, /es\.addEventListener\('references\.changed', \(e\) => emit\('references', data\(e\)\)\)/);
  assert.match(view, /const REFS_HASH = '#\/inspiration\/references';/);
  assert.equal(('#/inspiration/references'.match(/^#\/([\w-]+)/) || [])[1], 'inspiration', 'the router still reads the view from the address');
  assert.match(view, /segBtn\('board', 'Board'\), segBtn\('rules', 'Fixed rules', rulesN\), segBtn\('references', 'References', refsN\)/);
  assert.match(view, /names\(RULES_HASH\) \? 'rules' : names\(REFS_HASH\) \? 'references' : /);
  assert.match(view, /ui\.refsHost\.hidden = mode !== 'references';/);
  assert.match(view, /ui\.refs\.unmount\(\);/);
  // Off the board its hands are still: a paste or a drop there must not add a card (the board's own guards).
  assert.match(view, /if \(!boardReady\(\) \|\| document\.querySelector\('dialog\[open\]'\)\) return;/);
  assert.match(view, /return boardReady\(\) && !types\.includes\(CARD_DRAG\)/);
  assert.match(view, /const boardReady = \(\) => !!ui && boardish\(ui\.mode\) && !!ui\.boardKey;/, 'only a board part (the app\'s or the Studio look) takes a paste or a drop');
  assert.match(view, /const boardish = \(mode\) => mode === 'board' \|\| mode === 'look';/);
  // An emptied link title asks the page again, and the dialog answers a refusal itself.
  assert.match(edit, /if \(entry && kind === 'link' && patch\.title === '' && !patch\.url\) patch\.refetch = true;/);
  assert.match(edit, /noValidate: true/);
});

test('the part keeps the design rules: one primary button in sight, one Copy on a prompt, no chip, tokens only, motion within the token', async () => {
  const view = await read('client/views/inspiration.js');
  const panel = await read('client/components/references-panel.js');
  const edit = await read('client/components/references-edit.js');
  const words = await read('client/components/references-words.js');
  const css = await read('client/inspiration.css');
  // Add (the board), Add rule (the rules) and Add reference are never on screen together: each part hides the others'.
  assert.equal(panel.match(/variant: 'primary'/g).length, 1);
  assert.match(view, /ui\.refs\.addButton\.hidden = mode !== 'references';/);
  assert.match(view, /ui\.rules\.addButton\.hidden = mode !== 'rules';/);
  assert.match(view, /for \(const node of \[ui\.form, ui\.bar, ui\.main\]\) node\.hidden = !boardish\(mode\);/);
  assert.equal(panel.match(/button\('Copy'/g).length, 1, 'one Copy button in a row');
  assert.match(panel, /const copies = entry\.kind === 'prompt' \|\| entry\.kind === 'snippet';/);
  assert.doesNotMatch(panel + edit, /stateChip|\.chip|chip\(/, 'a kind and a tag are words, never chips');
  for (const file of [view, panel, edit, words]) assert.ok(file.split('\n').length <= 500, 'files stay under about 500 lines');
  assert.match(panel, /confirmDialog\(\{ title: `Remove \$\{entry\.kind\}`, message: removeWords\(entry, projectName\(\)\), confirm: 'Remove', variant: 'danger', cancel: 'Keep it' \}\)/, 'removal asks once');
  assert.equal(panel.match(/confirmDialog\(/g).length, 1);
  assert.match(panel, /const same = !st\.error && st\.entries !== null && snapshot === st\.snapshot;/, 'the echo of this window\'s own change redraws nothing');
  assert.match(edit, /say\(message\);\n\s+btn\.disabled = false; words\.textContent = was;\n\s+fieldOf\(message\)\.focus\(\);/, 'a refusal stays in the dialog, with the focus on its field');
  // A link opens in a new tab without handing the opener over; code is marked as code for a page translator.
  assert.match(panel, /target: '_blank', rel: 'noopener noreferrer'/);
  assert.match(panel, /box\.setAttribute\('translate', 'no'\)/);
  assert.match(edit, /text\.setAttribute\('translate', 'no'\)/);
  // Nothing of an entry is ever set as HTML.
  assert.doesNotMatch(panel + edit, /innerHTML|insertAdjacentHTML|outerHTML/);
  // The references' styles: the studio's tokens only, one transition on the token, hover behind a hover query.
  const own = css.slice(css.indexOf('/* ---------- references'));
  assert.ok(own.length > 1500);
  assert.equal(own.match(/#[0-9a-f]{3,8}\b/gi), null, 'colours come from the tokens');
  assert.deepEqual([...own.matchAll(/transition: ([^;]+);/g)].map((m) => m[1]), ['opacity var(--t) ease-out']);
  assert.doesNotMatch(own, /@keyframes|animation:/);
  assert.doesNotMatch(own.replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, ''), /:hover/, 'hover styles only where a pointer can hover');
  assert.match(own, /@media \(hover: none\) \{ \.ref-tools \{ opacity: 1; \} \}/, 'a touch screen shows the actions');
  assert.match(own, /\.ref:focus-visible \{ outline: 2px solid var\(--focus\)/, 'an entry that holds the focus shows it');
  assert.match(own, /\.ref-code:focus-visible \{ outline: 2px solid var\(--focus\)/, 'and so does a code box that scrolls');
  assert.match(own, /\.ref \{[^}]*break-inside: avoid;/, 'an entry is never cut between two columns');
  assert.match(own, /\.ref-code \{[^}]*white-space: pre;[^}]*overflow-x: auto;/, 'a long line scrolls inside its box');
});
