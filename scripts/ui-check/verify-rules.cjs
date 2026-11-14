// Fixed rules (docs/DESIGN.md section 11, docs/ARCHITECTURE.md section 23), driven in a real window: the Board |
// Fixed rules switch in the Inspiration view and its address, the empty state, Add rule through the dialog, a refused
// token name and a refused value kept in the dialog, a rule that locks a token with its swatch, a rule arriving from
// outside the window, Edit by Enter, Remove after one question, a reload that finds the rules, another project showing
// its own, a paste that adds no card while the rules are shown, and the layout at 1280, 1920 and 1000 px and in the
// light theme with the studio's own seed rules (server/lib/rules-seed.mjs) on a throwaway project.
// A private server (temp data and projects, a port the system picks): it never touches the studio on 4747 or
// ~/.atelier. Offscreen.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-rules.cjs
// Writes .local/shot-live/rules-*.jpg and prints the checks as JSON; exit 0 when every check holds.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'shot-live');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-rules-'));
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
  // Every check with what was seen goes to a file; the terminal gets one line per check and what a failed one saw.
  fs.writeFileSync(path.join(OUT, 'rules-results.json'), JSON.stringify(results, null, 1));
  for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : `\n     ${JSON.stringify(r.seen)}`));
  console.log(results.filter((r) => r.ok).length + ' of ' + results.length + ' checks hold');
  server?.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 150000);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: path.join(tmp, 'projects'), ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') };
  delete env.ELECTRON_RUN_AS_NODE;
  const api = async (method, p, body) => { const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, data: await res.json().catch(() => null) }; };
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 100) throw new Error('server did not start');
    await sleep(200);
  }
  const one = (await api('POST', '/api/projects', { name: 'Rules Check', kind: 'web-app', template: 'web-app-notes' })).data.project;
  const two = (await api('POST', '/api/projects', { name: 'Other Check', kind: 'web-app', template: 'web-app-notes' })).data.project;
  await api('POST', `/api/projects/${two.id}/rules`, { text: 'The other project keeps one rule of its own', kind: 'tone' });
  const R = `/api/projects/${one.id}/rules`;

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { win.webContents.invalidate(); await sleep(600); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name), image.toJPEG(88)); return image; };
  // The colour of one point of a captured frame, as [r, g, b]: what the picture holds, not what the page says.
  const pixel = (image, x, y) => { const { width } = image.getSize(); const b = image.toBitmap(); const i = (Math.round(y) * width + Math.round(x)) * 4; return [b[i + 2], b[i + 1], b[i]]; };
  const key = async (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(350); };
  const pick = async (id) => { await js(`(() => { const s = document.querySelector('#project-pick select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`); await sleep(1800); };
  const visible = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((n) => n.getClientRects().length)`;
  const state = `(() => { const r = document.querySelector('.inspo'); if (!r) return null; const rules = [...r.querySelectorAll('.rule')];
    return { hash: location.hash, tab: document.querySelector('#view-tabs a[aria-current="page"]')?.textContent, seg: [...r.querySelectorAll('.inspo-head .seg button')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.textContent + ']' : b.textContent)),
      head: r.querySelector('.inspo-count').textContent, primaries: ${visible('.inspo .btn.primary')}.map((b) => b.textContent), boardShown: !!r.querySelector('.inspo-scroll').getClientRects().length, fieldShown: !!r.querySelector('.inspo-add').getClientRects().length,
      fill: r.querySelector('.rules-fill').hidden ? null : r.querySelector('.rules-fill').textContent, groups: [...r.querySelectorAll('.rules-group')].map((g) => g.querySelector('.rules-kind').textContent + ': ' + g.querySelectorAll('.rule').length),
      rules: rules.map((n) => n.querySelector('.rule-text').textContent), focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName }; })()`;
  const dialogState = `(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, labels: [...d.querySelectorAll('.field > label')].map((l) => l.textContent), kinds: [...d.querySelectorAll('select option')].map((o) => o.textContent),
    hint: d.querySelector('.rules-token .hint')?.textContent, reason: d.querySelector('.note.danger')?.hidden ? null : d.querySelector('.note.danger')?.textContent, buttons: [...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent), focus: document.activeElement?.name || document.activeElement?.tagName, swatch: !d.querySelector('.rules-swatch').hidden }; })()`;
  const fill = (fields) => js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const set = (name, v) => { const f = d.querySelector('[name="' + name + '"]'); f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); };
    for (const [k, v] of Object.entries(${JSON.stringify(fields)})) set(k, v); })()`);
  const press = (words) => js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => b.textContent === ${JSON.stringify(words)}).click()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await pick(one.id);
  await js(`document.getElementById('main').focus()`);
  await key('3');
  await sleep(1200);
  const board = await js(state);
  check('key 3 opens Inspiration on the board, with the switch beside the title', board?.hash === '#/inspiration' && board.seg.join(' ') === '[Board] Fixed rules References Visualizer' && board.boardShown && board.fieldShown && board.primaries.join() === 'Add', board);

  // The switch: its own address, the tab stays current, the board's field steps out, one primary button in sight.
  await js(`[...document.querySelectorAll('.inspo-head .seg button')].find((b) => b.textContent.startsWith('Fixed rules')).click()`);
  await sleep(700);
  const empty = await js(state);
  check('Fixed rules has its own address and keeps the Inspiration tab current', empty.hash === '#/inspiration/rules' && empty.tab === 'Inspiration' && empty.seg.join(' ') === 'Board [Fixed rules] References Visualizer', empty);
  check('only Add rule is in sight as a primary button; the board and its field are out of sight', empty.primaries.join() === 'Add rule' && !empty.boardShown && !empty.fieldShown, empty.primaries);
  check('the empty state says what a rule is', /^No fixed rules yet\./.test(empty.fill || '') && empty.head === 'Rules Check · 0 rules', [empty.fill, empty.head]);
  await shot('rules-empty-1280.jpg');

  // Add rule: the dialog, a rule with no kind refused in words, then saved.
  await js(`${visible('.inspo .btn.primary')}[0].click()`);
  await sleep(400);
  const dlg = await js(dialogState);
  check('the Add rule dialog: its fields, the six kinds, the hint, the focus in the rule field', dlg?.title === 'Add rule' && dlg.labels.join(' | ') === 'Rule | Kind | Why (optional) | Locked token | Its value' && dlg.kinds.join() === 'Choose a kind…,Color,Type,Layout,Motion,Tone,Behaviour' && /^Optional\. Locks one CSS custom property/.test(dlg.hint) && dlg.focus === 'rule-text' && dlg.buttons.join() === 'Cancel,Add rule', dlg);
  await fill({ 'rule-text': 'Motion 160 ms or less' });
  await press('Add rule');
  await sleep(700);
  const noKind = await js(dialogState);
  check('no kind chosen: the dialog stays, says to choose, and the focus is on Kind', /^Choose what kind of rule it is: color, type, layout, motion, tone, behaviour$/.test(noKind?.reason || '') && noKind.focus === 'rule-kind', noKind);
  await fill({ 'rule-kind': 'motion', 'rule-why': 'docs/DESIGN.md section 1' });
  await press('Add rule');
  await sleep(900);
  const first = await js(state);
  check('the rule is listed under its kind and holds the focus', first.rules.join() === 'Motion 160 ms or less' && first.groups.join() === 'Motion1: 1' && first.focus === 'Motion rule: Motion 160 ms or less' && first.head === 'Rules Check · 1 rule', first);

  // A locked token: a bad name, then a bad value, each refused in a sentence with the focus on its field; then kept.
  await js(`${visible('.inspo .btn.primary')}[0].click()`);
  await sleep(400);
  await fill({ 'rule-text': 'Amber is the one accent', 'rule-kind': 'color', 'rule-token-name': 'accent', 'rule-token-value': '#d6a455' });
  const swatchOn = (await js(dialogState)).swatch;
  await press('Add rule');
  await sleep(700);
  const badName = await js(dialogState);
  check('a token name that is no custom property is refused with a sentence, the focus on the name', /A locked token is a CSS custom property such as --accent: two dashes.*"accent" is not one/.test(badName?.reason || '') && badName.focus === 'rule-token-name', badName);
  await fill({ 'rule-token-name': '--accent', 'rule-token-value': 'red; background: url(x)' });
  await press('Add rule');
  await sleep(700);
  const badValue = await js(dialogState);
  check('a value that could end the declaration is refused with a sentence, the focus on the value', /A token's value is one CSS value: it cannot hold ;/.test(badValue?.reason || '') && badValue.focus === 'rule-token-value' && !badValue.swatch, badValue);
  check('nothing was added by the refusals', (await api('GET', R)).data.rules.length === 1);
  await fill({ 'rule-token-value': '#d6a455' });
  await press('Add rule');
  await sleep(900);
  const locked = await js(`(() => { const n = [...document.querySelectorAll('.rule')].find((r) => r.textContent.includes('Amber')); const s = n?.querySelector('.rules-swatch'); return n && { token: n.querySelector('.rule-token')?.textContent, code: n.querySelector('.rule-code')?.textContent, swatch: s && getComputedStyle(s).backgroundColor, font: getComputedStyle(n.querySelector('.rule-code')).fontFamily.split(',')[0] }; })()`);
  check('the rule shows its locked token in the mono with a swatch of the value', swatchOn && locked?.token === 'Locks--accent: #d6a455' && locked.code === '--accent: #d6a455' && locked.swatch === 'rgb(214, 164, 85)' && /Cascadia|Consolas|monospace/.test(locked.font), locked);
  check('the record holds the lock', JSON.stringify((await api('GET', R)).data.locked.map((t) => [t.name, t.value])) === '[["--accent","#d6a455"]]');

  // A rule from outside the window (another window, the route, a hand edit) arrives by itself.
  await api('POST', R, { text: 'Chips only for states', kind: 'tone', why: 'docs/DESIGN.md sections 1 and 3' });
  await sleep(1200);
  const arrived = await js(state);
  check('a rule added elsewhere appears without a reload, by kind', arrived.rules.join(' | ') === 'Amber is the one accent | Motion 160 ms or less | Chips only for states' && arrived.groups.join() === 'Color1: 1,Motion1: 1,Tone1: 1' && arrived.head === 'Rules Check · 3 rules · 1 locked token', arrived);
  check('the switch counts the rules', (await js(`document.querySelector('.inspo-seg-n').textContent`)) === '3');

  // Edit by Enter on the focused rule; nothing changed closes without a write.
  await js(`[...document.querySelectorAll('.rule')].find((r) => r.textContent.includes('Chips')).focus()`);
  await key('Enter');
  const editDlg = await js(dialogState);
  check('Enter on a rule opens Edit rule with its values and no blank kind', editDlg?.title === 'Edit rule' && editDlg.kinds.join() === 'Color,Type,Layout,Motion,Tone,Behaviour' && editDlg.buttons.join() === 'Cancel,Save', editDlg);
  await fill({ 'rule-text': 'Chips only for states; kinds and modes are plain words' });
  await press('Save');
  await sleep(900);
  const edited = await js(state);
  check('the edit shows and the rule holds the focus again', edited.rules.includes('Chips only for states; kinds and modes are plain words') && edited.focus === 'Tone rule: Chips only for states; kinds and modes are plain words', edited);

  // While the rules are shown, a paste adds no card to the board.
  await js(`(() => { document.getElementById('main').focus(); const dt = new DataTransfer(); dt.setData('text/plain', '#ff0000'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await sleep(900);
  check('a paste on the rules adds no card', (await api('GET', `/api/projects/${one.id}/inspiration`)).data.cards.length === 0);

  // Remove asks once: Keep it leaves the rule, Remove takes it.
  await js(`[...document.querySelectorAll('.rule')].find((r) => r.textContent.includes('Motion')).focus()`);
  await key('Delete');
  const ask = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, words: d.querySelector('.dialog-body').textContent, buttons: [...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent) }; })()`);
  check('Delete asks once, in words that say what stops', ask?.title === 'Remove rule' && ask.words === "Remove this rule from Rules Check's fixed rules? Claude will no longer be told to keep it." && ask.buttons.join() === 'Keep it,Remove', ask);
  await press('Keep it');
  await sleep(400);
  const kept = (await js(state)).rules.length;
  await js(`[...document.querySelectorAll('.rule')].find((r) => r.textContent.includes('Motion')).focus()`);
  await key('Delete');
  await press('Remove');
  await sleep(1000);
  const removed = await js(state);
  check('Keep it keeps the rule; Remove takes it and the focus goes to the next rule', kept === 3 && removed.rules.length === 2 && !removed.rules.some((t) => t.includes('Motion')) && /^Tone rule/.test(removed.focus || ''), { kept, removed });

  // A reload finds the same part and the same rules; another project shows its own.
  win.webContents.reloadIgnoringCache();
  await sleep(3500);
  const reloaded = await js(state);
  check('a reload stays on Fixed rules with the rules as they were', reloaded?.hash === '#/inspiration/rules' && reloaded.seg.join(' ') === 'Board [Fixed rules2] References Visualizer' && reloaded.rules.join(' | ') === removed.rules.join(' | '), reloaded);
  await pick(two.id);
  const other = await js(state);
  check('switching the project shows that project\'s rules', other.rules.join() === 'The other project keeps one rule of its own' && other.head === 'Other Check · 1 rule', other);
  await pick(one.id);
  const back = await js(state);
  check('and back', back.rules.join(' | ') === removed.rules.join(' | ') && back.head === 'Rules Check · 2 rules · 1 locked token', back);

  // The layout with the studio's own seed rules: laptop, wide, small, light.
  for (const r of (await api('GET', R)).data.rules) await api('DELETE', `${R}/${r.id}`);
  const { STUDIO_RULES } = await import(pathToFileURL(path.join(ROOT, 'server', 'lib', 'rules-seed.mjs')).href);
  for (const seed of STUDIO_RULES) { const r = await api('POST', R, seed); if (r.status !== 200) throw new Error(`seed refused: ${JSON.stringify(r.data)}`); }
  await sleep(1500);
  const geometry = `(() => { const host = document.querySelector('.rules'); const rows = [...host.querySelectorAll('.rule')].map((n) => n.getBoundingClientRect()); const cols = [...new Set(rows.map((r) => Math.round(r.left)))].sort((a, b) => a - b); let overlaps = 0;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) { const p = rows[i], q = rows[j]; if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) overlaps++; }
    const head = document.querySelector('.inspo-head'); const text = [...host.querySelectorAll('.rule-text')].map((n) => n.getBoundingClientRect().width);
    return { window: innerWidth + 'x' + innerHeight, rules: rows.length, columns: cols.length, columnWidth: Math.round(rows[0]?.width || 0), widestText: Math.round(Math.max(...text)), overlaps, cutRows: rows.filter((r) => r.height > 400).length, sideways: host.scrollWidth - host.clientWidth, pageSideways: document.documentElement.scrollWidth - innerWidth, headFits: head.scrollWidth <= head.clientWidth, scrolls: host.scrollHeight > host.clientHeight }; })()`;
  const laptop = await js(geometry);
  check('1280×720: two columns, nothing overlaps, no sideways scroll, the head fits', laptop.rules === STUDIO_RULES.length && laptop.columns === 2 && laptop.overlaps === 0 && laptop.sideways === 0 && laptop.pageSideways <= 0 && laptop.headFits && laptop.widestText <= 640, laptop);
  await shot('rules-1280.jpg');
  // The focus by the keyboard, as a person reaches a rule: from its Edit button, Shift+Tab lands on the rule itself.
  win.webContents.focus(); // a hidden window's page has no focus, and :focus matches nothing without it
  await sleep(300);
  await js(`document.querySelector('.rule .rule-actions button').focus()`);
  await key('Tab', ['shift']);
  const focusLook = await js(`(() => { const n = document.activeElement; const a = n.querySelector('.rule-actions'); const cs = getComputedStyle(n); return { isRule: n.classList.contains('rule'), hasFocus: document.hasFocus(), focus: n.matches(':focus'), focusVisible: n.matches(':focus-visible'), outline: cs.outlineStyle, actions: getComputedStyle(a).opacity, buttons: [...a.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) }; })()`);
  check('a focused rule shows its ring and its actions, each button named', focusLook.isRule && focusLook.outline === 'solid' && focusLook.actions === '1' && focusLook.buttons.join(' | ') === 'Edit this rule (Enter) | Remove this rule (Delete)', focusLook);
  await sleep(300);
  await shot('rules-focus-1280.jpg');
  win.setSize(1920, 1080); await sleep(1200);
  const wide = await js(geometry);
  check('1920×1080: three columns of a readable measure, nothing overlaps, no sideways scroll', wide.columns === 3 && wide.overlaps === 0 && wide.sideways === 0 && wide.pageSideways <= 0 && wide.headFits && wide.widestText <= 640, wide);
  await shot('rules-1920.jpg');
  win.setSize(1000, 700); await sleep(1200);
  const small = await js(geometry);
  check('1000×700: still no overlap and no sideways scroll', small.overlaps === 0 && small.sideways === 0 && small.pageSideways <= 0, small);
  await shot('rules-1000.jpg');
  win.setSize(1280, 720); await sleep(800);
  await js(`${visible('.inspo .btn.primary')}[0].click()`);
  await sleep(500);
  await fill({ 'rule-text': 'A rule being written', 'rule-kind': 'color', 'rule-token-name': '--panel', 'rule-token-value': '#2a2927' });
  await shot('rules-dialog-1280.jpg');
  const dialogBox = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const r = d.getBoundingClientRect(); return { width: Math.round(r.width), fits: r.bottom <= innerHeight && r.top >= 0, sideways: d.querySelector('.dialog-body').scrollWidth - d.querySelector('.dialog-body').clientWidth }; })()`);
  check('the dialog fits the laptop window with no sideways scroll', dialogBox.fits && dialogBox.sideways <= 0, dialogBox);
  await js(`document.querySelector('dialog.dialog[open] .dialog-head button').click()`);
  await sleep(300);
  await js(`document.getElementById('theme-toggle').click()`); await sleep(600);
  const light = await js(`({ theme: document.documentElement.dataset.theme, ink: getComputedStyle(document.querySelector('.rule-text')).color, line: getComputedStyle(document.querySelector('.rule')).borderTopColor })`);
  check('the light theme draws the rules from its own tokens', light.theme === 'light' && light.ink === 'rgb(31, 28, 24)', light);
  // A hidden window can hand back an older frame after a theme switch: a nudge of its size makes it paint, and the
  // picture itself is read to see that it is the light one.
  win.setSize(1282, 720); await sleep(500); win.setSize(1280, 720); await sleep(900);
  const lightShot = await shot('rules-light-1280.jpg');
  const corner = pixel(lightShot, 6, lightShot.getSize().height - 6);
  check('the captured picture is the light theme', corner[0] > 200 && corner[1] > 200 && corner[2] > 190, corner);
  await js(`document.getElementById('theme-toggle').click()`); await sleep(300);

  // Back to the board: its field and its one primary button return.
  await js(`[...document.querySelectorAll('.inspo-head .seg button')].find((b) => b.textContent === 'Board').click()`);
  await sleep(600);
  const again = await js(state);
  check('Board brings the board back, with Add as the one primary button', again.hash === '#/inspiration' && again.boardShown && again.fieldShown && again.primaries.join() === 'Add' && again.head === 'Rules Check · 0 cards', again);
  await shot('rules-board-1280.jpg');
  check('no console errors', errors.length === 0, errors);
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(2); });
