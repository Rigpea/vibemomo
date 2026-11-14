// Check for t_err5g9l4v5: private server (temp data, own port), real client in an offscreen window.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-moved-head');
const PORT = 4898;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => results.push({ name, ok: !!ok, seen });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Room', kind: 'game', template: 'game-room-one' });
  const pid = created.project?.id || created.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const folder = path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...a], { cwd: folder, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (text) => {
    fs.appendFileSync(path.join(folder, 'verify-note.txt'), `${text}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', text);
    return git('rev-parse', 'HEAD');
  };
  const older = commit('older');
  commit('middle');
  const base = commit('newest');

  const t = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Go back by hand', request: 'Reset to an older commit', mode: 'handle' });
  const tid = t.id || t.task.id;
  git('reset', '-q', '--hard', older);
  const r = spawnSync('node', [path.join(ROOT, 'bin', 'atelier.mjs'), 'task', 'finish', tid, '--project', pid, '--summary', 'Went back'], { env, encoding: 'utf8', windowsHide: true });
  const want = `The files on disk differ from the task's base: HEAD moved from ${base.slice(0, 8)} to ${older.slice(0, 8)} (2 commits apart); nothing was kept as a version.`;
  check('CLI exit 0', r.status === 0, r.stderr);
  check('CLI prints the note', r.stdout.includes(want), r.stdout);
  check('CLI version null', /"version": null/.test(r.stdout), r.stdout.slice(0, 300));

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  await win.loadURL(`${BASE}/#/tasks`);
  await sleep(1500);
  await js(`[...document.querySelectorAll('#main .task-sum')].find((b) => b.textContent.includes('Go back by hand')).click()`);
  await sleep(800);
  const row = `(() => { const t = [...document.querySelectorAll('#main .task')].find((a) => a.textContent.includes('Go back by hand')); const n = t.querySelector('.task-detail p.note'); return { note: n?.textContent, overflow: n ? n.scrollWidth > n.clientWidth : null, hint: t.querySelector('.task-hint')?.textContent, buttons: [...t.querySelectorAll('.task-actions button')].map((b) => b.textContent.trim()) }; })()`;
  let seen = await js(row);
  check('1366: the row shows the note', seen.note === want, seen);
  check('1366: the hint no longer says nothing changed', /no version/.test(seen.hint || '') && !/nothing changed/i.test(seen.hint || ''), seen.hint);
  check('1366: no overflow', seen.overflow === false, seen.overflow);
  await shot('1-tasks-1366');
  win.setContentSize(800, 700);
  await sleep(600);
  seen = await js(row);
  check('800: the row shows the note, no overflow', seen.note === want && seen.overflow === false, seen);
  await shot('2-tasks-800');
  win.setContentSize(1366, 768);
  await sleep(400);

  await js(`[...document.querySelectorAll('#main .task')].find((a) => a.textContent.includes('Go back by hand')).querySelector('.task-actions button').click()`);
  await sleep(1000);
  const dialogText = await js(`[...document.querySelectorAll('dialog[open]')].map((d) => d.textContent).join(' | ')`);
  check('Record dialog reads as sentences', dialogText.includes(`${want} The task is done.`), dialogText);
  await shot('3-recorded');
  await js(`document.querySelector('dialog[open]')?.close()`);

  // Budget: the studio's pause has no Resume and ignores paused:false; the person's has Resume and it works.
  const budgetFile = path.join(dataDir, 'budget.json');
  const setPause = (pausedReason) => {
    const b = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    fs.writeFileSync(budgetFile, JSON.stringify({ ...b, paused: true, pausedReason, pausedAt: new Date().toISOString() }, null, 2));
  };
  await api('GET', '/api/budget');
  await api('PATCH', '/api/budget', { liveCeilingUsd: 0 });
  setPause('ceiling_reached');
  const after = await api('PATCH', '/api/budget', { paused: false });
  check('studio pause: PATCH paused:false ignored', after.paused === true && after.pausedReason === 'ceiling_reached', { paused: after.paused, reason: after.pausedReason });
  await js(`location.hash = '#/budget'`);
  await sleep(1000);
  const buttons = `[...document.querySelectorAll('#main button')].map((b) => b.textContent.trim())`;
  check('studio pause: no Resume on the page', !(await js(buttons)).includes('Resume'), await js(buttons));
  await shot('4-budget-studio-pause');
  const lifted = await api('PATCH', '/api/budget', { liveCeilingUsd: 10 });
  check('studio pause: raising the ceiling lifts it', lifted.paused === false, lifted.paused);
  setPause('user');
  await js(`location.hash = '#/tasks'`);
  await sleep(500);
  await js(`location.hash = '#/budget'`);
  await sleep(1000);
  check('person\'s pause: Resume on the page', (await js(buttons)).includes('Resume'), await js(buttons));
  await js(`[...document.querySelectorAll('#main button')].find((b) => b.textContent.trim() === 'Resume').click()`);
  await sleep(800);
  check('person\'s pause: Resume lifts it', (await api('GET', '/api/budget')).paused === false, null);
  await finish(results.every((c) => c.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((e) => { results.push({ name: 'driver error', ok: false, seen: String(e?.stack || e) }); finish(2); });
