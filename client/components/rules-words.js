// The fixed rules' pure parts (components/rules-panel.js draws with them; tests/rules-view.test.mjs reads them): the
// kinds in words, the rules grouped by kind, the count line, a token's swatch, what an edit form would send, and the
// sentences. No DOM.

export const KIND_WORDS = { color: 'Color', type: 'Type', layout: 'Layout', motion: 'Motion', tone: 'Tone', behaviour: 'Behaviour' };
export const kindWord = (k) => KIND_WORDS[k] || String(k || '');

/** The rules by kind in the kinds' own order (the order they were added within a kind); a kind with none is left out. */
export function groupRules(rules, kinds = Object.keys(KIND_WORDS)) {
  return kinds.map((kind) => ({ kind, rules: (rules || []).filter((r) => r.kind === kind) })).filter((g) => g.rules.length);
}

/** The rule ids in the order the list shows them, so the focus can go to the next one after a removal. */
export const shownOrder = (rules, kinds) => groupRules(rules, kinds).flatMap((g) => g.rules.map((r) => r.id));

/** The count line beside the title: "Harbor · 9 rules · 4 locked tokens". */
export function countWords(name, rules) {
  const n = (rules || []).length;
  const locks = (rules || []).filter((r) => r.token).length;
  return [name, `${n} rule${n === 1 ? '' : 's'}`, locks ? `${locks} locked token${locks === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
}

/** A token as it is written in CSS: "--accent: #d6a455". */
export const tokenWords = (token) => (token ? `${token.name}: ${token.value}` : '');

/** The value as a color to show beside it, or null: a hex of 3, 4, 6 or 8 digits, or one rgb(), hsl(), oklch() and
 *  the like with nothing but numbers inside. Anything else (a font list, a time, a var()) gets no swatch. */
export function swatchOf(value) {
  const v = String(value ?? '').trim();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[-+0-9.%,/\sa-z]*\)$/i.test(v) && !/var|calc|url/i.test(v)) return v;
  return null;
}

/** A rule's name for assistive technology and tooltips. */
export function ruleName(rule) {
  const t = String(rule?.text || '').replace(/\s+/g, ' ').trim();
  return `${kindWord(rule?.kind)} rule: ${t.length > 90 ? `${t.slice(0, 89)}…` : t}`;
}

/**
 * What an edit form sends: for a new rule (before: null) every field; for an existing one only what changed, and {}
 * when nothing did. form: { text, kind, why, tokenName, tokenValue } as typed. Both token fields empty is no lock
 * (token: null); one without the other is sent as typed, and the server says which is missing.
 */
export function formPatch(before, form) {
  const text = String(form.text ?? '').replace(/\s+/g, ' ').trim();
  const why = String(form.why ?? '').replace(/\s+/g, ' ').trim();
  const name = String(form.tokenName ?? '').trim();
  const value = String(form.tokenValue ?? '').replace(/\s+/g, ' ').trim();
  const token = name || value ? { name, value } : null;
  if (!before) return { text, kind: form.kind || '', why, token };
  const patch = {};
  if (text !== before.text) patch.text = text;
  if ((form.kind || '') !== before.kind) patch.kind = form.kind || '';
  if (why !== (before.why || '')) patch.why = why;
  if (tokenWords(token) !== tokenWords(before.token) || !!token !== !!before.token) patch.token = token;
  return patch;
}

export const EMPTY_WORDS = 'No fixed rules yet. A rule is one thing that must stay the same while everything else changes; Claude is told to keep it in every task.';
export const TOKEN_HINT = 'Optional. Locks one CSS custom property at this value; Claude is told to leave it there in every task.';
export const removeWords = (rule, project) => `Remove this rule from ${project ? `${project}'s` : 'the'} fixed rules? Claude will no longer be told to keep it.${rule.token ? ` Its lock on ${rule.token.name} goes with it.` : ''}`;
