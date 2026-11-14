// CSS as the Visualizer reads it (docs/ARCHITECTURE.md section 26): a scanner that walks a stylesheet's text and
// answers every declaration with the line it starts on, and the colour parts: what in a value is a colour, the same
// colour written two ways as one, and how far two colours are apart. Pure: no file access, no DOM, no dependency.
// It reads what is written. It does not run the cascade, so it cannot say which declaration wins on an element.

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Every declaration of a stylesheet, in source order: [{ prop, value, line, selector, at, important }].
 * line is where the declaration starts (1-based, plus lineOffset for a <style> block inside a page); selector is the
 * nearest enclosing rule's (a keyframe's `from` or `50%` inside @keyframes); at lists the enclosing at-rules, outermost
 * first (`@media (max-width: 1100px)`). imports: [{ href, line }] for every @import. Comments and strings are skipped
 * as such, and `;`, `{` and `}` inside parentheses belong to the value (a data URL).
 */
export function scanCss(text, { lineOffset = 0 } = {}) {
  const decls = [];
  const imports = [];
  const stack = []; // enclosing blocks: { prelude, at }
  const src = String(text ?? '');
  let line = 1 + lineOffset;
  let buf = '';
  let bufLine = line;
  let depth = 0; // parentheses
  const reset = () => { buf = ''; depth = 0; };
  const statement = () => {
    const s = squash(buf);
    const startLine = bufLine;
    reset();
    if (!s) return;
    if (s.startsWith('@')) {
      const m = s.match(/^@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s)"']+))/i);
      if (m) imports.push({ href: m[1] ?? m[2] ?? m[3], line: startLine });
      return;
    }
    if (!stack.length) return; // a declaration outside any block is not CSS
    const colon = s.indexOf(':');
    if (colon < 1) return;
    const rawProp = s.slice(0, colon).trim();
    if (!/^(--[\w-]+|-?[a-z][a-z0-9-]*)$/i.test(rawProp)) return;
    let value = s.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, '').trim();
    if (!value) return;
    const rule = [...stack].reverse().find((b) => !b.at);
    decls.push({
      prop: rawProp.startsWith('--') ? rawProp : rawProp.toLowerCase(),
      value,
      line: startLine,
      selector: rule ? rule.prelude.slice(0, 200) : '',
      at: stack.filter((b) => b.at).map((b) => b.prelude.slice(0, 200)),
      important,
    });
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '*') { // a comment: gone, its lines counted
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let j = i; j < stop; j++) if (src[j] === '\n') line++;
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'") { // a string: copied whole
      if (!buf.trim()) bufLine = line;
      let j = i + 1;
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\') j++; if (src[j] === '\n') line++; j++; }
      buf += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '\n') { line++; buf += ' '; continue; }
    if (ch === '(') { depth++; buf += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (depth === 0 && ch === '{') {
      const prelude = squash(buf);
      reset();
      stack.push({ prelude, at: prelude.startsWith('@') });
      continue;
    }
    if (depth === 0 && ch === '}') { statement(); stack.pop(); continue; }
    if (depth === 0 && ch === ';') { statement(); continue; }
    if (!buf.trim() && ch.trim()) bufLine = line;
    buf += ch;
  }
  statement(); // a file that ends inside a block: its last declaration is still one
  return { decls, imports, lines: line - lineOffset - (src.endsWith('\n') ? 1 : 0) };
}

// ---------- values ----------
/** The index of the parenthesis that closes the one at open, or -1. Quotes hide what is inside them. */
export function closeOf(s, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** A value cut at the top level (outside parentheses and quotes) on spaces (sep ' '), commas (',') or slashes ('/'). */
export function splitTop(value, sep = ' ') {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (const ch of String(value ?? '')) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The custom properties a value reads: every `var(--name` in it, in order (a name twice when read twice). */
export const varsIn = (value) => [...String(value ?? '').matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);

/**
 * A value with every var(--name) replaced by what lookup(name) answers (a string, or null when the name is not set),
 * else by the fallback written in the var(), else left as it is. Goes at most 8 deep, so a loop of tokens ends.
 */
export function resolveVars(value, lookup, depth = 0) {
  let s = String(value ?? '');
  if (depth > 8) return s;
  for (let at = s.indexOf('var('); at >= 0; at = s.indexOf('var(', at)) {
    const end = closeOf(s, at + 3);
    if (end < 0) break;
    const inner = s.slice(at + 4, end);
    const comma = splitTop(inner, ',');
    const name = (comma[0] || '').trim();
    const found = lookup(name);
    const fallback = comma.length > 1 ? inner.slice(inner.indexOf(',') + 1).trim() : null;
    const put = found != null ? resolveVars(found, lookup, depth + 1) : fallback != null ? resolveVars(fallback, lookup, depth + 1) : null;
    if (put == null) { at = end + 1; continue; }
    s = s.slice(0, at) + put + s.slice(end + 1);
    at += put.length;
  }
  return s;
}

/**
 * A sum of lengths worked out: calc(), min() and max() over px and rem (rem times rootPx) and plain numbers, with
 * + - * / and parentheses, as px rounded to hundredths. null for anything it cannot be sure of: another unit, a
 * percentage, a var() left unread, clamp(), env().
 */
export function evalLength(text, rootPx = 16) {
  const s = String(text ?? '').trim().toLowerCase();
  let i = 0;
  const ws = () => { while (s[i] === ' ') i++; };
  const fail = () => { throw new Error('not a sum of lengths'); };
  function atom() {
    ws();
    if (s[i] === '(') { i++; const v = sum(); ws(); if (s[i++] !== ')') fail(); return v; }
    const fn = s.slice(i).match(/^(calc|min|max)\(/);
    if (fn) {
      i += fn[0].length;
      const args = [sum()];
      for (ws(); s[i] === ','; ws()) { i++; args.push(sum()); }
      if (s[i++] !== ')') fail();
      if (fn[1] === 'calc') { if (args.length !== 1) fail(); return args[0]; }
      if (args.some((a) => a.len !== args[0].len)) fail();
      return { n: Math[fn[1]](...args.map((a) => a.n)), len: args[0].len };
    }
    const m = s.slice(i).match(/^([-+]?(?:\d*\.)?\d+)(px|rem)?(?![\w%.])/);
    if (!m) fail();
    i += m[0].length;
    return { n: parseFloat(m[1]) * (m[2] === 'rem' ? rootPx : 1), len: !!m[2] };
  }
  function product() {
    let a = atom();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== '*' && op !== '/') return a;
      i++;
      const b = atom();
      if (op === '*') { if (a.len && b.len) fail(); a = { n: a.n * b.n, len: a.len || b.len }; } else { if (b.len || !b.n) fail(); a = { n: a.n / b.n, len: a.len }; }
    }
  }
  function sum() {
    let a = product();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== '+' && op !== '-') return a;
      i++;
      const b = product();
      if (a.len !== b.len) fail();
      a = { n: op === '+' ? a.n + b.n : a.n - b.n, len: a.len };
    }
  }
  try {
    const v = sum();
    ws();
    return i === s.length && v.len && Number.isFinite(v.n) ? Math.round(v.n * 100) / 100 : null;
  } catch { return null; }
}

// ---------- colours ----------
const NAMED = Object.fromEntries(('aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32')
  .split(' ').reduce((pairs, word, i, all) => (i % 2 ? pairs : [...pairs, [word, all[i + 1]]]), []));
const NAMED_RE = new RegExp(`(?<![\\w#.-])(${Object.keys(NAMED).join('|')})(?![\\w(-])`, 'gi');

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const byte = (n) => clamp(Math.round(n), 0, 255);
const num = (s, scale = 1) => (/%$/.test(s) ? (parseFloat(s) / 100) * scale : parseFloat(s));
const alphaOf = (s) => (s == null ? 1 : clamp(/%$/.test(s) ? parseFloat(s) / 100 : parseFloat(s), 0, 1));

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => byte((v + m) * 255));
}

/**
 * One colour as { r, g, b, a } (0 to 255, a 0 to 1), or null for what is no colour or one this reader cannot turn
 * into sRGB (oklch(), lab(), color-mix() and the like, anything holding a var()). A hex of 3, 4, 6 or 8 digits,
 * rgb() and hsl() in both spellings, the named colours and `transparent`.
 */
export function parseColor(value) {
  const v = String(value ?? '').trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return { r, g, b, a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1 };
  }
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (Object.hasOwn(NAMED, v)) return parseColor(`#${NAMED[v]}`);
  const fn = v.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!fn || /var\(|calc\(|from /.test(fn[2])) return null;
  const [main, slash] = fn[2].split('/').map((s) => s.trim());
  const parts = main.split(/[\s,]+/).filter(Boolean);
  const alpha = slash ?? (parts.length === 4 ? parts[3] : null);
  if (parts.length < 3 || parts.slice(0, 3).some((p) => !/^[-+]?(\d*\.)?\d+(%|deg)?$/.test(p)) || (alpha != null && !/^[-+]?(\d*\.)?\d+%?$/.test(alpha))) return null;
  const a = Math.round(alphaOf(alpha) * 1000) / 1000;
  if (fn[1].startsWith('rgb')) { const [r, g, b] = parts.slice(0, 3).map((p) => byte(num(p, 255))); return { r, g, b, a }; }
  const [r, g, b] = hslToRgb(parseFloat(parts[0]), clamp(num(parts[1], 1), 0, 1), clamp(num(parts[2], 1), 0, 1));
  return { r, g, b, a };
}

const hex2 = (n) => n.toString(16).padStart(2, '0');
/** '#rrggbb' of a parsed colour, its alpha aside. */
export const hexOf = (c) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
/** One spelling per colour, so the same colour written two ways counts as one: '#rrggbb', or 'rgba(r, g, b, a)' when
 *  it lets the surface through. */
export const canonColor = (c) => (c.a >= 1 ? hexOf(c) : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`);

const COLOR_FN = /#[0-9a-f]{3,8}(?![\w-])|(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\(/gi;
/** Text and addresses hold no colours: what is inside quotes and url() is blanked, the length kept. */
const masked = (value) => String(value ?? '').replace(/"[^"]*"|'[^']*'/g, (m) => ' '.repeat(m.length)).replace(/url\([^)]*\)/gi, (m) => ' '.repeat(m.length));

/**
 * The colours written out in a value, in order: [{ raw, color, canon }]. color is null for a colour function this
 * reader cannot turn into sRGB; its canon is then the text as written, lower case. A function holding a var() is
 * not a written colour, but a colour written inside it is found. named: also the colour names (only where the
 * property takes a colour, since `red` is also a word).
 */
export function colorsIn(value, { named = false } = {}) {
  const s = masked(value);
  const out = [];
  const spans = [];
  COLOR_FN.lastIndex = 0;
  for (let m = COLOR_FN.exec(s); m; m = COLOR_FN.exec(s)) {
    if (m[0][0] === '#') {
      const color = parseColor(m[0]);
      if (color) { out.push({ at: m.index, raw: m[0], color, canon: canonColor(color) }); spans.push([m.index, m.index + m[0].length]); }
      continue;
    }
    const end = closeOf(s, m.index + m[0].length - 1);
    if (end < 0) break;
    const raw = s.slice(m.index, end + 1);
    if (/var\(/.test(raw)) continue; // not written out; the scan goes on inside it
    const color = parseColor(raw);
    out.push({ at: m.index, raw, color, canon: color ? canonColor(color) : squash(raw).toLowerCase() });
    spans.push([m.index, end + 1]);
    COLOR_FN.lastIndex = end + 1;
  }
  if (named) {
    NAMED_RE.lastIndex = 0;
    for (let m = NAMED_RE.exec(s); m; m = NAMED_RE.exec(s)) {
      if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      if (/--[\w-]*$/.test(s.slice(0, m.index))) continue; // the tail of a custom property's name
      const color = parseColor(m[0]);
      out.push({ at: m.index, raw: m[0].toLowerCase(), color, canon: canonColor(color) });
    }
  }
  return out.sort((a, b) => a.at - b.at).map(({ raw, color, canon }) => ({ raw, color, canon }));
}

/** A value that is one colour and nothing else: { raw, color, canon }, or null. */
export function wholeColor(value) {
  const v = squash(String(value ?? ''));
  const found = colorsIn(v, { named: true });
  return found.length === 1 && found[0].raw.length === v.length ? found[0] : null;
}

// ---------- distance ----------
const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
/** OKLab of an sRGB colour, as [L, a, b]. */
export function oklab({ r, g, b }) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const sub = (p, q) => p.map((v, i) => v - q[i]);
const dot = (p, q) => p.reduce((sum, v, i) => sum + v * q[i], 0);
/** How far two colours are apart: the OKLab distance times 100 (about 2 is the least the eye tells apart). Alpha aside. */
export const colorDistance = (c1, c2) => Math.sqrt(dot(sub(oklab(c1), oklab(c2)), sub(oklab(c1), oklab(c2)))) * 100;

/**
 * How far a colour is from a set of reference colours, counting every blend of two of them as one of them: the
 * least distance to a reference or to the straight line between two (in OKLab, times 100). The greys between a dark
 * canvas and a light ink are then near the two, while a hue neither holds is far. Infinity with no references.
 */
export function distanceToPalette(color, refs) {
  const p = oklab(color);
  const pts = refs.map(oklab);
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    best = Math.min(best, Math.hypot(...sub(p, pts[i])));
    for (let j = i + 1; j < pts.length; j++) {
      const ab = sub(pts[j], pts[i]);
      const len = dot(ab, ab);
      if (!len) continue;
      const t = clamp(dot(sub(p, pts[i]), ab) / len, 0, 1);
      best = Math.min(best, Math.hypot(...sub(p, pts[i].map((v, k) => v + ab[k] * t))));
    }
  }
  return best * 100;
}
