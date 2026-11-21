// Inspiration › Studio look (docs/DESIGN.md section 15, docs/ARCHITECTURE.md section 27), driven in a real window:
// the two scopes named in the head, the person's own board filled through the one field (cream and teal colours and
// notes), Make a look with each choice naming its card, the preview over the whole studio, Apply, the look across
// the Workbench, Tasks and Settings, a real reload, the light theme's own look, Reset and Undo, the one line about the
// studio's locked defaults, and a product's app board and the studio project's app board unchanged throughout.
// At 1280×720 and 1920×1080. A private server (temp data and projects, a port the system picks): it never touches
// the studio on 4747 or ~/.atelier. Offscreen.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-studio-look.cjs
// Writes .local/shot-live/studio-look-*.jpg and prints the checks; exit 0 when every check holds.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'shot-live');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-studio-look-'));
fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();

const results = [];
const check = (name, ok, seen) => results.push({ name, ok: !!ok, seen });
let server = null;
let done = false;
async function finish(code) {
  if (done) return;
  done = true;
  fs.writeFileSync(path.join(OUT, 'studio-look-results.json'), JSON.stringify(results, null, 1));
  for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : `\n     ${JSON.stringify(r.seen)}`));
  console.log(results.filter((r) => r.ok).length + ' of ' + results.length + ' checks hold');
  server?.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 240000);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: path.join(tmp, 'projects'), ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') };
  delete env.ELECTRON_RUN_AS_NODE;
  const api = async (method, p, body) => { const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: res.status, data: await res.json().catch(() => null) }; };
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 100) throw new Error('server did not start');
    await sleep(200);
  }
  // The studio project with the studio's four seeded locks, and a product with its own app board.
  const studio = (await api('POST', '/api/projects', { name: 'Studio Check', kind: 'studio' })).data.project;
  for (const [text, name, value] of [['The canvas is warm charcoal', '--bg', '#232221'], ['Content is set in warm off-white ink', '--ink', '#ece8e1'], ['Amber is the one accent', '--accent', '#d6a455'], ['A serif display face', '--serif', '"Source Serif 4", "Source Serif Pro", "Iowan Old Style", "Charter", "Cambria", "Georgia", serif']]) {
    await api('POST', `/api/projects/${studio.id}/rules`, { text, kind: name === '--serif' ? 'type' : 'color', token: { name, value } });
  }
  await api('POST', `/api/projects/${studio.id}/inspiration`, { kind: 'color', hex: '#d6a455', name: 'amber' });
  const product = (await api('POST', '/api/projects', { name: 'Sample Check', kind: 'web-app', template: 'web-app-notes' })).data.project;
  for (const card of [{ kind: 'note', text: 'Shelf: a modern collector' }, { kind: 'color', hex: '#7a4b2a', name: 'walnut' }, { kind: 'color', hex: '#e6d3b3', name: 'linen' }]) await api('POST', `/api/projects/${product.id}/inspiration`, card);
  await api('POST', `/api/projects/${product.id}/activate`);
  const appBoards = async () => JSON.stringify([(await api('GET', `/api/projects/${product.id}/inspiration`)).data.cards, (await api('GET', `/api/projects/${studio.id}/inspiration`)).data.cards]);
  const boardsBefore = await appBoards();
  const facts = async () => (await api('GET', '/api/settings/appearance')).data;

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const size = async (w, h) => { win.setSize(w + 2, h); await sleep(300); win.setSize(w, h); await sleep(900); };
  const shot = async (name) => { const [w, h] = win.getSize(); await size(w, h); win.webContents.invalidate(); await sleep(500); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toJPEG(88)); };
  const go = async (hash) => { await js(`location.hash = ${JSON.stringify(hash)}`); await sleep(1500); };
  const clickText = async (sel, text) => { const ok = await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => n.textContent.trim() === ${JSON.stringify(text)} && !n.closest('[hidden]')); if (!b) return false; b.focus(); b.click(); return !b.disabled; })()`); await sleep(1200); return ok; };
  const root = `(() => { const r = getComputedStyle(document.documentElement); const v = (n) => r.getPropertyValue(n).trim(); return { bg: v('--bg'), panel: v('--panel'), ink: v('--ink'), accent: v('--accent'), serif: v('--serif'), r2: v('--r2'), muted: v('--muted'), body: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme }; })()`;
  const panel = `(() => { const s = document.querySelector('.slook'); if (!s) return null; const t = (sel) => s.querySelector(sel)?.textContent || null; const btn = (w) => [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === w && !b.closest('[hidden]') && !b.hidden);
    return { hidden: s.hidden, scope: t('.slook-scope'), now: t('.slook-now'), lock: s.querySelector('.slook-lock').hidden ? null : t('.slook-lock'), rows: [...s.querySelectorAll('.slook-row')].map((r) => [r.querySelector('.slook-label').textContent, r.querySelector('.slook-value').textContent, r.querySelector('.slook-from').textContent]), pairs: t('.slook-pairs'), lead: s.querySelector('.slook-proposal > p.meta')?.textContent || null,
      make: btn('Make a look') ? { off: btn('Make a look').disabled, primary: btn('Make a look').classList.contains('primary') } : null, again: !!btn('Make again'), apply: btn('Apply') ? { off: btn('Apply').disabled, primary: btn('Apply').classList.contains('primary') } : null, undo: !!btn('Undo'), reset: btn('Reset to defaults')?.disabled ?? null,
      primaries: [...document.querySelectorAll('#main .btn.primary')].filter((b) => !b.closest('[hidden]') && !b.hidden && b.offsetParent).map((b) => b.textContent.trim()) }; })()`;
  const head = `(() => ({ hash: location.hash, scopes: [...document.querySelectorAll('.inspo-scope')].map((n) => n.textContent), pressed: [...document.querySelectorAll('.inspo-head .seg button[aria-pressed="true"]')].map((b) => b.textContent), count: document.querySelector('.inspo-count')?.textContent, cards: document.querySelectorAll('.inspo-board > .inspo-card').length, empty: document.querySelector('.inspo-fill')?.textContent || null, placeholder: document.querySelector('.inspo-add .input')?.placeholder }))()`;
  const type = async (value) => { await js(`(() => { const f = document.querySelector('.inspo-add .input'); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event('input', { bubbles: true })); f.form.requestSubmit(); })()`); await sleep(900); };

  await win.loadURL(`${BASE}/#/inspiration`);
  await sleep(3000);
  const appHead = await js(head);
  check('the head names the two scopes: the open project\'s app and "For you"', appHead.scopes.join(' | ') === 'Sample Check\'s app | For you' && appHead.pressed.join() === 'Board' && appHead.count === 'Sample Check · 3 cards', appHead);
  await shot('studio-look-01-app-board-1280.jpg');

  await clickText('.inspo-head .seg button', 'Studio look');
  let h = await js(head);
  let p = await js(panel);
  check('Studio look has its own address, its own empty board and a sentence saying it restyles the studio for you, not the project', h.hash === '#/inspiration/look' && h.pressed.join() === 'Studio look' && h.count === 'Studio look · 0 cards' && /^Nothing collected for the studio's look yet/.test(h.empty || '') && p.scope === 'Restyles the studio for you, on this computer. It is not Sample Check\'s app board, and no worker reads it.' && /placeholder|look/.test(h.placeholder), [h, p.scope]);
  check('on the Studio look, Make a look is the one primary action in sight', p.make && p.make.primary && p.primaries.join() === 'Make a look', p);

  for (const v of ['#f3e9d7', '#2f7f79', '#173b3a', '#e0b98a', 'Bookish and calm: a Garamond for headings, nothing loud.', 'Paper and sea glass. Rounded cards like pebbles.', 'Warm cream paper, teal ink, a little sand.']) await type(v);
  await sleep(800);
  h = await js(head);
  check('seven cards added through the one field land on the Studio look board', h.cards === 7 && h.count === 'Studio look · 7 cards', h);
  check('they are kept in the data folder, not in either project', (await api('GET', '/api/studio-look/board')).data.cards.length === 7 && await appBoards() === boardsBefore);
  await shot('studio-look-02-board-1280.jpg');

  const start = await js(root);
  await clickText('.inspo-head .btn', 'Make a look');
  p = await js(panel);
  const previewed = await js(root);
  const rows = Object.fromEntries(p.rows.map((r) => [r[0], r]));
  check('Make a look proposes canvas, panel, ink, accent, display font and corners, each saying where it came from', p.rows.map((r) => r[0]).join() === 'Canvas,Panel,Ink,Accent,Display font,Corners' && /173b3a/.test(rows.Canvas[2]) && /f3e9d7/.test(rows.Ink[2]) && rows['Display font'][1] === 'Garamond' && /Garamond/.test(rows['Display font'][2]) && rows.Corners[1] === 'Round' && /Rounded cards/.test(rows.Corners[2]), p.rows);
  check('it says every text and surface pair passes AA, with the lowest', /^Every text and surface pair passes AA: \d+ pairs, the lowest .+ at (4\.[5-9]|[5-9]\.\d|\d\d\.\d):1\.$/.test(p.pairs || ''), p.pairs);
  check('the proposal shows over the whole studio at once: the canvas, the face and the corners on the root', start.bg === '#232221' && previewed.bg === rows.Canvas[1] && /Garamond/.test(previewed.serif) && previewed.r2 === '14px', [start, previewed]);
  check('nothing is kept yet, and Apply is now the one primary action', JSON.stringify((await facts()).stored) === '{}' && p.apply && p.apply.primary && !p.apply.off && p.again && p.primaries.join() === 'Apply', [p.apply, p.primaries]);
  check('the line names the locked defaults the look differs from', p.lock === 'Your look sets --bg, --ink, --accent and --serif away from Studio Check\'s locked defaults. Those locks bind the studio\'s source code; your look is a layer on top, for you only.', p.lock);
  await shot('studio-look-03-proposal-1280.jpg');

  await clickText('.slook-proposal .btn', 'Apply');
  p = await js(panel);
  let f = await facts();
  const applied = await js(root);
  check('Apply keeps the look in the person\'s settings, and the fixed rules refuse nothing', f.stored.surfaces?.dark?.canvas === rows.Canvas[1] && f.stored.display === 'garamond' && f.stored.radius === 'round' && f.locked.length === 4 && f.undo?.words === 'the look before Apply', f);
  check('the page keeps showing it once the preview has ended', applied.bg === rows.Canvas[1] && applied.body !== 'rgb(35, 34, 33)', applied);
  check('the panel says the look in effect and offers Undo', /^Your look in the dark theme: canvas #/.test(p.now) && p.undo && p.apply === null, [p.now, p.undo]);
  await shot('studio-look-04-applied-1280.jpg');
  for (const [hash, name] of [['#/workbench', 'workbench'], ['#/tasks', 'tasks'], ['#/settings', 'settings']]) {
    await go(hash);
    check(`${name}: the whole studio wears the look`, (await js(root)).bg === rows.Canvas[1], await js(root));
    await shot(`studio-look-05-${name}-1280.jpg`);
  }
  const settings = await js(`(() => { const s = document.getElementById('appearance'); return { lines: [...s.querySelectorAll('.look-lock')].filter((n) => !n.hidden).map((n) => n.textContent), board: s.querySelector('.look-sub')?.textContent, swatches: [...s.querySelectorAll('.look-board .look-swatch')].map((b) => b.title), disabled: [...s.querySelectorAll('button, input')].filter((b) => b.disabled).map((b) => b.textContent || b.name) }; })()`);
  check('Settings: one line on the locked defaults, the surfaces named as the Studio look\'s, and no control disabled by a lock', settings.lines.length === 2 && settings.lines[0].startsWith('Your look sets --bg, --ink, --accent and --serif away') && settings.lines[1].startsWith('The surfaces and the display font (Garamond) come from Inspiration › Studio look.') && !settings.disabled.some((d) => /Comfortable|Compact|look-accent/.test(d)), settings);
  check('Settings offers the Studio look board\'s colours as accent presets, not the project\'s', settings.board === 'From your Studio look board' && settings.swatches.length === 4 && !settings.swatches.some((t) => /walnut|linen|amber/.test(t)), settings);

  // A real reload finds the look and the Undo.
  await win.loadURL(`${BASE}/#/inspiration/look`);
  await sleep(3000);
  p = await js(panel);
  check('after a reload the look is on the page and Undo is still offered', (await js(root)).bg === rows.Canvas[1] && p.undo && !p.hidden, [await js(root), p.undo]);

  // The wide screen.
  await size(1920, 1080);
  await shot('studio-look-06-applied-1920.jpg');
  await go('#/workbench');
  await shot('studio-look-07-workbench-1920.jpg');
  await go('#/inspiration/look');

  // The light theme: its own look from the same board, cream on the canvas and teal as the accent.
  await js(`document.getElementById('theme-toggle').click()`);
  await sleep(1200);
  const lightStart = await js(root);
  check('in the light theme the dark look does not apply: the studio\'s own light canvas', lightStart.theme === 'light' && lightStart.bg === '#f3f1ec', lightStart);
  await clickText('.inspo-head .btn', 'Make a look');
  p = await js(panel);
  const lightRows = Object.fromEntries(p.rows.map((r) => [r[0], r]));
  check('a light look from the same board: the cream canvas and the teal accent made darker to pass', /warm|cream|f3e9d7/.test(lightRows.Canvas[2]) && /2f7f79/.test(lightRows.Accent[2]) && /made darker/.test(lightRows.Accent[2]) && /For the light theme/.test(p.lead || ''), p.rows);
  await clickText('.slook-proposal .btn', 'Apply');
  f = await facts();
  check('Apply keeps the light surfaces beside the dark ones', !!f.stored.surfaces?.dark && f.stored.surfaces?.light?.canvas === lightRows.Canvas[1] && (await js(root)).bg === lightRows.Canvas[1], f.stored.surfaces);
  await shot('studio-look-08-light-1920.jpg');
  await go('#/workbench');
  await shot('studio-look-09-light-workbench-1920.jpg');
  await go('#/inspiration/look');
  await js(`document.getElementById('theme-toggle').click()`);
  await sleep(1200);

  // Reset, Undo, Reset.
  await size(1280, 720);
  await clickText('.slook .btn', 'Reset to defaults');
  f = await facts();
  const reset = await js(root);
  check('Reset to defaults brings the studio back: nothing stored, the canvas, ink, accent, face and corners its own', JSON.stringify(f.stored) === '{}' && reset.bg === '#232221' && reset.ink === '#ece8e1' && reset.accent === '#d6a455' && /^"Source Serif 4"/.test(reset.serif) && reset.r2 === '8px', [f.stored, reset]);
  p = await js(panel);
  check('after Reset the line about the locks is gone and Undo is offered', p.lock === null && p.undo, p);
  await shot('studio-look-10-reset-1280.jpg');
  await clickText('.slook .btn', 'Undo');
  check('Undo brings the look back', (await js(root)).bg === rows.Canvas[1] && !!(await facts()).stored.surfaces?.light);
  await clickText('.slook .btn', 'Reset to defaults');
  check('and Reset takes it off again', JSON.stringify((await facts()).stored) === '{}' && (await js(root)).bg === '#232221');

  check('the product\'s app board and the studio project\'s app board are unchanged throughout', await appBoards() === boardsBefore);
  check('no error in the page console', errors.length === 0, errors);
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1), (err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(1); }));
