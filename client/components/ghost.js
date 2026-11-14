// The ghost marker (docs/ARCHITECTURE.md section 4, "Who is working where"): while a session of the open project
// reports tool calls, a faint label in the preview's corner says who does what ("Claude Code · editing welcome.css ·
// 4 s ago"); when the edited file is one the page in view uses it adds "on this page" and offers Reload the preview;
// a part the studio links to that file (a pin, the Page or Phone readout on screen) gets a soft outline in the frame.
// The Page tab dots edited pages and the Phone screen carries the same words, plus a running build's step.
// Nothing here is guessed: a marker comes only from a call a session reported (app 'console' events), an outline only
// from a link the studio holds, a build only from the run the server reported (state.runs). The preview never reloads
// by itself; the person presses Reload.
// The model (ghostOf and its words) has no DOM; createGhost draws it with the el/button it is handed, so
// tests/ghost.test.mjs runs both on stubs.
import { toolVerb, toolObject, brainLine } from './companion-words.js';
import { projectRel } from './source-words.js';
import { OVERLAY_ID, outlineBox, elementAt, fileOfUrl } from '../../workbenches/page/pages.js';

export const GHOST_MS = 30 * 1000; // a call shows this long; a page's dot stays this long after its run ends
export const GHOST_OUTLINE_ID = `${OVERLAY_ID}-ghost`;
export const MAX_CALLS = 50; // calls kept per project; only the newest one names the label
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const BACKEND_WORDS = { 'claude-code': 'Claude Code', api: 'API', command: 'Command', codex: 'Codex' };

const bare = (name) => String(name || '').replace(/^mcp__.+?__/, '');
const slashes = (s) => String(s ?? '').trim().replace(/\\/g, '/');
const lastPart = (p) => slashes(p).split('/').filter(Boolean).pop() || '';
const cut = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Who runs a session, in words: "Claude Code" for the claude-code backend (the default), else the backend's name. */
export const whoOf = (s) => BACKEND_WORDS[s?.backend || 'claude-code'] || 'A session';
/** The longer line for a tooltip: brainLine for Claude Code ("Claude Code · Opus 5.5 · your login"). */
export const whoTitle = (s) => ((s?.backend || 'claude-code') === 'claude-code' ? brainLine(s?.model) : whoOf(s));

export const isEdit = (call) => EDIT_TOOLS.has(bare(call?.name));

/** The file an editing call names, as its summary carries it (server/lib/console.mjs toolSummary), or null. */
export function editedFile(call) {
  if (!isEdit(call)) return null;
  const s = String(call.summary ?? '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try { const o = JSON.parse(s); const f = o.file_path ?? o.notebook_path ?? o.path; return typeof f === 'string' ? f : null; } catch { return null; }
  }
  return s;
}

/** How long ago, short: "just now", "4 s ago", "2 min ago". */
export function agoShort(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** What a call does, in words after the who: "editing welcome.css", "running npm run check", "reading app.js". */
export function doingWords(call) {
  const b = bare(call?.name);
  if (isEdit(call)) return `editing ${lastPart(editedFile(call)) || 'a file'}`;
  const obj = cut(toolObject(call?.summary, call?.name));
  if (b === 'Bash' || b === 'PowerShell' || b === 'Shell') return obj ? `running ${obj}` : 'running a command';
  if (b === 'Read' || b === 'atelier_read_file') return obj ? `reading ${obj}` : 'reading a file';
  if (b === 'Grep') return obj ? `searching ${obj}` : 'searching';
  if (b === 'Glob') return obj ? `finding ${obj}` : 'finding files';
  const verb = toolVerb(call?.name);
  return [verb.charAt(0).toLowerCase() + verb.slice(1), obj || null].filter(Boolean).join(' ');
}

/** A running build's words: "Building and installing · step 2 of 3 · gradlew" (no step yet: the first part alone). */
export function buildWords(build) {
  if (!build) return '';
  const s = build.step;
  return ['Building and installing', s ? `step ${s.index} of ${s.of}` : null, s?.label || null].filter(Boolean).join(' · ');
}

/** The project's running build from the runs the server reported (state.runs): its step read from the run's latest
 *  ("2 of 3 · gradlew", server/lib/devices/android.mjs), or null when no build of this project runs. */
export function buildOfRuns(runs = [], projectId) {
  const r = (runs || []).find((x) => x?.kind === 'build' && x.projectId === projectId && !x.endedAt);
  if (!r) return null;
  const m = /^(\d+) of (\d+) · (.+)$/.exec(String(r.latest || ''));
  return { step: m ? { index: Number(m[1]), of: Number(m[2]), label: m[3] } : null };
}

/** The part↔file links the studio holds: every pin with a selector and files, and the readout on screen
 *  ({ selector, element, files }). Files read "path:line" or "path"; the link keeps the path. */
export function linksOf(pins = [], readouts = []) {
  const out = [];
  const add = (selector, name, files, source) => {
    if (!selector) return;
    for (const f of files || []) {
      const file = slashes(String(f).replace(/:\d+(:\d+)?$/, ''));
      if (file) out.push({ selector, name: name || selector, file, source });
    }
  };
  for (const p of pins || []) add(p?.selector, p?.element, p?.files, 'pin');
  for (const r of readouts || []) if (r) add(r.selector, r.element, r.files, 'readout');
  return out;
}

/**
 * The marker's model. edits: the project's reported tool calls [{ sessionId, name, summary, at }] (at in ms);
 * sessions: id -> { projectId, backend, model, running, endedAt }; pageFiles: project-relative files the page in view
 * uses; entry and htmlFiles: the entry and the sibling pages; pins and readouts: the part↔file links; build: the
 * running build ({ step }) or null; reloadedAt: when the frame last loaded (ms); root: the project's folder.
 * Returns { label, title, file, onPage, parts, pages, reload, phone, nextAt }:
 * - label: the newest call of a session of this project in the last 30 s, one line; else the build's words; else ''.
 * - parts: [{ selector, name, file, source }] linked to a file edited since the frame loaded, while the label shows.
 * - pages: [{ file, title }] the entry or sibling pages edited since the frame loaded, while their run goes on or for
 *   30 s after it ended; reload: such an edit touched a file the page in view uses.
 * - phone: the build's words while one runs, else the label. nextAt: when the model next changes with no new call.
 */
export function ghostOf({ projectId = null, edits = [], sessions = {}, pageFiles = [], entry = null, htmlFiles = [], pins = [], readouts = [], build = null, reloadedAt = 0, root = '', now = Date.now() } = {}) {
  const sessionOf = (id) => (sessions instanceof Map ? sessions.get(id) : sessions?.[id]) || null;
  const mine = projectId ? (edits || []).filter((c) => sessionOf(c.sessionId)?.projectId === projectId) : [];
  const rel = (c) => { const f = editedFile(c); return f ? projectRel(f, root) : null; };
  const used = new Set([...(pageFiles || []), entry].filter(Boolean).map(slashes));
  const pageSet = new Set([entry, ...(htmlFiles || [])].filter(Boolean).map(slashes));
  const recent = mine.filter((c) => now - c.at < GHOST_MS);
  const newest = recent.reduce((a, c) => (!a || c.at >= a.at ? c : a), null);

  let label = '';
  let phoneLabel = ''; // the phone's copy: "on this page" speaks of the preview, so the phone leaves it out
  let title = '';
  let file = null;
  let onPage = false;
  if (newest) {
    const s = sessionOf(newest.sessionId);
    file = rel(newest);
    onPage = !!file && used.has(file);
    title = whoTitle(s);
    phoneLabel = isEdit(newest) ? [whoOf(s), doingWords(newest), agoShort(now - newest.at)].join(' · ') : `${whoOf(s)} · ${doingWords(newest)}`;
    label = onPage ? `${phoneLabel} · on this page` : phoneLabel;
  }

  // Parts: only while the label shows, for edits since the frame loaded (a reload takes the outline away).
  const parts = [];
  if (label) {
    const edited = new Set(recent.filter((c) => isEdit(c) && c.at > reloadedAt).map(rel).filter(Boolean));
    const seen = new Set();
    for (const l of linksOf(pins, readouts)) {
      if (!edited.has(l.file) || seen.has(l.selector)) continue;
      seen.add(l.selector);
      parts.push(l);
    }
  }

  // Pages and Reload: edits since the frame loaded, while their run goes on or for 30 s after it ended.
  const held = (s) => !!s && (s.running || (Number.isFinite(s.endedAt) && now - s.endedAt < GHOST_MS));
  const kept = mine.filter((c) => isEdit(c) && c.at > reloadedAt && held(sessionOf(c.sessionId))).sort((a, b) => b.at - a.at);
  const pages = [];
  let reload = false;
  for (const c of kept) {
    const f = rel(c);
    if (!f) continue;
    if (used.has(f)) reload = true;
    if (pageSet.has(f) && !pages.some((p) => p.file === f)) pages.push({ file: f, title: `edited by ${whoOf(sessionOf(c.sessionId))} · ${agoShort(now - c.at)}` });
  }

  const buildLine = buildWords(build);
  const times = [
    ...recent.map((c) => c.at + GHOST_MS),
    ...kept.map((c) => sessionOf(c.sessionId)).filter((s) => !s.running && Number.isFinite(s.endedAt)).map((s) => s.endedAt + GHOST_MS),
  ].filter((t) => t > now);
  return {
    label: label || buildLine, title: label ? title : buildLine ? 'The phone build the studio started' : '',
    file, onPage, parts, pages, reload, phone: buildLine || phoneLabel,
    nextAt: times.length ? Math.min(...times) : null,
  };
}

/** The files the document in the frame uses, project-relative: its own file, its scripts and styles, and every
 *  resource the frame's window loaded from the preview (modules imported later too). [] when it cannot be read. */
export function pageFilesOf(doc) {
  if (!doc) return [];
  const urls = [];
  try { urls.push(doc.URL); } catch { /* no URL */ }
  try { for (const n of doc.querySelectorAll?.('script[src], link[href]') || []) urls.push(n.src || n.href || n.getAttribute?.('src') || n.getAttribute?.('href')); } catch { /* not readable */ }
  try { for (const e of doc.defaultView?.performance?.getEntriesByType?.('resource') || []) urls.push(e.name); } catch { /* no timing */ }
  const base = String(doc.URL || 'http://studio.local/');
  const files = urls.filter(Boolean).map((u) => { try { return fileOfUrl(new URL(u, base).href); } catch { return null; } });
  return [...new Set(files.filter(Boolean))];
}

// ---------- the soft outline in the frame ----------

/** The element a link's selector names in doc: a Page path (selectorOf) first, then a CSS selector; null when
 *  nothing there matches or it has no box (a hidden screen). */
export function partElement(doc, selector) {
  let n = null;
  try { n = elementAt(doc, selector); } catch { n = null; }
  if (!n) { try { n = doc?.querySelector?.(selector) || null; } catch { n = null; } }
  const r = n?.getBoundingClientRect?.();
  return r && r.width > 0 && r.height > 0 ? n : null;
}

/** One holder (GHOST_OUTLINE_ID) in the frame's document with a box per part, at half the Page outline's strength;
 *  pointer-events none. No part found: the holder goes. Returns the number of boxes placed. */
export function placeGhostOutlines(doc, parts = [], { accent = '#8ab4ff' } = {}) {
  if (!doc) return 0;
  const found = parts.map((p) => ({ p, n: partElement(doc, p.selector) })).filter((x) => x.n);
  if (!found.length) { removeGhostOutlines(doc); return 0; }
  let holder = doc.getElementById?.(GHOST_OUTLINE_ID);
  if (!holder) {
    holder = doc.createElement('div');
    holder.id = GHOST_OUTLINE_ID;
    holder.setAttribute?.('aria-hidden', 'true');
    (doc.documentElement || doc.body).appendChild(holder);
  }
  Object.assign(holder.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', pointerEvents: 'none', zIndex: '2147483645', margin: '0', padding: '0' });
  const view = doc.defaultView || {};
  const boxes = found.map(({ p, n }) => {
    const box = outlineBox(n.getBoundingClientRect(), view.scrollX || view.pageXOffset || 0, view.scrollY || view.pageYOffset || 0);
    const b = doc.createElement('div');
    b.setAttribute?.('data-selector', p.selector);
    Object.assign(b.style, {
      position: 'absolute', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
      border: `1.5px solid ${accent}`, borderRadius: '3px', boxSizing: 'border-box', opacity: '0.5', pointerEvents: 'none',
    });
    return b;
  });
  for (const k of Array.from(holder.children || [])) k.remove?.();
  for (const b of boxes) holder.appendChild(b);
  return boxes.length;
}

export function removeGhostOutlines(doc) {
  const node = doc?.getElementById?.(GHOST_OUTLINE_ID);
  if (node) node.remove();
  return !!node;
}

// ---------- the controller ----------

/**
 * The Workbench's ghost: one per mount. frame is the preview iframe, reload() loads it again (the Workbench's Try),
 * h = { el, button } from client/components/ui.js. node goes in the preview-wrap's corner. setProject(bundle) on a
 * project switch, leave() when the project leaves the screen, destroy() on unmount. Every draw emits
 * app 'ghost' { projectId, model } for the Page and Phone panels.
 */
export function createGhost(app, { frame, reload, h, accent = () => undefined, now = () => Date.now() }) {
  const dot = h.el('span.ghost-dot', { 'aria-hidden': 'true' });
  const text = h.el('span.ghost-label');
  const reloadBtn = h.button('Reload the preview', { small: true, variant: 'quiet', class: 'ghost-reload', title: 'A session changed a file this page uses: load the preview again from the files on disk', onclick: () => reload?.() });
  const node = h.el('div.preview-ghost', { hidden: true }, dot, text, reloadBtn);
  const st = { projectId: null, root: '', entry: null, htmlFiles: [], pins: [], readouts: {}, edits: [], sessions: new Map(), asked: new Set(), reloadedAt: 0, timer: null, wake: null, model: null, gen: 0 };
  const offs = [];

  const doc = () => { try { return frame?.contentDocument || null; } catch { return null; } };
  const projectPath = () => app.state?.projects?.find?.((p) => p.id === st.projectId)?.path || app.state?.bundle?.project?.path || '';

  /** A session from a list or a record: its project, backend and model. What the events said about its run (an entry
   *  made by onConsole before the record came) stays; a session met only through a list takes the list's status. */
  function noteSession(s) {
    if (!s?.id) return;
    const prev = st.sessions.get(s.id);
    st.sessions.set(s.id, {
      projectId: s.projectId ?? null, backend: s.backend || prev?.backend, model: s.model ?? prev?.model,
      running: prev?.heard ? prev.running : s.status === 'running', endedAt: prev?.heard ? prev.endedAt : null, heard: !!prev?.heard,
    });
  }
  const met = (sid) => st.sessions.get(sid)?.projectId !== undefined;

  /** A call from a session the ghost has not met: its record names its project. Asked once per session. */
  async function meet(sid) {
    if (met(sid) || st.asked.has(sid) || typeof app.api?.consoleGet !== 'function') return;
    st.asked.add(sid);
    const gen = st.gen;
    try {
      const out = await app.api.consoleGet(sid);
      if (gen !== st.gen) return;
      noteSession({ ...(out?.session || out), id: sid });
      draw();
    } catch { st.asked.delete(sid); }
  }

  function onConsole({ name, data } = {}) {
    const sid = data?.sessionId;
    if (!sid || !st.projectId) return;
    const t = now();
    if (!st.sessions.has(sid)) st.sessions.set(sid, { projectId: undefined, running: false, endedAt: null, heard: true });
    const s = st.sessions.get(sid);
    s.heard = true;
    if (name === 'console.started' || name === 'console.chunk') {
      s.running = true; s.endedAt = null;
      if (name === 'console.chunk' && data.kind === 'tool') {
        st.edits.push({ sessionId: sid, name: data.name, summary: data.summary, at: t });
        if (st.edits.length > MAX_CALLS) st.edits.splice(0, st.edits.length - MAX_CALLS);
      }
    } else if (name === 'console.done' || name === 'console.error') {
      s.running = false; s.endedAt = t;
    } else return;
    if (!met(sid)) meet(sid);
    draw();
  }

  async function loadPins() {
    const pid = st.projectId;
    if (!pid || typeof app.api?.companionPins !== 'function') return;
    try {
      const out = await app.api.companionPins(pid);
      if (st.projectId !== pid) return;
      st.pins = out?.pins || [];
      draw();
    } catch { /* no pins: no outline from them */ }
  }

  function onFrameLoad() {
    st.reloadedAt = now();
    removeGhostOutlines(doc());
    draw();
  }

  function stopClock() {
    clearInterval(st.timer); st.timer = null;
    clearTimeout(st.wake); st.wake = null;
  }

  /** Once a second while a label shows; otherwise one wake-up when a dot or the Reload button is due to go. */
  function clock(model) {
    if (model?.label) {
      clearTimeout(st.wake); st.wake = null;
      if (!st.timer) st.timer = setInterval(draw, 1000);
      return;
    }
    clearInterval(st.timer); st.timer = null;
    clearTimeout(st.wake); st.wake = null;
    if (model?.nextAt) st.wake = setTimeout(draw, Math.max(50, model.nextAt - now() + 20));
  }

  function draw() {
    const d = doc();
    const model = st.projectId ? ghostOf({
      projectId: st.projectId, edits: st.edits, sessions: st.sessions, pageFiles: pageFilesOf(d), entry: st.entry, htmlFiles: st.htmlFiles,
      pins: st.pins, readouts: Object.values(st.readouts), build: buildOfRuns(app.state?.runs, st.projectId), reloadedAt: st.reloadedAt, root: projectPath(), now: now(),
    }) : null;
    st.model = model;
    const show = !!model && (!!model.label || model.reload);
    node.hidden = !show;
    dot.hidden = !model?.label;
    text.textContent = model?.label || '';
    node.title = model?.title || '';
    reloadBtn.hidden = !model?.reload;
    if (d) {
      if (model?.parts.length) placeGhostOutlines(d, model.parts, { accent: accent() });
      else removeGhostOutlines(d);
    }
    clock(model);
    app.emit?.('ghost', { projectId: st.projectId, model });
  }

  frame?.addEventListener?.('load', onFrameLoad);
  offs.push(() => frame?.removeEventListener?.('load', onFrameLoad));
  if (typeof app.on === 'function') {
    offs.push(app.on('console', onConsole));
    offs.push(app.on('runs', () => { if (st.projectId) draw(); }));
    offs.push(app.on('pins', (e) => { if (e?.projectId === st.projectId) loadPins(); }));
    // The Page and Phone panels publish the readout now on screen: { projectId, source, selector, element, files } or no selector.
    offs.push(app.on('ghost-readout', (r) => {
      if (!r || r.projectId !== st.projectId) return;
      if (r.selector) st.readouts[r.source || 'page'] = { selector: r.selector, element: r.element, files: r.files || [] };
      else delete st.readouts[r.source || 'page'];
      draw();
    }));
  }

  function reset() {
    st.gen++;
    stopClock();
    removeGhostOutlines(doc());
    Object.assign(st, { projectId: null, root: '', entry: null, htmlFiles: [], pins: [], readouts: {}, edits: [], sessions: new Map(), asked: new Set(), reloadedAt: 0, model: null });
  }

  return {
    node,
    /** A new project on screen: what the last one had goes; its running sessions, pins and pages are read. */
    async setProject(bundle) {
      reset();
      const pid = bundle?.project?.id || null;
      st.projectId = pid;
      st.entry = bundle?.manifest?.entry ? slashes(bundle.manifest.entry).replace(/^\/+/, '') : null;
      draw();
      if (!pid) return;
      const gen = st.gen;
      const sessions = app.api?.consoleSessions ? app.api.consoleSessions(pid).catch(() => null) : null;
      const files = app.api?.pageFiles ? app.api.pageFiles(pid).catch(() => null) : null;
      loadPins();
      const [list, pf] = await Promise.all([sessions, files]);
      if (gen !== st.gen) return;
      for (const s of (Array.isArray(list) ? list : list?.sessions || [])) noteSession(s);
      if (pf) { st.entry = pf.entry ? slashes(pf.entry).replace(/^\/+/, '') : st.entry; st.htmlFiles = pf.siblings || []; }
      draw();
    },
    leave() { reset(); draw(); },
    destroy() { reset(); offs.forEach((off) => off?.()); node.hidden = true; },
    model: () => st.model,
    _state: st,
  };
}
