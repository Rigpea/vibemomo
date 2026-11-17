// Exercise the real selection function without booting the DOM/router/SSE services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../client/app.js', import.meta.url), 'utf8');
const selection = source.slice(source.indexOf('async function selectProject('), source.indexOf('// ---------- SSE'));
assert.ok(selection.startsWith('async function selectProject('));
const bindSelection = new Function('state', 'app', 'api', 'emit', 'loadBundle', 'toggleLayout', `${selection}; return selectProject;`);

function setup(bundle) {
  const state = { activeProjectId: 'p_first', bundle, bundleError: new Error('old error') };
  const calls = [];
  const select = bindSelection(state,
    { isNarrow: () => false, layout: () => ({ versionsOpen: { value: false } }) },
    { activate: async (id) => { calls.push(['activate', id]); } },
    (topic) => calls.push(['event', topic]),
    async () => { calls.push(['load', state.activeProjectId]); state.bundle = { project: { id: state.activeProjectId } }; },
    () => {},
  );
  return { state, calls, select };
}

test('the first project selected by loadStudio still loads its Workbench bundle', async () => {
  const s = setup(null);
  await s.select('p_first');
  assert.equal(s.state.bundle.project.id, 'p_first');
  assert.equal(s.state.bundleError, null);
  assert.deepEqual(s.calls.filter(([action]) => action === 'load'), [['load', 'p_first']]);
});

test('selecting an already loaded project keeps its bundle and does not reload', async () => {
  const bundle = { project: { id: 'p_first' } };
  const s = setup(bundle);
  await s.select('p_first');
  assert.equal(s.state.bundle, bundle);
  assert.deepEqual(s.calls, []);
});

test('switching to another project activates it and replaces the previous bundle', async () => {
  const s = setup({ project: { id: 'p_first' } });
  await s.select('p_second');
  assert.equal(s.state.bundle.project.id, 'p_second');
  assert.ok(s.calls.some(([action, id]) => action === 'activate' && id === 'p_second'));
});
