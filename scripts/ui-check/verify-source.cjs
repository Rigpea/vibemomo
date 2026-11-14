// By-eye and by-DOM check of the Source dock tab: a private studio (temp data, own port and pid file), a temp web-app
// project with src/index.html, src/app.js and a dist/ folder, the real client in an offscreen Electron window.
// Checks: Source is the tab right after Page; the tree lists dist, src and the top files with folders closed; opening
// src then index.html shows numbered lines in the mono face; a Page readout file button (Point on the preview) opens
// the file at its line with that line marked and in view; Copy beside the readout's list is a separate button; a file
// edited on disk gains the dot (through the tab's GET /changes check) and the shown text follows with its scroll kept;
// app.openSource from another view comes back to the Workbench; a narrow window stacks the columns.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-source.cjs  (writes .local/verify-source/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-source');
const PORT = 4912;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-source-'));
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

// Sixty lines of filler above the card, so the line Point finds sits below the first screen of text.
const FILLER = Array.from({ length: 60 }, (_, i) => `<!-- filler line ${i + 1} -->`).join('\n');
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Source Probe</title>
<style>body{font-family:system-ui;margin:0;background:#16181c;color:#eee} .card{background:#2a2e35;padding:24px;margin:16px;border-radius:8px}</style></head>
<body>
${FILLER}
<main>
  <h1>Source Probe</h1>
  <div class="card lantern">Lantern festival</div>
</main>
<script src="app.js"></script>
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

  const folder = path.join(projectsDir, 'source-probe');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'atelier.json'), JSON.stringify({ name: 'Source Probe', kind: 'web-app', entry: 'src/index.html' }, null, 2));
  fs.writeFileSync(path.join(folder, 'src', 'index.html'), PAGE);
  fs.writeFileSync(path.join(folder, 'src', 'app.js'), "document.querySelector('.lantern').title = 'lantern';\n");
  fs.writeFileSync(path.join(folder, 'dist', 'notes.txt'), 'authored, not built\n');
  const imported = await api('POST', '/api/projects/import', { path: folder });
  const pid = imported.project.id;
  await api('POST', `/api/projects/${pid}/activate`);

  const win = new BrowserWindow({ width: 1366, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  const until = (expr, ms = 10000) => js(`(async () => { for (let i = 0; i < ${Math.ceil(ms / 100)}; i++) { try { const v = (${expr}); if (v) return (typeof v === 'object' && v.nodeType) || typeof v === 'function' ? true : v; } catch {} await new Promise((r) => setTimeout(r, 100)); } return null; })()`);
  const clickTab = (name) => js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}))?.click()`);
  const rows = () => js(`[...document.querySelectorAll('.source-item')].map((r) => ({ path: r.dataset.path, expanded: r.getAttribute('aria-expanded'), dot: !!r.querySelector('.source-dot'), dotTitle: r.querySelector('.source-dot')?.title || null }))`);
  const clickRow = (p) => js(`document.querySelector('.source-item[data-path=${JSON.stringify(p)}]')?.click()`);
  const fileState = () => js(`(() => { const t = document.querySelector('.source-text'); const m = document.querySelector('.source-mark'); const g = document.querySelector('.source-gutter'); const c = document.querySelector('.source-code'); return {
    path: document.querySelector('.source-path')?.textContent, meta: document.querySelector('.source-path-meta')?.textContent, note: document.querySelector('.source-note')?.textContent,
    hidden: t?.hidden, lines: g?.textContent.split('\\n').length, font: c ? getComputedStyle(c).fontFamily : null, lineHeight: c ? getComputedStyle(c).lineHeight : null,
    mark: m && !m.hidden ? { line: m.dataset.line, top: m.offsetTop } : null, scrollTop: t?.scrollTop, boxHeight: t?.clientHeight, code: c?.textContent };
  })()`);
  const frameDoc = `document.querySelector('.preview-wrap iframe').contentDocument`;
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);

  // ---------- the tab and the tree ----------
  const tabs = await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].map((t) => t.dataset.kind)`);
  check('Source is the band tab right after Claude Code (the Page panel is the left column)', tabs.indexOf('source') === tabs.indexOf('companion') + 1 && !tabs.includes('page'), tabs);
  await clickTab('Source');
  await until(`document.querySelectorAll('.source-item').length >= 3`);
  const top = await rows();
  check('the tree lists dist and src (closed) with atelier.json at the top', JSON.stringify(top.slice(0, 2).map((r) => [r.path, r.expanded])) === JSON.stringify([['dist', 'false'], ['src', 'false']]) && top.some((r) => r.path === 'atelier.json'), top);
  check('.studio and .git are not listed', !top.some((r) => r.path.startsWith('.studio') || r.path.startsWith('.git')), top.map((r) => r.path));
  await clickRow('src');
  await until(`document.querySelector('.source-item[data-path="src/index.html"]')`);
  const opened = await rows();
  check('opening src lists src/app.js and src/index.html under it', ['src/app.js', 'src/index.html'].every((p) => opened.some((r) => r.path === p)), opened.map((r) => r.path));
  await clickRow('src/index.html');
  await until(`document.querySelector('.source-path')?.textContent === 'src/index.html' && !document.querySelector('.source-text').hidden`);
  const shown = await fileState();
  const want = PAGE.split('\n').length - 1; // the final newline is not a line
  check('the file shows numbered lines in the mono face at 20 px a line', shown.lines === want && /Cascadia|Consolas|mono/i.test(shown.font || '') && shown.lineHeight === '20px', { lines: shown.lines, want, font: shown.font, lineHeight: shown.lineHeight });
  check('no line is marked when a file is opened from the tree', shown.mark === null, shown.mark);
  await shot('a-source-tab');

  // ---------- a Page readout file button opens it at the line ----------
  await clickTab('Page');
  await until(`document.querySelector('.page-head button')`);
  await js(`[...document.querySelectorAll('.page-head button')].find((b) => b.textContent.trim() === 'Point').click()`);
  await js(`${frameDoc}.querySelector('.lantern').click()`);
  const ref = await until(`[...document.querySelectorAll('.page-readout button')].map((b) => b.textContent.trim()).find((t) => /^src\\/index\\.html:\\d+$/.test(t))`, 8000);
  check('Point reads the card with a src/index.html:line candidate', !!ref, ref);
  check('Copy sits beside the readout\'s list as its own button', (await js(`[...document.querySelectorAll('.page-readout .phone-files button')].some((b) => b.textContent.trim() === 'Copy')`)) === true, null);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await js(`[...document.querySelectorAll('.page-readout button')].find((b) => b.textContent.trim() === ${JSON.stringify(ref || '')})?.click()`);
  const line = Number(String(ref || '').split(':')[1]);
  await until(`document.querySelector('.dock-tabs [role="tab"][data-kind="source"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('.source-mark') && !document.querySelector('.source-mark').hidden`, 6000);
  const atLine = await fileState();
  const inView = atLine.mark && atLine.mark.top >= atLine.scrollTop && atLine.mark.top + 20 <= atLine.scrollTop + atLine.boxHeight;
  check('the file button opens the Source tab at that line, marked and in view', atLine.path === 'src/index.html' && atLine.mark?.line === String(line) && inView && atLine.meta.startsWith(`line ${line}`), atLine.mark ? { mark: atLine.mark, scrollTop: atLine.scrollTop, boxHeight: atLine.boxHeight, meta: atLine.meta } : atLine);
  await shot('b-opened-at-line');

  // ---------- a file edited on disk gains the dot ----------
  await js(`document.querySelector('.source-text').scrollTop = 200`);
  fs.appendFileSync(path.join(folder, 'src', 'index.html'), '<!-- edited on disk -->\n');
  await js(`window.dispatchEvent(new Event('focus'))`); // back from an editor; the 5 s check would find it too
  const dotted = await until(`document.querySelector('.source-item[data-path="src/index.html"] .source-dot')?.title`, 12000);
  check('the edited file gains a dot titled changed since #n, and its folder one', /^changed since #\d+$/.test(dotted || '') && !!(await js(`document.querySelector('.source-item[data-path="src"] .source-dot')`)), dotted);
  const followed = await until(`document.querySelector('.source-code').textContent.includes('edited on disk')`, 8000);
  const after = await fileState();
  check('the shown text follows the edit and keeps its scroll', !!followed && Math.abs(after.scrollTop - 200) <= 1 && /changed since #\d+/.test(after.meta || ''), { scrollTop: after.scrollTop, meta: after.meta });
  await shot('c-changed-dot');

  // ---------- openSource from another view ----------
  await js(`location.hash = '#/tasks'`);
  await sleep(800);
  await js(`window.atelier.openSource({ path: 'src/app.js', line: 1 })`);
  const back = await until(`location.hash === '#/workbench' && document.querySelector('.source-path')?.textContent === 'src/app.js' && document.querySelector('.source-mark')?.dataset.line === '1'`, 8000);
  check('app.openSource from the Tasks view comes back to the Workbench and opens the file', !!back, await js(`({ hash: location.hash, path: document.querySelector('.source-path')?.textContent })`));

  // ---------- keys ----------
  await js(`document.querySelector('.source-item[data-path="src/app.js"]').focus()`);
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
  check('Tab from the tree moves to the text', (await js(`document.activeElement === document.querySelector('.source-text')`)) === true, await js(`document.activeElement?.className`));

  // ---------- narrow ----------
  win.setContentSize(1000, 760);
  await sleep(900);
  const narrow = await js(`(() => { const host = document.querySelector('.source-host'); return { width: host.clientWidth, stacked: document.querySelector('.source-cols').classList.contains('stacked') }; })()`);
  check('under 640 px the tree sits above the text', narrow.width < 640 ? narrow.stacked : !narrow.stacked, narrow);
  await shot('d-narrow');
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
