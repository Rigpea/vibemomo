// By-eye and by-DOM check of arranging the dock (client/components/dock.js, ./dock-arrange.js): a private studio on
// a temp port with a temp web-app project (dock tabs Companion, Page, Source, Terminal, Devices) in an offscreen
// Electron window 1500 px wide. A pointer drag reorders the tabs and the order survives a reload; a drag onto the
// stage fills the side slot with the Page panel and marks its tab; dragging the slot's head back returns it; Alt+Arrow
// moves a tab; Reset arrangement puts the defaults back; at 1200 px a kept slot empties into the dock.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-dock-arrange.cjs  (writes .local/verify-dock-arrange/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-dock-arrange');
const PORT = 4916;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-arrange-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 180000);

app.disableHardwareAcceleration();

async function main() {
  const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }

  const folder = path.join(projectsDir, 'arrange-probe');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'atelier.json'), JSON.stringify({ name: 'Arrange Probe', kind: 'web-app', entry: 'src/index.html' }, null, 2));
  fs.writeFileSync(path.join(folder, 'src', 'index.html'), '<!doctype html>\n<h1 id="title">Arrange probe</h1>\n<p>One page to read.</p>\n');
  const imported = await api('POST', '/api/projects/import', { path: folder });
  const pid = imported.project.id;
  await api('POST', `/api/projects/${pid}/activate`);

  const win = new BrowserWindow({ width: 1500, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  const resize = async (w) => { win.setContentSize(w, 900); await sleep(900); return js('window.innerWidth'); };
  const order = () => js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].map((t) => t.dataset.kind)`);
  const ui = async () => (await api('GET', `/api/projects/${pid}`)).project.ui || {};
  /** A real pointer drag: down on the source element, moves in steps on the document, up at (x, y). to: a selector
   *  whose box centre is the target, or { x, y }. */
  const drag = (fromSel, to) => js(`(async () => {
    const from = document.querySelector(${JSON.stringify(fromSel)});
    const b = from.getBoundingClientRect();
    const sx = b.left + b.width / 2, sy = b.top + b.height / 2;
    const tgt = ${JSON.stringify(to)};
    const t = typeof tgt === 'string' ? document.querySelector(tgt).getBoundingClientRect() : null;
    const x = t ? t.left + t.width / 2 : tgt.x, y = t ? t.top + t.height / 2 : tgt.y;
    const ev = (type, cx, cy) => new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, clientX: cx, clientY: cy });
    from.dispatchEvent(ev('pointerdown', sx, sy));
    for (let i = 1; i <= 8; i++) { document.dispatchEvent(ev('pointermove', sx + (x - sx) * i / 8, sy + (y - sy) * i / 8)); await new Promise((r) => setTimeout(r, 16)); }
    const during = { line: !document.querySelector('.dock-drop-line').hidden, target: document.querySelector('.side-drop')?.textContent || null };
    document.dispatchEvent(ev('pointerup', x, y));
    from.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return during;
  })()`);
  const tabSel = (kind) => `.dock-tabs [role="tab"][data-kind="${kind}"]`;
  const side = () => js(`(() => {
    const s = document.querySelector('aside.stage-side');
    const r = s.getBoundingClientRect();
    return { hidden: s.hidden, hasSide: document.querySelector('.preview-wrap').classList.contains('has-side'), head: s.querySelector('.side-head:not([hidden]) .side-name')?.textContent || null,
      panel: !!s.querySelector('.wbp-host'), pageTree: !!s.querySelector('.wbp-host') && s.querySelector('.wbp-host').innerText.length > 0, w: Math.round(r.width), h: Math.round(r.height),
      marks: [...document.querySelectorAll('.dock-tabs .tab-side')].map((m) => m.closest('[role="tab"]').dataset.kind), away: document.querySelector('.dock-away:not([hidden])')?.textContent || null };
  })()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);
  check('the window is 1500 px wide', (await js('window.innerWidth')) === 1500);
  const first = await order();
  check('the default order', JSON.stringify(first) === JSON.stringify(['companion', 'codex', 'source', 'terminal', 'web-app']), first);
  check('no Reset arrangement before anything is arranged', !(await js(`[...document.querySelectorAll('.dock-tabs button')].some((b) => b.textContent.trim() === 'Reset arrangement')`)));
  await shot('a-default');

  // ---------- a pointer drag reorders, the click after the drop is not a selection ----------
  const selBefore = await js(`document.querySelector('.dock-tabs [aria-selected="true"]')?.dataset.kind`);
  const d1 = await drag(tabSel('source'), { x: await js(`(() => { const b = document.querySelector('${tabSel('terminal')}').getBoundingClientRect(); return b.right - 4; })()`), y: await js(`document.querySelector('${tabSel('terminal')}').getBoundingClientRect().top + 10`) });
  check('the drop line shows during the drag', d1.line, d1);
  const o1 = await order();
  check('Source dropped after Terminal', JSON.stringify(o1) === JSON.stringify(['companion', 'codex', 'terminal', 'source', 'web-app']), o1);
  check('the active tab did not change', (await js(`document.querySelector('.dock-tabs [aria-selected="true"]')?.dataset.kind`)) === selBefore, selBefore);
  await sleep(500);
  const u1 = await ui();
  check('dockOrder is saved in project.ui', JSON.stringify(u1.dockOrder) === JSON.stringify(o1), u1);
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);
  const o2 = await order();
  check('the order survives a reload', JSON.stringify(o2) === JSON.stringify(o1), o2);
  await shot('b-reordered');

  // ---------- Alt+Arrow ----------
  await js(`document.querySelector('${tabSel('web-app')}').focus(); document.querySelector('${tabSel('web-app')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }))`);
  await sleep(200);
  const o3 = await order();
  const said = await js(`document.querySelector('.dock-live').textContent`);
  check('Alt+Left moves Devices one place and says so', o3[2] === 'web-app' && said === 'Devices moved before Source', { o3, said });

  // ---------- onto the stage ----------
  await js(`document.querySelector('${tabSel('source')}').click()`);
  await sleep(800);
  const d2 = await drag(tabSel('source'), '.preview-wrap iframe');
  check('over the stage the slot shows "Beside the preview"', /^Beside the preview/.test(d2.target || ''), d2);
  await sleep(800);
  const s1 = await side();
  check('the Source panel fills the side slot with its head, the tab carries the mark, the band says where it went',
    !s1.hidden && s1.hasSide && s1.panel && s1.head === 'Source' && JSON.stringify(s1.marks) === '["source"]' && s1.away === 'Source is beside the preview.' && s1.w >= 300 && s1.w <= 420, s1);
  check('stageSide is saved', (await ui()).stageSide === 'source');
  await shot('c-source-beside');

  // ---------- the width rule ----------
  await resize(1200);
  const s2 = await side();
  check('1200: the slot empties into the dock, stageSide kept', s2.hidden && !s2.panel && (await ui()).stageSide === 'source', s2);
  await resize(1500);
  check('1500: beside again', (await side()).panel);

  // ---------- back to the tabs by the slot's head ----------
  await drag('.side-head .side-handle', tabSel('companion'));
  await sleep(500);
  const s3 = await side();
  check('dragged back: the slot is empty and hidden, no mark', s3.hidden && !s3.panel && s3.marks.length === 0 && s3.away === null, s3);
  check('stageSide cleared', (await ui()).stageSide == null);
  await shot('d-back');

  // ---------- Reset ----------
  await drag(tabSel('terminal'), '.preview-wrap iframe');
  await sleep(500);
  await js(`[...document.querySelectorAll('.dock-tabs button')].find((b) => b.textContent.trim() === 'Reset arrangement').click()`);
  await sleep(800);
  const o4 = await order();
  const s4 = await side();
  const toastText = await js(`[...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | ')`);
  check('Reset: the default order, the slot empty, one toast', JSON.stringify(o4) === JSON.stringify(first) && s4.hidden && /Dock arrangement reset/.test(toastText), { o4, s4, toastText });
  const u4 = await ui();
  check('dockOrder and stageSide are cleared', u4.dockOrder == null && u4.stageSide == null, u4);
  await shot('e-reset');
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
