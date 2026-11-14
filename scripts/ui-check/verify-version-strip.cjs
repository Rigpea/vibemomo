// By-eye check of the version strip along the bottom of the Workbench: a web-app project from templates/web-app-notes
// (its creation keeps #1), two more versions kept through the CLI with --task of a task created through the API
// (#2 and #3), then: three numbered marks in order, the task's bar over #2–#3 named by the task, the current mark
// filled, a tap on #1 opening the drawer with row #1 focused, and the dashed stub after a file edit.
// A private studio (temp data, own port and pid file), the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-version-strip.cjs  (writes .local/verify-version-strip/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-version-strip');
const PORT = 4907;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-strip-'));
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
const cli = (...args) => execFileSync('node', ['bin/atelier.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true });

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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 120000);

app.disableHardwareAcceleration();

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Strip', kind: 'web-app', template: 'web-app-notes' });
  const pid = created.project?.id || created.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const t = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Add a notes footer', request: 'Add a notes footer', mode: 'handle' });
  const tid = t.id || t.task?.id;
  for (const label of ['Footer first pass', 'Footer second pass']) {
    await api('PUT', `/api/projects/${pid}/files`, { path: 'footer-note.txt', content: `${label}\n` });
    cli('checkpoint', '--project', pid, '--label', label, '--task', tid);
  }
  const bundle = await api('GET', `/api/projects/${pid}`);
  check('three versions: #1 from the creation, #2 and #3 through the CLI with the task', bundle.versions?.length === 3 && bundle.versions.filter((v) => v.taskId === tid).length === 2, bundle.versions?.map((v) => [v.n, v.label, v.taskId]));

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);
  const seen = await js(`(() => {
    const marks = [...document.querySelectorAll('#main .vstrip .vmark')];
    const bars = [...document.querySelectorAll('#main .vstrip .vbar')];
    const box = (n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }; };
    return {
      marks: marks.map((m) => ({ text: m.textContent, name: m.getAttribute('aria-label'), current: m.classList.contains('current'), bg: getComputedStyle(m).backgroundColor, box: box(m) })),
      bars: bars.map((b) => ({ name: b.title, live: b.classList.contains('live'), box: box(b) })),
      barHeight: Math.round(document.querySelector('#main .versions-bar').getBoundingClientRect().height),
      button: document.querySelector('#main .versions-bar .versions-btn button')?.textContent,
    };
  })()`);
  check('three marks numbered in order', JSON.stringify(seen.marks.map((m) => m.text)) === '["1","2","3"]', seen.marks.map((m) => m.text));
  check('each mark is at least 24 px wide', seen.marks.every((m) => m.box.width >= 24), seen.marks.map((m) => m.box));
  check('the current mark (#3) is filled, the others are not', seen.marks[2]?.current && !seen.marks[0]?.current && seen.marks[2].bg !== seen.marks[0].bg, seen.marks.map((m) => [m.text, m.current, m.bg]));
  check('mark names read "#n label · when · state"', /^#2 Footer first pass · .+ · experiment$/.test(seen.marks[1]?.name || ''), seen.marks[1]?.name);
  const bar = seen.bars[0];
  check('one bar, named by the task', seen.bars.length === 1 && bar.name === 'Add a notes footer' && !bar.live, seen.bars);
  check('the bar spans #2 to #3', bar && bar.box.left >= seen.marks[1].box.left - 4 && bar.box.left < seen.marks[1].box.right && bar.box.right > seen.marks[2].box.left && bar.box.right <= seen.marks[2].box.right + 4, { bar: bar?.box, marks: seen.marks.map((m) => m.box) });
  check('the bar with a lane stays within 56 px', seen.barHeight >= 36 && seen.barHeight <= 56, seen.barHeight);
  check('the Versions button stays at the left', seen.button === 'Versions · 3', seen.button);
  await shot('1-strip');

  // A tap on #1 opens the drawer with row #1 focused.
  await js(`document.querySelector('#main .vstrip .vmark').click()`);
  await sleep(800);
  const opened = await js(`({ drawer: !document.querySelector('#main .drawer').hidden, focused: document.activeElement?.id || null, n: document.activeElement?.querySelector?.('td')?.textContent })`);
  const v1 = bundle.versions.find((v) => v.n === 1);
  check('a tap on #1 opens the drawer with row #1 focused', opened.drawer && opened.focused === `version-row-${v1.id}` && opened.n === '1', opened);
  await shot('2-drawer-at-1');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);
  check('Esc closes the drawer and the strip is back', (await js(`document.querySelector('#main .drawer').hidden && !document.querySelector('#main .versions-bar').hidden`)) === true);

  // A file edit: the dashed stub after the current mark.
  await api('PUT', `/api/projects/${pid}/files`, { path: 'footer-note.txt', content: 'edited on disk\n' });
  await sleep(800);
  await js(`window.atelier.loadBundle({ quiet: true })`); // the stub is the check here, not whether a change event arrived
  await sleep(800);
  const stub = await js(`(() => { const s = document.querySelector('#main .vstrip .vstub'); const m = [...document.querySelectorAll('#main .vstrip .vmark')][2]; if (!s) return null; const a = s.getBoundingClientRect(); const b = m.getBoundingClientRect(); return { title: s.title, after: a.left >= b.right - 1, style: getComputedStyle(s).borderTopStyle }; })()`);
  check('the dirty stub after #3, dashed, titled', stub && stub.title === 'the files on disk · changed since #3' && stub.after && stub.style === 'dashed', stub);
  await shot('3-dirty-stub');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
