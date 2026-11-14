// Tasks: every task of the project (or, in the All projects scope, of every registered project)
// as a plain list grouped by state; rows open in place.
// Status is derived from task events and git, never set by hand.
import { el, clear, button, empty, loading, errorBox, segmented } from '../components/ui.js';
import { createTaskList } from '../components/task-list.js';
import { taskState } from '../components/status-words.js';

// Reading order: what needs you first, finished work last (collapsed).
const GROUPS = [
  ['needs-input', 'Needs your input'],
  ['working', 'Working'],
  ['interrupted', 'Interrupted'],
  ['review', 'Ready to try'],
  ['record-result', 'Record the result'],
  ['ready', 'Ready for Claude Code'],
  ['draft', 'Draft'],
  ['done', 'Done', true],
  ['cancelled', 'Cancelled', true],
];
const SCOPE_KEY = 'atelier.tasksScope';
let v = null;

export function mount(host, app) {
  const body = el('div');
  const scope = sessionStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'project';
  v = { app, body, scope, all: null, allError: null, lists: new Map(), open: new Set(JSON.parse(sessionStorage.getItem('atelier.taskGroupsOpen') || '[]')), offs: [] };
  const seg = segmented([['project', 'This project'], ['all', 'All projects']], scope, (k) => {
    v.scope = k; sessionStorage.setItem(SCOPE_KEY, k);
    v.lists.forEach((l) => l.destroy()); v.lists.clear(); v.nodes = null; // each scope keeps its own rows
    if (k === 'all') loadAll(); else render();
  }, { label: 'Show tasks of' });
  clear(host, el('div.page', el('div.page-inner',
    el('div.page-head', el('h1', 'Tasks'), button('New task', { variant: 'primary', onclick: () => app.showPanel('task') })),
    el('div.tasks-scope', seg.node),
    body)));
  v.offs.push(
    app.on('bundle', () => (v.scope === 'all' ? scheduleAll() : render())),
    app.on('task.changed', (d) => { v.lists.forEach((l) => l.invalidate(d?.taskId)); if (v.scope === 'all') scheduleAll(); }),
    // All projects keeps its open rows across a switch: a row of the newly active project gains its actions.
    app.on('project-switch', () => { if (v.scope === 'project') v.lists.forEach((l) => l.reset()); }),
  );
  if (scope === 'all') loadAll(); else render();
}

export function unmount() { clearTimeout(v?.allTimer); v?.offs.forEach((off) => off()); v?.lists.forEach((l) => l.destroy()); v = null; }

/** GET /api/tasks: every registered project's tasks, each with projectId/projectName. */
async function loadAll() {
  if (!v) return;
  const mine = v;
  if (!mine.all) render();
  try {
    const out = await mine.app.api.allTasks();
    mine.all = out.tasks || []; mine.allError = null;
  } catch (err) { mine.allError = err; }
  if (v === mine && v.scope === 'all') render();
}
function scheduleAll() { clearTimeout(v.allTimer); v.allTimer = setTimeout(loadAll, 300); }

function listFor(status) {
  if (!v.lists.has(status)) v.lists.set(status, createTaskList(v.app, { showStatus: false, allProjects: v.scope === 'all' }));
  return v.lists.get(status);
}

/** The tasks the current scope shows, or a node to show instead (empty, loading, error). */
function scopeTasks() {
  const { app } = v;
  if (v.scope === 'all') {
    if (v.allError && !v.all) return errorBox(v.allError, () => loadAll());
    if (!v.all) return loading('Loading tasks of every project…');
    return v.all.length ? v.all : empty('No tasks in any project yet.');
  }
  const b = app.state.bundle;
  if (!app.projectId()) return empty('Create a project to start.', null, button('New project', { onclick: () => app.newProject() }));
  if (!b) return app.state.bundleError ? errorBox(app.state.bundleError, () => app.loadBundle()) : loading('Loading tasks…');
  return b.tasks?.length ? b.tasks : empty('No tasks yet. Describe a change in the Workbench panel.');
}

function render() {
  if (!v) return;
  const got = scopeTasks();
  if (!Array.isArray(got)) return clear(v.body, got);
  const tasks = [...got].sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || ''));
  const known = new Set(GROUPS.map(([k]) => k));
  const groups = [...GROUPS, ...[...new Set(tasks.map(taskState))].filter((s) => !known.has(s)).map((s) => [s, s])];
  // Keep group nodes (and their expanded rows) across re-renders.
  v.nodes ||= new Map();
  const shown = [];
  for (const [status, label, collapsible] of groups) {
    const items = tasks.filter((t) => taskState(t) === status);
    if (!items.length) continue;
    const list = listFor(status);
    list.render(items);
    let node = v.nodes.get(status);
    const head = [el('h2', label), el('span.meta', String(items.length))];
    if (collapsible) {
      if (!node) {
        node = el('details.group', { open: v.open.has(status) || undefined });
        node.addEventListener('toggle', () => {
          if (node.open) v.open.add(status); else v.open.delete(status);
          sessionStorage.setItem('atelier.taskGroupsOpen', JSON.stringify([...v.open]));
        });
      }
      clear(node, el('summary', head), list.node);
    } else {
      node ||= el('section.group');
      clear(node, el('div.section-head', head), list.node);
    }
    v.nodes.set(status, node);
    shown.push(node);
  }
  clear(v.body, shown);
}
