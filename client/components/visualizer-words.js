// The Visualizer's pure parts (components/visualizer-panel.js and visualizer-draw.js draw with them;
// tests/visualizer-view.test.mjs reads them): the groups and their words, what a lock check and a drift mark say, a
// place as file:line, the size a sample is drawn at, an easing as a curve, and the request of the task that tidies
// the drift. No DOM. The numbers and the judgements are the server's (server/lib/design-read.mjs).

export const USE_WORDS = { surface: 'Surfaces', text: 'Text', line: 'Lines', effect: 'Effects', unused: 'Not used' };
export const USE_HINTS = {
  surface: 'Used mostly as a background',
  text: 'Used mostly as the colour of text',
  line: 'Used mostly on borders and outlines',
  effect: 'Used mostly in shadows, fills, strokes and the like',
  unused: 'Set in a stylesheet and read by none of them',
};

/** The colours by what they are used for, in the order of USE_WORDS; a group with none is left out. */
export function groupColors(colors, uses = Object.keys(USE_WORDS)) {
  return uses.map((use) => ({ use, items: (colors || []).filter((c) => c.use === use) })).filter((g) => g.items.length);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const countWords = plural;

/** A place as the last part of its path and its line: "styles.css:16". */
export const placeRef = (p) => (p?.file ? `${String(p.file).split('/').pop()}${p.line ? `:${p.line}` : ''}` : '');
/** The same with the whole path, for a title and for a task's request. */
export const placeFull = (p) => (p?.file ? `${p.file}${p.line ? `:${p.line}` : ''}` : '');
/** What a place sets there: ".btn.primary { background }". */
export const placeWhat = (p) => `${p?.scope || ''} { ${p?.prop || ''} }`.trim();

/** A value's name on screen: a custom property's name, else the value as written. */
export const itemName = (item) => item?.name || item?.value || '';

/** How often, in the words of the list: "49 uses" for a custom property, "3 places" for a written-out value. */
export function usesWords(item) {
  if (item.kind === 'token') return item.count ? plural(item.count, 'use') : 'not used';
  return plural(item.count, 'place');
}

// ---------- drift ----------
export const DRIFT_WORDS = { once: 'once', far: 'far' };
/** The marks of a value: [{ key, word, title }]. limits.far is the server's threshold. */
export function driftMarks(item, limits = {}) {
  return (item.drift || []).map((key) => ({
    key,
    word: DRIFT_WORDS[key] || key,
    title: key === 'once'
      ? 'Written out in one place only, not through a custom property'
      : `Far from every colour on the board, and from every blend of two of them (${item.distance ?? item.defs?.find((d) => d.base)?.distance ?? '?'} away; over ${limits.far ?? 8} counts as far)`,
  }));
}

/** Every value that drifts, with what kind of value it is: [{ what, item, keys }]. */
export function driftList(answer) {
  const of = (what, list) => (list || []).filter((x) => x.drift?.length).map((item) => ({ what, item, keys: item.drift }));
  return [
    ...of('colour', answer?.colors), ...of('font size', answer?.type?.sizes), ...of('spacing', answer?.spacing),
    ...of('radius', answer?.radii), ...of('duration', answer?.motion?.durations), ...of('easing', answer?.motion?.easings),
  ];
}

// ---------- locks ----------
const STATE = {
  matches: { tone: 'ok', word: 'Kept' },
  varies: { tone: 'warn', word: 'Kept, with another value elsewhere' },
  breaks: { tone: 'danger', word: 'Broken' },
  missing: { tone: 'neutral', word: 'Not set in these stylesheets' },
};
/** A lock check in words: { tone, word, detail }. detail says what the files set where they differ. */
export function lockWords(check, token) {
  const s = STATE[check?.state] || { tone: 'neutral', word: 'Not checked' };
  const defs = check?.defs || [];
  const base = defs.find((d) => d.base);
  let detail = '';
  if (check?.state === 'breaks' && base) detail = `${placeRef(base)} sets ${base.value}, not ${token?.value}`;
  else if (check?.state === 'varies') detail = defs.filter((d) => !d.same).map((d) => `${d.scope || placeRef(d)} sets ${d.value}`).join('; ');
  else if (check?.state === 'missing' && token) detail = `No stylesheet read here sets ${token.name}`;
  return { ...s, detail };
}
/** The tone and the word of a lock's state alone (a value's mark, the list's note). */
export const lockState = (state) => STATE[state] || { tone: 'neutral', word: 'Not checked' };
/** The short word beside a value a rule locks. */
export const lockMark = (lock) => ({ matches: 'kept', varies: 'kept', breaks: 'broken', missing: 'locked' }[lock?.state] || 'locked');

// ---------- the board ----------
/** A board colour against the files: { tone, words }. */
export function boardWords(card) {
  const n = card?.nearest;
  const where = n ? `${n.label}${n.scope ? ` under ${n.scope}` : ''}` : '';
  if (card?.state === 'exact') return { tone: 'ok', words: `In the stylesheets as ${where}` };
  if (card?.state === 'close') return { tone: 'neutral', words: `Closest is ${where}, ${n.distance} away` };
  return { tone: 'warn', words: n ? `Not in the stylesheets; the closest is ${where}, ${n.distance} away` : 'Not in the stylesheets' };
}

// ---------- the head ----------
/** The count line beside the title: "Harbor · 3 stylesheets · 41 colours · 12 drifting · 1 lock broken". */
export function headWords(name, answer) {
  if (!answer) return name || '';
  if (!answer.entry) return [name, 'no web entry'].filter(Boolean).join(' · ');
  const drifting = driftList(answer).length;
  const broken = answer.summary?.locks?.breaks || 0;
  return [name, plural(answer.sheets.length, 'stylesheet'), plural(answer.colors.length, 'colour'), drifting ? `${drifting} drifting` : 'nothing drifting', broken ? `${plural(broken, 'lock')} broken` : null].filter(Boolean).join(' · ');
}

// ---------- drawing ----------
export const SAMPLE = 'Sphinx of black quartz, judge my vow';
export const SAMPLE_MAX = 48;
/** The size a type sample is drawn at: { px, note } or null for a size that cannot be drawn (a sum, a clamp).
 *  em and % are drawn against the root size, and say so; a size over 48 px is drawn at 48 and says so. */
export function sampleSize(item, rootPx = 16) {
  let px = item.px;
  let note = '';
  if (px == null) {
    const m = String(item.value).match(/^((?:\d*\.)?\d+)(em|%)$/);
    if (!m) return null;
    px = Math.round(parseFloat(m[1]) * (m[2] === '%' ? rootPx / 100 : rootPx) * 100) / 100;
    note = `drawn against ${rootPx} px`;
  }
  if (px > SAMPLE_MAX) return { px: SAMPLE_MAX, note: `drawn at ${SAMPLE_MAX} px` };
  return { px, note };
}

/** A length as the width of its bar, drawn at its real size up to max; { px, cut } or null for a relative one. */
export function barWidth(item, max = 160) {
  if (item.px == null) return null;
  return { px: Math.max(1, Math.min(item.px, max)), cut: item.px > max };
}

/** A duration in words: "140 ms", "1.8 s". */
export const msWords = (ms) => (ms >= 1000 ? `${Math.round(ms / 10) / 100} s` : `${ms} ms`);

/**
 * An easing as the path of its curve in a square of `size`, time left to right and progress bottom to top, or null
 * for one that is no curve (linear() with stops). A stepped easing is a staircase.
 */
export function easingPath(item, size = 48) {
  const r = (n) => Math.round(n * 100) / 100;
  if (Array.isArray(item.curve)) {
    const [x1, y1, x2, y2] = item.curve;
    return `M0 ${size} C${r(x1 * size)} ${r(size - y1 * size)} ${r(x2 * size)} ${r(size - y2 * size)} ${size} 0`;
  }
  if (item.steps) {
    const n = Math.min(item.steps, 12);
    let d = `M0 ${size}`;
    for (let i = 1; i <= n; i++) d += ` H${r((i / n) * size)} V${r(size - (i / n) * size)}`;
    return d;
  }
  return null;
}

// ---------- the task that tidies the drift ----------
export const TASK_LIST_MAX = 30;
const listed = (lines, max = TASK_LIST_MAX) => (lines.length > max ? [...lines.slice(0, max), `- and ${lines.length - max} more (the Visualizer lists them all)`] : lines);

/**
 * What Make it a task would create: { title, request, files, count }, or null when nothing drifts and no lock is
 * broken. The request names every value with its place, so a session can go straight to the lines; the person reads
 * and edits it before the task is made.
 */
export function taskRequest(name, answer) {
  const drift = driftList(answer);
  const broken = (answer?.rules || []).filter((r) => r.check?.state === 'breaks');
  if (!drift.length && !broken.length) return null;
  const at = (item) => (item.count > 1 ? `${plural(item.count, 'place')}, first at ${placeFull(item.places?.[0] || item.home)}` : `at ${placeFull(item.places?.[0] || item.home)}`);
  const far = drift.filter((d) => d.keys.includes('far')).map(({ item }) => `- ${itemName(item)}${item.kind === 'token' ? ` (${item.defs.find((x) => x.base)?.canon})` : ''}, ${item.kind === 'token' ? `set at ${placeFull(item.home)}` : at(item)}`);
  const once = drift.filter((d) => d.keys.includes('once')).map(({ what, item }) => `- ${what} ${itemName(item)} ${at(item)}`);
  const parts = [`Tidy the drift in ${name || 'this project'}'s design system, as the Visualizer read it from ${answer.entry} (${answer.sheets.map((s) => s.file).join(', ')}). Change only what is listed here, keep every fixed rule, and leave a value as it is when it is right: say which and why in the result.`];
  if (broken.length) parts.push(['Locked tokens the files break (the rule is the person\'s; set the file back to the locked value, or ask before changing the rule):', ...broken.map((r) => { const base = r.check.defs.find((d) => d.base); return `- ${r.token.name} is locked at ${r.token.value}; ${placeFull(base)} sets ${base.value}`; })].join('\n'));
  if (far.length) parts.push([`Colours far from every colour on the inspiration board (move each to a board colour or an existing custom property, or say why it stays):`, ...listed(far)].join('\n'));
  if (once.length) parts.push([`Values written out in one place only (use the nearest value of the scale or a custom property, or say why it stays):`, ...listed(once)].join('\n'));
  const count = drift.length + broken.length;
  return { title: `Tidy the design drift the Visualizer found (${plural(count, 'value')})`, request: parts.join('\n\n'), files: answer.sheets.map((s) => s.file), count };
}

export const NO_ENTRY_HINT = 'The Visualizer reads the stylesheets the project\'s web entry loads.';
export const EMPTY_SHEETS = 'The entry page loads no stylesheet from this project, so there is nothing to draw yet.';
export const FONT_NOTE = 'A font the page loads from the web or through @font-face is not loaded here: its sample is drawn in the next face of its stack this computer has.';
export const LEGEND = 'once: written out in one place only · far: far from every colour on the board';
