// studio.show (docs/ARCHITECTURE.md section 11): the request check the route and the tool share, and the client's
// handler on a stub app. Risks covered: a panel or Point mode outside the Workbench is refused rather than half
// done; the handler switches the project before it shows anything, waits for the Workbench to show that project
// before it picks the panel, says so when the project has no such panel, and hands a file and line to the Source
// panel as its open command. The dock's show() and the panels' command() are covered on their own
// (tests/phone-panel.test.mjs, tests/source-tab.test.mjs); app.js only queues the event into this handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShow, SHOW_PANELS, SHOW_VIEWS } from '../server/lib/mcp/show.mjs';
import { handleStudioShow, waitUntil, panelCommand, PANEL_KINDS, VIEW_ROUTES } from '../client/components/studio-show.js';
import { panelKinds } from '../client/components/dock.js';

test('checkShow: a panel or point implies the workbench, Point mode implies the phone panel; wrong mixes are refused in words', () => {
  assert.deepEqual(checkShow({ projectId: 'p_1', point: true }), { show: { projectId: 'p_1', view: 'workbench', panel: 'phone', point: true } });
  assert.deepEqual(checkShow({ panel: 'tuning' }), { show: { view: 'workbench', panel: 'tuning' } });
  assert.deepEqual(checkShow({ view: 'tasks' }), { show: { view: 'tasks' } });
  // A file opens in the Source panel, so it implies that panel and the Workbench.
  assert.deepEqual(checkShow({ file: ' src/a.js ', line: 3 }), { show: { view: 'workbench', panel: 'source', file: 'src/a.js', line: 3 } });
  assert.deepEqual(checkShow({ panel: 'source', file: 'a.js' }), { show: { view: 'workbench', panel: 'source', file: 'a.js' } });
  assert.deepEqual(checkShow({ panel: 'page' }), { show: { view: 'workbench', panel: 'page' } });
  assert.deepEqual(checkShow({ panel: 'source' }), { show: { view: 'workbench', panel: 'source' } }, 'the tab alone');
  for (const [body, words] of [
    [{ panel: 'phone', file: 'a.js' }, /a file opens in the source panel, not the phone panel/],
    [{ point: true, file: 'a.js', line: 2 }, /a file opens in the source panel, not the phone panel/],
    [{ view: 'tasks', file: 'a.js' }, /source panel is in the workbench view, not tasks/],
    [{ view: 'tasks', panel: 'phone' }, /phone panel is in the workbench view, not tasks/],
    [{ panel: 'tuning', point: true }, /Point mode belongs to the phone panel/],
    [{ view: 'nowhere' }, /view must be one of workbench, learning, inspiration, console, tasks, memory, settings/],
    [{ panel: 'drums' }, /panel must be one of/],
    [{ line: 4 }, /line needs file/],
    [{ file: 'a.js', line: 0 }, /line must be a whole number/],
    [{ point: 'yes' }, /point must be true or false/],
    [{ projectId: '../x' }, /projectId must be a project id/],
    [{}, /Nothing to show/],
  ]) assert.match(checkShow(body).error || '', words, JSON.stringify(body));
});

test('every panel name maps to a dock kind and every view to a route', () => {
  assert.deepEqual(Object.keys(PANEL_KINDS), ['devices', 'phone', 'play', 'tuning', 'audio', 'page', 'source']);
  assert.deepEqual(Object.keys(PANEL_KINDS), SHOW_PANELS, 'the client maps every panel the server lets through');
  // The dock's kinds for a game with tuning, cues and a phone, and for a web app: every mapped kind can occur.
  const kinds = new Set([...panelKinds({ kind: 'game', tuning: {}, cues: [1], devices: { android: {} } }, { phone: true }), ...panelKinds({ kind: 'web-app' })]);
  for (const k of Object.values(PANEL_KINDS)) assert.ok(kinds.has(k), k);
  assert.deepEqual(VIEW_ROUTES, { workbench: 'workbench', learning: 'learning', inspiration: 'inspiration', console: 'claude-code', tasks: 'tasks', memory: 'memory', settings: 'settings' });
  assert.deepEqual(Object.keys(VIEW_ROUTES), SHOW_VIEWS, 'the client routes every view the server lets through');
});

function stubApp({ active = 'p_1', projects = ['p_1', 'p_2'], panels = ['game', 'phone'], view = 'tasks' } = {}) {
  const calls = [];
  const app = {
    state: { activeProjectId: active, projects: projects.map((id) => ({ id, name: id === 'p_2' ? 'Harbor' : 'Room' })), view },
    project: () => app.state.projects.find((p) => p.id === app.state.activeProjectId),
    workbench: null,
    async selectProject(id) { calls.push(['select', id]); app.state.activeProjectId = id; },
    go(route) {
      calls.push(['go', route]);
      app.state.view = route;
      // The Workbench mounts a moment later and shows the active project once its bundle is in.
      if (route === 'workbench') setTimeout(() => {
        app.workbench = { projectOnScreen: () => app.state.activeProjectId, async showPanel(kind, command) { calls.push(['panel', kind, command]); return panels.includes(kind); } };
      }, 20);
    },
  };
  return { app, calls };
}

test('the handler switches the project, goes to the Workbench, waits for it and opens the phone panel with Point mode', async () => {
  const { app, calls } = stubApp();
  const toasts = [];
  const done = await handleStudioShow(app, { projectId: 'p_2', view: 'workbench', panel: 'phone', point: true }, { toast: (t, o) => toasts.push([t, o]) });
  assert.deepEqual(calls, [['select', 'p_2'], ['go', 'workbench'], ['panel', 'phone', { point: true }]]);
  assert.deepEqual(done, { project: 'p_2', view: 'workbench', panel: true, lesson: null, toast: null });
  assert.deepEqual(toasts, []);
});

test('a file and line open in the Source panel as the command app.openSource gives; the Page panel opens with no command', async () => {
  const { app, calls } = stubApp({ panels: ['source', 'page'] });
  const toasts = [];
  const done = await handleStudioShow(app, { projectId: 'p_2', view: 'workbench', panel: 'source', file: 'src/game.js', line: 12 }, { toast: (t) => toasts.push(t) });
  assert.deepEqual(calls, [['select', 'p_2'], ['go', 'workbench'], ['panel', 'source', { open: { path: 'src/game.js', line: 12 } }]]);
  assert.equal(done.panel, true);
  assert.deepEqual(toasts, [], 'no note: the file is opened, not named');
  await handleStudioShow(app, { panel: 'page', view: 'workbench' }, {});
  assert.deepEqual(calls.at(-1), ['panel', 'page', {}]);
  // A file with no panel (a server from before the Source tab) still opens there; no line marks nothing.
  await handleStudioShow(app, { file: 'index.html' }, {});
  assert.deepEqual(calls.at(-1), ['panel', 'source', { open: { path: 'index.html', line: null } }]);
  assert.deepEqual(panelCommand({ panel: 'phone', point: false }), { point: false });
  assert.deepEqual(panelCommand({ panel: 'source' }), {}, 'the tab alone');
});

test('the handler on the active project and view changes nothing it need not; a view alone goes there', async () => {
  const { app, calls } = stubApp({ view: 'claude-code' });
  await handleStudioShow(app, { projectId: 'p_1', view: 'console' }, {});
  assert.deepEqual(calls, [], 'already there');
  await handleStudioShow(app, { view: 'memory' }, {});
  assert.deepEqual(calls, [['go', 'memory']]);
});

test('a project with no such panel, a project this window does not list, and a Workbench that never shows the project say so', async () => {
  const { app } = stubApp({ panels: ['game'] });
  const toasts = [];
  const toast = (t) => toasts.push(t);
  const noPanel = await handleStudioShow(app, { view: 'workbench', panel: 'audio' }, { toast });
  assert.equal(noPanel.panel, false);
  assert.deepEqual(toasts, ['Room has no Audio panel']);

  const unknown = await handleStudioShow(app, { projectId: 'p_9', view: 'tasks' }, { toast });
  assert.equal(unknown.view, null, 'nothing else is done for a project the window does not list');
  assert.match(toasts[1], /does not list \(p_9\)/);

  const stuck = stubApp();
  stuck.app.go = () => {}; // the Workbench never mounts
  const out = await handleStudioShow(stuck.app, { view: 'workbench', panel: 'phone' }, { toast, wait: (fn) => waitUntil(fn, { ms: 60, every: 10 }) });
  assert.equal(out.panel, false);
  assert.match(toasts[2], /The Phone panel could not be shown: the Workbench did not load the project/);
});

test('checkShow: a lesson implies the learning view and refuses panels, files, Point mode, other views and ids that are not lesson ids', () => {
  assert.deepEqual(checkShow({ projectId: 'p_1', lesson: 'les_abc123' }), { show: { projectId: 'p_1', view: 'learning', lesson: 'les_abc123' } });
  assert.deepEqual(checkShow({ view: 'learning', lesson: 'les_abc123' }), { show: { view: 'learning', lesson: 'les_abc123' } });
  assert.deepEqual(checkShow({ view: 'learning' }), { show: { view: 'learning' } }, 'the view alone');
  for (const [body, words] of [
    [{ lesson: '../../secret' }, /lesson must be a lesson id/],
    [{ lesson: 'les_' }, /lesson must be a lesson id/],
    [{ lesson: 7 }, /lesson must be a lesson id/],
    [{ lesson: 'les_abc123', panel: 'page' }, /has no panels, files or Point mode/],
    [{ lesson: 'les_abc123', file: 'a.js' }, /has no panels, files or Point mode/],
    [{ lesson: 'les_abc123', point: true }, /has no panels, files or Point mode/],
    [{ lesson: 'les_abc123', view: 'tasks' }, /a lesson opens in the learning view, not tasks/],
    [{ view: 'learning', panel: 'page' }, /the page panel is in the workbench view, not learning/],
  ]) assert.match(checkShow(body).error || '', words, JSON.stringify(body));
});

test('a lesson goes to app.showLesson after the project switch; a window without it says so', async () => {
  const { app, calls } = stubApp();
  app.showLesson = (id) => calls.push(['lesson', id, app.state.activeProjectId]);
  const toasts = [];
  const done = await handleStudioShow(app, { projectId: 'p_2', view: 'learning', lesson: 'les_abc123' }, { toast: (t) => toasts.push(t) });
  assert.deepEqual(calls, [['select', 'p_2'], ['lesson', 'les_abc123', 'p_2']], 'the project first, then the lesson on it');
  assert.deepEqual(done, { project: 'p_2', view: 'learning', panel: null, lesson: 'les_abc123', toast: null });
  assert.deepEqual(toasts, []);
  // The view alone routes like any other.
  await handleStudioShow(app, { view: 'learning' }, {});
  assert.deepEqual(calls.at(-1), ['go', 'learning']);
  const old = stubApp().app;
  const out = await handleStudioShow(old, { view: 'learning', lesson: 'les_abc123' }, { toast: (t) => toasts.push(t) });
  assert.equal(out.lesson, null);
  assert.match(toasts[0], /cannot show lessons yet: reload it/);
});

test('waitUntil resolves true once the test holds and false after the time', async () => {
  let n = 0;
  assert.equal(await waitUntil(() => ++n >= 3, { ms: 1000, every: 5 }), true);
  assert.equal(await waitUntil(() => false, { ms: 30, every: 5 }), false);
  assert.equal(await waitUntil(() => { throw new Error('x'); }, { ms: 20, every: 5 }), false, 'a throwing test is false');
});
