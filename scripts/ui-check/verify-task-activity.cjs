// By-eye check of a task row's Activity in the Workbench's Task tab: a task with a Chat session record (made through
// POST /api/console/sessions with its taskId: a record with no turns, nothing is sent and no claude runs) shows
// "Activity · no tool calls yet", and opened, who runs it, the task's title and "Idle · not started"; a second task
// without a session shows no Activity line. Live rows need a real session: that is the architect's run, not this one.
// A private studio (temp data, own port and pid file), a project from templates/game-room-one, the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-task-activity.cjs  (writes .local/verify-task-activity/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-task-activity');
const PORT = 4906;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-activity-'));
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 120000);

app.disableHardwareAcceleration();

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Activity', kind: 'game', template: 'game-room-one' });
  const pid = created.project?.id || created.id;
  await api('POST', `/api/projects/${pid}/activate`);

  const a = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Tighten the title spacing', request: 'The h1 sits too close to the subtitle; give it room.\nSee the case screen.', mode: 'handle' });
  const tidA = a.id || a.task?.id;
  const b = await api('POST', `/api/projects/${pid}/tasks`, { title: 'A task nobody runs', request: 'Nothing runs this', mode: 'handle' });
  const tidB = b.id || b.task?.id;
  const ses = await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId: pid, taskId: tidA });
  const sid = ses.session?.id || ses.id;
  check('a session record for the first task', !!sid && (ses.session?.taskId || ses.taskId) === tidA, ses);

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const row = (tid) => `document.querySelector('#collab .task[data-tid="${tid}"]')`;

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000); // the bundle, then the sessions list and the redraw it brings
  const summaryA = await js(`${row(tidA)}?.querySelector('details.task-activity > summary')?.textContent || null`);
  check('first task: the Activity line, closed, before anything is read', summaryA === 'Activity' || summaryA === 'Activity · no tool calls yet', summaryA);
  check('first task: closed by default', (await js(`${row(tidA)}?.querySelector('details.task-activity')?.open`)) === false);
  check('second task: no Activity line', (await js(`!!${row(tidB)} && !${row(tidB)}.textContent.includes('Activity')`)) === true);
  await js(`${row(tidA)}.querySelector('details.task-activity > summary').click()`);
  await sleep(1200);
  const seen = await js(`(() => { const d = ${row(tidA)}.querySelector('details.task-activity'); const s = d.querySelector('.activity-state'); return { open: d.open, summary: d.querySelector('summary').textContent, who: d.querySelector('.activity-who')?.textContent, intent: d.querySelector('.activity-intent')?.textContent, state: s?.textContent.replace(/\\s+/g, ' ').trim(), reasonFont: s ? getComputedStyle(s.querySelector('.cmp-reason')).fontSize : null }; })()`);
  check('opened: no tool calls yet', seen.open && seen.summary === 'Activity · no tool calls yet', seen.summary);
  check('opened: who runs it', /^Claude Code · .+ · your login$/.test(seen.who || ''), seen.who);
  check('opened: the intent is the request\'s first sentence, which says more than the title', seen.intent === 'The h1 sits too close to the subtitle; give it room.', seen.intent);
  check('opened: Idle · not started', seen.state === 'Idle · not started', seen.state);
  await shot('1-activity-open');
  // A redraw (a bundle refresh) keeps it open.
  await js(`window.dispatchEvent(new HashChangeEvent('hashchange'))`);
  await sleep(1500);
  check('a redraw keeps it open', (await js(`${row(tidA)}.querySelector('details.task-activity').open`)) === true);
  // The Tasks view shares the rows.
  await js(`location.hash = '#/tasks'`);
  await sleep(1500);
  const inTasks = await js(`[...document.querySelectorAll('#main .task')].map((r) => ({ title: r.querySelector('.task-title')?.textContent, activity: r.querySelector('details.task-activity > summary')?.textContent || null }))`);
  check('Tasks view: the first task has Activity, the second none', inTasks.some((r) => r.title?.includes('Tighten') && r.activity) && inTasks.some((r) => r.title?.includes('nobody') && !r.activity), inTasks);
  await shot('2-tasks-view');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
