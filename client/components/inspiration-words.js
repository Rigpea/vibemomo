// The inspiration board's pure parts (views/inspiration.js draws with them; tests/inspiration-view.test.mjs reads
// them): what a typed or pasted text is (a link, a hex color, a note), the tags in use and the filter, where a card
// lands when it is moved, a first guess at a card's height for the grid, and the words. No DOM. The server imports
// httpUrl from here, so the record's read and the card's link cannot disagree about an address.

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** '#rrggbb' in lower case from #rgb, rgb, #rrggbb or rrggbb; null for anything else (the server's rule). */
export function normalizeHex(text) {
  const m = String(text ?? '').trim().match(HEX);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
}

/** The text as one http(s) address, or null: a single word starting with http://, https:// or www. */
export function readUrl(text) {
  const t = String(text ?? '').trim();
  if (!t || /\s/.test(t)) return null;
  const candidate = /^www\.[^.]+\.\S+$/i.test(t) ? `https://${t}` : t;
  if (!/^https?:\/\/\S+$/i.test(candidate)) return null;
  try { return new URL(candidate).href; } catch { return null; }
}

/**
 * The address a link card may open: the text itself when it is an http or https address, else null. A card read back
 * from .studio/inspiration.json can hold anything (a file edited by hand, a folder brought in by import), and a
 * javascript: address in an href would run in the studio's own page. It must start with the scheme as written (no
 * space or control character before it, which a browser would skip) and be an address a browser can read. The
 * server's read (validCard in server/lib/inspiration.mjs) and the card's node use this one function.
 */
export function httpUrl(v) {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return null;
  try { const { protocol } = new URL(v); return protocol === 'http:' || protocol === 'https:' ? v : null; } catch { return null; }
}

/**
 * What the add field (or a paste, or a dropped text) would make: { kind: 'link', url }, { kind: 'color', hex },
 * { kind: 'note', text }, or null for nothing typed. A bare three or six letter word of hex digits without # is a
 * color only when it has a digit in it, so "added" or "facade" stay words.
 */
export function detectKind(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const url = readUrl(t);
  if (url) return { kind: 'link', url };
  const hex = normalizeHex(t);
  if (hex && (t.startsWith('#') || /\d/.test(t))) return { kind: 'color', hex };
  return { kind: 'note', text: t };
}

/** The Add button's words for what the field holds. */
export const addLabel = (found) => (found ? { link: 'Add link', color: 'Add color', note: 'Add note' }[found.kind] : 'Add');

/** Typed tags as the server stores them: split at commas, lower case, no leading #, each once. */
export function parseTags(text) {
  const out = [];
  for (const raw of String(text ?? '').split(',')) {
    const t = raw.replace(/\s+/g, ' ').trim().replace(/^#+/, '').toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The tags the board uses, with how many cards carry each: the default set first in its own order, then the
 *  person's own by name. A default tag no card has is left out (a filter on it would show nothing). */
export function tagsInUse(cards, defaults = []) {
  const count = new Map();
  for (const c of cards || []) for (const t of c.tags || []) count.set(t, (count.get(t) || 0) + 1);
  const own = [...count.keys()].filter((t) => !defaults.includes(t)).sort((a, b) => a.localeCompare(b));
  return [...defaults.filter((t) => count.has(t)), ...own].map((tag) => ({ tag, count: count.get(tag) }));
}

export const filterCards = (cards, tag) => (tag ? (cards || []).filter((c) => (c.tags || []).includes(tag)) : cards || []);

/** The tags an edit form offers: the default set, the board's own, then this card's, each once. */
export function tagChoices(defaults = [], cards = [], cardTags = []) {
  return [...new Set([...defaults, ...tagsInUse(cards, defaults).map((t) => t.tag), ...cardTags])];
}

/**
 * Where a card goes when the keyboard moves it one place among the cards on screen (ids, in order): the id it lands
 * before, null for the end, or undefined when it is already at that edge.
 */
export function stepTarget(ids, id, delta) {
  const i = ids.indexOf(id);
  if (i < 0) return undefined;
  if (delta < 0) return i === 0 ? undefined : ids[i - 1];
  return i >= ids.length - 1 ? undefined : ids[i + 2] ?? null;
}

/** Where a dragged card goes when dropped on another: before it, or after it (the id that follows it among the
 *  cards on screen, null at the end). undefined when the drop would leave it where it is. */
export function dropTarget(ids, dragId, overId, after) {
  if (dragId === overId || !ids.includes(dragId) || !ids.includes(overId)) return undefined;
  const rest = ids.filter((x) => x !== dragId);
  const at = rest.indexOf(overId) + (after ? 1 : 0);
  const before = rest[at] ?? null;
  const now = ids[ids.indexOf(dragId) + 1] ?? null;
  return before === now ? undefined : before;
}

/** The ids in the order a move gives (as the server answers it), for the view to show at once. */
export function moved(ids, id, before) {
  const rest = ids.filter((x) => x !== id);
  const at = before == null ? rest.length : rest.indexOf(before);
  if (at < 0) return ids;
  rest.splice(at, 0, id);
  return rest;
}

export const GRID_ROW = 4; // px: the grid's row unit (inspiration.css grid-auto-rows)
export const GRID_GAP = 14; // px: the least space under a card, counted into its span (rounding up to a row gives 14 to 18)
export const spanFor = (height) => Math.max(1, Math.ceil((height + GRID_GAP) / GRID_ROW));

/** A card's height in px before the browser has measured it, so the first paint does not stack the cards: the
 *  image by its recorded ratio, the words by their length. The view measures and corrects it right after. */
export function estimateHeight(card, colWidth = 280) {
  const image = card.kind === 'image' ? card : card.kind === 'link' ? card.image : null;
  const ratio = image?.width && image?.height ? Math.min(2.2, Math.max(0.35, image.height / image.width)) : image ? 0.66 : 0;
  const lines = (text, perLine) => (text ? Math.ceil(String(text).length / perLine) : 0);
  const perLine = Math.max(16, Math.floor(colWidth / 7.2));
  let body = lines(card.why, perLine) * 20 + (card.tags?.length ? 18 : 0);
  if (card.kind === 'link') body += Math.min(2, lines(card.title || card.url, perLine) || 1) * 21 + 18;
  if (card.kind === 'note') body += Math.min(14, String(card.text || '').split('\n').reduce((n, l) => n + Math.max(1, lines(l, perLine)), 0)) * 21;
  if (card.kind === 'color') body += 20;
  return Math.round(ratio * colWidth) + (card.kind === 'color' ? 96 : 0) + (body ? body + 24 + 8 : 0) + 2;
}

/** A card's name for assistive technology and tooltips: its kind, then what it holds. */
export function cardName(card) {
  const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  if (card.kind === 'image') return `Image${card.why ? `: ${short(card.why, 80)}` : card.name ? `: ${card.name}` : ''}`;
  if (card.kind === 'link') return `Link: ${short(card.title || card.url, 80)}`;
  if (card.kind === 'color') return `Color ${card.hex}${card.name ? ` ${card.name}` : ''}`;
  return `Note: ${short(card.text, 80)}`;
}

/** An image's alternative text: why the person kept it, else its file name, else what it is. */
export const imageAlt = (card) => card.why || (card.kind === 'link' ? `Preview of ${card.title || card.site || 'the page'}` : card.name || 'Collected image');

/** The words under the title of a link card: its site, and when the page gave no preview, why. */
export const linkMeta = (card) => [card.site, card.preview?.ok === false ? card.preview.reason : null].filter(Boolean).join(' · ');

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
/** Why a picked or dropped file is not sent, in the server's own sentence, or null. Only the size is judged here:
 *  what the file is, the server reads from its bytes. */
export function fileProblem(file, limits = {}) {
  const max = limits.imageBytes;
  return max && file?.size > max ? `An image on the board is at most ${mb(max)}; ${file.name ? `${file.name} is` : 'this one is'} ${mb(file.size)}` : null;
}

export const rgbToHex = (r, g, b) => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0')).join('')}`;

/** The address an image of the board is read from; v (the card's updatedAt) makes a refetched preview a new address. */
/** The address of an image on the Studio look board (the person's own, in the data folder). */
export const lookFileUrl = (file, v = '') => `/api/studio-look/board/files/${encodeURIComponent(file)}${v ? `?v=${encodeURIComponent(v)}` : ''}`;
export const fileUrl = (projectId, file, v = '') => `/api/projects/${encodeURIComponent(projectId)}/inspiration/files/${encodeURIComponent(file)}${v ? `?v=${encodeURIComponent(v)}` : ''}`;

/** The count line beside the title: "Harbor · 6 cards", and with a filter "Harbor · 2 of 6 cards · layout". */
export function countWords(name, total, shown, tag) {
  const cards = `${total} card${total === 1 ? '' : 's'}`;
  return [name, tag ? `${shown} of ${cards}` : cards, tag].filter(Boolean).join(' · ');
}

export const PICK_HINT = 'Picking a color: click the image, or move with the arrow keys and press Enter. Esc stops.';
export const EMPTY_WORDS = 'Nothing collected yet. Drop or paste an image, a link, a hex color or a few words anywhere here.';
export const removeWords = (card, project) => `Remove this ${card.kind} from ${project ? `${project}'s` : 'the'} board?${card.kind === 'image' || card.image ? ' Its image file goes from .studio/inspiration.' : ''}`;
