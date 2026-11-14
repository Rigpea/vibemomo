// Check for t_v1q368earu: private server (temp data, own port), real client in an offscreen window.
// An explore task with three options: the row names them, Compare opens first and last, Try it the last.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-explore');
const PORT = 4897;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => results.push({ name, ok: !!ok, seen });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 120000);

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Room', kind: 'game', template: 'game-room-one' });
  const pid = created.project?.id || created.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const folder = path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
  const cli = (...a) => spawnSync('node', [path.join(ROOT, 'bin', 'atelier.mjs'), ...a, '--project', pid], { env, encoding: 'utf8', windowsHide: true });

  const t = await api('POST', `/api/projects/${pid}/tasks`, { title: 'Three jumps', request: 'Try three jumps', mode: 'explore' });
  const tid = t.id || t.task.id;
  cli('task', 'start', tid);
  const ids = [];
  for (const [text, flags] of [['Option A', ['--task', tid]], ['Option B', []], ['Option C', ['--task', tid]]]) {
    fs.appendFileSync(path.join(folder, 'verify-note.txt'), `${text}\n`);
    const r = cli('checkpoint', '--label', text, ...flags);
    check(`checkpoint ${text}`, r.status === 0, r.stderr);
    check(`checkpoint ${text} prints its number first`, /^#\d+ .+ \(v_\w+\)\r?\n\{/.test(r.stdout), r.stdout.slice(0, 200));
    ids.push(JSON.parse(r.stdout.slice(r.stdout.indexOf('\n') + 1)).version);
  }
  const done = cli('task', 'finish', tid, '--summary', 'Three jumps to compare');
  check('CLI prints the list', done.status === 0 && JSON.stringify(JSON.parse(done.stdout).versionIds) === JSON.stringify(ids), done.stdout.slice(0, 400));

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const row = (scope) => `[...document.querySelectorAll('${scope} .task')].find((a) => a.textContent.includes('Three jumps'))`;
  const press = (scope, label) => js(`[...${row(scope)}.querySelectorAll('.task-actions button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const readRow = (scope) => js(`(() => { const t = ${row(scope)}; return { meta: t.querySelector('.task-meta')?.textContent, buttons: [...t.querySelectorAll('.task-actions button')].map((b) => b.textContent.trim()), overflow: [...t.querySelectorAll('.task-actions')].some((b) => b.scrollWidth > b.clientWidth) }; })()`);
  const readCompare = () => js(`(() => { const s = [...document.querySelectorAll('.sbs')]; return { count: s.length, a: document.querySelector('#sbs-a')?.value, b: document.querySelector('#sbs-b')?.value, frames: [...document.querySelectorAll('.sbs iframe')].map((f) => f.getAttribute('src')), view: location.hash }; })()`);

  // The Tasks view
  await win.loadURL(`${BASE}/#/tasks`);
  await sleep(1500);
  await js(`${row('#main')}.querySelector('.task-sum').click()`);
  await sleep(800);
  let seen = await readRow('#main');
  check('Tasks: row names every option', /produced #\d+, #\d+, #\d+/.test(seen.meta), seen.meta);
  const buttons = seen.buttons;
  check('Tasks: Compare beside Try it', buttons.indexOf('Compare side by side') === buttons.indexOf('Try it') + 1, buttons);
  check('Tasks: no overflow at 1366', seen.overflow === false, seen.overflow);
  await shot('1-tasks-1366');
  win.setContentSize(800, 700);
  await sleep(600);
  seen = await readRow('#main');
  check('Tasks: no overflow at 800', seen.overflow === false, seen);
  await shot('2-tasks-800');
  win.setContentSize(1366, 768);
  await sleep(400);

  // Compare from the Tasks view has to reach the Workbench first
  await press('#main', 'Compare side by side');
  await sleep(2500);
  let cmp = await readCompare();
  check('Compare: goes to the Workbench', cmp.view.startsWith('#/workbench'), cmp.view);
  check('Compare: A is the first option, B the last', cmp.a === ids[0] && cmp.b === ids[2], cmp);
  check('Compare: both frames load those versions', cmp.frames.length === 2 && cmp.frames[0].includes(ids[0]) && cmp.frames[1].includes(ids[2]), cmp.frames);
  await shot('3-compare');

  // The Workbench panel shares the row: its meta comes from the bundle route
  seen = await readRow('#collab');
  check('Panel: row names every option', /produced #\d+, #\d+, #\d+/.test(seen.meta), seen.meta);
  const expanded = await js(`${row('#collab')}.querySelector('.task-sum').getAttribute('aria-expanded')`);
  if (expanded !== 'true') await js(`${row('#collab')}.querySelector('.task-sum').click()`);
  await sleep(800);
  await press('#collab', 'Compare side by side');
  await sleep(1200);
  cmp = await readCompare();
  check('Panel: Compare again leaves one overlay', cmp.count === 1, cmp.count);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(500);
  check('Esc closes it', (await readCompare()).count === 0, null);

  // Try it keeps opening the last
  await press('#collab', 'Try it');
  await sleep(1500);
  const src = await js(`[...document.querySelectorAll('#main iframe')].map((f) => f.getAttribute('src')).join(' ')`);
  check('Try it opens the last option', src.includes(ids[2]) && !src.includes(ids[0]), src);
  await shot('4-try-it');

  // Recording: the dialog names all of them and offers both actions
  await press('#collab', 'Record the result');
  await sleep(1200);
  const dlg = await js(`(() => { const d = document.querySelector('dialog[open]'); return { text: d?.textContent, buttons: [...(d?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()) }; })()`);
  check('Record dialog names every option', /This task produced #\d+, #\d+, #\d+\. The task is done\./.test(dlg.text || ''), dlg.text);
  check('Record dialog offers Try it and Compare', dlg.buttons.includes('Try it') && dlg.buttons.includes('Compare side by side'), dlg.buttons);
  await shot('5-recorded');
  await js(`[...document.querySelector('dialog[open]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close').click()`);
  await sleep(600);
  seen = await readRow('#collab');
  check('Done: Compare still offered', seen.buttons.includes('Compare side by side'), seen.buttons);
  const versions = (await api('GET', `/api/projects/${pid}/versions`));
  const list = Array.isArray(versions) ? versions : versions.versions || [];
  check('Recording tags the untagged option', list.find((v) => v.id === ids[1])?.taskId === tid, list.map((v) => [v.n, v.taskId]));
  await finish(results.every((c) => c.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((e) => { results.push({ name: 'driver error', ok: false, seen: String(e?.stack || e) }); finish(2); });
