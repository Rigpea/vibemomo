// The Workbench's room for the preview (task t_e8x0zb4sbd, decision row 149): no Live note line under the preview, and
// the Working now strip hidden by default, shown by the More menu's toggle and remembered as the studio's layout pref.
// Pure words and the layout module on their own; scripts/ui-check/verify-live.cjs and verify-working-now.cjs look at
// the real Workbench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const sw = await import('../client/components/stage-words.js');
const lw = await import('../client/components/live-words.js');
const layout = await import('../client/components/layout.js');
const wbSource = await fsp.readFile(new URL('../client/views/workbench.js', import.meta.url), 'utf8');

test('the Live note line is gone: while the frame shows the live server there is no line under the preview', () => {
  const f = sw.stageFoot({ liveShown: true, live: { state: 'running', reason: '127.0.0.1:5173' }, current: { n: 3 } });
  assert.deepEqual(f, { hidden: true, left: '', right: '' });
  assert.ok(!/LIVE_NOTE/.test(wbSource), 'the Workbench no longer draws the note anywhere');
  // Select carries the fact in one short sentence while it is disabled.
  assert.match(wbSource, /liveShown\(\) \? LIVE_SELECT_TITLE :/);
  assert.equal(lw.LIVE_SELECT_TITLE.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length, 1, 'one sentence');
  assert.match(lw.LIVE_SELECT_TITLE, /files on disk/);
});

test('the line under the preview keeps its other words: a failed or invalid Live says why, the files on disk otherwise', () => {
  const failed = sw.stageFoot({ liveShown: false, live: { state: 'failed', reason: 'it stopped' }, current: { n: 3 }, selection: 'h1' });
  assert.equal(failed.hidden, false);
  assert.equal(failed.left, 'Live failed: it stopped. The preview shows the files on disk.');
  assert.equal(failed.right, 'h1 selected');
  assert.equal(sw.stageFoot({ live: { state: 'invalid', reason: 'no command' } }).left, 'Live is not valid: no command. The preview shows the files on disk.');
  const plain = sw.stageFoot({ live: { state: 'off' }, current: { n: 3 }, changed: 0 });
  assert.deepEqual(plain, { hidden: false, ...sw.footWords({ current: { n: 3 }, changed: 0 }) });
  assert.equal(sw.stageFoot().hidden, false);
});

test('Working now is hidden by default for every project, and the toggle writes the studio default', () => {
  store.clear();
  const eff = layout.resolveLayout({ ui: {} }, { id: 'p', ui: {} });
  assert.deepEqual(eff.runsShown, { value: false, scope: 'built-in' });
  assert.deepEqual(sw.runsToggle(eff.runsShown), { shown: false, scope: 'studio', next: true });
  assert.equal(sw.RUNS_TOGGLE, 'Show runs under the preview');
  // The Workbench hides the strip from the same answer and puts the toggle in the More menu.
  assert.match(wbSource, /ui\.workingNow\.node\.hidden = !runsToggle\(l\.runsShown\)\.shown;/);
  assert.match(wbSource, /role: 'menuitemcheckbox', 'aria-checked': String\(shown\)/);
  assert.match(wbSource, /setLayoutPref\(t\.scope, 'runsShown', t\.next\)/);
  assert.equal(layout.LAYOUT_KEYS.runsShown.type, 'bool', 'Settings · Layout lists it as Yes / No');
});

test('the choice is remembered in the studio\'s settings; a session or project value that wins is the one the toggle changes', async () => {
  store.clear();
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ui: JSON.parse(init.body).ui }) };
  };
  const settings = { ui: { layout: { leftWidth: 260 } } };
  const project = { id: 'p', ui: {} };
  await layout.setLayout('studio', 'runsShown', true, { settings, project });
  assert.deepEqual(sent.map((s) => [s.method, s.url]), [['PATCH', '/api/settings']]);
  assert.deepEqual(sent[0].body.ui.layout, { leftWidth: 260, runsShown: true }, 'stored beside the other layout prefs, which stay');
  const shown = layout.resolveLayout(settings, project).runsShown;
  assert.deepEqual(shown, { value: true, scope: 'studio' }, 'a reload reads it back from the settings');
  assert.deepEqual(sw.runsToggle(shown), { shown: true, scope: 'studio', next: false }, 'the next press hides it again');
  // Every project reads the studio's value unless the person set one for that project or session in Settings.
  assert.equal(layout.resolveLayout(settings, { id: 'q', ui: {} }).runsShown.value, true);
  assert.deepEqual(sw.runsToggle({ value: false, scope: 'session' }), { shown: false, scope: 'session', next: true });
  assert.deepEqual(sw.runsToggle({ value: true, scope: 'project' }), { shown: true, scope: 'project', next: false });
  delete globalThis.fetch;
});
