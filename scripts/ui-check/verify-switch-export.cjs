// By-eye check of the tester's round on #61-#64: Export while another version is previewed, a long path in a task row at
// 800 px, the Task form's words, the loading state of a project switch, and the mode across a switch.
// A private studio (temp data, own port and pid file), projects from templates/game-room-one, the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-switch-export.cjs  (writes .local/verify-switch-export/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-switch-export');
const PORT = 4898;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-switch-'));
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
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const make = async (name) => {
    const created = await api('POST', '/api/projects', { name, kind: 'game', template: 'game-room-one' });
    return created.project?.id || created.id;
  };
  const pid = await make('Verify One');
  const other = await make('Verify Two');
  await api('POST', `/api/projects/${pid}/activate`);
  const bundle = await api('GET', `/api/projects/${pid}`);
  const folder = bundle.entry?.path || bundle.project?.path;
  const cli = (...a) => spawnSync('node', [path.join(ROOT, 'bin', 'atelier.mjs'), ...a, '--project', pid], { env, encoding: 'utf8', windowsHide: true });
  fs.appendFileSync(path.join(folder, 'verify-note.txt'), 'second\n');
  const made = cli('checkpoint', '--label', 'Jump higher');
  fs.appendFileSync(path.join(folder, 'verify-note.txt'), 'third\n');
  const made2 = cli('checkpoint', '--label', 'Lower gravity');
  check('Two versions kept', made.status === 0 && made2.status === 0, [made.stderr, made2.stderr]);
  const versions = (await api('GET', `/api/projects/${pid}`)).versions;
  const previewed = versions.find((v) => v.label === 'Jump higher');
  const head = versions.find((v) => v.label === 'Lower gravity');
  const atHead = async () => { const b = await api('GET', `/api/projects/${pid}`); return b.changes.sinceVersionId; };

  const win = new BrowserWindow({ width: 1366, height: 768, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const press = (text, scope = 'document') => js(`[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const dialogText = () => js(`document.querySelector('dialog[open]')?.innerText || ''`);
  const dlg = `document.querySelector('dialog[open]')`;
  const restoreLabel = `Restore #${previewed.n} and export it`;

  // ---- 1. Export while another version is previewed
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2000);
  await press('Build/Export');
  await sleep(1000);
  let text = await dialogText();
  check('Export, no version previewed: no sentence about a preview', !text.includes('You are previewing') && text.includes(`Export #${head.n} Lower gravity`), text.slice(0, 200));
  await press('Cancel', dlg);
  await sleep(300);
  await js(`window.atelier.workbench.viewVersion(${JSON.stringify(previewed.id)})`);
  await sleep(1000);
  await press('Build/Export');
  await sleep(1000);
  text = await dialogText();
  check('Export, #n previewed: names both versions', text.includes(`You are previewing #${previewed.n} Jump higher. Export builds the files on disk, which are #${head.n} Lower gravity.`), text.slice(0, 240));
  check('Export, #n previewed: offers the button', await js(`[...${dlg}.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(restoreLabel)})`));
  check('Export, #n previewed: the keyboard is not on the restore button', !(await js(`document.activeElement.textContent.trim() === ${JSON.stringify(restoreLabel)}`)));
  await shot('1-export-while-previewing');
  await press('Cancel', dlg);
  await sleep(500);
  check('Cancel restores nothing', (await atHead()) === head.id);
  check('Cancel leaves the preview on the version', await js(`document.querySelector('.preview-wrap iframe').src.includes(${JSON.stringify(previewed.id)})`));
  await press('Build/Export');
  await sleep(1000);
  await press(restoreLabel, dlg);
  await sleep(3000);
  check('The button restores', (await atHead()) === previewed.id);
  text = await dialogText();
  check('The export reopens for the restored version', text.includes(`Export #${previewed.n} Jump higher`) && !text.includes('You are previewing'), text.slice(0, 200));
  await shot('2-export-after-restore');
  await press('Cancel', dlg);
  await sleep(300);

  // ---- 2. A long path at 800 px
  const longPath = `C:\\Users\\${'somebody-with-a-long-name\\'.repeat(6)}templates\\game-room-one`;
  await api('POST', `/api/projects/${pid}/tasks`, { title: 'Catch up with the template', request: `Compare with ${longPath}`, mode: 'handle' });
  win.setContentSize(800, 768);
  await sleep(600);
  const widths = (list) => js(`(() => { const d = document.documentElement; const l = document.querySelector(${JSON.stringify(list)}); return { docScroll: d.scrollWidth, docClient: d.clientWidth, inner: innerWidth, listScroll: l?.scrollWidth, listClient: l?.clientWidth }; })()`);
  const open = (root) => js(`[...document.querySelectorAll('${root} .task-sum')].find((b) => b.textContent.includes('Catch up')).click()`);
  await js(`location.hash = '#/tasks'`);
  await sleep(1500);
  await open('#main');
  await sleep(1000);
  let w = await widths('#main .task-list');
  check('800 px, Tasks view: width is 800', w.inner === 800, w);
  check('800 px, Tasks view: no sideways scroll', w.docScroll === w.docClient && w.listScroll === w.listClient && w.listClient > 0, w);
  check('800 px, Tasks view: the path is in the open row', await js(`document.querySelector('#main .task-detail').innerText.includes('game-room-one')`));
  await shot('3-long-path-tasks');
  await js(`location.hash = '#/workbench'`);
  await sleep(1500);
  await js(`window.atelier.showPanel('task')`);
  await sleep(800);
  await open('#collab');
  await sleep(1000);
  w = await widths('#collab .task-list');
  check('800 px, Task panel: no sideways scroll', w.docScroll === w.docClient && w.listScroll === w.listClient && w.listClient > 0, w);
  check('800 px, Task panel: nor does its scrolling box', await js(`(() => { const t = document.querySelector('#collab .timeline'); return t.scrollWidth === t.clientWidth; })()`));
  await shot('4-long-path-panel');

  // ---- 3. The form's words
  check('Form: the button names the project', (await js(`document.querySelector('#collab .composer button[type=submit]').textContent.trim() === 'Create task on ' + window.atelier.project().name`)) === true);
  check('Form: the sentence says how it runs', (await js(`document.querySelector('#collab .composer-foot .hint').textContent`)) === 'Nothing runs until you hand it over: Run with Claude Code here on its row.');
  await js(`document.querySelector('#collab .collab-close').click()`);
  win.setContentSize(1366, 768);
  await sleep(800);

  // ---- 4. A project switch shows itself, held open by a delay on the bundle's answer
  await js(`(() => {
    const real = window.fetch;
    window.__hold = false;
    window.fetch = async (url, opts) => {
      if (window.__hold && /\\/api\\/projects\\/[^/?]+$/.test(String(url)) && (!opts || !opts.method || opts.method === 'GET')) await new Promise((r) => { const t = setInterval(() => { if (!window.__hold) { clearInterval(t); r(); } }, 20); });
      return real(url, opts);
    };
  })()`);
  const toolbar = () => js(`(() => { const pill = document.querySelector('.version-pill'); const f = document.querySelector('.preview-wrap iframe'); return { pill: pill?.textContent, frame: f.getAttribute('src'), disabled: [...document.querySelectorAll('.stage-head button')].every((b) => b.disabled), banner: document.querySelector('#main .banner').hidden }; })()`);
  const switchTo = async (id) => {
    await js(`window.__hold = true; window.atelier.selectProject(${JSON.stringify(id)}); undefined`);
    await sleep(300);
    const during = await toolbar();
    await js(`window.__hold = false`);
    await sleep(1500);
    return { during, after: await toolbar() };
  };
  const seenSwitch = await switchTo(other);
  check('Switch: the pill reads Loading… until the bundle arrives', seenSwitch.during.pill === 'Loading…', seenSwitch.during);
  check('Switch: the preview is blank meanwhile', seenSwitch.during.frame === 'about:blank', seenSwitch.during);
  check('Switch: the actions wait too', seenSwitch.during.disabled, seenSwitch.during);
  check('Switch: afterwards the next project is shown', /^#\d+/.test(seenSwitch.after.pill || '') && seenSwitch.after.frame.includes(other) && !seenSwitch.after.disabled, seenSwitch.after);
  await shot('5-after-switch');

  // ---- 5. The mode across a switch
  const form = `document.querySelector('#collab .composer')`;
  const setForm = (request) => js(`(() => { const r = ${form}.querySelector('textarea'); r.value = ${JSON.stringify(request)}; r.dispatchEvent(new Event('input', { bubbles: true })); ${form}.querySelector('select[aria-label="How Claude Code works with you"]').value = 'explore'; })()`);
  const readForm = () => js(`({ request: ${form}.querySelector('textarea').value, mode: ${form}.querySelector('select[aria-label="How Claude Code works with you"]').value })`);
  await setForm('');
  await switchTo(pid);
  let f = await readForm();
  check('Mode: back on the default after a switch with no request', f.mode === 'handle' && f.request === '', f);
  await setForm('Still typing this');
  await switchTo(other);
  f = await readForm();
  check('Mode: kept with a request still in the field', f.mode === 'explore' && f.request === 'Still typing this', f);
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
