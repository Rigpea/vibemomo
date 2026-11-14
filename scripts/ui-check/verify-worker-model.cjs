// By-eye check of Focus › Identity's worker model: the line reads the studio default, Edit offers the models with
// Studio default first, Save stores workerModel and the line names the model; saving the identity again without
// touching the select leaves it; choosing Studio default removes it. A private studio (temp data, own port and pid
// file), the real client; no worker starts.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-worker-model.cjs  (writes .local/verify-worker-model/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-worker-model');
const PORT = 4897;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-worker-model-'));
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
  const created = await api('POST', '/api/projects', { name: 'Verify Worker', kind: 'web-app' });
  const pid = created.project.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const stored = async () => (await api('GET', `/api/projects/${pid}`)).project.workerModel;

  const refused = await fetch(`${BASE}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerModel: 'gpt-5' }) });
  const refusedBody = await refused.json();
  check('The route refuses an unknown model with a 400 that names the choices', refused.status === 400 && /workerModel must be one of/.test(refusedBody.error?.message), `${refused.status} ${refusedBody.error?.message}`);

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = async (code) => { try { return await win.webContents.executeJavaScript(code, true); } catch (err) { throw new Error(`page script failed: ${String(code).replace(/\s+/g, ' ').slice(0, 240)} :: ${err.message}`); } };
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  // The section in edit mode is the form's own section, with no aria-label: found by the worker model's select then.
  const identity = `(document.querySelector('section.focus-sec[aria-label="Identity"]') || document.querySelector('select[data-edit="worker-model"]')?.closest('section'))`;
  const identityText = () => js(`${identity}?.innerText || ''`);
  const press = (label) => js(`[...${identity}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`);
  const choose = (value) => js(`(() => { const s = ${identity}.querySelector('select[data-edit="worker-model"]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await js(`[...document.querySelectorAll('.collab-head button, #main [role=tab], #main button')].find((b) => b.textContent.trim() === 'Focus')?.click()`);
  await sleep(800);
  await js(`${identity}.scrollIntoView()`);

  let text = await identityText();
  check('The line reads the studio default', /Worker model\s*Fable 5\.2 \(studio default\)/.test(text), text);
  await shot('1-default');

  await press('Edit');
  await sleep(300);
  const options = await js(`[...${identity}.querySelectorAll('select[data-edit="worker-model"] option')].map((o) => o.value + '=' + o.textContent)`);
  check('Edit offers Studio default first, then the models', options?.[0] === 'default=Studio default (Fable 5.2)' && options.includes('claude-opus-5-5=Opus 5.5') && options.length === 6, options);
  check('The hint says when it applies', /Applies to the next worker started; a running worker keeps its model\./.test(await identityText()), await identityText());
  await choose('claude-opus-5-5');
  await shot('2-edit');
  await press('Save');
  await sleep(1500);
  check('Save stores the model', (await stored()) === 'claude-opus-5-5', await stored());
  text = await identityText();
  check('The line names the model', /Worker model\s*Opus 5\.5/.test(text) && !text.includes('studio default'), text);
  await shot('3-opus');

  await press('Edit');
  await sleep(300);
  check('The select opens on the stored model', (await js(`${identity}.querySelector('select[data-edit="worker-model"]').value`)) === 'claude-opus-5-5');
  await press('Save');
  await sleep(1500);
  check('Saving the identity again keeps it', (await stored()) === 'claude-opus-5-5', await stored());

  await press('Edit');
  await sleep(300);
  await choose('default');
  await press('Save');
  await sleep(1500);
  check('Studio default removes it', (await stored()) === undefined, await stored());
  check('The line reads the default again', /Worker model\s*Fable 5\.2 \(studio default\)/.test(await identityText()), await identityText());

  // The studio default itself (settings.workerModel in the registry): shown and changed in the same form.
  const studioStored = async () => (await api('GET', '/api/settings/worker-model')).studio;
  const chooseStudio = (value) => js(`(() => { const s = ${identity}.querySelector('select[data-edit="studio-worker-model"]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const showSelects = async () => { await js(`${identity}.querySelector('select[data-edit="studio-worker-model"]').closest('.field').scrollIntoView({ block: 'end' })`); await sleep(400); };
  const firstChoice = () => js(`${identity}.querySelector('select[data-edit="worker-model"] option').textContent`);
  await press('Edit');
  await sleep(300);
  const studioOptions = await js(`[...${identity}.querySelectorAll('select[data-edit="studio-worker-model"] option')].map((o) => o.value + '=' + o.textContent)`);
  check('Edit offers the studio default: Built in first, then the models', studioOptions?.[0] === 'default=Built in (Fable 5.2)' && studioOptions.includes('claude-sonnet-5-5=Sonnet 5.5') && studioOptions.length === 6, studioOptions);
  check('Nothing stored: the select opens on Built in', (await js(`${identity}.querySelector('select[data-edit="studio-worker-model"]').value`)) === 'default');
  await chooseStudio('claude-sonnet-5-5');
  check('The worker model\'s first choice names the default being chosen', (await firstChoice()) === 'Studio default (Sonnet 5.5)', await firstChoice());
  await showSelects();
  await shot('4-studio-edit');
  await press('Save');
  await sleep(2000);
  check('Save stores the studio default in the registry', (await studioStored()).stored === 'claude-sonnet-5-5', JSON.stringify(await studioStored()));
  check('The project keeps no model of its own', (await stored()) === undefined, await stored());
  text = await identityText();
  check('The line names the stored studio default', /Worker model\s*Sonnet 5\.5 \(studio default\)/.test(text), text);
  await shot('5-studio-sonnet');

  // Changed from outside the window, as the manager's atelier_set_worker_model does: the open panel follows.
  await fetch(`${BASE}/api/settings/worker-model`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerModel: 'claude-haiku-5-5' }) });
  await sleep(2500);
  text = await identityText();
  check('A default set through the route reaches the open panel', /Worker model\s*Haiku 5\.5 \(studio default\)/.test(text), text);
  await press('Edit');
  await sleep(300);
  check('The form opens on the stored default and names it', (await js(`${identity}.querySelector('select[data-edit="studio-worker-model"]').value`)) === 'claude-haiku-5-5' && (await firstChoice()) === 'Studio default (Haiku 5.5)', await firstChoice());
  await choose('claude-opus-5-5'); // the project's own model and the studio default in one Save
  await chooseStudio('default');
  await showSelects();
  await shot('6-both-edit');
  await press('Save');
  await sleep(2000);
  check('Built in clears the stored default', (await studioStored()).stored === null && (await studioStored()).model === 'claude-fable-5-2', JSON.stringify(await studioStored()));
  check('The same Save stored the project\'s model', (await stored()) === 'claude-opus-5-5', await stored());
  text = await identityText();
  check('The line names the project\'s model', /Worker model\s*Opus 5\.5/.test(text) && !text.includes('studio default'), text);
  await shot('7-project-opus');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
