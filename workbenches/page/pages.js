// Page panel, the pure half: what the preview's document says about itself, read through a handful of DOM properties
// (children, tagName, getAttribute, hidden, id, textContent, parentElement) so tests/page-tab.test.mjs can hand it a
// stub document. Pages come from the document's own structure, parts from its real elements; nothing is guessed:
// a page with no name reads as its tag or file, a page that does not answer to its hash says so.
// The server imports auraLine (server/lib/companion.mjs, server/lib/mcp/tools.mjs), so nothing here touches a global.

export const OVERLAY_ID = 'atelier-page-outline';
export const NOT_READABLE = 'The preview is not readable from here';
const NAME_MAX = 60;
const PART_MAX = 40; // parts per level
const LANDMARKS = new Set(['header', 'nav', 'main', 'section', 'footer', 'aside']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta']);
const TAG_WORDS = { header: 'Header', nav: 'Navigation', main: 'Main', section: 'Section', footer: 'Footer', aside: 'Aside', body: 'Page' };

const tagOf = (el) => String(el?.tagName || '').toLowerCase();
const attr = (el, name) => (typeof el?.getAttribute === 'function' ? el.getAttribute(name) : null);
const kids = (el) => Array.from(el?.children || []);
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n = NAME_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const two = (i) => String(i + 1).padStart(2, '0');

/**
 * An element's words as a reader hears them: its text nodes in order, a <br> as a space, aria-hidden parts left out
 * (a heading "Choose your<br>companion<span aria-hidden>.</span>" reads "Choose your companion", not "Choose yourcompanion.").
 * A node without childNodes (a stub) gives its textContent.
 */
export function spokenText(el) {
  if (!el) return '';
  const nodes = el.childNodes;
  if (!nodes) return squash(el.textContent);
  let out = '';
  for (const n of Array.from(nodes)) {
    if (n.nodeType === 3) out += n.nodeValue || '';
    else if (n.nodeType === 1) {
      if (tagOf(n) === 'br') out += ' ';
      else if (attr(n, 'aria-hidden') !== 'true') out += ` ${spokenText(n)} `;
    }
  }
  return squash(out);
}

/** Hidden by the attribute, aria-hidden, or (when the document has a view) display none. */
export function isHidden(el) {
  if (!el) return true;
  if (el.hidden === true || attr(el, 'hidden') != null) return true;
  const view = el.ownerDocument?.defaultView;
  if (view?.getComputedStyle) {
    try { if (view.getComputedStyle(el).display === 'none') return true; } catch { /* a detached node */ }
  }
  return false;
}

/** The first element under el (breadth first) whose tag is in tags. */
function firstUnder(el, tags) {
  const queue = kids(el);
  while (queue.length) {
    const n = queue.shift();
    if (tags.has(tagOf(n))) return n;
    queue.push(...kids(n));
  }
  return null;
}

/** A page's name: its heading (h1, h2), aria-label, data-screen / data-page, id, else fallback. */
export function pageName(el, fallback = '') {
  const h = firstUnder(el, new Set(['h1', 'h2']));
  const said = spokenText(h) || squash(attr(el, 'aria-label')) || squash(attr(el, 'data-screen')) || squash(attr(el, 'data-page')) || squash(el?.id);
  return cut(said || fallback || TAG_WORDS[tagOf(el)] || tagOf(el) || 'Page');
}

/** A part's name: a heading's own text; else the heading inside it, aria-label, id, else its tag in words. */
export function partName(el) {
  const tag = tagOf(el);
  if (HEADINGS.has(tag)) return cut(spokenText(el) || tag);
  const h = firstUnder(el, HEADINGS);
  return cut(spokenText(h) || squash(attr(el, 'aria-label')) || squash(el.id) || TAG_WORDS[tag] || tag);
}

const SIMPLE_ID = /^[A-Za-z][\w-]*$/;

/** A stable path to el: '#id' when it has a plain id, else tag:nth-of-type(n) steps up to an ancestor with one or
 *  to body, joined with ' > '. elementAt reads it back. */
export function selectorOf(el) {
  const steps = [];
  for (let n = el; n; n = n.parentElement) {
    const tag = tagOf(n);
    if (n.id && SIMPLE_ID.test(n.id)) { steps.unshift(`#${n.id}`); break; }
    if (tag === 'body' || tag === 'html' || !n.parentElement) { steps.unshift(tag || 'body'); break; }
    const same = kids(n.parentElement).filter((k) => tagOf(k) === tag);
    steps.unshift(`${tag}:nth-of-type(${same.indexOf(n) + 1})`);
  }
  return steps.join(' > ');
}

/** The element a selectorOf path names in doc, or null. */
export function elementAt(doc, selector) {
  const steps = String(selector || '').split(' > ').filter(Boolean);
  if (!doc || !steps.length) return null;
  let cur = null;
  for (const [i, step] of steps.entries()) {
    if (step.startsWith('#')) { cur = doc.getElementById?.(step.slice(1)) || null; }
    else if (i === 0 && step === 'body') cur = doc.body || null;
    else if (i === 0 && step === 'html') cur = doc.documentElement || null;
    else {
      const m = step.match(/^([a-z][a-z0-9-]*):nth-of-type\((\d+)\)$/);
      if (!m || !cur) return null;
      cur = kids(cur).filter((k) => tagOf(k) === m[1])[Number(m[2]) - 1] || null;
    }
    if (!cur) return null;
  }
  return cur;
}

/** The document's file from a preview URL (/preview/<project>/<ref>/<path>): the project-relative path, or null. */
export function fileOfUrl(url) {
  try {
    const u = new URL(url, 'http://studio.local');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'preview' || parts.length < 4) return null;
    return parts.slice(3).map(decodeURIComponent).join('/');
  } catch { return null; }
}

const baseName = (p) => String(p || '').split('/').pop() || '';

/**
 * Where a point sits, as words a person and a brief can use: the entry's file plus the shown page's hash
 * ("dist/welcome/index.html#case"), the URL's own hash when the page has none, the URL itself when it is not a preview URL.
 * Never the preview URL with its cache-buster.
 */
export function pageRef(e) {
  const file = fileOfUrl(e?.url);
  if (!file) return e?.url || '';
  const key = String(e?.page?.key || '');
  const i = key.indexOf('#');
  if (i >= 0) return `${file}${key.slice(i)}`;
  try { return `${file}${new URL(e.url).hash}`; } catch { return file; }
}
/** The key a page's aura is kept under in project.ui.pages: the file's name, then #screen when it has one. */
export const pageKey = (file, slug) => `${baseName(file) || 'page'}${slug ? `#${slug}` : ''}`;

function walk(el, visit) {
  for (const k of kids(el)) {
    if (SKIP.has(tagOf(k))) continue;
    if (visit(k) !== false) walk(k, visit);
  }
}

/**
 * The entry document's pages: [{ n, key, name, slug, hash, element, visible, file }].
 * Elements with data-screen or data-page; else body's top-level section and main elements with an id (one level
 * into an id-less main); else the one document. The visible page is the one matching the hash, else the one not
 * hidden. siblings: other HTML files in the entry's folder, listed after as pages of their own (element null).
 */
export function pagesOf(doc, url, { siblings = [] } = {}) {
  const body = doc?.body;
  if (!body) return [];
  const file = fileOfUrl(url) || baseName(url) || 'index.html';
  let hash = '';
  try { hash = decodeURIComponent(new URL(url, 'http://studio.local').hash.slice(1)); } catch { /* none */ }
  let found = [];
  walk(body, (n) => {
    const s = attr(n, 'data-screen') ?? attr(n, 'data-page');
    if (s != null) { found.push({ element: n, slug: squash(s) || n.id || '' }); return false; }
    return true;
  });
  if (!found.length) {
    const top = [];
    for (const k of kids(body)) {
      const tag = tagOf(k);
      if ((tag === 'section' || tag === 'main') && k.id) top.push(k);
      else if (tag === 'main') top.push(...kids(k).filter((s) => tagOf(s) === 'section' && s.id));
    }
    found = top.map((element) => ({ element, slug: element.id }));
  }
  let pages;
  if (found.length) {
    pages = found.map(({ element, slug }) => ({ element, slug, name: pageName(element, slug), hash: slug ? `#${slug}` : null, hidden: isHidden(element) }));
    const byHash = hash ? pages.find((p) => p.slug === hash) : null;
    const shown = byHash && !byHash.hidden ? byHash : pages.find((p) => !p.hidden) || null;
    pages.forEach((p) => { p.visible = p === shown; });
  } else {
    pages = [{ element: body, slug: '', name: pageName(body, squash(doc.title) || baseName(file)), hash: null, hidden: false, visible: true }];
  }
  const own = pages.map((p, i) => ({ n: two(i), key: pageKey(file, p.slug), name: p.name, slug: p.slug, hash: p.hash, element: p.element, visible: !!p.visible, file }));
  const others = siblings.filter((s) => baseName(s) !== baseName(file)).map((s, i) => ({
    n: two(own.length + i), key: pageKey(s), name: baseName(s), slug: '', hash: null, element: null, visible: false, file: s,
  }));
  return [...own, ...others];
}

const isPart = (el) => {
  const tag = tagOf(el);
  return LANDMARKS.has(tag) || HEADINGS.has(tag) || !!el.id || attr(el, 'aria-label') != null || attr(el, 'role') != null;
};

/** The parts directly under el, looking through elements that are not parts themselves; hidden ones are left out. */
function partsUnder(el) {
  const out = [];
  walk(el, (n) => {
    if (out.length >= PART_MAX || isHidden(n)) return false;
    if (isPart(n)) { out.push(n); return false; }
    return true;
  });
  return out;
}

/** The visible page's parts two levels deep: [{ name, tag, selector, element, children: [{ … , children: [] }] }]. */
export function partsOf(pageElement) {
  if (!pageElement) return [];
  const one = (n, deeper) => ({ name: partName(n), tag: tagOf(n), selector: selectorOf(n), element: n, children: deeper ? partsUnder(n).map((c) => one(c, false)) : [] });
  return partsUnder(pageElement).map((n) => one(n, true));
}

// ---------- the outline on the preview ----------

/** Where the outline sits for a box (getBoundingClientRect) on a document scrolled by (x, y): document coordinates. */
export const outlineBox = (rect, scrollX = 0, scrollY = 0) => ({
  left: Math.round((rect.left + scrollX) * 100) / 100,
  top: Math.round((rect.top + scrollY) * 100) / 100,
  width: Math.round(rect.width * 100) / 100,
  height: Math.round(rect.height * 100) / 100,
});

/**
 * One outline element in the frame's own document, absolutely placed over el at its box, with the label
 * "<name> selected" at its top left; pointer-events none so the page below still works. Created once, then moved.
 */
export function placeOverlay(doc, el, name, { accent = '#8ab4ff' } = {}) {
  if (!doc || !el?.getBoundingClientRect) return null;
  const view = doc.defaultView || {};
  const box = outlineBox(el.getBoundingClientRect(), view.scrollX || view.pageXOffset || 0, view.scrollY || view.pageYOffset || 0);
  let node = doc.getElementById?.(OVERLAY_ID);
  if (!node) {
    node = doc.createElement('div');
    node.id = OVERLAY_ID;
    node.setAttribute?.('aria-hidden', 'true');
    const label = doc.createElement('span');
    label.className = `${OVERLAY_ID}-label`;
    node.appendChild(label);
    (doc.documentElement || doc.body).appendChild(node);
  }
  Object.assign(node.style, {
    position: 'absolute', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
    border: `1.5px solid ${accent}`, borderRadius: '3px', boxSizing: 'border-box', pointerEvents: 'none', zIndex: '2147483646', margin: '0', padding: '0',
  });
  const label = node.firstChild || node.children?.[0];
  if (label) {
    label.textContent = `${name} selected`;
    Object.assign(label.style, {
      position: 'absolute', left: '-1.5px', top: box.top >= 18 ? '-18px' : '0', padding: '1px 6px', font: '600 11px/16px system-ui, sans-serif',
      color: '#0b0d10', background: accent, borderRadius: '3px', whiteSpace: 'nowrap', pointerEvents: 'none',
    });
  }
  return node;
}

export function removeOverlay(doc) {
  const node = doc?.getElementById?.(OVERLAY_ID);
  if (node) node.remove();
  return !!node;
}

// ---------- Point on the preview ----------

/** The element under a click as the readout and the inspect route take it. Text nodes count as their parent. */
export function describeElement(target, { page = null, url = '' } = {}) {
  const el = target?.nodeType === 3 ? target.parentElement : target;
  if (!el || !el.tagName) return null;
  const classes = Array.from(el.classList || String(attr(el, 'class') || '').split(/\s+/).filter(Boolean)).filter((c) => c !== OVERLAY_ID);
  return {
    tag: tagOf(el), id: el.id || null, classes,
    text: squash(el.innerText ?? el.textContent).slice(0, 160),
    selector: selectorOf(el), page: page ? { key: page.key, name: page.name } : null, url,
  };
}

/** What POST /page/inspect is asked. */
export const inspectBody = (element, file = null) => ({ selector: element.selector, id: element.id, classes: element.classes, text: element.text, ...(file ? { page: file } : {}) });

/** tag#id.class.class */
export const elementName = (e) => (e ? `${e.tag || '?'}${e.id ? `#${e.id}` : ''}${(e.classes || []).map((c) => `.${c}`).join('')}` : '');
export const candidateRef = (c) => `${c.file}:${c.line}`;

/** The block Copy for a task puts on the clipboard. */
export function pointTaskText({ element, candidates = [], searched } = {}) {
  const lines = [`Preview point: ${element?.page?.name || 'a page'}${element?.url ? ` (${pageRef(element)})` : ''}`];
  if (element) {
    lines.push(`Element: ${elementName(element)}${element.selector ? ` (selector ${element.selector})` : ''}`);
    lines.push(`Text: ${element.text ? `"${element.text}"` : '(none)'}`);
  }
  const top = candidates.slice(0, 3);
  if (top.length) { lines.push('Files:'); for (const c of top) lines.push(`- ${candidateRef(c)}${c.matched?.length ? ` (matches ${c.matched.join(', ')})` : ''}`); }
  else lines.push(`Files: none found${searched ? ` in ${searched}` : ''}`);
  return lines.join('\n');
}

/** The pin a preview point becomes: source preview and no device point, so the Companion tab lists it as a phone pin. */
export function pinFromPoint({ element, candidates = [] } = {}) {
  const e = element || {};
  return {
    source: 'preview', element: elementName(e) || '?', text: e.text || '', selector: e.selector || '', point: null,
    files: candidates.slice(0, 10).map(candidateRef), page: pageRef(e),
    ...(e.page?.key ? { pageKey: e.page.key, pageName: e.page.name || '' } : {}),
  };
}

// ---------- the footer, the aura, readability ----------

/** "Preview · #4 · 390 px · not verified": the version on screen (or files on disk), the frame's width, verified or not. */
export function footerLine({ versions = [], ref = 'head', current = null, dirty = false, width = null } = {}) {
  const v = ref && ref !== 'head' ? versions.find((x) => x.id === ref) || null : !dirty ? current : null;
  const w = Number.isFinite(width) && width > 0 ? `${Math.round(width)} px` : 'width unknown';
  return ['Preview', v ? `#${v.n}` : 'files on disk', w, v?.verified ? 'verified' : 'not verified'].join(' · ');
}

/** "Aura of <page>: <note>" for the page the Page tab last saw on the preview, or null when no note is kept. */
export function auraLine(ui = {}) {
  const at = ui?.pageInView;
  const note = at?.key ? squash(ui?.pages?.[at.key]?.aura) : '';
  return note ? `Aura of ${at.name || at.key}: ${note}` : null;
}

/** The aura lines for preview pins: one per page with a note, in pin order. */
export function auraLinesForPins(ui = {}, pins = []) {
  const out = [];
  for (const p of pins) {
    if (p?.source !== 'preview' || !p.pageKey) continue;
    const note = squash(ui?.pages?.[p.pageKey]?.aura);
    const line = note ? `Aura of ${p.pageName || p.pageKey}: ${note}` : null;
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/** Can the panel read the frame? { ok: true, doc } or { ok: false, why } in plain words. */
export function readable(frame) {
  if (!frame) return { ok: false, why: 'there is no preview frame' };
  let doc;
  try { doc = frame.contentDocument; } catch { return { ok: false, why: 'the page in the frame is from another origin' }; }
  // A cross-origin frame answers contentDocument with null; a frame not in the page has no window at all.
  if (doc === null || doc === undefined) return { ok: false, why: frame.contentWindow ? 'the page in the frame is from another origin' : 'the preview is not loaded' };
  const href = String(doc.URL || doc.location?.href || '');
  if (!href || href === 'about:blank') return { ok: false, why: 'the preview is not loaded' };
  if (!doc.body) return { ok: false, why: 'the document has no body' };
  return { ok: true, doc };
}
