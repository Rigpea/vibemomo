// The project picker in the top bar (DESIGN.md section 8): the open project's name as a select of every project, its
// kind in plain words beside it, and the live dot before the name while the project has a working run (the same dot
// the task bars use). "New project…" at the end opens the dialog. It replaces the left rail in the layout; the rail is
// still rendered for anything that reads it (components/rail.js), never shown.
import { el, clear } from './ui.js';
import { railDot } from './run-words.js';

const NEW = '__new';

export function renderProjectPicker(host, app) {
  const { state } = app;
  const active = state.projects.find((p) => p.id === state.activeProjectId) || null;
  const dot = active ? railDot(state.runs || [], active.id) : null;
  const hadFocus = host.contains(document.activeElement);
  const select = el('select.pick', {
    'aria-label': 'Project', title: active ? `${active.name} · ${active.kind}` : 'Choose a project',
    onchange: (e) => {
      const v = e.target.value;
      if (v === NEW) { e.target.value = state.activeProjectId || ''; app.newProject(); return; }
      app.selectProject(v);
    },
  },
  // The live dot stands before the select for the open project; the list marks the other working ones in text.
  state.projects.map((p) => el('option', { value: p.id }, `${p.id !== state.activeProjectId && railDot(state.runs || [], p.id) ? '● ' : ''}${p.name}`)),
  state.projects.length ? el('option', { value: '', disabled: true }, '────') : null,
  el('option', { value: NEW }, 'New project…'));
  if (active) select.value = active.id;
  clear(host,
    dot ? el('span.rail-dot', { title: dot.title, role: 'img', 'aria-label': dot.title }) : null,
    state.bootError ? el('span.meta', 'Projects unavailable') : state.projects.length ? select : null,
    !state.bootError && !state.projects.length ? el('button.btn.quiet.sm', { type: 'button', onclick: () => app.newProject() }, 'New project') : null,
    active ? el('span.pick-kind', active.kind) : null);
  if (hadFocus) select.focus();
}
