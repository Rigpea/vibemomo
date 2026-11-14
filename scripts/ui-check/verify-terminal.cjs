// By-eye check of the Terminal dock tab (workbenches/terminal/panel.js, ARCHITECTURE.md section 14) on a temp web-app
// project from templates/web-app-notes: the Terminal tab after Page, Open terminal spawning a real shell (node-pty
// prebuild), the facts line naming the shell and the project folder, the tab's count, echo atelier-ok typed into the
// xterm and read back from the pane, the pane refitting when the grip pulls the dock taller, then Close ending it.
// A private studio (temp data, own port and pid file), the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-terminal.cjs  (writes .local/verify-terminal/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-terminal');
const PORT = 4911;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-terminal-'));
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
  try { for (const t of await api('GET', '/api/terminal')) await api('DELETE', `/api/terminal/${t.id}`); } catch { /* server gone */ }
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
  const created = await api('POST', '/api/projects', { name: 'Verify Terminal', kind: 'web-app', template: 'web-app-notes' });
  const pid = created.project?.id || created.id;
  await api('POST', `/api/projects/${pid}/activate`);

  const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);
  const tabs = await js(`[...document.querySelectorAll('#main .dock-tablist [role="tab"]')].map((b) => b.dataset.kind)`);
  check('a Terminal tab right after Source, which follows Claude Code; no Page tab in the band', tabs.indexOf('terminal') === tabs.indexOf('source') + 1 && tabs.indexOf('source') === tabs.indexOf('companion') + 1 && !tabs.includes('page'), tabs); // the Page panel is the left column
  await js(`document.querySelector('#main .dock-tablist [data-kind="terminal"]').click()`);
  await sleep(1500);
  const before = await js(`(() => { const b = document.querySelector('#main .dock-body'); return { empty: document.querySelector('#main .terminal-host .term-pane')?.textContent || '', height: Math.round(b.getBoundingClientRect().height), vh: innerHeight }; })()`);
  check('the empty pane says how to start', /No terminal open in this project/.test(before.empty), before.empty);
  check('the band body takes clamp(150px, 24vh, 520px)', Math.abs(before.height - Math.min(520, Math.max(150, before.vh * 0.24))) <= 2, before);
  await shot('1-terminal-tab');

  // Open terminal: a real shell in the project folder.
  await js(`[...document.querySelectorAll('#main .terminal-host button')].find((b) => b.textContent.trim() === 'Open terminal').click()`);
  await sleep(2500);
  const list = await api('GET', '/api/terminal');
  const t = list.find((x) => x.projectId === pid);
  check('Open terminal spawned a shell in the project', !!t && !t.exited, list);
  const shell = String(t?.shell || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const facts = await js(`document.querySelector('#main .terminal-host .term-facts')?.textContent || ''`);
  check('the facts line names the shell and the project folder', !!t && facts.includes(t.cwd) && facts.includes(` · ${shell} · pid ${t.pid}`), { facts, cwd: t?.cwd, shell });
  const count = await js(`document.querySelector('#main .dock-tablist [data-kind="terminal"] .tab-count')?.textContent || null`);
  check('the tab counts one open terminal', count === '1', count);

  // Type into the xterm through real key input and read the pane.
  await js(`document.querySelector('#main .terminal-host .xterm-helper-textarea')?.focus()`);
  await sleep(200);
  win.webContents.insertText('echo atelier-ok');
  await sleep(200);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await sleep(2000);
  const rows = await js(`document.querySelector('#main .terminal-host .xterm-rows')?.textContent || ''`);
  check('echo atelier-ok is read back in the pane', (rows.match(/atelier-ok/g) || []).length >= 2, rows.slice(-400));
  await shot('2-echo');

  // The grip pulls the dock taller: the xterm gets more rows.
  const rowsBefore = await js(`document.querySelectorAll('#main .terminal-host .xterm-rows > div').length`);
  await js(`(() => {
    const g = document.querySelector('#main .dock-grip'); const r = g.getBoundingClientRect(); const y = r.top + 4;
    const ev = (type, cy) => g.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: r.left + 40, clientY: cy }));
    ev('pointerdown', y); ev('pointermove', y - 120); ev('pointerup', y - 120);
  })()`);
  await sleep(1200);
  const rowsAfter = await js(`document.querySelectorAll('#main .terminal-host .xterm-rows > div').length`);
  check('the pane refits when the grip moves (more rows)', rowsAfter > rowsBefore, { rowsBefore, rowsAfter });
  await shot('3-taller');

  // Close ends the shell and the tab goes.
  await js(`document.querySelector('#main .terminal-host .term-tab button[title^="Close (ends"]').click()`);
  await sleep(1500);
  const after = await api('GET', '/api/terminal');
  const gone = await js(`({ tabs: document.querySelectorAll('#main .terminal-host .term-tab').length, count: document.querySelector('#main .dock-tablist [data-kind="terminal"] .tab-count')?.textContent || null })`);
  check('Close ended the shell, and the tab and the count are gone', !after.some((x) => x.projectId === pid) && gone.tabs === 0 && gone.count === null, { after, gone });
  await shot('4-closed');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
