// By-eye check of three words-and-order fixes: a task's events read oldest first and in full, the Readiness
// checklist has one name in the Play panel and the export dialog, and Side by side folds only the dock's panel.
// A private studio (temp data, own port and pid file), a project from templates/game-room-one, the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-events.cjs  (writes .local/verify-events/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-events');
const PORT = 4897;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-events-'));
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
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 120000);

app.disableHardwareAcceleration();

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

  // created, ready, started and these notes: more than 12 events, the first notes behind the disclosure.
  const t = await api('POST', `/api/projects/${pid}/tasks`, { title: 'A long lesson', request: 'Teach the jump', mode: 'teach' });
  const tid = t.id || t.task.id;
  cli('task', 'start', tid);
  const longNote = `12. THE LONG ONE.\nSecond line. ${'word '.repeat(500)}THE END OF THE NOTE`;
  for (let n = 1; n <= 12; n++) {
    const r = cli('task', 'note', tid, n === 12 ? longNote : `${n}. Note number ${n}`);
    if (r.status !== 0) check(`note ${n}`, false, r.stderr);
  }

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const row = `[...document.querySelectorAll('#main .task')].find((a) => a.textContent.includes('A long lesson'))`;
  const readEvents = () => js(`(() => { const r = ${row}; const outer = r.querySelector('.task-detail > details.more:last-of-type'); const inner = outer.querySelector('details.more'); const lists = [...outer.querySelectorAll(':scope > div > ul.events')]; const texts = (ul) => [...ul.querySelectorAll(':scope > li')].map((li) => li.children[1].textContent); return { summary: outer.querySelector('summary').textContent, open: outer.open, innerSummary: inner?.querySelector('summary').textContent, innerOpen: inner?.open, earlier: inner ? texts(inner.querySelector('ul.events')) : [], recent: texts(lists[lists.length - 1]), innerAbove: inner && lists.length ? !!(inner.compareDocumentPosition(lists[lists.length - 1]) & Node.DOCUMENT_POSITION_FOLLOWING) : null, whenFont: getComputedStyle(outer.querySelector('.events-when')).fontFamily }; })()`);

  // ---- 1. the events
  await win.loadURL(`${BASE}/#/tasks`);
  await sleep(1500);
  await js(`${row}.querySelector('.task-sum').click()`);
  await sleep(800);
  await js(`${row}.querySelector('.task-detail > details.more:last-of-type > summary').click()`);
  await sleep(300);
  let seen = await readEvents();
  const total = Number(seen.summary.replace(/\D/g, ''));
  check('Events: more than 12 in this case', total > 12, seen.summary);
  check('Events: last 12 shown, the rest behind "n earlier"', seen.recent.length === 12 && seen.earlier.length === total - 12 && seen.innerSummary === `${total - 12} earlier` && seen.innerOpen === false, { recent: seen.recent.length, earlier: seen.earlier.length, inner: seen.innerSummary });
  check('Events: the disclosure is above the open ones', seen.innerAbove === true);
  const order = [...seen.earlier, ...seen.recent].map((text) => (/— (\d+)\. /.exec(text) || [])[1]).filter(Boolean).map(Number);
  check('Events: notes read 1 to 12 top down', JSON.stringify(order) === JSON.stringify(Array.from({ length: 12 }, (_, i) => i + 1)), order);
  check('Events: first event is the oldest', /^created/.test(seen.earlier[0]), seen.earlier[0]);
  const long = seen.recent[seen.recent.length - 1];
  check('Events: a long note has its full text and its line break', long.endsWith('THE END OF THE NOTE') && long.includes('THE LONG ONE.\nSecond line.'), long.length);
  check('Events: the time column is mono', /Cascadia|Consolas|mono/i.test(seen.whenFont), seen.whenFont);
  await shot('1-events-closed-earlier');
  await js(`${row}.querySelector('.task-detail > details.more:last-of-type details.more > summary').click()`);
  await sleep(300);
  await shot('2-events-open-earlier');
  // A note arriving redraws the row: what the person opened stays open and the new note lands last.
  cli('task', 'note', tid, '13. Arrived while reading');
  await sleep(4000); // the watcher's quiet window plus the offscreen window's late paint
  seen = await readEvents();
  check('Events: a new note keeps both open and lands at the end', seen.open && seen.innerOpen && /13\. Arrived while reading$/.test(seen.recent[seen.recent.length - 1]), { open: seen.open, inner: seen.innerOpen, last: seen.recent[seen.recent.length - 1]?.slice(0, 60) });

  // ---- 2. one name for the checklist
  fs.appendFileSync(path.join(folder, 'verify-note.txt'), 'second\n');
  cli('checkpoint', '--label', 'Second version');
  await js(`location.hash = '#/workbench'`);
  await sleep(2500);
  // Companion is the first dock tab since #81, so the checklist is on the Play tab only once it is chosen.
  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim().startsWith('Play'))?.click()`);
  await sleep(800);
  const heading = await js(`[...document.querySelectorAll('.wbp-host:not([hidden]) h3')].map((h) => h.textContent).filter((x) => /checklist/i.test(x))`);
  check('Play panel: Readiness checklist', heading.length === 1 && /^Readiness checklist · \d+\/\d+$/.test(heading[0]), heading);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Build/Export').click()`);
  await sleep(1500);
  const dialogText = await js(`document.querySelector('dialog[open]')?.innerText || ''`);
  check('Export dialog: Readiness checklist', /Readiness checklist: \d+ of \d+ met/.test(dialogText), dialogText.slice(0, 200));
  await shot('3-export-dialog');
  await js(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Cancel').click()`);
  await sleep(300);
  check('No "Experience checklist" in the page', !(await js(`document.body.innerText.includes('Experience checklist')`)));

  // ---- 3. what the guide says about Side by side
  const visible = (sel) => `(() => { const n = document.querySelector('${sel}'); return !!n && n.getClientRects().length > 0; })()`;
  const dockFacts = async () => ({ body: await js(visible('.dock-body')), tabs: await js(`[...document.querySelectorAll('.dock [role=tab]')].some((n) => n.getClientRects().length > 0)`), versions: await js(visible('.versions-bar')) });
  const before = await dockFacts();
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Side by side').click()`);
  await sleep(1500);
  const during = await dockFacts();
  check('Side by side: the panel goes, the tab strip and the Versions bar stay', before.body && !during.body && during.tabs && during.versions, { before, during });
  await shot('4-side-by-side');
  await js(`document.querySelector('.dock [role=tab]').click()`);
  await sleep(600);
  const clicked = await dockFacts();
  check('Side by side: clicking a tab opens its panel again', clicked.body, clicked);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);
  check('Side by side: closed', !(await js(visible('.sbs'))));
  const after = await dockFacts();
  check('Side by side: closing leaves the dock open as it was', after.body && after.tabs, after);
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
