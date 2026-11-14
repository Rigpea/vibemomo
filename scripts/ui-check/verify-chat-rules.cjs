// NOT YET RUN: the session that wrote it was refused electron.exe. Run with
// node_modules/electron/dist/electron.exe scripts/ui-check/verify-chat-rules.cjs
// Check for t_16zpc0f8m3: private server (temp data, own port, fake claude), the real client in an
// offscreen Electron window at laptop width. Never touches the studio on 4747 or ~/.atelier.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'ui-check', 'verify-chat-rules');
const PORT = 4894;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-'));
fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: path.join(tmp, 'projects'), ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => results.push({ name, ok: !!ok, seen });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

let server = null;
let done = false;
async function finish(code) {
  if (done) return;
  done = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  server?.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 90000);

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Room', kind: 'game', template: 'game-room-one' });
  const pid = created.data.project?.id || created.data.id;
  await api('POST', `/api/projects/${pid}/activate`);

  const task = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Header check', request: 'Look and report', mode: 'handle' });
  const tid = task.data.id || task.data.task.id;

  // The real route: refused entries are 400 and leave no session or event; a good one runs.
  const drive = await api('POST', `/api/projects/${pid}/tasks/${tid}/console`, { addDirs: ['C:\\'] });
  check('route refuses C:\\ with 400 invalid_input naming it', drive.status === 400 && drive.data.error?.code === 'invalid_input' && drive.data.error.message.includes('C:\\'), drive.data.error?.message);
  const bare = await api('POST', `/api/projects/${pid}/tasks/${tid}/console`, { addDirs: ['C:'] });
  check('route refuses C: with 400', bare.status === 400, bare.data.error?.message);
  const notList = await api('POST', `/api/projects/${pid}/tasks/${tid}/console`, { addDirs: 'x' });
  check('route refuses a non-array with 400', notList.status === 400, notList.data.error?.message);
  const none = await api('GET', `/api/console/sessions?projectId=${pid}`);
  check('no session was made by a refusal', none.data.length === 0, none.data.length);
  const run = await api('POST', `/api/projects/${pid}/tasks/${tid}/console`, { addDirs: [path.join(ROOT, 'templates')] });
  check('route accepts the templates folder', run.status === 200 || run.status === 202, run.data.sessionId);
  await sleep(1500);

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  await win.loadURL(`${BASE}/#/console`);
  await sleep(1500);
  const clicked = await js(`(() => { const b = document.querySelector('button.item[data-sid="${run.data.sessionId}"]'); if (b) b.click(); return !!b; })()`);
  check('session row found', clicked);
  await sleep(1000);
  const head = await js(`(() => { const e = document.querySelector('.cc-head-line'); return e ? { text: e.textContent, title: e.title, clipped: e.scrollWidth > e.clientWidth, width: e.clientWidth } : null; })()`);
  check('header says what runs without asking', head?.text.includes('node, npm run, npm test and git read commands run without asking'), head);
  check('header title says it is not a sandbox', head?.title.includes('not a sandbox') && head.title.includes('outside the project'), head?.title);
  await shot('chat-header');

  const opened = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'New session'); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  const label = await js(`(() => { const e = [...document.querySelectorAll('label.check')].find((x) => /node/.test(x.textContent)); return e ? e.textContent : null; })()`);
  check('new-session dialog names the rules', opened && label?.includes('not a sandbox'), label);
  await shot('new-session');
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(2); });
