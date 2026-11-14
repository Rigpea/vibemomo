// The fixed rules' pure parts and their wiring into the Inspiration view (t_coydia7ucq; docs/DESIGN.md section 11).
// Risks covered: the list groups by kind in the server's order; an edit sends only what changed and a cleared token
// goes as null; a swatch shows only for a value that is a color; the part is reached by its own address and the
// board's paste, drop and eyedropper stand still while the rules are shown; the view keeps DESIGN.md's rules (one
// primary button in sight, no chip, tokens only, motion within the token, hover behind a hover query).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { KIND_WORDS, kindWord, groupRules, shownOrder, countWords, tokenWords, swatchOf, ruleName, formPatch, removeWords, EMPTY_WORDS, TOKEN_HINT } from '../client/components/rules-words.js';
import { RULE_KINDS, byKind } from '../server/lib/rules.mjs';

const read = (rel) => fsp.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

const RULES = [
  { id: 'rule_m1', text: 'Motion 160 ms or less', kind: 'motion', why: 'docs/DESIGN.md section 1', token: null },
  { id: 'rule_c1', text: 'Amber is the one accent', kind: 'color', why: '', token: { name: '--accent', value: '#d6a455' } },
  { id: 'rule_t1', text: 'Chips only for states', kind: 'tone', why: '', token: null },
  { id: 'rule_c2', text: 'Warm charcoal canvas', kind: 'color', why: 'the look', token: { name: '--bg', value: '#232221' } },
];

test('the list: by kind in the server\'s order, a kind with none left out; the count line; the words', () => {
  assert.deepEqual(Object.keys(KIND_WORDS), RULE_KINDS, 'the client names every kind the server takes, in its order');
  assert.deepEqual(groupRules(RULES, RULE_KINDS).map((g) => [g.kind, g.rules.map((r) => r.id)]), [['color', ['rule_c1', 'rule_c2']], ['motion', ['rule_m1']], ['tone', ['rule_t1']]]);
  assert.deepEqual(shownOrder(RULES, RULE_KINDS), byKind(RULES).map((r) => r.id), 'the screen and the brief list them in one order');
  assert.deepEqual(groupRules([], RULE_KINDS), []);
  assert.equal(kindWord('behaviour'), 'Behaviour');
  assert.equal(countWords('Harbor', RULES), 'Harbor · 4 rules · 2 locked tokens');
  assert.equal(countWords('Harbor', [RULES[1]]), 'Harbor · 1 rule · 1 locked token');
  assert.equal(countWords('', [RULES[0]]), '1 rule');
  assert.equal(countWords('Harbor', []), 'Harbor · 0 rules');
  assert.equal(tokenWords(RULES[1].token), '--accent: #d6a455');
  assert.equal(tokenWords(null), '');
  assert.equal(ruleName(RULES[1]), 'Color rule: Amber is the one accent');
  assert.ok(ruleName({ kind: 'tone', text: 'w '.repeat(100) }).length <= 'Tone rule: '.length + 90);
  assert.equal(removeWords(RULES[1], 'Harbor'), "Remove this rule from Harbor's fixed rules? Claude will no longer be told to keep it. Its lock on --accent goes with it.");
  assert.equal(removeWords(RULES[0], ''), 'Remove this rule from the fixed rules? Claude will no longer be told to keep it.');
  assert.match(EMPTY_WORDS, /^No fixed rules yet\./);
  assert.match(TOKEN_HINT, /^Optional\. Locks one CSS custom property at this value/);
});

test('a swatch only for a value that is a color: a hex or one color function of numbers', () => {
  for (const v of ['#d6a455', '#abc', '#abcd', '#d6a45580', ' #232221 ', 'rgb(214 164 85)', 'rgba(214, 164, 85, 0.16)', 'hsl(37 61% 59%)', 'oklch(0.75 0.11 78)']) assert.equal(swatchOf(v), v.trim(), v);
  for (const v of ['140ms', '6px', '"Source Serif 4", serif', 'var(--accent)', 'rgb(var(--r) 0 0)', '#d6a45', '#xyz', 'amber', '', null, 'calc(1px + 2px)', '0 12px 32px rgba(0, 0, 0, 0.45)']) assert.equal(swatchOf(v), null, String(v));
});

test('formPatch: a new rule sends every field; an edit sends only what changed; an emptied token goes as null', () => {
  assert.deepEqual(formPatch(null, { text: '  Dark   only ', kind: 'color', why: '', tokenName: '', tokenValue: '' }), { text: 'Dark only', kind: 'color', why: '', token: null });
  assert.deepEqual(formPatch(null, { text: 'Amber', kind: '', why: ' the look ', tokenName: ' --accent ', tokenValue: ' #d6a455 ' }), { text: 'Amber', kind: '', why: 'the look', token: { name: '--accent', value: '#d6a455' } }, 'no kind chosen is sent as none: the server says to choose');
  const same = { text: RULES[1].text, kind: 'color', why: '', tokenName: '--accent', tokenValue: '#d6a455' };
  assert.deepEqual(formPatch(RULES[1], same), {}, 'nothing changed, nothing sent');
  assert.deepEqual(formPatch(RULES[1], { ...same, why: 'docs/DESIGN.md section 8' }), { why: 'docs/DESIGN.md section 8' });
  assert.deepEqual(formPatch(RULES[1], { ...same, tokenValue: '#d6a456' }), { token: { name: '--accent', value: '#d6a456' } });
  assert.deepEqual(formPatch(RULES[1], { ...same, tokenName: '', tokenValue: '' }), { token: null }, 'both fields emptied takes the lock off');
  assert.deepEqual(formPatch(RULES[1], { ...same, tokenValue: '' }), { token: { name: '--accent', value: '' } }, 'half a token is sent as typed, for the server\'s sentence');
  assert.deepEqual(formPatch(RULES[0], { text: 'Motion 160 ms or less', kind: 'layout', why: 'docs/DESIGN.md section 1', tokenName: '--t', tokenValue: '140ms' }), { kind: 'layout', token: { name: '--t', value: '140ms' } });
});

test('the rules are a part of the Inspiration view with their own address; the route, the event and the calls are wired', async () => {
  const app = await read('client/app.js');
  const view = await read('client/views/inspiration.js');
  const api = await read('client/api.js');
  for (const call of ['rules: (id) => get(', 'addRule: (id, rule) => post(', 'patchRule: (id, ruleId, b) => patch(', 'removeRule: (id, ruleId) => del(']) assert.ok(api.includes(call), call);
  assert.match(app, /es\.addEventListener\('rules\.changed', \(e\) => emit\('rules', data\(e\)\)\)/);
  // The address names the part, and the app's router still reads the view from it (so the tab stays current).
  assert.match(view, /const RULES_HASH = '#\/inspiration\/rules';/);
  assert.equal(('#/inspiration/rules'.match(/^#\/([\w-]+)/) || [])[1], 'inspiration');
  assert.match(app, /const name = \(location\.hash\.match\(\/\^#\\\/\(\[\\w-\]\+\)\/\) \|\| \[\]\)\[1\];/, 'the router takes the first word of the address');
  assert.match(view, /window\.addEventListener\('hashchange', applyMode\)/);
  assert.match(view, /window\.removeEventListener\('hashchange', applyMode\)/, 'and lets go of it when the view goes');
  assert.match(view, /segBtn\('board', 'Board'\), segBtn\('rules', 'Fixed rules', rulesN\)/);
  assert.match(view, /ui\.rules\.unmount\(\);/);
  // While the rules are shown the board's hands are still: a paste or a drop there must not add a card.
  assert.match(view, /if \(!ui \|\| !ui\.pid \|\| ui\.mode !== 'board' \|\| document\.querySelector\('dialog\[open\]'\)\) return;/);
  assert.match(view, /return !!ui\?\.pid && ui\.mode === 'board' && !types\.includes\(CARD_DRAG\)/);
  assert.match(view, /if \(mode !== ui\.mode\) \{ stopPicking\(\); setDropping\(false\); \}/);
});

test('the part keeps the design rules: one primary button in sight, no chip, tokens only, motion within the token', async () => {
  const view = await read('client/views/inspiration.js');
  const panel = await read('client/components/rules-panel.js');
  const edit = await read('client/components/rules-edit.js');
  const css = await read('client/inspiration.css');
  // Add (the board) and Add rule (the rules) are never on screen together: each part hides the other's.
  assert.equal(panel.match(/variant: 'primary'/g).length, 1);
  assert.match(view, /for \(const node of \[ui\.form, ui\.bar, ui\.scroll\]\) node\.hidden = mode !== 'board';/);
  assert.match(view, /ui\.rules\.addButton\.hidden = mode !== 'rules';/);
  assert.doesNotMatch(panel + edit, /stateChip|\.chip|chip\(/, 'a kind and a lock are words, never chips');
  for (const file of [view, panel, edit]) assert.ok(file.split('\n').length <= 500, 'files stay under about 500 lines');
  assert.match(panel, /confirmDialog\(\{ title: 'Remove rule', message: removeWords\(rule, projectName\(\)\), confirm: 'Remove', variant: 'danger', cancel: 'Keep it' \}\)/, 'removal asks once');
  assert.equal(panel.match(/confirmDialog\(/g).length, 1);
  assert.match(panel, /const same = !st\.error && st\.rules !== null && snapshot === st\.snapshot;/, 'the echo of this window\'s own change redraws nothing');
  assert.match(edit, /say\(message\);\n\s+btn\.disabled = false; words\.textContent = was;\n\s+fieldOf\(message\)\.focus\(\);/, 'a refusal stays in the dialog, with the focus on its field');
  // The rules' styles: the studio's tokens only, one transition on the token, hover behind a hover query.
  const own = css.slice(css.indexOf('/* ---------- fixed rules'), css.indexOf('@media (max-width: 1100px)'));
  assert.ok(own.length > 800);
  assert.equal(own.match(/#[0-9a-f]{3,8}\b/gi), null, 'colours come from the tokens');
  assert.deepEqual([...own.matchAll(/transition: ([^;]+);/g)].map((m) => m[1]), ['opacity var(--t) ease-out']);
  assert.doesNotMatch(own, /@keyframes|animation:/);
  assert.doesNotMatch(own.replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, ''), /:hover/, 'hover styles only where a pointer can hover');
  assert.match(own, /@media \(hover: none\) \{ \.rule-actions \{ opacity: 1; \} \}/, 'a touch screen shows the actions');
  assert.match(own, /\.rule:focus-visible \{ outline: 2px solid var\(--focus\)/, 'a rule that holds the focus shows it');
  assert.match(own, /\.rule \{[^}]*break-inside: avoid;/, 'a rule is never cut between two columns');
  // Code is marked as code, so a page translator leaves a declaration alone.
  assert.match(panel, /code\.setAttribute\('translate', 'no'\)/);
  assert.match(edit, /code\.setAttribute\('translate', 'no'\)/);
});
