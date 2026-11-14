// By-eye check of Focus > Unresolved: typed first, one group per task, Resolve all, five before Show all.
// A private studio (temp data, own port and pid file), a project from templates/game-room-one, the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-unresolved.cjs  (writes .local/verify-unresolved/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-unresolved');
const PORT = 4898;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-unresolved-'));
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

const words = 'Whether the swell now sounds right is for you to judge by ear; the length only drops a little.';
const carried = (n, taskId, taskTitle) => ({ text: `${n}. ${words}`, taskId, ...(taskTitle ? { taskTitle, at: new Date().toISOString() } : {}) });

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
  await api('PATCH', `/api/projects/${pid}`, { unresolved: [
    carried(1, 't_a', 'Tap renders at the saved tuning'), 'Typed: should the room have a title card?', carried(2, 't_a', 'Tap renders at the saved tuning'),
    carried(3, 't_b', 'Blip a little higher'), carried(4, 't_b', 'Blip a little higher'), carried(5, 't_b', 'Blip a little higher'), carried(6, 't_b', 'Blip a little higher'),
    carried(7, 't_c', 'One item only'), carried(8, 't_gone'), carried(9, 't_gone2'),
  ] });

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = async (code) => { try { return await win.webContents.executeJavaScript(code, true); } catch (err) { throw new Error(`page script failed: ${String(code).replace(/\s+/g, " ").slice(0, 240)} :: ${err.message}`); } };
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const read = () => js(`(() => { const s = document.querySelector('section[aria-label="Unresolved"]'); if (!s) return null; s.scrollIntoView(); return {
    count: s.querySelector('.focus-head .meta')?.textContent,
    first: s.querySelector('.focus-head + *')?.tagName,
    rows: [...s.querySelectorAll('.unresolved li > span')].map((n) => n.textContent.slice(0, 8)),
    lines: [...s.querySelectorAll('.unresolved-from > .meta')].map((n) => n.textContent),
    all: [...s.querySelectorAll('.unresolved-from button')].map((n) => n.textContent),
    buttons: [...s.querySelectorAll(':scope > button')].map((n) => [n.textContent, n.getAttribute('aria-expanded')]),
    scrollsSideways: s.scrollWidth > s.clientWidth,
  }; })()`);
  const press = (scope, label) => js(`[...document.querySelectorAll('section[aria-label="Unresolved"] ${scope}')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2000);
  await js(`[...document.querySelectorAll('.collab button, .collab [role=tab]')].find((b) => b.textContent.trim() === 'Focus').click()`);
  await sleep(500);

  let seen = await read();
  check('The count is the total', seen.count === '10', seen.count);
  check('Five items before the disclosure, typed first', seen.rows.length === 5 && seen.rows[0].startsWith('Typed'), seen.rows);
  check('Group lines with the whole group counted, cut group included', JSON.stringify(seen.lines) === JSON.stringify(['From task: Tap renders at the saved tuning · 2 items', 'From task: Blip a little higher · 4 items']), seen.lines);
  check('Resolve all counts the whole group', JSON.stringify(seen.all) === JSON.stringify(['Resolve all 2', 'Resolve all 4']), seen.all);
  check('Show all 10, closed', seen.buttons.length === 1 && seen.buttons[0][0] === 'Show all 10' && seen.buttons[0][1] === 'false', seen.buttons);
  check('Nothing scrolls sideways', !seen.scrollsSideways);
  await shot('1-first-five');

  await press('> button', 'Show all 10');
  await sleep(400);
  seen = await read();
  check('Show all: every item, and the earlier group last', seen.rows.length === 10 && seen.lines[seen.lines.length - 1] === 'From earlier tasks · 2 items', { rows: seen.rows.length, lines: seen.lines });
  check('A group of one has no Resolve all', !seen.all.includes('Resolve all 1') && seen.lines.includes('From task: One item only · 1 item'), seen.all);
  check('Show all: says how to go back', seen.buttons[0][0] === 'Show first 5' && seen.buttons[0][1] === 'true', seen.buttons);
  check('The toggle keeps the focus', await js(`document.activeElement?.dataset?.edit === 'unresolved-all'`));
  await shot('2-show-all');

  await js(`location.reload()`);
  await sleep(2500);
  await js(`[...document.querySelectorAll('.collab button, .collab [role=tab]')].find((b) => b.textContent.trim() === 'Focus').click()`);
  await sleep(500);
  await press('> button', 'Show all 10');
  await sleep(300);

  await press('.unresolved-from button', 'Resolve all 4');
  await sleep(1000);
  seen = await read();
  const stored = (await api('GET', `/api/projects/${pid}`));
  const left = (stored.project || stored).unresolved;
  check('Resolve all: the group is gone on disk, the rest keep their stamps', left.length === 6 && !left.some((u) => u.taskId === 't_b') && left.find((u) => u.taskId === 't_a')?.taskTitle === 'Tap renders at the saved tuning', left.map((u) => u.taskId));
  check('Resolve all: the count follows', seen.count === '6', seen.count);
  check('The open list stays open after a save', seen.rows.length === 6, seen.rows.length);

  await js(`[...document.querySelector('section[aria-label="Unresolved"]').querySelectorAll('.unresolved li')].find((li) => li.textContent.startsWith('1.')).querySelector('button').click()`);
  await sleep(1000);
  seen = await read();
  check('One Resolve removes one, and at five or fewer there is no disclosure', seen.count === '5' && seen.rows.length === 5 && seen.buttons.length === 0, seen);
  await shot('3-after-resolving');

  // ---- where the focus goes, and an open form staying open
  const openFocusPanel = async () => {
    await js(`location.reload()`);
    await sleep(2500);
    await js(`[...document.querySelectorAll('.collab button, .collab [role=tab]')].find((b) => b.textContent.trim() === 'Focus').click()`);
    await sleep(500);
  };
  const focusedText = () => js(`(() => { const n = document.activeElement; if (!n || n === document.body) return 'the page'; if (n.tagName === 'INPUT') return n.getAttribute('aria-label'); return n.tagName + ' ' + n.textContent; })()`);
  const pressRow = (start) => js(`[...document.querySelectorAll('section[aria-label="Unresolved"] .unresolved li')].find((li) => li.textContent.startsWith(${JSON.stringify(start)})).querySelector('button').click()`);
  const focusIs = async (name, want) => { const got = await focusedText(); check(name, got.startsWith(want), got); };
  await api('PATCH', `/api/projects/${pid}`, { unresolved: [carried('A', 't_a', 'Group A'), carried('B', 't_a', 'Group A'), carried('C', 't_a', 'Group A'), carried('G', 't_a', 'Group A'), carried('D', 't_b', 'Group B'), carried('E', 't_c', 'Group C'), carried('F', 't_c', 'Group C')] });
  await openFocusPanel();
  await press('> button', 'Show all 7');
  await sleep(300);
  await pressRow('A.');
  await sleep(800);
  await focusIs('After a Resolve: the next item\'s text, not a button', 'SPAN B.');
  await pressRow('G.');
  await sleep(800);
  await focusIs('After the last of a group: the next group\'s heading, not its Resolve all', 'SPAN From task: Group B');
  await press('.unresolved-from button', 'Resolve all 2'); // Group A
  await sleep(800);
  await focusIs('After a Resolve all: the next group\'s heading', 'SPAN From task: Group B');
  await press('.unresolved-from button', 'Resolve all 2'); // Group C, the last
  await sleep(800);
  await focusIs('After the last group: the Add field', 'Add an unresolved question');

  await js(`document.querySelector('[aria-label="Edit current piece"]').click()`);
  await sleep(400);
  await js(`document.querySelector('section.focus-sec form input').value = 'Half typed'`);
  await pressRow('D.');
  await sleep(800);
  check('An open edit form survives a Resolve, with its words', (await js(`document.querySelector('section.focus-sec form input')?.value`)) === 'Half typed');
  await js(`(() => { const a = document.querySelector('[aria-label="Add an unresolved question"]'); a.value = 'Asked with the form open'; a.closest('form').requestSubmit(); })()`);
  await sleep(800);
  check('An open edit form survives an Add, with its words', (await js(`document.querySelector('section.focus-sec form input')?.value`)) === 'Half typed');
  check('The Add reached the list', (await api('GET', `/api/projects/${pid}`)).project.unresolved.some((u) => u.text === 'Asked with the form open'));
  await shot('4-form-kept');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
