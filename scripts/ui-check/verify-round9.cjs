// Throwaway by-eye check for studio #34, #36, #37 and Room One #9 through the game template:
// a private server (temp data, own port and pid file), the real client in an offscreen Electron
// window with software rendering. Never touches the studio on 4747 or ~/.atelier.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-round9.cjs  (writes .local/verify-round9/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-round9');
const PORT = 4894;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify9-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

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

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Nine', kind: 'game', template: 'game-room-one' });
  const pid = created.project?.id || created.id;
  // a kept version with a note (force: nothing changed on disk), starred; then a build so Focus has a release
  const kept = await api('POST', `/api/projects/${pid}/versions`, { label: 'Tuning try: slightly higher jump', note: 'testing the keep flow', force: true });
  await api('PATCH', `/api/projects/${pid}/versions/${kept.id}`, { userPreferred: true });
  const built = await api('POST', `/api/projects/${pid}/build`, { notes: 'verify build' }).catch((e) => ({ error: String(e) }));
  check('build produced a release', !!(built.release || built.zip || built.id), built.error || Object.keys(built));
  // an unsaved tuning draft, so Keep version has something to say
  await api('PATCH', `/api/projects/${pid}`, { ui: { tuningDraft: { file: 'src/tuning.js', values: { jumpVelocity: 920 }, at: '2026-11-04T19:00:00.000Z' } } });

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  win.webContents.debugger.attach('1.3');
  const shot = async (name) => { await sleep(500); const { data } = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 85 }); fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(data, 'base64')); };
  await win.loadURL(`${BASE}/#workbench`);
  await sleep(2000);

  // (a) the intro card at 390x220 and 640x360 inside hidden frames, measured
  const measure = await js(`(async () => { const out = []; for (const [w, h] of [[390, 220], [640, 360], [1280, 720]]) { const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;left:0;top:0;width:' + w + 'px;height:' + h + 'px;border:0;visibility:hidden'; f.src = '/preview/${pid}/head/src/index.html?m=' + w; document.body.appendChild(f); await new Promise((r) => { f.onload = r; }); await new Promise((r) => setTimeout(r, 500)); const d = f.contentDocument; const card = d.querySelector('#help, .help, .card, [role="dialog"]'); const cb = card && card.getBoundingClientRect(); out.push({ frame: w + 'x' + h, sel: card && (card.id || card.className), w: cb && Math.round(cb.width), h: cb && Math.round(cb.height), top: cb && Math.round(cb.top), bottom: cb && Math.round(cb.bottom), fits: cb ? (cb.top >= -1 && cb.bottom <= h + 1 && cb.width <= w + 1) : null, innerScroll: card ? card.scrollHeight > card.clientHeight + 1 : null, font: card && getComputedStyle(card).fontSize }); f.remove(); } return out; })()`);
  check('intro card fits 390x220 without inner scrolling', measure[0]?.fits && !measure[0]?.innerScroll, measure);

  // (b) Side by side at 800x600: both frames stacked, the card inside each frame
  await js(`[...document.querySelectorAll('.wb-actions button')].find((b) => b.textContent === 'Side by side').click()`);
  await sleep(2500);
  const sbs = await js(`(() => { const cols = [...document.querySelectorAll('.sbs-col')]; return cols.map((c) => { const f = c.querySelector('iframe'); const fb = f.getBoundingClientRect(); let card = null; try { const el = f.contentDocument.querySelector('#help, .help, .card, [role="dialog"]'); const cb = el && el.getBoundingClientRect(); card = cb && { w: Math.round(cb.width), h: Math.round(cb.height), fitsFrame: cb.width <= fb.width + 1 && cb.height <= fb.height + 1, innerScroll: el.scrollHeight > el.clientHeight + 1 }; } catch (e) { card = String(e); } return { frame: [Math.round(fb.width), Math.round(fb.height)], card }; }); })()`);
  check('side by side at 800x600: card fits each frame', Array.isArray(sbs) && sbs.length === 2 && sbs.every((c) => c.card && c.card.fitsFrame && !c.card.innerScroll), sbs);
  await shot('a-side-by-side-800x600');
  await js(`document.querySelector('.preview-wrap dialog[open]')?.close()`);
  await sleep(400);

  // (c) the versions drawer at laptop width: note, files, one star
  win.setSize(1280, 800);
  await sleep(600);
  await js(`[...document.querySelectorAll('.versions-bar button')][0].click()`);
  await sleep(900);
  const drawer = await js(`(() => { const rows = [...document.querySelectorAll('.versions-table tbody tr')]; return rows.map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').slice(0, 220), starred: r.querySelector('.star-btn')?.getAttribute('aria-pressed'), filesTitle: [...r.querySelectorAll('[title]')].map((x) => x.title).filter((t) => /\\n|src\\//.test(t)).slice(0, 2) })); })()`);
  check('drawer: the kept version shows its note and n files, and is the only star', drawer.some((r) => /testing the keep flow/.test(r.text)) && drawer.filter((r) => r.starred === 'true').length === 1, drawer);
  await shot('c-drawer-note-files-star');
  await js(`[...document.querySelectorAll('.drawer-head button')].pop()?.click()`);
  await sleep(400);

  // (d) Keep version with an unsaved tuning draft
  await js(`[...document.querySelectorAll('.wb-actions button')].find((b) => b.textContent === 'Keep version').click()`);
  await sleep(900);
  const keep = await js(`document.querySelector('dialog[open]')?.innerText.replace(/\\s+/g, ' ')`);
  check('Keep version names Tuning > Save to file for the unsaved draft', /Save to file/.test(keep || '') && /tuning.js/.test(keep || ''), keep);
  await shot('d-keep-with-draft');
  await js(`document.querySelector('dialog[open]')?.close()`);
  await sleep(300);

  // (e) Focus lists the release
  await js(`[...document.querySelectorAll('.collab-head button')].find((b) => b.textContent === 'Focus')?.click()`);
  await sleep(900);
  const focus = await js(`(() => { const s = [...document.querySelectorAll('.focus-sec')].find((x) => /Next release/.test(x.innerText)); return s ? s.innerText.replace(/\\s+/g, ' ').slice(0, 300) : null; })()`);
  check('Focus > Next release lists the release', /zip|#1/.test(focus || '') && !/No releases yet/.test(focus || ''), focus);
  await shot('e-focus-releases');
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
