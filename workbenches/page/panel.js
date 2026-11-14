// Page dock tab (docs/ARCHITECTURE.md section 13): the preview's own document read in place, since the preview is
// same-origin with the studio. Left: the numbered pages (the entry's screens, then the other HTML files beside it) and
// the visible page's aura note. Right: "On this screen", the visible page's parts two levels deep; a selected part is
// outlined on the preview by one element injected into the frame's document. Point reads the element under a click
// in the frame (the click does not reach the page) and asks POST /page/inspect for the files that likely hold it.
// Everything shown comes from the document as it is now or from a route's answer; when the frame cannot be read the
// tab says so and shows no tree. Pure parts: ./pages.js.
import { el, clear, button, toast, copyText } from '/components/ui.js';
import {
  NOT_READABLE, readable, pagesOf, partsOf, elementAt, placeOverlay, removeOverlay, describeElement, inspectBody,
  elementName, candidateRef, pointTaskText, pinFromPoint, footerLine, fileOfUrl, pageRef,
} from './pages.js';

const STACK_PX = 760; // narrower than this, the two columns stack
const REREAD_MS = 120; // after the document changes (a screen shown or hidden), read it again once it settles
const HASH_WAIT_MS = 200; // after setting a hash, how long a page has to show itself
const POINT_EVENT = 'atelier:point-mode'; // the Phone and Page Point modes are never both on

let st = null;

export function mount(container, ctx) {
  const me = {
    ctx, container, doc: null, pages: [], parts: [], visible: null, selected: null, point: false, readout: null, ghost: [], ghostDots: new Map(),
    siblings: [], notes: {}, auraDrafts: {}, offs: [], docOffs: [], timer: null, raf: null, inspectTurn: 0,
  };
  st = me;
  container.classList?.add('page-host');
  const n = (me.nodes = {});
  n.notReadable = el('p.page-unreadable', { role: 'status', hidden: true });
  n.pages = el('ol.page-list', { 'aria-label': 'Pages' });
  n.auraBox = el('div.page-aura');
  n.tree = el('ul.page-tree', { role: 'tree', 'aria-label': 'On this screen' });
  n.treeNote = el('p.meta');
  n.pointBtn = button('Point', { small: true, 'aria-pressed': 'false', title: 'A click on the preview reads the element under it instead of reaching the page (Esc leaves)', onclick: () => setPoint(!me.point) });
  n.pointLine = el('p.meta', { role: 'status' });
  n.readout = el('div.page-readout', { role: 'status' });
  n.footer = el('p.meta.page-footer');
  n.left = el('div.page-col', el('h3.overline', 'Pages'), n.pages, n.auraBox);
  n.right = el('div.page-col', el('div.page-head', el('h3.overline', 'On this screen'), n.pointBtn), n.treeNote, n.tree, n.pointLine, n.readout);
  n.body = el('div.page-cols', n.left, n.right);
  clear(container, el('div.page-tab', n.notReadable, n.body, n.footer));

  const frame = ctx.previewFrame;
  const onLoad = () => { deselect(false); read(); };
  frame?.addEventListener?.('load', onLoad);
  me.offs.push(() => frame?.removeEventListener?.('load', onLoad));
  if (ctx.bus?.on) me.offs.push(ctx.bus.on('reload', () => { detachDoc(); me.selected = null; me.readout = null; tellReadout(); }));
  // The ghost marker (client/components/ghost.js): the pages a session edited carry a faint dot until the frame reloads.
  if (typeof ctx.app?.on === 'function') me.offs.push(ctx.app.on('ghost', onGhost));
  const g = ctx.app?.workbench?.ghost?.(); // mounted after the ghost last drew: start from its model
  if (g?.projectId === ctx.projectId) me.ghost = g.model?.pages || [];
  const onOther = (e) => { if (e?.detail?.owner !== 'page' && me.point) setPoint(false, { quiet: true }); };
  globalThis.window?.addEventListener?.(POINT_EVENT, onOther);
  me.offs.push(() => globalThis.window?.removeEventListener?.(POINT_EVENT, onOther));
  container.addEventListener?.('keydown', onPanelKey);
  me.offs.push(() => container.removeEventListener?.('keydown', onPanelKey));
  // Esc anywhere in the studio leaves Point, not only with the focus in this panel or in the frame.
  globalThis.window?.addEventListener?.('keydown', onPanelKey);
  me.offs.push(() => globalThis.window?.removeEventListener?.('keydown', onPanelKey));
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => sizeColumns());
    ro.observe(container);
    me.offs.push(() => ro.disconnect());
  }
  loadSiblings();
  read();
}

export function unmount() {
  const me = st;
  if (!me) return;
  setPoint(false, { quiet: true });
  if (me.doc) removeOverlay(me.doc);
  detachDoc();
  if (me.readout) { me.readout = null; tellReadout(); }
  me.offs.forEach((off) => off());
  clearTimeout(me.timer);
  me.container.classList?.remove('page-host');
  st = null;
}

/** The bundle changed (a version kept, files changed): the footer's version and the aura may have moved. */
/** The dock's command for this panel (studio.show, the stage head's Select): { point: true|false } turns Point mode. */
export function command(cmd = {}) {
  if (st && typeof cmd.point === 'boolean') setPoint(cmd.point);
  return null;
}

export function update() {
  if (!st) return;
  renderAura();
  renderFooter();
}

// ---------- reading the frame ----------

async function loadSiblings() {
  const me = st;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(me.ctx.projectId)}/page/files`);
    const out = res.ok ? await res.json() : null;
    if (st !== me || !out) return;
    me.siblings = [out.entry, ...(out.siblings || [])].filter(Boolean);
    read();
  } catch { /* the entry's own pages still list */ }
}

function sizeColumns() {
  const me = st;
  const w = me?.container.getBoundingClientRect?.().width || 0;
  me?.nodes.body.classList?.toggle('stacked', w > 0 && w < STACK_PX);
}

function attachDoc(doc) {
  const me = st;
  detachDoc();
  me.doc = doc;
  const view = doc.defaultView;
  const on = (target, type, fn, opts) => { target?.addEventListener?.(type, fn, opts); me.docOffs.push(() => target?.removeEventListener?.(type, fn, opts)); };
  // Capture on the frame's window: the top of every event's path, so Point holds a click back before the page's own
  // listeners (on window, document or the element) see it.
  const top = view?.addEventListener ? view : doc;
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) on(top, type, onFrameClick, true);
  on(top, 'keydown', onFrameKey, true);
  if (me.point && doc.documentElement?.style) doc.documentElement.style.cursor = 'crosshair';
  on(doc, 'scroll', follow, true);
  on(view, 'resize', follow);
  on(view, 'hashchange', soon);
  const MO = view?.MutationObserver || globalThis.MutationObserver;
  if (typeof MO === 'function' && doc.body) {
    const mo = new MO((records) => { if (records.some((r) => !isOurs(r.target))) soon(); });
    mo.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-hidden'] });
    me.docOffs.push(() => mo.disconnect());
  }
}

const isOurs = (node) => String(node?.id || '').startsWith('atelier-page-outline');

function detachDoc() {
  const me = st;
  if (!me) return;
  me.docOffs.forEach((off) => off());
  me.docOffs = [];
  me.doc = null;
}

/** Read again shortly; a document that keeps changing is read at most once per REREAD_MS. */
function soon() {
  const me = st;
  if (!me || me.timer) return;
  me.timer = setTimeout(() => { me.timer = null; if (st === me) read(); }, REREAD_MS);
}

function read() {
  const me = st;
  if (!me) return;
  const r = readable(me.ctx.previewFrame);
  if (!r.ok) {
    detachDoc();
    me.pages = []; me.parts = []; me.visible = null; me.selected = null; me.sig = null;
    me.nodes.notReadable.hidden = false;
    me.nodes.notReadable.textContent = `${NOT_READABLE}: ${r.why}.`;
    me.nodes.body.hidden = true;
    me.ctx.setCount?.(null);
    renderFooter();
    return;
  }
  if (me.doc !== r.doc) attachDoc(r.doc);
  me.nodes.notReadable.hidden = true;
  me.nodes.body.hidden = false;
  me.pages = pagesOf(r.doc, r.doc.URL, { siblings: me.siblings });
  me.visible = me.pages.find((p) => p.visible) || null;
  me.parts = partsOf(me.visible?.element);
  if (me.selected && !elementAt(r.doc, me.selected.selector)) deselect(false);
  me.ctx.setCount?.(me.pages.length);
  rememberInView();
  // A document that changes all the time (a game) must not rebuild the lists under the person's pointer and focus.
  const sig = JSON.stringify([me.pages.map((p) => [p.key, p.name, p.visible]), signature(me.parts), me.selected?.selector || null]);
  if (sig !== me.sig) { me.sig = sig; render(); } else renderFooter();
  follow();
}

const signature = (parts) => parts.map((p) => [p.selector, p.name, signature(p.children)]);

/** project.ui.pageInView: the page the companion's context pack names the aura of. Saved only when it changes. */
function rememberInView() {
  const me = st;
  const v = me.visible;
  const now = me.ctx.project?.ui?.pageInView;
  if (!v || (now?.key === v.key && now?.name === v.name)) return;
  me.ctx.saveUi?.({ pageInView: { key: v.key, name: v.name } })?.catch?.(() => {});
}

// ---------- drawing ----------

function render() {
  const me = st;
  const focusKey = me.container.contains?.(globalThis.document?.activeElement) ? globalThis.document.activeElement.dataset?.focusKey : null;
  renderPages();
  renderAura();
  renderTree();
  renderReadout();
  renderFooter();
  sizeColumns();
  if (focusKey) findFocusKey(me.container, focusKey)?.focus?.();
}

function findFocusKey(root, key) {
  if (root?.dataset?.focusKey === key) return root;
  for (const k of root?.kids || root?.children || []) {
    if (typeof k !== 'object') continue;
    const hit = findFocusKey(k, key);
    if (hit) return hit;
  }
  return null;
}

/** The row that carries a file's dot: the shown page when it is that file's, else the file's first row. A one-file app
 *  with many hash pages is edited as one file, so one dot says so instead of a dot on every row (decision row 114). */
export function dotRows(pages, ghost) {
  const out = new Map(); // file → { key, shared }
  for (const g of ghost || []) {
    const rows = (pages || []).filter((p) => p.file === g.file);
    const row = rows.find((p) => p.visible) || rows[0];
    if (row) out.set(g.file, { key: row.key, shared: rows.length });
  }
  return out;
}
/** The dot's words: who and when, and for a file behind several pages, that it is. */
export const dotWords = (title, shared) => (shared > 1 ? `${title} · the one file behind ${shared} pages` : title);

function renderPages() {
  const me = st;
  me.ghostDots = new Map();
  const carriers = dotRows(me.pages, me.ghost);
  clear(me.nodes.pages, me.pages.map((p) => {
    const edited = me.ghost.find((g) => g.file === p.file);
    const carrier = edited ? carriers.get(p.file) : null;
    const words = carrier?.key === p.key ? dotWords(edited.title, carrier.shared) : null;
    const dot = words ? el('span.page-ghost', { title: words, 'aria-label': words, role: 'img' }) : null;
    if (dot) me.ghostDots.set(p.file, [...(me.ghostDots.get(p.file) || []), dot]);
    return el('li.page-item',
      el('button.page-row', {
        type: 'button', dataset: { page: p.key, focusKey: `page:${p.key}` },
        'aria-current': p.visible ? 'page' : 'false',
        title: p.visible ? `${p.name} is on the preview` : p.element ? `Show ${p.name} on the preview${p.hash ? ` (${p.hash})` : ''}` : `Open ${p.file} in the preview`,
        onclick: () => openPage(p),
      }, el('span.page-name', p.name), dot, el('span.page-n', p.n)),
      me.notes[p.key] ? el('p.meta.page-note', me.notes[p.key]) : null);
  }));
}

/** The ghost's pages ({ file, title }): the rows are drawn again only when the set of files changes (the person's
 *  focus stays on its row); a title that only ticks is set on the dots in place. */
function onGhost(e) {
  const me = st;
  if (!me || e?.projectId !== me.ctx.projectId) return;
  const next = e.model?.pages || [];
  const sig = (list) => list.map((g) => g.file).sort().join('\n');
  const changed = sig(next) !== sig(me.ghost);
  me.ghost = next;
  if (changed) {
    const focusKey = me.container.contains?.(globalThis.document?.activeElement) ? globalThis.document.activeElement.dataset?.focusKey : null;
    renderPages();
    if (focusKey) findFocusKey(me.nodes.pages, focusKey)?.focus?.();
    return;
  }
  const carriers = dotRows(me.pages, next);
  for (const g of next) for (const dot of me.ghostDots.get(g.file) || []) { const w = dotWords(g.title, carriers.get(g.file)?.shared || 1); dot.title = w; dot.setAttribute?.('aria-label', w); }
}

/** The readout on screen is a link from a part to its files: the ghost outlines that part when a session edits one. */
function tellReadout() {
  const me = st;
  const r = me?.readout;
  me?.ctx.app?.emit?.('ghost-readout', {
    projectId: me.ctx.projectId, source: 'page',
    selector: r?.candidates?.length ? r.element?.selector || null : null,
    element: r ? elementName(r.element) : null, files: (r?.candidates || []).map(candidateRef),
  });
}

function renderAura() {
  const me = st;
  const box = me.nodes.auraBox;
  const v = me.visible;
  if (!v) { me.auraFor = null; return clear(box); }
  // The person is typing in it: a redraw would take the caret away; the draft is theirs until Save.
  if (me.auraFor === v.key && me.nodes.auraArea && globalThis.document?.activeElement === me.nodes.auraArea) return;
  me.auraFor = v.key;
  const kept = me.ctx.project?.ui?.pages?.[v.key]?.aura || '';
  const id = `page-aura-${String(me.ctx.projectId)}`;
  const area = el('textarea.input', {
    id, rows: 2, maxLength: 300, value: me.auraDrafts[v.key] ?? kept, dataset: { focusKey: 'aura' },
    placeholder: 'The feel this page should give: calm, playful, careful…',
    oninput: (e) => { me.auraDrafts[v.key] = e.target.value; me.nodes.auraState.textContent = e.target.value.trim() === kept.trim() ? '' : 'Not saved'; },
  });
  me.nodes.auraArea = area;
  me.nodes.auraState = el('span.meta', { role: 'status' }, me.auraDrafts[v.key] != null && me.auraDrafts[v.key].trim() !== kept.trim() ? 'Not saved' : '');
  clear(box,
    el('label.page-aura-label', { htmlFor: id }, `Aura · ${v.name}`),
    area,
    el('div.page-aura-row', button('Save', { small: true, dataset: { focusKey: 'aura-save' }, onclick: () => saveAura(v, area.value) }), me.nodes.auraState));
}

async function saveAura(page, text) {
  const me = st;
  const ui = me.ctx.project?.ui || {};
  const pages = { ...(ui.pages || {}) };
  const note = String(text || '').trim();
  const rest = { ...(pages[page.key] || {}) };
  if (note) rest.aura = note; else delete rest.aura;
  if (Object.keys(rest).length) pages[page.key] = rest; else delete pages[page.key];
  try {
    await me.ctx.saveUi({ pages });
    if (st !== me) return;
    delete me.auraDrafts[page.key];
    renderAura();
    findFocusKey(me.nodes.auraBox, 'aura-save')?.focus?.();
    me.nodes.auraState.textContent = note ? 'Saved' : 'Removed';
  } catch (err) {
    if (st === me) me.nodes.auraState.textContent = `Not saved: ${err.message}`;
  }
}

function partRow(part, depth) {
  const me = st;
  const on = me.selected?.selector === part.selector;
  return el('li', { role: 'none' },
    el('button.page-part', {
      type: 'button', role: 'treeitem', 'aria-level': String(depth), 'aria-selected': String(on),
      dataset: { selector: part.selector, focusKey: `part:${part.selector}` }, title: `${part.tag} · ${part.selector}`,
      onclick: () => (on ? deselect() : select(part)),
    }, el('span', part.name), el('span.meta', part.tag)),
    part.children.length ? el('ul', { role: 'group' }, part.children.map((c) => partRow(c, depth + 1))) : null);
}

function renderTree() {
  const me = st;
  me.nodes.treeNote.textContent = !me.visible ? 'No page is visible on the preview.'
    : !me.visible.element ? '' : me.parts.length ? '' : `${me.visible.name} has no headings, landmarks or named groups to list.`;
  clear(me.nodes.tree, me.parts.map((p) => partRow(p, 1)));
}

function renderFooter() {
  const me = st;
  const b = me.ctx.app?.state?.bundle;
  const versions = b?.versions || [];
  const current = versions.find((v) => v.id === b?.changes?.sinceVersionId) || null;
  const ref = me.ctx.app?.workbench?.previewRef?.() || 'head';
  const width = me.ctx.previewFrame?.getBoundingClientRect?.().width;
  me.nodes.footer.textContent = footerLine({ versions, ref, current, dirty: !!b?.changes?.dirty, width });
}

// ---------- pages ----------

function openPage(p) {
  const me = st;
  const doc = me.doc;
  if (!doc || p.visible) return;
  delete me.notes[p.key];
  const view = doc.defaultView;
  if (!p.element) { // another HTML file beside the entry: load it in the frame
    try { view.location.href = new URL(p.file.split('/').pop(), doc.URL).href; } catch (err) { me.notes[p.key] = `Cannot be opened from here: ${err.message}`; renderPages(); }
    return;
  }
  if (!p.hash) { me.notes[p.key] = 'Cannot be opened from here: the page has no name to go to by hash.'; renderPages(); return; }
  try { view.location.hash = p.hash; } catch (err) { me.notes[p.key] = `Cannot be opened from here: ${err.message}`; renderPages(); return; }
  setTimeout(() => {
    if (st !== me) return;
    read();
    if (!me.pages.find((x) => x.key === p.key)?.visible) {
      me.notes[p.key] = `Cannot be opened from here: the page did not show itself for ${p.hash}.`;
      renderPages();
    }
  }, HASH_WAIT_MS);
}

// ---------- the outline ----------

function accent() {
  try { return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || undefined; } catch { return undefined; }
}

function select(part) {
  const me = st;
  me.selected = { selector: part.selector, name: part.name };
  follow();
  renderTree();
}

function deselect(draw = true) {
  const me = st;
  me.selected = null;
  if (me.doc) removeOverlay(me.doc);
  if (draw) renderTree();
}

/** Put the outline where the selected element is now (on scroll, resize and every read). */
function follow() {
  const me = st;
  if (!me?.doc || !me.selected) return;
  const target = elementAt(me.doc, me.selected.selector);
  if (!target) return deselect();
  placeOverlay(me.doc, target, me.selected.name, { accent: accent() });
}

// ---------- Point ----------

function setPoint(on, { quiet = false } = {}) {
  const me = st;
  if (!me) return;
  me.point = on;
  me.nodes.pointBtn.setAttribute('aria-pressed', String(on));
  const root = me.doc?.documentElement;
  if (root?.style) root.style.cursor = on ? 'crosshair' : '';
  if (on) {
    try { globalThis.window?.dispatchEvent?.(new CustomEvent(POINT_EVENT, { detail: { owner: 'page' } })); } catch { /* no window */ }
  }
  me.nodes.pointLine.textContent = on ? 'Point: click the preview to read the element under it. Nothing reaches the page; Esc leaves.'
    : quiet ? '' : 'Point is off: clicks reach the page again.';
}

function onFrameClick(e) {
  const me = st;
  if (!me?.point) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
  if (e.type === 'click') pointAt(e.target);
}

function onFrameKey(e) {
  if (e.key === 'Escape' && st?.point) { e.preventDefault(); e.stopPropagation(); setPoint(false); }
}

function onPanelKey(e) {
  if (e.key === 'Escape' && st?.point) { e.preventDefault(); e.stopPropagation(); setPoint(false); }
}

async function pointAt(target) {
  const me = st;
  const element = describeElement(target, { page: me.visible, url: me.doc?.URL || '' });
  if (!element) return;
  const turn = ++me.inspectTurn;
  me.selected = { selector: element.selector, name: elementName(element) };
  follow();
  renderTree();
  me.readout = { element, candidates: null };
  renderReadout();
  let answer;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(me.ctx.projectId)}/page/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inspectBody(element, fileOfUrl(element.url))),
    });
    const data = await res.json().catch(() => null);
    answer = res.ok ? data : { error: data?.error?.message || `the route answered ${res.status}` };
  } catch (err) { answer = { error: err.message }; }
  if (st !== me || me.inspectTurn !== turn) return;
  me.readout = { element, candidates: answer.candidates || [], searched: answer.searched || null, error: answer.error || null };
  renderReadout();
  tellReadout();
}

function renderReadout() {
  const me = st;
  const box = me.nodes.readout;
  const r = me.readout;
  if (!r) return clear(box);
  const { element } = r;
  const row = (k, v) => el('div.phone-kv', el('span.meta', k), v);
  const files = r.candidates === null ? el('span.meta', 'Searching the entry\'s folder…')
    : r.error ? el('span.meta', `Files not searched: ${r.error}`)
      : r.candidates.length ? el('div.phone-files', r.candidates.map((c) => button(candidateRef(c), { small: true, variant: 'quiet', class: 'mono', title: `Open ${candidateRef(c)} in the Source tab (matches ${(c.matched || []).join(', ')})`, onclick: () => openSource(c) })),
        button('Copy', { small: true, variant: 'quiet', title: 'Copy these files as file:line, one per line', onclick: () => copy(r.candidates.map(candidateRef).join('\n'), `${r.candidates.length} file${r.candidates.length === 1 ? '' : 's'} as file:line`) }))
        : el('span.meta', `No file holds its id, classes or text${r.searched ? ` in ${r.searched}` : ''}`);
  clear(box,
    row('Element', el('code', elementName(element))),
    row('Text', element.text ? el('span', element.text) : el('span.meta', 'no text')),
    row('Page', el('span', `${element.page?.name || 'a page'}${element.url ? ` · ${pageRef(element)}` : ''}`)),
    row('Files', files),
    r.candidates === null ? null : el('div.phone-files',
      button('Pin', { small: true, title: 'Keep this point for the companion: it is listed under the Companion thread and can ride a message', onclick: () => pin(r) }),
      button('Copy for a task', { small: true, onclick: () => copy(pointTaskText(r), 'The element, its page and its first files') })));
}

async function pin(readout) {
  const me = st;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(me.ctx.projectId)}/companion/pins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pinFromPoint(readout)),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) throw new Error(out?.error?.message || `the route answered ${res.status}`);
    if (st === me) toast(`Pinned ${out.element}: it is listed under the Companion thread`, { tone: 'ok' });
  } catch (err) {
    if (st === me) toast(`Pin: ${err.message}`, { tone: 'danger' });
  }
}

/** A file:line button opens the file at the line in the Source tab (app.openSource; decision row 67 revised). */
function openSource(c) {
  const open = st?.ctx.app?.openSource;
  if (typeof open !== 'function') return toast('The Source tab is not available here', { tone: 'danger' });
  return open({ path: c.file, line: c.line });
}

async function copy(text, what = text) {
  const ok = await copyText(text);
  toast(ok ? `Copied ${what}` : 'Could not copy to the clipboard', { tone: ok ? 'neutral' : 'danger' });
}

/** Tests only: the panel's state. */
export const _state = () => st;
