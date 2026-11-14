// By-eye and by-DOM check of the Phone panel: a private studio (temp data, own port and pid file) with
// ATELIER_ADB and ATELIER_EMULATOR set to tests/fixtures/fake-adb.mjs and a fake WebView DevTools endpoint (tests/fixtures/fake-cdp.mjs),
// a temp Capacitor project (capacitor.config.json and an android/ folder) imported into it, the real client in an
// offscreen Electron window. Checks the Phone tab, the chips, the screenshot image loading, a tap posting input,
// Point mode's readout and Esc, the layout beside and below, and the iPhone line once the project gains ios/.
// Nothing here is a real phone: the fake adb answers one booted emulator and a 10 x 20 grey PNG.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-phone.cjs  (writes .local/verify-phone/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-phone');
const PORT = 4902;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-phone-'));
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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 150000);

app.disableHardwareAcceleration();

async function main() {
  const { startFakeCdp } = await import(pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'fake-cdp.mjs')).href);
  cdp = await startFakeCdp();
  // The system node runs the fake adb, as the server is run (process.execPath here is electron.exe).
  const env = {
    ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '',
    // The emulator is the same fake command: the tools chip asks only whether it is found, and nothing here boots.
    ATELIER_ADB: `node "${FAKE_ADB}"`, ATELIER_EMULATOR: `node "${FAKE_ADB}"`, FAKE_ADB_CDP_PORT: String(cdp.port),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }

  // A Capacitor project: capacitor.config.json, an android/ folder and the web page the inspect search reads.
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
  const bundle = await api('GET', `/api/projects/${pid}`);
  check('the bundle\'s manifest names devices.android with the Capacitor app id', bundle.manifest?.devices?.android?.appId === 'com.example.probe', bundle.manifest?.devices);

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);

  const tabs = await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].map((t) => t.textContent.trim())`);
  check('the dock offers a Phone tab', tabs.includes('Phone'), tabs);
  // Every POST the page sends to the phone routes, with the answer's status.
  await js(`window.__posts = []; (() => { const f = window.fetch; window.fetch = (u, o) => { const p = f(u, o); if (o && o.method === 'POST' && String(u).includes('/phone/')) p.then((r) => window.__posts.push({ url: String(u), body: o.body, status: r.status })); return p; }; })()`);
  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === 'Phone')?.click()`);
  await sleep(2500);

  const chips = await js(`[...document.querySelectorAll('.phone-chips [data-chip]')].map((c) => ({ key: c.dataset.chip, text: c.textContent, label: c.getAttribute('aria-label') }))`);
  const chipText = Object.fromEntries(chips.map((c) => [c.key, c.text]));
  check('four chips from the fake adb: tools found, booted Fake_Pixel, app running, build idle',
    chipText.tools === 'Tools found' && chipText.device === 'Booted · Fake_Pixel' && chipText.app === 'App running' && chipText.build === 'Build idle', chips);
  check('every chip has an accessible name', chips.length === 4 && chips.every((c) => /^(Tools|Device|App|Build): /.test(c.label || '')), chips.map((c) => c.label));
  const buttons = await js(`Object.fromEntries([...document.querySelectorAll('.phone-actions button')].map((b) => [b.textContent.trim(), { disabled: b.disabled, title: b.title }]))`);
  check('Boot is off (already up), Build and install, Launch and Stop are on', buttons.Boot?.disabled === true && buttons['Build and install']?.disabled === false && buttons.Launch?.disabled === false && buttons.Stop?.disabled === false, buttons);

  const img = await js(`(async () => {
    for (let i = 0; i < 40; i++) { const im = document.querySelector('.phone-img'); if (im && !im.hidden && im.naturalWidth > 0) break; await new Promise((r) => setTimeout(r, 100)); }
    const im = document.querySelector('.phone-img');
    const box = im.getBoundingClientRect();
    const side = document.querySelector('.phone-side').getBoundingClientRect();
    return { hidden: im.hidden, src: im.getAttribute('src'), natural: [im.naturalWidth, im.naturalHeight], box: [Math.round(box.width), Math.round(box.height)], beside: side.left >= box.right, label: im.getAttribute('aria-label'), tab: im.tabIndex, live: document.querySelector('.phone-live').textContent };
  })()`);
  check('the screenshot image loads from the route at the fake PNG\'s 10 x 20', !img.hidden && /\/phone\/screenshot\?t=\d+$/.test(img.src || '') && img.natural[0] === 10 && img.natural[1] === 20, img);
  check('drawn at its ratio (twice as tall as wide, within a pixel) with the controls beside it', Math.abs(img.box[1] - 2 * img.box[0]) <= 2 && img.box[1] > 150 && img.beside, img);
  check('the image is focusable and named after the device', img.tab === 0 && /^Screen of Fake_Pixel \(emulator-5554\)/.test(img.label || ''), img.label);
  const srcLater = await (async () => { await sleep(1200); return js(`document.querySelector('.phone-img').getAttribute('src')`); })();
  check('the image reloads while the panel is visible', srcLater !== img.src, { before: img.src, after: srcLater });
  const live = await js(`document.querySelector('.phone-live').textContent`);
  check('the live line says what the screen is', /^Live, about [\d.]+ frames? a second: still screenshots from the device, not video$/.test(live), live);
  await shot('a-phone-panel');

  // A tap at the image's centre: the fake screen is 10 x 20, so the centre is (5, 10) in device pixels.
  const press = (dx, dy) => `(() => { const im = document.querySelector('.phone-img'); const b = im.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; im.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y })); im.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: x + ${dx}, clientY: y + ${dy} })); })()`;
  await js(press(0, 0));
  await sleep(800);
  const posts = await js(`window.__posts.filter((p) => p.url.includes('/phone/input'))`);
  const tap = posts[0] ? JSON.parse(posts[0].body) : null;
  check('a tap on the image posts input { tap, 5, 10 } and the route answers 200', tap && tap.type === 'tap' && tap.x === 5 && tap.y === 10 && posts[0].status === 200, posts);
  await js(press(0, -60));
  await sleep(800);
  const swipe = await js(`window.__posts.filter((p) => p.url.includes('/phone/input')).map((p) => JSON.parse(p.body))[1] || null`);
  check('a drag posts a swipe with a duration', swipe && swipe.type === 'swipe' && swipe.y2 < swipe.y && Number.isInteger(swipe.ms), swipe);

  // Point mode
  await js(`[...document.querySelectorAll('.phone-keys button')].find((b) => b.textContent.trim() === 'Point mode').click()`);
  await js(press(0, 0));
  const readout = await js(`(async () => {
    for (let i = 0; i < 40 && !/button#start/.test(document.querySelector('.phone-readout').textContent); i++) await new Promise((r) => setTimeout(r, 100));
    const r = document.querySelector('.phone-readout');
    return { text: r.innerText, files: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()), inputs: window.__posts.filter((p) => p.url.includes('/phone/input')).length, inspects: window.__posts.filter((p) => p.url.includes('/phone/inspect')).map((p) => JSON.parse(p.body)) };
  })()`);
  check('Point mode posts inspect at the tap and nothing to input', readout.inputs === 2 && readout.inspects.length === 1 && readout.inspects[0].x === 5 && readout.inspects[0].y === 10, readout);
  check('the readout names the element, its text, the page and src/index.html:2', /button#start\.btn\.primary/.test(readout.text) && /Start the round now/.test(readout.text) && /https:\/\/localhost\/#\/start/.test(readout.text) && readout.files.includes('src/index.html:2') && readout.files.includes('Copy for a task'), readout);
  await shot('b-point-mode');
  await js(`document.querySelector('.phone-img').focus(); document.querySelector('.phone-img').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  const after = await js(`({ pressed: [...document.querySelectorAll('.phone-keys button')].find((b) => b.textContent.trim() === 'Point mode').getAttribute('aria-pressed'), inputs: window.__posts.filter((p) => p.url.includes('/phone/input')).length })`);
  check('Esc leaves Point mode and is not sent as Back', after.pressed === 'false' && after.inputs === 2, after);

  // Narrow: the controls go below the screen.
  win.setContentSize(900, 760);
  await sleep(800);
  const narrow = await js(`(() => { const host = document.querySelector('.phone-host'); const im = document.querySelector('.phone-img').getBoundingClientRect(); const side = document.querySelector('.phone-side').getBoundingClientRect(); return { hostWidth: host.clientWidth, below: side.top >= im.bottom - 1, beside: side.left >= im.right }; })()`);
  check('on a narrow panel (520 px or less) the controls sit below the screen, otherwise beside', narrow.hostWidth <= 520 ? narrow.below : narrow.beside, narrow);
  await shot('c-narrow');
  win.setContentSize(1366, 768);
  await sleep(500);

  // The iPhone line: the project gains ios/; the next status poll (5 s) brings the stub's reason.
  fs.mkdirSync(path.join(folder, 'ios'), { recursive: true });
  const ios = await js(`(async () => { for (let i = 0; i < 80; i++) { const l = document.querySelector('.phone-ios'); if (l && !l.hidden) return { text: l.textContent, kids: l.children.length }; await new Promise((r) => setTimeout(r, 100)); } return null; })()`);
  check('with ios/ the iPhone line states its reason, text only, no frame', ios && /^iPhone: The iPhone simulator runs only on macOS/.test(ios.text) && ios.kids === 0, ios);
  const imgs = await js(`document.querySelectorAll('.phone img').length`);
  check('one screen image only: nothing drawn for the iPhone', imgs === 1, imgs);
  await shot('d-iphone-line');

  // Hidden tab: no screenshot requests while another tab shows.
  const others = tabs.filter((t) => t !== 'Phone');
  if (others.length) {
    await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === ${JSON.stringify(others[0])}).click()`);
    await sleep(600);
    const a = await js(`document.querySelector('.phone-img').getAttribute('src')`);
    await sleep(1500);
    const b = await js(`document.querySelector('.phone-img').getAttribute('src')`);
    check('with another tab shown the screen stops reloading', a === b, { a, b });
  }
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
