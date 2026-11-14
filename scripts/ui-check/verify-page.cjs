// By-eye and by-DOM check of the Page dock tab: a private studio (temp data, own port and pid file), a temp web-app
// project whose entry holds two data-screen sections routed by hash, the real client in an offscreen Electron window.
// Checks: Page is the tab right after Companion; the pages read "Home 01", "Events 02" with the visible one marked;
// a page row opens its screen by hash and the mark follows; a part selected in On this screen is outlined on the
// preview within 2 px of the part's box, with its label, and deselecting removes the outline; Point reads a clicked
// element with a file candidate and the click does not reach the page; Pin adds a preview pin; the aura is saved in
// project.ui.pages; the footer line; a narrow window stacks the columns.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-page.cjs  (writes .local/verify-page/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-page');
const PORT = 4905;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-page-'));
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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 150000);

app.disableHardwareAcceleration();

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page Probe</title>
<style>body{font-family:system-ui;margin:0;background:#16181c;color:#eee} header{padding:16px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:16px;list-style:none;margin:0} .card{background:#2a2e35;padding:24px;border-radius:8px} .spacer{height:900px}</style></head>
<body>
<section class="screen" data-screen="home">
  <header class="top"><h1>Home</h1></header>
  <ul id="event-grid" class="grid" aria-label="Event grid">
    <li class="card lantern">Lantern festival</li>
    <li class="card">Night market</li>
    <li class="card">River walk</li>
  </ul>
  <div class="spacer"></div>
  <nav aria-label="Navigation"><a href="#events">Events</a></nav>
</section>
<section class="screen" data-screen="events" hidden>
  <h1>Events</h1>
  <p>All of them.</p>
</section>
<script>
  window.clicks = 0;
  document.addEventListener('click', () => { window.clicks++; });
  const show = () => { const want = location.hash.slice(1) || 'home'; for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== want; };
  addEventListener('hashchange', show); show();
</script>
</body></html>
`;

async function main() {
  const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }

  const folder = path.join(projectsDir, 'page-probe');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'atelier.json'), JSON.stringify({ name: 'Page Probe', kind: 'web-app', entry: 'src/index.html' }, null, 2));
  fs.writeFileSync(path.join(folder, 'src', 'index.html'), PAGE);
  fs.writeFileSync(path.join(folder, 'src', 'about.html'), '<!doctype html><h1>About</h1>\n');
  const imported = await api('POST', '/api/projects/import', { path: folder });
  const pid = imported.project.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const ui = async () => (await api('GET', `/api/projects/${pid}`)).project.ui || {};

  const win = new BrowserWindow({ width: 1366, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  const until = (expr, ms = 10000) => js(`(async () => { for (let i = 0; i < ${Math.ceil(ms / 100)}; i++) { try { const v = (${expr}); if (v) return (typeof v === 'object' && v.nodeType) || typeof v === 'function' ? true : v; } catch {} await new Promise((r) => setTimeout(r, 100)); } return null; })()`);
  const clickTab = (name) => js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}))?.click()`);
  const rows = () => js(`[...document.querySelectorAll('.page-row')].map((r) => ({ name: r.querySelector('.page-name').textContent, n: r.querySelector('.page-n').textContent, current: r.getAttribute('aria-current') }))`);
  const frameDoc = `document.querySelector('.preview-wrap iframe').contentDocument`;
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);

  // ---------- the tab and the pages ----------
  const tabs = await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].map((t) => t.textContent.trim())`);
  const column = await js(`(() => { const l = document.querySelector('.wb-left'); return { head: l?.querySelector('.left-head')?.textContent.trim(), tab: !!l?.querySelector('.page-tab'), pages: l?.querySelectorAll('.page-row').length || 0 }; })()`);
  check('the Page panel is the left column, not a band tab', column.tab && /^Project/.test(column.head || '') && !tabs.some((t) => t.startsWith('Page')), { column, tabs });
  await until(`document.querySelectorAll('.page-row').length >= 2`);
  const first = await rows();
  check('the pages read Home 01, Events 02, then about.html 03', JSON.stringify(first.map((r) => [r.name, r.n])) === JSON.stringify([['Home', '01'], ['Events', '02'], ['about.html', '03']]), first);
  check('the visible page (Home) is marked', first[0]?.current === 'page' && first[1]?.current === 'false', first);
  check('the column head counts the pages', (await js(`document.querySelector('.left-count')?.textContent.trim()`)) === '3 pages', await js(`document.querySelector('.left-head')?.textContent`));
  const footer = await js(`document.querySelector('.page-footer')?.textContent`);
  check('the footer says preview, version or files on disk, width and verified or not', /^Preview · (#\d+|files on disk) · \d+ px · (verified|not verified)$/.test(footer || ''), footer);
  await shot('a-page-tab');

  // ---------- a page by hash ----------
  await js(`[...document.querySelectorAll('.page-row')][1].click()`);
  const moved = await until(`document.querySelectorAll('.page-row')[1]?.getAttribute('aria-current') === 'page'`, 3000);
  check('a page row opens its screen by hash and the mark follows', !!moved && (await js(`${frameDoc}.location.hash`)) === '#events', await rows());
  await js(`[...document.querySelectorAll('.page-row')][0].click()`);
  await until(`document.querySelectorAll('.page-row')[0]?.getAttribute('aria-current') === 'page'`, 3000);

  // ---------- a part outlined ----------
  const parts = await js(`[...document.querySelectorAll('.page-part')].map((b) => b.firstChild.textContent)`);
  check('On this screen lists Home, Event grid and Navigation', ['Home', 'Event grid', 'Navigation'].every((n) => parts.includes(n)), parts);
  await js(`[...document.querySelectorAll('.page-part')].find((b) => b.firstChild.textContent === 'Event grid').click()`);
  await sleep(300);
  const boxes = await js(`(() => { const d = ${frameDoc}; const o = d.getElementById('atelier-page-outline'); const g = d.getElementById('event-grid'); if (!o) return null; const a = o.getBoundingClientRect(), b = g.getBoundingClientRect(); return { o: [a.left, a.top, a.width, a.height], g: [b.left, b.top, b.width, b.height], label: o.textContent, events: getComputedStyle(o).pointerEvents }; })()`);
  check('the selected part is outlined within 2 px of its box, with "Event grid selected" and pointer-events none',
    !!boxes && boxes.o.every((v, i) => Math.abs(v - boxes.g[i]) <= 2) && boxes.label === 'Event grid selected' && boxes.events === 'none', boxes);
  await shot('b-part-outlined');
  await js(`${frameDoc}.defaultView.scrollTo(0, 300)`);
  await sleep(300);
  const scrolled = await js(`(() => { const d = ${frameDoc}; const a = d.getElementById('atelier-page-outline').getBoundingClientRect(), b = d.getElementById('event-grid').getBoundingClientRect(); return Math.abs(a.top - b.top); })()`);
  check('the outline stays on the part after a scroll', scrolled <= 2, scrolled);
  await js(`${frameDoc}.defaultView.scrollTo(0, 0)`);
  await js(`[...document.querySelectorAll('.page-part')].find((b) => b.firstChild.textContent === 'Event grid').click()`);
  await sleep(200);
  check('a second click deselects and removes the outline', (await js(`!${frameDoc}.getElementById('atelier-page-outline')`)) === true, null);

  // ---------- Point ----------
  await js(`[...document.querySelectorAll('.page-head button')].find((b) => b.textContent.trim() === 'Point').click()`);
  await js(`${frameDoc}.querySelector('.lantern').click()`);
  const read = await until(`[...document.querySelectorAll('.page-readout button')].map((b) => b.textContent.trim()).find((t) => /^src\\/index\\.html:\\d+$/.test(t))`, 8000);
  check('Point reads the clicked element with a file candidate', !!read && /li\.card\.lantern/.test(await js(`document.querySelector('.page-readout').textContent`)), await js(`document.querySelector('.page-readout')?.innerText`));
  check('the click under Point did not reach the page', (await js(`${frameDoc}.defaultView.clicks`)) === 0, await js(`${frameDoc}.defaultView.clicks`));
  await js(`[...document.querySelectorAll('.page-readout button')].find((b) => b.textContent.trim() === 'Pin').click()`);
  await sleep(800);
  const pins = (await api('GET', `/api/projects/${pid}/companion/pins`)).pins;
  check('Pin adds a preview pin with no device point', pins.length === 1 && pins[0].source === 'preview' && pins[0].point === null && pins[0].pageKey === 'index.html#home', pins);
  await shot('c-point-readout');
  await js(`${frameDoc}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  check('Esc leaves Point', (await js(`[...document.querySelectorAll('.page-head button')].find((b) => b.textContent.trim() === 'Point').getAttribute('aria-pressed')`)) === 'false', null);

  // ---------- the aura ----------
  await js(`(() => { const t = document.querySelector('.page-aura textarea'); t.value = 'calm, a little playful'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`[...document.querySelectorAll('.page-aura button')].find((b) => b.textContent.trim() === 'Save').click()`);
  await sleep(800);
  const saved = await ui();
  check('the aura is saved in project.ui.pages under the page key, and the page in view is remembered', saved.pages?.['index.html#home']?.aura === 'calm, a little playful' && saved.pageInView?.key === 'index.html#home', { pages: saved.pages, pageInView: saved.pageInView });
  await shot('d-aura');

  // ---------- narrow ----------
  win.setContentSize(1000, 760);
  await sleep(900);
  const narrow = await js(`(() => { const left = document.querySelector('.wb-left'); const btn = [...document.querySelectorAll('.stage-head button')].find((b) => b.textContent.trim() === 'Pages'); return { width: innerWidth, hidden: getComputedStyle(left).display === 'none', button: !!btn }; })()`);
  check('under 1100 px the column steps aside and the stage head offers Pages', narrow.hidden && narrow.button, narrow);
  await js(`[...document.querySelectorAll('.stage-head button')].find((b) => b.textContent.trim() === 'Pages').click()`);
  await sleep(400);
  const opened = await js(`(() => { const left = document.querySelector('.wb-left'); const cols = document.querySelector('.page-cols'); return { shown: getComputedStyle(left).display !== 'none', over: getComputedStyle(left).position === 'absolute', tracks: getComputedStyle(cols).gridTemplateColumns.trim().split(/\\s+/).length, rows: document.querySelectorAll('.page-row').length }; })()`);
  check('Pages opens the column over the stage with the pages and the parts stacked', opened.shown && opened.over && opened.tracks === 1 && opened.rows === 3, opened);
  await shot('e-narrow');
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
