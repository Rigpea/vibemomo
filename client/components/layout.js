// Layout preferences with explicit scope. Resolution order (first defined wins):
//   this session (sessionStorage) > this project (project.ui.layout) > studio default (settings.ui.layout) > built-in.
import { api } from '../api.js';

export const LAYOUT_KEYS = {
  railCollapsed: { label: 'Project list collapsed', type: 'bool', def: false },
  collabCollapsed: { label: 'Task | Focus panel collapsed', type: 'bool', def: false },
  leftCollapsed: { label: 'Pages column collapsed to a tag', type: 'bool', def: false },
  versionsOpen: { label: 'Versions drawer open', type: 'bool', def: false },
  // The Working now strip under the preview: hidden unless the person asks (the More menu's toggle, Settings).
  runsShown: { label: 'Runs shown under the preview', type: 'bool', def: false },
  theme: { label: 'Theme', type: 'theme', def: 'dark' },
  // The sizes the splitters set (components/splitter.js): px, or none for the stylesheet's default.
  leftWidth: { label: 'Pages column width (px)', type: 'number', def: 236 },
  collabWidth: { label: 'Task inspector width (px)', type: 'number', def: 340 },
  timelineHeight: { label: 'Timeline height (px)', type: 'number', def: null },
};
export const SCOPES = [
  ['session', 'This session'],
  ['project', 'This project'],
  ['studio', 'Studio default'],
];
const SS_KEY = 'atelier.layout';

export function sessionLayout() {
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) || '{}'); } catch { return {}; }
}
function writeSession(obj) { sessionStorage.setItem(SS_KEY, JSON.stringify(obj)); }

/** Layers by scope for the given studio settings + project. */
export function layers(settings, project) {
  return {
    session: sessionLayout(),
    project: project?.ui?.layout || {},
    studio: settings?.ui?.layout || {},
  };
}

/** Effective value + the scope it came from, per key. */
export function resolveLayout(settings, project) {
  const l = layers(settings, project);
  const out = {};
  for (const [key, meta] of Object.entries(LAYOUT_KEYS)) {
    const scope = ['session', 'project', 'studio'].find((s) => l[s][key] !== undefined);
    out[key] = { value: scope ? l[scope][key] : meta.def, scope: scope || 'built-in' };
  }
  return out;
}

/**
 * Write one key at one scope. value === undefined removes the key at that scope.
 * Returns {scope, key, prev} so the caller can undo. Server writes go through the API.
 */
export async function setLayout(scope, key, value, { settings, project }) {
  const prev = layers(settings, project)[scope][key];
  if (scope === 'session') {
    const s = sessionLayout();
    if (value === undefined) delete s[key]; else s[key] = value;
    writeSession(s);
  } else if (scope === 'project') {
    if (!project) throw new Error('Open a project first');
    const layout = { ...(project.ui?.layout || {}) };
    if (value === undefined) delete layout[key]; else layout[key] = value;
    const saved = await api.patchProject(project.id, { ui: { ...(project.ui || {}), layout } });
    project.ui = saved.ui;
  } else if (scope === 'studio') {
    const layout = { ...(settings?.ui?.layout || {}) };
    if (value === undefined) delete layout[key]; else layout[key] = value;
    const saved = await api.patchSettings({ ui: { ...(settings?.ui || {}), layout } });
    settings.ui = saved.ui;
  }
  return { scope, key, prev };
}
