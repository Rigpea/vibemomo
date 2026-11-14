// Appearance (docs/ARCHITECTURE.md section 24, docs/DESIGN.md section 12): the pure parts of the person's own look
// for the studio. What can be chosen, the CSS custom properties of client/styles.css each choice writes, the contrast
// an accent must keep against the canvas, what a patch may hold, and what a fixed rule's locked token takes away.
// No DOM and no Node: the settings view draws with it, components/appearance.js applies it, and the server checks a
// patch with the same code (server/lib/appearance.mjs), so the screen and the route can never disagree.

export const THEMES = ['dark', 'light'];
/** --bg, --ink and --accent as client/styles.css holds them per theme (tests/appearance.test.mjs compares). */
export const CANVAS = { dark: '#232221', light: '#f3f1ec' };
export const INK = { dark: '#ece8e1', light: '#1f1c18' };
export const DEFAULT_ACCENT = { dark: '#d6a455', light: '#a86f17' };
/** WCAG 2.1 AA: text in the accent (links, the selected tab's words) 4.5:1; the focus ring, a non-text part, 3:1. */
export const AA_TEXT = 4.5;
export const AA_RING = 3;

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
/** Every token any control writes: what components/appearance.js sets or takes off the root element. */
export const ALL_TOKENS = [...new Set(CONTROL_KEYS.flatMap((k) => CONTROLS[k].tokens))];

// ---------- colour ----------
const shown = (v, max = 40) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
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

function toHsl(hex) {
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
function fromHsl(h, s, l) {
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

/** A ratio as it is said: one decimal, cut rather than rounded, so 4.46 never reads as a passing 4.5. */
export const ratioWords = (r) => `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;

/**
 * Whether a colour can be the accent of a theme. { ok, hex, ratio, sentence } when it passes; when it does not,
 * { ok: false, reason: 'not_hex' | 'low_contrast', hex?, ratio?, nearest?, sentence }: the sentence says the ratio,
 * which need it misses, and the nearest shade that passes.
 */
export function accentCheck(value, theme = 'dark') {
  const hex = normHex(value);
  if (!hex) return { ok: false, reason: 'not_hex', sentence: `An accent is a hex color such as ${DEFAULT_ACCENT.dark}; "${shown(value)}" is not one.` };
  const canvas = CANVAS[theme];
  const ratio = contrast(hex, canvas);
  if (ratio >= AA_TEXT) return { ok: true, hex, ratio, sentence: `${hex} is ${ratioWords(ratio)} against the ${theme} canvas.` };
  const nearest = nearestPassing(hex, canvas);
  const misses = ratio >= AA_RING
    ? `enough for the focus ring (${AA_RING}:1) but not for text in the accent (${AA_TEXT}:1)`
    : `too close for the focus ring (${AA_RING}:1) and for text in the accent (${AA_TEXT}:1)`;
  return { ok: false, reason: 'low_contrast', hex, ratio, nearest, sentence: `${hex} is ${ratioWords(ratio)} against the ${theme} canvas (${canvas}): ${misses}. The nearest shade that passes is ${nearest}.` };
}

/** One picked colour as the accent of both themes: itself in the theme it was picked in, and in the other theme the
 *  nearest shade of it that passes there. The picked one is not checked here. */
export function accentPair(hex, theme = 'dark') {
  const other = theme === 'dark' ? 'light' : 'dark';
  return { [theme]: hex, [other]: nearestPassing(hex, CANVAS[other]) };
}

/** What choosing a colour in a theme sends as the accent: the pair, or null when it is that theme's built-in (the
 *  studio's own accent is nothing stored, in both themes). */
export const accentPatch = (hex, theme = 'dark') => (hex === DEFAULT_ACCENT[theme] ? null : accentPair(hex, theme));

/** The four tokens an accent writes in a theme: itself, its soft wash, the ink on a filled button, the focus ring. */
export function accentVars(hex, theme = 'dark') {
  const [r, g, b] = rgb(hex);
  const inks = ['#1c1a17', '#ffffff'];
  return {
    '--accent': hex,
    '--accent-soft': `rgba(${r}, ${g}, ${b}, ${theme === 'dark' ? 0.16 : 0.12})`,
    '--accent-ink': contrast(hex, inks[0]) >= contrast(hex, inks[1]) ? inks[0] : inks[1],
    '--focus': mix(hex, INK[theme], 0.25), // toward the ink is away from the canvas: never less contrast than the accent
  };
}

// ---------- the stored choices ----------
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** What is stored, kept to what is valid and not the default: { accent?: { dark?, light? }, density?, textSize?,
 *  radius?, motion? }. A value that is no option, or an accent that no longer passes, is left out. */
export function cleanAppearance(raw) {
  const out = {};
  if (!isMap(raw)) return out;
  if (isMap(raw.accent)) {
    const accent = {};
    for (const theme of THEMES) {
      const c = raw.accent[theme] == null ? null : accentCheck(raw.accent[theme], theme);
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
 * A patch as a route or the view sends it, checked. null resets every choice. Otherwise any of the five keys: a
 * choice's option, or null (or the default) for the default; accent: { dark?, light? } with a hex per theme, or null.
 * Answers { ok: true, reset, patch } with null wherever a choice goes back to its default, or
 * { ok: false, code: 'invalid_input' | 'low_contrast', key, message }.
 */
export function checkAppearancePatch(body) {
  const bad = (message, key = null, code = 'invalid_input') => ({ ok: false, code, key, message });
  if (body === null) return { ok: true, reset: true, patch: {} };
  if (!isMap(body)) return bad(`appearance must be an object holding any of ${CONTROL_KEYS.join(', ')}, or null to reset them all`);
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!CONTROL_KEYS.includes(key)) return bad(`appearance.${shown(key)} is not a choice (${CONTROL_KEYS.join(', ')})`, null);
    if (key === 'accent') {
      if (value === null) { patch.accent = null; continue; }
      if (!isMap(value)) return bad('appearance.accent is { dark, light }: a hex color for a theme, or null for the built-in accent', key);
      const accent = {};
      for (const [theme, hex] of Object.entries(value)) {
        if (!THEMES.includes(theme)) return bad(`appearance.accent.${shown(theme)} is not a theme (${THEMES.join(', ')})`, key);
        if (hex === null || normHex(hex) === DEFAULT_ACCENT[theme]) { accent[theme] = null; continue; } // the built-in is nothing stored
        const c = accentCheck(hex, theme);
        if (!c.ok) return bad(c.sentence, key, c.reason === 'low_contrast' ? 'low_contrast' : 'invalid_input');
        accent[theme] = c.hex;
      }
      patch.accent = accent;
      continue;
    }
    const { options, def } = CONTROLS[key];
    if (value === null) { patch[key] = null; continue; }
    if (typeof value !== 'string' || !Object.hasOwn(options, value)) return bad(`appearance.${key} must be one of ${Object.keys(options).join(', ')}, or null for the default (${def}); "${shown(value)}" is none of them`, key);
    patch[key] = value === def ? null : value;
  }
  return { ok: true, reset: false, patch };
}

/** The controls a checked patch would move off their defaults: the ones a lock must be asked about. Taking a choice
 *  back to its default is never refused. */
export function patchSets(patch) {
  return CONTROL_KEYS.filter((key) => (key === 'accent' ? isMap(patch.accent) && Object.values(patch.accent).some((v) => v !== null) : patch[key] != null));
}

/** The stored choices after a checked patch. */
export function mergeAppearance(stored, { reset = false, patch = {} } = {}) {
  if (reset) return {};
  const next = { ...cleanAppearance(stored) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'accent' && isMap(value)) {
      const accent = { ...(next.accent || {}) };
      for (const [theme, hex] of Object.entries(value)) { if (hex === null) delete accent[theme]; else accent[theme] = hex; }
      if (Object.keys(accent).length) next.accent = accent; else delete next.accent;
    } else if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

// ---------- fixed rules ----------
/** locked: [{ name, value, ruleId, text }] from the studio project's rules (server/lib/rules.mjs lockedTokens).
 *  Answers the controls a lock takes away: { accent: { token, value, ruleId, text }, … }. A control is locked when a
 *  rule locks any token it writes. */
export function controlLocks(locked = []) {
  const out = {};
  for (const key of CONTROL_KEYS) {
    const hit = (locked || []).find((t) => CONTROLS[key].tokens.includes(t?.name));
    if (hit) out[key] = { token: hit.name, value: hit.value, ruleId: hit.ruleId || null, text: hit.text || '' };
  }
  return out;
}

/** The choices in effect: what is stored and valid, without any control a fixed rule locks. */
export function effectiveAppearance(stored, locks = {}) {
  const out = cleanAppearance(stored);
  for (const key of Object.keys(locks || {})) delete out[key];
  return out;
}

const quoted = (text, max = 90) => { const t = shown(text, 400); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
/** The sentence beside a locked control, and the route's refusal: which rule, which token, at which value. */
export function lockSentence(key, lock, projectName = '') {
  return `${CONTROLS[key].label} is fixed by ${projectName ? `${projectName}'s rule` : 'the rule'} "${quoted(lock.text)}", which locks ${lock.token} at ${lock.value}.`;
}

// ---------- what reaches the page ----------
/** The custom properties to set on the root for the choices in effect, in one theme. A default writes nothing, so
 *  the stylesheet's own value stands; every token not in the answer is taken off (ALL_TOKENS). */
export function cssVars(appearance, theme = 'dark') {
  const a = cleanAppearance(appearance);
  const out = {};
  if (a.accent?.[theme]) Object.assign(out, accentVars(a.accent[theme], theme));
  for (const key of CHOICE_KEYS) if (a[key]) Object.assign(out, CONTROLS[key].options[a[key]].tokens);
  return out;
}

/** The accent a theme shows: the chosen one, else the studio's own. */
export const accentOf = (appearance, theme = 'dark') => cleanAppearance(appearance).accent?.[theme] || DEFAULT_ACCENT[theme];
/** A choice's option in effect. */
export const optionOf = (appearance, key) => cleanAppearance(appearance)[key] || CONTROLS[key].def;
/** Whether anything is off its default (Reset has something to do). */
export const isCustom = (appearance) => Object.keys(cleanAppearance(appearance)).length > 0;
