// Electron shell for the studio (docs/ARCHITECTURE.md section 9, decision row 14).
// It does not change the companion or the UI: it finds or starts `node server/index.mjs`
// with the SYSTEM Node, waits for /api/health, and shows http://127.0.0.1:<port>/ in a native
// window with a tray icon. It stops only a companion it started itself (by its own child pid).
//
// Dev flag: --screenshot <path.png|path.jpg>  load, wait 1.5 s, capture the window, write, quit.
'use strict';
require('../server/lib/env.cjs');
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// The name on screen. The storage identity below stays the old one, so a renamed app keeps its window state.
const PRODUCT = 'vibeMomo';
// Electron keeps the studio page's localStorage, the single-instance lock and the packaged log under userData, named
// after the app: "atelier" from package.json when run from source, and possibly the build's productName in a packaged
// exe. Pinned to appData/atelier (the folder every earlier version used; Windows folder names ignore case), so the
// visible rename to vibeMomo moves nothing. Set before the app is ready, as Electron requires.
app.setPath('userData', path.join(app.getPath('appData'), 'atelier'));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PORT = Number(process.env.ATELIER_PORT || 4747);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NODE = process.env.ATELIER_NODE || 'node';
const LOG_FILE = app.isPackaged ? path.join(app.getPath('userData'), 'atelier-app.log') : path.join(ROOT, '.local-app.log');
const HEALTH_WAIT_MS = 15000;
const MIN_NODE_MAJOR = 22;
// The pid file the companion writes (server/index.mjs resolves it against its cwd, ROOT).
const PID_FILE = path.resolve(ROOT, process.env.ATELIER_PID_FILE || path.join('.local', 'server.pid'));

const argv = process.argv.slice(1);
const shotIdx = argv.indexOf('--screenshot');
const SCREENSHOT = shotIdx >= 0 && argv[shotIdx + 1] ? path.resolve(process.cwd(), argv[shotIdx + 1]) : null;

let win = null;
let tray = null;
let companion = null; // { child, pid } when this app started it; null when attached to a running one
let quitting = false;
let stopped = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(msg) {
  const line = `[${new Date().toISOString()}] [app] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* log is best effort */ }
  process.stdout.write(line);
}

async function health() {
  try {
    const res = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const h = await res.json();
    return h && h.ok ? h : null;
  } catch {
    return null;
  }
}

/** Version of the Node that would run the companion, or {error}. */
function probeNode() {
  const r = spawnSync(NODE, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (r.error) return { error: r.error.code === 'ENOENT' ? `"${NODE}" was not found on PATH` : r.error.message };
  const v = String(r.stdout || '').trim();
  const major = Number((v.match(/^v(\d+)/) || [])[1]);
  if (!major) return { error: `"${NODE} --version" printed ${JSON.stringify(v || r.stderr || '')}` };
  if (major < MIN_NODE_MAJOR) return { error: `"${NODE}" is ${v}; the studio needs Node ${MIN_NODE_MAJOR} or newer` };
  return { version: v };
}

function companionEnv() {
  const env = { ...process.env };
  // The portable exe unpacks into a temp folder; new projects must not land beside it.
  if (app.isPackaged && !env.ATELIER_PROJECTS_DIR) env.ATELIER_PROJECTS_DIR = path.join(app.getPath('documents'), 'Atelier projects');
  return env;
}

/** Start `node server/index.mjs`; resolves {ok} once health answers with our pid, or {error}. */
async function startCompanion() {
  const node = probeNode();
  if (node.error) return { error: node.error, nodeMissing: true };
  const out = fs.openSync(LOG_FILE, 'a');
  let child;
  try {
    child = spawn(NODE, ['server/index.mjs'], { cwd: ROOT, env: companionEnv(), stdio: ['ignore', out, out], windowsHide: true });
  } catch (err) {
    fs.closeSync(out);
    return { error: err.message, nodeMissing: err.code === 'ENOENT' };
  }
  fs.closeSync(out); // the child holds its own handle
  let exited = null;
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    // taskkill /F ends the process with code 1: after our own kill that is a stop, not a failure.
    if (child.atelierStopping) log(`companion stopped (pid ${child.pid})`);
    else log(`companion pid ${child.pid} exited (code ${code}, signal ${signal})`);
    if (companion && companion.child === child) companion = null;
  });
  companion = { child, pid: child.pid };
  log(`started companion: ${NODE} (${node.version}) server/index.mjs, pid ${child.pid}, port ${PORT}, cwd ${ROOT}`);
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    if (spawnError) return { error: spawnError.message, nodeMissing: spawnError.code === 'ENOENT' };
    if (exited) return { error: `the companion exited during startup (code ${exited.code}); see ${LOG_FILE}` };
    const h = await health();
    if (h) {
      if (h.pid !== child.pid) log(`health answers with pid ${h.pid}, spawned ${child.pid}`);
      log(`companion healthy on ${ORIGIN} (pid ${h.pid}, v${h.version})`);
      return { ok: true };
    }
    await sleep(250);
  }
  return { error: `no /api/health answer on ${ORIGIN} within ${HEALTH_WAIT_MS / 1000} s; see ${LOG_FILE}` };
}

function portListeners() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c[0] === 'TCP' && c[3] === 'LISTENING' && new RegExp(`:${PORT}$`).test(c[1])).map((c) => Number(c[4]));
  } catch {
    return null;
  }
}

/** Stop the companion this app started (never one it attached to) and wait for the port to free. */
async function stopCompanion() {
  const c = companion;
  if (!c) return;
  companion = null;
  log(`stopping companion pid ${c.pid}`);
  c.child.atelierStopping = true;
  if (c.child.exitCode === null && c.child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else try { c.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 40; i++) {
    const listeners = portListeners();
    const free = listeners ? !listeners.length : !(await health());
    if (free) { log(`port ${PORT} is free`); dropPidFile(c.pid); return; }
    await sleep(150);
  }
  log(`port ${PORT} still in use after stopping pid ${c.pid}`);
}

/** A forced stop skips the companion's own exit cleanup: remove its pid file, only if it names that pid. */
function dropPidFile(pid) {
  try {
    if (JSON.parse(fs.readFileSync(PID_FILE, 'utf8')).pid !== pid) return;
    fs.rmSync(PID_FILE);
    log(`removed pid file ${PID_FILE}`);
  } catch { /* already gone, unreadable or not ours */ }
}

function errorPage(title, body) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const html = `<!doctype html><meta charset="utf-8"><title>${PRODUCT}</title>
<style>body{background:#111317;color:#e8e4da;font:15px/1.55 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}
main{max-width:620px;padding:32px}h1{font-size:20px;margin:0 0 12px}code{background:#1d2027;padding:2px 6px;border-radius:4px}p{color:#bdb8ad}</style>
<main><h1>${esc(title)}</h1>${body}</main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function nodeRequiredPage(reason) {
  return errorPage(`${PRODUCT} needs Node.js 22 or newer`, `
<p>The studio's companion runs with the Node.js installed on this computer, and it could not be started: ${String(reason).replace(/[&<>]/g, '')}.</p>
<p>Install the current LTS from <code>https://nodejs.org</code> (or <code>winget install OpenJS.NodeJS.LTS</code>), make sure <code>node --version</code> prints v22 or newer in a new terminal, then start ${PRODUCT} again.</p>
<p>To use a specific Node, set <code>ATELIER_NODE</code> to its full path.</p>`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#111317',
    title: PRODUCT,
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The page sets its own <title>; the window keeps the product name.
  win.on('page-title-updated', (e) => e.preventDefault());
  const isOurs = (url) => { try { return new URL(url).origin === ORIGIN; } catch { return false; } };
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#111317', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } };
    external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isOurs(url) || url.startsWith('data:')) return;
    e.preventDefault();
    external(url);
  });
  win.on('close', (e) => {
    if (quitting || SCREENSHOT) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
  return win;
}

function showWindow() {
  if (!win) createWindow().loadURL(`${ORIGIN}/`);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTrayMenu() {
  const items = [{ label: `Open ${PRODUCT}`, click: showWindow }];
  if (companion) items.push({ label: 'Restart companion', click: restartCompanion });
  // The studio's own restart (POST /api/studio/restart): works for a server this app did not start too.
  else items.push({ label: 'Restart studio', click: restartStudio });
  items.push({ type: 'separator' });
  if (!companion) items.push({ label: 'Quit and stop the studio', click: quitAndStop });
  items.push({ label: 'Quit', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip(`${PRODUCT} (${ORIGIN})`);
  tray.on('click', showWindow);
  buildTrayMenu();
}

/** The studio's restart through its own route; the window reloads once the fresh server answers. */
async function restartStudio() {
  try {
    const before = await health();
    await fetch(`${ORIGIN}/api/studio/restart`, { method: 'POST' });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const h = await health();
      if (h && h.startedAt !== before?.startedAt) { if (win) win.loadURL(`${ORIGIN}/`); return; }
    }
    log('restart: no fresh health answer within 30 s');
  } catch (err) { log(`restart failed: ${err.message}`); }
}

/** Quit the app and stop the attached server too (scripts/restart.mjs --stop proves it is this studio's first). */
function quitAndStop() {
  const r = spawnSync(NODE, [path.join(ROOT, 'scripts', 'restart.mjs'), '--stop'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  log(`quit and stop: ${(r.stdout || r.error?.message || '').trim().split(/\r?\n/).pop()}`);
  app.quit();
}

async function restartCompanion() {
  if (!companion) return;
  await stopCompanion();
  const r = await startCompanion();
  if (tray) buildTrayMenu();
  if (!win) return;
  if (r.ok) win.loadURL(`${ORIGIN}/`);
  else win.loadURL(r.nodeMissing ? nodeRequiredPage(r.error) : errorPage('The companion did not start', `<p>${r.error}</p>`));
}

/** Window pixels as a NativeImage: capturePage first, then the DevTools protocol (another render path). */
async function grab() {
  try {
    return await win.webContents.capturePage();
  } catch (err) {
    log(`capturePage failed (${err.message}); trying Page.captureScreenshot`);
  }
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  try {
    const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
    return nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  } finally {
    dbg.detach();
  }
}

async function capture(file) {
  await sleep(1500);
  try {
    win.show();
    // Evidence that the preload bridge reaches the page (version, Electron, GPU from specs()).
    const bridge = await win.webContents.executeJavaScript(
      `(async () => { const d = window.atelierDesktop; return d ? JSON.stringify({ version: d.version, electron: d.electron, chrome: d.chrome, specs: await d.specs() }) : 'window.atelierDesktop missing'; })()`,
    ).catch((err) => `bridge check failed: ${err.message}`);
    log(`atelierDesktop: ${bridge}`);
    const image = await grab();
    if (image.isEmpty()) throw new Error('empty image');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = /\.jpe?g$/i.test(file) ? image.toJPEG(85) : image.toPNG();
    fs.writeFileSync(file, buf);
    const s = image.getSize();
    log(`screenshot ${file} (${s.width}x${s.height}, ${buf.length} bytes)`);
  } catch (err) {
    log(`screenshot failed: ${err.message}`);
    process.exitCode = 1;
  }
  app.quit();
}

// PCI vendor ids; 'basic' GPU info usually leaves vendorString empty.
const GPU_VENDORS = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x1414: 'Microsoft', 0x106b: 'Apple', 0x5143: 'Qualcomm' };

function gpuSummary(info) {
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  const hex = (n) => (typeof n === 'number' ? `0x${n.toString(16).padStart(4, '0')}` : null);
  return devices.map((d) => {
    const g = { vendor: d.vendorString || GPU_VENDORS[d.vendorId] || hex(d.vendorId), device: d.deviceString || hex(d.deviceId) };
    if (d.driverVersion) g.driver = d.driverVersion;
    if (d.active) g.active = true;
    return g;
  });
}

ipcMain.on('atelier:version', (e) => { e.returnValue = PKG.version; });
ipcMain.handle('atelier:pick-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: 'Import a folder', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('atelier:specs', async () => {
  let gpus = [];
  try { gpus = gpuSummary(await app.getGPUInfo('basic')); } catch { /* GPU process unavailable */ }
  // Windows' software adapter is not a GPU the person owns.
  gpus = gpus.filter((g) => !/Basic Render Driver/i.test(`${g.device || ''} ${g.vendor || ''}`));
  return { gpus, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
});

// One studio window per user session; a second launch focuses it. Screenshot runs are
// one-shot checks on their own port and skip the lock so they can run beside a real one.
if (!SCREENSHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => { /* stay in the tray */ });
  app.on('before-quit', (e) => {
    quitting = true;
    if (stopped || !companion) return;
    e.preventDefault();
    stopCompanion().finally(() => { stopped = true; app.quit(); });
  });

  app.whenReady().then(async () => {
    log(`${PRODUCT} desktop ${PKG.version} (Electron ${process.versions.electron}) on ${ORIGIN}${SCREENSHOT ? `, screenshot ${SCREENSHOT}` : ''}`);
    createTray();
    createWindow();
    if (SCREENSHOT) win.webContents.once('did-finish-load', () => capture(SCREENSHOT));
    const h = await health();
    let target = `${ORIGIN}/`;
    if (h) {
      log(`attached to the running companion pid ${h.pid} (v${h.version}); it is not ours and stays running on quit`);
    } else {
      const r = await startCompanion();
      if (!r.ok) {
        log(`companion failed: ${r.error}`);
        target = r.nodeMissing ? nodeRequiredPage(r.error) : errorPage('The companion did not start', `<p>${r.error}</p>`);
      }
    }
    buildTrayMenu();
    if (win) await win.loadURL(target).catch((err) => log(`load failed: ${err.message}`));
  }).catch((err) => {
    log(`startup failed: ${err.stack || err.message}`);
    dialog.showErrorBox(PRODUCT, String(err.message || err));
    app.quit();
  });
}
