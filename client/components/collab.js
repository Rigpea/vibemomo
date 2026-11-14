// The right panel of the Workbench and of Learning (DESIGN.md section 8): the task inspector at the top (components/task-inspector.js: the
// task in focus, as the reference), this project's tasks under it, the composer that hands work to Claude Code behind
// "New task", and Focus (current piece, next release, unresolved, identity: components/focus.js) behind its button,
// beside Processes (components/process-graph.js) and Skills (Claude Code skills: components/skills-panel.js).
import { el, clear, button, textarea, input, select, field, toast, toastError, empty, shortLabel } from './ui.js';
import { createTaskList, MODE_LABELS } from './task-list.js';
import { createTaskInspector } from './task-inspector.js';
import { createSplitter } from './splitter.js';
import { renderFocus } from './focus.js';
import { createProcessGraph } from './process-graph.js';
import { createSkillsPanel } from './skills-panel.js';
import { taskPlaceholders } from './task-placeholders.js';

const TAB_KEY = 'atelier.panelTab';
const MORE_KEY = 'atelier.composerMore';
let built = null; // { host, app, list, timeline, focus, taskPane, seg, request, acceptance, sendBtn, syncSend, composerReset }

export function renderCollab(host, app, detail = {}) {
  if (!built || built.host !== host) { built?.list.destroy(); built?.inspector.destroy(); built = build(host, app); }
  if (detail.reset) { built.list.reset(); built.composerReset(); }
  if (!built.focus.hidden) renderFocus(built.focus, app);
  if (detail.focusOnly) return;
  const b = app.state.bundle;
  const pid = app.projectId();
  built.syncSend();
  if (!pid) return clear(built.timeline, empty('Create a project to start.', null, button('New project', { onclick: () => app.newProject() })));
  if (!b) return clear(built.timeline, el('div.loading', el('span.spinner'), 'Loading tasks…'));
  const examples = taskPlaceholders(b.project?.kind);
  built.request.placeholder = examples.request;
  built.acceptance.placeholder = examples.acceptance;
  if (built.timeline.firstChild !== built.list.node) clear(built.timeline, built.list.node);
  const tasks = [...(b.tasks || [])].sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || ''));
  clear(built.tasksCount, tasks.length ? String(tasks.length) : '');
  built.list.render(tasks);
  built.inspector.update(tasks);
  // A task.changed always names its project; bundle renders pass nothing and must not refetch.
  if (detail.taskId) built.list.invalidate(detail.taskId);
  else if (detail.projectId === pid) built.list.invalidate(null); // the event does not say which task: refresh every open one
}

/** Switch the panel to 'task' or 'focus' (used by app.showPanel and the Tasks page). */
export function showPanel(tab, { taskId } = {}) {
  if (!built) return;
  built.setTab(tab);
  // The panel may still be hidden for a frame or two (a route change, the layout pref being
  // applied): retry until the field is rendered and actually holds focus.
  let tries = 0;
  const attempt = () => {
    if (tab === 'task' && !taskId) built.composerWrap.open = true; // the composer waits behind New task
    const target = tab === 'task' && taskId ? taskTarget(built.timeline, taskId) : tab === 'task' ? built.request : built.focus.querySelector('button, input, textarea');
    if (taskId && target) target.closest?.('article.task')?.scrollIntoView?.({ block: 'nearest' });
    if (target && target.offsetParent) target.focus();
    if ((!target || document.activeElement !== target) && ++tries < 30) setTimeout(attempt, 40);
  };
  requestAnimationFrame(attempt);
}

/** A task's row in the Task tab: its Activity line when it has one, else the row's own button. */
export function taskTarget(timeline, taskId) {
  const row = [...(timeline?.querySelectorAll?.('article.task') || [])].find((n) => n.dataset?.tid === taskId);
  return row ? row.querySelector('details.task-activity > summary') || row.querySelector('.task-sum') : null;
}

function build(host, app) {
  let inspector = null;
  const list = createTaskList(app, { compact: true, onToggle: (tid, open) => { if (open) inspector?.pick(tid); }, onRender: () => inspector?.refresh() });
  inspector = createTaskInspector(app, {
    sourceOf: (t) => list.activitySource(t),
    onFollow: (sessionId) => { sessionStorage.setItem('atelier.consoleSession', sessionId); sessionStorage.setItem('atelier.consoleMode', 'chat'); sessionStorage.setItem('atelier.consoleScope', 'project'); app.go('claude-code'); },
    // The Companion is in the Workbench's dock, or in the Learning view's when that view is on screen.
    onAsk: () => (app.learning?.showCompanion ? app.learning.showCompanion() : app.workbench?.showPanel?.('companion'))?.then(() => document.querySelector('#main .cmp-composer textarea')?.focus()),
  });
  const timeline = el('div.timeline', { role: 'region', 'aria-label': 'Tasks of this project' });
  const focus = el('div.focus', { role: 'region', 'aria-label': 'Focus' });

  // Their placeholders follow the project kind: renderCollab sets them once the bundle is there.
  const request = textarea({ rows: 3 });
  const inspiration = input({ placeholder: 'A game, site, sound or link (optional)' });
  const acceptance = textarea({ rows: 2 });
  const mode = select(Object.entries(MODE_LABELS), 'handle', { 'aria-label': 'How Claude Code works with you' });
  // The studio's skill departments (the Skills tab keeps them; components/skill-departments.js). Optional: the worker on
  // a task with one is told to use that department's skills.
  const department = select([['', 'None']], '', { 'aria-label': 'Department whose skills the worker uses' });
  const moreWords = el('span', 'More: inspiration, acceptance, department');
  const syncMore = () => {
    const name = department.value ? department.selectedOptions[0]?.textContent : '';
    clear(moreWords, `More: inspiration, acceptance, department${name ? ` · ${name}` : ''}`);
  };
  department.addEventListener('change', syncMore);
  /** Fill the choices from the departments as the Skills tab last read them; a chosen one that is gone goes back to None. */
  const setDepartments = (list) => {
    const was = department.value;
    clear(department, el('option', { value: '' }, 'None'), ...(list || []).map((d) => el('option', { value: d.id }, d.name)));
    department.value = (list || []).some((d) => d.id === was) ? was : '';
    syncMore();
  };
  const sendBtn = button('Create task', { variant: 'primary', type: 'submit' });
  // The list needs the height more than these two fields do: they wait behind a disclosure.
  const more = el('details.more.composer-more',
    { open: sessionStorage.getItem(MORE_KEY) === 'open', ontoggle: () => sessionStorage.setItem(MORE_KEY, more.open ? 'open' : 'closed') },
    // In a short window the opened fields would start below the fold: bring them into view when the person opens them.
    el('summary', { onclick: () => requestAnimationFrame(() => { if (more.open) form.scrollTop += more.getBoundingClientRect().top - form.getBoundingClientRect().top - 8; }) }, moreWords),
    field('Inspiration', inspiration),
    field('Acceptance (optional, one per line)', acceptance, 'Becomes the task’s acceptance conditions.'),
    field('Department (optional)', department, 'The worker is told to use this department’s skills (Skills tab).'));
  const form = el('form.composer', { onsubmit: (e) => { e.preventDefault(); send(); } },
    field('Request', request), more,
    field('How to work with you', mode),
    el('div.composer-foot', el('span.hint', 'Nothing runs until you hand it over: Run with Claude Code here on its row.'), sendBtn));
  request.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  let sending = false;
  let sendWords = 'Create task';
  /** The form outlives a project switch (a typed request stays), so the button says where the task goes. */
  const projectName = () => {
    const pid = app.projectId();
    const open = app.state.bundle?.project;
    return (open?.id === pid && open.name) || app.state.projects.find((p) => p.id === pid)?.name || null;
  };
  const syncSend = () => {
    sendBtn.disabled = sending || !app.state.bundle || !request.value.trim();
    const name = projectName();
    const words = name ? `Create task on ${shortLabel(name, 28)}` : 'Create task';
    if (words !== sendWords) clear(sendBtn, el('span', words));
    sendWords = words;
    const whole = name ? `Create task on ${name}` : 'Create task';
    sendBtn.setAttribute('aria-label', whole); // a title alone would name the button by the project only
    if (words !== whole) sendBtn.title = name; // the whole name, when the button had to cut it
    else sendBtn.removeAttribute('title');
  };
  request.addEventListener('input', syncSend);
  const tasksCount = el('span.tasks-count');
  const composerWrap = el('details.composer-wrap', { open: sessionStorage.getItem('atelier.composerOpen') === 'open', ontoggle: () => sessionStorage.setItem('atelier.composerOpen', composerWrap.open ? 'open' : 'closed') },
    el('summary', 'New task'), form);
  const taskPane = el('div.collab-task', inspector.node, el('div.tasks-head', el('span.overline', 'Tasks'), tasksCount), timeline, composerWrap);

  const processes = createProcessGraph(app);
  const saved = sessionStorage.getItem(TAB_KEY);
  const skills = createSkillsPanel(app, { onDepartments: setDepartments });
  let tab = ['focus', 'processes', 'skills'].includes(saved) ? saved : 'task';
  let focusBtn = null;
  let processBtn = null;
  let skillsBtn = null;
  let tasksBtn = null;
  const setTab = (t) => {
    tab = t;
    sessionStorage.setItem(TAB_KEY, t);
    taskPane.hidden = t !== 'task';
    focus.hidden = t !== 'focus';
    processes.node.hidden = t !== 'processes';
    skills.node.hidden = t !== 'skills';
    focusBtn?.setAttribute('aria-pressed', String(t === 'focus'));
    processBtn?.setAttribute('aria-pressed', String(t === 'processes'));
    skillsBtn?.setAttribute('aria-pressed', String(t === 'skills'));
    // The open tab's own button steps aside (its name is the title): five buttons and the title no longer fit the head.
    if (tasksBtn) tasksBtn.hidden = t === 'task';
    if (processBtn) processBtn.hidden = t === 'processes';
    if (skillsBtn) skillsBtn.hidden = t === 'skills';
    clear(title, t === 'focus' ? 'Focus' : t === 'processes' ? 'Processes' : t === 'skills' ? 'Skills' : 'Task inspector');
    if (t === 'focus') renderFocus(focus, app);
    if (t === 'processes') requestAnimationFrame(() => processes.render());
    if (t === 'skills') skills.render();
    head.dataset.tab = t; // the task's state chip belongs to the Task inspector
  };
  const title = el('h2.collab-title', 'Task inspector');
  // Focus shows the Focus view (and stays on it when pressed again); Tasks, shown beside it then, goes back.
  focusBtn = button('Focus', { small: true, variant: 'quiet', 'aria-pressed': 'false', title: 'The current piece, the next release, unresolved questions and the project\'s identity', onclick: () => setTab('focus') });
  tasksBtn = button('Tasks', { small: true, variant: 'quiet', hidden: true, title: 'Back to the task inspector and the tasks', onclick: () => setTab('task') });
  processBtn = button('Processes', { small: true, variant: 'quiet', 'aria-pressed': 'false', title: 'What is working on this project now: each run as a node reporting to the project, its line saying its state', onclick: () => setTab('processes') });
  skillsBtn = button('Skills', { small: true, variant: 'quiet', 'aria-pressed': 'false', title: 'The Claude Code skills sessions in this project can use, by department; place them, add one from a folder or a .zip', onclick: () => { setTab('skills'); skills.focus(); } }); // the button hides: the focus goes to the filter
  skillsBtn.append(skills.count); // the number of skills found, once the first scan answers
  // Beside the preview: "Hide this panel"; over the preview (narrow windows): a close ×, Esc too.
  const head = el('div.collab-head', title, el('span.spacer'), inspector.chip, tasksBtn, processBtn, skillsBtn, focusBtn,
    button('', { icon: 'sidebar', small: true, variant: 'quiet', class: 'collab-hide', title: 'Hide this panel (])', onclick: () => app.toggleLayout('collabCollapsed', true) }),
    button('', { icon: 'x', small: true, variant: 'quiet', class: 'collab-close', title: 'Close the panel (Esc)', onclick: () => { app.toggleLayout('collabCollapsed', true); requestAnimationFrame(() => document.querySelector('#main .wb-panel-btn')?.focus()); } }));

  async function send() {
    if (sending) return; // Ctrl+Enter does not pass through the disabled button
    const text = request.value.trim();
    if (!text) { request.focus(); toast('Write a request first', { tone: 'warn', timeout: 2000 }); return; }
    sending = true;
    syncSend();
    try {
      const lines = acceptance.value.split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
      const task = await app.api.createTask(app.projectId(), { request: text, inspiration: inspiration.value.trim() || undefined, acceptance: lines.length ? lines : undefined, mode: mode.value || 'handle', department: department.value || undefined });
      request.value = '';
      inspiration.value = '';
      acceptance.value = '';
      toast(`Task created: ${shortLabel(task.title, 60)}`, { tone: 'ok', clears: 'Could not create the task' });
      await app.loadBundle({ quiet: true });
      list.expand(task.id);
    } catch (err) {
      toastError(err, 'Could not create the task');
    } finally {
      sending = false;
      syncSend();
    }
  }

  clear(host, head, taskPane, focus, processes.node, skills.node);
  // The panel's width is the person's: dragged on its left edge, kept as a layout pref (the shell applies it).
  host.append(createSplitter({ axis: 'x', sign: -1, min: 280, max: 600, label: 'Width of the task inspector',
    read: () => host.getBoundingClientRect().width || 340, apply: (px) => document.getElementById('app')?.style.setProperty('--collab-w', `${px}px`),
    save: (px) => app.setLayoutPref('studio', 'collabWidth', px).catch((err) => toast(`Width not saved: ${err.message}`, { tone: 'danger' })) }));
  const out = { host, app, list, inspector, tasksCount, composerWrap, timeline, focus, taskPane, request, acceptance, sendBtn, syncSend, setTab, composerReset: () => {
    // The form belongs to a project, but a request still in the field is the person's work: all of it stays, mode too.
    if (request.value.trim()) return;
    request.value = ''; inspiration.value = ''; acceptance.value = ''; mode.value = 'handle'; department.value = ''; syncMore();
    syncSend();
  } };
  built = out;
  setTab(tab);
  skills.load(); // the count shows on the tab before it is opened
  return out;
}
