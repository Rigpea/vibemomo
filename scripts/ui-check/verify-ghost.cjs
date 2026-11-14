// By-eye and by-DOM check of the ghost marker (client/components/ghost.js): a private studio (temp data, own port and
// pid file), two temp web-app projects, each with a real console session record (POST /api/console/sessions writes the
// record and spawns nothing), a preview pin on the first project's event grid naming its stylesheet, the real client in
// an offscreen Electron window. The session's tool calls are stub console events fed through app.emit('console', …) in
// the page (window.atelier), since the server has no test hook that sends console.* events.
// Checks: another project's session draws nothing; an Edit of the page's stylesheet shows the label in the preview's
// corner with who, the file, how long ago and "on this page", the live dot and Reload the preview; the frame was not
// reloaded by itself; the pin's part gets the soft outline within 2 px of its box at half strength; an Edit of a
// sibling page dots its Page row with "edited by Claude Code · …"; a Bash call reads "Claude Code · running npm run
// check"; Reload loads the frame again, after which the outline, the dot and the button are gone; a project switch
// clears the marker. The phone's label needs a device and is covered on stubs only (tests/ghost.test.mjs).
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-ghost.cjs  (writes .local/verify-ghost/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-ghost');
const PORT = 4907;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-ghost-'));
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
<html lang="en"><head><meta charset="utf-8"><title>Ghost Probe</title><link rel="stylesheet" href="style.css"></head>
<body>
<section class="screen" data-screen="home">
  <header class="top"><h1>Home</h1></header>
  <ul id="event-grid" class="grid" aria-label="Event grid"><li class="card">Lantern festival</li><li class="card">Night market</li></ul>
</section>
</body></html>
`;
const CSS = 'body{font-family:system-ui;margin:0;background:#16181c;color:#eee}\nheader{padding:16px}\n.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:16px;list-style:none;margin:0}\n.card{background:#2a2e35;padding:24px;border-radius:8px}\n';

async function makeProject(name, slug) {
  const folder = path.join(projectsDir, slug);
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'atelier.json'), JSON.stringify({ name, kind: 'web-app', entry: 'src/index.html' }, null, 2));
  fs.writeFileSync(path.join(folder, 'src', 'index.html'), PAGE);
  fs.writeFileSync(path.join(folder, 'src', 'style.css'), CSS);
  fs.writeFileSync(path.join(folder, 'src', 'about.html'), '<!doctype html><h1>About</h1>\n');
  const imported = await api('POST', '/api/projects/import', { path: folder });
  const session = await api('POST', '/api/console/sessions', { backend: 'claude-code', projectId: imported.project.id, title: `${name} probe` });
  return { id: imported.project.id, folder, sid: (session.session || session).id };
}

async function main() {
  const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }

  const one = await makeProject('Ghost Probe', 'ghost-probe');
  const two = await makeProject('Other Probe', 'other-probe');
  await api('POST', `/api/projects/${one.id}/companion/pins`, { source: 'preview', element: 'ul#event-grid.grid', selector: '#event-grid', files: ['src/style.css:3'], pageKey: 'index.html#home', pageName: 'Home' });
  await api('POST', `/api/projects/${one.id}/activate`);

  const win = new BrowserWindow({ width: 1366, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  const until = (expr, ms = 10000) => js(`(async () => { for (let i = 0; i < ${Math.ceil(ms / 100)}; i++) { try { const v = (${expr}); if (v) return (typeof v === 'object' && v.nodeType) || typeof v === 'function' ? true : v; } catch {} await new Promise((r) => setTimeout(r, 100)); } return null; })()`);
  const clickTab = (name) => js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}))?.click()`);
  const frameDoc = `document.querySelector('.preview-wrap iframe').contentDocument`;
  /** A stub console event, as the SSE handler in client/app.js emits it. */
  const say = (name, data) => js(`window.atelier.emit('console', ${JSON.stringify({ name, data })})`);
  const call = (sid, tool, summary) => say('console.chunk', { sessionId: sid, runId: 'run_probe', kind: 'tool', id: `tu_${Math.random().toString(36).slice(2)}`, name: tool, summary, ms: 1000 });
  const ghost = () => js(`(() => { const g = document.querySelector('.preview-ghost'); if (!g) return null; const r = g.querySelector('.ghost-reload'); return { inWrap: !!g.closest('.preview-wrap') && !g.closest('iframe'), hidden: g.hidden, label: g.querySelector('.ghost-label').textContent, dot: !g.querySelector('.ghost-dot').hidden, reload: r ? !r.hidden : false, title: g.title, opacity: getComputedStyle(g).opacity }; })()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await clickTab('Page');
  await until(`document.querySelectorAll('.page-row').length >= 2`);
  // A mark in the frame's window: if anything reloads the preview, the mark is gone.
  await js(`${frameDoc}.defaultView.__ghostMark = 1`);

  // ---------- another project's session ----------
  await say('console.started', { sessionId: two.sid, runId: 'run_two' });
  await call(two.sid, 'Edit', path.join(one.folder, 'src', 'style.css'));
  await sleep(800);
  const quiet = await ghost();
  check('a session of another project draws nothing here', !!quiet && quiet.hidden === true && quiet.inWrap, quiet);

  // ---------- an edit of the page's stylesheet ----------
  await say('console.started', { sessionId: one.sid, runId: 'run_one' });
  await call(one.sid, 'Edit', path.join(one.folder, 'src', 'style.css'));
  const shown = await until(`!document.querySelector('.preview-ghost').hidden && document.querySelector('.preview-ghost .ghost-label').textContent`, 5000);
  const g1 = await ghost();
  check('the label names who, the file, how long ago and "on this page", in the preview-wrap and not in the frame',
    !!shown && /^Claude Code · editing style\.css · (just now|\d+ s ago) · on this page$/.test(g1.label) && g1.inWrap, g1);
  check('the live dot shows and Reload the preview is offered', g1.dot && g1.reload, g1);
  check('the tooltip names the brain', g1.title === 'Claude Code · Opus 5.5 · your login', g1.title);
  const box = await until(`(() => { const d = ${frameDoc}; const h = d.getElementById('atelier-page-outline-ghost'); const b = h && h.firstElementChild; if (!b) return null; const a = b.getBoundingClientRect(), g = d.getElementById('event-grid').getBoundingClientRect(); return { o: [a.left, a.top, a.width, a.height], g: [g.left, g.top, g.width, g.height], opacity: getComputedStyle(b).opacity, events: getComputedStyle(b).pointerEvents }; })()`, 4000);
  check('the pin\'s part gets the soft outline within 2 px, at half strength, pointer-events none',
    !!box && box.o.every((v, i) => Math.abs(v - box.g[i]) <= 2) && Number(box.opacity) === 0.5 && box.events === 'none', box);
  await sleep(2200);
  const ticked = (await ghost()).label;
  check('the time ticks while the label shows', /· [2-9] s ago ·/.test(ticked), ticked);
  await shot('a-ghost-label-outline');

  // ---------- a sibling page edited ----------
  await call(one.sid, 'Write', path.join(one.folder, 'src', 'about.html'));
  const dot = await until(`(() => { const r = [...document.querySelectorAll('.page-row')].find((x) => x.querySelector('.page-name').textContent === 'about.html'); const d = r && r.querySelector('.page-ghost'); return d ? d.title : null; })()`, 4000);
  check('the edited page\'s row carries a dot titled "edited by Claude Code · …"', /^edited by Claude Code · (just now|\d+ s ago)$/.test(dot || ''), dot);
  check('only the edited page is dotted', (await js(`document.querySelectorAll('.page-ghost').length`)) === 1, await js(`document.querySelectorAll('.page-ghost').length`));
  await shot('b-page-dot');

  // ---------- a non-file call ----------
  await call(one.sid, 'Bash', 'npm run check');
  await sleep(400);
  const g2 = await ghost();
  check('a Bash call reads "Claude Code · running npm run check"', g2.label === 'Claude Code · running npm run check', g2);
  check('Reload stays while an unreloaded edit touched the page', g2.reload, g2);
  check('nothing reloaded the preview by itself', (await js(`${frameDoc}.defaultView.__ghostMark`)) === 1, null);

  // ---------- Reload ----------
  await js(`document.querySelector('.preview-ghost .ghost-reload').click()`);
  await until(`${frameDoc}.defaultView.__ghostMark === undefined && ${frameDoc}.readyState === 'complete'`, 5000);
  await sleep(600);
  const after = await ghost();
  const left = await js(`({ outline: !!${frameDoc}.getElementById('atelier-page-outline-ghost'), dots: document.querySelectorAll('.page-ghost').length })`);
  check('Reload loads the frame again; the outline, the dot and the button go', !after.reload && !left.outline && left.dots === 0, { after, left });
  await shot('c-after-reload');

  // ---------- a switch ----------
  await say('console.done', { sessionId: one.sid, runId: 'run_one', turn: {} });
  await js(`window.atelier.selectProject(${JSON.stringify(two.id)})`);
  await until(`window.atelier.workbench?.projectOnScreen?.() === ${JSON.stringify(two.id)}`, 8000);
  await sleep(600);
  const switched = await ghost();
  check('a project switch clears the marker', switched.hidden === true, switched);
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
