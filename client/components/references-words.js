// The references' pure parts (components/references-panel.js draws with them, server/lib/mcp/tools.mjs searches with
// them, tests/references-view.test.mjs reads them): the kinds in words, an entry's name, the search and the tag
// filter, the list grouped by kind, the count line, how much of a long text is shown, what a form would send, and
// the sentences. No DOM.

export const KIND_WORDS = { link: 'Links', snippet: 'Snippets', prompt: 'Prompts', note: 'Notes' };
export const KIND_ONE = { link: 'Link', snippet: 'Snippet', prompt: 'Prompt', note: 'Note' };
export const kindWord = (k) => KIND_WORDS[k] || String(k || '');
/** What the Language field offers; any short word is taken. */
export const LANGUAGES = ['js', 'ts', 'css', 'html', 'json', 'bash', 'powershell', 'python', 'sql', 'markdown'];
/** The fields a kind keeps beside the ones every entry has: a link its address, the others their text. */
export const HAS_TEXT = ['snippet', 'prompt', 'note'];

const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const lineCount = (text) => { const t = String(text ?? ''); return t ? t.split('\n').length : 0; };
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';

/** An entry's name: its title, else what it holds (a link's address, the first line of its text). */
export function refName(e, max = 80) {
  if (e?.title) return short(e.title, max);
  if (e?.kind === 'link') return short(e.url, max);
  return short(firstLine(e?.text), max);
}
/** For assistive technology and tooltips: "Snippet: Atomic write". */
export const refLabel = (e) => `${KIND_ONE[e?.kind] || 'Reference'}: ${refName(e, 90)}`;

/** The words under a link's title: its site, and when the page gave no title, why. */
export const linkMeta = (e) => [e.site || hostOf(e.url), e.preview?.ok === false ? e.preview.reason : null].filter(Boolean).join(' · ');

// ---------- search and filter ----------
export const searchWords = (q) => String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
/** Everything a search reads of an entry: title, text, tags, the use-it-for line, a link's address and site, a
 *  snippet's language, where it came from and its kind. */
export const haystack = (e) => [e.title, e.text, e.url, e.site, e.description, e.language, e.useFor, e.source, e.kind, ...(e.tags || [])].filter(Boolean).join('\n').toLowerCase();
/** True when every word of the search is somewhere in the entry (in any order); an empty search finds everything. */
export function matchesSearch(e, q) {
  const words = searchWords(q);
  if (!words.length) return true;
  const hay = haystack(e);
  return words.every((w) => hay.includes(w));
}
/** The entries a tag and a search leave, in the order given. */
export function filterRefs(entries, { tag = null, search = '' } = {}) {
  return (entries || []).filter((e) => (!tag || (e.tags || []).includes(tag)) && matchesSearch(e, search));
}
/** The tags in use with how many entries carry each, by name. */
export function tagsInUse(entries) {
  const count = new Map();
  for (const e of entries || []) for (const t of e.tags || []) count.set(t, (count.get(t) || 0) + 1);
  return [...count.keys()].sort((a, b) => a.localeCompare(b)).map((tag) => ({ tag, count: count.get(tag) }));
}
/** Typed tags as the server stores them: split at commas, lower case, no leading #, each once. */
export function parseTags(text) {
  const out = [];
  for (const raw of String(text ?? '').split(',')) {
    const t = raw.replace(/\s+/g, ' ').trim().replace(/^#+/, '').toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---------- the list ----------
/** The entries by kind in the kinds' own order (the order stored within a kind: newest first); a kind with none is left out. */
export function groupRefs(entries, kinds = Object.keys(KIND_WORDS)) {
  return kinds.map((kind) => ({ kind, entries: (entries || []).filter((e) => e.kind === kind) })).filter((g) => g.entries.length);
}
/** The ids in the order the list shows them, so the focus can go to the next one after a removal. */
export const shownOrder = (entries, kinds) => groupRefs(entries, kinds).flatMap((g) => g.entries.map((e) => e.id));

/** The count line beside the title: "Harbor · 12 references", and filtered "Harbor · 3 of 12 references · mcp · “atomic”". */
export function countWords(name, total, shown, { tag = null, search = '' } = {}) {
  const q = String(search || '').trim();
  const refs = `${total} reference${total === 1 ? '' : 's'}`;
  return [name, tag || q ? `${shown} of ${refs}` : refs, tag, q ? `“${short(q, 40)}”` : null].filter(Boolean).join(' · ');
}

export const SHOWN_LINES = { snippet: 12, prompt: 8, note: 8 };
/** How much of a long text the list shows before Show all: the first `max` lines. { text, cut, lines }. */
export function clampLines(text, max) {
  const all = String(text ?? '').split('\n');
  if (all.length <= max) return { text: all.join('\n'), cut: false, lines: all.length };
  return { text: all.slice(0, max).join('\n'), cut: true, lines: all.length };
}

/** True when the list shows only the start of an entry's text: more lines than its kind shows, or, for a prompt or a
 *  note (whose lines wrap), more characters than those lines hold. */
export const isLong = (e) => lineCount(e?.text) > (SHOWN_LINES[e?.kind] || 8) || (e?.kind !== 'snippet' && String(e?.text ?? '').length > 640);
/** The words of the button that opens and closes a long text. */
export const moreWords = (e, open) => (open ? 'Show less' : e.kind === 'snippet' ? `Show all ${lineCount(e.text)} lines` : 'Show all');

// ---------- the form ----------
const one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const body = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
/**
 * What the form sends. form: { kind, title, url, text, language, useFor, source, tags } as typed (tags a string of
 * comma separated words). For a new entry (before: null) every field of its kind; for an existing one only what
 * changed, and {} when nothing did.
 */
export function formPatch(before, form) {
  const kind = before?.kind || form.kind;
  const next = { title: one(form.title), useFor: one(form.useFor), source: one(form.source), tags: parseTags(form.tags) };
  if (kind === 'link') next.url = String(form.url ?? '').trim();
  else next.text = body(form.text);
  if (kind === 'snippet') next.language = one(form.language).toLowerCase();
  if (!before) return { kind, ...next };
  const patch = {};
  for (const [k, v] of Object.entries(next)) {
    const was = k === 'tags' ? before.tags || [] : before[k] ?? '';
    if (JSON.stringify(v) !== JSON.stringify(was)) patch[k] = v;
  }
  return patch;
}

export const EMPTY_WORDS = 'No references yet. A reference is something to build from: a docs link, a code snippet, a prompt that worked or a note. Claude gets the ones that match a task in its brief.';
export const NO_MATCH_WORDS = 'No reference matches. Clear the search or the tag to see them all.';
export const USE_HINT = 'Optional. One line saying when to reach for it; a task whose request uses these words gets this reference in its brief.';
export const removeWords = (e, project) => `Remove this ${e.kind} from ${project ? `${project}'s` : 'the'} references? Claude will no longer get it in a brief.`;
