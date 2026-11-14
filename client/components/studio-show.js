// studio.show: a companion's atelier_studio_show moves this window (server/lib/mcp/show.mjs checks the request;
// docs/ARCHITECTURE.md section 11). Select the project, go to the view, pick the dock tab, turn Point mode on, or open
// a file at a line in the Source tab (the same command app.openSource gives the dock), or show a lesson in the Learning
// view (app.showLesson, which the view takes when it mounts or at once when it is on screen). No DOM of its own, so a test
// drives it with a stub app (tests/studio-show.test.mjs).

export const VIEW_ROUTES = { workbench: 'workbench', learning: 'learning', inspiration: 'inspiration', console: 'claude-code', tasks: 'tasks', memory: 'memory', settings: 'settings' };
export const PANEL_KINDS = { devices: 'web-app', phone: 'phone', play: 'game', tuning: 'action', audio: 'audio', page: 'page', source: 'source' };
const PANEL_WORDS = { devices: 'Devices', phone: 'Phone', play: 'Play', tuning: 'Tuning', audio: 'Audio', page: 'Page', source: 'Source' };

/** Resolves true once test() holds, false after ms. */
export function waitUntil(test, { ms = 5000, every = 50 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = !!test(); } catch { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - t0 >= ms) return resolve(false);
      setTimeout(tick, every);
    };
    tick();
  });
}

/** The command the dock hands the panel: Point mode for the phone, the file and line for the Source tab. */
export function panelCommand(d = {}) {
  if (d.panel === 'source' && d.file) return { open: { path: d.file, line: Number.isInteger(d.line) ? d.line : null } };
  return typeof d.point === 'boolean' ? { point: d.point } : {};
}

/**
 * Act on one studio.show payload { projectId?, view?, panel?, point?, file?, line?, lesson? }. Returns what was done:
 * { project, view, panel, lesson, toast } with false or null for what was not. toast(text, opts) is ui.js's.
 * A file with no panel (a server from before the Source tab) opens in the Source tab all the same.
 */
export async function handleStudioShow(app, payload = {}, { toast = () => {}, wait = waitUntil } = {}) {
  const d = payload.file && !payload.panel ? { ...payload, panel: 'source', view: payload.view || 'workbench' } : payload;
  const done = { project: null, view: null, panel: null, lesson: null, toast: null };
  const say = (text, opts) => { done.toast = text; toast(text, opts); };
  if (d.projectId && d.projectId !== app.state.activeProjectId) {
    if (!app.state.projects.some((p) => p.id === d.projectId)) {
      say(`The companion asked for a project this window does not list (${d.projectId})`, { tone: 'danger' });
      return done;
    }
    await app.selectProject(d.projectId);
  }
  done.project = app.state.activeProjectId;
  // A lesson: the Learning view of the project just selected, at that lesson (the view fetches it by id).
  if (typeof d.lesson === 'string' && d.lesson) {
    if (typeof app.showLesson === 'function') { app.showLesson(d.lesson); done.view = 'learning'; done.lesson = d.lesson; }
    else say('This window cannot show lessons yet: reload it', { tone: 'danger' });
    return done;
  }
  const view = VIEW_ROUTES[d.view] ? d.view : null;
  if (view) {
    if (app.state.view !== VIEW_ROUTES[view]) app.go(VIEW_ROUTES[view]);
    done.view = view;
  }
  const kind = PANEL_KINDS[d.panel];
  if (kind) {
    // The Workbench mounts after the route change and shows the project once its bundle is in.
    const ready = await wait(() => app.workbench?.projectOnScreen?.() && app.workbench.projectOnScreen() === app.state.activeProjectId);
    done.panel = ready ? await app.workbench.showPanel(kind, panelCommand(d)) : false;
    if (!done.panel) say(ready ? `${app.project()?.name || 'This project'} has no ${PANEL_WORDS[d.panel]} panel` : `The ${PANEL_WORDS[d.panel]} panel could not be shown: the Workbench did not load the project`, { tone: 'danger' });
  }
  return done;
}
