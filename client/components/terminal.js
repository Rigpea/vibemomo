// Terminal panes: real shells on this machine (server/lib/terminal.mjs, node-pty) rendered with xterm.js.
// Contract: docs/ARCHITECTURE.md sections 8 and 14. Output arrives over an EventSource per terminal (the server
// replays the scrollback on attach, so switching tabs or reloading reattaches); input and resize go over POST.
// Quick actions only type text into the active shell.
// createTerminalPane makes one pane with its own state. Two may be open at once: the Claude Code view's Terminal
// mode (mountTerminalMode, scope project | studio | all) and the Workbench dock's Terminal tab
// (workbenches/terminal/panel.js, fixed to the project). Both may attach to one shell: both get its stream, both
// can type, and the pane that resized last sets the shell's size, which the facts line says.
import { el, clear, button, select, stateChip, toast, toastError, empty, loading, errorBox, shortLabel } from './ui.js';
import { openLauncher, composeClaude } from './terminal-launch.js';

export { composeClaude };

const OPEN_TASK = (s) => !['done', 'cancelled'].includes(s);
const DEFAULT_FONT = 'Consolas, monospace';
export const RESTART_TEXT = 'This terminal ended when the studio restarted. Terminals are not kept across restarts.';
/** Where a pane lives, as the other pane's facts line names it. */
export const PLACE_NAMES = { view: 'the Claude Code view', dock: 'the dock' };

// ---------- the panes open now (for the "also open in" words) ----------
const panes = new Set();
function othersOn(pane, id) {
  if (!id) return [];
  return [...panes].filter((p) => p !== pane && p.attachedId() === id).map((p) => p.place);
}
function tellOthers(pane) { for (const p of panes) if (p !== pane) p.renderFacts(); }
/** "also open in the dock; the pane resized last sets its size", or '' when no other pane shows the shell. */
export function sharedWords(places) {
  const names = [...new Set(places)].map((p) => PLACE_NAMES[p] || p);
  return names.length ? `also open in ${names.join(' and ')}; the pane resized last sets its size` : '';
}

// ---------- the Claude Code view's pane (thin wrapper, same behaviour as before) ----------
let viewPane = null;

/** The scope (This project | Studio | All) is chosen in the Claude Code bar (views/console.js). */
export const terminalScope = () => sessionStorage.getItem('atelier.terminalScope') || 'project';
export function setTerminalScope(k) {
  sessionStorage.setItem('atelier.terminalScope', k);
  viewPane?.setScope(k);
}
export function mountTerminalMode(host, app, { onScope } = {}) {
  unmountTerminalMode();
  viewPane = createTerminalPane(host, app, { scope: terminalScope(), onScope, place: 'view' });
  return viewPane;
}
export function unmountTerminalMode() {
  viewPane?.destroy();
  viewPane = null;
}

// ---------- vendor loading (once per page, shared by every pane) ----------
let vendor = null;
function loadVendor() {
  if (vendor) return vendor;
  if (!document.querySelector('link[data-xterm]')) document.head.append(el('link', { rel: 'stylesheet', href: '/vendor/xterm/xterm.css', 'data-xterm': '1' }));
  const script = (src) => new Promise((resolve, reject) => {
    const s = el('script', { src, async: false });
    s.addEventListener('load', resolve);
    s.addEventListener('error', () => reject(new Error(`Could not load ${src} (is npm install done?)`)));
    document.head.append(s);
  });
  vendor = (window.Terminal ? Promise.resolve() : script('/vendor/xterm/xterm.js'))
    .then(() => (window.FitAddon ? null : script('/vendor/xterm/addon-fit.js')))
    .catch((err) => { vendor = null; throw err; });
  return vendor;
}

// ---------- raw calls (input and resize stay off the "Saving" chip) ----------
async function postRaw(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const e = (await res.json().catch(() => null))?.error || {};
    throw Object.assign(new Error(e.message || `POST ${url} failed (${res.status})`), { code: e.code, status: res.status });
  }
  return res.json().catch(() => ({}));
}
const enc = encodeURIComponent;
const shellName = (t) => String(t.shell || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
function cssVar(name, fallback) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
function theme() {
  const light = document.documentElement.dataset.theme === 'light';
  const base = { background: cssVar('--code-bg', light ? '#ffffff' : '#0d0f12'), foreground: cssVar('--ink', light ? '#15181d' : '#e7e9ec'), cursor: cssVar('--accent', '#6ea8fe'), cursorAccent: cssVar('--code-bg', '#0d0f12'), selectionBackground: light ? 'rgba(37, 99, 201, 0.25)' : 'rgba(110, 168, 254, 0.3)' };
  return light ? { ...base, black: '#15181d', red: '#b4232c', green: '#1d7a49', yellow: '#8a5a00', blue: '#2563c9', magenta: '#8b3fb0', cyan: '#0f7380', white: '#5a616c', brightBlack: '#6b727c', brightRed: '#c9353e', brightGreen: '#23935a', brightYellow: '#9c6700', brightBlue: '#3b77dc', brightMagenta: '#9d52c2', brightCyan: '#158593', brightWhite: '#2f343c' } : base;
}

/**
 * One terminal pane in host. Options:
 * - scope: 'project' | 'studio' | 'all' (which terminals the tabs row lists)
 * - fixedScope: the scope never changes (the dock); New terminal opens in the project only
 * - projectId: the project 'project' scope means (default: the active project)
 * - place: 'view' | 'dock', named in the other pane's facts line
 * - onScope(k): the pane changed its own scope (a terminal opened outside it)
 * - onTerms(list): the terminals the tabs row lists, after every load
 * Returns { destroy(), refresh(), setScope(k) }.
 */
export function createTerminalPane(host, app, { scope = 'project', fixedScope = false, projectId = null, place = 'view', onScope, onTerms } = {}) {
  const activeKey = place === 'view' ? 'atelier.terminalActive' : `atelier.terminalActive.${place}:${projectId || ''}`;
  const tm = {
    terms: null, listError: null, offs: [], vendorError: null, scope, dead: false,
    activeId: sessionStorage.getItem(activeKey) || null,
    xt: null, fit: null, es: null, ro: null, attachedId: null, sizeTimer: null, listTimer: null,
    inBuf: '', inQueued: false, chain: Promise.resolve(), lastSize: '',
    nodes: {
      tabs: el('div.term-tabs', { role: 'tablist', 'aria-label': 'Open terminals' }),
      actions: el('div.term-actions'),
      facts: el('div.term-facts.meta'),
      pane: el('div.term-pane'),
      exit: el('div.term-exit'),
      sr: el('div.sr-only', { role: 'status', 'aria-live': 'polite' }),
    },
  };
  const me = { place, attachedId: () => tm.attachedId, renderFacts: () => renderFacts() };
  const alive = () => !tm.dead;
  const n = tm.nodes;
  const newLabel = fixedScope ? 'Open terminal' : 'New terminal';

  // ---------- data ----------
  async function loadList() {
    try {
      const out = await app.api.terminals();
      if (!alive()) return;
      const now = Array.isArray(out) ? out : [];
      // A terminal we were showing that the server no longer knows ended with the server (a restart):
      // keep it as an ended tab with the reason instead of letting it vanish.
      const ghosts = (tm.terms || []).filter((t) => (t.lost || !t.exited) && !now.some((x) => x.id === t.id))
        .map((t) => ({ ...t, exited: true, lost: true }));
      tm.terms = [...now, ...ghosts];
      tm.listError = null;
    } catch (err) { if (alive()) tm.listError = err; }
    if (!alive()) return;
    const shownNow = shown();
    if (!shownNow.some((t) => t.id === tm.activeId)) setActive(shownNow[0]?.id || null);
    renderTabs(); renderFacts(); renderExit();
    if (tm.activeId !== tm.attachedId) attach(); else if (!tm.activeId) renderPane();
  }
  function scheduleList() { if (!alive()) return; clearTimeout(tm.listTimer); tm.listTimer = setTimeout(() => alive() && loadList(), 200); }

  const projectOf = (id) => (id ? app.state.projects?.find((p) => p.id === id) : null);
  const isStudio = (t) => !t.projectId || projectOf(t.projectId)?.kind === 'studio';
  const ownProject = () => projectId || app.projectId();
  const fits = (t) => tm.scope === 'all' || (tm.scope === 'studio' ? isStudio(t) : t.projectId === ownProject());
  function shown() {
    return (tm.terms || []).filter(fits).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  const active = () => tm.terms?.find((t) => t.id === tm.activeId) || null;
  const folderName = (t) => (t.projectId ? projectOf(t.projectId)?.name || t.projectId : 'Studio');
  function setActive(id) {
    tm.activeId = id;
    if (id) sessionStorage.setItem(activeKey, id); else sessionStorage.removeItem(activeKey);
  }

  // ---------- toolbar ----------
  function renderTabs() {
    if (!alive()) return;
    const list = shown();
    try { onTerms?.(list); } catch (err) { console.error(err); }
    const tabs = list.map((t, i) => el(`div.term-tab${t.exited ? '.exited' : ''}`, { 'aria-current': t.id === tm.activeId ? 'true' : undefined },
      el('button.term-tab-main', {
        type: 'button', role: 'tab', 'aria-selected': String(t.id === tm.activeId), title: t.exited ? `${t.cwd} · ${t.shell} · ${t.lost ? 'ended' : 'exited'}` : `${t.cwd} · ${t.shell} · pid ${t.pid}`,
        dataset: { termId: t.id },
        onclick: () => { if (t.id !== tm.activeId) { setActive(t.id); renderTabs(); renderFacts(); renderExit(); attach(); } else tm.xt?.focus(); },
      }, el('span.ellipsis', `${i + 1} · ${folderName(t)}`), el('span.muted', shellName(t)), t.exited ? stateChip(t.lost ? 'Ended' : 'Exited', 'neutral', t.lost ? RESTART_TEXT : `Exited with code ${t.exitCode ?? '?'}`) : null),
      button('', { icon: 'x', small: true, variant: 'quiet', title: t.exited ? 'Close this tab' : 'Close (ends the shell and everything running in it)', onclick: () => closeTerm(t.id) })));
    const none = fixedScope ? 'No terminal in this project' : 'No terminals in this scope';
    clear(n.tabs, tm.terms === null ? el('span.meta', tm.listError ? `Could not list terminals: ${tm.listError.message}` : 'Loading…') : tabs.length ? tabs : el('span.meta', none));
  }

  function renderActions() {
    if (!alive()) return;
    const cur = projectOf(ownProject());
    let folder = null;
    if (!fixedScope) {
      const folders = [...(cur && cur.kind !== 'studio' ? [[cur.id, cur.name]] : []), ['', 'Studio']];
      const prevFolder = n.actions.querySelector?.('select.term-folder')?.value;
      folder = select(folders, folders.some(([v]) => v === prevFolder) ? prevFolder : folders[0][0], { class: 'term-folder', 'aria-label': 'Folder for a new terminal', title: 'Folder for a new terminal' });
    }
    // The bundle's tasks are the active project's; a dock pane fixed to another project offers none.
    const bundleTasks = !projectId || app.state.bundle?.project?.id === projectId ? app.state.bundle?.tasks || [] : [];
    const tasks = bundleTasks.filter((t) => OPEN_TASK(t.status));
    const taskSel = tasks.length ? select(tasks.map((t) => [t.id, `${t.id} · ${shortLabel(t.title, 40)}`]), tasks[0].id, { class: 'term-task', 'aria-label': 'Open task to show' }) : null;
    clear(n.actions,
      folder,
      button(newLabel, {
        variant: 'quiet', small: true,
        title: fixedScope ? 'Open a shell in this project\'s folder' : 'Open a shell in the chosen folder',
        onclick: () => openTerm(fixedScope ? ownProject() : folder.value || null),
      }),
      button('Start Claude Code', { variant: 'quiet', small: true, title: 'Compose a claude command line and type it into the active terminal', onclick: launcher }),
      button('Task list', { variant: 'quiet', small: true, title: 'Types the studio task list command into the active terminal', onclick: () => typeLine(`${atelierCmd()} task list`) }),
      taskSel ? el('span.term-taskshow', taskSel, button('Show task', { variant: 'quiet', small: true, title: 'Types task show <id> into the active terminal', onclick: () => typeLine(`${atelierCmd()} task show ${taskSel.value}`) })) : null);
  }

  function renderFacts() {
    if (!alive()) return;
    const t = active();
    // The honest line, said once: these are real shells and they run as you.
    // An ended or exited shell has no process any more: no pid, and the cursor is put away.
    if (t?.exited) endCursor();
    const shared = t && !t.exited ? sharedWords(othersOn(me, tm.attachedId)) : '';
    clear(n.facts, t
      ? (t.exited
        ? [el('span.mono', t.cwd), ` · ${shellName(t)} · ${t.lost ? 'ended' : 'exited'}; the output stays readable`]
        : [el('span.mono', t.cwd), ` · ${shellName(t)} · pid ${t.pid} · a real shell on this machine; whatever runs here runs as you`, shared ? ` · ${shared}` : ''])
      : 'Real shells on this machine: whatever runs here runs as you, and claude started here uses your own login.');
  }

  function renderExit() {
    if (!alive()) return;
    const t = active();
    clear(n.exit, t?.exited ? el('div.term-exited',
      el('span.meta', t.lost ? RESTART_TEXT : `Exited with code ${t.exitCode ?? '?'}`),
      button('Close', { small: true, variant: 'quiet', onclick: () => closeTerm(t.id) }),
      button(`${newLabel} here`, { small: true, variant: 'quiet', onclick: () => openTerm(t.projectId) })) : null);
  }

  function retryVendor() {
    tm.vendorError = null;
    renderPane();
    loadVendor().then(() => alive() && loadList(), (e) => { if (alive()) { tm.vendorError = e; renderPane(); } });
  }
  function renderPane(message) {
    if (!alive()) return null;
    if (tm.vendorError) {
      // The dock says it in one line; the Claude Code view keeps its error box.
      return clear(n.pane, place === 'dock'
        ? el('div.term-vendor', { role: 'alert' }, el('span', `The terminal could not load: ${tm.vendorError.message}`), button('Retry', { small: true, variant: 'quiet', onclick: retryVendor }))
        : errorBox(tm.vendorError, retryVendor));
    }
    if (!tm.activeId) {
      const none = fixedScope ? 'No terminal open in this project. Open terminal starts your shell in its folder.' : 'No terminal open. New terminal opens your shell in the chosen folder.';
      return clear(n.pane, tm.terms === null ? (tm.listError ? errorBox(tm.listError, loadList) : loading('Loading terminals…')) : empty(message || none));
    }
    return null;
  }

  // ---------- attach / xterm ----------
  function applyTheme() { if (tm.xt) tm.xt.options.theme = theme(); }
  /** Settings › Console › Terminal font first (e.g. a Nerd Font for prompt glyphs), then the studio mono list. */
  function terminalFont() {
    const own = String(app.state.settings?.console?.terminalFont || '').trim();
    const base = cssVar('--mono', DEFAULT_FONT);
    return own ? `${own}, ${base}` : base;
  }
  function applyFont() {
    if (!tm.xt) return;
    const f = terminalFont();
    if (tm.xt.options.fontFamily === f) return;
    tm.xt.options.fontFamily = f;
    scheduleFit();
  }

  /** The attached xterm stops showing a cursor (the shell behind it is gone). */
  function endCursor() {
    const xt = tm.xt;
    if (!xt) return;
    try { xt.options.cursorBlink = false; xt.options.cursorInactiveStyle = 'none'; } catch { /* older xterm */ }
    xt.write('\x1b[?25l'); // DECTCEM: hide the cursor
    n.pane.classList.add('ended');
  }

  function detach() {
    const had = tm.attachedId;
    tm.es?.close(); tm.es = null;
    try { tm.xt?.dispose(); } catch { /* already gone */ }
    tm.xt = null; tm.fit = null; tm.attachedId = null; tm.lastSize = ''; tm.inBuf = '';
    if (had) tellOthers(me);
  }

  function attach() {
    if (!alive()) return;
    detach();
    const t = active();
    if (!t || !window.Terminal) { renderPane(); return; }
    if (t.lost) { clear(n.pane, empty(RESTART_TEXT, null, button(`${newLabel} here`, { onclick: () => openTerm(t.projectId) }))); return; }
    const id = t.id;
    tm.attachedId = id;
    n.pane.classList.remove('ended');
    const xt = new window.Terminal({ cursorBlink: true, fontFamily: terminalFont(), fontSize: 13, scrollback: 5000, theme: theme(), allowProposedApi: false });
    const fit = new window.FitAddon.FitAddon();
    xt.loadAddon(fit);
    const mountNode = el('div.term-xterm');
    clear(n.pane, mountNode);
    xt.open(mountNode);
    tm.xt = xt; tm.fit = fit;
    try { fit.fit(); } catch { /* not laid out yet */ }
    sendSize(true);
    // While the replayed scrollback is parsed, xterm would answer the old queries in it (device
    // attributes, cursor position, focus): those answers must not reach the live shell.
    let replaying = 0;
    xt.onData((d) => { if (!replaying) queueInput(d); });
    xt.onResize(() => scheduleFit());
    const es = new EventSource(`/api/terminal/${enc(id)}/stream`);
    tm.es = es;
    es.onopen = () => { if (tm.attachedId === id) xt.reset(); }; // every (re)connect replays the scrollback from the start
    es.onmessage = (e) => {
      if (tm.attachedId !== id) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m.replay) { xt.write(m.d || ''); return; }
      replaying++;
      xt.write(m.d || '', () => { replaying--; });
    };
    es.addEventListener('exit', (e) => {
      if (tm.attachedId !== id) return;
      let code = null;
      try { code = JSON.parse(e.data).code; } catch { /* none */ }
      xt.write(`\r\n\x1b[2m[exited (code ${code ?? '?'})]\x1b[0m\r\n`);
      es.close();
      const rec = tm.terms?.find((x) => x.id === id);
      if (rec) { rec.exited = true; rec.exitCode = code; }
      n.sr.textContent = `Terminal exited with code ${code ?? 'unknown'}`;
      renderTabs(); renderFacts(); renderExit();
    });
    es.onerror = () => { if (tm.attachedId === id && es.readyState === EventSource.CLOSED) scheduleList(); };
    tellOthers(me);
    renderFacts();
    xt.focus();
  }

  function scheduleFit({ force = false } = {}) {
    if (!alive()) return;
    clearTimeout(tm.sizeTimer);
    tm.sizeTimer = setTimeout(() => {
      if (!alive() || !tm.fit || !n.pane.offsetParent) return;
      try { tm.fit.fit(); } catch { /* hidden */ }
      sendSize(force);
    }, 150);
  }
  function sendSize(force = false) {
    const xt = tm.xt; const id = tm.attachedId;
    if (!xt || !id || active()?.exited) return;
    const size = `${xt.cols}x${xt.rows}`;
    if (!force && size === tm.lastSize) return;
    tm.lastSize = size;
    postRaw(`/api/terminal/${enc(id)}/resize`, { cols: Math.max(2, Math.min(500, xt.cols)), rows: Math.max(2, Math.min(500, xt.rows)) }).catch(() => { /* exited meanwhile */ });
  }

  // Input is batched per animation frame and sent in order.
  function queueInput(d) {
    if (!alive()) return;
    tm.inBuf += d;
    if (tm.inQueued) return;
    tm.inQueued = true;
    requestAnimationFrame(flushInput);
  }
  function flushInput() {
    if (!alive()) return;
    tm.inQueued = false;
    const data = tm.inBuf; const id = tm.attachedId;
    tm.inBuf = '';
    if (!data || !id) return;
    tm.chain = tm.chain.then(() => postRaw(`/api/terminal/${enc(id)}/input`, { data })).catch((err) => {
      if (err.status === 404 || err.code === 'terminal_exited') scheduleList(); else toastError(err, 'Terminal input');
    });
  }

  // ---------- actions ----------
  async function openTerm(pid) {
    if (!alive()) return;
    const cols = tm.xt?.cols || 100; const rows = tm.xt?.rows || 30;
    try {
      const t = await app.api.terminalOpen({ projectId: pid || null, cols, rows });
      if (!alive()) return;
      if (!fixedScope && !fits(t)) { tm.scope = isStudio(t) ? 'studio' : 'all'; sessionStorage.setItem('atelier.terminalScope', tm.scope); onScope?.(tm.scope); }
      setActive(t.id);
      tm.terms = [...(tm.terms || []).filter((x) => x.id !== t.id), t];
      renderTabs(); renderFacts(); renderExit(); attach();
    } catch (err) {
      toastError(err, err.code === 'terminal_limit' ? 'terminal_limit' : newLabel);
    }
  }

  async function closeTerm(id) {
    if (!alive()) return;
    // Stop streaming and sending to it first, so nothing (a reconnect, a queued keystroke or a
    // focus report) reaches a terminal that no longer exists.
    if (tm.activeId === id) { detach(); setActive(null); }
    const rec = tm.terms?.find((t) => t.id === id);
    try {
      // A ghost has no shell left; an exited shell's record is still on the server and goes with DELETE.
      if (!rec?.lost) await app.api.terminalClose(id);
    } catch (err) { if (err.status !== 404) toastError(err, 'Close terminal'); }
    if (!alive()) return;
    tm.terms = (tm.terms || []).filter((t) => t.id !== id);
    loadList();
  }

  /** Type a line into the active terminal (text + Enter unless enter is false). Nothing is interpreted. */
  async function typeLine(text, { enter = true } = {}) {
    const t = active();
    if (!t || t.exited || !tm.attachedId) { toast(`Open a terminal first (${newLabel}).`, { timeout: 3500 }); return false; }
    tm.chain = tm.chain.then(() => postRaw(`/api/terminal/${enc(t.id)}/input`, { data: enter ? `${text}\r` : text })).catch((err) => toastError(err, 'Terminal'));
    tm.xt?.focus();
    return true;
  }

  function atelierCmd() {
    const studioDir = app.state.studio?.dir || '';
    const t = active();
    const inStudio = t && studioDir && t.cwd.toLowerCase() === studioDir.toLowerCase();
    if (inStudio || !studioDir) return 'node bin/atelier.mjs';
    const sep = studioDir.includes('\\') ? '\\' : '/';
    return `node "${studioDir}${sep}bin${sep}atelier.mjs"`;
  }

  // ---------- Start Claude Code launcher ----------
  function launcher() {
    if (!alive()) return;
    openLauncher({ app, term: active(), folderName, newLabel, typeLine, focus: () => tm.xt?.focus() });
  }

  // ---------- mount ----------
  clear(host, el(`div.term${place === 'dock' ? '.term-docked' : ''}`,
    el('div.term-head', el('div.term-row', n.tabs, n.actions), n.facts),
    n.exit, n.pane, n.sr));
  panes.add(me);
  tm.offs.push(
    app.on('terminal', () => scheduleList()),
    app.on('project-switch', () => { renderActions(); if (tm.scope === 'project' && !projectId) renderTabs(); }),
    app.on('bundle', () => renderActions()),
    app.on('layout', () => applyTheme()),
    app.on('studio', () => applyFont()),
  );
  if (typeof ResizeObserver === 'function') {
    tm.ro = new ResizeObserver(() => scheduleFit());
    tm.ro.observe(n.pane);
  }
  renderActions(); renderTabs(); renderFacts();
  loadVendor().then(() => alive() && loadList(), (err) => { if (!alive()) return; tm.vendorError = err; renderPane(); });

  return {
    /** Stops the stream and the observers and empties the host. */
    destroy() {
      if (tm.dead) return;
      tm.offs.forEach((off) => off());
      clearTimeout(tm.sizeTimer); clearTimeout(tm.listTimer);
      tm.ro?.disconnect();
      detach();
      tm.dead = true;
      panes.delete(me);
      tellOthers(me);
      host.replaceChildren();
    },
    /** The pane was shown or its box changed: refit, and take the shell's size (the pane shown last sets it). */
    refresh() { scheduleFit({ force: true }); renderFacts(); },
    setScope(k) {
      if (fixedScope || !alive()) return;
      tm.scope = k;
      loadList();
    },
    /** Tests only. */
    _state: () => tm,
  };
}
