// Source dock tab (docs/ARCHITECTURE.md section 15): the project's files, read-only. Left, a tree of the project
// folder from GET /files (folders closed until opened and listed when opened; .git, .studio and node_modules are the
// route's to leave out; tool folders such as .github or __pycache__ are left out behind "n tool folders hidden · Show",
// isToolFolder; dist is shown, since for some products it is authored source). Right, the chosen file as plain
// mono text with line numbers, the path above it with Copy path, and the opened line marked and scrolled into view.
// Files changed since the current version (bundle.changes) carry a dot. Nothing here writes: PUT /files is never used.
// The one way in from elsewhere is app.openSource({ path, line }) (client/app.js), which reaches command({ open }).
// Pure parts: client/components/source-words.js.
import { el, clear, button, toast, copyText } from '/components/ui.js';
import {
  CUT_BYTES, LINE_PX, NOT_TEXT, childPath, parentOf, foldersAbove, changedFrom, cutWords, linesOf, gutterOf, lineIn,
  scrollFor, projectRel, isToolFolder,
} from '/components/source-words.js';

const STACK_PX = 640; // narrower than this, the tree sits above the text
const POLL_MS = 5000; // while the tab is on screen, how often GET /changes is asked (the server does not watch sources)

let st = null;

export function mount(container, ctx) {
  const me = {
    ctx, container, dirs: new Map(), open: new Set(), file: null, focus: null, offs: [], poll: null, turn: 0,
    changed: changedFrom(ctx.app?.state?.bundle), pendingScroll: null, checking: false, showTools: false,
  };
  st = me;
  container.classList?.add('source-host');
  const n = (me.nodes = {});
  n.tree = el('ul.source-tree', { role: 'tree', 'aria-label': 'Project files', onkeydown: onTreeKey });
  n.treeNote = el('p.meta', { role: 'status' });
  n.toolsRow = el('p.meta.source-tools', { hidden: true });
  n.path = el('code.source-path');
  n.pathMeta = el('span.meta.source-path-meta');
  n.copy = button('Copy path', { small: true, variant: 'quiet', hidden: true, onclick: copyPath });
  n.note = el('p.meta.source-note', { role: 'status' });
  n.gutter = el('pre.source-gutter', { 'aria-hidden': 'true' });
  n.code = el('pre.source-code');
  n.mark = el('div.source-mark', { hidden: true, 'aria-hidden': 'true' });
  n.grid = el('div.source-grid', n.mark, n.gutter, n.code);
  n.text = el('div.source-text', { tabIndex: 0, role: 'region', 'aria-label': 'File text, read-only', hidden: true }, n.grid);
  n.left = el('div.source-col.source-files', el('h3.overline', 'Files'), n.treeNote, n.tree, n.toolsRow);
  n.right = el('div.source-col.source-view', el('div.source-head', n.path, n.pathMeta, n.copy), n.note, n.text);
  n.body = el('div.source-cols', n.left, n.right);
  clear(container, el('div.source-tab', n.body));
  renderFile();

  const app = ctx.app;
  // A file the studio wrote (PUT /files names it) or a .studio change: re-read the shown file when it is the one named.
  if (typeof app?.on === 'function') {
    me.offs.push(app.on('project.changed', (d) => { if (d?.projectId === ctx.projectId && d.file && d.file === me.file?.path) reread(); }));
  }
  // Back from an editor: the shown file and the changed list may both have moved.
  const onFocus = () => { recheck(); reread(); };
  globalThis.window?.addEventListener?.('focus', onFocus);
  me.offs.push(() => globalThis.window?.removeEventListener?.('focus', onFocus));
  me.poll = setInterval(() => { if (onScreen()) recheck(); }, POLL_MS);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => sizeColumns());
    ro.observe(container);
    me.offs.push(() => ro.disconnect());
  }
  loadDir('').then(() => {
    if (st !== me) return;
    if (!me.focus) me.focus = visibleItems()[0]?.path || null;
    renderTree();
  });
}

export function unmount() {
  const me = st;
  if (!me) return;
  clearInterval(me.poll);
  me.offs.forEach((off) => { try { off?.(); } catch { /* already gone */ } });
  me.container.classList?.remove('source-host');
  st = null;
}

/** The bundle changed (a version kept, files changed): the dots move, and the shown file is read again when it is one
 *  of the changed files (before or after), keeping its scroll. A new changed list also lists the open folders again. */
export function update() {
  const me = st;
  if (!me) return;
  const before = me.changed;
  me.changed = changedFrom(me.ctx.app?.state?.bundle);
  if (me.changed.sig === before.sig) return;
  const shown = me.file?.path;
  if (shown && (before.files.has(shown) || me.changed.files.has(shown))) reread();
  relistOpen();
  renderTree();
  renderPathLine();
}

/** The tab was shown (or the dock expanded): a line asked for while hidden is scrolled to now. */
export function shown() {
  if (st?.pendingScroll) applyScroll();
}

/** app.openSource and studio.show: { open: { path, line } } opens the file at the line. */
export function command(cmd = {}) {
  if (cmd.open?.path) return openFile(cmd.open.path, cmd.open.line ?? null);
  return null;
}

// ---------- reading ----------

const projectPath = () => {
  const me = st;
  return me.ctx.app?.state?.projects?.find?.((p) => p.id === me.ctx.projectId)?.path || '';
};

function onScreen() {
  const me = st;
  if (!me || me.container.hidden || globalThis.document?.hidden) return false;
  const rects = me.container.getClientRects?.();
  return rects ? rects.length > 0 : true;
}

async function loadDir(dir) {
  const me = st;
  const d = me.dirs.get(dir) || { entries: null, error: null, loading: false };
  me.dirs.set(dir, d);
  d.loading = true;
  try {
    const out = await me.ctx.api.readFile(me.ctx.projectId, dir);
    if (out?.type !== 'dir') throw new Error(`${dir || 'the project folder'} is not a folder`);
    d.entries = out.entries || [];
    d.error = null;
  } catch (err) {
    d.error = err.message || String(err);
  } finally {
    d.loading = false;
  }
  if (st === me && !dir) me.nodes.treeNote.textContent = d.error ? `The project folder could not be listed: ${d.error}` : d.entries.length ? '' : 'The project folder is empty.';
}

/** List again every loaded folder that is open (and the top), quietly; the tree redraws once all have answered. */
async function relistOpen() {
  const me = st;
  const dirs = ['', ...[...me.open].filter((p) => me.dirs.get(p)?.entries)];
  await Promise.all(dirs.map((d) => loadDir(d)));
  if (st === me) renderTree();
}

async function toggleDir(path) {
  const me = st;
  if (me.open.has(path)) { me.open.delete(path); renderTree(); return; }
  me.open.add(path);
  const d = me.dirs.get(path);
  if (!d?.entries) { me.dirs.set(path, { entries: null, error: null, loading: true }); renderTree(); await loadDir(path); }
  if (st === me) renderTree();
}

/** Open every folder above a path so its row is on screen, listing those not listed yet; a path inside a tool folder
 *  shows the tool folders, so the row is there to see. */
async function reveal(path) {
  const me = st;
  if (foldersAbove(path).some((d) => isToolFolder({ type: 'dir', name: d.split('/').pop() }))) me.showTools = true;
  for (const dir of foldersAbove(path)) {
    me.open.add(dir);
    if (!me.dirs.get(dir)?.entries) await loadDir(dir);
    if (st !== me) return;
  }
}

async function openFile(raw, line = null) {
  const me = st;
  const path = projectRel(raw, projectPath());
  const want = Number.isInteger(line) && line >= 1 ? line : null;
  const turn = ++me.turn;
  if (!path) {
    me.file = { path: String(raw), line: null, answer: null, error: `${raw} is not inside this project` };
    renderFile();
    return;
  }
  me.file = { path, line: want, answer: null, error: null, loading: true };
  me.focus = path;
  renderFile();
  await reveal(path);
  if (st !== me || turn !== me.turn) return;
  renderTree();
  let answer = null;
  let error = null;
  try { answer = await me.ctx.api.readFile(me.ctx.projectId, path, CUT_BYTES); } catch (err) { error = err.message || String(err); }
  if (st !== me || turn !== me.turn) return;
  if (answer?.type === 'dir') {
    me.file = null;
    me.open.add(path);
    if (!me.dirs.get(path)?.entries) await loadDir(path);
    if (st !== me) return;
    renderTree();
    renderFile();
    me.nodes.note.textContent = `${path} is a folder: it is open in the tree.`;
    return;
  }
  me.file = { path, line: want, answer, error, loading: false };
  me.pendingScroll = want;
  renderFile();
}

/** Read the shown file again; redraw only when its text changed, keeping the scroll. */
async function reread() {
  const me = st;
  const f = me?.file;
  if (!f?.answer || f.loading) return;
  const turn = me.turn;
  let answer;
  try { answer = await me.ctx.api.readFile(me.ctx.projectId, f.path, CUT_BYTES); } catch (err) {
    if (st === me && turn === me.turn) { f.answer = null; f.error = err.message || String(err); renderFile(); }
    return;
  }
  if (st !== me || turn !== me.turn || me.file !== f) return;
  const same = answer?.content === f.answer.content && answer?.text === f.answer.text && answer?.truncated === f.answer.truncated;
  if (same) return;
  f.answer = answer;
  f.error = null;
  renderFile({ keepScroll: true });
}

/** Ask GET /changes; when it differs from the bundle's, the bundle is loaded again (update() follows through the dock). */
async function recheck() {
  const me = st;
  if (!me || me.checking || typeof me.ctx.api?.changes !== 'function') return;
  me.checking = true;
  try {
    const changes = await me.ctx.api.changes(me.ctx.projectId);
    if (st !== me) return;
    const fresh = changedFrom({ changes, versions: me.ctx.app?.state?.bundle?.versions || [] });
    if (fresh.sig !== me.changed.sig) {
      if (typeof me.ctx.app?.loadBundle === 'function') me.ctx.app.loadBundle({ quiet: true });
      else { me.changed = fresh; renderTree(); renderPathLine(); }
    }
  } catch { /* the next tick asks again */ } finally {
    me.checking = false;
  }
}

// ---------- the tree ----------

/** The rows on screen, top to bottom: what the arrow keys walk. */
function visibleItems() {
  const me = st;
  const out = [];
  const walk = (dir, depth) => {
    for (const e of shownEntries(dir)) {
      const path = childPath(dir, e.name);
      out.push({ path, type: e.type, depth });
      if (e.type === 'dir' && me.open.has(path)) walk(path, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

/** A listed folder's entries as the tree shows them: without the tool folders unless the person asked for them. */
function shownEntries(dir) {
  const entries = st.dirs.get(dir)?.entries || [];
  return st.showTools ? entries : entries.filter((e) => !isToolFolder(e));
}

/** The tool folders left out of the tree as drawn: in the top folder and every open folder on screen. */
function hiddenToolCount() {
  const me = st;
  let n = 0;
  const walk = (dir) => {
    for (const e of me.dirs.get(dir)?.entries || []) {
      if (isToolFolder(e)) { n++; continue; }
      if (e.type === 'dir' && me.open.has(childPath(dir, e.name))) walk(childPath(dir, e.name));
    }
  };
  walk('');
  return n;
}

function renderToolsRow() {
  const me = st;
  const n = me.showTools ? 0 : hiddenToolCount();
  me.nodes.toolsRow.hidden = !n && !me.showTools;
  const words = me.showTools ? 'Tool folders shown · Hide' : `${n} tool folder${n === 1 ? '' : 's'} hidden · Show`;
  clear(me.nodes.toolsRow, button(words, {
    small: true, variant: 'quiet', 'aria-pressed': String(me.showTools),
    title: me.showTools ? 'Leave out the folders that start with a dot, __pycache__ and node_modules' : 'List the folders that start with a dot, __pycache__ and node_modules too',
    onclick: () => { me.showTools = !me.showTools; renderTree(); },
  }));
}

function itemNode(dir, e, depth) {
  const me = st;
  const path = childPath(dir, e.name);
  const isDir = e.type === 'dir';
  const open = isDir && me.open.has(path);
  const changed = isDir ? me.changed.folders.has(path) : me.changed.files.has(path);
  const words = isDir ? me.changed.folderWords : me.changed.fileWords;
  const row = el('div.source-item', {
    role: 'treeitem', tabIndex: path === me.focus ? 0 : -1, 'aria-level': String(depth),
    'aria-selected': String(!isDir && me.file?.path === path), 'aria-expanded': isDir ? String(open) : undefined,
    dataset: { path, type: e.type }, title: path, style: { paddingLeft: `${8 + (depth - 1) * 14}px` },
    onclick: () => { me.focus = path; if (isDir) toggleDir(path); else openFile(path); },
  },
  el('span.source-twisty', { 'aria-hidden': 'true' }, isDir ? (open ? '▾' : '▸') : ''),
  el('span.source-name', e.name),
  changed ? el('span.source-dot', { role: 'img', 'aria-label': words, title: words }) : null);
  let kids = null;
  if (open) {
    const d = me.dirs.get(path);
    const shown = shownEntries(path);
    kids = el('ul', { role: 'group' },
      d?.entries ? (shown.length ? shown.map((c) => itemNode(path, c, depth + 1)) : el('li.meta.source-empty', { role: 'none' }, d.entries.length ? 'Only tool folders here' : 'Empty folder'))
        : el('li.meta.source-empty', { role: 'none' }, d?.error ? `Could not list: ${d.error}` : 'Listing…'));
  }
  return el('li', { role: 'none' }, row, kids);
}

function renderTree() {
  const me = st;
  const hadFocus = me.nodes.tree.contains?.(globalThis.document?.activeElement);
  if (!visibleItems().some((x) => x.path === me.focus)) me.focus = visibleItems()[0]?.path || null;
  clear(me.nodes.tree, shownEntries('').map((e) => itemNode('', e, 1)));
  renderToolsRow();
  if (hadFocus) itemEl(me.focus)?.focus?.();
}

function itemEl(path) {
  const walk = (n) => {
    if (n?.dataset?.path === path && n.getAttribute?.('role') === 'treeitem') return n;
    for (const k of n?.children || n?.kids || []) { if (typeof k === 'object') { const hit = walk(k); if (hit) return hit; } }
    return null;
  };
  return walk(st.nodes.tree);
}

function moveTo(path) {
  const me = st;
  if (!path) return;
  me.focus = path;
  renderTree();
  itemEl(path)?.focus?.();
}

function onTreeKey(e) {
  const me = st;
  if (!me) return;
  const path = e.target?.dataset?.path ?? me.focus;
  const items = visibleItems();
  const i = items.findIndex((x) => x.path === path);
  const item = items[i];
  if (e.key === 'Tab' && !e.shiftKey) {
    if (me.file?.answer && !me.nodes.text.hidden) { e.preventDefault(); me.nodes.text.focus(); }
    return;
  }
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' '];
  if (!keys.includes(e.key) || !item) return;
  e.preventDefault();
  if (e.key === 'ArrowDown') moveTo(items[Math.min(items.length - 1, i + 1)].path);
  else if (e.key === 'ArrowUp') moveTo(items[Math.max(0, i - 1)].path);
  else if (e.key === 'Home') moveTo(items[0].path);
  else if (e.key === 'End') moveTo(items.at(-1).path);
  else if (e.key === 'ArrowRight') {
    if (item.type !== 'dir') return;
    if (!me.open.has(item.path)) toggleDir(item.path).then(() => itemEl(item.path)?.focus?.());
    else if (items[i + 1]?.depth > item.depth) moveTo(items[i + 1].path);
  } else if (e.key === 'ArrowLeft') {
    if (item.type === 'dir' && me.open.has(item.path)) { me.open.delete(item.path); moveTo(item.path); } else if (parentOf(item.path)) moveTo(parentOf(item.path));
  } else if (item.type === 'dir') toggleDir(item.path).then(() => itemEl(item.path)?.focus?.());
  else openFile(item.path).then(() => itemEl(item.path)?.focus?.());
}

// ---------- the file ----------

function renderPathLine() {
  const me = st;
  const f = me.file;
  const n = me.nodes;
  n.path.textContent = f ? f.path : '';
  n.copy.hidden = !f || !!f.error && !f.answer;
  const count = f?.answer && f.answer.text !== false ? linesOf(f.answer).length : 0;
  const at = f?.answer ? lineIn(f.line, count) : null;
  n.pathMeta.textContent = [at ? `line ${at}` : null, f && me.changed.files.has(f.path) ? me.changed.fileWords : null].filter(Boolean).join(' · ');
}

function renderFile({ keepScroll = false } = {}) {
  const me = st;
  const f = me.file;
  const n = me.nodes;
  const top = n.text.scrollTop;
  const left = n.text.scrollLeft;
  renderPathLine();
  n.mark.hidden = true;
  if (!f) {
    n.note.textContent = 'Choose a file in the tree to read it here.';
    n.text.hidden = true;
    return;
  }
  if (f.loading) { n.note.textContent = `Reading ${f.path}…`; n.text.hidden = true; return; }
  if (f.error) { n.note.textContent = `Could not open ${f.path}: ${f.error}`; n.text.hidden = true; return; }
  const a = f.answer;
  if (a.text === false) {
    n.note.textContent = NOT_TEXT;
    n.text.hidden = true;
    n.gutter.textContent = '';
    n.code.textContent = '';
    return;
  }
  const lines = linesOf(a);
  const at = lineIn(f.line, lines.length);
  n.note.textContent = [a.truncated ? cutWords(a) : null, f.line && !at ? `Line ${f.line} is past the end: the file has ${lines.length} line${lines.length === 1 ? '' : 's'}${a.truncated ? ' up to the cut' : ''}.` : null].filter(Boolean).join(' ');
  n.gutter.textContent = gutterOf(lines.length);
  n.code.textContent = lines.join('\n');
  n.text.setAttribute('aria-label', `${f.path}, read-only, ${lines.length} line${lines.length === 1 ? '' : 's'}`);
  n.text.hidden = false;
  if (at) {
    n.mark.hidden = false;
    n.mark.dataset.line = String(at);
    n.mark.style.top = `${(at - 1) * LINE_PX}px`;
  }
  if (keepScroll) { n.text.scrollTop = top; n.text.scrollLeft = left; } else if (me.pendingScroll) applyScroll();
  else { n.text.scrollTop = 0; n.text.scrollLeft = 0; }
}

/** Scroll the marked line into view; while the tab is hidden (no height) the line waits for shown(). */
function applyScroll() {
  const me = st;
  const line = me.pendingScroll;
  if (!line) return;
  const box = me.nodes.text;
  const h = box.clientHeight;
  box.scrollTop = scrollFor(line, h);
  box.scrollLeft = 0;
  if (h !== 0) me.pendingScroll = null;
}

async function copyPath() {
  const path = st?.file?.path;
  if (!path) return;
  const ok = await copyText(path);
  toast(ok ? `Copied ${path}` : 'Could not copy to the clipboard', { tone: ok ? 'neutral' : 'danger' });
}

function sizeColumns() {
  const me = st;
  const w = me?.container.getBoundingClientRect?.().width || 0;
  me?.nodes.body.classList?.toggle('stacked', w > 0 && w < STACK_PX);
}

/** Tests only: the panel's state. */
export const _state = () => st;
