// Inspiration (docs/DESIGN.md section 10, docs/ARCHITECTURE.md section 22): the board where the open project collects
// design references. A head with the project's name and count and one field that adds what is typed (a link, a hex
// color, a note); a row of the tags in use as a filter; then the board, a grid of cards packed by height in board
// order. An image comes by paste, by drop or by a file pick, anywhere on the view; a card is edited in a dialog, moved
// by drag or Alt with an arrow, removed after one question. The records are the server's (.studio/inspiration.json),
// so every change is sent and the board is read again; a refusal is the server's sentence in a toast.
import { el, clear, button, input, empty, errorBox, loading, toast, toastError, confirmDialog } from '../components/ui.js';
import { cardNode } from '../components/inspiration-card.js';
import { editCardDialog } from '../components/inspiration-edit.js';
import { mountRules } from '../components/rules-panel.js';
import { mountReferences } from '../components/references-panel.js';
import { mountVisualizer } from '../components/visualizer-panel.js';
import { olderServer } from '../components/skills-panel.js';
import { detectKind, addLabel, tagsInUse, filterCards, stepTarget, dropTarget, moved, spanFor, estimateHeight, fileProblem, countWords, cardName, removeWords, PICK_HINT, EMPTY_WORDS } from '../components/inspiration-words.js';

const CARD_DRAG = 'application/x-atelier-card';
const tagByProject = new Map(); // the filter each project was left on, for this window
let ui = null;

export function mount(host, app) {
  const title = el('h1', 'Inspiration');
  const count = el('span.meta.inspo-count');
  const field = input({ name: 'inspiration-add', placeholder: 'Paste a link, a hex color or a few words…', 'aria-label': 'Add a link, a color or a note', autocomplete: 'off', spellcheck: false });
  const addBtn = button('Add', { variant: 'primary', type: 'submit' }); // stays enabled: with nothing typed it sends the focus to the field
  const pick = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', multiple: true, hidden: true, 'aria-hidden': 'true', tabIndex: -1 });
  const pickBtn = button('Choose images', { title: 'Add image files from this computer (PNG, JPEG, WebP, GIF, SVG)', onclick: () => pick.click() });
  const form = el('form.inspo-add', { onsubmit: (e) => { e.preventDefault(); addTyped(); } }, field, addBtn, pickBtn, pick);
  const filter = el('div.inspo-filter', { role: 'group', 'aria-label': 'Filter by tag', hidden: true });
  const status = el('div.inspo-status', { role: 'status', hidden: true });
  const live = el('p.sr-only', { 'aria-live': 'polite' });
  const board = el('ol.inspo-board', { 'aria-label': 'Inspiration board' });
  const scroll = el('div.inspo-scroll', board);
  // The view's four parts (DESIGN.md sections 11, 13 and 14): the board of what the person likes, the fixed rules
  // saying what must stay the same, the references to build from, and the Visualizer, which draws what the project's
  // stylesheets really hold beside the first two. The address says which (#/inspiration, #/inspiration/rules,
  // #/inspiration/references, #/inspiration/visualizer), so a reload keeps it.
  const rulesN = el('span.inspo-seg-n');
  const refsN = el('span.inspo-seg-n');
  const segBtn = (v, ...words) => el('button', { type: 'button', 'aria-pressed': 'false', dataset: { v }, onclick: () => setMode(v) }, ...words);
  const seg = el('div.seg', { role: 'group', 'aria-label': 'Part of Inspiration' }, segBtn('board', 'Board'), segBtn('rules', 'Fixed rules', rulesN), segBtn('references', 'References', refsN), segBtn('visualizer', 'Visualizer'));
  const rulesHost = el('div.rules', { hidden: true });
  const rules = mountRules(rulesHost, app, { onChange: () => renderHead() });
  const refsHost = el('div.refs', { hidden: true });
  const refs = mountReferences(refsHost, app, { onChange: () => renderHead() });
  const vizHost = el('div.viz', { hidden: true });
  const viz = mountVisualizer(vizHost, app, { onChange: () => renderHead() });
  // The filter and the status words share one row that is always there, so the board never jumps when words appear.
  const bar = el('div.inspo-bar', filter, status);
  const root = el('div.inspo', el('header.inspo-head', title, seg, count, el('span.spacer'), form, rules.addButton, refs.addButton, viz.readButton, viz.taskButton), bar, live, scroll, rulesHost, refsHost, vizHost);
  clear(host, root);

  ui = { app, root, count, field, addBtn, filter, status, live, board, scroll, form, bar, seg, rulesN, rulesHost, rules, refsN, refsHost, refs, vizHost, viz, mode: 'board', pid: null, cards: null, defaults: [], limits: {}, error: null, tag: null, busy: [], picking: false, dropDepth: 0, drag: null, seq: 0, timer: null, offs: [], observer: null };
  if (typeof ResizeObserver === 'function') ui.observer = new ResizeObserver((entries) => { for (const e of entries) setSpan(e.target, e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight); });

  field.addEventListener('input', syncAdd);
  pick.addEventListener('change', () => { addFiles([...pick.files]); pick.value = ''; });
  const onPaste = (e) => paste(e);
  document.addEventListener('paste', onPaste);
  ui.offs.push(() => document.removeEventListener('paste', onPaste));
  root.addEventListener('dragenter', (e) => { if (isOutside(e)) { e.preventDefault(); ui.dropDepth++; setDropping(true); } });
  root.addEventListener('dragleave', (e) => { if (isOutside(e) && --ui.dropDepth <= 0) setDropping(false); });
  root.addEventListener('dragover', (e) => { if (isOutside(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  root.addEventListener('drop', (e) => { if (isOutside(e)) { e.preventDefault(); setDropping(false); dropped(e.dataTransfer); } });
  board.addEventListener('dragstart', dragStart);
  board.addEventListener('dragover', dragOver);
  board.addEventListener('drop', dragDrop);
  board.addEventListener('dragend', dragEnd);

  ui.offs.push(app.on('project-switch', sync));
  ui.offs.push(app.on('bundle', sync));
  ui.offs.push(app.on('studio', renderHead));
  ui.offs.push(app.on('inspiration', (d) => { if (ui && (!d?.projectId || d.projectId === ui.pid)) later(); }));
  ui.offs.push(app.on('sse', (d) => { if (ui && d?.state === 'open' && d.prev === 'down') load(); }));
  window.addEventListener('hashchange', applyMode);
  ui.offs.push(() => window.removeEventListener('hashchange', applyMode));
  applyMode();
  sync();
}

export function unmount() {
  if (!ui) return;
  stopPicking();
  clearTimeout(ui.timer);
  ui.rules.unmount();
  ui.refs.unmount();
  ui.viz.unmount();
  ui.observer?.disconnect();
  ui.offs.forEach((off) => off());
  ui = null;
}

/** Tests and drivers only. */
export const _ui = () => ui;

// ---------- the four parts: the board, the fixed rules, the references and the Visualizer ----------
const RULES_HASH = '#/inspiration/rules';
const REFS_HASH = '#/inspiration/references';
const VIZ_HASH = '#/inspiration/visualizer';
const names = (hash) => location.hash === hash || location.hash.startsWith(`${hash}/`);
const modeOfHash = () => (names(RULES_HASH) ? 'rules' : names(REFS_HASH) ? 'references' : names(VIZ_HASH) ? 'visualizer' : 'board');
function setMode(mode) {
  location.hash = mode === 'rules' ? RULES_HASH : mode === 'references' ? REFS_HASH : mode === 'visualizer' ? VIZ_HASH : '#/inspiration';
  applyMode(); // the hashchange that follows finds it done
}
/** Show the part the address names. Off the board its hands are still: no drop, no paste, no eyedropper. */
function applyMode() {
  if (!ui || !/^#\/inspiration(\/|$)/.test(location.hash || '#/inspiration')) return;
  const mode = modeOfHash();
  if (mode !== ui.mode) { stopPicking(); setDropping(false); }
  ui.mode = mode;
  for (const b of ui.seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === mode));
  for (const node of [ui.form, ui.bar, ui.scroll]) node.hidden = mode !== 'board';
  ui.rulesHost.hidden = mode !== 'rules';
  ui.rules.addButton.hidden = mode !== 'rules';
  ui.refsHost.hidden = mode !== 'references';
  ui.refs.addButton.hidden = mode !== 'references';
  ui.vizHost.hidden = mode !== 'visualizer';
  ui.viz.taskButton.hidden = ui.viz.readButton.hidden = mode !== 'visualizer';
  ui.viz.show(mode === 'visualizer'); // it reads the files when it comes on screen, not before
  renderHead();
}

// ---------- the project and its board ----------
const projectName = () => ui.app.state.projects.find((p) => p.id === ui.pid)?.name || '';

function sync() {
  if (!ui) return;
  const pid = ui.app.projectId();
  if (pid === ui.pid) return;
  stopPicking();
  ui.pid = pid;
  Object.assign(ui, { cards: null, snapshot: null, error: null, tag: tagByProject.get(pid) || null, busy: [], picking: false });
  render();
  if (pid) load();
}

async function load({ focusId = null } = {}) {
  const me = ui;
  const pid = me.pid;
  if (!pid) return;
  const seq = ++me.seq;
  try {
    const out = await me.app.api.inspiration(pid);
    if (ui !== me || me.pid !== pid || seq !== me.seq) return;
    const snapshot = JSON.stringify([out.cards || [], out.defaultTags || []]);
    // The board as it already stands (the echo of this window's own change): the nodes, the focus and an open
    // eyedropper stay as they are.
    const same = !me.error && me.cards !== null && snapshot === me.snapshot;
    Object.assign(me, { cards: out.cards || [], defaults: out.defaultTags || [], limits: out.limits || {}, error: null, snapshot });
    if (same) return focusCard(focusId);
  } catch (err) {
    if (ui !== me || me.pid !== pid || seq !== me.seq) return;
    Object.assign(me, { error: err, snapshot: null });
  }
  render({ focusId });
}

function focusCard(id) {
  const node = id ? [...ui.board.children].find((n) => n.dataset.card === id) : null;
  if (!node) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView?.({ block: 'nearest' });
}

/** A change someone else made (another window, the companion, a hand edit): read again once it has been quiet. */
function later() {
  clearTimeout(ui.timer);
  ui.timer = setTimeout(() => { if (ui && !ui.drag) load(); }, 150);
}

// ---------- adding ----------
function syncAdd() {
  const found = detectKind(ui.field.value);
  ui.addBtn.disabled = !ui.pid;
  ui.addBtn.querySelector('span').textContent = addLabel(found);
}

/** Send one card. words: what the status line says while it is on its way; focus: false leaves the focus where it
 *  is (the eyedropper goes on picking). Resolves the card, or null when refused. */
async function add(body, words, { focus = true } = {}) {
  const me = ui;
  const pid = me.pid;
  if (!pid) return null;
  me.busy.push(words);
  renderStatus();
  try {
    const card = await me.app.api.addInspiration(pid, body);
    if (ui === me && me.pid === pid) await load({ focusId: focus ? card.id : null });
    return card;
  } catch (err) {
    toastError(err, 'Inspiration');
    return null;
  } finally {
    me.busy.splice(me.busy.indexOf(words), 1);
    if (ui === me) renderStatus();
  }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'the page'; } };
function addFound(found, opts) {
  if (found.kind === 'link') return add({ kind: 'link', url: found.url }, `Fetching the preview of ${hostOf(found.url)}…`, opts);
  if (found.kind === 'color') return add({ kind: 'color', hex: found.hex }, `Adding ${found.hex}…`, opts);
  return add({ kind: 'note', text: found.text }, 'Adding the note…', opts);
}

async function addTyped() {
  const found = detectKind(ui.field.value);
  if (!found) return ui.field.focus();
  const typed = ui.field.value;
  ui.field.value = '';
  syncAdd();
  // The focus stays in the field for the next one. A refused card goes back in it, unless something else was typed since.
  if (!(await addFound(found, { focus: false })) && ui && !ui.field.value) { ui.field.value = typed; syncAdd(); }
}

const asBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error(`${file.name || 'The file'} could not be read`));
  r.readAsDataURL(file);
});

/** Files from a pick, a drop or the clipboard, one card each, in turn. What a file is, the server reads from its bytes. */
async function addFiles(files) {
  for (const file of files) {
    if (!ui) return;
    const problem = fileProblem(file, ui.limits);
    if (problem) { toastError(new Error(problem), 'Inspiration'); continue; }
    let data;
    try { data = await asBase64(file); } catch (err) { toastError(err, 'Inspiration'); continue; }
    await add({ kind: 'image', data, name: file.name || '' }, `Adding ${file.name || 'the image'}…`);
  }
}

/** A text that arrived by paste or drop: a link or a color is added at once; other words wait in the field for Add. */
function addText(text) {
  const found = detectKind(text);
  if (!found) return;
  if (found.kind !== 'note') { addFound(found); return; }
  ui.field.value = found.text;
  syncAdd();
  ui.field.focus();
}

function paste(e) {
  if (!ui || !ui.pid || ui.mode !== 'board' || document.querySelector('dialog[open]')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); return; }
  if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return; // typing: the paste is the field's
  const text = e.clipboardData?.getData('text/plain') || '';
  if (text.trim()) { e.preventDefault(); addText(text); }
}

/** A drag from outside the board (files, a link, a text), not one of its own cards. */
const isOutside = (e) => { const types = [...(e.dataTransfer?.types || [])]; return !!ui?.pid && ui.mode === 'board' && !types.includes(CARD_DRAG) && types.some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain'); };
function setDropping(on) {
  if (!on) ui.dropDepth = 0;
  ui.root.classList.toggle('dropping', on);
  renderStatus();
}
function dropped(data) {
  const files = [...(data.files || [])];
  if (files.length) return addFiles(files);
  const link = (data.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  return addText(link || data.getData('text/plain') || '');
}

// ---------- a card's actions ----------
const shownIds = () => filterCards(ui.cards, ui.tag).map((c) => c.id);
const say = (words) => { clear(ui.live, words); };

async function edit(card) {
  const me = ui;
  const saved = await editCardDialog(card, { defaultTags: me.defaults, cards: me.cards, limits: me.limits, save: (patch) => me.app.api.patchInspiration(me.pid, card.id, patch) });
  if (saved && ui === me) load({ focusId: card.id });
}

async function remove(card) {
  const me = ui;
  const ok = await confirmDialog({ title: 'Remove card', message: removeWords(card, projectName()), confirm: 'Remove', variant: 'danger', cancel: 'Keep it' });
  if (!ok || ui !== me) return;
  const ids = shownIds();
  const next = ids[ids.indexOf(card.id) + 1] || ids[ids.indexOf(card.id) - 1] || null;
  try {
    await me.app.api.removeInspiration(me.pid, card.id);
    toast(`Removed: ${cardName(card)}`, { tone: 'ok', timeout: 2500, clears: 'Inspiration' });
    if (ui === me) load({ focusId: next });
  } catch (err) { toastError(err, 'Inspiration'); if (ui === me) load(); }
}

/** Put a card before another (null: at the end): shown at once, then sent; a refusal reads the board again. */
async function move(id, before, words) {
  const me = ui;
  const order = moved(me.cards.map((c) => c.id), id, before);
  me.cards = order.map((x) => me.cards.find((c) => c.id === x));
  me.snapshot = JSON.stringify([me.cards, me.defaults]); // what the server will answer once it has moved it
  render({ focusId: id });
  say(words);
  try { await me.app.api.moveInspiration(me.pid, { id, before }); } catch (err) { toastError(err, 'Inspiration'); if (ui === me) load({ focusId: id }); }
}
function step(card, delta) {
  const ids = shownIds();
  const before = stepTarget(ids, card.id, delta);
  if (before === undefined) return say(delta < 0 ? 'Already first' : 'Already last');
  const other = before ? ui.cards.find((c) => c.id === before) : null;
  move(card.id, before, other ? `Moved before ${cardName(other)}` : 'Moved to the end');
}

const pickColor = (card, hex) => add({ kind: 'color', hex, from: card.id, after: card.id }, `Adding ${hex}…`, { focus: false });
const stopPicking = () => ui?.board.querySelector('.inspo-card.picking')?.stopPick();

// ---------- drag to reorder ----------
const cardOf = (e) => e.target.closest?.('.inspo-card');
function dragStart(e) {
  const li = cardOf(e);
  if (!li || ui.picking) { e.preventDefault(); return; }
  ui.drag = li.dataset.card;
  e.dataTransfer.setData(CARD_DRAG, ui.drag);
  e.dataTransfer.effectAllowed = 'move';
  li.classList.add('dragging');
}
function clearDropMarks() { for (const n of ui.board.querySelectorAll('.drop-before, .drop-after')) n.classList.remove('drop-before', 'drop-after'); }
function dragOver(e) {
  if (!ui.drag) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const li = cardOf(e);
  clearDropMarks();
  if (!li || li.dataset.card === ui.drag) return;
  const r = li.getBoundingClientRect();
  li.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
}
function dragDrop(e) {
  if (!ui.drag) return;
  e.preventDefault();
  const li = cardOf(e);
  const id = ui.drag;
  const after = li?.classList.contains('drop-after');
  dragEnd();
  if (!li) return;
  const before = dropTarget(shownIds(), id, li.dataset.card, after);
  if (before !== undefined) move(id, before, 'Moved');
}
function dragEnd() {
  if (!ui) return;
  clearDropMarks();
  ui.board.querySelector('.dragging')?.classList.remove('dragging');
  ui.drag = null;
}

// ---------- render ----------
function setSpan(node, height) { if (height > 0) node.style.gridRowEnd = `span ${spanFor(height)}`; }

function renderHead() {
  if (!ui) return;
  const total = ui.cards?.length ?? 0;
  const n = ui.rules.count();
  clear(ui.rulesN, n ? String(n) : '');
  ui.rulesN.hidden = !n;
  const r = ui.refs.count();
  clear(ui.refsN, r ? String(r) : '');
  ui.refsN.hidden = !r;
  if (ui.mode === 'rules') clear(ui.count, ui.rules.words());
  else if (ui.mode === 'references') clear(ui.count, ui.refs.words());
  else if (ui.mode === 'visualizer') clear(ui.count, ui.viz.words());
  else clear(ui.count, ui.cards ? countWords(projectName(), total, filterCards(ui.cards, ui.tag).length, ui.tag) : projectName());
  ui.field.disabled = !ui.pid;
  syncAdd();
}

function renderStatus() {
  if (!ui) return;
  const words = ui.root.classList.contains('dropping') ? `Drop to add to ${projectName() || 'this project'}'s board` : ui.busy[0] || (ui.picking ? PICK_HINT : '');
  clear(ui.status, ui.busy.length && !ui.root.classList.contains('dropping') ? loading(words) : words);
  ui.status.hidden = !words;
}

function renderFilter() {
  const tags = tagsInUse(ui.cards || [], ui.defaults);
  if (ui.tag && !tags.some((t) => t.tag === ui.tag)) { ui.tag = null; tagByProject.delete(ui.pid); }
  ui.filter.hidden = !tags.length;
  const choose = (tag) => { ui.tag = tag; if (tag) tagByProject.set(ui.pid, tag); else tagByProject.delete(ui.pid); render(); ui.filter.querySelector('[aria-pressed="true"]')?.focus(); };
  const one = (tag, words, n) => el('button.inspo-filter-tag', { type: 'button', 'aria-pressed': String(ui.tag === tag), onclick: () => choose(tag) }, words, el('span.inspo-filter-n', String(n)));
  clear(ui.filter, one(null, 'All', ui.cards?.length || 0), tags.map((t) => one(t.tag, t.tag, t.count)));
}

function render({ focusId = null } = {}) {
  if (!ui) return;
  const me = ui;
  me.observer?.disconnect();
  renderFilter();
  renderHead();
  renderStatus();
  // The card whose image is being picked from keeps its node, so the eyedropper goes on while its swatches arrive.
  const picking = me.board.querySelector('.inspo-card.picking');
  const held = picking?.contains(document.activeElement) ? document.activeElement : null;
  // A redraw rebuilds the cards: the one that held the focus holds it again.
  const keepId = focusId || me.board.querySelector('.inspo-card:focus-within')?.dataset.card || null;
  const fill = (node) => { picking?.stopPick(); clear(me.board); me.board.hidden = true; me.scroll.querySelector('.inspo-fill')?.remove(); me.scroll.append(el('div.inspo-fill', node)); };
  me.scroll.querySelector('.inspo-fill')?.remove();
  me.board.hidden = false;
  if (!me.pid) return fill(empty('Create a project first; its inspiration board appears here.'));
  if (me.error && olderServer(me.error)) { // a window newer than the server it talks to
    return fill(empty('This studio server started before the Inspiration board existed, so it has no route for it yet. Restart it to load the new code (Ctrl+Alt+R).', null, button('Restart the studio', { onclick: () => me.app.restart() })));
  }
  if (me.error) return fill(errorBox(me.error, () => load()));
  if (me.cards === null) return fill(loading('Reading the board…'));
  if (!me.cards.length) return fill(empty(EMPTY_WORDS));
  const ctx = { projectId: me.pid, onEdit: edit, onRemove: remove, onMove: step, onPick: pickColor, onPicking: (on) => { me.picking = on; renderStatus(); } };
  const colWidth = me.board.querySelector('.inspo-card')?.offsetWidth || 280;
  const nodes = filterCards(me.cards, me.tag).map((card) => {
    if (picking?.dataset.card === card.id) return picking;
    const node = cardNode(card, ctx);
    setSpan(node, estimateHeight(card, colWidth)); // a first guess; the observer below measures
    return node;
  });
  if (picking && !nodes.includes(picking)) picking.stopPick();
  clear(me.board, nodes);
  for (const n of nodes) me.observer?.observe(n);
  if (held?.isConnected && !focusId) held.focus({ preventScroll: true });
  else focusCard(keepId);
}
