// By-eye check of Focus › Identity for a project with no template record: "not recorded", Set offering the
// templates of its kind, Cancel, and Save bringing the drift line and the Catch up button. Nothing is clicked
// on that button, so no Chat session starts. A private studio (temp data, own port and pid file), the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-template-set.cjs  (writes .local/verify-template-set/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-template-set');
const PORT = 4899;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-set-'));
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
  const created = await api('POST', '/api/projects', { name: 'Verify Late', kind: 'audio' });
  const pid = created.project.id;
  await api('POST', `/api/projects/${pid}/activate`);

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = async (code) => { try { return await win.webContents.executeJavaScript(code, true); } catch (err) { throw new Error(`page script failed: ${String(code).replace(/\s+/g, " ").slice(0, 240)} :: ${err.message}`); } };
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const identity = `document.querySelector('section.focus-sec[aria-label="Identity"]')`;
  const identityText = () => js(`${identity}?.innerText || ''`);
  const press = (label) => js(`[...${identity}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`);
  const focused = () => js(`document.activeElement?.dataset?.edit || document.activeElement?.tagName`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await js(`[...document.querySelectorAll('.collab-head button, #main [role=tab], #main button')].find((b) => b.textContent.trim() === 'Focus')?.click()`);
  await sleep(800);
  await js(`${identity}.scrollIntoView()`);

  const text = await identityText();
  check('Says not recorded', /Template: not recorded/.test(text), text);
  check('Offers Set', text.includes('Set'), text);
  await shot('1-not-recorded');

  await press('Set');
  await sleep(300);
  const options = await js(`[...${identity}.querySelectorAll('select option')].map((o) => o.value)`);
  check('Set offers the templates of the kind only', JSON.stringify(options) === '["audio-sound-sketch"]', options);
  check('The select has the focus', (await focused()) === 'template-choice', await focused());
  await shot('2-set-open');

  await api('PATCH', `/api/projects/${pid}`, { purpose: 'A refresh while Set is open' });
  await sleep(1500);
  check('A refresh keeps Set open', (await js(`!!${identity}.querySelector('select')`)), await identityText());

  await press('Cancel');
  await sleep(300);
  check('Cancel closes it and nothing is saved', !(await js(`!!${identity}.querySelector('select')`)) && !(await api('GET', `/api/projects/${pid}`)).project.template);
  check('Cancel gives the focus back to Set', (await focused()) === 'template-set', await focused());

  await press('Set');
  await sleep(300);
  await press('Save');
  await sleep(2500);
  const after = await identityText();
  check('The record is stored', (await api('GET', `/api/projects/${pid}`)).project.template?.name === 'audio-sound-sketch');
  check('The drift line replaces it', /Template: audio-sound-sketch · /.test(after) && !after.includes('not recorded'), after);
  check('The Catch up button is offered', after.includes('Catch up with the template'), after);
  check('The focus lands on Edit identity', (await focused()) === 'identity', await focused());
  await shot('3-after-save');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
