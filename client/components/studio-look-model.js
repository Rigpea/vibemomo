// The Studio look (docs/DESIGN.md section 15, docs/ARCHITECTURE.md section 27): Make a look reads the person's Studio
// look board and proposes a theme for the studio: canvas, panel, ink, accent, display font and corners, each naming the
// card it came from. No DOM and no Node. The colours keep AA on every surface text sits on (appearance-model.js does
// the checking and offers the nearest shade that passes); the proposal is checked with the same patch check the
// server uses, so what is previewed is what Apply can keep.
import { CANVAS, DEFAULT_ACCENT, FONTS, CONTROLS, SIDE, normHex, contrast, luminance, mix, toHsl, fromHsl, passAll, inkPassing, accentGrounds, checkAppearancePatch, mergeAppearance, cleanAppearance, textPairs, ratioWords } from './appearance-model.js';
import { cardName } from './inspiration-words.js';

/** How colourful a colour looks: HSL saturation weighed by how far its lightness is from black or white. */
export const chroma = (hex) => { const [, s, l] = toHsl(hex); return s * (1 - Math.abs(2 * l - 1)); };

/** The colours a board offers: its colour cards in board order, then hex values written in its notes; each once. */
export function boardColours(cards) {
  const out = [];
  const seen = new Set();
  const add = (hex, card) => { if (hex && !seen.has(hex)) { seen.add(hex); out.push({ hex, card }); } };
  for (const c of cards || []) if (c?.kind === 'color') add(normHex(c.hex), c);
  for (const c of cards || []) if (c?.kind === 'note') for (const m of String(c.text || '').matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) add(normHex(m[0]), c);
  return out;
}

/** The words of a card a font or a corner can be read from: its text or title, its name, its why and its tags. */
const wordsOf = (c) => [c.text, c.title, c.description, c.name, c.why, ...(c.tags || [])].filter(Boolean).join(' \n ');
const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const at = (text, w) => { const m = new RegExp(`(^|[^a-z])${escape(w)}(?=[^a-z]|$)`, 'i').exec(text); return m ? m.index + m[1].length : -1; };
/** Cards tagged with tag first, then the rest, each in board order. */
const tagFirst = (cards, tag) => [...cards.filter((c) => c.tags?.includes(tag)), ...cards.filter((c) => !c.tags?.includes(tag))];

/** The display face a board asks for: the first card (type-tagged first) that names a face or says serif or sans.
 *  Within a card a family's name beats a word for its mood, which beats a plain serif or sans ("a serif like
 *  Garamond" is Garamond); among equals the earliest word wins. { key, card, word } or null. */
export function fontFromBoard(cards) {
  const words = [
    ...Object.entries(FONTS).flatMap(([key, f]) => f.words.map((word, n) => ({ key, word, tier: n === 0 ? 0 : 1 }))),
    { key: 'grotesk', word: 'sans-serif', tier: 2 }, { key: 'grotesk', word: 'sans', tier: 2 }, { key: 'source', word: 'serif', tier: 2 },
  ];
  for (const card of tagFirst((cards || []).filter((c) => c?.kind !== 'color'), 'type')) {
    const text = wordsOf(card);
    let best = null;
    for (const w of words) {
      const i = at(text, w.word);
      // the strongest tier, then the earliest word; at one place the longer word ("sans-serif" over "sans" and "serif")
      if (i >= 0 && (!best || w.tier < best.tier || (w.tier === best.tier && (i < best.i || (i === best.i && w.word.length > best.word.length))))) best = { ...w, i };
    }
    if (best) return { key: best.key, card, word: best.word };
  }
  return null;
}

const RADIUS_WORDS = [
  ['soft', ['soft corners', 'soft corner', 'slightly rounded', 'gently rounded']],
  ['sharp', ['sharp', 'square', 'squared', 'crisp', 'angular', 'hard edges', 'hard-edged', 'brutalist']],
  ['round', ['rounded', 'round', 'pill', 'pills', 'bubbly', 'playful', 'friendly']],
];
/** The corners a board asks for: the first card (layout-tagged first) with a word for them. { key, card, word } or null. */
export function radiusFromBoard(cards) {
  for (const card of tagFirst((cards || []).filter((c) => c?.kind !== 'color'), 'layout')) {
    const text = wordsOf(card);
    let best = null;
    for (const [key, list] of RADIUS_WORDS) for (const word of list) {
      const i = at(text, word);
      if (i >= 0 && (!best || i < best.i || (i === best.i && word.length > best.word.length))) best = { key, word, i };
    }
    if (best) return { key: best.key, card, word: best.word };
  }
  return null;
}

const quote = (card) => `“${cardName(card)}”`;
const darkerOrLighter = (from, to) => (luminance(to) < luminance(from) ? 'darker' : 'lighter');

/**
 * Propose a look for a theme from a board's cards, on top of what is stored. Answers { theme, rows, patch, preview,
 * pairs, problem }: rows say per choice { key, label, value, hex?, card, words } where the value came from; patch is
 * what Apply sends (only the choices the board gave), preview the stored choices with the patch merged in (what the
 * page shows while the proposal is open), pairs every text and surface pair at its ratio, lowest first. With no
 * colour on the board there are no colour rows; problem is a sentence when the patch check refuses (it should not).
 */
export function proposeLook(cards, theme = 'dark', stored = {}) {
  const colours = boardColours(cards);
  const { away, need } = SIDE[theme];
  const onSide = (hex) => contrast(hex, away) >= need;
  const rows = [];
  const patch = {};

  if (colours.length) {
    // Canvas: the quietest colour on the theme's side (a light canvas leaves near-white for the panel); else a shade
    // of the quietest colour on the board, moved to the theme's side.
    const side = colours.filter((c) => onSide(c.hex) && (theme === 'dark' || luminance(c.hex) <= 0.95));
    const quiet = (a, b) => chroma(a.hex) - chroma(b.hex) || (theme === 'dark' ? luminance(a.hex) - luminance(b.hex) : luminance(b.hex) - luminance(a.hex));
    let canvas;
    if (side.length) {
      const pick = [...side].sort(quiet)[0];
      canvas = { hex: pick.hex, card: pick.card, words: `from ${quote(pick.card)}` };
    } else {
      const pick = [...colours].sort(quiet)[0];
      const [h, s] = toHsl(pick.hex);
      canvas = { hex: fromHsl(h, Math.min(s, 0.3), theme === 'dark' ? 0.13 : 0.94), card: pick.card, words: `a ${theme} shade of ${pick.hex}, from ${quote(pick.card)}` };
    }
    const taken = new Set([canvas.hex]);

    // Panel: a colour on the same side a small step from the canvas; else a step toward white, as the studio's own.
    const step = colours.filter((c) => !taken.has(c.hex) && onSide(c.hex) && contrast(c.hex, canvas.hex) >= 1.02 && contrast(c.hex, canvas.hex) <= 1.6);
    let panel;
    if (step.length) {
      const pick = [...step].sort((a, b) => Math.abs(contrast(a.hex, canvas.hex) - 1.12) - Math.abs(contrast(b.hex, canvas.hex) - 1.12))[0];
      panel = { hex: pick.hex, card: pick.card, words: `from ${quote(pick.card)}` };
    } else panel = { hex: mix(canvas.hex, '#ffffff', theme === 'dark' ? 0.035 : 0.6), card: canvas.card, words: 'a step up from the canvas' };
    taken.add(panel.hex);

    // Ink: the quiet colour furthest from the canvas on the other side; else a shade of the canvas's hue.
    const other = colours.filter((c) => !taken.has(c.hex) && (theme === 'dark' ? luminance(c.hex) > luminance(canvas.hex) : luminance(c.hex) < luminance(canvas.hex)) && contrast(c.hex, canvas.hex) >= 3);
    const byContrast = (a, b) => contrast(b.hex, canvas.hex) - contrast(a.hex, canvas.hex);
    const quietInks = other.filter((c) => chroma(c.hex) <= 0.3);
    const inkPick = [...(quietInks.length ? quietInks : other)].sort(byContrast)[0];
    let ink;
    if (inkPick) ink = { hex: inkPick.hex, card: inkPick.card, words: `from ${quote(inkPick.card)}` };
    else { const [h, s] = toHsl(canvas.hex); ink = { hex: fromHsl(h, Math.min(s, 0.12), theme === 'dark' ? 0.91 : 0.13), card: canvas.card, words: 'a shade of the canvas\'s hue (no colour on the board reads as ink)' }; }
    taken.add(ink.hex);
    const inkHex = inkPassing({ canvas: canvas.hex, panel: panel.hex, ink: ink.hex }, theme);
    if (inkHex !== ink.hex) ink = { ...ink, words: `${ink.words}, made ${darkerOrLighter(ink.hex, inkHex)} from ${ink.hex} to pass` };
    const surfaces = { canvas: canvas.hex, panel: panel.hex, ink: inkHex };

    // Accent: the most colourful colour left; else the studio's own. Either way the nearest shade that passes.
    const grounds = accentGrounds({ surfaces: { [theme]: surfaces } }, theme).map((g) => g.hex);
    // A card that says accent comes first; otherwise colour counts, and so does a hue that stands apart from the canvas.
    const canvasHue = toHsl(surfaces.canvas)[0];
    const hueApart = (hex) => { const d = Math.abs(toHsl(hex)[0] - canvasHue) % 360; return Math.min(d, 360 - d) / 180; };
    const saysAccent = (c) => /\baccent\b/i.test(wordsOf(c.card));
    const score = (c) => (saysAccent(c) ? 10 : 0) + chroma(c.hex) * (0.5 + 0.5 * hueApart(c.hex));
    const vivid = colours.filter((c) => !taken.has(c.hex) && chroma(c.hex) >= 0.12).sort((a, b) => score(b) - score(a))[0];
    const start = vivid ? vivid.hex : DEFAULT_ACCENT[theme];
    const accentHex = passAll(start, grounds);
    let accentWords = vivid ? `from ${quote(vivid.card)}` : `the studio's own ${DEFAULT_ACCENT[theme]} (no colourful card left on the board)`;
    if (accentHex !== start) accentWords += `, made ${darkerOrLighter(start, accentHex)} from ${start} to pass`;

    rows.push(
      { key: 'canvas', label: 'Canvas', value: surfaces.canvas, hex: surfaces.canvas, card: canvas.card, words: canvas.words },
      { key: 'panel', label: 'Panel', value: surfaces.panel, hex: surfaces.panel, card: panel.card, words: panel.words },
      { key: 'ink', label: 'Ink', value: surfaces.ink, hex: surfaces.ink, card: ink.card, words: ink.words },
      { key: 'accent', label: 'Accent', value: accentHex, hex: accentHex, card: vivid?.card || null, words: accentWords },
    );
    patch.surfaces = { [theme]: surfaces };
    patch.accent = { [theme]: accentHex };
  }

  const font = fontFromBoard(cards);
  if (font) {
    rows.push({ key: 'display', label: 'Display font', value: font.key, font: FONTS[font.key].stack, card: font.card, words: `“${font.word}” in ${quote(font.card)}` });
    patch.display = font.key;
  } else rows.push({ key: 'display', label: 'Display font', value: null, card: null, words: 'No card names a face or says serif or sans, so the display font stays as it is.' });

  const radius = radiusFromBoard(cards);
  if (radius) {
    rows.push({ key: 'radius', label: 'Corners', value: radius.key, card: radius.card, words: `“${radius.word}” in ${quote(radius.card)}` });
    patch.radius = radius.key;
  } else rows.push({ key: 'radius', label: 'Corners', value: null, card: null, words: 'No card has a word for corners (sharp, rounded, soft corners…), so they stay as they are.' });

  const checked = checkAppearancePatch(patch, stored);
  if (!checked.ok) return { theme, rows, patch, preview: null, pairs: [], problem: checked.message };
  const preview = mergeAppearance(stored, checked);
  return { theme, rows, patch, preview, pairs: textPairs(preview, theme), problem: null };
}

/** The sentence under a proposal: how its text and surface pairs stand. */
export function pairsWords(pairs) {
  if (!pairs?.length) return '';
  const low = pairs[0];
  return `Every text and surface pair passes AA: ${pairs.length} pairs, the lowest ${low.words} at ${ratioWords(low.ratio)}.`;
}

/** What a choice reads as on a row: a hex, a face's name, a corner's name. */
export function valueWords(row) {
  if (row.value == null) return 'unchanged';
  if (row.key === 'display') return FONTS[row.value]?.label || row.value;
  if (row.key === 'radius') return CONTROLS.radius.options[row.value]?.label || row.value;
  return row.value;
}

/** Whether a look of the person's own is in effect: surfaces, an accent or a display face (what Reset undoes here). */
export const hasLook = (appearance) => { const a = cleanAppearance(appearance); return !!(a.surfaces || a.accent || a.display || a.radius); };

/** The canvas a theme shows (the look's, else the studio's own). */
export const canvasOf = (appearance, theme = 'dark') => cleanAppearance(appearance).surfaces?.[theme]?.canvas || CANVAS[theme];
