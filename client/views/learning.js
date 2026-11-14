// Learning (docs/DESIGN.md section 9, docs/ARCHITECTURE.md section 19): the Companion teaches the person visually what
// the project is about to build. Left, a narrow shelf of the project's lessons (.studio/lessons, newest written first,
// each with Delete); in the middle the chosen lesson in a sandboxed, no-network frame (components/lesson-frame.js)
// with Back, Next and a progress row when it has steps; under it a dock like the Workbench's (components/dock.js) with
// one tab, Claude Code: the same panel module the Workbench's dock mounts (workbenches/companion/panel.js) on the same
// session, so the conversation, the box and a running answer carry over (decision row 138). Its height is its own
// (project.ui.learningDockHeight). The right panel (#collab: Task inspector, Processes, Skills, Focus) stays beside it
// as on the Workbench (app.js). Selecting text in a lesson or pressing a figure offers Ask about this, which quotes it
// into the Companion box.
import { el, clear, button, empty, errorBox, loading, toast, toastError, confirmDialog, ago } from '../components/ui.js';
import { lessonDocument, readTokens, LESSON_MESSAGE } from '../components/lesson-frame.js';
import { readLessonMessage, askLine, askFallback, stepWords, pickLesson } from '../components/lesson-words.js';
import { createDock } from '../components/dock.js';
import { olderServer } from '../components/skills-panel.js';

const LAST_KEY = 'atelier.lessonOpen'; // sessionStorage: { [projectId]: lessonId } the lesson last open per project
const readLast = () => { try { return JSON.parse(sessionStorage.getItem(LAST_KEY) || '{}'); } catch { return {}; } };
const writeLast = (pid, id) => sessionStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), [pid]: id }));
const companionModule = () => import('/workbenches/companion/panel.js'); // the URL the dock loads: one panel state
/** The Learning dock's options (tests/dock-arrange.test.mjs drives a dock with the same ones). */
export const LEARNING_DOCK = { kinds: () => ['companion'], heightKey: 'learningDockHeight', saveTab: false, arrange: false, key: 'atelier.dock.learning', label: 'Learning panels' };

let ui = null;

export function mount(host, app) {
  const shelfList = el('ol.learn-list');
  const shelfCount = el('span.learn-count');
  const shelf = el('nav.learn-shelf', { 'aria-label': 'Lessons' }, el('div.learn-shelf-head', el('span.overline', 'Lessons'), shelfCount), shelfList);
  const title = el('h2.learn-title');
  const meta = el('p.meta.learn-meta');
  const frame = el('iframe.learn-frame', { title: 'Lesson' });
  frame.setAttribute('sandbox', 'allow-scripts'); // before any srcdoc: no allow-same-origin, so the lesson runs in an opaque origin
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const stepLine = el('span.learn-step', { 'aria-live': 'polite' });
  const dots = el('div.learn-dots', { role: 'group', 'aria-label': 'Steps' });
  const back = button('Back', { small: true, onclick: () => goStep(-1), title: 'The step before (Left arrow inside the lesson)' });
  const next = button('Next', { small: true, variant: 'primary', onclick: () => goStep(1), title: 'The next step (Right arrow inside the lesson)' });
  const steps = el('div.learn-steps', { hidden: true }, stepLine, dots, el('span.spacer'), back, next);
  const body = el('div.learn-body');
  const panelSlot = el('span.learn-panel-slot');
  const display = el('section.learn-display', { 'aria-label': 'Lesson' }, el('header.learn-head', title, meta, el('span.spacer'), panelSlot), body, steps);
  // The dock under the lesson: the Workbench's own dock with the Companion alone (decision row 139). The grip's limit
  // is the lesson's height plus the dock body's, less the 120 px the lesson keeps (clampDockHeight).
  const dock = createDock(app, { ...LEARNING_DOCK, bus: null, frame: null, setPreviewWidth() {},
    stageHeight: () => display.getBoundingClientRect().height + (dock.node.querySelector('.dock-body')?.getBoundingClientRect().height || 0) });
  dock.node.hidden = true; // until a project's bundle is in
  const root = el('div.learn', shelf, el('div.learn-main', display, dock.node));
  clear(host, root);

  ui = { app, frame, shelfList, shelfCount, title, meta, body, steps, stepLine, dots, back, next, panelSlot, dock, pid: null, lessons: null, listError: null,
    openId: null, loadingId: null, theme: null, lesson: null, lessonError: null, stepCount: 0, stepIndex: 0, dockPid: null, loadSeq: 0, listSeq: 0, offs: [], timer: null };

  const onMessage = (e) => {
    if (!ui || e.source !== frame.contentWindow) return; // only the lesson frame on screen speaks here
    const msg = readLessonMessage(e.data);
    if (!msg) return;
    if (msg.what === 'steps') { ui.stepCount = msg.count; ui.stepIndex = msg.index; renderSteps(); }
    else if (msg.what === 'ask') ask(msg);
  };
  window.addEventListener('message', onMessage);
  ui.offs.push(() => window.removeEventListener('message', onMessage));
  ui.offs.push(app.on('project-switch', () => sync()));
  ui.offs.push(app.on('bundle', () => sync()));
  ui.offs.push(app.on('lessons', (d) => { if (ui && (!d?.projectId || d.projectId === ui.pid)) changed(d); }));
  ui.offs.push(app.on('sse', (d) => { if (ui && d?.state === 'open' && d.prev === 'down') loadList(); }));
  // The lesson wears the studio's tokens: a theme switch draws it again, on the step it was at.
  ui.offs.push(app.on('layout', () => { renderPanelBtn(); if (ui?.lesson && document.documentElement.dataset.theme !== ui.theme) renderLesson({ keepStep: true }); }));
  app.learning = { pick: (id) => pick(id), projectOnScreen: () => ui?.pid || null, showCompanion: () => showCompanion() };
  renderPanelBtn();
  sync();
}

export function unmount() {
  if (!ui) return;
  clearTimeout(ui.timer);
  ui.offs.forEach((off) => off());
  ui.dock.destroy(); // the panel keeps its box and live run for the next mount (the Workbench's dock, or here again)
  if (ui.app.learning) ui.app.learning = null;
  ui = null;
}

/** Tests only. */
export const _ui = () => ui;

// ---------- project, companion, list ----------
function sync() {
  if (!ui) return;
  const pid = ui.app.projectId();
  if (pid !== ui.pid) {
    ui.pid = pid;
    Object.assign(ui, { lessons: null, listError: null, openId: null, loadingId: null, theme: null, lesson: null, lessonError: null, stepCount: 0, stepIndex: 0 });
    renderShelf(); renderLesson();
    if (pid) loadList();
  }
  syncDock();
  const want = ui.app.state.lessonWanted;
  if (want && want.projectId === pid) { ui.app.state.lessonWanted = null; pick(want.id); }
}

/** The dock for the project on screen, set once its bundle is in (the session id is in project.ui; mounting before would
 *  offer Start over a session that exists). A project switch sets it again; with no project it hides. */
function syncDock() {
  const me = ui;
  const pid = me.pid;
  const b = me.app.state.bundle;
  if (!pid) { me.dockPid = null; me.dock.clearProject(); return; }
  if (b?.project?.id !== pid) return;
  if (me.dockPid === pid) { me.dock.update(); return; }
  me.dockPid = pid;
  me.dock.setProject(b);
}

/** Open the dock on Claude Code (expanded) and answer the panel module once it is mounted there; null without a dock.
 *  (insertDraft itself answers not_mounted when the panel failed to mount.) */
async function showCompanion() {
  const me = ui;
  if (!me?.dockPid || !(await me.dock.show('companion')) || ui !== me) return null;
  return companionModule();
}

/** The right panel's button in the lesson head, as on the Workbench's toolbar: Panel over the lesson on narrow windows,
 *  the sidebar icon when the panel is hidden, nothing while it shows (its own head can hide it). */
function renderPanelBtn() {
  if (!ui) return;
  const app = ui.app;
  const narrow = app.isNarrow();
  const collapsed = !!app.layout().collabCollapsed.value;
  clear(ui.panelSlot, narrow
    ? button('Panel', { small: true, variant: 'quiet', class: 'wb-panel-btn', 'aria-expanded': String(!collapsed), title: 'Open or close the right panel over the lesson (])', onclick: () => app.toggleLayout('collabCollapsed') })
    : collapsed ? button('', { icon: 'sidebar', small: true, variant: 'quiet', class: 'wb-panel-btn', title: 'Show the right panel: Task inspector, Processes, Skills, Focus (])', onclick: () => app.toggleLayout('collabCollapsed', false) }) : null);
}

async function loadList() {
  const me = ui;
  const pid = me.pid;
  const seq = ++me.listSeq;
  try {
    const out = await me.app.api.lessons(pid);
    if (ui !== me || me.pid !== pid || seq !== me.listSeq) return;
    me.lessons = out.lessons || [];
    me.listError = null;
  } catch (err) {
    if (ui !== me || seq !== me.listSeq) return;
    me.listError = err;
  }
  const ids = (me.lessons || []).map((l) => l.id);
  // The open lesson stays while it is being read (a studio.show can name one newer than this list) or still exists.
  if (!me.openId || (!ids.includes(me.openId) && !me.lesson && me.loadingId !== me.openId)) {
    const id = pickLesson({ last: readLast()[pid], ids });
    if (id) pick(id); else { me.openId = null; me.lesson = null; renderLesson(); }
  }
  renderShelf();
}

/** A lessons.changed: the list again; the open lesson again when it was the one written, or another when it went. */
function changed(d = {}) {
  clearTimeout(ui.timer);
  ui.timer = setTimeout(() => {
    if (!ui) return;
    if (d.lessonId && d.lessonId === ui.openId) {
      if (d.action === 'deleted') { ui.openId = null; ui.lesson = null; }
      else pick(ui.openId, { keepStep: true });
    }
    loadList();
  }, 150);
}

async function pick(id, { keepStep = false } = {}) {
  const me = ui;
  if (!me || !id) return;
  const pid = me.pid;
  const seq = ++me.loadSeq;
  me.openId = id;
  me.loadingId = id;
  me.lessonError = null;
  if (!keepStep) me.stepIndex = 0;
  writeLast(pid, id);
  renderShelf();
  try {
    const lesson = await me.app.api.lesson(pid, id);
    if (ui !== me || seq !== me.loadSeq || me.pid !== pid) return;
    me.lesson = lesson;
  } catch (err) {
    if (ui !== me || seq !== me.loadSeq) return;
    me.lesson = null;
    me.lessonError = err;
  }
  if (me.loadingId === id) me.loadingId = null;
  renderLesson({ keepStep });
}

async function remove(lesson) {
  const ok = await confirmDialog({ title: 'Delete lesson', message: `Delete "${lesson.title}"? The lesson file goes from this project's .studio/lessons; the conversation keeps what was said.`, confirm: 'Delete', variant: 'danger' });
  if (!ok || !ui) return;
  try {
    await ui.app.api.deleteLesson(ui.pid, lesson.id);
    toast(`Deleted "${lesson.title}"`, { tone: 'ok', timeout: 2500 });
    if (ui.openId === lesson.id) { ui.openId = null; ui.lesson = null; }
    loadList();
  } catch (err) { toastError(err, 'Delete lesson'); }
}

// ---------- the frame's messages ----------
function goStep(delta) {
  if (!ui || !ui.stepCount) return;
  sendStep(Math.max(0, Math.min(ui.stepCount - 1, ui.stepIndex + delta)));
}
function sendStep(index) {
  // The frame's origin is opaque, so '*' is the only target; only a step number goes out.
  ui.frame.contentWindow?.postMessage({ type: LESSON_MESSAGE, what: 'step', index }, '*');
}

async function ask(msg) {
  const me = ui;
  const line = askLine(msg, me.lesson?.title || 'this lesson');
  const mod = await showCompanion(); // a collapsed dock opens first, so the box can take the focus
  if (ui !== me) return;
  const out = mod?.insertDraft ? mod.insertDraft(line) : { ok: false, reason: 'not_mounted' };
  const words = askFallback(out);
  if (words) toast(words, { tone: out.ok ? 'neutral' : 'warn', timeout: 5000 });
}

// ---------- render ----------
function renderShelf() {
  const me = ui;
  const list = me.lessons || [];
  clear(me.shelfCount, list.length ? String(list.length) : '');
  if (me.listError && olderServer(me.listError)) { // a client newer than the server it talks to (section 19)
    return clear(me.shelfList, el('li.meta', 'This studio server started before the Learning tab existed, so it has no lessons route yet. Restart it to load the new code (Ctrl+Alt+R). ',
      button('Restart the studio', { small: true, variant: 'quiet', onclick: () => me.app.restart() })));
  }
  if (me.listError) return clear(me.shelfList, el('li.meta', `Lessons not read: ${me.listError.message}`));
  clear(me.shelfList, list.map((l) => el('li.learn-item', { dataset: { lesson: l.id } },
    el('button.learn-pick', { type: 'button', 'aria-current': l.id === me.openId ? 'true' : undefined, title: l.topic ? `${l.title} · ${l.topic}` : l.title, onclick: () => pick(l.id) },
      el('span.learn-pick-title', l.title),
      el('span.learn-pick-meta', [l.topic, ago(l.updatedAt)].filter(Boolean).join(' · '))),
    button('', { icon: 'trash', small: true, variant: 'quiet', class: 'learn-delete', title: `Delete the lesson "${l.title}"`, onclick: () => remove(l) }))));
}

function renderLesson({ keepStep = false } = {}) {
  const me = ui;
  if (!me.pid) { setHead('', ''); return clear(me.body, empty('Create a project first; its lessons appear here.')); }
  if (me.lessonError) { setHead('', ''); return clear(me.body, errorBox(me.lessonError, () => pick(me.openId))); }
  if (!me.lesson) {
    setHead('', '');
    me.stepCount = 0; renderSteps();
    if (me.lessons === null && !me.listError) return clear(me.body, loading('Reading the lessons…'));
    if (me.openId) return clear(me.body, loading('Opening the lesson…'));
    return clear(me.body, empty('Lessons appear here when you ask the Companion to teach you something.'));
  }
  const l = me.lesson;
  setHead(l.title, [l.topic, `written ${ago(l.updatedAt)}`].filter(Boolean).join(' · '));
  const want = keepStep ? me.stepIndex : 0;
  me.frame.title = `Lesson: ${l.title}`;
  me.frame.onload = () => { if (want > 0) sendStep(want); };
  const style = getComputedStyle(document.documentElement);
  me.theme = document.documentElement.dataset.theme;
  me.frame.srcdoc = lessonDocument({ html: l.html, title: l.title, tokens: readTokens(style, document.documentElement.dataset.theme) });
  if (me.body.firstChild !== me.frame) clear(me.body, me.frame);
}

function setHead(text, metaText) {
  clear(ui.title, text);
  clear(ui.meta, metaText);
  ui.title.hidden = !text;
  ui.meta.hidden = !metaText;
}

function renderSteps() {
  const me = ui;
  const n = me.lesson ? me.stepCount : 0;
  me.steps.hidden = !n;
  if (!n) return;
  clear(me.stepLine, stepWords(me.stepIndex, n));
  clear(me.dots, Array.from({ length: n }, (_, i) => el('button.learn-dot', {
    type: 'button', 'aria-label': `Step ${i + 1}`, 'aria-current': i === me.stepIndex ? 'step' : undefined, title: `Step ${i + 1}`, onclick: () => sendStep(i),
  })));
  me.back.disabled = me.stepIndex <= 0;
  me.next.disabled = me.stepIndex >= n - 1;
}
