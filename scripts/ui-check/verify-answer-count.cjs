// NOT YET RUN: the session that wrote it was refused electron.exe. Run with
// node_modules/electron/dist/electron.exe scripts/ui-check/verify-answer-count.cjs
// Check for t_8u81ll71u7: a private server (temp data, own port, fake claude) and the real client in an
// offscreen Electron window at laptop width. A cancelled empty turn must not count as an answer, in the
// list and once the session is open. Never touches the studio on 4747 or ~/.atelier.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'ui-check', 'verify-answer-count');
const PORT = 4895;
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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 60000);

const idle = async (id) => {
  for (let i = 0; i < 50; i++) {
    const s = await api('GET', `/api/console/sessions/${id}`);
    if (s.data.status === 'idle' && s.data.turns.length) return s.data;
    await sleep(100);
  }
  throw new Error(`session ${id} did not finish`);
};

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const answered = (await api('POST', '/api/console/sessions', { backend: 'claude-code', title: 'Answered' })).data;
  await api('POST', `/api/console/sessions/${answered.id}/send`, { text: 'hello' });
  await idle(answered.id);
  const stopped = (await api('POST', '/api/console/sessions', { backend: 'claude-code', title: 'Stopped' })).data;
  await api('POST', `/api/console/sessions/${stopped.id}/send`, { text: 'please SLEEP' });
  await sleep(300);
  await api('POST', `/api/console/sessions/${stopped.id}/cancel`);
  const rec = await idle(stopped.id);
  check('the fixture turn is cancelled and empty', rec.turns.at(-1).cancelled === true && !rec.turns.at(-1).text, rec.turns.at(-1));

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const meta = (id) => js(`document.querySelector('button.item[data-sid="${id}"] .item-meta')?.textContent ?? null`);
  await win.loadURL(`${BASE}/#/console`);
  await sleep(1500);
  await js(`(() => { for (const b of document.querySelectorAll('button')) if (b.textContent.trim() === 'All') b.click(); })()`);
  await sleep(500);
  const listStopped = await meta(stopped.id);
  const listAnswered = await meta(answered.id);
  check('the list says 0 answers for the cancelled session', /\b0 answers\b/.test(listStopped || ''), listStopped);
  check('the list says 1 answer for the answered session', /\b1 answer\b/.test(listAnswered || ''), listAnswered);
  await js(`document.querySelector('button.item[data-sid="${stopped.id}"]')?.click()`);
  await sleep(800);
  const openStopped = await meta(stopped.id);
  check('still 0 answers once it is open (the count from its turns)', /\b0 answers\b/.test(openStopped || ''), openStopped);
  fs.writeFileSync(path.join(OUT, 'console.png'), (await win.webContents.capturePage()).toPNG());
  check('no console errors (the new module loaded)', errors.length === 0, errors);
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(2); });
