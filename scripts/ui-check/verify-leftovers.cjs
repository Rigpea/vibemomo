// Throwaway check for t_ap41yl3cod: a private server (temp data, own port and pid file), the real client
// in an offscreen Electron window at laptop width. Never touches the studio on 4747 or ~/.atelier.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'ui-check', 'verify-leftovers'); // ignored by git: a run leaves nothing to checkpoint
const PORT = 4893;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const cli = (...args) => {
  const r = spawnSync('node', [path.join(ROOT, 'bin', 'atelier.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

let server = null;
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  server?.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 150000);

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Room', kind: 'game', template: 'game-room-one' });
  const pid = created.project?.id || created.id;
  await api('POST', `/api/projects/${pid}/activate`).catch(() => {});

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const open = async (hash) => { await js(`location.hash = ${JSON.stringify(hash)}`); await sleep(700); };
  await win.loadURL(`${BASE}/#/tasks`);
  await sleep(1200);

  // ---------- 1. no version: its own words. A task with a version keeps Ready to try. ----------
  const empty = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Nothing to change here', request: 'Look and report', mode: 'handle' });
  cli('task', 'finish', empty.id || empty.task.id, '--project', pid, '--summary', 'Nothing needed changing');
  await sleep(900);
  await open('#/tasks');
  const groupsOf = `[...document.querySelectorAll('#main .group')].map((g) => ({ head: g.querySelector('h2')?.textContent, rows: [...g.querySelectorAll('.task-title')].map((t) => t.textContent) }))`;
  let groups = await js(groupsOf);
  const topChip = `document.querySelector('#global-status .chip')?.textContent`;
  check('only a no-version task: group heading is Record the result', groups.some((g) => g.head === 'Record the result' && g.rows.includes('Nothing to change here')), groups);
  check('no Ready to try group for it', !groups.some((g) => g.head === 'Ready to try'), groups);
  check('top-bar chip reads Record the result, with its project', (await js(topChip)) === 'Verify Room: record the result', await js(topChip));
  check('top-bar chip title', true, await js(`document.querySelector('#global-status button')?.title`));

  await js(`[...document.querySelectorAll('#main .task-sum')].find((b) => b.textContent.includes('Nothing to change here')).click()`);
  await sleep(700);
  const rowOf = (title) => `(() => { const t = [...document.querySelectorAll('#main .task')].find((a) => a.textContent.includes(${JSON.stringify(title)})); return { buttons: [...t.querySelectorAll('.task-actions button')].map((b) => b.textContent.trim()), hint: t.querySelector('.task-hint')?.textContent || null }; })()`;
  const noVersionRow = await js(rowOf('Nothing to change here'));
  check('row offers only Record the result, Copy command, Cancel task', JSON.stringify(noVersionRow.buttons) === JSON.stringify(['Record the result', 'Copy command', 'Cancel task']), noVersionRow.buttons);
  check('hint says no version, nothing to try', /no version/i.test(noVersionRow.hint || '') && /nothing to try/i.test(noVersionRow.hint || ''), noVersionRow.hint);
  await shot('1-tasks-no-version');

  await open('#/workbench');
  await sleep(600);
  const panelChips = await js(`[...document.querySelectorAll('.collab .task-sum .chip, .task-sum .chip')].map((c) => c.textContent)`);
  check('Workbench panel row chip reads Record the result', panelChips.includes('Record the result') && !panelChips.includes('Ready to try'), panelChips);
  await shot('2-workbench-panel');

  const dirty = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Change a file', request: 'Edit', mode: 'handle' });
  const dirtyId = dirty.id || dirty.task.id;
  const folder = path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
  fs.writeFileSync(path.join(folder, 'verify-note.txt'), 'changed\n');
  cli('task', 'finish', dirtyId, '--project', pid, '--summary', 'Changed a file');
  await sleep(900);
  await open('#/tasks');
  groups = await js(groupsOf);
  check('a task with a version stays under Ready to try', groups.some((g) => g.head === 'Ready to try' && g.rows.includes('Change a file')), groups);
  check('the no-version task stays apart', groups.some((g) => g.head === 'Record the result' && g.rows.includes('Nothing to change here')), groups);
  check('top-bar chip prefers Ready to try when there is something to try', (await js(topChip)) === 'Verify Room: ready to try', await js(topChip));
  await js(`[...document.querySelectorAll('#main .task-sum')].find((b) => b.textContent.includes('Change a file')).click()`);
  await sleep(700);
  const withVersion = await js(rowOf('Change a file'));
  check('a task with a version still has Try it and no hint', withVersion.buttons.includes('Try it') && !withVersion.hint, withVersion);

  // ---------- 2. pause reasons ----------
  const budgetFile = path.join(dataDir, 'budget.json');
  const setPause = (paused, pausedReason) => {
    const b = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    fs.writeFileSync(budgetFile, JSON.stringify({ ...b, paused, pausedReason, pausedAt: paused ? new Date().toISOString() : null }, null, 2));
  };
  await api('GET', '/api/budget');
  const readBudget = `({ chip: document.querySelector('.page-head .chip')?.textContent || null, buttons: [...document.querySelectorAll('.page-head button')].map((b) => b.textContent.trim()), run: [...document.querySelectorAll('#main .section-head')].find((h) => h.textContent.includes('Run a utility'))?.querySelector('.chip, .meta')?.textContent, notes: [...document.querySelectorAll('#main p.note.warn')].map((n) => n.textContent) })`;
  const budgetWith = async (paused, reason) => {
    setPause(paused, reason);
    await open('#/workbench');
    await open('#/budget');
    await sleep(500);
    return js(readBudget);
  };
  let b = await budgetWith(true, 'user');
  check('person: Paused by you, Resume offered', b.chip === 'Paused by you' && b.buttons.includes('Resume') && b.run === 'Paused by you', b);
  await shot('3-budget-user');
  b = await budgetWith(true, 'ceiling_reached');
  check('ceiling: own label, no Resume', b.chip === 'Paused: live ceiling reached' && !b.buttons.includes('Resume') && b.run === b.chip && b.notes.some((n) => /raise the live ceiling/i.test(n)), b);
  await shot('4-budget-ceiling');

  // The way out exists: saving the cycle form with room under the ceiling lifts it, chips included.
  await js(`[...document.querySelectorAll('#main form.form-row button[type=submit]')].find((x) => x.textContent.includes('Save cycle')).click()`);
  await sleep(900);
  b = await js(readBudget);
  check('saving with room lifts the studio pause; Pause is back, Run chip follows', !b.chip && b.buttons.includes('Pause') && /^ready/.test(b.run || ''), b);

  b = await budgetWith(true, 'observed_balance_exhausted');
  check('balance: own label, no Resume', b.chip === 'Paused: observed balance below the reserve' && !b.buttons.includes('Resume') && b.run === b.chip && b.notes.some((n) => /newer observed balance/i.test(n)), b);
  await shot('5-budget-balance');
  b = await budgetWith(false, null);
  check('not paused: Pause offered, no chip', !b.chip && b.buttons.includes('Pause'), b);

  // ---------- 3. the drawer's X, then v and Esc on the shared path ----------
  await open('#/workbench');
  await sleep(600);
  const focusNow = `({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim(), inBar: !!document.activeElement?.closest('.versions-bar'), drawerHidden: document.querySelector('#main .drawer').hidden })`;
  const key = (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  await js(`document.activeElement?.blur()`);
  await js(`window.atelier.toggleVersions(true)`);
  await sleep(500);
  const opened = await js(focusNow);
  check('opening moves focus into the drawer', !opened.drawerHidden && !opened.inBar && opened.tag === 'BUTTON', opened);
  await shot('6-drawer-open');
  await js(`document.querySelector('#main .drawer-head button').focus(); document.querySelector('#main .drawer-head button').click()`);
  await sleep(500);
  const afterX = await js(focusNow);
  check('X closes the drawer and focus is on the Versions button', afterX.drawerHidden && afterX.inBar && /^Versions/.test(afterX.text), afterX);
  await shot('7-drawer-closed');
  await js(`window.atelier.toggleVersions(true)`);
  await sleep(500);
  win.webContents.focus();
  key('Escape');
  await sleep(500);
  const afterEsc = await js(focusNow);
  check('Esc closes it the same way', afterEsc.drawerHidden && afterEsc.inBar, afterEsc);
  key('v');
  await sleep(500);
  const afterV = await js(focusNow);
  check('v opens it again', !afterV.drawerHidden && !afterV.inBar, afterV);
  key('v');
  await sleep(500);
  const afterV2 = await js(focusNow);
  check('v closes it with focus on the Versions button', afterV2.drawerHidden && afterV2.inBar, afterV2);

  // A real click on the Versions button takes the path v takes: focus lands on the drawer's close button.
  const bar = await js(`(() => { const r = document.querySelector('#main .versions-bar button').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...bar, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...bar, button: 'left', clickCount: 1 });
  await sleep(500);
  const afterClick = { ...(await js(focusNow)), onClose: await js(`document.activeElement === document.querySelector('#main .drawer-head button')`) };
  check('clicking the Versions button puts focus on the drawer close button', !afterClick.drawerHidden && afterClick.onClose, afterClick);

  // The version pill and the preferred-elsewhere star take the same path, by a real mouse click from a closed drawer.
  const clickToolbar = async (selector) => {
    await js(`window.atelier.toggleVersions(false)`);
    await sleep(500);
    const box = await js(`(() => { const e = document.querySelector('${selector}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!box) return { missing: selector };
    win.webContents.sendInputEvent({ type: 'mouseDown', ...box, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...box, button: 'left', clickCount: 1 });
    await sleep(500);
    return { ...(await js(focusNow)), onClose: await js(`document.activeElement === document.querySelector('#main .drawer-head button')`) };
  };
  const afterPill = await clickToolbar('button.version-pill');
  check('clicking the version pill puts focus on the drawer close button', !afterPill.drawerHidden && afterPill.onClose, afterPill);

  const listed = await api('GET', `/api/projects/${pid}/versions`);
  const oldest = (listed.versions || listed).slice().sort((x, y) => x.n - y.n)[0];
  await api('PATCH', `/api/projects/${pid}/versions/${oldest.id}`, { userPreferred: true });
  await sleep(900); // the live refresh draws the star
  const afterStar = await clickToolbar('button.pref-elsewhere');
  check('clicking the preferred-elsewhere star puts focus on the drawer close button', !afterStar.drawerHidden && afterStar.onClose, afterStar);
  await shot('8-drawer-from-star');

  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'script error', ok: false, seen: String(err?.stack || err) }); finish(3); });
