// By-eye and by-DOM check of the Companion dock tab: a private studio (temp data, own port and pid file) with
// ATELIER_CLAUDE_BIN set to tests/fixtures/fake-claude.mjs (echoes what reaches its stdin, one Read call per run),
// ATELIER_ADB and ATELIER_EMULATOR set to tests/fixtures/fake-adb.mjs and a fake WebView DevTools endpoint, a temp
// Capacitor project imported into it, the real client in an offscreen Electron window. Checks: Companion is the
// first tab and the tab is remembered per project; the grip pulls the dock tall, is saved, and a double-click gives
// the default back; Start makes a companion session; a message is answered with the context pack on the first send
// and a tool row in the trajectory; a pin added from the Phone panel's Point readout rides a message; Make it a task
// sends its message; a narrow window stacks the trajectory. Nothing here is a real claude or a real phone.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-companion.cjs  (writes .local/verify-companion/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-companion');
const PORT = 4903;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-companion-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const FAKE_ADB = path.join(ROOT, 'tests', 'fixtures', 'fake-adb.mjs');
const FAKE_CLAUDE = path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs');

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${JSON.stringify(data)}`);
  return data;
};

let server = null;
let cdp = null;
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  server?.kill();
  await cdp?.close().catch(() => {});
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 180000);

app.disableHardwareAcceleration();

async function main() {
  const { startFakeCdp } = await import(pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'fake-cdp.mjs')).href);
  cdp = await startFakeCdp();
  const env = {
    ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '',
    ATELIER_CLAUDE_BIN: FAKE_CLAUDE, ATELIER_ADB: `node "${FAKE_ADB}"`, ATELIER_EMULATOR: `node "${FAKE_ADB}"`, FAKE_ADB_CDP_PORT: String(cdp.port),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }

  // The Capacitor project of verify-phone.cjs.
  const folder = path.join(projectsDir, 'phone-probe');
  fs.mkdirSync(path.join(folder, 'android'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'android', 'README.txt'), 'The native project would be here.\n');
  fs.writeFileSync(path.join(folder, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.probe', appName: 'Phone Probe', webDir: 'src' }, null, 2));
  fs.writeFileSync(path.join(folder, 'atelier.json'), JSON.stringify({ name: 'Phone Probe', kind: 'web-app', entry: 'src/index.html', devices: { android: { avd: 'Fake_Pixel' } } }, null, 2));
  fs.writeFileSync(path.join(folder, 'src', 'index.html'), '<!doctype html>\n<button id="start" class="btn primary">Start the round now</button>\n<script type="module" src="app.js"></script>\n');
  fs.writeFileSync(path.join(folder, 'src', 'app.js'), 'document.getElementById("start").focus();\n');
  const imported = await api('POST', '/api/projects/import', { path: folder });
  const pid = imported.project.id;
  await api('PATCH', '/api/settings', { ui: { phonePanel: true } }); // the Phone tab is off unless the studio setting asks (decision row 125)
  await api('POST', `/api/projects/${pid}/activate`);
  const ui = async () => (await api('GET', `/api/projects/${pid}`)).project.ui || {};

  const win = new BrowserWindow({ width: 1366, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  // executeJavaScript can only return what structured clone copies: every expression here answers plain data, and
  // until() turns a node or a function that slips through into true rather than dying on "could not be cloned".
  const until = (expr, ms = 10000) => js(`(async () => { for (let i = 0; i < ${Math.ceil(ms / 100)}; i++) { try { const v = (${expr}); if (v) return (typeof v === 'object' && v.nodeType) || typeof v === 'function' ? true : v; } catch {} await new Promise((r) => setTimeout(r, 100)); } return null; })()`);
  const clickTab = (name) => js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}))?.click()`);
  const selectedTab = () => js(`document.querySelector('.dock-tabs [role="tab"][aria-selected="true"]')?.textContent.trim()`);
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);

  // ---------- the tab: first, and remembered ----------
  const tabs = await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].map((t) => t.textContent.trim())`);
  check('Claude Code is the first band tab, before Devices and Phone', tabs[0] === 'Claude Code' && tabs.includes('Phone'), tabs);
  check('a project with no remembered tab opens on Claude Code', (await selectedTab()) === 'Claude Code', await selectedTab());
  check('with no session: Idle · no session yet, a Start button and the model picker', !!(await until(`/^Idle · no session yet$/.test(document.querySelector('.cmp-state')?.textContent.trim() || '') && [...document.querySelectorAll('.cmp-start button')].some((b) => b.textContent.trim() === 'Start') && !!document.querySelector('.cmp-start select')`)),
    await js(`document.querySelector('.companion')?.innerText || ''`));
  check('the header names the brain in words', (await js(`document.querySelector('.cmp-brain')?.textContent`)) === 'Claude Code · Opus 5.5 · your login', await js(`document.querySelector('.cmp-brain')?.textContent`));
  await shot('a-companion-empty');
  await clickTab('Phone');
  await sleep(800);
  check('picking Phone stores it as the project\'s tab', (await ui()).dockTab === 'phone', await ui());
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  check('after a reload the dock opens on Phone again', (await selectedTab())?.startsWith('Phone'), await selectedTab());
  await clickTab('Claude Code');
  await sleep(600);

  // ---------- the grip ----------
  const before = await js(`Math.round(document.querySelector('.dock-body').getBoundingClientRect().height)`);
  await js(`(() => { const g = document.querySelector('.dock-grip'); const b = g.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + 4;
    g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: y }));
    g.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: y - 40 }));
    g.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: y - 40 })); })()`);
  await sleep(800);
  const pulled = await js(`(() => { const body = document.querySelector('.dock-body').getBoundingClientRect(); const prev = document.querySelector('.preview-wrap').getBoundingClientRect(); return { body: Math.round(body.height), preview: Math.round(prev.height) }; })()`);
  const savedHeight = (await ui()).dockHeight;
  // 40 px stays inside the clamp at 1366 x 860: the stage (the preview and the band's body) less 120 px, and the timeline now sits between them.
  check('dragging the grip up 40 px makes the band 40 px taller and the preview shorter', Math.abs(pulled.body - before - 40) <= 3 && pulled.preview >= 119, { before, pulled });
  check('the height is saved in project.ui.dockHeight', Number.isFinite(savedHeight) && Math.abs(savedHeight - pulled.body) <= 2, savedHeight);
  await js(`(() => { const g = document.querySelector('.dock-grip'); const b = g.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + 4;
    g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 8, clientX: x, clientY: y }));
    g.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 8, clientX: x, clientY: y - 3000 }));
    g.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 8, clientX: x, clientY: y - 3000 })); })()`);
  await sleep(600);
  const tall = await js(`Math.round(document.querySelector('.preview-wrap').getBoundingClientRect().height)`);
  check('pulled as far as it goes, the preview keeps about 120 px', tall >= 110 && tall <= 140, tall);
  await shot('b-dock-pulled-tall');
  await js(`document.querySelector('.dock-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(800);
  const reset = await js(`Math.round(document.querySelector('.dock-body').getBoundingClientRect().height)`);
  check('a double-click on the grip gives the default height back and forgets the saved one', Math.abs(reset - before) <= 2 && (await ui()).dockHeight == null, { before, reset, saved: (await ui()).dockHeight });

  // ---------- Start and a message ----------
  await js(`[...document.querySelectorAll('.cmp-start button')].find((b) => b.textContent.trim() === 'Start').click()`);
  const sid = await (async () => { for (let i = 0; i < 50; i++) { const id = (await ui()).companionSessionId; if (id) return id; await sleep(200); } return null; })();
  const rec = sid ? await api('GET', `/api/console/sessions/${sid}`) : null;
  check('Start makes a Claude Code session with the studio tools and the companion context, and remembers its id',
    rec && rec.backend === 'claude-code' && rec.tools === 'studio' && rec.context === 'companion' && rec.permissionMode === 'auto' && rec.model === 'claude-opus-5-5' && rec.title === 'Companion · Phone Probe', rec);
  await until(`!!document.querySelector('.cmp-composer textarea')`);
  check('the composer asks about the page when no pin is selected', (await js(`document.querySelector('.cmp-composer textarea').placeholder`)) === 'Ask about this page…', await js(`document.querySelector('.cmp-composer textarea').placeholder`));
  await js(`(() => { const ta = document.querySelector('.cmp-composer textarea'); ta.value = 'What is on the screen?'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  const answered = await until(`/echo: Studio context/.test(document.querySelector('.cmp-log')?.textContent || '') && /Done/.test(document.querySelector('.cmp-state')?.textContent || '')`, 20000);
  const thread = await js(`document.querySelector('.cmp-log').innerText`);
  check('the fake claude answers in the thread, and its echo shows the context pack went with the first message', !!answered && /Web entry: src\/index\.html/.test(thread) && /src\/app\.js \(module\)/.test(thread) && /Phone: Android:/.test(thread), thread.slice(0, 1200));
  check('the answer\'s meta line says it went with the studio context', /with the studio context/.test(thread), thread.slice(-400));
  const traj = await js(`[...document.querySelectorAll('.cmp-traj-rows .turn-events > div')].map((d) => d.textContent.trim())`);
  check('the trajectory shows the run\'s Read call as time · verb · file, and its result under it', traj.some((t) => /^\d\d:\d\d · Read · CLAUDE\.md$/.test(t)) && traj.some((t) => /CLAUDE\.md contents/.test(t)), traj);
  check('the state line reads Done · when, with the dot in its text', /^Done · (just now|\d+ min ago)$/.test((await js(`document.querySelector('.cmp-state').textContent`)).trim()), await js(`document.querySelector('.cmp-state').textContent`));
  check('the thread drew the answer without the could-not-be-drawn note', (await js(`document.querySelectorAll('.cmp-draw-error').length`)) === 0, await js(`document.querySelector('.cmp-draw-error')?.textContent || ''`));
  await shot('c-answered');

  // ---------- a fresh load shows the stored session, never Start ----------
  await win.loadURL(`${BASE}/#/workbench`);
  const reread = await until(`/echo: Studio context/.test(document.querySelector('.cmp-log')?.textContent || '') && /^Done · /.test(document.querySelector('.cmp-state')?.textContent.trim() || '')`, 10000);
  const startShown = await js(`[...document.querySelectorAll('.cmp-start button')].some((b) => b.textContent.trim() === 'Start')`);
  check('after a reload the tab shows the stored session (thread and Done), not Start', !!reread && !startShown && (await ui()).companionSessionId === sid,
    { reread: !!reread, startShown, stored: (await ui()).companionSessionId, sid });

  // ---------- a pin from the Phone panel ----------
  await clickTab('Phone');
  await until(`(() => { const im = document.querySelector('.phone-img'); return im && !im.hidden && im.naturalWidth > 0; })()`);
  await js(`[...document.querySelectorAll('.phone-keys button')].find((b) => b.textContent.trim() === 'Point mode').click()`);
  await js(`(() => { const im = document.querySelector('.phone-img'); const b = im.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; im.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y })); im.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y })); })()`);
  await until(`[...document.querySelectorAll('.phone-readout button')].some((b) => b.textContent.trim() === 'Pin')`);
  await js(`[...document.querySelectorAll('.phone-readout button')].find((b) => b.textContent.trim() === 'Pin').click()`);
  await sleep(800);
  const pins = (await api('GET', `/api/projects/${pid}/companion/pins`)).pins;
  check('Pin stores the readout in .studio/pins.json', pins.length === 1 && pins[0].element === 'button#start.btn.primary' && pins[0].files[0] === 'src/index.html:2' && fs.existsSync(path.join(folder, '.studio', 'pins.json')), pins);
  await clickTab('Claude Code');
  const card = await until(`document.querySelector('.pin-card .pin-title')?.textContent`);
  check('the Companion tab lists it under the thread as Pin 1 · element · file', card === 'Pin 1 · button#start.btn.primary · src/index.html:2', card);
  check('the tab counts the pins', /Claude Code\s*1$/.test(await selectedTab()), await selectedTab());
  await js(`document.querySelector('.pin-card').click()`);
  await sleep(300);
  const attach = await js(`({ chip: document.querySelector('.cmp-attach .attach')?.textContent, placeholder: document.querySelector('.cmp-composer textarea').placeholder })`);
  check('a selected pin is a chip above the composer and the placeholder asks to refine it', attach.chip === 'Phone Probe / Phone / button#start.btn.primary' && attach.placeholder === 'Refine the selected part…', attach);
  await shot('d-pin-selected');
  await js(`(() => { const ta = document.querySelector('.cmp-composer textarea'); ta.value = 'Make it larger'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(`/echo: Make it larger/.test(document.querySelector('.cmp-log').textContent) && /Done/.test(document.querySelector('.cmp-state').textContent)`, 20000);
  const withPin = (await api('GET', `/api/console/sessions/${sid}`)).turns.filter((t) => t.role === 'user').at(-1);
  check('the pin rode the message as its block (point, element, text, files and the screenshot hint)', /^Make it larger\n\n---\nSelected pin \(from the studio\):/.test(withPin.text) && /- Files: src\/index\.html:2/.test(withPin.text) && /atelier_phone_screenshot/.test(withPin.text), withPin.text);
  check('the second message went without the context pack', !/Studio context/.test((await api('GET', `/api/console/sessions/${sid}`)).turns.at(-1).text), null);
  check('after sending the pin is let go', !(await js(`!!document.querySelector('.cmp-attach')`)), null);

  // ---------- Make it a task ----------
  await js(`[...document.querySelectorAll('.cmp-actions button')].find((b) => b.textContent.trim() === 'Make it a task').click()`);
  await until(`/echo: Turn this thread into a studio task/.test(document.querySelector('.cmp-log').textContent) && /Done/.test(document.querySelector('.cmp-state').textContent)`, 20000);
  const askTask = (await api('GET', `/api/console/sessions/${sid}`)).turns.filter((t) => t.role === 'user').at(-1).text;
  check('Make it a task sends the canned message', askTask === 'Turn this thread into a studio task with atelier_create_task: a title, the request with the pins\' files named, the numbers of the pins it is about as pins, three acceptance lines, mode handle; then tell me the task id.', askTask);
  await shot('e-make-it-a-task');

  // ---------- narrow ----------
  win.setContentSize(1000, 760);
  await sleep(900);
  const narrow = await js(`(() => { const host = document.querySelector('.companion-host'); const split = document.querySelector('.cmp-split'); return { width: host.clientWidth, stacked: split.classList.contains('stacked'), rowsHidden: document.querySelector('.cmp-traj-rows').hidden, button: !!document.querySelector('.cmp-state-btn') }; })()`);
  check('under 760 px the trajectory stacks under the thread, folded to its state line', narrow.width < 760 ? narrow.stacked && narrow.rowsHidden && narrow.button : !narrow.stacked, narrow);
  await shot('f-narrow');
  win.setContentSize(1366, 860);
  await sleep(500);
  check('the session shows in the Claude Code view\'s list too', (await api('GET', `/api/console/sessions?projectId=${pid}`)).some((s) => s.id === sid), null);
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
