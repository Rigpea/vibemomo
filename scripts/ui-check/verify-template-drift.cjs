// By-eye check of Focus › Identity: the template line up to date, a differing file named with the note and
// the button, and the click creating a task handed over with the template folder as an added directory.
// A private studio (temp data, own port and pid file), a project from templates/audio-sound-sketch, the real client.
// The click starts a real Chat session only if a claude binary is found; the driver reads the session record, not its answer.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-template-drift.cjs  (writes .local/verify-template-drift/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-template-drift');
const PORT = 4898;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-drift-'));
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
  const created = await api('POST', '/api/projects', { name: 'Verify Sound', kind: 'audio', template: 'audio-sound-sketch' });
  const pid = created.project.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const blank = await api('POST', '/api/projects', { name: 'Verify Blank', kind: 'web-app' });

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = async (code) => { try { return await win.webContents.executeJavaScript(code, true); } catch (err) { throw new Error(`page script failed: ${String(code).replace(/\s+/g, " ").slice(0, 240)} :: ${err.message}`); } };
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const identity = `document.querySelector('section.focus-sec[aria-label="Identity"]')`;
  const identityText = () => js(`${identity}?.innerText || ''`);
  const openFocus = async () => {
    await js(`[...document.querySelectorAll('.collab-head button, #main [role=tab], #main button')].find((b) => b.textContent.trim() === 'Focus')?.click()`);
    await sleep(800);
  };

  await api('POST', `/api/projects/${blank.project.id}/activate`);
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await openFocus();
  check('A blank project says not recorded', /Template: not recorded/.test(await identityText()), await identityText());

  await api('POST', `/api/projects/${pid}/activate`);
  await win.loadURL(`${BASE}/#/workbench`);
  await win.webContents.reload();
  await sleep(2500);
  await openFocus();
  let text = await identityText();
  check('Up to date says what is compared', /Template: audio-sound-sketch · src and manifest up to date · tuning values are yours/.test(text), text);
  check('No button when up to date', !text.includes('Catch up with the template'));
  await shot('1-up-to-date');

  await api('PUT', `/api/projects/${pid}/files`, { path: 'src/style.css', content: 'body { color: red }\n' });
  await sleep(2500);
  text = await identityText();
  check('A changed file is named without a reload', /1 src file differs:\s*src\/style\.css/.test(text), text); // the path is a button: innerText breaks the line before it
  const pathButton = `[...${identity}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'src/style.css')`;
  await js(`${pathButton}.focus(); ${pathButton}.click()`);
  await sleep(800);
  const diffText = await js(`document.querySelector('dialog[open] pre')?.textContent || ''`);
  check('The path opens its diff in a pre', /^--- template\/src\/style\.css\n\+\+\+ project\/src\/style\.css\n@@ /.test(diffText) && /^\+body \{ color: red \}$/m.test(diffText), diffText.slice(0, 200));
  await shot('2-diff-dialog');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(400);
  check('Esc closes the diff', await js(`!document.querySelector('dialog[open]')`));
  check('The focus is back on the path', await js(`document.activeElement === ${pathButton}`), await js(`document.activeElement?.outerHTML?.slice(0, 120) || ''`));
  check('The tuning file has no button', await js(`![...${identity}.querySelectorAll('button')].some((b) => /tuning/.test(b.textContent))`));
  check('The note is shown', text.includes('a file that differs may be your own change; read the diff before catching up'), text);
  check('The button is shown', text.includes('Catch up with the template'), text);
  await js(`${identity}.scrollIntoView()`);
  await shot('2-differs');
  check('Nothing ran before the click', (await api('GET', `/api/projects/${pid}/tasks`)).length === 0);

  await js(`[...${identity}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Catch up with the template').click()`);
  await sleep(3000);
  const list = await api('GET', `/api/projects/${pid}/tasks`);
  check('The click created one task', list.length === 1, list.map((t) => t.title));
  const { task, events } = await api('GET', `/api/projects/${pid}/tasks/${list[0].id}`);
  check('The task lists the differing path', JSON.stringify(task.context?.files || []).includes('src/style.css'), task.context?.files);
  const handed = events.find((e) => e.type === 'handed_to_console');
  check('It was handed over', !!handed, events.map((e) => e.type));
  const session = handed ? await api('GET', `/api/console/sessions/${handed.data.sessionId}`) : null;
  check('The session can read the template folder', (session?.addDirs || []).some((d) => d.endsWith(path.join('templates', 'audio-sound-sketch'))), session?.addDirs);
  text = await identityText();
  check('The button gives way to the open task', !text.includes('Catch up with the template') && text.includes('A catch-up task is open'), text);
  await shot('3-after-click');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
