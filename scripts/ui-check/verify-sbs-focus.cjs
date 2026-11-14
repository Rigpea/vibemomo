// Does replacing one Side by side with another leave the focus in the new overlay? Opens it from a task row's
// Compare side by side twice and reads document.activeElement after each, with every focus move on the way logged.
// A private studio (temp data, own port and pid file), a project from templates/game-room-one, the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-sbs-focus.cjs  (writes .local/verify-sbs-focus/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-sbs-focus');
const PORT = 4894;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-sbs-focus-'));
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
  const created = await api('POST', '/api/projects', { name: 'Verify Room', kind: 'game', template: 'game-room-one' });
  const pid = created.project.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const folder = path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
  const cli = (...a) => {
    const r = spawnSync('node', [path.join(ROOT, 'bin', 'atelier.mjs'), ...a, '--project', pid], { env, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) check(`cli ${a.slice(0, 2).join(' ')}`, false, r.stderr);
    return r;
  };

  // A task that made two versions, so its row offers Compare side by side.
  const t = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Two options', request: 'Try two things', mode: 'explore' });
  const tid = t.id || t.task.id;
  cli('task', 'start', tid);
  fs.writeFileSync(path.join(folder, 'option.txt'), 'one\n');
  cli('checkpoint', '--label', 'Option one', '--task', tid);
  fs.writeFileSync(path.join(folder, 'option.txt'), 'two\n');
  cli('checkpoint', '--label', 'Option two', '--task', tid);
  cli('task', 'finish', tid, '--summary', 'Two options', '--verification', 'driver setup');

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = async (code) => { try { return await win.webContents.executeJavaScript(code, true); } catch (err) { throw new Error(`page script failed: ${String(code).replace(/\s+/g, ' ').slice(0, 240)} :: ${err.message}`); } };
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const describe = `((n) => n ? [n.tagName, n.id, n.getAttribute('aria-label'), n.closest('.sbs') ? 'in overlay' : n.closest('.wb-toolbar') ? 'in toolbar' : ''].filter(Boolean).join(' ') : 'none')`;
  const focusNow = () => js(`${describe}(document.activeElement)`);
  const compare = () => js(`(() => { const b = [...document.querySelectorAll('.task button')].find((n) => n.textContent.trim() === 'Compare side by side'); b.focus(); b.click(); })()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await js(`(() => { window.__focusLog = []; document.addEventListener('focusin', (e) => window.__focusLog.push(${describe}(e.target)), true); })()`);
  await js(`[...document.querySelectorAll('.collab-head button')].find((b) => b.textContent.trim() === 'Task')?.click()`); // the panel tabs are not under #main
  await sleep(800);
  await js(`[...document.querySelectorAll('.task-sum')].find((n) => n.textContent.includes('Two options')).click()`);
  await sleep(1000);

  await compare();
  await sleep(2000);
  const first = await focusNow();
  check('First open: the focus is in the overlay', /in overlay/.test(first), first);
  check('First open: one overlay', (await js(`document.querySelectorAll('.sbs').length`)) === 1);
  await shot('1-first-open');

  await js(`window.__focusLog.length = 0`);
  await compare();
  const atOnce = [];
  for (let i = 0; i < 8; i++) { atOnce.push(await focusNow()); await sleep(100); }
  await sleep(1500);
  const second = await focusNow();
  const log = await js(`window.__focusLog`);
  check('Second open: the focus is in the new overlay', /in overlay/.test(second), { second, log, atOnce });
  check('Second open: one overlay', (await js(`document.querySelectorAll('.sbs').length`)) === 1);
  await shot('2-second-open');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
