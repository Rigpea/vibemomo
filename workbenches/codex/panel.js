// Codex workbench panel (docs/ARCHITECTURE.md section 21): a Codex CLI session in the dock, beside the Companion
// (workbenches/companion/panel.js), on the login the person saved with `codex login`. The same layout and the same
// parts as the Companion (client/components/session-parts.js): left, the thread with the pins and the composer;
// right, the trajectory under a one-word state and its reason. The head names the brain ("Codex · <model> · your
// ChatGPT login") and holds the three choices: the model, the effort and the sandbox, which reads in words which one
// is on. The session is an ordinary console session (backend 'codex', tools 'studio'); its id lives in
// project.ui.codexSessionId, the kept model and effort in project.ui.codex. A new session starts read-only.
// Nothing here claims a state: every word comes from GET /api/console/codex, the session record or the console events.
import { el, clear, button, select, textarea, empty, toast } from '/components/ui.js';
import { addChunk, runStart, drawThread, drawLive, drawTrajectory, drawState, drawPins } from '/components/session-parts.js';
import { pinChip, messageWithPins, isStacked } from '/components/companion-words.js';
import { CODEX_SANDBOXES, SANDBOX_TITLE, codexModelOptions, codexEffortOptions, takesEffort, effortWords, codexModelName, codexBrainLine, codexChoices, codexProblem, codexState, CODEX_HINT, codexPlaceholder } from '/components/codex-words.js';

let st = null;
const drafts = new Map(); // project id -> what was in the box when the panel unmounted

export function mount(container, ctx) {
  const me = {
    ctx, container, status: null, statusError: null, session: null, sessionError: null, loading: false, running: false, live: null,
    pins: [], pinsError: null, selected: new Set(), model: '', effort: '', sandbox: 'read-only', chose: false,
    stacked: false, trajOpen: false, timer: null, offs: [], ro: null, keptDraft: drafts.get(ctx.projectId) || '',
  };
  drafts.delete(ctx.projectId);
  st = me;
  container.classList?.add('companion-host');
  container.classList?.add('codex-host');
  const n = (me.nodes = {});
  n.brain = el('span.cmp-brain');
  n.choices = el('div.cmp-choices');
  n.headActions = el('div.cmp-head-actions');
  n.log = el('div.cmp-log', { role: 'log', 'aria-label': 'Codex thread', tabIndex: 0 });
  n.problem = el('div.cdx-problem');
  n.pins = el('div.cmp-pins', { 'aria-label': 'Pins' });
  n.composer = el('div.cmp-composer');
  n.state = el('div.cmp-state'); // not a live region: the Working clock changes every second
  n.rows = el('div.cmp-traj-rows', { 'aria-label': 'Tool calls of the run' });
  n.thread = el('section.cmp-thread', { 'aria-label': 'Thread' }, n.log, n.problem, n.pins, n.composer);
  n.traj = el('section.cmp-traj', { 'aria-label': 'Trajectory' }, n.state, n.rows);
  n.split = el('div.cmp-split', n.thread, n.traj);
  clear(container, el('div.companion.codex', el('header.cmp-head', n.brain, n.choices, el('span.spacer'), n.headActions), n.split));

  me.offs.push(
    ctx.app.on('console', onEvent),
    ctx.app.on('pins', (d) => { if (!d?.projectId || d.projectId === me.ctx.projectId) loadPins(); }),
    ctx.app.on('sse', (d) => { if (d?.state === 'open') { loadStatus(); loadSession(); loadPins(); } }),
  );
  if (typeof ResizeObserver === 'function') {
    me.ro = new ResizeObserver((entries) => setStacked(isStacked(entries[entries.length - 1].contentRect.width)));
    me.ro.observe(container);
  }
  render();
  loadStatus();
  loadSession();
  loadPins();
}

export function unmount() {
  const me = st;
  if (!me) return;
  const draft = me.nodes.composer.querySelector?.('textarea')?.value || me.keptDraft || '';
  if (draft) drafts.set(me.ctx.projectId, draft);
  st = null;
  clearInterval(me.timer);
  me.ro?.disconnect();
  me.offs.forEach((off) => off());
  me.container.classList?.remove('companion-host');
  me.container.classList?.remove('codex-host');
}

/** The bundle was refreshed: another window may have started or dropped the session. */
export function update() {
  const me = st;
  if (me && storedId() !== (me.session?.id || null) && !me.loading) loadSession();
}

/** Tests only. */
export const _state = () => st;
export const _forget = () => drafts.clear();
export const _setStacked = (on) => setStacked(on);

// ---------- data ----------
const storedId = () => st?.ctx.project?.ui?.codexSessionId || null;

/** The session's choices are the record's; before a session they are the person's kept ones, else config.toml's. */
function adopt() {
  const me = st;
  if (me.session) Object.assign(me, { model: me.session.model || '', effort: me.session.effort || '', sandbox: me.session.sandbox || 'read-only' });
  else if (!me.chose && me.status) Object.assign(me, codexChoices(me.ctx.project?.ui, me.status));
}

/** The CLI, the login, the models and config.toml's defaults (fresh: ask `codex login status` again now). */
async function loadStatus(fresh = false) {
  const me = st;
  try {
    const out = await me.ctx.api.codexStatus(fresh);
    if (st !== me) return;
    me.status = out;
    me.statusError = null;
    adopt();
  } catch (err) {
    if (st !== me) return;
    me.statusError = err;
  }
  render();
}

async function loadSession() {
  const me = st;
  const id = storedId();
  if (!id) { me.session = null; setRunning(false); adopt(); return render(); }
  me.loading = true;
  try {
    const s = await me.ctx.api.consoleGet(id);
    if (st !== me) return;
    me.session = s.session || s;
    me.sessionError = null;
    adopt();
    if (me.session.status === 'running') {
      if (!me.running) me.live = { items: [], startedAt: runStart(me.session), missed: true }; // its first rows came before this mount
      setRunning(true);
    } else setRunning(false);
  } catch (err) {
    if (st !== me) return;
    if (err.status === 404) { me.session = null; me.goneId = id; me.ctx.saveUi({ codexSessionId: null }).catch(() => {}); } // deleted in the Claude Code view
    else me.sessionError = err;
  } finally {
    if (st === me) me.loading = false;
  }
  if (st === me) render();
}

async function loadPins() {
  const me = st;
  try {
    const out = await me.ctx.api.companionPins(me.ctx.projectId);
    if (st !== me) return;
    me.pins = out.pins || [];
    me.pinsError = null;
    for (const id of [...me.selected]) if (!me.pins.some((p) => p.id === id)) me.selected.delete(id);
  } catch (err) {
    if (st !== me) return;
    me.pinsError = err;
  }
  paint(renderPins, renderComposer);
}

function setRunning(on) {
  const me = st;
  me.running = on;
  clearInterval(me.timer);
  me.timer = on ? setInterval(() => { if (st === me) paint(renderState); }, 1000) : null;
  if (!on) me.live = null;
}

// ---------- console events (the app's 'console' topic, as the Companion reads them) ----------
function onEvent({ name, data } = {}) {
  const me = st;
  if (!me || !data || !me.session || data.sessionId !== me.session.id) return;
  if (name === 'console.started') {
    me.live = { items: [], startedAt: Date.now(), runId: data.runId };
    setRunning(true);
  } else if (name === 'console.chunk') {
    if (!me.running) { me.live = { items: [], startedAt: Date.now(), runId: data.runId }; setRunning(true); }
    addChunk(me.live, data);
    paint(renderLive, renderTraj, renderState);
    return;
  } else if (name === 'console.done' || name === 'console.error') {
    setRunning(false);
    if (data.turn) me.session.turns = [...(me.session.turns || []), data.turn];
    if (data.turn?.signedOut) loadStatus(true); // the run found no login: the head and the note say so
    loadSession(); // the record is the truth
  } else return;
  render();
}

// ---------- render ----------
function render() {
  const me = st;
  if (!me) return;
  me.ctx.setNote?.(me.session ? `Session / ${me.session.title || me.session.id}` : '');
  let failed = null;
  for (const part of [renderHead, renderThread, renderProblem, renderPins, renderComposer, renderTraj, renderState]) {
    try { part(); } catch (err) { failed ||= err; }
  }
  if (failed) drawFailed(failed); else me.drawError = null;
}

/** Runs parts outside render() (a chunk, the clock); a throw goes to the same note. */
function paint(...parts) {
  if (!st) return;
  for (const part of parts) {
    try { part(); } catch (err) { drawFailed(err); }
  }
}

function drawFailed(err) {
  const me = st;
  const message = err?.message || String(err);
  if (me.drawError !== message) console.error('Codex view could not be drawn', err); // once per failure, not per tick
  me.drawError = message;
  try {
    clear(me.nodes.log, el('div.note.danger.cmp-draw-error', { role: 'alert' },
      `The Codex view could not be drawn: ${message}. `,
      button('Retry', { small: true, onclick: () => { me.drawError = null; if (me.session || storedId()) loadSession(); else render(); } })));
  } catch { /* the note itself could not be drawn; the console has the error */ }
}

/** A choice made in the head. With a session it is set on the session first (the record is what runs) and shown only
 *  once the server took it; the model and the effort are also kept per project for the next session. */
async function choose(key, value) {
  const me = st;
  const patch = { [key]: value };
  if (key === 'model' && !takesEffort(me.status, value, me.effort)) {
    // The person's new model does not take the effort they had: it goes to Codex's default for it, and they are told.
    patch.effort = '';
    toast(`${codexModelName(me.status, value)} does not take ${effortWords(me.effort).toLowerCase()}: the effort is now Codex's default for it.`);
  }
  if (me.session) {
    try {
      const out = await me.ctx.api.consolePatch(me.session.id, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === '' ? null : v])));
      if (st !== me || !me.session) return;
      Object.assign(me.session, { model: out.model, effort: out.effort, sandbox: out.sandbox });
      adopt();
    } catch (err) {
      if (st === me) { toast(`Not set on the session: ${err.message}`, { tone: 'danger' }); paint(renderHead); }
      return;
    }
  } else { me.chose = true; Object.assign(me, patch); }
  if (key !== 'sandbox') (me.ctx.saveUi?.({ codex: { model: me.model, effort: me.effort } }) || Promise.resolve()).catch((err) => toast(`Choice not kept: ${err.message}`, { tone: 'danger' }));
  if (st === me) paint(renderHead);
}

function renderHead() {
  const me = st;
  const s = me.session;
  me.nodes.brain.textContent = codexBrainLine(me.status, me.model);
  me.nodes.brain.title = s ? `${s.title || 'Codex'} · ${s.id}${s.codexThreadId ? ` · Codex thread ${s.codexThreadId}` : ''}${me.status?.version ? ` · ${me.status.version}` : ''}` : 'The session starts on Start';
  const off = me.running || !me.status;
  clear(me.nodes.choices,
    select(codexModelOptions(me.status, me.model), me.model, { 'aria-label': 'The model that answers', title: `The model that answers (the list is ${me.status?.source === 'built-in' ? 'the studio\'s short built-in one: Codex\'s own list could not be read' : 'Codex\'s own'})`, disabled: off, onchange: (e) => choose('model', e.target.value) }),
    select(codexEffortOptions(me.status, me.model), me.effort, { 'aria-label': 'How hard it thinks', title: 'How hard it thinks (Codex\'s reasoning effort for this model)', disabled: off, onchange: (e) => choose('effort', e.target.value) }),
    select(CODEX_SANDBOXES, me.sandbox, { 'aria-label': 'The sandbox Codex runs in', title: SANDBOX_TITLE, class: me.sandbox === 'workspace-write' ? 'cdx-write' : '', disabled: off, onchange: (e) => choose('sandbox', e.target.value) }));
  clear(me.nodes.headActions,
    s ? button('New session', { small: true, variant: 'quiet', disabled: me.running, title: 'Start over with a new Codex session, read-only; this one stays in the Claude Code view', onclick: newSession }) : null);
}

function renderThread() {
  const me = st;
  const log = me.nodes.log;
  if (me.sessionError) return clear(log, el('div.note.danger', { role: 'alert' }, `The Codex session could not be read: ${me.sessionError.message}`), button('Retry', { small: true, onclick: loadSession }));
  // A stored id not read yet: say so, never Start (Start would make a second session over the first).
  if (!me.session && storedId() && storedId() !== me.goneId) return clear(log, el('p.meta.cmp-hint', 'Reading the Codex session…'));
  if (!me.session) {
    const blocked = !me.status || !!codexProblem(me.status);
    // One sentence and the action (DESIGN.md section 3): what a session is stands on the button, and the head above
    // already names the login and the sandbox, so the 190 px dock shows Start without scrolling.
    return clear(log, el('div.cmp-start',
      empty('No Codex session on this project yet.'),
      el('div.cmp-start-row', button('Start', { variant: 'primary', disabled: me.loading || blocked, title: blocked ? codexProblem(me.status) || 'Checking Codex…' : 'Start a Codex session in this project\'s folder: a second opinion beside Claude Code, on the login and in the sandbox the line above names', onclick: start }))));
  }
  me.liveEl = drawThread(log, { session: me.session, running: me.running, live: me.live, hint: CODEX_HINT });
}

function renderLive() {
  const me = st;
  if (!me.liveEl || me.liveEl.node.isConnected === false) return renderThread();
  drawLive(me.nodes.log, me.liveEl, me.live);
}

/** What stands in the way, in one sentence with what to do: no CLI, signed out, or the check itself failed. */
function renderProblem() {
  const me = st;
  const box = me.nodes.problem;
  const problem = codexProblem(me.status);
  box.hidden = !problem && !me.statusError;
  if (problem) return clear(box, el('div.note.danger', { role: 'alert' }, `${problem} `, button('Check again', { small: true, onclick: () => loadStatus(true) })));
  if (me.statusError) return clear(box, el('div.note.danger', { role: 'alert' }, `Codex could not be checked: ${me.statusError.message}. `, button('Retry', { small: true, onclick: () => loadStatus(true) })));
  clear(box);
}

const selectedPins = () => st.pins.filter((p) => st.selected.has(p.id));
const numberOf = (p) => st.pins.indexOf(p) + 1;

function renderPins() {
  const me = st;
  drawPins(me.nodes.pins, {
    pins: me.session ? me.pins : [], selected: me.selected, error: me.session ? me.pinsError : null, onRemove: removePin,
    onToggle: (p, on) => { if (on) me.selected.delete(p.id); else me.selected.add(p.id); renderPins(); renderComposer(); },
  });
}

function renderComposer() {
  const me = st;
  const c = me.nodes.composer;
  c.hidden = !me.session;
  if (!me.session) return clear(c);
  const picked = selectedPins();
  const prev = c.querySelector?.('textarea');
  const hadFocus = !!prev && document.activeElement === prev;
  const ta = textarea({
    rows: 2, 'aria-label': 'Message to Codex', placeholder: codexPlaceholder(picked.length > 0), disabled: me.running,
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); } },
  });
  if (prev) ta.value = prev.value;
  else if (me.keptDraft) { ta.value = me.keptDraft; me.keptDraft = ''; } // the box as it was before the project switch
  const chipText = pinChip(me.ctx.project?.name || 'This project', picked);
  clear(c,
    chipText ? el('div.cmp-attach', el('span.attach', { title: 'Rides the next message: the point, element, text and first three files' }, chipText),
      button('', { icon: 'x', small: true, variant: 'quiet', title: 'Leave the pins out', onclick: () => { me.selected.clear(); renderPins(); renderComposer(); } })) : null,
    ta,
    el('div.cmp-actions',
      button('Send', { variant: 'primary', disabled: me.running, title: 'Send to Codex (Enter)', onclick: () => send(ta.value) }),
      button('Stop', { variant: 'quiet', disabled: !me.running, title: 'Cancel the running answer', onclick: stop })));
  if (hadFocus && !me.running) ta.focus();
}

function renderTraj() {
  const me = st;
  drawTrajectory(me.nodes.rows, { session: me.session, running: me.running, live: me.live, hidden: me.stacked && !me.trajOpen });
}

function renderState() {
  const me = st;
  if (!me) return;
  const tools = me.running ? (me.live?.items || []).filter((x) => x.kind === 'tool') : [];
  const s = codexState({ status: me.status, session: me.session, running: me.running, startedAt: me.live?.startedAt, lastTool: tools[tools.length - 1] || null });
  drawState(me.nodes.state, s, { stacked: me.stacked, open: me.trajOpen, onToggle: () => { me.trajOpen = !me.trajOpen; renderState(); renderTraj(); } });
}

function setStacked(on) {
  const me = st;
  if (!me || me.stacked === on) return;
  me.stacked = on;
  me.nodes.split.classList?.toggle('stacked', on);
  paint(renderTraj, renderState);
}

// ---------- actions ----------
async function start() {
  const me = st;
  // A stored session is the one to show: Start never makes a second while the first is there to read.
  if (storedId() && storedId() !== me.goneId) return loadSession();
  me.loading = true;
  paint(renderThread);
  try {
    const s = await me.ctx.api.consoleCreate({
      backend: 'codex', projectId: me.ctx.projectId, model: me.model || null, effort: me.effort || null, sandbox: me.sandbox,
      tools: 'studio', title: `Codex · ${me.ctx.project?.name || me.ctx.projectId}`,
    });
    if (st !== me) return;
    me.session = s.session || s;
    adopt();
    await me.ctx.saveUi({ codexSessionId: me.session.id });
  } catch (err) {
    if (st === me) toast(`Start: ${err.message}`, { tone: 'danger' });
  } finally {
    if (st === me) me.loading = false;
  }
  if (st !== me) return;
  render();
  me.nodes.composer.querySelector?.('textarea')?.focus();
}

async function newSession() {
  const me = st;
  if (me.running) return;
  await me.ctx.saveUi({ codexSessionId: null }).catch((err) => toast(`New session: ${err.message}`, { tone: 'danger' }));
  if (st !== me) return;
  me.session = null;
  me.sandbox = 'read-only'; // the next session starts read-only; the model and the effort stay as chosen
  me.chose = true;
  setRunning(false);
  render();
}

async function send(raw) {
  const me = st;
  const s = me.session;
  const words = String(raw || '').trim();
  if (!s || !words || me.running) return;
  const text = messageWithPins(words, selectedPins(), numberOf);
  const box = me.nodes.composer.querySelector?.('textarea');
  const draft = box?.value || '';
  const mine = { role: 'user', text, at: new Date().toISOString(), pending: true };
  s.turns = [...(s.turns || []), mine];
  if (box) box.value = '';
  me.live = { items: [], startedAt: Date.now() };
  setRunning(true);
  render();
  try {
    await me.ctx.api.consoleSend(s.id, { text });
    delete mine.pending;
    if (st !== me) return;
    me.selected.clear(); // the pins rode this message
    renderPins();
    renderComposer();
  } catch (err) {
    if (st !== me) return;
    s.turns = s.turns.filter((t) => t !== mine);
    setRunning(false);
    toast(`Send: ${err.message}`, { tone: 'danger' });
    render();
    const again = me.nodes.composer.querySelector?.('textarea');
    if (again && !again.value) again.value = draft;
    if (err.code === 'console_no_codex' || err.code === 'console_codex_signed_out') loadStatus(true); // the note under the thread says what to do
    loadSession();
  }
}

async function stop() {
  const me = st;
  if (!me.session) return;
  try { await me.ctx.api.consoleCancel(me.session.id); } catch (err) { toast(`Stop: ${err.message}`, { tone: 'danger' }); }
}

async function removePin(p) {
  const me = st;
  try {
    await me.ctx.api.removeCompanionPin(me.ctx.projectId, p.id);
    me.selected.delete(p.id);
  } catch (err) { toast(`Remove: ${err.message}`, { tone: 'danger' }); }
  if (st === me) loadPins();
}
