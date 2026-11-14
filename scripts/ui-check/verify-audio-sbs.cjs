// By-eye and by-DOM check of Side by side and the dialogs on an audio project: a private studio (temp data,
// own port and pid file), a project from templates/audio-sound-sketch, the real client in an offscreen Electron
// window, real key events through the debugger.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-audio-sbs.cjs  (writes .local/verify-audio-sbs/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-audio-sbs');
const PORT = 4896;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-sbs-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 150000);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const res = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Verify Sketch', kind: 'audio', template: 'audio-sound-sketch' }) });
  if (!res.ok) throw new Error(`create: ${res.status}`);
  const projectPath = path.join(projectsDir, 'verify-sketch');
  console.log("MARK project-created");

  const win = new BrowserWindow({ width: 1000, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  console.log("MARK debugger-attached");
  const shot = async (name) => { await sleep(400); try { const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { console.log(`shot ${name} skipped: ${err.message}`); } };
  const press = async (key, code, vk) => {
    for (const type of ['keyDown', 'keyUp']) await dbg.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(500);
  };
  const esc = () => press('Escape', 'Escape', 27);
  const openTab = async (name) => { await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === ${JSON.stringify(name)})?.click()`); await sleep(600); };
  const toolbar = async (label) => { await js(`[...document.querySelectorAll('.stage-head button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`); await sleep(1500); };
  const sbsOpen = () => js(`!!document.querySelector('.preview-wrap dialog[open]')`);
  const row = (cue) => js(`document.querySelector('.cue-list button[data-cue="${cue}"]').closest('li').children[1].innerText.trim()`);
  const active = () => js(`document.activeElement.getAttribute('aria-label') || document.activeElement.tagName`);
  await win.loadURL(`${BASE}/#workbench`);
  await sleep(2500);
  console.log("MARK page-loaded");

  // ---- 2. a narrow window: the overlay gets out of the way, and can come back
  await js(`[...document.querySelectorAll('.stage-head button')].find((b) => b.textContent.trim() === 'Panel').click()`);
  await sleep(400);
  const before = await js(`!document.getElementById('app').classList.contains('collab-collapsed')`);
  await shot('a-narrow-panel-open');
  await toolbar('Side by side');
  const narrowClosed = await js(`({ open: !document.getElementById('app').classList.contains('collab-collapsed'), frames: document.querySelectorAll('.sbs-col iframe').length, collapsed: document.getElementById('app').classList.contains('collab-collapsed') })`);
  check('opening Side by side closes the narrow overlay', before === true && narrowClosed.open === false && narrowClosed.collapsed && narrowClosed.frames === 2, { before, ...narrowClosed });
  await shot('b-sbs-narrow');
  await js(`[...document.querySelectorAll('.stage-head button')].find((b) => b.textContent.trim() === 'Panel').click()`);
  await sleep(300);
  check('the person can reopen it over the open overlay', await js(`!document.getElementById('app').classList.contains('collab-collapsed')`) === true && await sbsOpen());
  await js(`[...document.querySelectorAll('.stage-head button')].find((b) => b.textContent.trim() === 'Panel').click()`);
  await sleep(300);

  // ---- 1. Trigger names every frame; a press inside a frame names it
  await openTab('Audio');
  await sleep(1500); // the frames have loaded and said ready
  await js(`document.querySelector('.cue-list button[data-cue="blip"]').click()`);
  await sleep(1200);
  const byTrigger = await row('blip');
  check('a Trigger names the main preview and both frames, with numbers', /^played in main, A, B · \d\.\d\d s · -\d+ dB$/.test(byTrigger), byTrigger);
  const size = await js(`(() => { const li = document.querySelector('.cue-list button[data-cue="blip"]').closest('li'); const d = li.children[1].firstElementChild; return { lines: d.getClientRects().length, height: d.offsetHeight, lineHeight: parseFloat(getComputedStyle(d).lineHeight) }; })()`);
  check('that line stays one line at 1000 px', size.height <= size.lineHeight * 1.5, size);
  await shot('c-trigger-all-frames');

  await js(`document.querySelector('.sbs-col.side-a iframe').focus()`);
  await js(`document.querySelector('.sbs-col.side-a iframe').contentWindow.focus()`);
  await sleep(200);
  await press('3', 'Digit3', 51);
  await sleep(500);
  const mirrored = await row('tick');
  check('a real key press in frame A shows in the panel, the frame named; the mirror fires B', /^fired in A(, B)? · key( · |$)/.test(mirrored), mirrored);
  await shot('d-key-in-frame');
  await js(`document.getElementById('sbs-mirror').click()`);
  await js(`document.querySelector('.sbs-col.side-b iframe').contentWindow.focus()`);
  await sleep(200);
  await press('3', 'Digit3', 51);
  await sleep(500);
  const alone = await row('tick');
  check('with the mirror off a press in B names only B', /^fired in B · key( · |$)/.test(alone), alone);
  await js(`document.getElementById('sbs-mirror').click()`);

  // A frame's own Reload forgets its plays: both frames reloaded, nothing is left of a press only they heard.
  await js(`document.querySelector('.sbs-col.side-b button[aria-label="Reload B"]').click()`);
  await sleep(300);
  const afterReloadB = await row('tick');
  check('Reload B forgets B\'s plays in the row', !/\bB\b/.test(afterReloadB), afterReloadB);
  await js(`document.querySelector('.sbs-col.side-a button[aria-label="Reload A"]').click()`);
  await sleep(1500); // the frames have loaded again before the next steps use them
  const afterReloadA = await row('tick');
  check('and Reload A leaves the row with no plays', /not fired yet/.test(afterReloadA), afterReloadA);

  // ---- 3. Esc from anywhere, focus back on the toolbar button
  await js(`document.querySelector('.dock-tabs [role="tab"]').focus()`);
  await esc();
  check('Esc with focus on a dock button closes it', !(await sbsOpen()));
  const fromDock = await active();
  check('and focus lands on the Side by side button', fromDock === 'Side by side compare', fromDock);
  await toolbar('Side by side');
  await js(`document.querySelector('.sbs-col.side-a iframe').contentWindow.focus()`);
  await sleep(200);
  await esc();
  const fromFrame = await active();
  check('Esc inside a frame closes it and focus lands on the button, not the body', !(await sbsOpen()) && fromFrame === 'Side by side compare', fromFrame);
  await toolbar('Side by side');
  await js(`document.querySelector('.preview-wrap dialog[open] .dialog-head button').click()`);
  await sleep(300);
  const fromX = await active();
  check('the X returns focus there too', !(await sbsOpen()) && fromX === 'Side by side compare', fromX);
  await toolbar('Side by side');
  await toolbar('Keep version');
  const modalUp = await js(`!!document.querySelector('dialog:modal')`);
  await esc();
  check('a modal over it takes its own Esc and the overlay stays', modalUp && !(await js(`!!document.querySelector('dialog:modal')`)) && await sbsOpen());
  await esc();
  check('the next Esc closes the overlay', !(await sbsOpen()));
  // leaving the view closes it, so its listener goes with it; Esc afterwards reaches nothing it owns
  await toolbar('Side by side');
  await js(`location.hash = '#/memory'`);
  await sleep(800);
  // The view is part of the check: a hash the router does not read leaves the Workbench mounted, and nothing has been left.
  const left = await js(`({ view: atelier.state.view, targets: [...(atelier.previewTargets || [])].map((t) => ({ connected: t.frame.isConnected, ref: t.getRef() })) })`);
  check('leaving the view removes the frames from the live targets', left.view === 'memory' && left.targets.length === 0, left);
  await js(`location.hash = '#/workbench'`);
  await sleep(1500);

  // ---- 4. the checklist in the Audio panel, and the dialogs that point at it
  await openTab('Audio');
  const list = await js(`(() => { const rows = document.querySelector('.cue-list').getBoundingClientRect(); const box = [...document.querySelectorAll('.wbp-host h3')].find((h) => /Readiness checklist/.test(h.textContent)); return box ? { title: box.textContent, below: box.getBoundingClientRect().top >= rows.bottom, boxes: document.querySelectorAll('.wbp-host .check input').length } : null; })()`);
  check('the Audio panel has the checklist, below the cue rows', list && list.below && list.boxes > 0, list);
  await js(`document.querySelector('.wbp-host .check input').scrollIntoView({ block: 'center' })`);
  await js(`document.querySelector('.wbp-host .check input').click()`);
  await sleep(800);
  const ticked = await js(`[...document.querySelectorAll('.wbp-host h3')].find((h) => /Readiness checklist/.test(h.textContent)).textContent`);
  check('a tick counts', /· 1\//.test(ticked), ticked);
  await shot('e-checklist');
  await js(`document.querySelector('.cue-list button[data-render="blip"]').click()`);
  await sleep(1500);
  // the checklist survives a row redraw with its focus (the panel redraws on every event and every 5 s)
  await js(`document.querySelector('.wbp-host .check input').focus()`);
  await js(`document.querySelector('.cue-list button[data-cue="blip"]').click()`);
  await sleep(600);
  check('a row redraw leaves focus on the checkbox', await js(`document.activeElement.matches('.check input')`));

  // a tick is project data: keep what changed on disk with a long label, so the dialogs have a cut one to name
  fs.appendFileSync(path.join(projectPath, 'README.md'), '\nchanged\n');
  await sleep(600);
  const LONG = 'Make the swell shorter and quieter: swellDecayMs down by about a quarter and swellVolume down by about a fifth';
  await js(`atelier.api.keepVersion(atelier.projectId(), { label: ${JSON.stringify(LONG)}, note: '', state: 'experiment' }).then(() => atelier.loadBundle({ quiet: true }))`);
  await sleep(1000);

  await toolbar('Build/Export');
  const exportText = await js(`document.querySelector('dialog:modal').innerText`);
  check('the export dialog names the Audio panel, not Play or Devices', /the Audio panel/.test(exportText) && !/Play or Devices/.test(exportText), exportText);
  check('and says renders under dist/audio will travel', /Renders under dist\/audio will travel/.test(exportText), exportText);
  await shot('f-export-dialog');
  await js(`document.querySelector('dialog:modal .dialog-actions .btn.primary').click()`);
  await sleep(2500);
  const readyText = await js(`document.querySelector('dialog:modal').innerText`);
  check('after the build it says how many travel', /1 rendered file travels with this export, in audio\//.test(readyText), readyText);
  check('and a cut label gets no full stop', !/…\./.test(readyText), readyText.split('\n')[2]);
  await shot('g-export-ready');
  await esc();

  await toolbar('Restore');
  // Pick the long version: its name is cut.
  await js(`(() => { const s = document.querySelector('dialog:modal select'); s.value = [...s.options].find((o) => o.textContent.includes('Make the swell')).value; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const restoreText = await js(`document.querySelector('dialog:modal').innerText`);
  check('the Restore dialog has the cut label with no full stop after it', /…/.test(restoreText) && !/…\./.test(restoreText), restoreText);
  await shot('h-restore');
  await esc();

  // ---- the line at 800 px, Side by side open
  win.setContentSize(800, 800);
  await sleep(600);
  await toolbar('Side by side');
  await openTab('Audio');
  await sleep(1000);
  await js(`document.querySelector('.cue-list button[data-cue="blip"]').click()`);
  await sleep(1200);
  const narrowRow = await js(`(() => { const d = document.querySelector('.cue-list button[data-cue="blip"]').closest('li').children[1].firstElementChild; const b = document.querySelector('.dock-body'); return { text: d.innerText, height: d.offsetHeight, lineHeight: parseFloat(getComputedStyle(d).lineHeight), scroll: b.scrollWidth, client: b.clientWidth }; })()`);
  check('at 800 px the played line stays one line and nothing scrolls sideways', narrowRow.height <= narrowRow.lineHeight * 1.5 && narrowRow.scroll <= narrowRow.client, narrowRow);
  await shot('i-800');
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
