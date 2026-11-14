// Skills by department: the department folders (a real mouse click and real Enter and Space keys open and close them,
// each with its count), the Unplaced folder sorted by suggestion, confirming one suggestion and a Place all, ticking a
// second department (the shared marker), a skill's folder line and the places list (the reveal request is caught in the
// page, so no file manager window opens), the SKILL.md dialog's folder line, the Departments dialog (add, rename), the
// task form's department choice, and the restart line for a server older than the tab (the page's fetch answers as an
// old server would, then a project switch reloads the tab). Offscreen. It changes the studio-wide departments, so run it
// only against a second studio server with throwaway data (ATELIER_PORT, ATELIER_DATA_DIR, ATELIER_PROJECTS_DIR,
// ATELIER_PID_FILE), never the person's own.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-skill-departments.cjs <project> <other project> <baseUrl>
// Writes .local/shot-live/skills-dept*.jpg and prints the facts as JSON.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(path.resolve(__dirname, '..', '..'), '.local', 'shot-live');
const [projectName = '', otherName = '', BASE = 'http://127.0.0.1:4791'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (/:4747\b/.test(BASE)) { console.log(JSON.stringify({ error: 'refused: this driver changes the studio-wide departments; use a second server' })); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const STAMP = Date.now().toString(36).slice(-4); // new names each run, so a second run adds and renames too
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
setTimeout(() => { console.log(JSON.stringify({ error: 'timed out' })); app.exit(2); }, 150000);

app.whenReady().then(async () => {
  const facts = {};
  try {
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => { win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toJPEG(85)); };
    const key = (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'char', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
    const mouse = async (sel) => {
      const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!r) return false;
      win.webContents.sendInputEvent({ type: 'mouseDown', ...r, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...r, button: 'left', clickCount: 1 });
      return true;
    };
    const pick = (name) => js(`(() => { const s = document.querySelector('#project-pick select'); const o = [...(s?.options || [])].find((x) => x.textContent.replace('● ', '') === ${JSON.stringify(name)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
    const folders = `[...document.querySelectorAll('.skills-panel .sk-folder-head')].map((h) => h.querySelector('.sk-folder-name').textContent + ' · ' + h.querySelector('.sk-folder-count').textContent + (h.getAttribute('aria-expanded') === 'true' ? ' (open)' : ''))`;
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2500);
    await js(`sessionStorage.removeItem('atelier.skillsOpen'); sessionStorage.removeItem('atelier.skillsFilter')`);
    facts.picked = await pick(projectName);
    await sleep(2500);
    facts.clicked = await js(`(() => { const b = [...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim().startsWith('Skills')); if (!b) return false; b.click(); return true; })()`);
    await sleep(2000);
    const panel = `(() => { const p = document.querySelector('.skills-panel'); return { summary: p.querySelector('.sk-count')?.textContent, notice: p.querySelector('.sk-notice').hidden ? null : p.querySelector('.sk-notice').textContent,
      folders: ${folders}, subs: [...p.querySelectorAll('.sk-sub-head')].map((s) => s.textContent).slice(0, 8),
      cardsInClosed: [...p.querySelectorAll('.sk-folder-body[hidden] .sk-card')].length, intro: p.querySelector('.sk-intro').textContent.slice(0, 120),
      headButtons: [...p.querySelectorAll('.sk-head button')].map((b) => b.textContent + (b.disabled ? ' [disabled]' : '')), sideways: p.scrollWidth - p.clientWidth }; })()`;
    facts.first = await js(panel);
    await shot('skills-dept.jpg');

    // Folders: a real mouse click on Design's head opens it; Enter on the focused head closes it, Space opens it again.
    facts.mouse = await mouse('#sk-dept-design');
    await sleep(300);
    facts.afterClick = await js(`document.getElementById('sk-dept-design').getAttribute('aria-expanded') + ' · body ' + (document.getElementById('sk-dept-design-body').hidden ? 'hidden' : 'shown') + ' · ' + document.getElementById('sk-dept-design-body').textContent.slice(0, 80)`);
    await js(`document.getElementById('sk-dept-design').focus()`);
    key('Enter'); await sleep(300);
    facts.afterEnter = await js(`document.getElementById('sk-dept-design').getAttribute('aria-expanded') + ' · focus on ' + document.activeElement?.id`);
    key('Space'); await sleep(300);
    facts.afterSpace = await js(`document.getElementById('sk-dept-design').getAttribute('aria-expanded')`);
    key('Enter'); await sleep(200);

    // Confirm the first suggestion on a card: it leaves Unplaced; the focus goes to the next Unplaced card; the line says where it went.
    facts.placed = await js(`(() => { const b = document.querySelector('.skills-panel .sk-unplaced .sk-card .sk-suggest button'); if (!b) return null; const name = b.closest('.sk-card').dataset.skill; const words = b.textContent; b.click(); return { name, words }; })()`);
    await sleep(1200);
    const name = facts.placed?.name;
    facts.said = await js(`document.querySelector('.skills-panel .sk-said').textContent`);
    facts.focusAfterPlace = await js(`(document.activeElement?.className || '') + ' ' + (document.activeElement?.closest('.sk-card')?.dataset.skill || document.activeElement?.id || '')`);
    facts.foldersAfterPlace = await js(folders);
    // Open its department by its head to see it there, then tick a second department on its card: shared in both.
    const dept = await js(`(() => { const h = [...document.querySelectorAll('.skills-panel .sk-folder-head')].find((x) => x.querySelector('.sk-folder-count').textContent !== '0' && x.id !== 'sk-dept--unplaced'); h.click(); return h.id; })()`);
    await sleep(300);
    const where = `[...document.querySelectorAll('.skills-panel .sk-card')].filter((c) => c.dataset.skill === ${JSON.stringify(name)} && !c.closest('[hidden]')).map((c) => c.closest('section').querySelector('.sk-folder-name').textContent + (c.querySelector('.sk-shared') ? ' [' + c.querySelector('.sk-shared').textContent + ']' : ''))`;
    facts.afterPlace = await js(where);
    facts.ticked = await js(`(() => { const c = [...document.querySelectorAll('.skills-panel .sk-card')].find((x) => x.dataset.skill === ${JSON.stringify(name)} && !x.closest('[hidden]')); const d = c.querySelector('details.sk-depts'); d.open = true; const box = [...d.querySelectorAll('label.sk-dept-box')].find((l) => !l.querySelector('input').checked); const label = box.textContent; box.querySelector('input').focus(); box.querySelector('input').click(); return label; })()`);
    await sleep(1200);
    await js(`(() => { const h = [...document.querySelectorAll('.skills-panel .sk-folder-head')].find((x) => x.querySelector('.sk-folder-name').textContent === ${JSON.stringify(facts.ticked)}); if (h && h.getAttribute('aria-expanded') !== 'true') h.click(); })()`);
    await sleep(300);
    facts.afterTick = await js(where);
    facts.focusAfterTick = await js(`(() => { const a = document.activeElement; return a?.type + ' ' + (a?.closest('label')?.textContent || '') + ' in ' + (a?.closest('section')?.querySelector('.sk-folder-name')?.textContent || ''); })()`);
    facts.openDept = dept;

    // Place all: the first sub-group's button confirms every suggestion in it.
    facts.placeAll = await js(`(() => { const b = [...document.querySelectorAll('.skills-panel .sk-sub-head button')].find((x) => x.textContent.startsWith('Place all')); if (!b) return null; const w = b.textContent; b.click(); return w; })()`);
    await sleep(1500);
    facts.saidAfterAll = await js(`document.querySelector('.skills-panel .sk-said').textContent`);
    facts.foldersAfterAll = await js(folders);
    await js(`document.querySelector('.skills-panel').scrollTop = 0`);
    await sleep(300);
    await shot('skills-dept-folders.jpg');

    // A skill's folder line: the request is caught in the page (no window opens) and answered as the server would.
    await js(`(() => { const real = window.fetch; window.__revealed = []; window.fetch = async (url, opts) => {
      if (String(url).includes('/api/skills/reveal')) { const b = JSON.parse(opts.body); window.__revealed.push(b); return new Response(JSON.stringify({ opened: b.path, kind: 'skill' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      return real(url, opts); }; })()`);
    facts.where = await js(`(() => { const b = [...document.querySelectorAll('.skills-panel .sk-card .sk-where')].find((x) => !x.closest('[hidden]')); const card = b.closest('.sk-card'); b.click(); return { shown: b.textContent, title: b.title, path: card.dataset.path }; })()`);
    await sleep(600);
    facts.revealed = await js(`window.__revealed`);
    facts.toast = await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).slice(-1)[0] || null`);
    facts.places = await js(`(() => { const d = document.querySelector('.skills-panel details.sk-places'); d.open = true; return [...d.querySelectorAll('li')].map((li) => (li.querySelector('button.sk-where') ? '[button] ' : '[text] ') + li.textContent); })()`);
    await js(`document.querySelector('.skills-panel details.sk-places').scrollIntoView({ block: 'end' })`);
    await sleep(300);
    await shot('skills-dept-places.jpg');
    // SKILL.md: the name opens it; its folder line is a button too.
    await js(`[...document.querySelectorAll('.skills-panel .sk-card .sk-name')].find((x) => !x.closest('[hidden]')).click()`);
    await sleep(1200);
    facts.file = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, where: d.querySelector('.sk-file-where')?.textContent, whereIsButton: !!d.querySelector('.sk-file-where button.sk-where'), text: d.querySelector('pre.sk-text')?.textContent.slice(0, 30) }; })()`);
    await shot('skills-dept-file.jpg');
    await js(`document.querySelector('dialog.dialog[open] .dialog-head button').click()`);
    await sleep(400);

    // The Departments dialog: add a department, rename the second one, a name that is taken.
    await js(`[...document.querySelectorAll('.skills-panel .sk-head button')].find((b) => b.textContent === 'Departments').click()`);
    await sleep(400);
    facts.dialogOpen = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, rows: [...d.querySelectorAll('.sk-dept-row')].map((r) => r.querySelector('input').value + ' · ' + r.querySelector('.meta').textContent) }; })()`);
    await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const i = d.querySelector('.sk-dept-add input'); i.value = 'Sound ' + ${JSON.stringify(STAMP)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(800);
    await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const i = d.querySelectorAll('.sk-dept-row input')[1]; i.value = 'Experience ' + ${JSON.stringify(STAMP)}; i.dispatchEvent(new Event('change')); })()`);
    await sleep(800);
    facts.dialogAfter = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return { rows: [...d.querySelectorAll('.sk-dept-row')].map((r) => r.querySelector('input').value), status: d.querySelector('.sk-dept-status').textContent }; })()`);
    await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const i = d.querySelector('.sk-dept-add input'); i.value = 'design'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(800);
    facts.dialogDupe = await js(`document.querySelector('dialog.dialog[open] .sk-dept-status').textContent`);
    await shot('skills-dept-dialog.jpg');
    await js(`document.querySelector('dialog.dialog[open] .dialog-head button').click()`);
    await sleep(500);
    facts.foldersAfterDialog = await js(folders);

    // The task form's department choice follows the list.
    await js(`[...document.querySelectorAll('.collab-head button')].find((b) => !b.hidden && b.textContent.trim() === 'Tasks')?.click()`);
    await sleep(400);
    facts.form = await js(`(() => { const w = document.querySelector('details.composer-wrap'); if (w) w.open = true; const m = document.querySelector('details.composer-more'); m.open = true; const s = document.querySelector('select[aria-label="Department whose skills the worker uses"]'); s.value = s.options[1]?.value || ''; s.dispatchEvent(new Event('change')); return { options: [...s.options].map((o) => o.textContent), more: m.querySelector('summary').textContent }; })()`);
    await sleep(300);
    await js(`document.querySelector('details.composer-more')?.scrollIntoView({ block: 'center' })`);
    await shot('skills-dept-form.jpg');

    // An older server: the page's fetch answers /api/skills as one without the routes, then as one without departments.
    await js(`(() => { const real = window.fetch; window.__mode = 'noroute'; window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/api/skills?') && window.__mode === 'noroute') return new Response(JSON.stringify({ error: { code: 'not_found', message: 'No route GET /api/skills' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      if (u.includes('/api/skills?') && window.__mode === 'nodepts') { const r = await real(url, opts); const j = await r.json(); delete j.departments; return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); }
      return real(url, opts); }; })()`);
    await js(`[...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim().startsWith('Skills'))?.click()`);
    await pick(otherName);
    await sleep(2500);
    facts.noRoute = await js(panel);
    await shot('skills-dept-restart.jpg');
    await js(`window.__mode = 'nodepts'`);
    await pick(projectName);
    await sleep(2500);
    facts.noDepartments = await js(panel);
  } catch (err) { facts.error = err.message; }
  console.log(JSON.stringify(facts, null, 1));
  app.exit(0);
});
