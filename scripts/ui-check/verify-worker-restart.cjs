// Check for t_pcqooq40rf: workers report to the manager that started them, across projects and studio restarts.
// A private server (temp data, own port, fake claude), two projects: a manager session in "Verify Harbor" starts and
// queues tasks in "Verify Studio". The restart confirmation is read in an offscreen window (Ctrl+Alt+R, then Cancel);
// then the server is killed mid-turn, as a restart does, and started again on the same data: the cut-off task's
// report must reach the Harbor manager, not the studio project's Companion. Never touches the studio on 4747.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-worker-restart.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'ui-check', 'verify-worker-restart');
const PORT = 4897;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-'));
fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: path.join(tmp, 'projects'), ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const progress = (line) => fs.appendFileSync(path.join(OUT, 'progress.log'), `${new Date().toISOString()} ${line}
`);
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); progress(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
let server = null;
const startServer = async () => {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.log = '';
  server.stdout.on('data', (d) => { server.log += d; });
  server.stderr.on('data', (d) => { server.log += d; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up */ }
    if (i > 75) throw new Error('server did not start');
    await sleep(200);
  }
};
// As hard as a restart's stop: the server process ends at once and no turn end runs. Only the server: its fake claude
// child sleeps out its 20 s and exits.
const killServer = () => { try { server?.kill('SIGKILL'); } catch { /* gone */ } };
const turnsOf = async (sid) => (await api('GET', `/api/console/sessions/${sid}`)).data?.turns || [];
const events = async (pid, tid) => (await api('GET', `/api/projects/${pid}/tasks/${tid}`)).data?.events || [];
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(250); } };

let done = false;
async function finish(code) {
  if (done) return;
  done = true;
  progress(`finish ${code}`);
  if (server?.log) fs.writeFileSync(path.join(OUT, 'server.log'), server.log);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  try { killServer(); } catch { /* gone */ }
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 120000);

async function main() {
  fs.rmSync(path.join(OUT, 'progress.log'), { force: true });
  fs.rmSync(path.join(OUT, 'results.json'), { force: true });
  await startServer();
  progress('server up');
  const studio = (await api('POST', '/api/projects', { name: 'Verify Studio', kind: 'game', template: 'game-room-one' })).data;
  const harbor = (await api('POST', '/api/projects', { name: 'Verify Harbor', kind: 'game', template: 'game-room-one' })).data;
  const p1 = studio.project?.id || studio.id;
  const p2 = harbor.project?.id || harbor.id;
  const manager = (await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId: p2, title: 'Harbor manager' })).data.id;
  const companion = (await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId: p1, title: 'Studio companion' })).data.id;
  await api('PATCH', `/api/projects/${p1}`, { ui: { companionSessionId: companion } });
  await api('POST', `/api/projects/${p1}/activate`);
  const ta = (await api('POST', `/api/projects/${p1}/tasks`, { title: 'Long worker task', request: 'Work a while', mode: 'handle' })).data;
  const tb = (await api('POST', `/api/projects/${p1}/tasks`, { title: 'Queued worker task', request: 'Then this', mode: 'handle' })).data;
  const a = ta.id || ta.task.id;
  const b = tb.id || tb.task.id;
  const bad = await api('POST', `/api/projects/${p1}/workers`, { taskId: a, managerSessionId: 'x y' });
  check('a malformed managerSessionId is a 400', bad.status === 400, bad.data?.error);
  // revise with SLEEP in the note: the fake claude then sleeps 20 s, so the worker is mid-task.
  const started = await api('POST', `/api/projects/${p1}/tasks/${a}/review`, { verdict: 'revise', note: 'SLEEP while working', managerSessionId: manager });
  const queued = await api('POST', `/api/projects/${p1}/workers`, { taskId: b, managerSessionId: manager });
  check('the worker started and the second task queued', started.data?.state === 'working' && queued.data?.state === 'queued', [started.data, queued.data]);
  const handed = (await events(p1, a)).find((e) => e.type === 'handed_to_console');
  check('the handover event names the Harbor manager', handed?.data?.managerSessionId === manager, handed?.data);
  const queuedEv = (await events(p1, b)).find((e) => e.type === 'queued');
  check('the queued event names the Harbor manager', queuedEv?.data?.managerSessionId === manager, queuedEv?.data);
  const overview = (await api('GET', '/api/workers')).data;
  check('GET /api/workers: one mid-task, one queued', overview?.active?.length === 1 && overview.queued === 1 && overview.active[0].name === 'Long worker task', overview);
  const kept = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'workers.json'), 'utf8'));
  check('workers.json keeps the queue with its manager', kept.projects?.[p1]?.queue?.[0]?.tid === b && kept.projects[p1].queue[0].managerSessionId === manager, kept.projects);

  // The restart confirmation, in the real client.
  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, altKey: true, bubbles: true }))`);
  const dialogText = await waitFor(() => js(`document.querySelector('dialog[open]')?.textContent || ''`), 5000);
  win.webContents.invalidate();
  await sleep(700);
  fs.writeFileSync(path.join(OUT, 'restart-dialog.jpg'), (await win.webContents.capturePage()).toJPEG(85));
  check('the confirmation says the worker is mid-task and its manager is told', /1 worker is mid-task and will be interrupted; its manager is told and can continue it\./.test(dialogText), dialogText);
  check('the confirmation says the queued task starts again', /1 queued task starts again after the restart\./.test(dialogText), dialogText);
  await js(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Cancel')?.click()`);
  win.destroy();

  // The restart: the server dies mid-turn, then starts on the same data.
  progress('killing the server mid-turn');
  killServer();
  await sleep(800);
  await startServer();
  progress('server started again');
  const told = await waitFor(async () => (await turnsOf(manager)).find((t) => t.role === 'user' && /interrupted by a studio restart/.test(t.text)));
  check('the Harbor manager is told the task was interrupted by the restart', !!told, told?.text?.slice(0, 600));
  const mark = (await events(p1, a)).find((e) => e.type === 'worker_interrupted');
  check('the task records worker_interrupted with the manager', mark?.data?.managerSessionId === manager, mark?.data);
  const bHanded = await waitFor(async () => (await events(p1, b)).find((e) => e.type === 'handed_to_console'), 8000);
  check(`the kept queue: ${bHanded ? 'the queued task started' : 'the queued task waits (dirty folder)'}`, bHanded ? bHanded.data?.managerSessionId === manager : /waits and does not start by itself/.test(told?.text || ''), bHanded?.data || told?.text);
  if (bHanded) {
    const report = await waitFor(async () => (await turnsOf(manager)).find((t) => t.role === 'user' && new RegExp(`Worker report for task ${b}`).test(t.text) && !/interrupted/.test(t.text)), 20000);
    check('the queued task\'s worker reports to the Harbor manager', !!report, report?.text?.slice(0, 300));
  }
  const companionTurns = await turnsOf(companion);
  check('the studio project\'s Companion heard nothing', companionTurns.length === 0, companionTurns.map((t) => t.text?.slice(0, 120)));
  check('the server log names the reconcile', /workers after the restart: 1 interrupted/.test(server.log), server.log.split('\n').filter((l) => /workers/.test(l)));
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // the window closes after the dialog; the restart half needs no window
app.whenReady().then(() => main().catch((err) => { results.push({ name: 'error', ok: false, seen: err.stack }); finish(1); }));
