// The Visualizer's pure parts and its wiring into the Inspiration view (t_6kbrrw0jz1; docs/DESIGN.md section 14).
// Risks covered: a lock's state is said in words that are true for that state, and a state with no definitions does
// not throw; a drift mark says why; the head counts what drifts; a sample is never drawn at a size it does not have
// without saying so; an easing's curve is the curve of its numbers; the task's request names every value with its
// place and is absent when nothing drifts; the part is reached by its own address, reads the files only when it is on
// screen, hides the other parts' buttons and shows no primary button of its own; nothing read from a project is set
// as HTML; the styles keep DESIGN.md's rules (tokens only, no motion, no chip, hover left to the buttons).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { USE_WORDS, USE_HINTS, groupColors, placeRef, placeFull, placeWhat, itemName, usesWords, driftMarks, driftList, lockWords, lockState, lockMark, boardWords, headWords, sampleSize, barWidth, msWords, easingPath, taskRequest, countWords, SAMPLE_MAX, TASK_LIST_MAX, LEGEND } from '../client/components/visualizer-words.js';
import { COLOR_USES } from '../server/lib/design-read.mjs';

const read = (rel) => fsp.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const place = (line, file = 'src/style.css') => ({ file, line, scope: '.a', prop: 'color' });
const token = (name, hex, over = {}) => ({ kind: 'token', name, use: 'surface', count: 3, places: [place(40)], home: { file: 'src/style.css', line: 8 }, defs: [{ value: hex, canon: hex, hex, scope: ':root', file: 'src/style.css', line: 8, base: true, distance: 0, far: false }], drift: [], ...over });
const literal = (value, over = {}) => ({ kind: 'literal', value, canon: value, hex: value, use: 'text', count: 1, places: [place(77)], home: { file: 'src/style.css', line: 77 }, distance: 30, twin: null, drift: [], ...over });
const scale = (value, over = {}) => ({ value, px: parseFloat(value), count: 1, tokens: [], places: [place(90)], home: { file: 'src/style.css', line: 90 }, drift: [], ...over });
const ANSWER = {
  entry: 'src/index.html',
  sheets: [{ file: 'src/style.css', from: 'link', lines: 100, declarations: 80 }],
  skipped: [],
  colors: [token('--bg', '#ffffff'), token('--unused', '#008000', { use: 'unused', count: 0, places: [], drift: ['far'], defs: [{ value: '#008000', canon: '#008000', hex: '#008000', scope: ':root', file: 'src/style.css', line: 12, base: true, distance: 41.5, far: true }], home: { file: 'src/style.css', line: 12 } }), literal('#ff0000', { drift: ['once', 'far'] }), literal('#eeeeee', { use: 'line', count: 4 })],
  type: { families: [], sizes: [scale('32px', { drift: ['once'] }), scale('16px', { count: 9 })], base: 'Inter, sans-serif', rootPx: 16 },
  spacing: [scale('7px', { drift: ['once'] }), scale('8px', { count: 20, tokens: ['--s2'], home: { file: 'src/style.css', line: 5 } })],
  radii: [], motion: { durations: [], easings: [] },
  rules: [
    { id: 'rule_a', kind: 'layout', text: 'Ten', token: { name: '--s2', value: '10px' }, check: { state: 'breaks', defs: [{ value: '8px', scope: ':root', file: 'src/style.css', line: 5, base: true, same: false }] } },
    { id: 'rule_b', kind: 'tone', text: 'Plain words', token: null, check: null },
  ],
  locks: { '--s2': { ruleId: 'rule_a', text: 'Ten', value: '10px', state: 'breaks' } },
  board: [], summary: { declarations: 80, locks: { matches: 0, varies: 0, breaks: 1, missing: 0 } }, limits: { far: 8 },
};

test('words: the groups in the server\'s order, a place as file:line, how often, and the head\'s count', () => {
  assert.deepEqual(Object.keys(USE_WORDS), COLOR_USES, 'the client names every use the server answers, in its order');
  assert.deepEqual(Object.keys(USE_HINTS), COLOR_USES);
  assert.deepEqual(groupColors(ANSWER.colors).map((g) => [g.use, g.items.map(itemName)]), [['surface', ['--bg']], ['text', ['#ff0000']], ['line', ['#eeeeee']], ['unused', ['--unused']]], 'a use with no colour is left out');
  assert.deepEqual(groupColors([]), []);
  assert.equal(placeRef({ file: 'client/styles.css', line: 16 }), 'styles.css:16');
  assert.equal(placeRef({ file: 'client/index.html' }), 'index.html', 'a file with no line');
  assert.equal(placeRef(null), '');
  assert.equal(placeFull({ file: 'client/styles.css', line: 16 }), 'client/styles.css:16');
  assert.equal(placeWhat({ scope: '@media (max-width: 1100px) .btn', prop: 'background' }), '@media (max-width: 1100px) .btn { background }');
  assert.equal(usesWords(ANSWER.colors[0]), '3 uses');
  assert.equal(usesWords(token('--x', '#000000', { count: 1 })), '1 use');
  assert.equal(usesWords(ANSWER.colors[1]), 'not used');
  assert.equal(usesWords(ANSWER.colors[3]), '4 places');
  assert.equal(countWords(1, 'stylesheet'), '1 stylesheet');
  assert.equal(headWords('Harbor', ANSWER), 'Harbor · 1 stylesheet · 4 colours · 4 drifting · 1 lock broken');
  assert.equal(headWords('Harbor', { ...ANSWER, colors: [ANSWER.colors[0]], type: { families: [], sizes: [] }, spacing: [], rules: [], summary: { locks: { breaks: 0 } } }), 'Harbor · 1 stylesheet · 1 colour · nothing drifting');
  assert.equal(headWords('Harbor', { entry: null }), 'Harbor · no web entry');
  assert.equal(headWords('Harbor', null), 'Harbor');
  assert.match(LEGEND, /^once: .* · far: /);
});

test('drift: each mark says why in its title; the list names what kind of value each is', () => {
  assert.deepEqual(driftMarks(ANSWER.colors[2], { far: 8 }).map((m) => [m.key, m.word]), [['once', 'once'], ['far', 'far']]);
  assert.match(driftMarks(ANSWER.colors[2], { far: 8 })[0].title, /^Written out in one place only/);
  assert.match(driftMarks(ANSWER.colors[2], { far: 8 })[1].title, /\(30 away; over 8 counts as far\)$/);
  assert.match(driftMarks(ANSWER.colors[1], { far: 8 })[0].title, /\(41\.5 away; over 8 counts as far\)$/, 'a custom property\'s distance is its base value\'s');
  assert.deepEqual(driftMarks(ANSWER.colors[0]), []);
  assert.deepEqual(driftList(ANSWER).map((d) => [d.what, itemName(d.item), d.keys]), [['colour', '--unused', ['far']], ['colour', '#ff0000', ['once', 'far']], ['font size', '32px', ['once']], ['spacing', '7px', ['once']]]);
  assert.deepEqual(driftList(null), []);
});

test('locks and the board: words that are true for each state; a state with nothing found does not throw', () => {
  const tokenOf = { name: '--bg', value: '#232221' };
  const def = (value, same, base, scope = ':root', line = 6) => ({ value, same, base, scope, file: 'client/styles.css', line });
  assert.deepEqual(lockWords({ state: 'matches', defs: [def('#232221', true, true)] }, tokenOf), { tone: 'ok', word: 'Kept', detail: '' });
  assert.deepEqual(lockWords({ state: 'varies', defs: [def('#232221', true, true), def('#f3f1ec', false, false, '[data-theme="light"]', 36)] }, tokenOf), { tone: 'warn', word: 'Kept, with another value elsewhere', detail: '[data-theme="light"] sets #f3f1ec' });
  assert.deepEqual(lockWords({ state: 'breaks', defs: [def('#000000', false, true)] }, tokenOf), { tone: 'danger', word: 'Broken', detail: 'styles.css:6 sets #000000, not #232221' });
  assert.deepEqual(lockWords({ state: 'missing', defs: [] }, tokenOf), { tone: 'neutral', word: 'Not set in these stylesheets', detail: 'No stylesheet read here sets --bg' });
  assert.deepEqual(lockWords({ state: 'breaks' }, tokenOf), { tone: 'danger', word: 'Broken', detail: '' }, 'the state alone, as a value\'s mark has it');
  assert.equal(lockWords(null, null).word, 'Not checked');
  assert.deepEqual([lockState('varies').tone, lockState('nothing').tone], ['warn', 'neutral']);
  assert.deepEqual(['matches', 'varies', 'breaks', 'missing'].map((state) => lockMark({ state })), ['kept', 'kept', 'broken', 'locked']);
  assert.deepEqual(boardWords({ state: 'exact', nearest: { label: '--accent', scope: '', distance: 0 } }), { tone: 'ok', words: 'In the stylesheets as --accent' });
  assert.deepEqual(boardWords({ state: 'exact', nearest: { label: '--bg', scope: '[data-theme="light"]', distance: 0.4 } }), { tone: 'ok', words: 'In the stylesheets as --bg under [data-theme="light"]' });
  assert.deepEqual(boardWords({ state: 'close', nearest: { label: '--panel', scope: '', distance: 3.2 } }), { tone: 'neutral', words: 'Closest is --panel, 3.2 away' });
  assert.deepEqual(boardWords({ state: 'absent', nearest: { label: '#ffffff', scope: '', distance: 31 } }), { tone: 'warn', words: 'Not in the stylesheets; the closest is #ffffff, 31 away' });
  assert.deepEqual(boardWords({ state: 'absent', nearest: null }), { tone: 'warn', words: 'Not in the stylesheets' });
});

test('drawing: a sample at its real size or saying otherwise; a bar at its real width; an easing as the curve of its numbers', () => {
  assert.deepEqual(sampleSize({ value: '18px', px: 18 }), { px: 18, note: '' });
  assert.deepEqual(sampleSize({ value: '72px', px: 72 }), { px: SAMPLE_MAX, note: `drawn at ${SAMPLE_MAX} px` });
  assert.deepEqual(sampleSize({ value: '1.5em', px: null }, 16), { px: 24, note: 'drawn against 16 px' });
  assert.deepEqual(sampleSize({ value: '90%', px: null }, 20), { px: 18, note: 'drawn against 20 px' });
  assert.equal(sampleSize({ value: 'clamp(11px, 2vw, 18px)', px: null }), null, 'a sum is not drawn');
  assert.deepEqual(barWidth({ px: 12 }), { px: 12, cut: false });
  assert.deepEqual(barWidth({ px: 0.5 }), { px: 1, cut: false }, 'never thinner than a pixel');
  assert.deepEqual(barWidth({ px: 400 }), { px: 160, cut: true });
  assert.equal(barWidth({ px: null, value: '0.5em' }), null);
  assert.equal(msWords(140), '140 ms');
  assert.equal(msWords(1800), '1.8 s');
  assert.equal(easingPath({ curve: [0, 0, 0.58, 1] }, 48), 'M0 48 C0 48 27.84 0 48 0');
  assert.equal(easingPath({ curve: [0.25, 0.1, 0.25, 1] }, 100), 'M0 100 C25 90 25 0 100 0');
  assert.equal(easingPath({ curve: null, steps: 2 }, 48), 'M0 48 H24 V24 H48 V0');
  assert.equal(easingPath({ curve: null, steps: null }, 48), null);
});

test('taskRequest: every drifting value and every broken lock with its place; capped; nothing when nothing drifts', () => {
  const t = taskRequest('Harbor', ANSWER);
  assert.equal(t.title, 'Tidy the design drift the Visualizer found (5 values)');
  assert.deepEqual([t.files, t.count], [['src/style.css'], 5]);
  assert.deepEqual(t.request.split('\n\n'), [
    "Tidy the drift in Harbor's design system, as the Visualizer read it from src/index.html (src/style.css). Change only what is listed here, keep every fixed rule, and leave a value as it is when it is right: say which and why in the result.",
    "Locked tokens the files break (the rule is the person's; set the file back to the locked value, or ask before changing the rule):\n- --s2 is locked at 10px; src/style.css:5 sets 8px",
    'Colours far from every colour on the inspiration board (move each to a board colour or an existing custom property, or say why it stays):\n- --unused (#008000), set at src/style.css:12\n- #ff0000, at src/style.css:77',
    'Values written out in one place only (use the nearest value of the scale or a custom property, or say why it stays):\n- colour #ff0000 at src/style.css:77\n- font size 32px at src/style.css:90\n- spacing 7px at src/style.css:90',
  ]);
  const calm = { ...ANSWER, colors: [ANSWER.colors[0]], type: { families: [], sizes: [] }, spacing: [], rules: [ANSWER.rules[1]] };
  assert.equal(taskRequest('Harbor', calm), null);
  assert.equal(taskRequest('Harbor', null), null);
  const many = { ...calm, spacing: Array.from({ length: TASK_LIST_MAX + 7 }, (_, i) => scale(`${i + 1}.5px`, { drift: ['once'] })) };
  const lines = taskRequest('', many).request.split('\n');
  assert.equal(lines.at(-1), '- and 7 more (the Visualizer lists them all)');
  assert.equal(lines.filter((l) => l.startsWith('- spacing')).length, TASK_LIST_MAX);
  assert.match(lines[0], /^Tidy the drift in this project's design system/);
});

test('the Visualizer is a part of the Inspiration view with its own address; it reads when it is on screen; the route and the call are wired', async () => {
  const view = await read('client/views/inspiration.js');
  const panel = await read('client/components/visualizer-panel.js');
  const api = await read('client/api.js');
  const server = await read('server/index.mjs');
  const html = await read('client/index.html');
  assert.ok(api.includes('visualizer: (id) => get(`${P(id)}/visualizer`)'));
  assert.match(server, /route\('GET', '\/api\/projects\/:id\/visualizer', async \(\{ params \}\) => visualizerAnswer\(await projects\.loadProject\(params\.id\)\)\);/);
  assert.equal(server.match(/\/api\/projects\/:id\/visualizer/g).length, 1, 'one route, a GET: nothing can be written through it');
  assert.match(html, /<link rel="stylesheet" href="\/visualizer\.css">/);
  assert.match(view, /const VIZ_HASH = '#\/inspiration\/visualizer';/);
  assert.equal(('#/inspiration/visualizer'.match(/^#\/([\w-]+)/) || [])[1], 'inspiration', 'the router still reads the view from the address');
  assert.match(view, /segBtn\('references', 'References', refsN\), segBtn\('visualizer', 'Visualizer'\)\);/, 'four parts, the most a segmented control takes');
  assert.match(view, /names\(RULES_HASH\) \? 'rules' : names\(REFS_HASH\) \? 'references' : names\(VIZ_HASH\) \? 'visualizer' : names\(LOOK_HASH\) \? 'look' : 'board'/);
  assert.match(view, /ui\.vizHost\.hidden = mode !== 'visualizer';/);
  assert.match(view, /ui\.viz\.taskButton\.hidden = ui\.viz\.readButton\.hidden = mode !== 'visualizer';/);
  assert.match(view, /ui\.viz\.show\(mode === 'visualizer'\);/);
  assert.match(view, /ui\.viz\.unmount\(\);/);
  // It reads the files when it comes on screen and on the window's focus, never while another part is shown.
  assert.match(panel, /show\(on\) \{ const was = st\.shown; st\.shown = !!on; if \(on && !was && st\.pid\) load\(\); \}/);
  assert.match(panel, /if \(pid && st\.shown\) load\(\);/);
  assert.match(panel, /const onFocus = \(\) => \{ if \(st\.shown && !st\.busy && !document\.querySelector\('dialog\[open\]'\)\) load\(\); \};/);
  assert.match(panel, /app\.on\('rules', \(d\) => \{ if \(!d\?\.projectId \|\| d\.projectId === st\.pid\) later\(\); \}\)/);
  assert.match(panel, /app\.on\('inspiration', \(d\) => \{ if \(!d\?\.projectId \|\| d\.projectId === st\.pid\) later\(\); \}\)/);
  assert.match(panel, /const same = !st\.error && st\.answer !== null && snapshot === st\.snapshot;/, 'the same answer redraws nothing');
  // Every value leads to the Source tab through the one way in; the only thing made is a task, after the dialog.
  assert.match(panel, /const open = \(place\) => app\.openSource\(\{ path: place\.file, line: place\.line \|\| null \}\);/);
  assert.equal(panel.match(/app\.api\.\w+/g).filter((c) => !['app.api.visualizer', 'app.api.createTask'].includes(c)).length, 0, 'it reads its answer and can make a task; no other call');
  assert.match(panel, /actions: \[\{ label: 'Cancel', value: false \}, \{ label: 'Create task', variant: 'primary', run: create \}\]/);
  assert.match(panel, /app\.showPanel\('task', \{ taskId: task\.id \}\)/);
});

test('the part keeps the design rules: no primary button in the head, no chip, nothing set as HTML, tokens only, no motion', async () => {
  const view = await read('client/views/inspiration.js');
  const panel = await read('client/components/visualizer-panel.js');
  const draw = await read('client/components/visualizer-draw.js');
  const words = await read('client/components/visualizer-words.js');
  const css = await read('client/visualizer.css');
  for (const [name, file] of [['inspiration.js', view], ['visualizer-panel.js', panel], ['visualizer-draw.js', draw], ['visualizer-words.js', words]]) assert.ok(file.split('\n').length <= 500, `${name} stays under about 500 lines`);
  assert.equal(panel.match(/variant: 'primary'/g).length, 2, 'the two dialogs\' own confirm buttons');
  assert.match(panel, /const taskButton = button\('Make it a task', \{ title:/, 'the head\'s button is a plain one: this part reads, it has no primary action');
  assert.doesNotMatch(panel + draw, /stateChip|\.chip\b|chip\(/, 'a state is a word with a dot, never a chip');
  assert.doesNotMatch(panel + draw, /innerHTML|insertAdjacentHTML|outerHTML/, 'a value read from a project is text or one style property');
  assert.match(draw, /const mark = \(tone, word, title\) => el\(`span\.viz-mark\.tone-\$\{tone\}`, \{ title \}, el\('span\.viz-dot', \{ 'aria-hidden': 'true' \}\), word\);/, 'the dot never stands without its word');
  assert.match(draw, /code\.setAttribute|n\.setAttribute\('translate', 'no'\)/, 'values are marked as code for a page translator');
  // A project's colour reaches the page only as a background colour, which takes no address.
  assert.deepEqual([...new Set([...(draw + panel).matchAll(/style: \{ (\w+):/g)].map((m) => m[1]))].sort(), ['backgroundColor', 'borderRadius', 'fontFamily', 'fontSize', 'width']);
  // The styles: the studio's tokens only, no transition and no animation, hover left to the shared button.
  assert.ok(css.length > 3000);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, ''); // the rules, their comments aside
  assert.equal(rules.match(/#[0-9a-f]{3,8}\b/gi), null, 'colours come from the tokens; a swatch\'s colour is data');
  assert.doesNotMatch(rules, /rgba?\(|hsla?\(/);
  assert.doesNotMatch(rules, /transition|animation|@keyframes/, 'nothing in this part moves');
  assert.doesNotMatch(rules, /:hover/);
  assert.equal(css.match(/font-size: (13|12\.5|12|11)px/g), null, 'the small sizes are tokens, so the text size steps reach them');
  assert.match(css, /\.viz-cols \{[^}]*grid-template-columns: minmax\(0, 1fr\) 340px;/);
  assert.match(css, /\.viz-main \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.viz-side \{[^}]*overflow-y: auto;[^}]*border-left: 1px solid var\(--line\);/);
  assert.match(css, /@media \(max-width: 1100px\) \{\s*\.viz-cols \{ display: block; overflow-y: auto; \}/, 'one column below 1100 px');
  assert.match(css, /\.viz-mark\.tone-drift \.viz-dot \{ background: transparent; box-shadow: inset 0 0 0 1\.5px var\(--muted\); \}/, 'drift is told gently: a hollow dot in the muted ink');
  assert.match(css, /\.viz-mark\.tone-danger \.viz-dot \{ background: var\(--danger\); \}/);
});
