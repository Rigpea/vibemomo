// Companion workbench panel (docs/ARCHITECTURE.md section 12): a Claude Code session with the studio's tools in the
// dock, after the concept screen in docs/DESIGN.md section 7. Left, the thread (the transcript renderer of the Claude
// Code view, reused) with the pins under it and the composer; right, the trajectory: the run's tool rows as
// time · verb · file under a one-word state and its reason. Under 760 px the trajectory stacks under the thread,
// collapsed to its state line. The session is an ordinary console session (context 'companion', tools 'studio');
// its id lives in project.ui.companionSessionId and the Claude Code view lists it like any other.
// Nothing here claims a state: every word comes from the session record, the console events or the pins route.
// The thread, the live rows, the trajectory, the state line and the pin cards are drawn by
// client/components/session-parts.js, which the Codex tab (workbenches/codex/panel.js) uses too.
import { el, clear, button, select, textarea, empty, toast } from '/components/ui.js';
import { addChunk, runStart, drawThread, drawLive, drawTrajectory, drawState, drawPins } from '/components/session-parts.js';
import { COMPANION_MODELS, brainLine, MAKE_TASK_MESSAGE, companionState, pinChip, messageWithPins, composerPlaceholder, isStacked, COMPANION_EFFORTS, COMPANION_MODES, COMPANION_CHROME, modeWords, companionChoices, messageWithAttachments } from '/components/companion-words.js';

let st = null;
/** What the panel held when it unmounted, per project: the draft in the box, the selected pins, the attachments, the
 *  open trajectory and a running answer's live rows (kept up to date by a listener of its own until the next mount).
 *  The Workbench's dock and the Learning view mount this same panel in turn (decision row 138), so leaving one for the
 *  other keeps the box and the run as they were: the session itself lives on the server and never restarts. */
const kept = new Map();

export function mount(container, ctx) {
  const k = kept.get(ctx.projectId) || null;
  if (k) { k.off?.(); kept.delete(ctx.projectId); }
  const me = {
    ctx, container, session: null, sessionError: null, loading: false, running: false, live: null,
    pins: [], pinsError: null, selected: new Set(k?.selected || []), ...companionChoices(ctx.project?.ui), attachments: k?.attachments || [],
    stacked: false, trajOpen: !!k?.trajOpen, timer: null, offs: [], ro: null,
    keptDraft: k?.draft || '', keptLive: k?.live && k.sessionId ? { sessionId: k.sessionId, live: k.live } : null,
  };
  st = me;
  container.classList?.add('companion-host');
  const n = (me.nodes = {});
  n.brain = el('span.cmp-brain');
  n.choices = el('div.cmp-choices');
  n.headActions = el('div.cmp-head-actions');
  n.log = el('div.cmp-log', { role: 'log', 'aria-label': 'Companion thread', tabIndex: 0 });
  n.pins = el('div.cmp-pins', { 'aria-label': 'Pins' });
  n.composer = el('div.cmp-composer');
  n.state = el('div.cmp-state'); // not a live region: the Working clock changes every second
  n.rows = el('div.cmp-traj-rows', { 'aria-label': 'Tool calls of the run' });
  n.thread = el('section.cmp-thread', { 'aria-label': 'Thread' }, n.log, n.pins, n.composer);
  n.traj = el('section.cmp-traj', { 'aria-label': 'Trajectory' }, n.state, n.rows);
  n.split = el('div.cmp-split', n.thread, n.traj);
  clear(container, el('div.companion', el('header.cmp-head', n.brain, n.choices, el('span.spacer'), n.headActions), n.split));

  me.offs.push(
    ctx.app.on('console', onEvent),
    ctx.app.on('pins', (d) => { if (!d?.projectId || d.projectId === me.ctx.projectId) loadPins(); }),
    ctx.app.on('sse', (d) => { if (d?.state === 'open') { loadSession(); loadPins(); } }),
  );
  if (typeof ResizeObserver === 'function') {
    me.ro = new ResizeObserver((entries) => setStacked(isStacked(entries[entries.length - 1].contentRect.width)));
    me.ro.observe(container);
  }
  render();
  loadSession();
  loadPins();
}

export function unmount() {
  const me = st;
  if (!me) return;
  keep(me);
  st = null;
  clearInterval(me.timer);
  me.ro?.disconnect();
  me.offs.forEach((off) => off());
  me.container.classList?.remove('companion-host');
}

/** The bundle was refreshed: another window may have started or dropped the session. */
export function update() {
  const me = st;
  if (me && storedId() !== (me.session?.id || null) && !me.loading) loadSession();
}

/** Keep what the person had in the panel for the next mount of the same project (see kept). */
function keep(me) {
  const box = me.nodes.composer.querySelector?.('textarea');
  const draft = box ? box.value : me.keptDraft || '';
  const sessionId = me.session?.id || null;
  const rec = { draft, selected: [...me.selected], attachments: me.attachments, trajOpen: me.trajOpen, sessionId, live: me.running && sessionId ? me.live : null, off: null };
  if (rec.live && typeof me.ctx.app?.on === 'function') {
    rec.off = me.ctx.app.on('console', ({ name, data } = {}) => {
      if (!rec.live || !data || data.sessionId !== rec.sessionId) return;
      if (name === 'console.chunk') addChunk(rec.live, data);
      else if (name === 'console.done' || name === 'console.error') rec.live = null; // the record holds the answer now
    });
  }
  if (!rec.draft && !rec.selected.length && !rec.attachments.length && !rec.live && !rec.trajOpen) return;
  kept.get(me.ctx.projectId)?.off?.();
  kept.set(me.ctx.projectId, rec);
}

/**
 * Put a line into the box without sending it (the Learning view's Ask about this): after what is already typed, on a
 * line of its own, with the caret at the end and the focus in the box. Answers { ok, focused, reason }: no_session
 * before Start, running when the box is disabled for an answer (the line still waits in it), not_mounted otherwise.
 */
export function insertDraft(text) {
  const me = st;
  if (!me) return { ok: false, focused: false, reason: 'not_mounted' };
  if (!me.session) return { ok: false, focused: false, reason: 'no_session' };
  const box = me.nodes.composer.querySelector?.('textarea');
  if (!box) return { ok: false, focused: false, reason: 'not_mounted' };
  const line = String(text || '');
  box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n${line}` : line;
  if (box.disabled) return { ok: true, focused: false, reason: 'running' };
  box.focus();
  box.setSelectionRange?.(box.value.length, box.value.length);
  return { ok: true, focused: true, reason: null };
}

/** Tests only. */
export const _state = () => st;
export const _kept = (projectId) => kept.get(projectId) || null;
export const _forget = () => { for (const k of kept.values()) k.off?.(); kept.clear(); };
export const _setStacked = (on) => setStacked(on);

// ---------- data ----------
const storedId = () => st?.ctx.project?.ui?.companionSessionId || null;

async function loadSession() {
  const me = st;
  const id = storedId();
  if (!id) { me.session = null; setRunning(false); return render(); }
  me.loading = true;
  try {
    const s = await me.ctx.api.consoleGet(id);
    if (st !== me) return;
    me.session = s.session || s;
    me.sessionError = null;
    me.model = me.session.model || me.model;
    if (me.session.status === 'running') {
      // A run that was on screen before this mount carries on with the rows it had (kept); else its first rows are missed.
      const carried = me.keptLive?.sessionId === me.session.id ? me.keptLive.live : null;
      if (!me.running) me.live = carried || { items: [], startedAt: runStart(me.session), missed: true };
      setRunning(true);
    } else setRunning(false);
    me.keptLive = null;
  } catch (err) {
    if (st !== me) return;
    if (err.status === 404) { me.session = null; me.goneId = id; me.ctx.saveUi({ companionSessionId: null }).catch(() => {}); } // deleted in the Claude Code view
    else me.sessionError = err;
  } finally {
    if (st === me) me.loading = false;
  }
  if (st === me) render();
}

/** The pins count on the tab before the panel mounts (the dock calls this at setProject; docs/ARCHITECTURE.md section 4):
 *  read now, again on a pins change and when the event stream opens; the stop function ends it. */
export function watchCount(ctx) {
  let on = true;
  const read = async () => {
    try {
      const out = await ctx.api.companionPins(ctx.projectId);
      if (on) ctx.setCount?.((out?.pins || []).length);
    } catch { /* the panel says so when it is opened */ }
  };
  const offs = typeof ctx.app?.on === 'function' ? [
    ctx.app.on('pins', (d) => { if (!d?.projectId || d.projectId === ctx.projectId) read(); }),
    ctx.app.on('sse', (d) => { if (d?.state === 'open') read(); }),
  ] : [];
  read();
  return () => { on = false; offs.forEach((off) => off?.()); };
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
  me.ctx.setCount?.(me.pins.length);
  paint(renderPins, renderComposer);
}

function setRunning(on) {
  const me = st;
  me.running = on;
  clearInterval(me.timer);
  me.timer = on ? setInterval(() => { if (st === me) paint(renderState); }, 1000) : null;
  if (!on) me.live = null;
}

// ---------- console events (the app's 'console' topic, as the Claude Code view reads them) ----------
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
    loadSession(); // the record is the truth
  } else return;
  render();
}

// ---------- render ----------
/** Draws every part, each on its own: a part that throws does not stop the others (the state line still follows the
 *  record), and the first error of the pass replaces the thread with one danger note and a Retry instead of leaving
 *  whatever was drawn before. */
/** The band's note while this tab is active: the session's title, as the reference's "Session / gather-home". */
function tellNote() {
  const me = st;
  me?.ctx.setNote?.(me.session ? `Session / ${me.session.title || me.session.id}` : '');
}

function render() {
  tellNote();
  const me = st;
  if (!me) return;
  let failed = null;
  for (const part of [renderHead, renderThread, renderPins, renderComposer, renderTraj, renderState]) {
    try { part(); } catch (err) { failed ||= err; }
  }
  if (failed) drawFailed(failed); else me.drawError = null;
}

/** Runs one part outside render() (a chunk, the clock); a throw goes to the same note. */
function paint(...parts) {
  if (!st) return;
  for (const part of parts) {
    try { part(); } catch (err) { drawFailed(err); }
  }
}

function drawFailed(err) {
  const me = st;
  const message = err?.message || String(err);
  if (me.drawError !== message) console.error('Companion view could not be drawn', err); // once per failure, not per tick
  me.drawError = message;
  try {
    clear(me.nodes.log, el('div.note.danger.cmp-draw-error', { role: 'alert' },
      `The companion view could not be drawn: ${message}. `,
      button('Retry', { small: true, onclick: () => { me.drawError = null; if (me.session || storedId()) loadSession(); else render(); } })));
  } catch { /* the note itself could not be drawn; the console has the error */ }
}

/** A choice made in the head: kept per project, and set on the session for its next turn. */
async function choose(key, value) {
  const me = st;
  me[key] = value;
  const partial = { model: me.model, effort: me.effort, permissionMode: me.permissionMode, chrome: me.chrome };
  (me.ctx.saveUi?.({ companion: partial }) || Promise.resolve()).catch((err) => toast(`Choice not kept: ${err.message}`, { tone: 'danger' }));
  if (me.session) {
    try {
      const out = await me.ctx.api.consolePatch(me.session.id, { [key]: key === 'chrome' ? value : value || (key === 'effort' ? null : value) });
      if (st === me && me.session) Object.assign(me.session, { model: out.model, permissionMode: out.permissionMode, effort: out.effort, chrome: out.chrome });
    } catch (err) { if (st === me) toast(`Not set on the session: ${err.message}`, { tone: 'danger' }); }
  }
  if (st === me) paint(renderHead);
}

function renderHead() {
  const me = st;
  const s = me.session;
  me.nodes.brain.textContent = brainLine(s?.model || me.model);
  me.nodes.brain.title = s ? `${s.title || 'Companion'} · ${s.id} · ${modeWords(s.permissionMode)} · the studio's tools run without asking` : 'The session starts on Start';
  // The choices: the model, the effort and the mode, as the person picks them here; a change reaches the next turn.
  const pick = (key, options, title) => select(options, me[key], { 'aria-label': title, title, disabled: me.running, onchange: (e) => choose(key, e.target.value) });
  clear(me.nodes.choices,
    pick('model', COMPANION_MODELS, 'The model that answers'),
    pick('effort', COMPANION_EFFORTS, 'How hard it thinks (the CLI\'s effort level)'),
    pick('permissionMode', COMPANION_MODES, 'What it may do without asking: Plan edits nothing; Accept edits edits files; Auto decides itself; Runs anything runs every command'),
    select(COMPANION_CHROME, me.chrome ? 'on' : 'off', {
      'aria-label': 'Whether it may work in your own Chrome', title: 'Chrome on: it may open tabs in your own Chrome, signed in as you, to find and read pages (Claude in Chrome). It asks you to handle logins and CAPTCHAs.',
      disabled: me.running, onchange: (e) => choose('chrome', e.target.value === 'on'),
    }));
  clear(me.nodes.headActions,
    s ? button('New session', { small: true, variant: 'quiet', disabled: me.running, title: 'Start over with a new session; this one stays in the Claude Code view', onclick: newSession }) : null);
}

function renderThread() {
  const me = st;
  const log = me.nodes.log;
  if (me.sessionError) return clear(log, el('div.note.danger', { role: 'alert' }, `The companion session could not be read: ${me.sessionError.message}`), button('Retry', { small: true, onclick: loadSession }));
  // A stored id not read yet: say so, never Start (Start would make a second session over the first).
  if (!me.session && storedId() && storedId() !== me.goneId) return clear(log, el('p.meta.cmp-hint', 'Reading the companion session…'));
  if (!me.session) {
    const model = select(COMPANION_MODELS, me.model, { 'aria-label': 'Model', title: 'Which model answers', onchange: (e) => { me.model = e.target.value; renderHead(); } });
    return clear(log, el('div.cmp-start',
      empty('No companion session on this project yet.', 'It runs Claude Code on your login with the studio\'s tools, and changes things only when you ask.'),
      el('div.cmp-start-row', button('Start', { variant: 'primary', disabled: me.loading, onclick: start }), model)));
  }
  me.liveEl = drawThread(log, { session: me.session, running: me.running, live: me.live, hint: 'Ask about what is on the screen. Enter sends; Shift+Enter adds a line.' });
}

function renderLive() {
  const me = st;
  if (!me.liveEl || me.liveEl.node.isConnected === false) return renderThread();
  drawLive(me.nodes.log, me.liveEl, me.live);
}

function selectedPins() {
  const me = st;
  return me.pins.filter((p) => me.selected.has(p.id));
}
const numberOf = (p) => st.pins.indexOf(p) + 1;

function renderPins() {
  const me = st;
  drawPins(me.nodes.pins, {
    pins: me.pins, selected: me.selected, error: me.pinsError, onRemove: removePin,
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
    rows: 2, 'aria-label': 'Message to the companion', placeholder: composerPlaceholder(picked.length > 0), disabled: me.running,
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); } },
    onpaste: (e) => pasteFiles(e),
  });
  if (prev) ta.value = prev.value;
  else if (me.keptDraft) { ta.value = me.keptDraft; me.keptDraft = ''; } // the box as it was before the panel moved
  const chipText = pinChip(me.ctx.project?.name || 'This project', picked);
  const fileInput = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Files to attach', onchange: (e) => attachFiles([...(e.target.files || [])]) });
  clear(c,
    chipText ? el('div.cmp-attach', el('span.attach', { title: 'Rides the next message: the point, element, text and first three files' }, chipText),
      button('', { icon: 'x', small: true, variant: 'quiet', title: 'Leave the pins out', onclick: () => { me.selected.clear(); renderPins(); renderComposer(); } })) : null,
    me.attachments.length ? el('div.cmp-attach.cmp-files', me.attachments.map((f) => el('span.attach', { title: `${f.path} · rides the next message` }, f.name,
      button('', { icon: 'x', small: true, variant: 'quiet', title: `Leave ${f.name} out`, onclick: () => { me.attachments = me.attachments.filter((x) => x !== f); renderComposer(); } })))) : null,
    ta,
    el('div.cmp-actions',
      button('Send', { variant: 'primary', disabled: me.running, title: 'Send (Enter)', onclick: () => send(ta.value) }),
      button('Attach', { small: true, variant: 'quiet', disabled: me.running, title: 'Attach files to the next message (or paste a screenshot with Ctrl+V): they are saved in this project under .studio/attachments and the companion reads them', onclick: () => fileInput.click() }),
      fileInput,
      button('Stop', { variant: 'quiet', disabled: !me.running, title: 'Cancel the running answer', onclick: stop }),
      el('span.spacer'),
      button('Make it a task', { variant: 'quiet', disabled: me.running, title: 'Ask the companion to write this thread up as a studio task (atelier_create_task); nothing is handed over', onclick: () => send(MAKE_TASK_MESSAGE, { keepDraft: true }) })));
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
  const s = companionState({ session: me.session, running: me.running, startedAt: me.live?.startedAt, lastTool: tools[tools.length - 1] || null });
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
  const project = me.ctx.project;
  // A stored session is the one to show: Start never makes a second while the first is there to read.
  if (storedId() && storedId() !== me.goneId) return loadSession();
  me.loading = true;
  paint(renderThread);
  try {
    const s = await me.ctx.api.consoleCreate({
      backend: 'claude-code', projectId: me.ctx.projectId, model: me.model, permissionMode: me.permissionMode, effort: me.effort || null,
      chrome: me.chrome, tools: 'studio', context: 'companion', title: `Companion · ${project?.name || me.ctx.projectId}`,
    });
    if (st !== me) return;
    me.session = s.session || s;
    await me.ctx.saveUi({ companionSessionId: me.session.id });
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
  await me.ctx.saveUi({ companionSessionId: null }).catch((err) => toast(`New session: ${err.message}`, { tone: 'danger' }));
  if (st !== me) return;
  me.session = null;
  setRunning(false);
  render();
}

/** Ctrl+V in the composer: files on the clipboard (a screenshot, a copied file) are attached like Attach's; a
 *  screenshot's clipboard name (image.png) becomes screenshot-<time>.png. Text pastes as usual; when the clipboard
 *  holds only files, nothing lands in the box. */
function pasteFiles(e) {
  const items = [...(e.clipboardData?.items || [])];
  const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  if (!items.some((i) => i.kind === 'string' && i.type === 'text/plain')) e.preventDefault();
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  attachFiles(files.map((f, n) => {
    if (f.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) return f;
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File([f], `screenshot-${stamp}${files.length > 1 ? `-${n + 1}` : ''}.${ext}`, { type: f.type });
  }));
}

/** Files picked for the next message: each is read in the browser, saved under the project's .studio/attachments
 *  through the route, and listed above the composer until the message goes (or the person leaves it out). */
async function attachFiles(files) {
  const me = st;
  if (!me?.session || !files.length) return;
  const asBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;]*;base64,/, ''));
    r.onerror = () => reject(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
  for (const file of files) {
    try {
      const out = await me.ctx.api.companionAttach(me.ctx.projectId, { name: file.name, type: file.type || null, data: await asBase64(file) });
      if (st !== me) return;
      me.attachments = [...me.attachments, out];
    } catch (err) {
      if (st === me) toast(`${file.name} not attached: ${err.message}`, { tone: 'danger' });
    }
  }
  if (st === me) paint(renderComposer);
}

async function send(raw, { keepDraft = false } = {}) {
  const me = st;
  const s = me.session;
  const words = String(raw || '').trim();
  if (!s || !words || me.running) return;
  const picked = selectedPins();
  const text = messageWithAttachments(messageWithPins(words, picked, numberOf), me.attachments);
  const box = me.nodes.composer.querySelector?.('textarea');
  const draft = box?.value || '';
  const mine = { role: 'user', text, at: new Date().toISOString(), pending: true };
  s.turns = [...(s.turns || []), mine];
  if (box && !keepDraft) box.value = '';
  me.live = { items: [], startedAt: Date.now() };
  setRunning(true);
  render();
  try {
    await me.ctx.api.consoleSend(s.id, { text });
    delete mine.pending;
    if (st !== me) return;
    me.selected.clear(); // the pins rode this message; the next one carries what is selected then
    me.attachments = []; // so did the files
    renderPins();
    renderComposer();
  } catch (err) {
    if (st !== me) return;
    s.turns = s.turns.filter((t) => t !== mine);
    setRunning(false);
    toast(`Send: ${err.message}`, { tone: 'danger' });
    render();
    const again = me.nodes.composer.querySelector?.('textarea');
    if (again && !keepDraft && !again.value) again.value = draft;
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
