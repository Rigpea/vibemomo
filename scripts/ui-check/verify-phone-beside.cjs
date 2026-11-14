// By-eye and by-DOM check of the phone's screen beside the preview: the Phone driver's fixture (a private studio with
// tests/fixtures/fake-adb.mjs as adb and emulator, the fake WebView DevTools endpoint, a temp Capacitor project with a
// devices manifest) in an offscreen Electron window at 1500 and at 1200 px wide. Checks the side slot filled and
// empty, the screen's ratio and height in it, the live line under the image, the tab's line, a tap and Point mode on
// the moved image, the hysteresis band, and the "Beside the preview" switch kept per project across a reload.
// Nothing here is a real phone: the fake adb answers one booted emulator and a 10 x 20 grey PNG.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-phone-beside.cjs  (writes .local/verify-phone-beside/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-phone-beside');
const PORT = 4914;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-beside-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const FAKE_ADB = path.join(ROOT, 'tests', 'fixtures', 'fake-adb.mjs');

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
    ATELIER_ADB: `node "${FAKE_ADB}"`, ATELIER_EMULATOR: `node "${FAKE_ADB}"`, FAKE_ADB_CDP_PORT: String(cdp.port),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }

  // The Phone driver's fixture: a Capacitor project with a devices manifest.
  const folder = path.join(projectsDir, 'phone-probe');
  fs.mkdirSync(path.join(folder, 'android'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'android', 'README.txt'), 'The native project would be here.\n');
  fs.writeFileSync(path.join(folder, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.probe', appName: 'Phone Probe', webDir: 'src' }, null, 2));
  fs.writeFileSync(path.join(folder, 'atelier.json'), JSON.stringify({ name: 'Phone Probe', kind: 'web-app', entry: 'src/index.html', devices: { android: { avd: 'Fake_Pixel' } } }, null, 2));
  fs.writeFileSync(path.join(folder, 'src', 'index.html'), '<!doctype html>\n<button id="start" class="btn primary">Start the round now</button>\n');
  const imported = await api('POST', '/api/projects/import', { path: folder });
  const pid = imported.project.id;
  await api('PATCH', '/api/settings', { ui: { phonePanel: true } }); // the Phone tab is off unless the studio setting asks (decision row 125)
  await api('POST', `/api/projects/${pid}/activate`);

  const win = new BrowserWindow({ width: 1500, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  const resize = async (w) => { win.setContentSize(w, 900); await sleep(900); return js('window.innerWidth'); };
  const tabClick = (name) => js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === ${JSON.stringify(name)})?.click()`);
  const waitImg = () => js(`(async () => { for (let i = 0; i < 50; i++) { const im = document.querySelector('.phone-img'); if (im && !im.hidden && im.naturalWidth > 0) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  const where = () => js(`(() => {
    const side = document.querySelector('aside.stage-side');
    const im = document.querySelector('.phone-img');
    const host = document.querySelector('.phone-host');
    const line = document.querySelector('.phone-beside-line');
    return { sideHidden: side ? side.hidden : null, hasSide: document.querySelector('.preview-wrap').classList.contains('has-side'),
      inSide: !!(side && im && side.contains(im)), inTab: !!(host && im && host.contains(im)), imgs: document.querySelectorAll('.phone-img').length,
      line: line && !line.hidden ? line.textContent : null, hostBeside: host ? host.classList.contains('beside') : null, mark: im ? im.dataset.mark || null : null,
      box: document.querySelector('.phone-beside input') ? document.querySelector('.phone-beside input').checked : null };
  })()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);
  check('the window is 1500 px wide', (await js('window.innerWidth')) === 1500);

  // ---------- 1500 px, the dock on its first tab (the Phone tab never opened) ----------
  check('the image arrives', await waitImg());
  await js(`document.querySelector('.phone-img').dataset.mark = 'one'`);
  const wide = await where();
  check('wide: the screen sits in the side slot, the slot shown, the preview gives up its width', wide.inSide && wide.sideHidden === false && wide.hasSide && wide.imgs === 1, wide);
  const geo = await js(`(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { wrap: r('.preview-wrap'), side: r('aside.stage-side'), frame: r('.preview-wrap iframe'), img: r('.phone-img'), live: r('.phone-live'), cursor: getComputedStyle(document.querySelector('.phone-img')).cursor };
  })()`);
  check('the slot is 300 to 420 px wide and as tall as the preview', geo.side.w >= 300 && geo.side.w <= 420 && Math.abs(geo.side.h - geo.wrap.h) <= 1 && geo.side.r === geo.wrap.r, geo);
  check('the preview ends where the slot begins', geo.frame.r <= geo.side.l + 1, geo);
  check('the screen keeps the phone\'s ratio (twice as tall as wide) inside the stage height', Math.abs(geo.img.h - 2 * geo.img.w) <= 2 && geo.img.b <= geo.side.b && geo.img.t >= geo.side.t, geo);
  check('the live line sits under the image', geo.live.t >= geo.img.b - 1 && geo.live.b <= geo.side.b + 1, geo);
  const s1 = await js(`document.querySelector('.phone-img').getAttribute('src')`);
  await sleep(1500);
  const s2 = await js(`document.querySelector('.phone-img').getAttribute('src')`);
  check('the screen streams beside the preview with the Phone tab closed', s1 !== s2, { s1, s2 });
  await shot('a-1500-beside');

  // ---------- the Phone tab: controls, the line, a tap and Point on the moved image ----------
  await js(`window.__posts = []; (() => { const f = window.fetch; window.fetch = (u, o) => { const p = f(u, o); if (o && o.method === 'POST' && String(u).includes('/phone/')) p.then((r) => window.__posts.push({ url: String(u), body: o.body, status: r.status })); return p; }; })()`);
  await tabClick('Phone');
  await sleep(1200);
  const tab = await where();
  check('the tab keeps the controls and says "The screen is beside the preview."', tab.line === 'The screen is beside the preview.' && tab.hostBeside && !tab.inTab && tab.box === true
    && (await js(`!!document.querySelector('.phone-host .phone-actions') && !!document.querySelector('.phone-host .phone-readout')`)), tab);
  await shot('b-1500-phone-tab');
  const press = `(() => { const im = document.querySelector('.phone-img'); const b = im.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; im.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y })); im.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y })); })()`;
  await js(press);
  await sleep(800);
  const taps = await js(`window.__posts.filter((p) => p.url.includes('/phone/input')).map((p) => ({ ...JSON.parse(p.body), status: p.status }))`);
  check('a tap on the moved image posts input { tap, 5, 10 }', taps[0] && taps[0].type === 'tap' && taps[0].x === 5 && taps[0].y === 10 && taps[0].status === 200, taps);
  await js(`[...document.querySelectorAll('.phone-keys button')].find((b) => b.textContent.trim() === 'Point mode').click()`);
  const cursor = await js(`getComputedStyle(document.querySelector('.phone-img')).cursor`);
  check('Point mode\'s crosshair applies beside the preview', cursor === 'crosshair', cursor);
  await js(press);
  const point = await js(`(async () => {
    for (let i = 0; i < 40 && !/button#start/.test(document.querySelector('.phone-readout').textContent); i++) await new Promise((r) => setTimeout(r, 100));
    return { text: document.querySelector('.phone-readout').innerText, inspects: window.__posts.filter((p) => p.url.includes('/phone/inspect')).map((p) => JSON.parse(p.body)), inputs: window.__posts.filter((p) => p.url.includes('/phone/input')).length };
  })()`);
  check('Point mode on the moved image posts inspect at (5, 10) and the readout shows in the tab', point.inspects[0] && point.inspects[0].x === 5 && point.inspects[0].y === 10 && point.inputs === 1 && /button#start/.test(point.text), point);
  await shot('c-1500-point');
  await js(`document.querySelector('.phone-img').focus(); document.querySelector('.phone-img').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  const pressed = await js(`[...document.querySelectorAll('.phone-keys button')].find((b) => b.textContent.trim() === 'Point mode').getAttribute('aria-pressed')`);
  check('Esc on the moved image leaves Point mode', pressed === 'false', pressed);

  // ---------- 1200 px: back in the tab; the band ----------
  await resize(1200);
  const narrow = await where();
  check('1200: the screen is back in the tab, the slot hidden and empty, the same image node', narrow.inTab && narrow.sideHidden === true && !narrow.hasSide && narrow.line === null && narrow.mark === 'one' && narrow.imgs === 1, narrow);
  check('the readout stayed', /button#start/.test(await js(`document.querySelector('.phone-readout').innerText`)));
  await shot('d-1200-tab');
  await resize(1430);
  check('1430 from narrow: still in the tab (hysteresis)', (await where()).inTab);
  await resize(1500);
  check('1500: beside again', (await where()).inSide);
  await resize(1430);
  check('1430 from wide: still beside (hysteresis)', (await where()).inSide);
  await resize(1416);
  check('1416: back in the tab', (await where()).inTab);

  // ---------- the switch ----------
  await resize(1500);
  await js(`(() => { const b = document.querySelector('.phone-beside input'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(800);
  const off = await where();
  check('switch off at 1500: the screen is in the tab, the slot empty', off.inTab && off.sideHidden === true && off.box === false, off);
  const saved = await api('GET', `/api/projects/${pid}`);
  check('phoneBeside false is kept in project.ui, beside the other ui keys', saved.project.ui?.phoneBeside === false && 'dockTab' in (saved.project.ui || {}), saved.project.ui);
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);
  await tabClick('Phone');
  await sleep(1200);
  const reloaded = await where();
  check('after a reload at 1500 the switch is still off and the screen in the tab', reloaded.inTab && reloaded.box === false && reloaded.sideHidden === true, reloaded);
  await shot('e-1500-switch-off');
  await js(`(() => { const b = document.querySelector('.phone-beside input'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(800);
  check('switch on: beside again', (await where()).inSide);
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
