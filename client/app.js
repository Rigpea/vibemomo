// Atelier client: boot, state store, SSE, router, layout, global status, shortcuts.
import { api, onWrites } from './api.js';
import { el, clear, icon, chip, toast, toastError, dialog, button } from './components/ui.js';
import { globalTaskState, chipWords, statusSentence } from './components/status-words.js';
import { backendLabel } from './components/transcript.js';
import { markdown } from './components/markdown.js';
import { resolveLayout, setLayout } from './components/layout.js';
import { applyAppearance, rememberAppearance } from './components/appearance.js';
import { renderRail } from './components/rail.js';
import { renderProjectPicker } from './components/project-picker.js';
import { renderCollab, showPanel } from './components/collab.js';
import { handleStudioShow, waitUntil } from './components/studio-show.js';
import { sessionAsks } from './components/companion-words.js';
import { focusVersionRow } from './components/version-strip.js';
import { endedRun, runChipTab, isRunning } from './components/run-words.js';
import { restartStudio } from './components/restart.js';

// Section routes in navigation order (keys 1–8, the tabs in index.html in the same order). Module file names are kept
// from the first build.
const VIEWS = {
  workbench: () => import('./views/workbench.js'),
  learning: () => import('./views/learning.js'), // lessons beside the same Companion session (views/learning.js)
  inspiration: () => import('./views/inspiration.js'), // the project's board of design references (views/inspiration.js)
  'claude-code': () => import('./views/console.js'),
  tasks: () => import('./views/tasks.js'),
  memory: () => import('./views/knowledge.js'),
  budget: () => import('./views/usage.js'),
  settings: () => import('./views/settings.js'),
};
const VIEW_ORDER = Object.keys(VIEWS);
/** Hashes from before the interface pass keep working. */
const ALIASES = { knowledge: 'memory', usage: 'budget', console: 'claude-code' };

const state = {
  studio: null, projects: [], activeProjectId: null, settings: { ui: {} }, apiUtility: {}, templates: [],
  bundle: null, bundleError: null, retrieving: false, saving: 0, sse: 'connecting', view: 'workbench', bootError: null,
  runningSessions: [], // Chat sessions the server reports as running, for the global status chip
  askingSessions: [], // companion sessions whose last answer asks a question (needs you)
  runs: [], // GET /api/runs?projectId=all: what runs now and what ended (server/lib/runs.mjs), for the rail and Working now
  endedRun: null, // the last run a runs.changed event reported ended: the chip names it until clicked or another ends
  narrowPanelOpen: false, // below 1100 px the Task | Focus panel is an overlay: open only on request, never stored
  lessonWanted: null, // { projectId, id }: the lesson a studio.show asked for, taken by the Learning view when it shows
  // The person's look (Settings, Appearance): GET /api/state's { stored, effective, locks, rulesProject, rulesUnread };
  // null until a server that knows it has answered. lookPreview: choices shown before they are saved (a colour being picked).
  appearance: null,
  lookPreview: null,
};

// ---------- tiny pub/sub ----------
const topics = new Map();
function on(topic, fn) {
  if (!topics.has(topic)) topics.set(topic, new Set());
  topics.get(topic).add(fn);
  return () => topics.get(topic).delete(fn);
}
function emit(topic, detail) {
  for (const fn of topics.get(topic) || []) {
    try { fn(detail); } catch (err) { console.error('[atelier]', topic, err); }
  }
}

export const app = {
  state, api, on, emit,
  workbench: null, // registered by views/workbench.js: {tryHead, viewVersion, keep, compare, restore, build}
  project: () => state.bundle?.project || null,
  projectId: () => state.activeProjectId,
  restart: () => restart(), // the top bar's Restart (components/restart.js), for a tab that finds the server older than itself
  layout: effectiveLayout,
  /** Below 1100 px the Task | Focus panel opens over the preview instead of beside it. */
  isNarrow: () => NARROW.matches,
  loadStudio, loadBundle, selectProject, setLayoutPref, toggleLayout, toggleVersions, go,
  /** The look: show choices before they are saved (null ends the preview), and save a patch through the settings route. */
  previewLook, saveAppearance,
  /** Open the right panel on a tab (task, focus, processes, skills) and focus its first field: where it is, on the
   *  Workbench and on Learning, which both show it; from any other view, on the Workbench. */
  /** opts.taskId: open the Task tab at that task's row (the version strip's bars) instead of the composer. */
  showPanel: (tab = 'task', opts = {}) => { if (!panelView()) go('workbench'); toggleLayout('collabCollapsed', false); showPanel(tab, opts); },
  newProject: () => import('./components/new-project.js').then((m) => m.newProjectDialog(app)),
  /** The one way into the Source tab (the Phone and Page readouts, Activity rows, studio.show): { path, line }. */
  openSource,
  /** studio.show's lesson: the Learning view on the active project, showing that lesson (views/learning.js takes it). */
  showLesson,
  learning: null, // registered by views/learning.js while it is mounted: { pick(id), projectOnScreen() }
};
window.atelier = app; // debug handle

// ---------- data loading ----------
async function loadStudio() {
  try {
    const s = await api.state();
    Object.assign(state, {
      studio: s.studio, projects: s.projects || [], settings: s.settings || { ui: {} }, apiUtility: s.apiUtility || {}, templates: s.templates || [], bootError: null,
      appearance: s.appearance || null, // absent from a server started before the look existed
    });
    if (s.appearance) rememberAppearance(s.appearance.effective);
    noteStudioChange(s.studio);
    if (!state.activeProjectId || !state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = s.activeProjectId && state.projects.some((p) => p.id === s.activeProjectId) ? s.activeProjectId : state.projects[0]?.id || null;
    }
  } catch (err) {
    state.bootError = err;
  }
  emit('studio');
  applyLayout();
  renderStatus();
}

/** The studio behind this window: when its version or its start changes (a restart with new code), the window still
 *  runs what it loaded, so a prompt offers a reload; once per change. */
let bootStudio = null;
let reloadOffered = null;
function noteStudioChange(studio) {
  if (!studio) return;
  const mark = `${studio.version}@${studio.startedAt}`;
  if (!bootStudio) { bootStudio = { ...studio, mark }; return; }
  if (mark === bootStudio.mark || reloadOffered === mark) return;
  reloadOffered = mark;
  const words = studio.version !== bootStudio.version ? `The studio is now v${studio.version}; this window still runs v${bootStudio.version}.` : 'The studio restarted; this window still runs the code it loaded.';
  toast(words, { timeout: 0, action: { label: 'Reload', run: () => location.reload() }, clears: 'studio-changed' }).dataset.prefix = 'studio-changed';
}

let bundleSeq = 0;
async function loadBundle({ quiet = false } = {}) {
  const id = state.activeProjectId;
  if (!id) { state.bundle = null; emit('bundle'); renderStatus(); return; }
  const seq = ++bundleSeq;
  if (!quiet) { state.retrieving = true; renderStatus(); }
  try {
    const b = await api.project(id);
    if (seq !== bundleSeq) return;
    state.bundle = b;
    state.bundleError = null;
  } catch (err) {
    if (seq !== bundleSeq) return;
    state.bundleError = err;
    if (!quiet) state.bundle = null;
  } finally {
    if (seq === bundleSeq) state.retrieving = false;
  }
  emit('bundle');
  applyLayout();
  renderStatus();
}

let bundleTimer = null;
function scheduleBundle() {
  clearTimeout(bundleTimer);
  bundleTimer = setTimeout(() => loadBundle({ quiet: true }), 250);
}
let studioTimer = null;
function scheduleStudio() {
  clearTimeout(studioTimer);
  studioTimer = setTimeout(loadStudio, 300);
}

async function selectProject(id) {
  // loadStudio can select the first newly created/imported project before its
  // bundle has loaded. It still needs a real selection to populate the Workbench.
  if (!id || (id === state.activeProjectId && state.bundle?.project?.id === id)) return;
  state.activeProjectId = id;
  state.bundle = null;
  state.bundleError = null; // the last project's error is not this one's
  // The overlay belongs to the project it was opened on. Here, not in the Workbench: the rail also switches from other views.
  if (app.isNarrow() && state.narrowPanelOpen) toggleLayout('collabCollapsed', true);
  // So is the Versions drawer, which would cover the next project's dock (same reason to be here).
  if (app.layout().versionsOpen.value) toggleLayout('versionsOpen', false);
  emit('project-switch');
  emit('studio');
  api.activate(id).catch(() => {});
  await loadBundle();
}

// ---------- SSE (subscribe once; 30 s poll only while the stream is down) ----------
let fallbackTimer = null;
let showQueue = Promise.resolve();
function connectEvents() {
  const es = new EventSource('/api/events');
  const set = (s) => { const prev = state.sse; state.sse = s; renderStatus(); if (prev !== s) emit('sse', { state: s, prev }); };
  es.addEventListener('hello', () => {
    const wasDown = state.sse === 'down';
    set('open');
    clearInterval(fallbackTimer); fallbackTimer = null;
    if (wasDown) {
      loadStudio(); loadBundle({ quiet: true }); loadRunningSessions(); loadRuns(); emit('memory'); emit('budget');
      toast('Reconnected', { tone: 'ok', timeout: 2500 }); // once per "Server offline" -> connected
    }
  });
  es.addEventListener('error', () => {
    set('down');
    if (!fallbackTimer) fallbackTimer = setInterval(() => { loadStudio(); loadBundle({ quiet: true }); }, 30000);
  });
  const data = (e) => { try { return JSON.parse(e.data); } catch { return {}; } };
  es.addEventListener('project.changed', (e) => {
    const d = data(e);
    if (d.created || d.removed || d.imported) scheduleStudio();
    if (d.projectId === state.activeProjectId) scheduleBundle();
    emit('project.changed', d);
  });
  es.addEventListener('task.changed', (e) => {
    const d = data(e);
    if (d.projectId === state.activeProjectId) scheduleBundle();
    emit('task.changed', d);
  });
  es.addEventListener('memory.changed', (e) => emit('memory', data(e)));
  es.addEventListener('budget.changed', (e) => { emit('budget', data(e)); scheduleStudio(); });
  es.addEventListener('status', (e) => { const d = data(e); if (d.settings) scheduleStudio(); emit('status', d); });
  es.addEventListener('utility.progress', (e) => emit('utility', data(e)));
  es.addEventListener('terminal.changed', (e) => emit('terminal', data(e)));
  es.addEventListener('live.changed', (e) => emit('live', data(e))); // a project's live server (server/lib/live.mjs)
  // A run started, changed or ended (server/lib/runs.mjs). The chip takes only an end the event itself reports.
  es.addEventListener('runs.changed', (e) => {
    const d = data(e);
    const ended = endedRun(d);
    if (ended) { state.endedRun = ended; renderStatus(); }
    scheduleRuns();
  });
  es.addEventListener('skills.changed', (e) => emit('skills', data(e))); // the Skills tab lists again
  es.addEventListener('pins.changed', (e) => emit('pins', data(e))); // the Companion tab's pin list
  es.addEventListener('lessons.changed', (e) => emit('lessons', data(e))); // the Learning view's shelf and open lesson
  es.addEventListener('inspiration.changed', (e) => emit('inspiration', data(e))); // the Inspiration view's board
  es.addEventListener('rules.changed', (e) => emit('rules', data(e))); // the Inspiration view's fixed rules
  es.addEventListener('rules.changed', scheduleStudio); // a rule can lock a token of the look: the state names the locks
  es.addEventListener('references.changed', (e) => emit('references', data(e))); // the Inspiration view's references
  // A companion's atelier_studio_show: one at a time, so a second request waits for the first's project switch.
  es.addEventListener('studio.show', (e) => {
    const d = data(e);
    showQueue = showQueue.then(() => handleStudioShow(app, d, { toast })).catch((err) => console.error('[atelier] studio.show', err));
  });
  // EventSource has no wildcard for named events: list the console.* names from ARCHITECTURE.md section 7.
  for (const name of ['console.started', 'console.chunk', 'console.done', 'console.error']) {
    es.addEventListener(name, (e) => {
      if (name !== 'console.chunk') loadRunningSessions();
      emit('console', { name, data: data(e) });
    });
  }
}

/** Every project's runs, asked again a moment after runs.changed (a session's tool calls come close together). */
let runsLoad = 0;
async function loadRuns() {
  const load = ++runsLoad;
  try {
    const out = await api.runs('all');
    if (load !== runsLoad) return;
    state.runs = out.runs || [];
    state.runsNote = out.note || null;
    emit('runs');
  } catch { /* the rail and the strip keep what they had */ }
}
let runsTimer = null;
function scheduleRuns() {
  clearTimeout(runsTimer);
  runsTimer = setTimeout(loadRuns, 200);
}

/** Sessions start and end without a task changing, so the status chip asks for them on those events. */
let runningLoad = 0;
async function loadRunningSessions() {
  const load = ++runningLoad;
  try {
    const out = await api.consoleSessions();
    if (load !== runningLoad) return;
    const list = Array.isArray(out) ? out : out.sessions || [];
    state.runningSessions = list.filter((s) => s.status === 'running');
    state.askingSessions = list.filter((s) => s.context === 'companion' && sessionAsks(s));
    renderStatus();
  } catch { /* the chip still says what the tasks say */ }
}

// ---------- layout ----------
/** The views that show the right panel (#collab) beside them: the Workbench and Learning (styles.css says the same). */
const PANEL_VIEWS = ['workbench', 'learning'];
const panelView = () => PANEL_VIEWS.includes(state.view);
const NARROW = window.matchMedia('(max-width: 1100px)');
/** Resolved prefs. Below 1100 px the Task | Focus panel is an overlay over the preview: it stays
 *  collapsed until opened (], the toolbar's Panel button, New task), whatever the stored pref says. */
function effectiveLayout() {
  const l = resolveLayout(state.settings, state.bundle?.project);
  if (NARROW.matches) l.collabCollapsed = { value: !state.narrowPanelOpen, scope: 'narrow window' };
  return l;
}
NARROW.addEventListener('change', () => { state.narrowPanelOpen = false; applyLayout(); });

function applyLayout() {
  const l = app.layout();
  const root = document.getElementById('app');
  root.classList.toggle('rail-collapsed', !!l.railCollapsed.value);
  root.classList.toggle('collab-collapsed', !!l.collabCollapsed.value);
  root.classList.toggle('narrow', NARROW.matches);
  // The right panel's width (a layout pref) applies while it is a column: on the Workbench and on Learning.
  const cw = Number(l.collabWidth?.value);
  if (panelView() && !l.collabCollapsed.value && !NARROW.matches && Number.isFinite(cw) && cw > 0) root.style.setProperty('--collab-w', `${cw}px`);
  else root.style.removeProperty('--collab-w');
  const theme = l.theme.value === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  const tb = document.getElementById('theme-toggle');
  tb.querySelector('use').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  tb.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  tb.title = tb.getAttribute('aria-label');
  applyLook(); // the accent is a shade per theme, so the look follows the theme
  emit('layout', l);
}

// ---------- the look (Settings, Appearance; components/appearance.js) ----------
/** The choices in effect on the root element, in the theme on screen. Until a server that knows the look has answered,
 *  what index.html applied for the first frame stays. */
function applyLook() {
  const look = state.lookPreview || state.appearance?.effective;
  if (look) applyAppearance(look, document.documentElement.dataset.theme);
}
function previewLook(look) {
  state.lookPreview = look || null;
  applyLook();
}
/** Save a patch (null resets every choice) through PATCH /api/settings, which checks it; then the state is read
 *  again, so what shows is what the server kept. A refusal throws its sentence and the look goes back. */
async function saveAppearance(patch) {
  try {
    await api.patchSettings({ appearance: patch });
    await loadStudio();
  } finally {
    previewLook(null);
  }
  return state.appearance;
}

async function setLayoutPref(scope, key, value) {
  const out = await setLayout(scope, key, value, { settings: state.settings, project: state.bundle?.project });
  applyLayout();
  return out;
}
/** Quick toggles from the UI chrome apply to this session; Settings can make them durable. */
function toggleLayout(key, value) {
  const cur = app.layout()[key].value;
  if (key === 'collabCollapsed' && NARROW.matches) { // the overlay is transient: nothing is stored
    state.narrowPanelOpen = !(value !== undefined ? value : !cur);
    applyLayout();
    return Promise.resolve();
  }
  const next = value !== undefined ? value : key === 'theme' ? (cur === 'light' ? 'dark' : 'light') : !cur;
  return setLayoutPref('session', key, next).catch((e) => toastError(e, 'Layout'));
}

/** The v key, the Versions button, the drawer's X and Esc. Opening moves focus into the drawer (its Restore and Verify are
 *  the point of opening it); closing returns it to the Versions button, or it would fall to the body. */
function toggleVersions(value, { versionId } = {}) {
  return toggleLayout('versionsOpen', value).then(() => {
    requestAnimationFrame(() => {
      // A mark on the version strip opens the drawer at its own row.
      if (versionId && app.layout().versionsOpen.value && focusVersionRow(document, versionId)) return;
      (app.layout().versionsOpen.value
        ? document.querySelector('#main .drawer:not([hidden])')?.querySelector('button:not([disabled]), select, input, [tabindex="0"]')
        : document.querySelector('#main .versions-bar button'))?.focus();
    });
  });
}

// ---------- global status chip (derived only from real state) ----------
function globalStatus() {
  if (state.bootError || state.sse === 'down') return { s: 'offline', why: state.bootError?.message || 'Live updates disconnected; retrying (30 s fallback refresh).' };
  if (state.saving > 0) return { s: 'saving', why: 'Writing changes to disk' };
  if (state.retrieving) return { s: 'retrieving', why: 'Loading project records, versions and tasks' };
  // A run that just ended, in any project, until the person clicks the chip or another run ends.
  if (state.endedRun) return { s: 'run-ended', run: state.endedRun, scoped: true };
  const running = state.runningSessions.filter((x) => x.projectId === state.activeProjectId);
  const asking = state.askingSessions.filter((x) => x.projectId === state.activeProjectId);
  const found = globalTaskState(state.bundle?.tasks || [], running.length, asking.length);
  const { state: st, count: n = 0, sessions = 0 } = found || {};
  if (st === 'needs-you') return { s: 'needs-you', count: n, scoped: true, companion: true };
  if (sessions) return { s: 'working', count: 0, sessions: running, target: '#/claude-code', scoped: true };
  if (st && st !== 'ready') return { s: st, count: n, scoped: true };
  if (state.apiUtility?.paused) return { s: 'paused', why: 'API utilities are paused; everything else works' };
  if (st === 'ready') return { s: 'ready', count: n, scoped: true };
  return { s: 'idle', why: 'No task is waiting, working or needs input' };
}
function renderStatus() {
  const host = document.getElementById('global-status');
  const { s, why, count, sessions, target: own, scoped, companion, run } = globalStatus();
  const target = own || (['needs-input', 'working', 'interrupted', 'review', 'record-result', 'ready'].includes(s) ? '#/tasks' : s === 'paused' ? '#/budget' : null);
  if (s === 'idle') return clear(host); // nothing is waiting: say nothing
  // Task and session counts belong to the active project; the server, a save and the API pause do not.
  // A run's chip names the run's own project, which need not be the open one.
  const open = state.bundle?.project;
  const nameOf = (id) => (open?.id === id && open.name) || state.projects.find((p) => p.id === id)?.name;
  const name = run ? (run.projectId ? nameOf(run.projectId) || 'a removed project' : 'the studio') : nameOf(state.activeProjectId) || 'this project';
  const words = scoped ? chipWords(s, count, sessions, name, backendLabel, run) : null;
  const said = words ? words.said : statusSentence(why, null);
  const c = chip(s, words ? said : why, words?.visible);
  // A companion's question opens the Workbench on its tab; a run's chip, its project at the Task or Phone tab.
  const openIt = run ? () => openRun(run) : companion ? () => showCompanion() : () => (location.hash = target);
  clear(host, target || companion || run ? el('button', { type: 'button', title: s === 'paused' ? why : `${scoped ? said : why} — open`, 'aria-label': said, onclick: openIt }, c) : c);
}
/** The run chip's click: the chip goes, the run's project opens in the Workbench at the Phone tab (a build or a boot)
 *  or the Task tab (the rest). A run with no project (a shell in the studio's folder) opens the Workbench as it is. */
async function openRun(run) {
  state.endedRun = null;
  renderStatus();
  if (run.projectId && state.projects.some((p) => p.id === run.projectId)) await selectProject(run.projectId);
  if (state.view !== 'workbench') go('workbench');
  if (runChipTab(run) === 'phone') {
    if (await waitUntil(() => app.workbench?.projectOnScreen?.() === state.activeProjectId)) app.workbench.showPanel('phone');
  } else app.showPanel('task');
}
async function showCompanion() {
  if (state.view === 'learning' && app.learning?.showCompanion) return app.learning.showCompanion(); // its own dock holds it
  if (state.view !== 'workbench') go('workbench');
  if (await waitUntil(() => app.workbench?.projectOnScreen?.() === state.activeProjectId)) app.workbench.showPanel('companion');
}
/** Switch to the Workbench if needed, show the Source tab and open the file (relative to the active project) at the
 *  line. Resolves what the dock's show() answers, or false when the Workbench never showed the project. */
async function openSource({ path, line } = {}) {
  if (!path) return false;
  if (state.view !== 'workbench') go('workbench');
  if (!(await waitUntil(() => app.workbench?.projectOnScreen?.() === state.activeProjectId))) {
    toast('The Source tab could not be shown: the Workbench did not load the project', { tone: 'danger' });
    return false;
  }
  return app.workbench.showPanel('source', { open: { path, line: Number.isInteger(line) && line >= 1 ? line : null } });
}
function showLesson(id) {
  if (!id) return;
  state.lessonWanted = { projectId: state.activeProjectId, id };
  if (state.view === 'learning' && app.learning) app.learning.pick(id);
  else go('learning');
}
onWrites((n) => { state.saving = n; renderStatus(); });

// ---------- router ----------
let current = null;
let mountSeq = 0;
function go(view) { location.hash = `#/${view}`; }
async function route() {
  const name = (location.hash.match(/^#\/([\w-]+)/) || [])[1];
  if (ALIASES[name]) { location.replace(`#/${ALIASES[name]}`); return; }
  const view = VIEWS[name] ? name : 'workbench';
  if (current?.name === view) return;
  const seq = ++mountSeq;
  state.view = view;
  document.getElementById('app').dataset.view = view;
  applyLayout(); // the right panel's width applies on the Workbench and Learning only
  for (const a of document.querySelectorAll('#view-tabs a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const main = document.getElementById('main');
  try {
    const mod = await VIEWS[view]();
    if (seq !== mountSeq) return;
    current?.mod.unmount?.();
    clear(main);
    current = { name: view, mod };
    mod.mount(main, app);
  } catch (err) {
    console.error(err);
    clear(main, el('div.page', el('div.empty.error', el('div.empty-title', 'This view failed to load'), el('p', err.message))));
  }
}

// ---------- shortcuts ----------
const SHORTCUTS = [
  ['?', 'Show this help'],
  ['1 – 8', 'Workbench · Learning · Inspiration · Claude Code · Tasks · Memory · Budget · Settings'],
  ['t', 'Try: reload the files on disk in the preview'],
  ['c', 'Compare versions'],
  ['s', 'Side by side: two live previews with mirrored keys'],
  ['k', 'Keep version'],
  ['v', 'Open or close the Versions drawer'],
  ['f', 'Expand: only the preview'],
  ['p', 'Collapse the pages column to a tag, or open it again'],
  ['[', 'Open the project picker in the top bar'],
  [']', 'Collapse or expand the right panel, on the Workbench and Learning (below 1100 px it opens over the page)'],
  ['Alt+← / Alt+→', 'On the Inspiration board: move the focused card earlier or later (Enter edits it, Delete removes it)'],
  ['Ctrl+Alt+R', 'Restart the studio: its server starts again with the code on disk'],
  ['Esc', 'Close a dialog, the Versions drawer or the panel over the preview'],
  ['Tab / Shift+Tab', 'Move between controls; Enter or Space activates'],
];
function showHelp() {
  dialog({
    title: 'Help',
    body: el('div.help',
      el('h3', 'Getting started'),
      el('p.prose-width', 'Start from an inspiration: a game, a site, a sound you like. Name the smallest piece of it that would make it real, and make that piece work. Then try it, compare it with what you kept, and keep the version you prefer.'),
      el('p.prose-width', 'Start with Workbench › Try, then Tuning; hand bigger work to Claude Code from the Task panel.'),
      el('p.prose-width', 'Ask the Companion to teach you something and the lesson opens in Learning, with the same conversation in the dock under it.'),
      el('p.prose-width', 'Collect what you like in Inspiration: drop or paste an image, a link, a hex color or a few words. Each project has its own board, and Claude reads it with every task.'),
      el('p.prose-width', 'Beside the board, Fixed rules holds what must stay the same in the project\'s design (a rule can lock a design token at one value). Claude is told to keep them in every task.'),
      el('p.prose-width', 'References, the third part there, holds what to build from: docs links, code snippets, prompts that worked and notes. A task whose request matches an entry\'s tags or words gets it in its brief.'),
      el('p.prose-width', 'The fourth part, Visualizer, draws the design the project\'s stylesheets really hold (colours, type, spacing, radii, motion) beside the board\'s colours and the fixed rules, and marks what drifts. Every value opens its line in the Source tab.'),
      el('p.prose-width', 'Settings › Appearance makes the studio look your way: the accent, density, text size, corners and motion, kept for you on this computer.'),
      button('Read the guide', { title: 'The studio guide (docs/GUIDE.md)', onclick: showGuide }),
      el('h3', 'Keyboard'),
      el('dl.kbd-list', SHORTCUTS.flatMap(([k, d]) => [el('dt', el('kbd', k)), el('dd', { style: { margin: 0 } }, d)])),
      el('p.hint', { style: { marginTop: '16px' } }, 'Single keys do nothing while you type in a field or while the preview has focus.')),
    actions: [{ label: 'Close', variant: 'primary' }],
  });
}
/** docs/GUIDE.md from the server (GET /api/guide answers the markdown as text), in a 720 dialog. */
async function showGuide() {
  const body = el('div.guide', { tabindex: '0', 'aria-label': 'Guide text' }, el('div.loading', el('span.spinner', { 'aria-hidden': 'true' }), 'Loading the guide…'));
  dialog({ title: 'Guide', wide: true, body, actions: [{ label: 'Close', variant: 'primary' }] });
  try {
    const res = await fetch('/api/guide', { headers: { Accept: 'text/markdown, text/plain' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'This studio server does not serve the guide yet; restart it, or open docs/GUIDE.md in the studio folder.' : `The guide could not be loaded (status ${res.status}).`);
    let text = await res.text();
    if (/^\s*\{/.test(text)) { try { const j = JSON.parse(text); text = j.markdown || j.text || text; } catch { /* plain text after all */ } }
    clear(body, markdown(text, 'prose md'));
  } catch (err) {
    clear(body, el('p.note.warn', err.message));
  }
}
// A Queued run is a waiting worker task, kept across the restart (server/lib/workers.mjs): it is counted, not stopped.
const restart = () => restartStudio({ working: (state.runs || []).filter((r) => isRunning(r) && r.state !== 'Queued').map((r) => r.name) });
function onKey(e) {
  // Ctrl+Alt+R restarts the studio's server (components/restart.js), wherever the focus is.
  if (e.ctrlKey && e.altKey && !e.metaKey && (e.key === 'r' || e.key === 'R') && !e.defaultPrevented) { e.preventDefault(); restart(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  const isHelp = e.key === '?' || (e.shiftKey && (e.key === '/' || e.code === 'Slash'));
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable="true"], dialog')) return;
  if (document.querySelector('dialog[open]')) return;
  const k = e.key;
  if (isHelp) { e.preventDefault(); showHelp(); return; }
  if (/^[1-9]$/.test(k) && Number(k) <= VIEW_ORDER.length) { go(VIEW_ORDER[Number(k) - 1]); return; }
  if (k === '[') { document.querySelector('#project-pick select')?.focus(); return; }
  if (k === ']') { if (!panelView()) go('workbench'); toggleLayout('collabCollapsed'); return; }
  const wb = state.view === 'workbench' ? app.workbench : null;
  if (!wb) return;
  if (k === 't') wb.tryHead();
  else if (k === 'c') wb.compare();
  else if (k === 's') wb.sideBySide();
  else if (k === 'k') wb.keep();
  else if (k === 'v') toggleVersions();
  else if (k === 'f') wb.focus?.();
  else if (k === 'p') wb.togglePages?.();
}
/** Esc closes the panel when it lies over the preview (narrow windows); focus goes to the Panel button. */
function onEscape(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !NARROW.matches || !state.narrowPanelOpen || !panelView()) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  toggleLayout('collabCollapsed', true);
  requestAnimationFrame(() => document.querySelector('#main .wb-panel-btn')?.focus());
}

// ---------- boot ----------
async function boot() {
  document.getElementById('theme-toggle').addEventListener('click', () => toggleLayout('theme'));
  document.getElementById('restart-btn').addEventListener('click', restart);
  document.getElementById('help-btn').addEventListener('click', showHelp);
  document.addEventListener('keydown', onEscape);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', route);
  const rail = () => { renderRail(document.getElementById('rail'), app); renderProjectPicker(document.getElementById('project-pick'), app); };
  on('studio', rail);
  on('bundle', rail);
  on('layout', rail);
  on('runs', rail);
  const collab = document.getElementById('collab');
  on('bundle', () => renderCollab(collab, app));
  on('task.changed', (d) => renderCollab(collab, app, d));
  on('project-switch', () => renderCollab(collab, app, { reset: true }));
  on('studio', () => renderCollab(collab, app, { focusOnly: true }));
  renderStatus();
  route();
  await loadStudio();
  if (state.bootError) toast(`Studio server unreachable: ${state.bootError.message}`, { tone: 'danger', timeout: 0 });
  connectEvents();
  loadRunningSessions();
  loadRuns();
  await loadBundle();
}
boot();
