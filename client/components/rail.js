// Left rail: the project list (name, kind, last opened) and New project. Nothing else:
// the current piece, release, unresolved and identity live in the Workbench's Focus panel.
import { el, clear, button, ago } from './ui.js';
import { railDot } from './run-words.js';

/** A project's name on the rail, with the live dot while it has a working run (the dot the task bars use). */
export function railTitle(p, runs) {
  const dot = railDot(runs, p.id);
  // The dot comes first so a long name's ellipsis never hides it.
  return el('span.item-title', dot ? el('span.rail-dot', { title: dot.title, role: 'img', 'aria-label': dot.title }) : null, p.name);
}

export function renderRail(host, app) {
  const { state } = app;
  const collapsed = app.layout().railCollapsed.value;
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.pid || document.activeElement.dataset.role : null;
  const head = el('div.rail-head',
    el('span.overline', 'Projects'),
    button('', { icon: 'sidebar', small: true, variant: 'quiet', title: collapsed ? 'Show projects ([)' : 'Hide projects ([)', 'aria-expanded': String(!collapsed), dataset: { role: 'toggle' }, onclick: () => app.toggleLayout('railCollapsed') }));
  const body = el('div.rail-body');
  if (state.bootError) body.append(el('p.meta', { style: { padding: '0 8px' } }, 'Projects are unavailable while the server is unreachable.'));
  else if (state.projects.length) {
    body.append(el('ul.list', state.projects.map((p) => el('li',
      el('button.item', { type: 'button', 'aria-current': p.id === state.activeProjectId ? 'true' : 'false', dataset: { pid: p.id }, onclick: () => app.selectProject(p.id) },
        railTitle(p, state.runs || []),
        el('span.item-meta', `${p.kind} · ${p.id === state.activeProjectId ? 'open' : `opened ${ago(p.lastOpenedAt)}`}`))))));
  }
  body.append(button('New project', { icon: 'plus', variant: 'quiet', small: true, class: 'rail-new', dataset: { role: 'new' }, onclick: () => app.newProject() }));
  clear(host, head, body);
  if (focused) host.querySelector(`[data-pid="${focused}"], [data-role="${focused}"]`)?.focus();
}
