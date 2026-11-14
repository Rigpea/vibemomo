// By-eye check of Focus › Identity for a record whose template is gone, and for a name that cannot be a template:
// the sentence, Set beside it, Cancel leaving the record, Save replacing it. Also a kind with no template: the
// sentence alone. A private studio (temp data, own port and pid file), the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-template-gone.cjs  (writes .local/verify-template-gone/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-template-gone');
const PORT = 4901;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-gone-'));
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

/** The record is a file a person can edit; PATCH refuses these names, so they go in the way they would arrive. */
function writeRecord(projectPath, name) {
  const file = path.join(projectPath, '.studio', 'project.json');
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  project.template = { name, at: '2026-01-01T00:00:00.000Z', projectName: project.name };
  fs.writeFileSync(file, JSON.stringify(project, null, 2));
}

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Gone', kind: 'audio' });
  const pid = created.project.id;
  const pathOf = async (id) => (await api('GET', '/api/projects')).find((p) => p.id === id).path;
  const projectPath = await pathOf(pid);
  writeRecord(projectPath, 'retired-template');
  await api('POST', `/api/projects/${pid}/activate`);

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = async (code) => { try { return await win.webContents.executeJavaScript(code, true); } catch (err) { throw new Error(`page script failed: ${String(code).replace(/\s+/g, ' ').slice(0, 240)} :: ${err.message}`); } };
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const identity = `document.querySelector('section.focus-sec[aria-label="Identity"]')`;
  const identityText = () => js(`${identity}?.innerText || ''`);
  const press = (label) => js(`[...${identity}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`);
  const hasButton = (label) => js(`[...${identity}.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)})`);
  const focused = () => js(`document.activeElement?.dataset?.edit || document.activeElement?.tagName`);
  const openFocus = async () => {
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2500);
    await js(`[...document.querySelectorAll('.collab-head button, #main [role=tab], #main button')].find((b) => b.textContent.trim() === 'Focus')?.click()`);
    await sleep(1500);
    await js(`${identity}.scrollIntoView()`);
  };

  await openFocus();
  const text = await identityText();
  check('Says the template is gone', text.includes('Template: retired-template · no longer in the studio'), text);
  check('Offers Set beside it', await hasButton('Set'), text);
  check('Offers no catch-up', !text.includes('Catch up with the template'), text);
  await shot('1-gone');

  await press('Set');
  await sleep(300);
  const options = await js(`[...${identity}.querySelectorAll('select option')].map((o) => o.value)`);
  check('Set offers the templates of the kind only', JSON.stringify(options) === '["audio-sound-sketch"]', options);
  check('The select has the focus', (await focused()) === 'template-choice', await focused());
  await shot('2-set-open');

  await press('Cancel');
  await sleep(300);
  check('Cancel leaves the record', (await api('GET', `/api/projects/${pid}`)).project.template?.name === 'retired-template');
  check('Cancel brings the sentence back', (await identityText()).includes('no longer in the studio'));
  check('Cancel gives the focus back to Set', (await focused()) === 'template-set', await focused());

  await press('Set');
  await sleep(300);
  await press('Save');
  await sleep(2500);
  const after = await identityText();
  check('The record is replaced', (await api('GET', `/api/projects/${pid}`)).project.template?.name === 'audio-sound-sketch');
  check('The drift line replaces the sentence', /Template: audio-sound-sketch · /.test(after) && !after.includes('no longer in the studio'), after);
  await shot('3-after-save');

  writeRecord(projectPath, '..');
  await openFocus();
  const dots = await identityText();
  check('.. reads as not a template name, with Set', dots.includes('Template: .. · not a template name') && await hasButton('Set'), dots);
  await shot('4-not-a-name');

  // every kind has a template in the studio (web-app-notes for web-app), so a gone template still offers Set; the no-Set case cannot be shown with a real kind.
  const none = await api('POST', '/api/projects', { name: 'Verify No Kind', kind: 'web-app' });
  writeRecord(await pathOf(none.project.id), 'retired-template');
  await api('POST', `/api/projects/${none.project.id}/activate`);
  await openFocus();
  await js(`[...document.querySelectorAll('#rail button.item, .rail button.item')].find((b) => (b.querySelector('.item-title')?.textContent || '').trim() === 'Verify No Kind')?.click()`); // the client keeps its own active project
  await sleep(1200);
  await js(`[...document.querySelectorAll('.collab-head button')].find((b) => b.textContent.trim() === 'Focus')?.click()`);
  await sleep(800);
  const alone = await identityText();
  check('A gone template on a web-app: the sentence, with Set', alone.includes('Template: retired-template · no longer in the studio') && (await hasButton('Set')), alone);
  await shot('5-no-kind');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
