// The Visualizer's reader (t_6kbrrw0jz1; docs/ARCHITECTURE.md section 26). Risks covered: a declaration is answered
// with the line it really starts on, whatever comments, strings, data URLs and nested at-rules stand around it; the
// same colour written two ways counts as one, and a hex inside a string or a url() is no colour; a custom property is
// counted where it is read, a written-out value where it stands, and a value through a custom property is never a
// one-off; a sum of lengths is worked out or left as written, never guessed; a lock is kept, varies, is broken or is
// set nowhere; a colour is far only when the board has nothing near it nor between two of its colours; the entry's
// stylesheets are followed through link, <style> and @import and never out of the project, into .git or .studio, or
// onto another site; reading writes nothing, not even beside a damaged record; the studio's own stylesheets keep the
// studio's seed locks; and through a real server process the route answers for a product with its rules and board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanCss, splitTop, varsIn, resolveVars, evalLength, parseColor, canonColor, colorsIn, wholeColor, colorDistance, distanceToPalette } from '../server/lib/css-scan.mjs';
import { readDesign, sameValue, colorUse, FAR, PLACES_MAX } from '../server/lib/design-read.mjs';
import { findSheets, sheetsInHtml, hrefCandidates, visualizerAnswer, MAX_SHEETS } from '../server/lib/visualizer.mjs';
import { STUDIO_RULES } from '../server/lib/rules-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lineOf = (text, needle) => text.slice(0, text.indexOf(needle)).split('\n').length;
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
/** Every file under a folder with its hash (.git aside): what a read must leave exactly as it was. */
function snapshot(dir, skip = ['.git']) {
  const out = {};
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (skip.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(cur, e.name), r);
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(cur, e.name))).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

const CSS = `/* a comment with { braces } and ; semicolons
   over two lines */
@import url("more.css");
:root {
  --bg: #FFF;
  --ink: rgb(17 17 17);
  --accent: #2f5bd3;
  --soft: rgba(47, 91, 211, 0.12);
  --alias: var(--accent);
  --unused: hsl(120, 100%, 25%);
  --s2: 8px; --s3: 12px;
  --r: 0.5rem;
  --t: 140ms;
  --font: "Inter", system-ui, sans-serif;
  --shadow: 0 2px 8px rgba(0,0,0,.2);
  font: 16px/1.5 var(--font);
}
@media (prefers-color-scheme: dark) { :root { --bg: #111111; } }
body { background: var(--bg); color: var(--ink); margin: 0; }
.btn { background: var(--accent); color: white; padding: var(--s2) var(--s3); border: 1px solid #2F5BD3;
  border-radius: var(--r);
  transition: background var(--t) ease-out, color 0.2s 50ms; }
.btn:hover { background: var(--soft); box-shadow: var(--shadow); margin: calc(var(--s2) * -1) 7px; }
h1 { font-size: 2rem; font-family: Georgia, serif; }
.x { content: "#abcdef;}"; background: url(data:image/png;base64,AAAA#fff) #ff0000; font-size: 0.9em; border-radius: 50% }
@keyframes spin { to { transform: rotate(1turn); } }
.spin { animation: spin 1s linear infinite; }
`;

// ---------- the scanner ----------
test('scanCss: every declaration with the line it starts on, its selector and its at-rules; comments, strings and data URLs are no structure', () => {
  const { decls, imports, lines } = scanCss(CSS);
  assert.equal(lines, CSS.split('\n').length - 1, 'the lines of the file, the last line end aside');
  assert.deepEqual(imports, [{ href: 'more.css', line: 3 }]);
  const find = (prop, selector) => decls.find((d) => d.prop === prop && (!selector || d.selector === selector));
  for (const [prop, needle, selector] of [['--bg', '--bg: #FFF', ':root'], ['--s3', '--s2: 8px', ':root'], ['font', 'font: 16px', ':root'], ['border-radius', 'border-radius: var(--r)', '.btn'], ['transition', 'transition:', '.btn'], ['font-family', 'font-family: Georgia', 'h1'], ['animation', 'animation: spin', '.spin']]) {
    assert.equal(find(prop, selector).line, lineOf(CSS, needle), `${prop} is on its own line`);
  }
  const dark = decls.find((d) => d.prop === '--bg' && d.at.length);
  assert.deepEqual([dark.value, dark.selector, dark.at, dark.line], ['#111111', ':root', ['@media (prefers-color-scheme: dark)'], lineOf(CSS, '@media')]);
  assert.equal(find('content').value, '"#abcdef;}"', 'a string keeps its ; and }');
  assert.equal(find('background', '.x').value, 'url(data:image/png;base64,AAAA#fff) #ff0000', 'a ; inside parentheses belongs to the value');
  assert.equal(find('border-radius', '.x').value, '50%', 'the last declaration needs no ;');
  const frame = find('transform');
  assert.deepEqual([frame.selector, frame.at], ['to', ['@keyframes spin']]);
  assert.equal(decls.some((d) => /comment|braces|semicolons/.test(d.prop + d.value)), false, 'nothing of the comment is read');
  // A <style> element's lines count from where it stands in its page; !important is noted, not kept in the value.
  const inline = scanCss('\n.a { color: red !important; }\n', { lineOffset: 10 });
  assert.deepEqual([inline.decls[0].line, inline.decls[0].value, inline.decls[0].important], [12, 'red', true]);
  // Nested rules and an unclosed block do not throw.
  const nested = scanCss('.card { color: #111; &:hover { color: #222 } .title { margin: 4px } }\n.open { padding: 2px');
  assert.deepEqual(nested.decls.map((d) => [d.selector, d.prop, d.value]), [['.card', 'color', '#111'], ['&:hover', 'color', '#222'], ['.title', 'margin', '4px'], ['.open', 'padding', '2px']]);
  assert.deepEqual(scanCss('').decls, []);
  assert.deepEqual(scanCss('@import "a.css" screen; @import url(b.css);\n@charset "utf-8";').imports.map((i) => i.href), ['a.css', 'b.css']);
});

test('values: cut at the top level only; custom properties read, with their fallback, without looping; sums of lengths worked out or refused', () => {
  assert.deepEqual(splitTop('1px solid rgba(0, 0, 0, 0.5)', ' '), ['1px', 'solid', 'rgba(0, 0, 0, 0.5)']);
  assert.deepEqual(splitTop('"Inter, Display", system-ui, var(--x, a, b)', ','), ['"Inter, Display"', 'system-ui', 'var(--x, a, b)']);
  assert.deepEqual(splitTop('16px/1.5', '/'), ['16px', '1.5']);
  assert.deepEqual(varsIn('var(--a) calc(var(--b) + var( --a ))'), ['--a', '--b', '--a']);
  const map = { '--a': '4px', '--b': 'var(--a)', '--loop': 'var(--loop)' };
  const lookup = (n) => map[n] ?? null;
  assert.equal(resolveVars('var(--b) var(--none, 2px) var(--none)', lookup), '4px 2px var(--none)');
  assert.equal(typeof resolveVars('var(--loop)', lookup), 'string', 'a property that reads itself ends');
  assert.equal(evalLength('calc(8px * -1)'), -8);
  assert.equal(evalLength('calc(14px + 2px)'), 16);
  assert.equal(evalLength('max(1px, calc(6px - 3px))'), 3);
  assert.equal(evalLength('min(4px, 6px)'), 4);
  assert.equal(evalLength('calc(1.5rem / 2)', 16), 12);
  assert.equal(evalLength('calc((4px + 2px) * 2)'), 12);
  for (const no of ['calc(100% - 8px)', 'calc(var(--w) + 4px)', 'clamp(11px, 2vw, 18px)', 'calc(4px * 2px)', 'calc(4px / 0)', 'calc(2 * 3)', 'max(16px, env(safe-area-inset-left))', 'calc(1em + 2px)', '12px']) {
    assert.equal(evalLength(no) === null || no === '12px', true, `${no} is not guessed`);
  }
});

// ---------- colours ----------
test('colours: one spelling per colour; hex, rgb() and hsl() in both spellings, names; what is no colour is null', () => {
  const canon = (v) => { const c = parseColor(v); return c && canonColor(c); };
  for (const same of ['#fff', '#FFFFFF', '#ffff', '#ffffffff', 'white', 'rgb(255, 255, 255)', 'rgb(255 255 255)', 'rgb(100% 100% 100%)', 'hsl(0, 0%, 100%)', 'rgba(255,255,255,1)']) assert.equal(canon(same), '#ffffff', same);
  assert.equal(canon('#2F5BD3'), '#2f5bd3');
  assert.equal(canon('rgba(0,0,0,.2)'), 'rgba(0, 0, 0, 0.2)');
  assert.equal(canon('rgb(0 0 0 / 20%)'), 'rgba(0, 0, 0, 0.2)');
  assert.equal(canon('#00000033'), 'rgba(0, 0, 0, 0.2)');
  assert.equal(canon('hsl(120, 100%, 25%)'), '#008000');
  assert.equal(canon('hsl(210deg 50% 40% / 0.5)'), 'rgba(51, 102, 153, 0.5)');
  assert.equal(canon('rebeccapurple'), '#663399');
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  for (const no of ['#12', '#12345', 'rgb(var(--x))', 'rgba(var(--rgb), 0.5)', 'oklch(70% 0.1 200)', 'currentColor', 'inherit', '12px', 'reddish', '']) assert.equal(parseColor(no), null, no);
  // In a value: a hex in a string or an address is not one; a var() function is not a written colour, what is inside is.
  assert.deepEqual(colorsIn('url(data:image/png;base64,AAAA#fff) #ff0000').map((c) => c.canon), ['#ff0000']);
  assert.deepEqual(colorsIn('"#abcdef"').map((c) => c.canon), []);
  assert.deepEqual(colorsIn('0 1px 2px rgba(0,0,0,.18), inset 0 0 0 1px #FFF').map((c) => c.canon), ['rgba(0, 0, 0, 0.18)', '#ffffff']);
  assert.deepEqual(colorsIn('color-mix(in srgb, var(--a) 50%, #fff)').map((c) => c.canon), ['#ffffff']);
  assert.deepEqual(colorsIn('oklch(70% 0.1 200)').map((c) => [c.canon, c.color]), [['oklch(70% 0.1 200)', null]], 'a colour this reader cannot convert is still a colour, kept as written');
  assert.deepEqual(colorsIn('1px solid red', { named: true }).map((c) => c.canon), ['#ff0000']);
  assert.deepEqual(colorsIn('1px solid red').map((c) => c.canon), [], 'a name is a colour only where the property takes one');
  assert.deepEqual(colorsIn('var(--red) var(--tan-2)', { named: true }), [], 'the tail of a custom property\'s name is not a colour');
  assert.equal(wholeColor(' #FFF ').canon, '#ffffff');
  assert.equal(wholeColor('0 2px 8px #000'), null);
  assert.equal(wholeColor('"Inter", serif'), null);
  // Distance: a pair the eye cannot tell apart is near 0; a blend of two references is near them; another hue is far.
  const c = (v) => parseColor(v);
  assert.ok(colorDistance(c('#2f5bd3'), c('#2e5ad2')) < 1);
  assert.ok(colorDistance(c('#ffffff'), c('#000000')) > 99 && colorDistance(c('#ffffff'), c('#000000')) < 101);
  const board = [c('#232221'), c('#ece8e1'), c('#d6a455')];
  assert.ok(distanceToPalette(c('#9a948a'), board) < 2, 'a warm grey between the canvas and the ink is near the two');
  assert.ok(distanceToPalette(c('#93be7c'), board) > FAR, 'a green neither holds is far');
  assert.ok(distanceToPalette(c('#e07a72'), board) > FAR);
  assert.equal(distanceToPalette(c('#123456'), []), Infinity);
  assert.equal(colorUse('background-color'), 'surface');
  assert.equal(colorUse('color'), 'text');
  assert.equal(colorUse('border-top'), 'line');
  assert.equal(colorUse('box-shadow'), 'effect');
  assert.equal(colorUse('--x'), 'token');
});

// ---------- the design ----------
const RULES = [
  { id: 'rule_aaaa', kind: 'color', text: 'Blue is the accent', token: { name: '--accent', value: '#2F5BD3' } },
  { id: 'rule_bbbb', kind: 'color', text: 'White paper', token: { name: '--bg', value: '#ffffff' } },
  { id: 'rule_cccc', kind: 'layout', text: 'Ten', token: { name: '--s2', value: '10px' } },
  { id: 'rule_dddd', kind: 'color', text: 'Brand', token: { name: '--brand', value: '#123456' } },
  { id: 'rule_eeee', kind: 'type', text: 'Inter', token: { name: '--font', value: "'Inter',system-ui,  sans-serif" } },
  { id: 'rule_ffff', kind: 'tone', text: 'Plain words', why: 'because', token: null },
];
const BOARD = [{ id: 'ins_aaaa', hex: '#2f5bd3', name: 'blue' }, { id: 'ins_bbbb', hex: '#ffffff', name: 'paper' }, { id: 'ins_cccc', hex: '#00aa88', name: 'sea' }];
const design = () => readDesign([{ file: 'src/style.css', decls: scanCss(CSS).decls }], { rules: RULES, boardColors: BOARD });

test('readDesign, colours: custom properties with where they are set and read; written-out colours with their places; grouped by use', () => {
  const d = design();
  const token = (name) => d.colors.find((c) => c.name === name);
  const literal = (v) => d.colors.find((c) => c.kind === 'literal' && c.value === v);
  assert.deepEqual(d.colors.filter((c) => c.kind === 'token').map((c) => c.name).sort(), ['--accent', '--alias', '--bg', '--ink', '--soft', '--unused'], 'a custom property that is one colour; --shadow and --font are not');
  const bg = token('--bg');
  assert.deepEqual(bg.defs.map((x) => [x.canon, x.scope, x.base, x.line]), [['#ffffff', ':root', true, lineOf(CSS, '--bg: #FFF')], ['#111111', '@media (prefers-color-scheme: dark) :root', false, lineOf(CSS, '@media')]], 'the value where no condition holds is the base');
  assert.deepEqual([bg.count, bg.use, bg.home], [1, 'surface', { file: 'src/style.css', line: lineOf(CSS, '--bg: #FFF') }]);
  assert.deepEqual(bg.places, [{ file: 'src/style.css', line: lineOf(CSS, 'body {'), scope: 'body', prop: 'background' }]);
  assert.deepEqual([token('--ink').defs[0].canon, token('--ink').use], ['#111111', 'text']);
  assert.deepEqual([token('--accent').count, token('--accent').usesBy, token('--accent').use], [2, { token: 1, surface: 1 }, 'surface'], 'read once by a rule and once by another custom property');
  assert.deepEqual([token('--alias').defs[0].value, token('--alias').defs[0].canon, token('--alias').use], ['var(--accent)', '#2f5bd3', 'unused'], 'a property that reads another shows the colour it comes to');
  assert.deepEqual([token('--unused').defs[0].canon, token('--unused').count, token('--unused').use], ['#008000', 0, 'unused']);
  assert.equal(token('--soft').defs[0].canon, 'rgba(47, 91, 211, 0.12)');
  assert.deepEqual(d.colors.filter((c) => c.kind === 'literal').map((c) => c.value).sort(), ['#2f5bd3', '#ff0000', '#ffffff', 'rgba(0, 0, 0, 0.2)']);
  assert.deepEqual([literal('#ffffff').use, literal('#ffffff').twin, literal('#ffffff').count], ['text', '--bg', 1], '`white` is #ffffff, and the same as a custom property\'s value');
  assert.deepEqual([literal('#2f5bd3').use, literal('#2f5bd3').twin], ['line', '--accent'], 'the same colour in another case is that colour');
  assert.deepEqual([literal('rgba(0, 0, 0, 0.2)').places[0].prop, literal('rgba(0, 0, 0, 0.2)').use], ['--shadow', 'effect'], 'a colour inside a custom property that is more than a colour');
  assert.equal(literal('#ff0000').home.line, lineOf(CSS, '.x {'));
  for (const item of d.colors) assert.equal(typeof item.home.line, 'number', `${item.name || item.value} has a home`);
});

test('readDesign, drift: far from the board and its blends; written out once; a value through a custom property is never a one-off', () => {
  const d = design();
  const drift = (key) => d.colors.find((c) => (c.name || c.value) === key).drift;
  assert.deepEqual(drift('#ff0000'), ['once', 'far']);
  assert.deepEqual(drift('--unused'), ['far'], 'a custom property is never a one-off');
  assert.deepEqual(drift('--accent'), []);
  assert.deepEqual(drift('#2f5bd3'), ['once'], 'on the board, yet written out in one place');
  assert.deepEqual(drift('--soft'), [], 'a wash of a board colour is that colour let through');
  assert.equal(d.colors.find((c) => c.name === '--bg').defs[0].distance, 0);
  // With no colour on the board nothing is far.
  const bare = readDesign([{ file: 'a.css', decls: scanCss(CSS).decls }]);
  assert.equal(bare.colors.some((c) => c.drift.includes('far')), false);
  assert.equal(bare.colors.find((c) => c.value === '#ff0000').distance, null);
  assert.deepEqual(bare.board, []);
  assert.deepEqual(bare.rules, []);
  // Many places: the count is whole, the list is capped.
  const many = readDesign([{ file: 'a.css', decls: scanCss(Array.from({ length: PLACES_MAX + 5 }, (_, i) => `.a${i} { color: #123456; margin: 3px }`).join('\n')).decls }]);
  assert.deepEqual([many.colors[0].count, many.colors[0].places.length, many.colors[0].drift], [PLACES_MAX + 5, PLACES_MAX, []]);
  assert.deepEqual([many.spacing[0].count, many.spacing[0].places.length], [PLACES_MAX + 5, PLACES_MAX]);
});

test('readDesign, type, spacing, radii and motion: through custom properties and written out, rem against the root, sums worked out, the delay left out', () => {
  const d = design();
  assert.deepEqual(d.type.rootPx, 16);
  assert.deepEqual(d.type.rootFrom, { file: 'src/style.css', line: lineOf(CSS, 'font: 16px') });
  assert.equal(d.type.base, '"Inter", system-ui, sans-serif');
  assert.deepEqual(d.type.families.map((f) => [f.value, f.first, f.count, f.tokens, f.drift]), [['"Inter", system-ui, sans-serif', 'Inter', 1, ['--font'], []], ['Georgia, serif', 'Georgia', 1, [], []]], 'a family is never a one-off');
  assert.deepEqual(d.type.families[0].home, { file: 'src/style.css', line: lineOf(CSS, '--font:') }, 'at home where its custom property is set');
  assert.deepEqual(d.type.sizes.map((s) => [s.value, s.px, s.count, s.drift]), [['32px', 32, 1, ['once']], ['16px', 16, 1, ['once']], ['0.9em', null, 1, ['once']]]);
  assert.deepEqual(d.spacing.map((s) => [s.value, s.count, s.tokens, s.drift]), [['7px', 1, [], ['once']], ['8px', 2, ['--s2'], []], ['12px', 1, ['--s3'], []]], 'calc(var(--s2) * -1) is the scale\'s 8px; margin: 0 is no value');
  assert.deepEqual(d.spacing[1].home, { file: 'src/style.css', line: lineOf(CSS, '--s2: 8px') });
  assert.deepEqual(d.radii.map((r) => [r.value, r.px, r.tokens, r.drift]), [['8px', 8, ['--r'], []], ['50%', null, [], ['once']]], '0.5rem is 8px at a 16 px root');
  assert.deepEqual(d.motion.durations.map((m) => [m.value, m.ms, m.tokens, m.drift]), [['140ms', 140, ['--t'], []], ['200ms', 200, [], ['once']], ['1000ms', 1000, [], ['once']]], 'the 50ms is a delay');
  assert.deepEqual(d.motion.easings.map((e) => [e.value, e.curve]).sort(), [['ease-out', [0, 0, 0.58, 1]], ['linear', [0, 0, 1, 1]]]);
  // A sum that cannot be worked out is shown as it is written and is not called a one-off.
  const sums = readDesign([{ file: 'c.css', decls: scanCss('.a { padding: max(16px, env(safe-area-inset-left)) 5px; font-size: clamp(11px, 2vw, 18px); border-radius: calc(100% - 2px) }').decls }]);
  assert.deepEqual(sums.spacing.map((s) => [s.value, s.px, s.drift]), [['5px', 5, ['once']], ['max(16px, env(safe-area-inset-left))', null, []]]);
  assert.deepEqual([sums.type.sizes.map((s) => [s.value, s.drift]), sums.radii.map((s) => [s.value, s.drift])], [[['clamp(11px, 2vw, 18px)', []]], [['calc(100% - 2px)', []]]]);
  // A font shorthand held whole by a custom property, a root size that moves rem, a stepped and a bezier easing.
  const other = readDesign([{ file: 'b.css', decls: scanCss(':root { --body: 500 15px/1.4 "Work Sans", sans-serif; font-size: 20px } p { font: var(--body); margin: 1rem } a { transition: color .1s cubic-bezier(.2,0,0,1), opacity 1s steps(4, end); transition-duration: 300ms, 0.3s; animation-timing-function: ease }').decls }]);
  assert.equal(other.type.rootPx, 20);
  assert.deepEqual(other.type.sizes.map((s) => [s.value, s.tokens]), [['20px', []], ['15px', ['--body']]]);
  assert.deepEqual(other.type.families.map((f) => [f.value, f.tokens]), [['"Work Sans", sans-serif', ['--body']]]);
  assert.deepEqual(other.spacing.map((s) => s.value), ['20px'], '1rem at the 20 px root');
  assert.deepEqual(other.motion.durations.map((m) => [m.value, m.count]), [['100ms', 1], ['300ms', 2], ['1000ms', 1]]);
  assert.deepEqual(other.motion.easings.map((e) => [e.value, e.curve, e.steps]).sort(), [['cubic-bezier(0.2, 0, 0, 1)', [0.2, 0, 0, 1], null], ['ease', [0.25, 0.1, 0.25, 1], null], ['steps(4, end)', null, 4]]);
});

test('readDesign, locks and the board: kept, kept with another value elsewhere, broken, set nowhere; a board colour found, near or absent', () => {
  const d = design();
  const rule = (id) => d.rules.find((r) => r.id === id);
  assert.deepEqual([rule('rule_aaaa').check.state, rule('rule_aaaa').check.defs.map((x) => x.same)], ['matches', [true]], '#2F5BD3 is #2f5bd3');
  assert.deepEqual([rule('rule_bbbb').check.state, rule('rule_bbbb').check.defs.map((x) => [x.value, x.base, x.same])], ['varies', [['#FFF', true, true], ['#111111', false, false]]]);
  assert.deepEqual([rule('rule_cccc').check.state, rule('rule_cccc').check.defs[0].value, rule('rule_cccc').check.defs[0].line], ['breaks', '8px', lineOf(CSS, '--s2: 8px')]);
  assert.deepEqual(rule('rule_dddd').check, { state: 'missing', defs: [] });
  assert.equal(rule('rule_eeee').check.state, 'matches', 'the same stack in other quotes and spacing');
  assert.deepEqual([rule('rule_ffff').check, rule('rule_ffff').token, rule('rule_ffff').why], [null, null, 'because'], 'a rule in words is listed, not judged');
  assert.deepEqual(d.locks['--s2'], { ruleId: 'rule_cccc', text: 'Ten', value: '10px', state: 'breaks' });
  assert.deepEqual(d.summary.locks, { matches: 2, varies: 1, breaks: 1, missing: 1 });
  assert.equal(sameValue('140ms', ' 140MS '), true);
  assert.equal(sameValue('#fff', 'white'), true);
  assert.equal(sameValue('#fff', '#ffe'), false);
  assert.deepEqual(d.board.map((c) => [c.hex, c.state, c.nearest.label]), [['#2f5bd3', 'exact', '--accent'], ['#ffffff', 'exact', '--bg'], ['#00aa88', 'absent', d.board[2].nearest.label]]);
  assert.ok(d.board[2].nearest.distance > FAR);
  assert.deepEqual([d.summary.declarations, d.summary.tokens], [scanCss(CSS).decls.length, 12]);
});

// ---------- the entry's stylesheets ----------
test('sheetsInHtml and hrefCandidates: links and <style> in page order; a comment hides; print and icons are not stylesheets; another site is null', () => {
  const html = '<!doctype html>\n<head>\n<link rel="icon" href="x.png">\n<link href=a.css rel=stylesheet>\n<!-- <link rel="stylesheet" href="ghost.css"> -->\n<LINK REL="Stylesheet" HREF=\'b.css?v=2\'>\n<link rel="stylesheet" media="print" href="print.css">\n<link rel="alternate stylesheet" href="alt.css">\n<style>\n.inline { color: red }\n</style>\n<style></style>\n</head>';
  assert.deepEqual(sheetsInHtml(html), [{ href: 'a.css', line: 4 }, { href: 'b.css?v=2', line: 6 }, { css: '\n.inline { color: red }\n', lineOffset: 8 }]);
  assert.deepEqual(hrefCandidates('style.css', 'src/index.html', 'src'), ['src/style.css']);
  assert.deepEqual(hrefCandidates('../shared/a%20b.css?v=1#x', 'src/pages/index.html', 'src/pages'), ['src/shared/a b.css']);
  assert.deepEqual(hrefCandidates('/styles.css', 'client/index.html', 'client'), ['client/styles.css', 'styles.css'], 'a path from the site\'s root: the entry\'s folder first, then the project\'s');
  assert.deepEqual(hrefCandidates('/a.css', 'index.html', '.'), ['a.css']);
  for (const far of ['https://fonts.example/x.css', '//cdn.example/x.css', 'data:text/css,a{}']) assert.equal(hrefCandidates(far, 'index.html', '.'), null, far);
  assert.deepEqual(hrefCandidates('  ', 'index.html', '.'), []);
});

async function fixtureProject() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-viz-'));
  const put = async (rel, text) => { await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fsp.writeFile(path.join(dir, rel), text); };
  await put('src/index.html', ['<!doctype html>', '<html><head>', '<link rel="stylesheet" href="style.css">', '<!-- <link rel="stylesheet" href="ghost.css"> -->', '<link rel="stylesheet" href="/abs.css">', '<link rel="stylesheet" href="https://fonts.example/x.css">', '<link rel="stylesheet" href="../../outside.css">', '<link rel="stylesheet" href="../.studio/secret.css">', '<link rel="stylesheet" href="../.git/config">', '<link rel="stylesheet" href="missing.css">', '<link rel="stylesheet" href="style.css?again">', '<style>', '.inline { color: #123456; }', '</style>', '</head><body></body></html>'].join('\n'));
  await put('src/style.css', '@import "more/extra.css";\n@import url(loop.css);\n:root { --accent: #2f5bd3; --radius: 10px; }\n.a { color: var(--accent); border-radius: var(--radius); }\n');
  await put('src/more/extra.css', '@import "../style.css";\n@import "../../../far.css";\n.e { color: red; }\n');
  await put('src/loop.css', '@import "loop.css";\n.l { padding: 4px; }\n');
  await put('src/abs.css', '.abs { margin: 6px; }\n');
  await put('.studio/secret.css', '.secret { color: #bada55; }\n');
  await put('.git/config', '.git { color: #c0ffee; }\n');
  await put('atelier.json', JSON.stringify({ kind: 'web-app', name: 'Fixture', entry: 'src/index.html' }));
  return dir;
}

test('findSheets: link, <style> and @import followed inside the project, each file once; what is left out is named with why', async () => {
  const dir = await fixtureProject();
  try {
    const found = await findSheets(dir, 'src/index.html');
    assert.equal(found.entry, 'src/index.html');
    assert.deepEqual(found.sheets.map((s) => [s.file, s.from]), [['src/style.css', 'link'], ['src/more/extra.css', 'import'], ['src/loop.css', 'import'], ['src/abs.css', 'link'], ['src/index.html', 'style']], 'an import comes after the sheet that names it; a sheet named twice, or importing itself, is read once');
    assert.deepEqual(found.skipped, [
      { href: '../../../far.css', from: 'src/more/extra.css', reason: 'outside the project' },
      { href: 'https://fonts.example/x.css', from: 'src/index.html', reason: 'on another site; only files of the project are read' },
      { href: '../../outside.css', from: 'src/index.html', reason: 'outside the project' },
      { href: '../.studio/secret.css', from: 'src/index.html', reason: 'inside .git or .studio, which are not read' },
      { href: '../.git/config', from: 'src/index.html', reason: 'inside .git or .studio, which are not read' },
      { href: 'missing.css', from: 'src/index.html', reason: 'not found in the project' },
    ]);
    const inline = found.sheets.at(-1).decls[0];
    assert.deepEqual([inline.prop, inline.value, inline.line], ['color', '#123456', 13], 'a <style> declaration has its line in the page');
    assert.equal(found.sheets[0].lines, 4);
    // Entries that give nothing to follow say why.
    assert.match((await findSheets(dir, 'src/game.js')).reason, /^The project's entry \(src\/game\.js\) is not an HTML page/);
    assert.match((await findSheets(dir, '')).reason, /^The project names no entry page/);
    assert.match((await findSheets(dir, 'src/nope.html')).reason, /^The entry page src\/nope\.html could not be read/);
    assert.match((await findSheets(dir, '../elsewhere.html')).reason, /could not be read/);
    assert.equal((await findSheets(dir, '.studio/x.html')).entry, null, 'an entry inside .studio is not read');
    // More sheets than the limit: the rest are named, not read.
    await fsp.writeFile(path.join(dir, 'src', 'many.html'), Array.from({ length: MAX_SHEETS + 2 }, (_, i) => `<link rel="stylesheet" href="m${i}.css">`).join('\n'));
    for (let i = 0; i < MAX_SHEETS + 2; i++) await fsp.writeFile(path.join(dir, 'src', `m${i}.css`), `.m${i} { top: 0 }`);
    const many = await findSheets(dir, 'src/many.html');
    assert.deepEqual([many.sheets.length, many.skipped.length, many.skipped[0].reason], [MAX_SHEETS, 2, `more than ${MAX_SHEETS} stylesheets; the rest are not read`]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('visualizerAnswer: the design with the project\'s rules and board colours; it writes nothing, not even beside a damaged record', async () => {
  const dir = await fixtureProject();
  try {
    await fsp.writeFile(path.join(dir, '.studio', 'rules.json'), JSON.stringify({ rules: [{ id: 'rule_aaaa', kind: 'layout', text: 'Corners are 12 px', token: { name: '--radius', value: '12px' } }, { id: 'rule_bbbb', kind: 'tone', text: 'Plain words' }] }));
    await fsp.writeFile(path.join(dir, '.studio', 'inspiration.json'), JSON.stringify({ cards: [{ id: 'ins_aaaa', kind: 'color', hex: '#2f5bd3', name: 'blue' }, { id: 'ins_bbbb', kind: 'note', text: 'calm' }] }));
    const before = snapshot(dir, []);
    const a = await visualizerAnswer({ path: dir, manifest: { entry: 'src/index.html' } });
    assert.deepEqual(a.sheets.map((s) => [s.file, s.from, s.declarations]), [['src/style.css', 'link', 4], ['src/more/extra.css', 'import', 1], ['src/loop.css', 'import', 1], ['src/abs.css', 'link', 1], ['src/index.html', 'style', 1]]);
    assert.equal(a.skipped.length, 6);
    assert.deepEqual([a.rules.length, a.rules[0].check.state, a.rules[0].check.defs[0].file, a.rules[0].check.defs[0].line, a.rules[1].check], [2, 'breaks', 'src/style.css', 3, null]);
    assert.deepEqual([a.board.map((c) => [c.hex, c.state, c.nearest.label]), a.boardCards], [[['#2f5bd3', 'exact', '--accent']], 2], 'only the colour cards stand beside');
    assert.deepEqual(a.colors.find((c) => c.value === '#123456').places, [{ file: 'src/index.html', line: 13, scope: '.inline', prop: 'color' }]);
    assert.equal(a.colors.some((c) => /bada55|c0ffee/.test(c.value || '')), false, 'nothing of .studio or .git was read');
    assert.deepEqual([a.rulesError, a.boardError, a.limits.far, a.limits.places], [null, null, FAR, PLACES_MAX]);
    assert.deepEqual(snapshot(dir, []), before, 'no file changed, no file appeared');
    // Damaged records: said, not read as none, and no .corrupt copy is made by this route.
    await fsp.writeFile(path.join(dir, '.studio', 'rules.json'), '{ "rules": [');
    await fsp.writeFile(path.join(dir, '.studio', 'inspiration.json'), 'not json');
    const broken = snapshot(dir, []);
    const b = await visualizerAnswer({ path: dir, manifest: { entry: 'src/index.html' } });
    assert.deepEqual([b.rulesError, b.boardError, b.rules, b.board], ['.studio/rules.json could not be read', '.studio/inspiration.json could not be read', [], []]);
    assert.ok(b.colors.length > 0, 'the design is still answered');
    assert.deepEqual(snapshot(dir, []), broken);
    // No web entry: an answer that says so, with empty lists the view can draw.
    const none = await visualizerAnswer({ path: dir, manifest: { entry: 'src/main.js' } });
    assert.deepEqual([none.entry, none.sheets, none.colors, none.spacing], [null, [], [], []]);
    assert.match(none.reason, /is not an HTML page/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ---------- the real files ----------
test('the studio\'s own stylesheets: every sheet the page links is read, each value at its real line, and the studio\'s seed locks are kept', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(ROOT, 'atelier.json'), 'utf8'));
  const html = await fsp.readFile(path.join(ROOT, manifest.entry), 'utf8');
  const before = snapshot(path.join(ROOT, 'client'));
  const found = await findSheets(ROOT, manifest.entry);
  const linked = [...html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)">/g)].map((m) => `client/${m[1]}`);
  assert.ok(linked.includes('client/visualizer.css'), 'the Visualizer\'s own sheet is linked');
  assert.deepEqual(found.sheets.map((s) => s.file), linked, 'a path from the site\'s root is read from the entry\'s folder');
  assert.deepEqual(found.skipped, []);
  const styles = await fsp.readFile(path.join(ROOT, 'client', 'styles.css'), 'utf8');
  const d = readDesign(found.sheets, { rules: STUDIO_RULES.map((r, i) => ({ id: `rule_seed${i}`, ...r })), boardColors: [{ id: 'ins_a', hex: '#232221' }, { id: 'ins_b', hex: '#d6a455' }, { id: 'ins_c', hex: '#ece8e1' }] });
  const accent = d.colors.find((c) => c.name === '--accent');
  assert.deepEqual(accent.defs.map((x) => [x.canon, x.scope, x.file, x.line]), [['#d6a455', ':root, [data-theme="dark"]', 'client/styles.css', lineOf(styles, '--accent: #d6a455')], ['#a86f17', '[data-theme="light"]', 'client/styles.css', lineOf(styles, '--accent: #a86f17')]]);
  assert.ok(accent.count > 20 && accent.places.every((p) => p.file.startsWith('client/') && p.line > 0));
  // What the seed rules lock is what the stylesheet sets where no other theme is asked for (decision row 158).
  const locked = d.rules.filter((r) => r.check);
  assert.deepEqual(locked.map((r) => r.token.name).sort(), ['--accent', '--bg', '--ink', '--serif']);
  for (const r of locked) assert.ok(['matches', 'varies'].includes(r.check.state), `${r.token.name} is ${r.check.state}: the seed lock and client/styles.css disagree`);
  assert.deepEqual(d.rules.find((r) => r.token?.name === '--bg').check.defs.filter((x) => !x.same).map((x) => x.scope), ['[data-theme="light"]'], 'the light theme sets its own canvas, which the view names');
  assert.deepEqual(d.board.map((c) => [c.state, c.nearest.label]), [['exact', '--bg'], ['exact', '--accent'], ['exact', '--ink']]);
  for (const name of ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6']) assert.ok(d.spacing.some((s) => s.tokens.includes(name)), `${name} is on the spacing scale`);
  assert.deepEqual(d.type.families.map((f) => f.tokens[0]).sort(), ['--font', '--mono', '--serif']);
  assert.ok(d.motion.durations.find((m) => m.value === '140ms').tokens.includes('--t'));
  assert.deepEqual(snapshot(path.join(ROOT, 'client')), before, 'the studio\'s files are as they were');
});

test('every template\'s entry is read: a product such as Quick Notes or Room One has a design to draw', async () => {
  for (const name of await fsp.readdir(path.join(ROOT, 'templates'))) {
    const dir = path.join(ROOT, 'templates', name);
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'atelier.json'), 'utf8'));
    const a = await visualizerAnswer({ path: dir, manifest });
    assert.deepEqual([a.entry, a.sheets.map((s) => s.file)], [manifest.entry, [`${path.posix.dirname(manifest.entry)}/style.css`]], name);
    assert.ok(a.colors.length >= 3 && a.type.families.length >= 1 && a.type.sizes.length >= 1, `${name}: colours, a family and sizes`);
    for (const item of [...a.colors, ...a.type.sizes, ...a.spacing, ...a.radii, ...a.motion.durations, ...a.motion.easings]) assert.ok(item.home?.file && item.home.line > 0, `${name}: ${item.name || item.value} links to a line`);
  }
});

// ---------- through a real server process ----------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-viz-http-'));
let child;
let BASE;
let project;
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await fsp.mkdir(path.join(root, 'projects'), { recursive: true });
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects'), ATELIER_PID_FILE: path.join(root, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exit = code; });
  const t0 = Date.now();
  let up = false;
  while (exit === null && Date.now() - t0 < 30000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error(`server did not start on port ${PORT} after ${Date.now() - t0} ms (exit ${exit}): ${stderr.slice(-500)}`);
  const made = await api('POST', '/api/projects', { name: 'Viz Notes', kind: 'web-app', template: 'web-app-notes' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  project = made.data;
});
after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('GET /api/projects/:id/visualizer: a product\'s design with its rules and board; reading makes no version, no task and no changed file', async () => {
  const V = `/api/projects/${project.project.id}/visualizer`;
  const dir = project.entry.path;
  const files = snapshot(dir, ['.git', '.studio']);
  const plain = await api('GET', V);
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  assert.deepEqual([plain.data.entry, plain.data.sheets.map((s) => s.file), plain.data.rules, plain.data.board, plain.data.boardCards], ['src/index.html', ['src/style.css'], [], [], 0]);
  assert.ok(plain.data.colors.some((c) => c.name === '--accent' && c.defs.length === 2), 'the template\'s accent with its dark value');
  assert.equal(plain.data.colors.some((c) => c.drift.includes('far')), false, 'no board colour, so nothing is far');
  for (const rule of [{ text: 'Corners are 12 px', kind: 'layout', token: { name: '--radius', value: '12px' } }, { text: 'Tap targets stay 44 px', kind: 'layout', token: { name: '--tap', value: '44px' } }]) assert.equal((await api('POST', `/api/projects/${project.project.id}/rules`, rule)).status, 200);
  assert.equal((await api('POST', `/api/projects/${project.project.id}/inspiration`, { kind: 'color', hex: '#f7f6f3', name: 'paper' })).status, 200);
  const full = (await api('GET', V)).data;
  assert.deepEqual(full.rules.map((r) => [r.token.name, r.check.state]), [['--radius', 'breaks'], ['--tap', 'matches']]);
  assert.deepEqual(full.board.map((c) => [c.hex, c.name, c.state, c.nearest.label]), [['#f7f6f3', 'paper', 'exact', '--bg']]);
  assert.ok(full.colors.some((c) => c.drift.includes('far')), 'with a colour on the board, the ones far from it say so');
  assert.equal(full.radii.find((r) => r.value === '10px').tokens[0], '--radius');
  assert.deepEqual(full.locks['--radius'].state, 'breaks');
  assert.deepEqual(snapshot(dir, ['.git', '.studio']), files, 'the product\'s files are as they were');
  assert.equal((await api('GET', `/api/projects/${project.project.id}/versions`)).data.length ?? (await api('GET', `/api/projects/${project.project.id}/versions`)).data.versions.length, 1, 'no version was kept');
  const tasks = (await api('GET', `/api/projects/${project.project.id}/tasks`)).data;
  assert.equal((Array.isArray(tasks) ? tasks : tasks.tasks).length, 0, 'no task was made');
  assert.equal((await api('GET', `/api/projects/${project.project.id}/changes`)).status, 200);
  const gone = await api('GET', '/api/projects/p_nothere12345/visualizer');
  assert.equal(gone.status, 404);
});
