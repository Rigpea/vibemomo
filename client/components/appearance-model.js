// Appearance (docs/ARCHITECTURE.md section 24, docs/DESIGN.md section 12): the pure parts of the person's own look
// for the studio. What can be chosen, the CSS custom properties of client/styles.css each choice writes, the contrast
// every text colour must keep on every surface it sits on, what a patch may hold, and which of the studio's locked
// defaults the person's look sets to another value (a personal layer: a lock binds the source, never the look).
// No DOM and no Node: the settings view and the Studio look draw with it, components/appearance.js applies it, and the
// server checks a patch with the same code (server/lib/appearance.mjs), so the screen and the route can never disagree.

export const THEMES = ['dark', 'light'];
/** --bg, --ink and --accent as client/styles.css holds them per theme (tests/appearance.test.mjs compares). */
export const CANVAS = { dark: '#232221', light: '#f3f1ec' };
export const INK = { dark: '#ece8e1', light: '#1f1c18' };
export const DEFAULT_ACCENT = { dark: '#d6a455', light: '#a86f17' };
/** WCAG 2.1 AA: text in the accent (links, the selected tab's words) 4.5:1; the focus ring, a non-text part, 3:1. */
export const AA_TEXT = 4.5;
export const AA_RING = 3;
/** The state colours per theme, as client/styles.css holds them: a look moves one only as far as it must to pass. */
export const STATES = { dark: { ok: '#93be7c', warn: '#d6a455', danger: '#e07a72', busy: '#9fb3c8' }, light: { ok: '#1d7a49', warn: '#8a5a00', danger: '#b4232c', busy: '#3a4fb8' } };
/** A look's three surface colours for a theme (Inspiration, Studio look); everything else is worked out from them. */
export const SURFACE_KEYS = ['canvas', 'panel', 'ink'];
/** Every token a theme's surfaces write: the surfaces, the hairlines, the three inks, and the state colours. */
export const SURFACE_TOKENS = ['--bg', '--panel', '--panel-2', '--panel-3', '--field', '--line', '--line-strong', '--ink', '--ink-2', '--muted', '--seg-on', '--code-bg', '--canvas-dot', '--ok', '--warn', '--danger', '--busy', '--ok-soft', '--warn-soft', '--danger-soft', '--busy-soft'];
/** The surfaces text sits on, by token, with the words a sentence uses for each. */
export const TEXT_GROUNDS = { '--bg': 'canvas', '--panel': 'panel', '--panel-2': 'raised panel', '--field': 'field', '--seg-on': 'selected control' };
/** The text colours checked on every one of those surfaces. */
export const TEXT_INKS = { '--ink': 'ink', '--ink-2': 'second ink', '--muted': 'muted ink', '--accent': 'accent' };

/** Display faces for the product's own words and a task's title (--serif). Only these stacks can be chosen: a stored
 *  key, never a CSS value, so nothing a registry holds is written into a style as it is. Each stack ends in families
 *  every system has. words: what a board's card may say to suggest it (components/studio-look-model.js). */
export const FONTS = {
  source: { label: 'Source Serif', stack: '"Source Serif 4", "Source Serif Pro", "Iowan Old Style", "Charter", "Cambria", "Georgia", serif', words: ['source serif'] },
  garamond: { label: 'Garamond', stack: '"EB Garamond", "Garamond", "Iowan Old Style", "Georgia", serif', words: ['garamond', 'old style', 'oldstyle', 'bookish', 'literary'] },
  didone: { label: 'Didone', stack: '"Bodoni 72", "Bodoni MT", "Didot", "Playfair Display", "Georgia", serif', words: ['bodoni', 'didot', 'didone', 'playfair', 'high contrast serif'] },
  georgia: { label: 'Georgia', stack: '"Georgia", "Cambria", "Times New Roman", serif', words: ['georgia', 'times new roman', 'cambria', 'newspaper'] },
  slab: { label: 'Slab serif', stack: '"Rockwell", "Roboto Slab", "Zilla Slab", "Courier New", serif', words: ['slab', 'rockwell', 'typewriter'] },
  humanist: { label: 'Humanist sans', stack: '"Gill Sans", "Gill Sans MT", "Seravek", "Optima", "Segoe UI", sans-serif', words: ['gill sans', 'optima', 'humanist', 'seravek'] },
  grotesk: { label: 'Grotesk sans', stack: '"Inter", "Helvetica Neue", "Helvetica", "Arial", sans-serif', words: ['inter', 'helvetica', 'grotesk', 'grotesque', 'swiss'] },
  geometric: { label: 'Geometric sans', stack: '"Futura", "Century Gothic", "Avenir Next", "Avenir", sans-serif', words: ['futura', 'avenir', 'century gothic', 'geometric', 'bauhaus'] },
  rounded: { label: 'Rounded sans', stack: '"SF Pro Rounded", "Nunito", "Varela Round", "Arial Rounded MT Bold", sans-serif', words: ['rounded sans', 'nunito', 'varela', 'rounded type', 'rounded font'] },
  mono: { label: 'Monospace', stack: '"Cascadia Code", "Consolas", ui-monospace, monospace', words: ['monospace', 'cascadia', 'consolas', 'code font'] },
};

/** Accents offered as presets, each chosen to pass on the dark canvas; the light theme gets the nearest shade that
 *  passes there (accentPair). The first is the studio's own. */
export const ACCENT_PRESETS = [
  { name: 'Amber', hex: '#d6a455' },
  { name: 'Clay', hex: '#d9906b' },
  { name: 'Rose', hex: '#d68aa6' },
  { name: 'Lilac', hex: '#b09ce0' },
  { name: 'Sky', hex: '#79b3dc' },
  { name: 'Teal', hex: '#5fbcab' },
];

const px = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, `${v}px`]));
const choice = (label, def, hint, options) => ({ label, def, hint, options, tokens: Object.keys(options[def].tokens) });

/**
 * Every control: its label, the tokens it writes, and for a choice its options in order, each with its label and the
 * value of every token. The default option holds the values client/styles.css has, so choosing it writes nothing.
 */
export const CONTROLS = {
  accent: { label: 'Accent', tokens: ['--accent', '--accent-soft', '--accent-ink', '--focus'] },
  // A theme's canvas, panel and ink (Inspiration, Studio look): { dark?, light? }, like the accent.
  surfaces: { label: 'Surfaces', tokens: SURFACE_TOKENS },
  display: choice('Display font', 'source', 'The face of the product\'s own words and a task\'s title.', Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, { label: f.label, tokens: { '--serif': f.stack } }]))),
  // Density moves the heights of controls, rows and bars. The spacing scale (--s1 to --s6) stays: the 8 px grid is a
  // fixed rule of the studio in words.
  density: choice('Density', 'comfortable', 'The height of buttons, fields, rows and bars. The spacing grid stays.', {
    comfortable: { label: 'Comfortable', tokens: { ...px({ '--ctl-h': 32, '--ctl-h-sm': 28, '--ctl-pad': 5, '--row-h': 40, '--top-h': 44, '--view-h': 40, '--cell-y': 6 }) } },
    compact: { label: 'Compact', tokens: { ...px({ '--ctl-h': 28, '--ctl-h-sm': 24, '--ctl-pad': 2, '--row-h': 32, '--top-h': 40, '--view-h': 36, '--cell-y': 3 }) } },
  }),
  textSize: choice('Text size', 'default', 'Interface text, one pixel a step. Code in the terminal and lessons keep their own size.', {
    small: { label: 'Small', tokens: px({ '--fs-title': 17, '--fs-h': 13, '--fs-body': 13, '--fs-sm': 12, '--fs-meta': 11.5, '--fs-xs': 11, '--fs-over': 11 }) },
    default: { label: 'Default', tokens: px({ '--fs-title': 18, '--fs-h': 14, '--fs-body': 14, '--fs-sm': 13, '--fs-meta': 12.5, '--fs-xs': 12, '--fs-over': 11 }) },
    large: { label: 'Large', tokens: px({ '--fs-title': 19, '--fs-h': 15, '--fs-body': 15, '--fs-sm': 14, '--fs-meta': 13.5, '--fs-xs': 13, '--fs-over': 11.5 }) },
    larger: { label: 'Larger', tokens: px({ '--fs-title': 20, '--fs-h': 16, '--fs-body': 16, '--fs-sm': 15, '--fs-meta': 14.5, '--fs-xs': 14, '--fs-over': 12 }) },
  }),
  radius: choice('Corners', 'soft', 'Buttons and fields, cards and panels, dialogs.', {
    sharp: { label: 'Sharp', tokens: px({ '--r1': 2, '--r2': 3, '--r3': 4 }) },
    soft: { label: 'Soft', tokens: px({ '--r1': 6, '--r2': 8, '--r3': 10 }) },
    round: { label: 'Round', tokens: px({ '--r1': 10, '--r2': 14, '--r3': 18 }) },
  }),
  motion: choice('Motion', 'normal', 'Reduced turns transitions and animations off.', {
    normal: { label: 'Normal', tokens: { '--t': '140ms' } },
    reduced: { label: 'Reduced', tokens: { '--t': '0ms' } },
  }),
};
export const CONTROL_KEYS = Object.keys(CONTROLS);
export const CHOICE_KEYS = CONTROL_KEYS.filter((k) => CONTROLS[k].options);
/** The keys kept per theme as { dark?, light? }. */
export const THEMED_KEYS = ['accent', 'surfaces'];
/** Every token any control writes: what components/appearance.js sets or takes off the root element. */
export const ALL_TOKENS = [...new Set(CONTROL_KEYS.flatMap((k) => CONTROLS[k].tokens))];

// ---------- colour ----------
const shown = (v, max = 40) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** '#rrggbb' in lower case from a hex of 3 or 6 digits, or null. */
export function normHex(v) {
  const m = typeof v === 'string' ? v.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i) : null;
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (parts) => `#${parts.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
const linear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
/** WCAG relative luminance of a '#rrggbb'. */
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio of two '#rrggbb' colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** a moved toward b by t (0 to 1) in sRGB. */
export const mix = (a, b, t) => { const [p, q] = [rgb(a), rgb(b)]; return toHex(p.map((c, i) => c + (q[i] - c) * t)); };

/** [hue 0-360, saturation 0-1, lightness 0-1] of a '#rrggbb'. */
export function toHsl(hex) {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
/** '#rrggbb' of a hue, saturation and lightness. */
export function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([r, g, b].map((v) => (v + m) * 255));
}

/**
 * The shade of this hue closest to hex that reaches min:1 against the canvas: the hue and saturation stay, the
 * lightness moves away from the canvas only as far as it must. A colour that already passes comes back as it is.
 */
export function nearestPassing(hex, canvas, min = AA_TEXT) {
  if (contrast(hex, canvas) >= min) return hex;
  const [h, s, l] = toHsl(hex);
  const end = contrast('#ffffff', canvas) >= contrast('#000000', canvas) ? 1 : 0; // the side away from the canvas
  let fails = l;
  let passes = end;
  for (let i = 0; i < 24; i++) {
    const mid = (fails + passes) / 2;
    if (contrast(fromHsl(h, s, mid), canvas) >= min) passes = mid; else fails = mid;
  }
  let out = fromHsl(h, s, passes);
  // Rounding to 8 bits can land a hair under: step on until the hex itself passes.
  for (let i = 0; i < 64 && contrast(out, canvas) < min; i++) { passes += (end - passes) * 0.05 + (end ? 0.002 : -0.002); out = fromHsl(h, s, Math.max(0, Math.min(1, passes))); }
  return out;
}

/** The shade of hex closest to it that reaches min:1 on every one of these surfaces (they lie on one side: a theme's
 *  surfaces are all dark or all light), by stepping away from the one it is closest to until none is too close. */
export function passAll(hex, surfaces, min = AA_TEXT) {
  let out = hex;
  for (let i = 0; i < 8; i++) {
    const worst = surfaces.reduce((w, g) => (contrast(out, g) < contrast(out, w) ? g : w), surfaces[0]);
    if (contrast(out, worst) >= min) return out;
    out = nearestPassing(out, worst, min);
  }
  return out;
}

/** A ratio as it is said: one decimal, cut rather than rounded, so 4.46 never reads as a passing 4.5. */
export const ratioWords = (r) => `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;

// ---------- surfaces: a theme's canvas, panel and ink (Inspiration, Studio look) ----------
const rgbaOf = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };
/** What a theme's canvas and panel stay on the side of: a dark theme's are dark, a light theme's light. */
export const SIDE = { dark: { away: '#ffffff', need: 7 }, light: { away: '#000000', need: 12 } };

/** The surfaces text sits on, worked out from the three colours: the raised panel a step toward the ink, the field a
 *  step away from it, the selected control's ground. */
export function surfaceGrounds({ canvas, panel, ink }, theme = 'dark') {
  const field = theme === 'dark' ? mix(canvas, '#000000', 0.14) : mix(canvas, '#ffffff', 0.7);
  return { '--bg': canvas, '--panel': panel, '--panel-2': mix(panel, ink, 0.05), '--field': field, '--seg-on': theme === 'dark' ? mix(panel, ink, 0.12) : field };
}

/** The ink moved only as far as it must to pass on every surface (the raised ones move a little with it). */
export function inkPassing(s, theme = 'dark') {
  let ink = s.ink;
  for (let i = 0; i < 6; i++) {
    const next = passAll(ink, Object.values(surfaceGrounds({ ...s, ink }, theme)));
    if (next === ink) break;
    ink = next;
  }
  return ink;
}

/**
 * Whether { canvas, panel, ink } can be a theme's surfaces. { ok, surfaces } when they can; otherwise { ok: false,
 * reason: 'invalid' | 'not_hex' | 'wrong_side' | 'low_contrast', sentence, nearest? }: the canvas and the panel stay on
 * the theme's side, and the ink reaches AA on every surface text sits on (nearest: the ink that would).
 */
export function surfaceCheck(value, theme = 'dark') {
  if (!isMap(value) || Object.keys(value).some((k) => !SURFACE_KEYS.includes(k))) return { ok: false, reason: 'invalid', sentence: `A theme's surfaces are { ${SURFACE_KEYS.join(', ')} }: three hex colors` };
  const out = {};
  for (const k of SURFACE_KEYS) {
    const hex = normHex(value[k]);
    if (!hex) return { ok: false, reason: 'not_hex', sentence: `The ${k} is a hex color such as ${k === 'ink' ? INK[theme] : CANVAS[theme]}; "${shown(value[k])}" is not one.` };
    out[k] = hex;
  }
  const { away, need } = SIDE[theme];
  for (const k of ['canvas', 'panel']) {
    const r = contrast(out[k], away);
    if (r < need) return { ok: false, reason: 'wrong_side', sentence: `A ${theme} theme's ${k} is ${theme}: ${out[k]} is ${ratioWords(r)} against ${away}, under the ${need}:1 that needs.` };
  }
  const grounds = surfaceGrounds(out, theme);
  const worst = Object.keys(TEXT_GROUNDS).reduce((w, t) => (contrast(out.ink, grounds[t]) < contrast(out.ink, grounds[w]) ? t : w));
  const r = contrast(out.ink, grounds[worst]);
  if (r < AA_TEXT) {
    const nearest = inkPassing(out, theme);
    return { ok: false, reason: 'low_contrast', sentence: `The ink ${out.ink} is ${ratioWords(r)} on the ${TEXT_GROUNDS[worst]} (${grounds[worst]}), under the ${AA_TEXT}:1 text needs. The nearest shade that passes is ${nearest}.`, nearest };
  }
  return { ok: true, surfaces: out };
}

/** Every token a theme's surfaces write. The second and muted inks and the state colours move only as far as they
 *  must to pass on every surface. */
export function surfaceVars(s, theme = 'dark') {
  const grounds = surfaceGrounds(s, theme);
  const on = Object.values(grounds);
  const out = {
    ...grounds,
    '--panel-3': mix(s.panel, s.ink, 0.1),
    '--line': mix(s.canvas, s.ink, 0.1),
    '--line-strong': mix(s.canvas, s.ink, 0.18),
    '--ink': s.ink,
    '--ink-2': passAll(mix(s.ink, s.canvas, 0.17), on),
    '--muted': passAll(mix(s.ink, s.canvas, 0.4), on),
    '--code-bg': theme === 'dark' ? mix(s.canvas, '#000000', 0.18) : mix(s.canvas, '#ffffff', 0.4),
    '--canvas-dot': rgbaOf(s.ink, theme === 'dark' ? 0.07 : 0.08),
  };
  for (const [k, hex] of Object.entries(STATES[theme])) {
    const c = passAll(hex, [grounds['--bg'], grounds['--panel'], grounds['--panel-2']]);
    out[`--${k}`] = c;
    out[`--${k}-soft`] = rgbaOf(c, theme === 'dark' ? 0.14 : 0.1);
  }
  return out;
}

/** The surfaces an accent is read on in a theme: the canvas alone, or on a look's surfaces the four it sits on. */
export function accentGrounds(appearance, theme = 'dark') {
  const s = appearance?.surfaces?.[theme];
  if (!s) return [{ name: 'canvas', hex: CANVAS[theme] }];
  const g = surfaceGrounds(s, theme);
  return ['--bg', '--panel', '--panel-2', '--field'].map((t) => ({ name: TEXT_GROUNDS[t], hex: g[t] }));
}

/**
 * Whether a colour can be the accent of a theme, read on grounds (default: the theme's canvas). { ok, hex, ratio,
 * sentence } when it passes; when it does not, { ok: false, reason: 'not_hex' | 'low_contrast', hex?, ratio?, nearest?,
 * sentence }: the sentence says the ratio on the surface it is closest to, which need it misses, and the nearest shade
 * that passes on all of them.
 */
export function accentCheck(value, theme = 'dark', grounds = null) {
  const hex = normHex(value);
  if (!hex) return { ok: false, reason: 'not_hex', sentence: `An accent is a hex color such as ${DEFAULT_ACCENT.dark}; "${shown(value)}" is not one.` };
  const on = grounds?.length ? grounds : [{ name: 'canvas', hex: CANVAS[theme] }];
  const worst = on.reduce((w, g) => (contrast(hex, g.hex) < contrast(hex, w.hex) ? g : w));
  const ratio = contrast(hex, worst.hex);
  if (ratio >= AA_TEXT) return { ok: true, hex, ratio, sentence: `${hex} is ${ratioWords(ratio)} against the ${theme} ${worst.name}.` };
  const nearest = passAll(hex, on.map((g) => g.hex));
  const misses = ratio >= AA_RING
    ? `enough for the focus ring (${AA_RING}:1) but not for text in the accent (${AA_TEXT}:1)`
    : `too close for the focus ring (${AA_RING}:1) and for text in the accent (${AA_TEXT}:1)`;
  return { ok: false, reason: 'low_contrast', hex, ratio, nearest, sentence: `${hex} is ${ratioWords(ratio)} against the ${theme} ${worst.name} (${worst.hex}): ${misses}. The nearest shade that passes is ${nearest}.` };
}

/** One picked colour as the accent of both themes: itself in the theme it was picked in, and in the other theme the
 *  nearest shade of it that passes there (on that theme's look surfaces, when appearance has them). The picked one is
 *  not checked here. */
export function accentPair(hex, theme = 'dark', appearance = {}) {
  const other = theme === 'dark' ? 'light' : 'dark';
  return { [theme]: hex, [other]: passAll(hex, accentGrounds(appearance, other).map((g) => g.hex)) };
}

/** What choosing a colour in a theme sends as the accent: the pair, or null when it is that theme's built-in (the
 *  studio's own accent is nothing stored, in both themes). */
export const accentPatch = (hex, theme = 'dark', appearance = {}) => (hex === DEFAULT_ACCENT[theme] ? null : accentPair(hex, theme, appearance));

/** The four tokens an accent writes in a theme: itself, its soft wash, the ink on a filled button, the focus ring. */
export function accentVars(hex, theme = 'dark', ink = INK[theme]) {
  const [r, g, b] = rgb(hex);
  const inks = ['#1c1a17', '#ffffff'];
  return {
    '--accent': hex,
    '--accent-soft': `rgba(${r}, ${g}, ${b}, ${theme === 'dark' ? 0.16 : 0.12})`,
    '--accent-ink': contrast(hex, inks[0]) >= contrast(hex, inks[1]) ? inks[0] : inks[1],
    '--focus': mix(hex, ink, 0.25), // toward the ink is away from the canvas: never less contrast than the accent
  };
}

// ---------- the stored choices ----------
/** What is stored, kept to what is valid and not the default: { accent?: { dark?, light? }, surfaces?: { dark?,
 *  light? }, display?, density?, textSize?, radius?, motion? }. A value that is no option, surfaces that do not pass,
 *  or an accent that does not pass on the surfaces of its theme, is left out. */
export function cleanAppearance(raw) {
  const out = {};
  if (!isMap(raw)) return out;
  if (isMap(raw.surfaces)) {
    const surfaces = {};
    for (const theme of THEMES) {
      const c = raw.surfaces[theme] == null ? null : surfaceCheck(raw.surfaces[theme], theme);
      if (c?.ok) surfaces[theme] = c.surfaces;
    }
    if (Object.keys(surfaces).length) out.surfaces = surfaces;
  }
  if (isMap(raw.accent)) {
    const accent = {};
    for (const theme of THEMES) {
      const c = raw.accent[theme] == null ? null : accentCheck(raw.accent[theme], theme, accentGrounds(out, theme));
      if (c?.ok && c.hex !== DEFAULT_ACCENT[theme]) accent[theme] = c.hex;
    }
    if (Object.keys(accent).length) out.accent = accent;
  }
  for (const key of CHOICE_KEYS) {
    if (typeof raw[key] === 'string' && Object.hasOwn(CONTROLS[key].options, raw[key]) && raw[key] !== CONTROLS[key].def) out[key] = raw[key];
  }
  return out;
}

/**
 * A patch as a route or a view sends it, checked against what is stored (an accent is judged on the surfaces it will
 * sit on). null resets every choice. Otherwise any of the keys: a choice's option, or null (or the default) for the
 * default; accent: { dark?, light? } with a hex per theme, or null; surfaces: { dark?, light? } with { canvas, panel,
 * ink } per theme, or null. Answers { ok: true, reset, patch } with null wherever a choice goes back to its default,
 * or { ok: false, code: 'invalid_input' | 'low_contrast', key, message }.
 */
export function checkAppearancePatch(body, stored = {}) {
  const bad = (message, key = null, code = 'invalid_input') => ({ ok: false, code, key, message });
  if (body === null) return { ok: true, reset: true, patch: {} };
  if (!isMap(body)) return bad(`appearance must be an object holding any of ${CONTROL_KEYS.join(', ')}, or null to reset them all`);
  const was = cleanAppearance(stored);
  const patch = {};
  // Surfaces first, whatever the order sent: an accent is judged on the surfaces it will sit on.
  const keys = Object.keys(body).sort((x, y) => (x === 'surfaces' ? -1 : y === 'surfaces' ? 1 : 0));
  const surfacesAfter = (theme) => (patch.surfaces === null ? null : isMap(patch.surfaces) && Object.hasOwn(patch.surfaces, theme) ? patch.surfaces[theme] : was.surfaces?.[theme] || null);
  const groundsAfter = (theme) => { const s = surfacesAfter(theme); return accentGrounds(s ? { surfaces: { [theme]: s } } : {}, theme); };
  for (const key of keys) {
    const value = body[key];
    if (!CONTROL_KEYS.includes(key)) return bad(`appearance.${shown(key)} is not a choice (${CONTROL_KEYS.join(', ')})`, null);
    if (THEMED_KEYS.includes(key)) {
      if (value === null) { patch[key] = null; continue; }
      if (!isMap(value)) return bad(key === 'accent' ? 'appearance.accent is { dark, light }: a hex color for a theme, or null for the built-in accent' : 'appearance.surfaces is { dark, light }: { canvas, panel, ink } for a theme, or null for the studio\'s own', key);
      const per = {};
      for (const [theme, v] of Object.entries(value)) {
        if (!THEMES.includes(theme)) return bad(`appearance.${key}.${shown(theme)} is not a theme (${THEMES.join(', ')})`, key);
        if (key === 'surfaces') {
          if (v === null) { per[theme] = null; continue; }
          const c = surfaceCheck(v, theme);
          if (!c.ok) return bad(c.sentence, key, c.reason === 'low_contrast' ? 'low_contrast' : 'invalid_input');
          per[theme] = c.surfaces;
          continue;
        }
        if (v === null || normHex(v) === DEFAULT_ACCENT[theme]) { per[theme] = null; continue; } // the built-in is nothing stored
        const c = accentCheck(v, theme, groundsAfter(theme));
        if (!c.ok) return bad(c.sentence, key, c.reason === 'low_contrast' ? 'low_contrast' : 'invalid_input');
        per[theme] = c.hex;
      }
      patch[key] = per;
      continue;
    }
    const { options, def } = CONTROLS[key];
    if (value === null) { patch[key] = null; continue; }
    if (typeof value !== 'string' || !Object.hasOwn(options, value)) return bad(`appearance.${key} must be one of ${Object.keys(options).join(', ')}, or null for the default (${def}); "${shown(value)}" is none of them`, key);
    patch[key] = value === def ? null : value;
  }
  // New surfaces under an accent already kept: that accent must still pass on them, or come with the patch.
  if (isMap(patch.surfaces)) {
    for (const theme of THEMES) {
      const kept = was.accent?.[theme];
      if (!patch.surfaces[theme] || !kept || patch.accent === null || (isMap(patch.accent) && Object.hasOwn(patch.accent, theme))) continue;
      const c = accentCheck(kept, theme, groundsAfter(theme));
      if (!c.ok) return bad(`Your ${theme} accent would not pass on these surfaces: ${c.sentence} Send an accent with them.`, 'accent', 'low_contrast');
    }
  }
  return { ok: true, reset: false, patch };
}

/** The stored choices after a checked patch. */
export function mergeAppearance(stored, { reset = false, patch = {} } = {}) {
  if (reset) return {};
  const next = { ...cleanAppearance(stored) };
  for (const [key, value] of Object.entries(patch)) {
    if (THEMED_KEYS.includes(key) && isMap(value)) {
      const per = { ...(next[key] || {}) };
      for (const [theme, v] of Object.entries(value)) { if (v === null) delete per[theme]; else per[theme] = v; }
      if (Object.keys(per).length) next[key] = per; else delete next[key];
    } else if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** The patch that brings the stored choices back to exactly before (Undo): every key named, null where before had none. */
export function restorePatch(before) {
  const b = cleanAppearance(before);
  return Object.fromEntries(CONTROL_KEYS.map((key) => [key, THEMED_KEYS.includes(key) ? Object.fromEntries(THEMES.map((t) => [t, b[key]?.[t] ?? null])) : b[key] ?? null]));
}

// ---------- fixed rules: the studio's locked defaults, and the person's layer on top ----------
// A fixed rule of the studio project that locks a token (--bg, --ink, --accent, --serif) holds the value the studio's
// source ships with: it binds a worker editing client/styles.css. The person's own look is a layer on top, for them
// only, so a lock never refuses or removes it (decision row 186); the screen says once where the look differs.
const lower = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** locked: [{ name, value, ruleId, text }] (server/lib/rules.mjs lockedTokens). The locked tokens the look sets to
 *  another value in this theme, each with yours: the value the look writes. */
export function lockDiffs(appearance, locked = [], theme = 'dark') {
  const vars = cssVars(appearance, theme);
  return (Array.isArray(locked) ? locked : []).filter((t) => t && Object.hasOwn(vars, t.name) && lower(vars[t.name]) !== lower(t.value))
    .map((t) => ({ name: t.name, value: t.value, ruleId: t.ruleId || null, text: t.text || '', yours: vars[t.name] }));
}

const listWords = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** The one plain line when the look differs from a locked default; '' when it does not. */
export function lockLine(diffs, projectName = '') {
  if (!diffs?.length) return '';
  const whose = projectName ? `${projectName}'s` : 'the studio\'s';
  return `Your look sets ${listWords(diffs.map((d) => d.name))} away from ${whose} locked default${diffs.length === 1 ? '' : 's'}. Those locks bind the studio's source code; your look is a layer on top, for you only.`;
}

// ---------- what reaches the page ----------
/** The custom properties to set on the root for the choices in effect, in one theme. A default writes nothing, so
 *  the stylesheet's own value stands; every token not in the answer is taken off (ALL_TOKENS). */
export function cssVars(appearance, theme = 'dark') {
  const a = cleanAppearance(appearance);
  const out = {};
  const s = a.surfaces?.[theme];
  if (s) Object.assign(out, surfaceVars(s, theme));
  if (a.accent?.[theme] || s) Object.assign(out, accentVars(accentOf(a, theme), theme, s?.ink || INK[theme]));
  for (const key of CHOICE_KEYS) if (a[key]) Object.assign(out, CONTROLS[key].options[a[key]].tokens);
  return out;
}

/** The accent a theme shows: the chosen one, else the studio's own (on a look's surfaces, its nearest shade that passes there). */
export function accentOf(appearance, theme = 'dark') {
  const a = cleanAppearance(appearance);
  if (a.accent?.[theme]) return a.accent[theme];
  return a.surfaces?.[theme] ? passAll(DEFAULT_ACCENT[theme], accentGrounds(a, theme).map((g) => g.hex)) : DEFAULT_ACCENT[theme];
}
/** A choice's option in effect. */
export const optionOf = (appearance, key) => cleanAppearance(appearance)[key] || CONTROLS[key].def;
/** Whether anything is off its default (Reset has something to do). */
export const isCustom = (appearance) => Object.keys(cleanAppearance(appearance)).length > 0;

/** Every text colour on every surface it sits on in a theme with a look's surfaces, with its ratio, lowest first:
 *  what the Studio look says when it states that every pair passes. No surfaces: no pairs. */
export function textPairs(appearance, theme = 'dark') {
  const s = cleanAppearance(appearance).surfaces?.[theme];
  if (!s) return [];
  const vars = cssVars(appearance, theme);
  const grounds = surfaceGrounds(s, theme);
  const pairs = [];
  for (const [t, words] of Object.entries(TEXT_INKS)) {
    for (const [g, gw] of Object.entries(TEXT_GROUNDS)) {
      if (t === '--accent' && g === '--seg-on') continue; // the accent's words never sit on the selected control's ground
      pairs.push({ text: t, ground: g, words: `${words} on the ${gw}`, fg: vars[t], bg: grounds[g], ratio: contrast(vars[t], grounds[g]) });
    }
  }
  return pairs.sort((x, y) => x.ratio - y.ratio);
}
