// Claude Code section: Chat (headless Claude Code, one bounded API turn, or a local command)
// and Terminal (components/terminal.js). Contract: docs/ARCHITECTURE.md sections 7 and 8.
// The view only sends; SSE (app topic 'console') streams console.started / chunk / done / error.
import { el, clear, button, select, toast, toastError, confirmDialog, textarea, empty, loading, errorBox, ago, segmented, chip, stateChip, shortLabel } from '../components/ui.js';
import { sessionChipState } from '../components/status-words.js';
import { BACKENDS, backendLabel, renderTurn, orderedItems, liveTurn } from '../components/transcript.js';
import { newSessionDialog, CONTEXTS } from '../components/console-new.js';
import { mountTerminalMode, unmountTerminalMode, terminalScope, setTerminalScope } from '../components/terminal.js';
import { isAnswer } from '../components/is-answer.js';

const DEFAULT_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5'];
const SCOPES = [['project', 'This project'], ['studio', 'Studio'], ['all', 'All']];
const CTX_KEY = 'atelier.consoleContext';

let v = null;

export function mount(host, app) {
  v = {
    app, offs: [], backends: null, backendsError: null, models: DEFAULT_MODELS, sessions: null, listError: null,
    scope: sessionStorage.getItem('atelier.consoleScope') || 'project',
    selectedId: sessionStorage.getItem('atelier.consoleSession') || null,
    session: null, sessionError: null, task: null, taskLoad: 0, live: null, errors: [], running: new Set(), finished: new Set(), listTimer: null,
    nodes: {
      list: el('nav.cc-list', { 'aria-label': 'Sessions' }),
      head: el('header.cc-head'),
      log: el('div.cc-log', { role: 'log', 'aria-label': 'Transcript', 'aria-live': 'off', tabindex: '0' }),
      turns: el('div.cc-turns'),
      composer: el('div.cc-composer'),
      sr: el('div.sr-only', { role: 'status', 'aria-live': 'polite' }),
    },
  };
  const n = v.nodes;
  const chat = el('div.cc-chat', n.list, el('section.cc-main', { 'aria-label': 'Conversation' }, n.head, n.log, n.composer, n.sr));
  const termHost = el('div.cc-term');
  const newBtn = button('New session', { variant: 'primary', onclick: newSession });
  // Chat | Terminal: chat stays mounted while hidden; the terminal mounts on demand.
  const scopeSeg = segmented(SCOPES, v.scope, (k) => {
    if (v.mode === 'terminal') { setTerminalScope(k); return; }
    v.scope = k; sessionStorage.setItem('atelier.consoleScope', k); renderList(); dropOutOfScope();
  }, { label: 'Show' });
  v.scopeSeg = scopeSeg;
  const setMode = (m) => {
    v.mode = m; sessionStorage.setItem('atelier.consoleMode', m);
    chat.hidden = m === 'terminal'; termHost.hidden = m !== 'terminal'; newBtn.hidden = m === 'terminal';
    scopeSeg.set(m === 'terminal' ? terminalScope() : v.scope);
    if (m === 'terminal') mountTerminalMode(termHost, app, { onScope: (k) => scopeSeg.set(k) }); else unmountTerminalMode();
  };
  const startMode = sessionStorage.getItem('atelier.consoleMode') === 'terminal' ? 'terminal' : 'chat';
  const modeSeg = segmented([['chat', 'Chat'], ['terminal', 'Terminal']], startMode, setMode, { label: 'Mode' });
  clear(host, el('div.cc', el('div.cc-bar', modeSeg.node, scopeSeg.node, el('span.spacer'), newBtn), chat, termHost));
  v.offs.push(
    app.on('console', onEvent),
    app.on('task.changed', (d) => { if (!d?.taskId || d.taskId === v?.session?.taskId) loadTask(); }), // an event may not say which task
    app.on('sse', (d) => { if (d?.state === 'open') loadTask(); }), // a change may have passed while disconnected
    app.on('studio', () => { renderList(); renderHead(); renderComposer(); }),
    app.on('project-switch', () => { if (v.scope === 'project') { renderList(); dropOutOfScope(); } }),
  );
  // Keep the transcript pinned to the newest turn while the layout settles, unless the person scrolled up.
  v.stick = true; v.autoTop = 0;
  // Only a scroll the person makes (not one we set) can unpin it.
  n.log.addEventListener('scroll', () => { if (Math.abs(n.log.scrollTop - v.autoTop) > 2) v.stick = n.log.scrollHeight - n.log.scrollTop - n.log.clientHeight < 60; });
  v.ro = new ResizeObserver(() => { if (v?.stick) pin(); });
  v.ro.observe(n.log);
  v.ro.observe(n.turns); // content height changes too (fonts, markdown reflow)
  n.log.append(n.turns);
  renderAll();
  loadBackends();
  loadList();
  if (v.selectedId) openSession(v.selectedId, { quiet: true });
  setMode(startMode);
}

export function unmount() {
  if (!v) return;
  v.offs.forEach((off) => off());
  clearTimeout(v.listTimer);
  v.ro?.disconnect();
  unmountTerminalMode();
  v = null;
}

// ---------- data ----------
async function loadBackends() {
  try {
    const out = await v.app.api.consoleBackends();
    if (!v) return;
    v.backends = out.backends || [];
    const models = (out.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    if (models.length) v.models = models;
    v.backendsError = null;
  } catch (err) { if (v) v.backendsError = err; }
  if (v) { renderHead(); renderComposer(); }
}
const backendInfo = (id) => v.backends?.find((b) => b.id === id) || null;

async function loadList() {
  try {
    const out = await v.app.api.consoleSessions();
    if (!v) return;
    v.sessions = Array.isArray(out) ? out : out.sessions || [];
    v.listError = null;
    for (const s of v.sessions) if (s.status === 'running') v.running.add(s.id); else if (!v.live || v.live.sessionId !== s.id) v.running.delete(s.id);
  } catch (err) { if (v) v.listError = err; }
  if (v) renderList();
}
function scheduleList() { clearTimeout(v.listTimer); v.listTimer = setTimeout(() => v && loadList(), 300); }

async function openSession(id, { quiet = false } = {}) {
  if (v.selectedId !== id || !v.openedAt) v.openedAt = Date.now(); // when this session's view opened
  v.selectedId = id;
  sessionStorage.setItem('atelier.consoleSession', id);
  if (v.session?.id !== id) { v.session = null; v.live = null; v.errors = []; }
  if (!quiet) renderAll();
  try {
    const out = await v.app.api.consoleGet(id);
    if (!v || v.selectedId !== id) return;
    v.session = out.session || out;
    v.sessionError = null;
    if (v.session.status === 'running') v.running.add(id);
    else if (!v.live) v.running.delete(id);
  } catch (err) {
    if (!v || v.selectedId !== id) return;
    if (err.status === 404) { forget(); } else v.sessionError = err;
  }
  renderAll();
  loadTask();
}
/** The task the open session runs, for the header's chip. Writes come in bursts: only the newest answer counts.
 *  A task that cannot be read shows no chip rather than an old state. */
async function loadTask() {
  const s = v?.session;
  if (!s?.taskId || !s.projectId) return;
  const load = ++v.taskLoad;
  let task = null;
  try { task = (await v.app.api.task(s.projectId, s.taskId)).task; } catch { /* no chip */ }
  if (!v || v.taskLoad !== load) return;
  v.task = task;
  renderHead();
}
function forget() {
  v.selectedId = null; v.session = null; v.live = null; v.errors = []; v.openedAt = 0;
  sessionStorage.removeItem('atelier.consoleSession');
}
/** After a scope or project change: a selected session the list no longer shows is closed. */
function dropOutOfScope() {
  if (!v?.selectedId || !v.sessions) return;
  const known = v.sessions.some((s) => s.id === v.selectedId);
  if (!known || shown().some((s) => s.id === v.selectedId)) return;
  forget();
  renderAll();
}
const newLive = (id, runId, fromStart = false) => ({ sessionId: id, runId, items: [], fromStart });

// ---------- SSE ----------
function onEvent({ name, data } = {}) {
  if (!v || !data) return;
  const id = data.sessionId;
  const mine = id && id === v.selectedId;
  if (name === 'console.started') {
    v.running.add(id);
    if (mine) { v.live = newLive(id, data.runId, true); v.nodes.sr.textContent = 'Answering…'; }
  } else if (name === 'console.chunk') {
    if (!mine) return;
    v.live ||= newLive(id, data.runId);
    v.running.add(id);
    // One ordered list: text segments and tool/status events in the order they arrived.
    const items = v.live.items;
    if (data.kind === 'text') {
      const lastItem = items[items.length - 1];
      if (lastItem?.kind === 'text') lastItem.text += data.text || ''; else items.push({ kind: 'text', text: data.text || '' });
    } else items.push({ kind: data.kind, id: data.id, name: data.name, summary: data.summary, detail: data.detail, text: data.text, ok: data.ok });
    paintLive();
    return;
  } else if (name === 'console.done') {
    v.running.delete(id);
    if (data.runId) v.finished.add(data.runId);
    if (mine) {
      v.live = null;
      if (v.session && data.turn) v.session.turns = [...(v.session.turns || []), data.turn];
      v.nodes.sr.textContent = 'Answer finished.';
      openSession(id, { quiet: true }); // re-read the record: the server copy is the truth
    }
  } else if (name === 'console.error') {
    v.running.delete(id);
    if (data.runId) v.finished.add(data.runId);
    if (mine) {
      v.live = null;
      if (v.session && data.turn) v.session.turns = [...(v.session.turns || []), data.turn]; // the turn carries the error
      else v.errors.push(data.message || 'The run failed.');
      v.nodes.sr.textContent = `Error: ${data.message || 'the run failed'}`;
      openSession(id, { quiet: true });
    }
  } else return;
  scheduleList();
  if (mine) { renderLog(); renderComposer(); renderHead(); }
}

// ---------- left: the session list ----------
function renderAll() { renderList(); renderHead(); renderLog(); renderComposer(); }

const projectOf = (id) => (id ? v.app.state.projects.find((p) => p.id === id) : null);
const isStudioSession = (s) => !s.projectId || projectOf(s.projectId)?.kind === 'studio';
function shown() {
  const pid = v.app.projectId();
  return (v.sessions || [])
    .filter((s) => v.scope === 'all' || (v.scope === 'studio' ? isStudioSession(s) : s.projectId && s.projectId === pid))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
/** Answers, not turns: a question and its answer are one exchange (the list carries only turnCount). */
const answerCount = (s) => (Array.isArray(s.turns) ? s.turns.filter(isAnswer).length : s.answerCount ?? Math.floor((s.turnCount ?? 0) / 2));
const titleOf = (s) => s.title || shortLabel(s.turns?.find((t) => t.role === 'user')?.text, 60) || 'Untitled session';

function renderList() {
  if (!v) return;
  const host = v.nodes.list;
  if (!v.sessions) return clear(host, v.listError ? errorBox(v.listError, loadList) : loading('Loading sessions…'));
  const list = shown();
  if (!list.length) return clear(host, empty(v.sessions.length ? 'No sessions in this scope.' : 'No sessions yet.'));
  if (v.selectedId && !list.some((s) => s.id === v.selectedId) && v.sessions.some((s) => s.id === v.selectedId)) queueMicrotask(dropOutOfScope);
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.sid : null;
  clear(host, el('ul.list', list.map((s) => el('li',
    el('button.item', { type: 'button', 'aria-current': s.id === v.selectedId ? 'true' : undefined, dataset: { sid: s.id }, onclick: () => openSession(s.id) },
      el('span.item-line', el('span.item-title', { style: { flex: 1 } }, titleOf(s)), v.running.has(s.id) ? stateChip('Working', 'busy') : null),
      el('span.item-meta', [backendLabel(s.backend), `${answerCount(s)} answer${answerCount(s) === 1 ? '' : 's'}`, ago(s.updatedAt), v.scope !== 'project' ? projectOf(s.projectId)?.name || 'studio' : null].filter(Boolean).join(' · ')))))));
  if (focused) host.querySelector(`[data-sid="${focused}"]`)?.focus();
}

// ---------- right: one-line header + transcript ----------
const CLI_RULES = 'node, npm run, npm test and git read commands run without asking';
const STUDIO_TOOLS_TITLE = 'Studio tools: the studio\'s own tools (mcp__atelier__*) run without asking. They read the project, look at its phone, move this window and record tasks, unresolved items, memory and kept versions; none pushes, deletes, restores, exports or spends on the API.';

function renderHead() {
  if (!v) return;
  const s = v.session;
  if (!s) return clear(v.nodes.head, el('span.cc-head-line.meta', v.selectedId ? 'Loading session…' : 'No session open'));
  const p = projectOf(s.projectId);
  // A Codex session (started in the Workbench's Codex tab) names its model and the sandbox it runs in.
  const parts = [p?.name || 'Studio', backendLabel(s.backend), ...(s.backend === 'claude-code' ? [s.model, s.permissionMode, s.allowStudioCli ? CLI_RULES : null] : s.backend === 'codex' ? [s.model, `sandbox ${s.sandbox || 'read-only'}`] : []), s.taskId ? `task ${s.taskId}` : null].filter(Boolean);
  const busy = v.running.has(s.id);
  const state = sessionChipState(busy, s.taskId && v.task?.id === s.taskId ? v.task : null); // v.task may still be the last session's
  clear(v.nodes.head,
    el('span.cc-head-line.ellipsis', { title: [titleOf(s), s.cwd || p?.path || v.app.state.studio?.dir || '', s.allowStudioCli ? `${CLI_RULES}. This is not a sandbox: node can do anything a program you run can, including reading files outside the project.` : null].filter(Boolean).join('\n') }, parts.join(' · ')),
    s.permissionMode === 'bypassPermissions' ? stateChip('runs anything', 'warn', 'bypassPermissions: Claude Code runs commands and edits files without asking') : null,
    s.tools === 'studio' ? stateChip('tools', 'neutral', STUDIO_TOOLS_TITLE) : null,
    state ? chip(state) : null,
    button('Delete', { small: true, variant: 'quiet', disabled: busy, title: 'Delete this session record', onclick: remove }));
}

function renderLog() {
  if (!v) return;
  const log = v.nodes.turns;
  if (!v.selectedId) return clear(log, empty('Pick a session on the left, or start a new one.'));
  if (!v.session) return clear(log, v.sessionError ? errorBox(v.sessionError, () => openSession(v.selectedId)) : loading('Loading transcript…'));
  const turns = v.session.turns || [];
  clear(log,
    !turns.length && !v.live ? el('p.meta.cc-start', 'No turns yet. Enter sends; Shift+Enter adds a line.') : null,
    turns.map((t) => renderTurn(t, v.session)),
    v.running.has(v.session.id) ? liveNode() : null,
    v.errors.map((m) => el('div.note.danger', { role: 'alert' }, m)));
  v.stick = true;
  pin();
}

function pin() { const log = v.nodes.log; log.scrollTop = log.scrollHeight; v.autoTop = log.scrollTop; }

let liveEl = null;
/** When the run began: the server's run start if it reports one, else the last message sent. */
function runStartedAt(s) {
  const iso = s.runStartedAt || s.startedAt || [...(s.turns || [])].reverse().find((t) => t.role === 'user')?.at;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function liveNode() {
  // The "arrived before this view opened" note only when the run started > 5 s before the view
  // opened and this view did not see it start.
  const started = runStartedAt(v.session);
  const missedEarly = !v.live?.fromStart && started !== null && (v.openedAt || Date.now()) - started > 5000;
  liveEl = liveTurn(v.session, missedEarly);
  paintLive(true);
  return liveEl.node;
}
let paintQueued = false;
function paintLive(now = false) {
  if (!v?.live || !liveEl) { if (v?.live && !liveEl) renderLog(); return; }
  if (!liveEl.node.isConnected && !now) { renderLog(); return; }
  if (paintQueued && !now) return;
  const paint = () => {
    paintQueued = false;
    if (!v?.live || !liveEl) return;
    const log = v.nodes.log;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    clear(liveEl.body, orderedItems(v.live.items));
    if (stick) pin();
  };
  if (now) paint(); else { paintQueued = true; requestAnimationFrame(paint); }
}

// ---------- composer ----------
function contextFor(id) { try { return JSON.parse(sessionStorage.getItem(CTX_KEY) || '{}')[id] || 'none'; } catch { return 'none'; } }
function setContext(id, value) {
  let all = {};
  try { all = JSON.parse(sessionStorage.getItem(CTX_KEY) || '{}'); } catch { /* fresh */ }
  all[id] = value;
  sessionStorage.setItem(CTX_KEY, JSON.stringify(all));
}

function renderComposer() {
  if (!v) return;
  const c = v.nodes.composer;
  const s = v.session;
  c.hidden = !s;
  if (!s) return clear(c);
  const busy = v.running.has(s.id);
  const info = backendInfo(s.backend);
  const unavailable = v.backends && info && !info.available;
  const prev = c.querySelector('textarea');
  const hadFocus = !!prev && document.activeElement === prev;
  const ta = textarea({
    rows: 3, placeholder: busy ? 'Answering… Stop cancels the turn' : `Message ${backendLabel(s.backend)}`, 'aria-label': 'Message', disabled: busy,
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta); }
      // Escape deliberately does nothing here: no clear, no cancel.
    },
  });
  if (prev) ta.value = prev.value;
  const ctx = s.backend !== 'claude-code' && s.backend !== 'codex' // the two CLIs keep their own conversation
    ? select(CONTEXTS, contextFor(s.id), { 'aria-label': 'Context sent with the message', title: 'Context sent with the message', onchange: (e) => setContext(s.id, e.target.value) })
    : null;
  clear(c,
    unavailable ? el('div.note.warn', `${backendLabel(s.backend)} is unavailable${info.detail ? ` (${info.detail})` : ''}. ${BACKENDS[s.backend]?.fix || ''}`) : null,
    ta,
    el('div.cc-actions',
      button('Send', { variant: 'primary', disabled: busy, title: 'Send (Enter)', onclick: () => send(ta) }),
      button('Stop', { variant: 'quiet', disabled: !busy, title: 'Cancel the running turn', onclick: stop }),
      ctx));
  if (hadFocus && !busy) ta.focus();
}

async function send(ta) {
  const s = v?.session;
  const text = ta.value.trim();
  if (!s || !text || v.running.has(s.id)) return;
  const context = s.backend === 'claude-code' || s.backend === 'codex' ? undefined : contextFor(s.id);
  ta.disabled = true;
  const mine = { role: 'user', text, at: new Date().toISOString(), pending: true };
  s.turns = [...(s.turns || []), mine];
  v.errors = [];
  ta.value = '';
  renderLog();
  try {
    // claude-code/command answer 202 {runId} at once; api holds the request until its turn ends.
    const out = await v.app.api.consoleSend(s.id, { text, context });
    delete mine.pending;
    if (!v || v.session?.id !== s.id) return;
    if (out?.turn || (out?.runId && v.finished.has(out.runId))) { v.running.delete(s.id); v.live = null; openSession(s.id, { quiet: true }); return; }
    v.running.add(s.id);
    v.live ||= newLive(s.id, out?.runId || null, true);
    renderLog(); renderComposer(); renderHead(); scheduleList();
  } catch (err) {
    if (!v) return;
    s.turns = (s.turns || []).filter((t) => t !== mine);
    const busy = err.status === 409 || err.code === 'console_busy';
    toast(`${busy ? 'This session is still answering' : 'Send'}: ${err.message || err}`, { tone: 'danger' }); // times out: a refusal also stays in the transcript
    if (v.session?.id !== s.id) return;
    if (!v.running.has(s.id)) v.live = null;
    // The server may have recorded the message with an error turn (e.g. api not_configured): show its record.
    if (!busy && err.status) await openSession(s.id, { quiet: true }); else { renderLog(); renderComposer(); }
    if (!v || v.session?.id !== s.id) return;
    const recorded = (v.session.turns || []).filter((t) => t.role === 'user').at(-1)?.text === text && !busy;
    const box = v.nodes.composer.querySelector('textarea');
    if (box) { if (!box.value && !recorded) box.value = text; box.focus(); }
  }
}

async function stop() {
  const s = v?.session;
  if (!s) return;
  try { await v.app.api.consoleCancel(s.id); toast('Stop requested', { timeout: 2500 }); } catch (err) { toastError(err, 'Stop'); }
}

async function remove() {
  const s = v?.session;
  if (!s) return;
  const ok = await confirmDialog({ title: 'Delete this session?', message: `"${titleOf(s)}" and its ${answerCount(s)} answer${answerCount(s) === 1 ? '' : 's'} are removed from ~/.atelier/console. Files Claude Code changed are not touched.`, confirm: 'Delete session', variant: 'danger' });
  if (!ok || !v) return;
  try {
    await v.app.api.consoleDelete(s.id);
    if (!v) return;
    toast('Session deleted', { tone: 'ok' });
    forget();
    renderAll();
    loadList();
  } catch (err) { toastError(err, 'Delete'); }
}

// ---------- new session ----------
async function newSession() {
  const app = v.app;
  await loadBackends(); // a key or a pause may have changed since this view opened
  if (!v) return;
  const res = await newSessionDialog(app, { backends: v.backends, backendsError: v.backendsError, models: v.models, start: v.session?.backend || 'claude-code' });
  if (!res?.session || !v) return;
  const s = res.session;
  if (res.context) setContext(s.id, res.context);
  const fits = v.scope === 'all' || (v.scope === 'studio' ? isStudioSession(s) : s.projectId === app.projectId());
  if (!fits) {
    v.scope = isStudioSession(s) ? 'studio' : 'all';
    sessionStorage.setItem('atelier.consoleScope', v.scope);
    if (v.mode !== 'terminal') v.scopeSeg.set(v.scope);
  }
  v.session = s;
  await openSession(s.id);
  loadList();
  v?.nodes.composer.querySelector('textarea')?.focus();
}
