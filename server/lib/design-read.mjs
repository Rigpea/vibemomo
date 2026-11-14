// The design system a project's stylesheets really hold (docs/ARCHITECTURE.md section 26): from the declarations
// server/lib/css-scan.mjs found, the colours (custom properties and written-out ones, by what they are used for, with
// the count of places), the font families and sizes, the spacing and radius values, the durations and easings; then
// what the fixed rules lock, checked against what the files set, and what drifts: a colour far from every colour on
// the inspiration board, and a value written out in one place only. Pure: the caller reads the files and the records.
// Every value keeps the places it was read from as { file, line, scope, prop }.
import { splitTop, varsIn, resolveVars, evalLength, colorsIn, wholeColor, hexOf, colorDistance, distanceToPalette } from './css-scan.mjs';

/** A colour further than this from every board colour and every blend of two (OKLab distance × 100) is "far". */
export const FAR = 8;
/** Under this a board colour counts as being in the stylesheets as it is. */
export const EXACT = 1;
/** The places kept per value; its count is always the whole number. */
export const PLACES_MAX = 40;
export const COLOR_USES = ['surface', 'text', 'line', 'effect', 'unused'];

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const COLOR_PROPS = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|inline|block)(-(start|end))?)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|scrollbar-color|-webkit-text-fill-color|-webkit-tap-highlight-color|stop-color|flood-color)$/;
const SPACING_PROPS = /^((margin|padding)(-(top|right|bottom|left|inline|block)(-(start|end))?)?|(grid-)?(row-|column-)?gap)$/;
const RADIUS_PROPS = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
const CONDITIONAL = /^@(media|supports|container)\b/i;
const GENERIC_FAMILY = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji)$/i;
const EASING_WORDS = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };

/** What a colour is used for, from the property that holds it. */
export function colorUse(prop) {
  if (prop.startsWith('--')) return 'token';
  if (/^background/.test(prop)) return 'surface';
  if (/^(color|caret-color|-webkit-text-fill-color|text-decoration)/.test(prop)) return 'text';
  if (/^(border|outline|column-rule)/.test(prop)) return 'line';
  return 'effect';
}

/** Where a declaration stands, in words: its at-rules, then its selector. */
export const scopeOf = (d) => squash([...(d.at || []), d.selector || ''].join(' '));
const placeOf = (d) => ({ file: d.file, line: d.line, scope: scopeOf(d), prop: d.prop });

/** Values counted with their places: add(key, place, { token }) once per place; a value read through a custom
 *  property names that property, one written out counts as literal. */
function tally() {
  const map = new Map();
  return {
    add(key, place, { token = null, more = null } = {}) {
      let e = map.get(key);
      if (!e) map.set(key, (e = { key, count: 0, literal: 0, tokens: [], places: [], ...(more || {}) }));
      e.count++;
      if (token) { if (!e.tokens.includes(token)) e.tokens.push(token); } else e.literal++;
      if (e.places.length < PLACES_MAX) e.places.push(place);
      return e;
    },
    values: () => [...map.values()],
  };
}
/** Written out, in one place only. A value that comes through a custom property is part of the system, not a one-off. */
const once = (e) => e.count === 1 && e.literal === 1;
const drifts = (e, far = false) => [once(e) ? 'once' : null, far ? 'far' : null].filter(Boolean);
/** A length's drift. A sum this reader could not work out (a clamp(), an env()) is shown as written and not judged. */
const lengthDrift = (e) => (/^(clamp|calc|min|max)\(/i.test(e.key) ? [] : drifts(e));

/** A length as px ({ px }) for px and rem, as written ({ rel }) for em, % and a function; null for anything else. */
function lengthOf(text, rootPx = 16) {
  const t = String(text ?? '').trim().toLowerCase();
  const m = t.match(/^([-+]?(?:\d*\.)?\d+)(px|rem|em|%)$/);
  if (m) {
    const n = Math.abs(parseFloat(m[1]));
    if (m[2] === 'px') return { px: n };
    if (m[2] === 'rem') return { px: Math.round(n * rootPx * 100) / 100 };
    return { rel: `${n}${m[2]}` };
  }
  if (/^(clamp|calc|min|max)\(/.test(t)) return { rel: squash(text) };
  return null;
}
const timeOf = (text) => { const m = String(text ?? '').trim().toLowerCase().match(/^((?:\d*\.)?\d+)(ms|s)$/); return m ? Math.round(parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) * 100) / 100 : null; };

function easingOf(text) {
  const t = squash(text).toLowerCase();
  if (Object.hasOwn(EASING_WORDS, t)) return { key: t, curve: EASING_WORDS[t], steps: null };
  if (t === 'step-start' || t === 'step-end') return { key: t, curve: null, steps: 1 };
  const bez = t.match(/^cubic-bezier\(([^)]*)\)$/);
  if (bez) {
    const n = bez[1].split(',').map((x) => parseFloat(x));
    if (n.length === 4 && n.every(Number.isFinite)) return { key: `cubic-bezier(${n.join(', ')})`, curve: n, steps: null };
  }
  const st = t.match(/^steps\(\s*(\d+)/);
  if (st) return { key: t.replace(/\s*,\s*/g, ', '), curve: null, steps: Number(st[1]) };
  if (/^linear\(/.test(t)) return { key: t.replace(/\s*,\s*/g, ', '), curve: null, steps: null };
  return null;
}

/** Two values of one property as the same value: two spellings of one colour, or the same text but for case, spaces
 *  and the kind of quote. */
export function sameValue(a, b) {
  const [ca, cb] = [wholeColor(a), wholeColor(b)];
  if (ca?.color && cb?.color) return ca.canon === cb.canon;
  const norm = (s) => squash(s).toLowerCase().replace(/'/g, '"').replace(/\s*,\s*/g, ', ');
  return norm(a) === norm(b);
}

/**
 * Read the design. sheets: [{ file, decls }] in the order the page loads them (decls from scanCss);
 * rules: the project's fixed rules; boardColors: the board's colour cards as [{ id, hex, name }].
 */
export function readDesign(sheets, { rules = [], boardColors = [] } = {}) {
  const decls = sheets.flatMap((s) => s.decls.map((d) => ({ ...d, file: s.file })));

  // ---------- custom properties: every definition, and every place one is read ----------
  const tokens = new Map();
  for (const d of decls) {
    if (!d.prop.startsWith('--') || d.at.some((a) => /^@font-face/i.test(a))) continue;
    if (!tokens.has(d.prop)) tokens.set(d.prop, { name: d.prop, defs: [], uses: 0, usesBy: {}, places: [] });
    tokens.get(d.prop).defs.push({ value: d.value, file: d.file, line: d.line, scope: scopeOf(d), conditional: d.at.some((a) => CONDITIONAL.test(a)) });
  }
  for (const t of tokens.values()) {
    t.base = t.defs.find((x) => !x.conditional) || t.defs[0]; // what holds where no condition does
    t.base.base = true;
  }
  const lookup = (name) => tokens.get(name)?.base.value ?? null;
  for (const d of decls) {
    for (const name of varsIn(d.value)) {
      const t = tokens.get(name);
      if (!t) continue;
      t.uses++;
      const use = colorUse(d.prop);
      t.usesBy[use] = (t.usesBy[use] || 0) + 1;
      if (t.places.length < PLACES_MAX) t.places.push(placeOf(d));
    }
  }
  // The size rem counts from: what the page's root sets in px, else the browsers' 16.
  const rootDecl = decls.find((d) => /(^|[\s,])(:root|html)([\s,]|$)/.test(d.selector) && !d.at.length && (d.prop === 'font-size' || d.prop === 'font') && /(^|\s)(\d*\.)?\d+px/.test(resolveVars(d.value, lookup)));
  const rootPx = rootDecl ? parseFloat(resolveVars(rootDecl.value, lookup).match(/(?:^|\s)((?:\d*\.)?\d+)px/)[1]) : 16;
  /** One part of a value: what it comes to once its custom properties are read, and the property it is, if it is one. */
  const readPart = (part) => {
    const m = part.match(/^var\(\s*(--[\w-]+)\s*(,[\s\S]*)?\)$/);
    if (/^(clamp|calc|min|max)\(/i.test(part)) {
      // A sum of lengths is worked out (calc(var(--s2) * -1) is 8px); one that cannot be is shown as it is written.
      const px = evalLength(resolveVars(part, lookup), rootPx);
      if (px == null) return { text: part, token: null };
      // It stays a value of the scale when it is one custom property's own length, negated or not.
      const names = varsIn(part);
      const own = names.length === 1 ? lengthOf(resolveVars(`var(${names[0]})`, lookup), rootPx)?.px : null;
      return { text: `${Math.abs(px)}px`, token: own === Math.abs(px) ? names[0] : null };
    }
    return { text: /var\(/.test(part) ? resolveVars(part, lookup).trim() : part, token: m ? m[1] : null };
  };
  /** Where a value is at home: the definition of the custom property it comes through, else the first place it is written. */
  const homeOf = (e) => {
    const b = e.tokens.length ? tokens.get(e.tokens[0])?.base : null;
    return b ? { file: b.file, line: b.line } : e.places[0] ? { file: e.places[0].file, line: e.places[0].line } : null;
  };
  /** The parts of a value cut on spaces, a custom property that holds several parts opened into them. */
  const partsOf = (value) => splitTop(value, ' ').flatMap((raw) => { const p = readPart(raw); return p.token ? splitTop(p.text, ' ').map((text) => ({ text, token: p.token })) : [p]; });

  // ---------- colours ----------
  const refs = boardColors.map((c) => ({ ...c, color: wholeColor(c.hex)?.color })).filter((c) => c.color);
  const palette = refs.map((c) => c.color);
  const farOf = (color) => {
    if (!palette.length || !color || color.a === 0) return { distance: null, far: false };
    const distance = Math.round(distanceToPalette(color, palette) * 10) / 10;
    return { distance, far: distance > FAR };
  };
  const USES = ['surface', 'text', 'line', 'effect'];
  const dominant = (by) => USES.reduce((best, k) => ((by[k] || 0) > (by[best] || 0) ? k : best), 'surface');
  const colorTokens = [];
  for (const t of tokens.values()) {
    const defs = t.defs.map((def) => ({ def, found: wholeColor(resolveVars(def.value, lookup)) }));
    const base = defs.find((x) => x.def === t.base).found;
    if (!base) continue; // not a colour where no condition holds
    colorTokens.push({
      kind: 'token', name: t.name,
      // read only by other custom properties: an effect, since nothing here says what for
      use: !t.uses ? 'unused' : USES.some((k) => t.usesBy[k]) ? dominant(t.usesBy) : 'effect',
      count: t.uses, usesBy: { ...t.usesBy }, places: t.places, home: { file: t.base.file, line: t.base.line },
      defs: defs.filter((x) => x.found).map(({ def, found }) => ({
        value: def.value, canon: found.canon, hex: found.color ? hexOf(found.color) : null, alpha: found.color ? found.color.a : null,
        scope: def.scope, file: def.file, line: def.line, base: !!def.base, ...farOf(found.color),
      })),
      drift: farOf(base.color).far ? ['far'] : [],
    });
  }
  const colorNames = new Set(colorTokens.map((t) => t.name));
  const literalTally = tally();
  for (const d of decls) {
    const isToken = d.prop.startsWith('--');
    if (isToken && colorNames.has(d.prop) && wholeColor(d.value)) continue; // a colour token's own definition: its swatch, not a literal
    for (const found of colorsIn(d.value, { named: !isToken && COLOR_PROPS.test(d.prop) })) {
      if (found.color && found.color.a === 0) continue; // transparent is the absence of a colour
      const e = literalTally.add(found.canon, placeOf(d), { more: { color: found.color, usesBy: {} } });
      const use = isToken ? 'effect' : colorUse(d.prop);
      e.usesBy[use] = (e.usesBy[use] || 0) + 1;
    }
  }
  const tokenByCanon = new Map();
  for (const t of colorTokens) { const b = t.defs.find((x) => x.base); if (b && !tokenByCanon.has(b.canon)) tokenByCanon.set(b.canon, t.name); }
  const literals = literalTally.values().map((e) => {
    const f = e.color ? farOf(e.color) : { distance: null, far: false };
    return {
      kind: 'literal', value: e.key, canon: e.key, hex: e.color ? hexOf(e.color) : null, alpha: e.color ? e.color.a : null,
      use: dominant(e.usesBy),
      count: e.count, usesBy: e.usesBy, places: e.places, home: homeOf(e), distance: f.distance, twin: tokenByCanon.get(e.key) || null, drift: drifts(e, f.far),
    };
  });
  const colors = [...colorTokens.sort((a, b) => b.count - a.count), ...literals.sort((a, b) => b.count - a.count)];

  // ---------- type ----------
  const faces = new Set(decls.filter((d) => d.prop === 'font-family' && d.at.some((a) => /^@font-face/i.test(a))).map((d) => squash(d.value).replace(/^["']|["']$/g, '').toLowerCase()));
  const sizeTally = tally();
  const familyTally = tally();
  const addSize = (part, d) => {
    const len = lengthOf(part.text, rootPx);
    if (!len) return false;
    if (len.px === 0) return true;
    sizeTally.add(len.px != null ? `${len.px}px` : len.rel, placeOf(d), { token: part.token, more: { px: len.px ?? null } });
    return true;
  };
  let baseStack = null; // the family the page's root or body sets: what the type scale is drawn in
  const addFamily = (raw, d, token = null) => {
    const p = token ? { text: resolveVars(raw, lookup), token } : readPart(squash(raw));
    const stack = splitTop(p.text, ',').map(squash).join(', ');
    if (!stack || /^(inherit|initial|unset|revert|revert-layer)$/i.test(stack) || /var\(/.test(stack)) return;
    familyTally.add(stack, placeOf(d), { token: p.token });
    if (!baseStack && !d.at.length && /(^|[\s,])(:root|html|body)([\s,]|$)/.test(d.selector)) baseStack = stack;
  };
  /** The font shorthand: the first part that is a size (before its /line-height) and, after it, the family. */
  const readFont = (value, d, token = null) => {
    const raw = splitTop(value, ' ');
    for (let i = 0; i < raw.length; i++) {
      const head = readPart(splitTop(raw[i], '/')[0] || '');
      if (!lengthOf(head.text, rootPx)) continue;
      addSize({ text: head.text, token: head.token || token }, d);
      const family = raw.slice(i + 1).join(' ');
      if (family) addFamily(family, d, token && !/^var\(/.test(family) ? token : null);
      return;
    }
    const one = raw.length === 1 ? readPart(raw[0]) : null; // a custom property that holds the whole shorthand
    if (one?.token && !token && one.text !== raw[0]) readFont(one.text, d, one.token);
  };
  for (const d of decls) {
    if (d.prop.startsWith('--') || d.at.some((a) => /^@font-face/i.test(a))) continue;
    if (d.prop === 'font-size') addSize(readPart(d.value), d);
    else if (d.prop === 'font-family') addFamily(d.value, d);
    else if (d.prop === 'font') readFont(d.value, d);
  }
  // A custom property that holds a font stack and is read nowhere is still a family the files name.
  for (const t of tokens.values()) {
    const items = splitTop(resolveVars(t.base.value, lookup), ',').map(squash);
    if (t.uses || items.length < 2 || !items.some((x) => GENERIC_FAMILY.test(x))) continue;
    const e = familyTally.add(items.join(', '), { file: t.base.file, line: t.base.line, scope: t.base.scope, prop: t.name }, { token: t.name });
    e.count--; // defined, not used
  }
  const firstOf = (stack) => (splitTop(stack, ',')[0] || '').replace(/^["']|["']$/g, '');
  // A family set once on the page's root is the whole design, not a one-off: families never drift by count.
  const families = familyTally.values().map((e) => ({ value: e.key, first: firstOf(e.key), count: e.count, tokens: e.tokens, places: e.places, home: homeOf(e), webfont: faces.has(firstOf(e.key).toLowerCase()), drift: [] }))
    .sort((a, b) => b.count - a.count);
  const sizes = sizeTally.values().map((e) => ({ value: e.key, px: e.px, count: e.count, tokens: e.tokens, places: e.places, home: homeOf(e), drift: lengthDrift(e) }))
    .sort((a, b) => (b.px ?? -1) - (a.px ?? -1) || b.count - a.count);

  // ---------- spacing and radii ----------
  const spaceTally = tally();
  const radiusTally = tally();
  for (const d of decls) {
    if (d.prop.startsWith('--')) continue;
    if (SPACING_PROPS.test(d.prop)) {
      for (const part of partsOf(d.value)) {
        const len = lengthOf(part.text, rootPx);
        if (!len || len.px === 0 || /^0(%|em)$/.test(len.rel || '')) continue;
        spaceTally.add(len.px != null ? `${len.px}px` : len.rel, placeOf(d), { token: part.token, more: { px: len.px ?? null } });
      }
    } else if (RADIUS_PROPS.test(d.prop)) {
      for (const part of partsOf(d.value).flatMap((p) => splitTop(p.text, '/').map((text) => ({ text, token: p.token })))) {
        const len = lengthOf(part.text, rootPx);
        if (!len || len.px === 0 || /^0(%|em)$/.test(len.rel || '')) continue;
        radiusTally.add(len.px != null ? `${len.px}px` : len.rel, placeOf(d), { token: part.token, more: { px: len.px ?? null } });
      }
    }
  }
  const scale = (t) => t.values().map((e) => ({ value: e.key, px: e.px, count: e.count, tokens: e.tokens, places: e.places, home: homeOf(e), drift: lengthDrift(e) }))
    .sort((a, b) => (a.px ?? Infinity) - (b.px ?? Infinity) || a.value.localeCompare(b.value));
  const spacing = scale(spaceTally);
  const radii = scale(radiusTally);

  // ---------- motion ----------
  const durationTally = tally();
  const easingTally = tally();
  const addEasing = (part, d) => { const e = easingOf(part.text); if (e) easingTally.add(e.key, placeOf(d), { token: part.token, more: { curve: e.curve, steps: e.steps } }); return !!e; };
  const addDuration = (part, d) => { const ms = timeOf(part.text); if (ms) durationTally.add(`${ms}ms`, placeOf(d), { token: part.token, more: { ms } }); };
  for (const d of decls) {
    if (d.prop.startsWith('--')) continue;
    if (d.prop === 'transition' || d.prop === 'animation') {
      for (const item of splitTop(d.value, ',')) {
        let timed = false;
        for (const part of partsOf(item)) {
          if (timeOf(part.text) != null) { if (!timed) addDuration(part, d); timed = true; } // the second time is the delay
          else addEasing(part, d);
        }
      }
    } else if (d.prop === 'transition-duration' || d.prop === 'animation-duration') {
      for (const item of splitTop(d.value, ',')) addDuration(readPart(item), d);
    } else if (d.prop === 'transition-timing-function' || d.prop === 'animation-timing-function') {
      for (const item of splitTop(d.value, ',')) addEasing(readPart(item), d);
    }
  }
  const durations = durationTally.values().map((e) => ({ value: e.key, ms: e.ms, count: e.count, tokens: e.tokens, places: e.places, home: homeOf(e), drift: drifts(e) })).sort((a, b) => a.ms - b.ms);
  const easings = easingTally.values().map((e) => ({ value: e.key, curve: e.curve, steps: e.steps, count: e.count, tokens: e.tokens, places: e.places, home: homeOf(e), drift: drifts(e) })).sort((a, b) => b.count - a.count);

  // ---------- what the fixed rules lock, against what the files set ----------
  const locks = {};
  const checked = rules.map((r) => {
    if (!r.token) return { id: r.id, kind: r.kind, text: r.text, why: r.why || '', token: null, check: null };
    const t = tokens.get(r.token.name);
    let check;
    if (!t) check = { state: 'missing', defs: [] };
    else {
      const defs = t.defs.map((def) => ({ value: def.value, scope: def.scope, file: def.file, line: def.line, base: !!def.base, same: sameValue(def.value, r.token.value) || sameValue(resolveVars(def.value, lookup), r.token.value) }));
      const base = defs.find((x) => x.base);
      check = { state: !base.same ? 'breaks' : defs.every((x) => x.same) ? 'matches' : 'varies', defs };
    }
    locks[r.token.name] = { ruleId: r.id, text: r.text, value: r.token.value, state: check.state };
    return { id: r.id, kind: r.kind, text: r.text, why: r.why || '', token: { ...r.token }, check };
  });

  // ---------- the board's colours, against what the files hold ----------
  const held = [
    ...colorTokens.flatMap((t) => t.defs.filter((x) => x.hex).map((x) => ({ label: t.name, scope: x.base ? '' : x.scope, canon: x.canon, color: wholeColor(x.hex).color, file: x.file, line: x.line }))),
    ...literals.filter((l) => l.hex).map((l) => ({ label: l.canon, scope: '', canon: l.canon, color: wholeColor(l.hex).color, file: l.places[0]?.file, line: l.places[0]?.line })),
  ];
  const board = refs.map((c) => {
    let nearest = null;
    for (const h of held) {
      const distance = colorDistance(c.color, h.color);
      if (!nearest || distance < nearest.distance) nearest = { label: h.label, scope: h.scope, canon: h.canon, file: h.file, line: h.line, distance };
    }
    if (nearest) nearest.distance = Math.round(nearest.distance * 10) / 10;
    return { id: c.id, hex: hexOf(c.color), name: c.name || '', nearest, state: !nearest ? 'absent' : nearest.distance < EXACT ? 'exact' : nearest.distance <= FAR ? 'close' : 'absent' };
  });

  const all = [...colors, ...families, ...sizes, ...spacing, ...radii, ...durations, ...easings];
  const states = checked.filter((r) => r.check).map((r) => r.check.state);
  return {
    colors, type: { families, sizes, base: baseStack || families[0]?.value || null, rootPx, rootFrom: rootDecl ? { file: rootDecl.file, line: rootDecl.line } : null }, spacing, radii, motion: { durations, easings },
    rules: checked, locks, board,
    summary: {
      declarations: decls.length, tokens: tokens.size, colors: colors.length,
      far: all.filter((x) => x.drift.includes('far')).length, once: all.filter((x) => x.drift.includes('once')).length,
      locks: { matches: states.filter((s) => s === 'matches').length, varies: states.filter((s) => s === 'varies').length, breaks: states.filter((s) => s === 'breaks').length, missing: states.filter((s) => s === 'missing').length },
    },
  };
}
