// Settings › Appearance (docs/DESIGN.md section 12, docs/ARCHITECTURE.md section 24), driven in a real window: the
// section and its five controls, each choice applied live to the computed styles and kept by the route, the focus
// staying on the pressed button, a preset, a hex that fails AA kept as a proposal with the nearest shade, a colour
// card of the person's Studio look board as a preset, the picker's live preview, a real reload that finds the look,
// the light theme's own shade, a fixed rule of the studio project that locks --accent (named in one line, never
// disabling a control or refusing the look: decision row 186), Reset with Undo, and two looks captured at 1280×720 and 1920×1080.
// A private server (temp data and projects, a port the system picks): it never touches the studio on 4747 or
// ~/.atelier. Offscreen.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-appearance.cjs
// Writes .local/shot-live/appearance-*.jpg and prints the checks; exit 0 when every check holds.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-appearance-'));
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
  fs.writeFileSync(path.join(OUT, 'appearance-results.json'), JSON.stringify(results, null, 1));
  for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : `\n     ${JSON.stringify(r.seen)}`));
  console.log(results.filter((r) => r.ok).length + ' of ' + results.length + ' checks hold');
  server?.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 170000);
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
  const studio = (await api('POST', '/api/projects', { name: 'Studio Check', kind: 'studio' })).data.project;
  const one = (await api('POST', '/api/projects', { name: 'Look Check', kind: 'web-app', template: 'web-app-notes' })).data.project;
  // The presets come from the person's Studio look board, never from a project's app board.
  await api('POST', `/api/projects/${one.id}/inspiration`, { kind: 'color', hex: '#7a4b2a', name: 'walnut' });
  for (const card of [{ kind: 'note', text: 'Quiet surfaces, one accent' }, { kind: 'color', hex: '#232221', name: 'canvas' }, { kind: 'color', hex: '#79b3dc', name: 'sky' }, { kind: 'color', hex: '#5fbcab', name: 'teal' }]) await api('POST', '/api/studio-look/board', card);
  await api('POST', `/api/projects/${one.id}/activate`);
  const stored = async () => (await api('GET', '/api/settings/appearance')).data;

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const size = async (w, h) => { win.setSize(w + 2, h); await sleep(300); win.setSize(w, h); await sleep(900); };
  // A hidden window can hand back an older frame after a small change: a nudge of its size makes it paint first.
  const shot = async (name) => { const [w, h] = win.getSize(); await size(w, h); win.webContents.invalidate(); await sleep(500); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name), image.toJPEG(88)); return image; };
  const press = async (sel) => { await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.focus(); b.click(); })()`); await sleep(900); };
  const look = `(() => { const cs = (n) => (n ? getComputedStyle(n) : null); const root = getComputedStyle(document.documentElement); const btn = document.querySelector('.set-sec .btn:not(.sm)'); const v = (n) => root.getPropertyValue(n).trim();
    return { accent: v('--accent'), focus: v('--focus'), ink: v('--accent-ink'), t: v('--t'), motion: document.documentElement.dataset.motion || null, theme: document.documentElement.dataset.theme,
      btnH: btn && Math.round(btn.getBoundingClientRect().height), btnR: cs(btn)?.borderTopLeftRadius, body: cs(document.body).fontSize, meta: cs(document.querySelector('.look-intro'))?.fontSize, top: Math.round(document.querySelector('.topbar').getBoundingClientRect().height), tab: Math.round(document.querySelector('#view-tabs a').getBoundingClientRect().height), link: cs(document.querySelector('#view-tabs a'))?.transitionDuration, gap: v('--s4') }; })()`;
  const panel = `(() => { const s = document.getElementById('appearance'); if (!s) return null; const seg = (k) => [...s.querySelectorAll('[data-look="' + k + '"] .seg button')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.textContent + ']' : b.textContent) + (b.disabled ? '×' : ''));
    const sw = (sel) => [...s.querySelectorAll(sel + ' .look-swatch')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.title + ']' : b.title) + (b.disabled ? '×' : ''));
    const note = s.querySelector('.look-note'); const locks = [...s.querySelectorAll('.look-lock')].filter((n) => !n.hidden).map((n) => n.textContent);
    return { labels: [...s.querySelectorAll('.look-label')].map((n) => n.textContent), density: seg('density'), textSize: seg('textSize'), radius: seg('radius'), motion: seg('motion'), presets: sw('.look-accent'), board: sw('.look-board'), boardLabel: s.querySelector('.look-sub')?.textContent,
      pick: s.querySelector('.look-pick').value, pickOff: s.querySelector('.look-pick').disabled, hex: s.querySelector('.look-hex').value, hexOff: s.querySelector('.look-hex').disabled, note: note.hidden ? null : note.textContent, warn: note.classList.contains('warn'), locks,
      reset: [...s.querySelectorAll('.btn')].find((b) => b.textContent === 'Reset to defaults')?.disabled, focus: document.activeElement?.dataset?.v || document.activeElement?.title || document.activeElement?.name || document.activeElement?.tagName }; })()`;

  await win.loadURL(`${BASE}/#/settings`);
  await sleep(3000);
  const first = await js(panel);
  const firstLook = await js(look);
  const sections = await js(`[...document.querySelectorAll('.set-sec > .overline')].map((n) => n.textContent)`);
  check('Settings opens on Appearance, with Layout as the next section', sections[0] === 'Appearance' && sections[1] === 'Layout', sections);
  check('the section has its five controls, each at its default, and Reset has nothing to do', first?.labels.join() === 'Accent,Density,Text size,Corners,Motion' && first.density.join() === '[Comfortable],Compact' && first.textSize.join() === 'Small,[Default],Large,Larger' && first.radius.join() === 'Sharp,[Soft],Round' && first.motion.join() === '[Normal],Reduced' && first.reset === true, first);
  check('the accent starts on the studio\'s own, with six presets and the line saying its contrast', first.pick === '#d6a455' && first.hex === '#d6a455' && first.presets.length === 6 && first.presets[0] === '[Amber, #d6a455]' && /^#d6a455 is \d+\.\d:1 against the dark canvas \(text in the accent needs 4\.5:1\)\. The light theme shows #a86f17\.$/.test(first.note || ''), [first.pick, first.presets, first.note]);
  check('the Studio look board\'s colour cards are offered as presets, not the project\'s', first.boardLabel === 'From your Studio look board' && first.board.join(' | ') === 'teal, #5fbcab | sky, #79b3dc | canvas, #232221', [first.boardLabel, first.board]);
  const painted = await js(`[...document.querySelectorAll('#appearance .look-swatch')].map((b) => getComputedStyle(b).backgroundColor)`);
  check('every swatch is painted in its own colour', painted.length === 9 && painted[0] === 'rgb(214, 164, 85)' && painted[4] === 'rgb(121, 179, 220)' && painted[8] === 'rgb(35, 34, 33)' && new Set(painted.slice(0, 6)).size === 6, painted);
  check('the defaults on the page: 32 px buttons, 14 px text, 6 px corners, 140 ms', firstLook.btnH === 32 && firstLook.body === '14px' && firstLook.btnR === '6px' && firstLook.t === '140ms' && firstLook.top === 44 && firstLook.accent === '#d6a455', firstLook);
  await shot('appearance-01-default-1280.jpg');

  // Each choice applies at once, is kept by the route, and the pressed button keeps the focus.
  await press('[data-look="density"] .seg button[data-v="compact"]');
  const compact = await js(look);
  const compactPanel = await js(panel);
  check('Compact: buttons 28 px, the top bar 40 px, the tabs 24 px, at once; the spacing grid stays', compact.btnH === 28 && compact.top === 40 && compact.tab === 24 && compact.gap === '16px', compact);
  check('the pressed button is the chosen one and keeps the focus; Reset now has something to do', compactPanel.density.join() === 'Comfortable,[Compact]' && compactPanel.focus === 'compact' && compactPanel.reset === false, compactPanel);
  check('the route kept it, per person', JSON.stringify((await stored()).stored) === '{"density":"compact"}', (await stored()).stored);
  await press('[data-look="textSize"] .seg button[data-v="large"]');
  const large = await js(look);
  check('Large text: body 15 px and the meta line 13.5 px', large.body === '15px' && large.meta === '13.5px', large);
  await press('[data-look="radius"] .seg button[data-v="round"]');
  const round = await js(look);
  check('Round corners: a button\'s corner is 10 px', round.btnR === '10px', round);
  await press('[data-look="motion"] .seg button[data-v="reduced"]');
  const reduced = await js(look);
  check('Reduced motion: the token is 0 ms, the root says so, and a tab has no transition', reduced.t === '0ms' && reduced.motion === 'reduced' && /^0s/.test(reduced.link || ''), reduced);
  await press('[data-look="motion"] .seg button[data-v="normal"]');
  check('Normal brings motion back', (await js(look)).t === '140ms' && (await js(look)).motion === null);

  // A preset: saved for both themes, the light one its nearest shade that passes.
  await press('.look-accent .look-swatch[title="Sky, #79b3dc"]');
  const sky = await js(look);
  const skyPanel = await js(panel);
  const skyStored = (await stored()).stored.accent;
  check('the Sky preset is the accent at once, with a focus ring and button ink derived from it', sky.accent === '#79b3dc' && /^#[0-9a-f]{6}$/.test(sky.focus) && sky.ink === '#1c1a17', sky);
  check('it is marked as chosen (also on the board, where the same colour is a card) and stored with a light shade', skyPanel.presets.includes('[Sky, #79b3dc]') && skyPanel.board.includes('[sky, #79b3dc]') && skyStored.dark === '#79b3dc' && /^#[0-9a-f]{6}$/.test(skyStored.light) && skyPanel.note.includes(`The light theme shows ${skyStored.light}.`), [skyPanel.presets, skyPanel.board, skyStored, skyPanel.note]);

  // A hex that fails AA: refused in a sentence, kept as a proposal, nothing saved; the nearest shade is one press away.
  const type = async (value) => { await js(`(() => { const h = document.querySelector('.look-hex'); h.focus(); h.value = ${JSON.stringify(value)}; h.dispatchEvent(new Event('input', { bubbles: true })); h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`); await sleep(900); };
  await type('#3a3834');
  const dim = await js(panel);
  const offered = (dim.note.match(/passes is (#[0-9a-f]{6})\./) || [])[1];
  check('a dim hex is refused in words with the nearest shade that passes, and stays in the field', dim.warn && /^#3a3834 is 1\.\d:1 against the dark canvas \(#232221\): too close for the focus ring \(3:1\) and for text in the accent \(4\.5:1\)\. The nearest shade that passes is #[0-9a-f]{6}\.Use #[0-9a-f]{6}$/.test(dim.note) && dim.hex === '#3a3834', dim);
  check('nothing was saved and the page still shows the last accent', (await stored()).stored.accent.dark === '#79b3dc' && (await js(look)).accent === '#79b3dc');
  await shot('appearance-02-refused-accent-1280.jpg');
  await js(`[...document.querySelectorAll('.look-note .btn')].find((b) => b.textContent.startsWith('Use #')).click()`);
  await sleep(900);
  check('Use takes the offered shade: saved, on the page, and the line is plain again', (await stored()).stored.accent.dark === offered && (await js(look)).accent === offered && !(await js(panel)).warn, [offered, (await stored()).stored.accent]);
  await type('not a color');
  check('words that are no hex are refused as such', (await js(panel)).note.startsWith('An accent is a hex color such as #d6a455; "not a color" is not one.'), (await js(panel)).note);

  // A colour card of the board: one that passes is taken; the canvas itself is refused like any dim colour.
  await press('.look-board .look-swatch[title="teal, #5fbcab"]');
  check('a colour card of the board becomes the accent', (await stored()).stored.accent.dark === '#5fbcab' && (await js(look)).accent === '#5fbcab' && (await js(panel)).board.includes('[teal, #5fbcab]'), (await js(panel)).board);
  await press('.look-board .look-swatch[title="canvas, #232221"]');
  const canvasCard = await js(panel);
  check('the board\'s canvas card is refused with its sentence and changes nothing', canvasCard.warn && /^#232221 is 1\.0:1 against the dark canvas/.test(canvasCard.note) && (await stored()).stored.accent.dark === '#5fbcab', canvasCard.note);

  // The picker: a colour shows on the page while it is dragged, and is saved when it is let go.
  await js(`(() => { const p = document.querySelector('.look-pick'); p.value = '#d68aa6'; p.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  check('a colour being picked shows on the page before it is saved', (await js(look)).accent === '#d68aa6' && (await stored()).stored.accent.dark === '#5fbcab' && (await js(panel)).hex === '#d68aa6', [(await js(look)).accent, (await stored()).stored.accent]);
  await js(`document.querySelector('.look-pick').dispatchEvent(new Event('change', { bubbles: true }))`);
  await sleep(900);
  const rose = (await stored()).stored;
  check('letting go saves it', rose.accent.dark === '#d68aa6' && (await js(panel)).presets.includes('[Rose, #d68aa6]'), rose);

  // Look A (compact, large text, round, rose) in the section and on the Workbench, laptop and wide.
  await shot('appearance-03-look-a-settings-1280.jpg');
  await js(`location.hash = '#/workbench'`); await sleep(2500);
  await shot('appearance-04-look-a-workbench-1280.jpg');
  await size(1920, 1080);
  await shot('appearance-05-look-a-workbench-1920.jpg');
  await size(1280, 720);

  // A real reload finds the look: from the registry, and already in the first frame's copy.
  await js(`location.hash = '#/settings'`); await sleep(1200);
  win.webContents.reloadIgnoringCache();
  await sleep(3500);
  const again = await js(look);
  const copy = await js(`JSON.parse(localStorage.getItem('atelier.appearance') || 'null')`);
  check('after a reload the look is the same: rose, compact, 15 px, round', again.accent === '#d68aa6' && again.btnH === 28 && again.body === '15px' && again.btnR === '10px', again);
  check('the first frame has a copy of it for both themes', copy?.dark?.['--accent'] === '#d68aa6' && copy.light?.['--accent'] === rose.accent.light && copy.dark['--ctl-h'] === '28px', copy);
  const reloaded = await js(panel);
  check('and the section shows it', reloaded.density.join() === 'Comfortable,[Compact]' && reloaded.textSize.join() === 'Small,Default,[Large],Larger' && reloaded.radius.join() === 'Sharp,Soft,[Round]' && reloaded.pick === '#d68aa6', reloaded);

  // The light theme shows its own shade, which passes on the light canvas.
  await js(`document.getElementById('theme-toggle').click()`); await sleep(900);
  const light = await js(look);
  const lightPanel = await js(panel);
  check('the light theme shows the light shade of the accent', light.theme === 'light' && light.accent === rose.accent.light && lightPanel.pick === rose.accent.light && /against the light canvas \(text in the accent needs 4\.5:1\)\. The dark theme shows #d68aa6\.$/.test(lightPanel.note), [light, lightPanel.note]);
  await size(1280, 720);
  await shot('appearance-06-look-a-light-1280.jpg');
  await js(`document.getElementById('theme-toggle').click()`); await sleep(700);

  // A rule of the studio project that locks --accent binds the studio's source, not the person's look (decision row 186):
  // nothing is disabled or refused, and one line says the look differs from the locked default.
  const rule = (await api('POST', `/api/projects/${studio.id}/rules`, { text: 'Amber is the one accent: the primary action, links, focus and the selected item', kind: 'color', token: { name: '--accent', value: '#d6a455' } })).data;
  await sleep(1800);
  const locked = await js(panel);
  const lockedLook = await js(look);
  check('a rule that locks --accent disables nothing: the picker, the hex field and every swatch stay free', !locked.pickOff && !locked.hexOff && locked.presets.every((p) => !p.endsWith('×')) && locked.board.every((p) => !p.endsWith('×')), locked);
  check('one line says the look sets --accent away from the locked default', locked.locks.length === 1 && locked.locks[0] === 'Your look sets --accent away from Studio Check\'s locked default. Those locks bind the studio\'s source code; your look is a layer on top, for you only.', locked.locks);
  check('the stored accent stays in effect, and the other choices too', lockedLook.accent === '#d68aa6' && lockedLook.btnH === 28 && lockedLook.btnR === '10px', lockedLook);
  const around = await js(`fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appearance: { accent: { dark: '#5fbcab' } } }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  check('the route keeps a new accent though the rule locks --accent', around.status === 200 && around.body.appearance?.accent?.dark === '#5fbcab', around);
  await shot('appearance-07-locked-accent-1280.jpg');
  await api('PATCH', '/api/settings', { appearance: { accent: { dark: '#d68aa6' } } });
  await api('DELETE', `/api/projects/${studio.id}/rules/${rule.id}`);
  await sleep(1800);
  check('with the rule gone the line goes too', (await js(panel)).locks.length === 0 && (await js(look)).accent === '#d68aa6', (await js(panel)).locks);

  // Look B (comfortable, larger text, sharp, teal), then the layout at three widths.
  await press('[data-look="density"] .seg button[data-v="comfortable"]');
  await press('[data-look="textSize"] .seg button[data-v="larger"]');
  await press('[data-look="radius"] .seg button[data-v="sharp"]');
  await press('.look-accent .look-swatch[title="Teal, #5fbcab"]');
  const b = await js(look);
  check('look B: teal, 32 px buttons, 16 px text, 2 px corners', b.accent === '#5fbcab' && b.btnH === 32 && b.body === '16px' && b.btnR === '2px', b);
  const geometry = `(() => { const s = document.getElementById('appearance'); const page = document.querySelector('.page'); const r = s.getBoundingClientRect(); const wide = [...s.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().right > r.right + 1).length;
    return { window: innerWidth + 'x' + innerHeight, width: Math.round(r.width), sideways: page.scrollWidth - page.clientWidth, pageSideways: document.documentElement.scrollWidth - innerWidth, outside: wide, segRows: [...s.querySelectorAll('.seg')].map((n) => Math.round(n.getBoundingClientRect().height)) }; })()`;
  const g1280 = await js(geometry);
  check('1280×720 at the largest text: nothing leaves the section, no sideways scroll, each choice on one line', g1280.sideways <= 0 && g1280.pageSideways <= 0 && g1280.outside === 0 && g1280.segRows.every((h) => h <= 40), g1280);
  await shot('appearance-08-look-b-settings-1280.jpg');
  await size(1000, 700);
  const g1000 = await js(geometry);
  check('1000×700: still no sideways scroll', g1000.sideways <= 0 && g1000.pageSideways <= 0 && g1000.outside === 0, g1000);
  await size(1920, 1080);
  const g1920 = await js(geometry);
  check('1920×1080: the section keeps a readable width', g1920.sideways <= 0 && g1920.outside === 0 && g1920.width <= 720, g1920);
  await shot('appearance-09-look-b-settings-1920.jpg');
  await js(`location.hash = '#/workbench'`); await sleep(2500);
  await shot('appearance-10-look-b-workbench-1920.jpg');
  await size(1280, 720);
  await shot('appearance-11-look-b-workbench-1280.jpg');
  await js(`location.hash = '#/inspiration'`); await sleep(1800);
  await shot('appearance-12-look-b-inspiration-1280.jpg');
  await js(`location.hash = '#/settings'`); await sleep(1500);

  // A keyboard focus ring in the chosen accent's own focus colour.
  win.webContents.focus(); await sleep(300);
  await js(`document.querySelector('[data-look="density"] .seg button[data-v="compact"]').focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] }); await sleep(400);
  const ring = await js(`(() => { const n = document.activeElement; const cs = getComputedStyle(n); const v = getComputedStyle(document.documentElement).getPropertyValue('--focus').trim(); const hex = (c) => '#' + c.match(/\\d+/g).slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join(''); return { on: n.dataset.v, style: cs.outlineStyle, color: hex(cs.outlineColor), focus: v }; })()`);
  check('the keyboard focus ring is drawn in the accent\'s focus colour', ring.on === 'comfortable' && ring.style === 'solid' && ring.color === ring.focus, ring);

  // Reset to defaults, with Undo.
  const before = (await stored()).stored;
  await js(`[...document.querySelectorAll('#appearance .btn')].find((b) => b.textContent === 'Reset to defaults').click()`);
  await sleep(1200);
  const resetLook = await js(look);
  const toastWords = await js(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent)`);
  check('Reset to defaults: everything back at once and nothing stored', resetLook.accent === '#d6a455' && resetLook.btnH === 32 && resetLook.body === '14px' && resetLook.btnR === '6px' && JSON.stringify((await stored()).stored) === '{}' && (await js(panel)).reset === true, resetLook);
  check('the first-frame copy is dropped with it', (await js(`localStorage.getItem('atelier.appearance')`)) === null);
  check('a toast says so and offers Undo', toastWords.some((t) => t.startsWith('Appearance is back to the studio\'s defaults') && t.includes('Undo')), toastWords);
  await js(`[...document.querySelectorAll('#toasts .toast .btn')].find((b) => b.textContent === 'Undo').click()`);
  await sleep(1200);
  check('Undo brings the look back as it was stored', JSON.stringify((await stored()).stored) === JSON.stringify(before) && (await js(look)).accent === '#5fbcab', [(await stored()).stored, before]);
  await js(`[...document.querySelectorAll('#appearance .btn')].find((b) => b.textContent === 'Reset to defaults').click()`);
  await sleep(1000);
  await js(`document.querySelectorAll('#toasts .toast').forEach((t) => t.remove())`);

  // With no project open the board offers nothing and says nothing; the registry holds no look in any project.
  const files = fs.readdirSync(path.join(tmp, 'projects')).flatMap((dir) => fs.readdirSync(path.join(tmp, 'projects', dir, '.studio')).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(tmp, 'projects', dir, '.studio', f), 'utf8')));
  check('no project record holds the look', files.length > 0 && files.every((text) => !text.includes('appearance')));
  check('no console errors', errors.length === 0, errors);
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(2); });
