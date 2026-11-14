// The Visualizer's drawing (docs/DESIGN.md section 14): from the server's answer, the sections of the main column
// (colour swatches by use, the families and the type scale in the real fonts, spacing as bars at their real size,
// radii as corners, durations on one time axis, easings as curves) and the side column (the board's colours and the
// fixed rules, each locked token with its verdict). Every value carries one file:line button, and a count button
// when it stands in more than one place. ctx: { open(place), places(item), limits, locks, goto(hash) }.
// Values from a project's files are only ever set as text or as one style property, never as HTML.
import { el, button } from './ui.js';
import { USE_WORDS, USE_HINTS, groupColors, placeRef, placeFull, itemName, usesWords, driftMarks, lockWords, lockState, lockMark, boardWords, sampleSize, barWidth, msWords, easingPath, countWords, SAMPLE, FONT_NOTE, LEGEND } from './visualizer-words.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids); return n; };
const code = (text, cls = '') => { const n = el(`span.mono${cls}`, text); n.setAttribute('translate', 'no'); return n; };

/** A state as a word with a dot in its colour (DESIGN.md section 8): never colour alone. */
const mark = (tone, word, title) => el(`span.viz-mark.tone-${tone}`, { title }, el('span.viz-dot', { 'aria-hidden': 'true' }), word);

/** The one way to a line: "styles.css:16", which opens the Source tab there. */
function sourceLink(place, ctx, words = null) {
  if (!place?.file) return null;
  return button(words || placeRef(place), { small: true, variant: 'quiet', class: 'mono viz-src', title: `Open ${placeFull(place)} in the Source tab`, onclick: () => ctx.open(place) });
}

/** What every value says after its name: where it is at home, in how many places it stands, and its marks. */
function facts(item, ctx) {
  const many = item.kind === 'token' ? item.count > 0 || item.defs.length > 1 : item.count > 1;
  const locks = (item.kind === 'token' ? [item.name] : item.tokens || []).map((name) => ctx.locks?.[name] && { name, ...ctx.locks[name] }).filter(Boolean);
  return el('span.viz-facts',
    sourceLink(item.home, ctx),
    many ? button(usesWords(item), { small: true, variant: 'quiet', class: 'viz-count', title: `List where ${itemName(item)} is set and used`, onclick: () => ctx.places(item) })
      : item.kind === 'token' && !item.count ? el('span.viz-quiet', 'not used') : null,
    locks.map((l) => mark(lockState(l.state).tone, lockMark(l), `${l.name} is locked at ${l.value} by the rule "${l.text}"`)),
    driftMarks(item, ctx.limits).map((m) => mark('drift', m.word, m.title)));
}
const tokenWords = (item) => (item.tokens?.length ? code(item.tokens.join(' '), '.viz-token') : null);

function section(key, title, count, ...body) {
  const id = `viz-h-${key}`;
  return el('section.viz-section', { 'aria-labelledby': id, dataset: { section: key } }, el('h2.overline.viz-h', { id }, title, count != null ? el('span.viz-n', String(count)) : null), body);
}
const none = (words) => el('p.viz-none', words);

// ---------- colour ----------
function colorTile(c, ctx) {
  const base = c.kind === 'token' ? c.defs.find((d) => d.base) || c.defs[0] : c;
  const others = c.kind === 'token' ? c.defs.filter((d) => d !== base) : [];
  // The swatch is the value that holds where no condition does; a custom property's other values (another theme, a
  // media query, a component's own) are small chips after it, so the palette on screen stays one palette.
  const alts = others.slice(0, 4).map((d) => el('span.viz-chip.sm', { style: { backgroundColor: d.canon }, title: `${d.scope}: ${d.value}` }));
  const title = c.kind === 'token' ? [`${c.name}: ${base.value}`, ...others.map((d) => `${d.scope}: ${d.value}`)].join('\n') : c.value;
  return el('li.viz-color', { title, dataset: { value: itemName(c) } },
    el('span.viz-swatch', { style: { backgroundColor: base.canon }, 'aria-hidden': 'true' }),
    code(itemName(c), '.viz-name'),
    c.kind === 'token' ? el('span.viz-line.viz-alts', code(base.canon, '.viz-value'), alts, others.length > 4 ? el('span.viz-quiet', `+${others.length - 4}`) : null)
      : c.twin ? el('span.viz-value', 'same as ', code(c.twin)) : null,
    facts(c, ctx));
}
function colours(answer, ctx) {
  const groups = groupColors(answer.colors);
  if (!groups.length) return section('colour', 'Colour', 0, none('No colour is set in these stylesheets.'));
  return section('colour', 'Colour', answer.colors.length, groups.map((g) => el('div.viz-group', { dataset: { use: g.use } },
    el('h3.viz-sub', { title: USE_HINTS[g.use] }, USE_WORDS[g.use], el('span.viz-n', String(g.items.length))),
    el('ul.viz-colors', g.items.map((c) => colorTile(c, ctx))))));
}

// ---------- type ----------
function typeSection(answer, ctx) {
  const { families, sizes, base, rootPx } = answer.type;
  if (!families.length && !sizes.length) return section('type', 'Type', 0, none('No font family or size is set in these stylesheets.'));
  const webfont = families.some((f) => f.webfont) || (answer.skipped || []).some((s) => /font/i.test(s.href));
  const family = (f) => el('li.viz-family', { dataset: { value: f.value } },
    el('p.viz-sample', { style: { fontFamily: f.value } }, SAMPLE),
    el('p.viz-line', code(f.value, '.viz-stack'), tokenWords(f), facts(f, ctx)));
  const size = (s) => {
    const draw = sampleSize(s, rootPx);
    return el(`li.viz-size${draw ? '' : '.undrawn'}`, { dataset: { value: s.value } },
      code(s.value, '.viz-val'),
      draw ? el('span.viz-size-sample', { style: { fontSize: `${draw.px}px`, fontFamily: base || '' }, title: draw.note || undefined }, SAMPLE) : null,
      el('span.viz-line', !draw ? el('span.viz-quiet', 'a sum; not drawn') : draw.note ? el('span.viz-quiet', draw.note) : null, tokenWords(s), facts(s, ctx)));
  };
  return section('type', 'Type', families.length + sizes.length,
    families.length ? el('ul.viz-families', families.map(family)) : null,
    webfont ? el('p.viz-note', FONT_NOTE) : null,
    sizes.length ? el('ul.viz-sizes', sizes.map(size)) : none('No font size is set in these stylesheets.'));
}

// ---------- spacing, radii ----------
function spacingSection(answer, ctx) {
  const row = (s) => {
    const w = barWidth(s);
    return el(`li.viz-row${w ? '' : '.undrawn'}`, { dataset: { value: s.value } },
      code(s.value, '.viz-val'),
      w ? el('span.viz-track', el('span.viz-bar', { style: { width: `${w.px}px` }, title: w.cut ? `${s.value}: drawn at 160 px` : s.value, class: w.cut ? 'cut' : undefined })) : null,
      el('span.viz-line', w ? null : el('span.viz-quiet', 'relative; not drawn'), tokenWords(s), facts(s, ctx)));
  };
  return section('spacing', 'Spacing', answer.spacing.length, answer.spacing.length ? el('ul.viz-rows', answer.spacing.map(row)) : none('No margin, padding or gap is set in these stylesheets.'));
}
function radiiSection(answer, ctx) {
  const tile = (r) => el('li.viz-radius', { dataset: { value: r.value } },
    /^[\d.]+(px|%)$/.test(r.value) ? el('span.viz-corner', { style: { borderRadius: r.value }, 'aria-hidden': 'true' }) : el('span.viz-corner.undrawn', { 'aria-hidden': 'true' }),
    el('span.viz-line', code(r.value, '.viz-name'), tokenWords(r)), facts(r, ctx));
  return section('radii', 'Radii', answer.radii.length, answer.radii.length ? el('ul.viz-radii', answer.radii.map(tile)) : none('No border radius is set in these stylesheets.'));
}

// ---------- motion ----------
function motionSection(answer, ctx) {
  const { durations, easings } = answer.motion;
  if (!durations.length && !easings.length) return section('motion', 'Motion', 0, none('No transition or animation is set in these stylesheets.'));
  const longest = Math.max(...durations.map((d) => d.ms), 1);
  const duration = (d) => el('li.viz-row', { dataset: { value: d.value } },
    code(msWords(d.ms), '.viz-val'),
    el('span.viz-track.time', el('span.viz-bar', { style: { width: `${Math.max(1, (d.ms / longest) * 100)}%` }, title: `${msWords(d.ms)} of the longest, ${msWords(longest)}` })),
    el('span.viz-line', tokenWords(d), facts(d, ctx)));
  const easing = (e) => {
    const path = easingPath(e, 48);
    return el('li.viz-easing', { dataset: { value: e.value } },
      path ? svg('svg', { class: 'viz-curve', viewBox: '-2 -2 52 52', width: '52', height: '52', 'aria-hidden': 'true' }, svg('path', { d: 'M0 48 H48 M0 48 V0', class: 'viz-axis' }), svg('path', { d: path, class: 'viz-ease' })) : el('span.viz-curve.undrawn', { 'aria-hidden': 'true' }),
      el('span.viz-line', code(e.value, '.viz-name'), tokenWords(e)), facts(e, ctx));
  };
  return section('motion', 'Motion', durations.length + easings.length,
    durations.length ? el('ul.viz-rows', durations.map(duration)) : null,
    easings.length ? el('ul.viz-easings', easings.map(easing)) : null);
}

// ---------- the side column: what the person wants ----------
function boardSection(answer, ctx) {
  const toBoard = button('Open the board', { small: true, onclick: () => ctx.goto('#/inspiration') });
  if (answer.boardError) return section('board', 'Board colours', null, el('p.viz-none', `${answer.boardError}, so no colour is compared.`));
  if (!answer.board.length) return section('board', 'Board colours', 0, el('p.viz-none', 'No colour card on the board yet. Add a hex colour there and every colour here is compared with it.'), toBoard);
  return section('board', 'Board colours', answer.board.length, el('ul.viz-board', answer.board.map((c) => {
    const w = boardWords(c);
    return el('li.viz-card', { dataset: { hex: c.hex } },
      el('span.viz-chip', { style: { backgroundColor: c.hex }, 'aria-hidden': 'true' }),
      el('span.viz-card-body', el('span.viz-line', code(c.hex, '.viz-name'), c.name ? el('span.viz-quiet', c.name) : null),
        el('span.viz-line', mark(w.tone, w.words), c.nearest && c.state !== 'absent' ? sourceLink(c.nearest, ctx) : null)));
  })));
}
function rulesSection(answer, ctx) {
  const toRules = button('Open Fixed rules', { small: true, onclick: () => ctx.goto('#/inspiration/rules') });
  if (answer.rulesError) return section('rules', 'Fixed rules', null, el('p.viz-none', `${answer.rulesError}, so no lock is checked.`));
  if (!answer.rules.length) return section('rules', 'Fixed rules', 0, el('p.viz-none', 'No fixed rule yet. A rule that locks a custom property is checked here against the files.'), toRules);
  const locked = answer.rules.filter((r) => r.check);
  const words = answer.rules.filter((r) => !r.check);
  const lockNode = (r) => {
    const w = lockWords(r.check, r.token);
    return el('li.viz-rule', { dataset: { rule: r.id, state: r.check.state } },
      el('p.viz-rule-state', mark(w.tone, w.word)),
      el('p.viz-rule-text', r.text),
      el('p.viz-line', code(`${r.token.name}: ${r.token.value}`, '.viz-token')),
      w.detail ? el('p.viz-rule-detail', w.detail) : null,
      r.check.defs.length ? el('p.viz-line', r.check.defs.map((d) => sourceLink(d, ctx))) : null);
  };
  return section('rules', 'Fixed rules', answer.rules.length,
    locked.length ? el('ul.viz-rules', locked.map(lockNode)) : el('p.viz-none', 'No rule locks a custom property, so there is nothing to check against the files.'),
    words.length ? el('p.viz-sub', `In words, not checked here`, el('span.viz-n', String(words.length))) : null,
    words.length ? el('ul.viz-rules.plain', words.map((r) => el('li.viz-rule', { dataset: { rule: r.id } }, el('p.viz-rule-text', r.text)))) : null,
    toRules);
}

/** The line over the sections: the entry, the stylesheets it loads as links to their first line, and what was left out. */
function filesLine(answer, ctx) {
  return el('div.viz-files',
    el('p.viz-line', { title: `${countWords(answer.summary.declarations, 'declaration')} read` }, el('span.viz-quiet', 'Read from'), sourceLink({ file: answer.entry }, ctx, answer.entry), el('span.viz-quiet', '→'),
      answer.sheets.filter((s) => s.from !== 'style').map((s) => sourceLink({ file: s.file, line: 1 }, ctx, s.file.split('/').pop())),
      answer.sheets.some((s) => s.from === 'style') ? el('span.viz-quiet', 'and its own <style>') : null),
    (answer.skipped || []).length ? el('p.viz-line.viz-skipped', el('span.viz-quiet', 'Not read:'), answer.skipped.map((s) => el('span', { title: `Named in ${s.from}` }, code(s.href), el('span.viz-quiet', ` (${s.reason})`)))) : null,
    el('p.viz-legend', LEGEND));
}

/** The whole view for one answer: [main column, side column]. */
export function drawDesign(answer, ctx) {
  return [
    el('div.viz-main', filesLine(answer, ctx), colours(answer, ctx), typeSection(answer, ctx), spacingSection(answer, ctx), radiiSection(answer, ctx), motionSection(answer, ctx)),
    el('aside.viz-side', { 'aria-label': 'What the board and the fixed rules ask for' }, boardSection(answer, ctx), rulesSection(answer, ctx)),
  ];
}
