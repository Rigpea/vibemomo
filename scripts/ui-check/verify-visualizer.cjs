// The Visualizer (docs/DESIGN.md section 14, docs/ARCHITECTURE.md section 26), driven in a real window: the fourth
// part of the Inspiration view and its address; a copy of the studio's own client stylesheets drawn with the studio's
// seed rules and board colours (the locks kept, the light theme's other values named); a product from the notes
// template with a kept lock, a broken one, one set nowhere and one that varies; swatches, the type scale, bars,
// corners and curves checked against the computed styles; a file:line button and a place in the list opening the
// Source tab at that line; a hand edit of a stylesheet found by Read again; Make it a task making one task through the
// task route after the request was shown; no file of either project changed by reading; the layout at 1280, 1920 and
// 1000 px and in the light theme.
// A private server (temp data and projects, a port the system picks): it never touches the studio on 4747 or
// ~/.atelier. Offscreen.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-visualizer.cjs
// Writes .local/shot-live/visualizer-*.jpg and prints the checks; exit 0 when every check holds.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'shot-live');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-viz-'));
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
  fs.writeFileSync(path.join(OUT, 'visualizer-results.json'), JSON.stringify(results, null, 1));
  for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : `\n     ${JSON.stringify(r.seen)}`));
  console.log(results.filter((r) => r.ok).length + ' of ' + results.length + ' checks hold');
  server?.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 170000);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** Every file of a project with a hash, its .git and the studio's own records aside (opening a project writes those;
 *  tests/visualizer.test.mjs shows the reader itself writes none): what reading must leave as it is. */
function snapshot(dir) {
  const out = {};
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.studio') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(cur, e.name), r);
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(cur, e.name))).digest('hex');
    }
  };
  walk(dir, '');
  return JSON.stringify(out);
}

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
  const must = async (method, p, body) => { const r = await api(method, p, body); if (r.status !== 200) throw new Error(`${method} ${p} refused: ${JSON.stringify(r.data)}`); return r.data; };

  // One project holds a copy of the studio's own page and stylesheets, with the studio's seed rules and board colours.
  const made = await must('POST', '/api/projects', { name: 'Studio Copy', kind: 'web-app', template: 'web-app-notes' });
  const studio = made.project;
  const studioDir = made.entry.path;
  fs.mkdirSync(path.join(studioDir, 'client'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'client'))) if (/\.(css|html)$/.test(f)) fs.copyFileSync(path.join(ROOT, 'client', f), path.join(studioDir, 'client', f));
  const manifestFile = path.join(studioDir, 'atelier.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), entry: 'client/index.html' }, null, 2));
  const { STUDIO_RULES } = await import(pathToFileURL(path.join(ROOT, 'server', 'lib', 'rules-seed.mjs')).href);
  for (const r of STUDIO_RULES) await must('POST', `/api/projects/${studio.id}/rules`, r);
  for (const c of [{ hex: '#ece8e1', name: 'ink' }, { hex: '#d6a455', name: 'amber' }, { hex: '#232221', name: 'canvas' }]) await must('POST', `/api/projects/${studio.id}/inspiration`, { kind: 'color', ...c });

  // The other is a product as the notes template makes it, with four locks: kept, varying, broken and set nowhere.
  const made2 = await must('POST', '/api/projects', { name: 'Notes Check', kind: 'web-app', template: 'web-app-notes' });
  const notes = made2.project;
  const notesDir = made2.entry.path;
  for (const r of [
    { text: 'Tap targets stay 44 px', kind: 'layout', token: { name: '--tap', value: '44px' } },
    { text: 'Blue is the one accent', kind: 'color', token: { name: '--accent', value: '#2F5BD3' } },
    { text: 'Corners are 12 px', kind: 'layout', token: { name: '--radius', value: '12px' } },
    { text: 'The brand colour stays', kind: 'color', token: { name: '--brand', value: '#123456' } },
    { text: 'One column, phone first', kind: 'layout' },
  ]) await must('POST', `/api/projects/${notes.id}/rules`, r);
  for (const c of [{ hex: '#00aa88', name: 'a green the files do not hold' }, { hex: '#1d1d1f', name: 'ink' }, { hex: '#2f5bd3', name: 'blue' }, { hex: '#f7f6f3', name: 'paper' }]) await must('POST', `/api/projects/${notes.id}/inspiration`, { kind: 'color', ...c });
  const before = { studio: snapshot(studioDir), notes: snapshot(notesDir) };
  const answer = await must('GET', `/api/projects/${studio.id}/visualizer`);
  const answer2 = await must('GET', `/api/projects/${notes.id}/visualizer`);

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((err) => { throw new Error(`${err.message} in: ${String(code).slice(0, 160)}`); });
  const shot = async (name) => { win.webContents.invalidate(); await sleep(600); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name), image.toJPEG(88)); return image; };
  const pixel = (image, x, y) => { const { width } = image.getSize(); const b = image.toBitmap(); const i = (Math.round(y) * width + Math.round(x)) * 4; return [b[i + 2], b[i + 1], b[i]]; };
  const key = async (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(350); };
  const pick = async (id) => { await js(`(() => { const s = document.querySelector('#project-pick select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`); await sleep(1800); };
  const visible = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((n) => n.getClientRects().length)`;
  const segClick = (starts) => js(`[...document.querySelectorAll('.inspo-head .seg button')].find((b) => b.textContent.startsWith(${JSON.stringify(starts)})).click()`);
  const state = `(() => { const r = document.querySelector('.inspo'); if (!r) return null; const v = r.querySelector('.viz'); const n = (sel) => v.querySelectorAll(sel).length; const fill = v.querySelector('.viz-fill');
    return { hash: location.hash, tab: document.querySelector('#view-tabs a[aria-current="page"]')?.textContent, seg: [...r.querySelectorAll('.inspo-head .seg button')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.textContent + ']' : b.textContent)),
      head: r.querySelector('.inspo-count').textContent, buttons: ${visible('.inspo-head > .btn')}.map((b) => b.textContent || b.getAttribute('aria-label')), primaries: ${visible('.inspo .btn.primary')}.map((b) => b.textContent),
      vizShown: !!v.getClientRects().length, boardShown: !!r.querySelector('.inspo-scroll').getClientRects().length, rulesShown: !!r.querySelector('.rules').getClientRects().length, refsShown: !!r.querySelector('.refs').getClientRects().length,
      fill: fill.hidden ? null : fill.textContent, sections: [...v.querySelectorAll('.viz-section')].map((s) => s.querySelector('.viz-h').textContent),
      groups: [...v.querySelectorAll('.viz-group')].map((g) => g.querySelector('.viz-sub').textContent), colors: n('.viz-color'), families: n('.viz-family'), sizes: n('.viz-size'), spacing: n('[data-section="spacing"] .viz-row'), radii: n('.viz-radius'), durations: n('[data-section="motion"] .viz-row'), easings: n('.viz-easing'),
      files: v.querySelector('.viz-files')?.textContent, task: r.querySelector('.inspo-head > .btn:not(.icon-only):not([hidden]):last-child')?.disabled }; })()`;

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await pick(studio.id);
  await js(`document.getElementById('main').focus()`);
  await key('3');
  await sleep(1200);
  const board = await js(state);
  check('key 3 opens Inspiration on the board; the switch has four parts', board?.hash === '#/inspiration' && board.seg.join(' ') === '[Board] Fixed rules12 References Visualizer' && board.boardShown && !board.vizShown && board.primaries.join() === 'Add', board);

  await segClick('Visualizer');
  await sleep(1500);
  const s = await js(state);
  check('the Visualizer has its own address and keeps the Inspiration tab current', s.hash === '#/inspiration/visualizer' && s.tab === 'Inspiration' && s.seg.join(' ') === 'Board Fixed rules12 References [Visualizer]', s);
  check('only its own two buttons are in the head, and no primary button; the other parts are out of sight', s.buttons.join(' | ') === 'Read the stylesheets again | Make it a task' && s.primaries.length === 0 && s.vizShown && !s.boardShown && !s.rulesShown && !s.refsShown, s);
  const drifting = answer.colors.concat(answer.type.sizes, answer.spacing, answer.radii, answer.motion.durations, answer.motion.easings).filter((x) => x.drift.length).length;
  check('the head counts what the server read', s.head === `Studio Copy · ${answer.sheets.length} stylesheets · ${answer.colors.length} colours · ${drifting} drifting` && answer.sheets.length >= 5 && drifting > 0, [s.head, answer.sheets.map((x) => x.file)]);
  check('the files line names the entry and each stylesheet, then says what the two drift words mean', /^Read fromclient\/index\.html→styles\.cssviews\.csslearning\.cssinspiration\.cssvisualizer\.cssonce: written out in one place only · far: far from every colour on the board$/.test(s.files || ''), s.files);
  check('seven sections: colour, type, spacing, radii and motion, then the board\'s colours and the fixed rules', s.sections.map((t) => t.replace(/\d+$/, '')).join(' | ') === 'Colour | Type | Spacing | Radii | Motion | Board colours | Fixed rules', s.sections);
  check('every value the server answered is drawn', s.colors === answer.colors.length && s.families === answer.type.families.length && s.sizes === answer.type.sizes.length && s.spacing === answer.spacing.length && s.radii === answer.radii.length && s.durations === answer.motion.durations.length && s.easings === answer.motion.easings.length, s);
  check('colours are grouped by use', s.groups.map((g) => g.replace(/\d+$/, '')).join(' | ') === 'Surfaces | Text | Lines | Effects | Not used', s.groups);

  // The drawing against the computed styles.
  const drawn = await js(`(() => { const v = document.querySelector('.viz'); const tile = (name) => v.querySelector('.viz-color[data-value="' + name + '"]'); const cs = (n) => getComputedStyle(n);
    const accent = tile('--accent'); const fam = [...v.querySelectorAll('.viz-family')].map((f) => ({ stack: f.dataset.value, font: cs(f.querySelector('.viz-sample')).fontFamily }));
    const size = (val) => { const li = v.querySelector('.viz-size[data-value="' + val + '"]'); const smp = li?.querySelector('.viz-size-sample'); return smp && { px: cs(smp).fontSize, font: cs(smp).fontFamily, line: li.querySelector('.viz-line').textContent }; };
    const bar = (val) => { const li = v.querySelector('[data-section="spacing"] .viz-row[data-value="' + val + '"]'); return li && { w: Math.round(li.querySelector('.viz-bar').getBoundingClientRect().width * 10) / 10, line: li.querySelector('.viz-line').textContent }; };
    const corner = (val) => { const li = v.querySelector('.viz-radius[data-value="' + val + '"]'); return li && cs(li.querySelector('.viz-corner')).borderTopLeftRadius; };
    const dur = [...v.querySelectorAll('[data-section="motion"] .viz-row')].map((li) => ({ v: li.dataset.value, w: Math.round(li.querySelector('.viz-bar').getBoundingClientRect().width), track: Math.round(li.querySelector('.viz-track').getBoundingClientRect().width) }));
    const ease = [...v.querySelectorAll('.viz-easing')].map((li) => ({ v: li.dataset.value, d: li.querySelector('.viz-ease')?.getAttribute('d') }));
    return { accent: accent && { main: cs(accent.querySelector('.viz-swatch')).backgroundColor, alt: [...accent.querySelectorAll('.viz-chip.sm')].map((a) => cs(a).backgroundColor), name: accent.querySelector('.viz-name').textContent, value: accent.querySelector('.viz-value').textContent, facts: [...accent.querySelectorAll('.viz-facts > *')].map((n) => n.textContent), title: accent.title },
      black: tile('#000000') && [...tile('#000000').querySelectorAll('.viz-facts > *')].map((n) => n.textContent), unused: [...v.querySelectorAll('.viz-group[data-use="unused"] .viz-color')].map((t) => t.dataset.value + ':' + t.querySelector('.viz-facts').textContent),
      fam, s18: size('18px'), s125: size('12.5px'), b12: bar('12px'), b1: bar('1px'), b48: bar('48px'), r6: corner('6px'), r50: corner('50%'), dur, ease }; })()`);
  check('a custom property is a swatch in its own colour with its other value as a chip beside the value, its name, its value, its home and its uses', drawn.accent?.main === 'rgb(214, 164, 85)' && drawn.accent.alt.join() === 'rgb(168, 111, 23)' && drawn.accent.name === '--accent' && drawn.accent.value === '#d6a455' && drawn.accent.facts[0] === 'styles.css:16' && /^\d+ uses$/.test(drawn.accent.facts[1]) && drawn.accent.facts.includes('kept') && /\[data-theme="light"\]: #a86f17/.test(drawn.accent.title), drawn.accent);
  check('a colour far from the board says so gently, a custom property read nowhere says not used', drawn.black?.includes('far') && drawn.unused.some((u) => /^--busy-soft:styles\.css:\d+not used$/.test(u)), [drawn.black, drawn.unused]);
  check('each family is drawn in its own stack', drawn.fam.length === 3 && drawn.fam.every((f) => f.font.replace(/"/g, '') === f.stack.replace(/"/g, '')), drawn.fam);
  check('the type scale draws each size at its size, in the page\'s family, with its custom property and its home', drawn.s18?.px === '18px' && /Inter/.test(drawn.s18.font) && /--fs-title/.test(drawn.s18.line) && /styles\.css:71/.test(drawn.s18.line) && drawn.s125?.px === '12.5px', [drawn.s18, drawn.s125]);
  check('a spacing value is a bar at its real size', drawn.b12?.w === 12 && drawn.b1?.w === 1 && drawn.b48?.w === 48 && /--s3/.test(drawn.b12.line) && /\d+ places/.test(drawn.b12.line), [drawn.b12, drawn.b1, drawn.b48]);
  check('a radius is a corner of that radius', drawn.r6 === '6px' && drawn.r50 === '50%', [drawn.r6, drawn.r50]);
  const longest = drawn.dur[drawn.dur.length - 1];
  check('durations share one axis: the longest fills the track and the others are in proportion', longest.w === longest.track && drawn.dur[0].w < longest.w / 5 && drawn.dur.map((d) => d.v).join() === answer.motion.durations.map((d) => d.value).join(), drawn.dur);
  check('an easing is drawn as its curve', drawn.ease.find((e) => e.v === 'ease-out')?.d === 'M0 48 C0 48 27.84 0 48 0' && drawn.ease.find((e) => e.v === 'linear')?.d === 'M0 48 C0 48 48 0 48 0', drawn.ease);

  // The side column: the board's colours found in the files, the locks checked.
  const side = `(() => { const v = document.querySelector('.viz-side'); return { cards: [...v.querySelectorAll('.viz-card')].map((c) => ({ hex: c.dataset.hex, chip: getComputedStyle(c.querySelector('.viz-chip')).backgroundColor, text: c.querySelector('.viz-card-body').textContent })),
    rules: [...v.querySelectorAll('.viz-rules:not(.plain) .viz-rule')].map((r) => ({ state: r.dataset.state, word: r.querySelector('.viz-rule-state').textContent, text: r.querySelector('.viz-rule-text').textContent, token: r.querySelector('.viz-token')?.textContent, detail: r.querySelector('.viz-rule-detail')?.textContent || '', links: [...r.querySelectorAll('.viz-src')].map((b) => b.textContent), dot: getComputedStyle(r.querySelector('.viz-dot')).backgroundColor })),
    plain: v.querySelectorAll('.viz-rules.plain .viz-rule').length, sub: [...v.querySelectorAll('.viz-sub')].map((n) => n.textContent) }; })()`;
  const sd = await js(side);
  check('the board\'s colour cards stand beside, each found in the stylesheets as its custom property', sd.cards.length === 3 && sd.cards.map((c) => c.text).join(' | ') === '#232221canvasIn the stylesheets as --bgstyles.css:6 | #d6a455amberIn the stylesheets as --accentstyles.css:16 | #ece8e1inkIn the stylesheets as --inkstyles.css:13' && sd.cards[1].chip === 'rgb(214, 164, 85)', sd.cards);
  check('the four locked tokens are checked: the serif kept; the canvas, the ink and the accent kept with the light theme\'s value named', sd.rules.length === 4 && sd.rules.filter((r) => r.state === 'varies').length === 3 && sd.rules.find((r) => r.token.startsWith('--serif'))?.word === 'Kept' && sd.rules.find((r) => r.token === '--accent: #d6a455')?.detail === '[data-theme="light"] sets #a86f17' && sd.rules.find((r) => r.token === '--accent: #d6a455').links.join() === 'styles.css:16,styles.css:46', sd.rules);
  check('the rules in words are listed, not judged', sd.plain === 8 && sd.sub.some((t) => t === 'In words, not checked here8'), [sd.plain, sd.sub]);
  await shot('visualizer-studio-1280.jpg');
  await js(`document.querySelector('.viz-main').scrollTop = document.querySelector('[data-section="type"]').offsetTop - 12`);
  await shot('visualizer-studio-type-1280.jpg');
  await js(`document.querySelector('.viz-main').scrollTop = document.querySelector('[data-section="radii"]').offsetTop - 220`);
  await shot('visualizer-studio-spacing-1280.jpg');
  await js(`document.querySelector('.viz-main').scrollTop = 1e6`);
  await shot('visualizer-studio-motion-1280.jpg');
  await js(`document.querySelector('.viz-main').scrollTop = 0`);

  // The list of places, and a place opening the Source tab at its line.
  await js(`document.querySelector('.viz-color[data-value="--accent"] .viz-count').click()`);
  await sleep(500);
  const dlg = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, wide: d.classList.contains('wide'), subs: [...d.querySelectorAll('.viz-sub')].map((n) => n.textContent), set: [...d.querySelectorAll('.viz-places')][0].textContent, places: d.querySelectorAll('.viz-places')[1].querySelectorAll('.viz-place').length, first: d.querySelectorAll('.viz-places')[1].querySelector('.viz-place').textContent, note: d.querySelector('.viz-note')?.textContent, more: [...d.querySelectorAll('.viz-none')].map((n) => n.textContent), fits: d.getBoundingClientRect().bottom <= innerHeight }; })()`);
  const accentItem = answer.colors.find((c) => c.name === '--accent');
  check('the count opens the list: where the property is set, its lock, and every place that reads it', dlg?.title === '--accent' && dlg.wide && dlg.subs.join(' | ') === `Set2 | Read${accentItem.count}` && /styles\.css:16.*--accent: #d6a455.*styles\.css:46.*--accent: #a86f17/.test(dlg.set) && dlg.places === Math.min(accentItem.count, 40) && /^Locked at #d6a455 by the rule/.test(dlg.note || '') && (accentItem.count <= 40 || dlg.more.includes(`and ${accentItem.count - 40} more, not listed`)) && dlg.fits, dlg);
  await shot('visualizer-places-1280.jpg');
  const second = accentItem.places[1];
  await js(`document.querySelectorAll('dialog.dialog[open] .viz-places')[1].querySelectorAll('.viz-place .viz-src')[1].click()`);
  await sleep(2600);
  const sourceState = `({ hash: location.hash, open: !!document.querySelector('dialog[open]'), path: document.querySelector('.source-path')?.textContent, meta: document.querySelector('.source-path-meta')?.textContent, marked: !!document.querySelector('.source-mark') })`;
  const src = await js(sourceState);
  check('a place in the list closes it and opens the Source tab at that file and line', src.hash === '#/workbench' && !src.open && src.path === second.file && new RegExp(`line ${second.line}\\b`).test(src.meta || '') && src.marked, [src, second]);
  await shot('visualizer-source-1280.jpg');
  await js(`location.hash = '#/inspiration/visualizer'`);
  await sleep(1500);
  await js(`document.querySelector('.viz-row[data-value="140ms"] .viz-src').click()`);
  await sleep(2400);
  const src2 = await js(sourceState);
  check('a value\'s own file:line button opens the Source tab where its custom property is set', src2.hash === '#/workbench' && src2.path === 'client/styles.css' && /line 76\b/.test(src2.meta || ''), src2);

  // The product: four locks in their four states, the board against the files, and a reload that stays.
  await js(`location.hash = '#/inspiration/visualizer'`);
  await sleep(1200);
  await pick(notes.id);
  await sleep(600);
  const n = await js(state);
  const nd = await js(side);
  const drifting2 = answer2.colors.concat(answer2.type.sizes, answer2.spacing, answer2.radii, answer2.motion.durations, answer2.motion.easings).filter((x) => x.drift.length).length;
  check('another project shows its own design: the notes template\'s one stylesheet', n.head === `Notes Check · 1 stylesheet · ${answer2.colors.length} colours · ${drifting2} drifting · 1 lock broken` && /^Read fromsrc\/index\.html→style\.css/.test(n.files) && n.colors === answer2.colors.length && n.task === false, n);
  const by = (name) => nd.rules.find((r) => r.token.startsWith(name));
  check('a kept lock, one kept with another value elsewhere, a broken one and one set nowhere, each in words with its dot', by('--tap')?.word === 'Kept' && by('--tap').dot === 'rgb(147, 190, 124)' && by('--accent')?.word === 'Kept, with another value elsewhere' && by('--accent').detail === '@media (prefers-color-scheme: dark) :root sets #7c9cff' && by('--radius')?.word === 'Broken' && by('--radius').detail === 'style.css:21 sets 10px, not 12px' && by('--radius').dot === 'rgb(224, 122, 114)' && by('--brand')?.word === 'Not set in these stylesheets' && by('--brand').links.length === 0 && nd.plain === 1, nd.rules);
  check('a board colour the files hold is found; one they do not hold says so', /^#f7f6f3paperIn the stylesheets as --bg/.test(nd.cards[0].text) && /^#00aa88a green the files do not holdNot in the stylesheets; the closest is /.test(nd.cards[3].text), nd.cards);
  const marks = await js(`(() => { const v = document.querySelector('.viz'); const t = (sel) => [...(v.querySelector(sel)?.querySelectorAll('.viz-mark') || [])].map((m) => m.textContent + '|' + m.title); return { radius: t('.viz-radius[data-value="10px"]'), four: t('.viz-radius[data-value="4px"]'), danger: t('.viz-color[data-value="--danger"]'), bg: t('.viz-color[data-value="--bg"]') }; })()`);
  check('a value shows its lock and its drift: broken on the 10 px radius, once on a one-off, far on a colour the board has nothing near', marks.radius.some((m) => /^broken\|--radius is locked at 12px by the rule "Corners are 12 px"$/.test(m)) && marks.four.some((m) => m.startsWith('once|Written out in one place only')) && marks.danger.some((m) => /^far\|Far from every colour on the board/.test(m)) && marks.bg.length === 0, marks);
  await shot('visualizer-notes-1280.jpg');
  win.webContents.reloadIgnoringCache();
  await sleep(3500);
  const reloaded = await js(state);
  check('a reload stays on the Visualizer with the same project', reloaded?.hash === '#/inspiration/visualizer' && reloaded.head === n.head && reloaded.colors === n.colors, reloaded);
  check('reading changed no file of either project', before.studio === snapshot(studioDir) && before.notes === snapshot(notesDir));

  // A rule changed elsewhere arrives by itself; a stylesheet edited by hand is found by Read again.
  const radiusRule = (await must('GET', `/api/projects/${notes.id}/rules`)).rules.find((r) => r.token?.name === '--radius');
  await must('PATCH', `/api/projects/${notes.id}/rules/${radiusRule.id}`, { token: { name: '--radius', value: '10px' } });
  await sleep(1500);
  const healed = await js(side);
  check('a rule changed outside the window is checked again without a reload', healed.rules.find((r) => r.token.startsWith('--radius'))?.word === 'Kept' && !/broken/.test((await js(state)).head), healed.rules);
  const cssFile = path.join(notesDir, 'src', 'style.css');
  fs.writeFileSync(cssFile, fs.readFileSync(cssFile, 'utf8').replace('--radius: 10px;', '--radius: 14px;'));
  await js(`${visible('.inspo-head > .btn.icon-only')}[0].click()`);
  await sleep(1200);
  const edited = await js(side);
  const corner = await js(`!!document.querySelector('.viz-radius[data-value="14px"]') && !document.querySelector('.viz-radius[data-value="10px"]')`);
  check('Read again finds a hand edit of the stylesheet: the lock is broken and the corner is the new one', edited.rules.find((r) => r.token.startsWith('--radius'))?.detail === 'style.css:21 sets 14px, not 10px' && corner, edited.rules);

  // Make it a task: the request is shown first; Cancel makes nothing; Create makes one task through the task route.
  const tasksBefore = (await must('GET', `/api/projects/${notes.id}/tasks`));
  const count = (t) => (Array.isArray(t) ? t : t.tasks || []).length;
  const openTask = async () => { await js(`${visible('.inspo-head > .btn:not(.icon-only)')}.find((b) => b.textContent === 'Make it a task').click()`); await sleep(500); };
  await openTask();
  const td = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, hint: d.querySelector('.hint').textContent, text: d.querySelector('textarea').value, buttons: [...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent), focus: document.activeElement?.name, fits: d.getBoundingClientRect().bottom <= innerHeight }; })()`);
  check('Make it a task shows the request first: the broken lock, the far colours and the one-offs, each with its place', td?.title === 'Make it a task' && /^Tidy the drift in Notes Check's design system, as the Visualizer read it from src\/index\.html \(src\/style\.css\)\./.test(td.text) && td.text.includes('- --radius is locked at 10px; src/style.css:21 sets 14px') && /Colours far from every colour on the inspiration board[^\n]*\n- --danger \(#b3261e\), set at src\/style\.css:19/.test(td.text) && /- radius 4px at src\/style\.css:\d+/.test(td.text) && td.buttons.join() === 'Cancel,Create task' && td.focus === 'visualizer-task' && td.fits && /handed to no one/.test(td.hint), td);
  await shot('visualizer-task-1280.jpg');
  await js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => b.textContent === 'Cancel').click()`);
  await sleep(400);
  check('Cancel makes no task', count(await must('GET', `/api/projects/${notes.id}/tasks`)) === count(tasksBefore));
  await openTask();
  await js(`(() => { const t = document.querySelector('dialog.dialog[open] textarea'); t.value = t.value + '\\n\\nStart with the radius.'; })()`);
  await js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => b.textContent === 'Create task').click()`);
  await sleep(1500);
  const after = await must('GET', `/api/projects/${notes.id}/tasks`);
  const list = Array.isArray(after) ? after : after.tasks || [];
  const task = list.find((t) => /^Tidy the design drift the Visualizer found/.test(t.title));
  const toastText = await js(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent)`);
  check('Create task makes one task, ready and handed to no one, with the edited request and the stylesheet as its file', count(after) === count(tasksBefore) + 1 && task?.status === 'ready' && /Start with the radius\.$/.test(task.request) && task.mode === 'handle' && (task.context?.files || []).includes('src/style.css') && !(await js(`!!document.querySelector('dialog[open]')`)) && toastText.some((t) => t.startsWith('Task made: Tidy the design drift')), { task, toastText });

  // A project with no stylesheet says so.
  fs.writeFileSync(path.join(notesDir, 'src', 'index.html'), fs.readFileSync(path.join(notesDir, 'src', 'index.html'), 'utf8').replace(/<link rel="stylesheet"[^>]*>/, '<link rel="stylesheet" href="https://example.com/site.css">'));
  await js(`${visible('.inspo-head > .btn.icon-only')}[0].click()`);
  await sleep(1200);
  const bare = await js(state);
  check('an entry that loads no stylesheet of the project says so, and names what was left out and why', /^The entry page loads no stylesheet from this project/.test(bare.fill || '') && /https:\/\/example\.com\/site\.css: on another site/.test(bare.fill) && bare.task === true, bare);

  // The layout: laptop, wide, small, light.
  await js(`document.querySelectorAll('#toasts .toast').forEach((t) => t.remove())`);
  await pick(studio.id);
  await sleep(600);
  const geometry = `(() => { const main = document.querySelector('.viz-main'); const sideCol = document.querySelector('.viz-side'); const head = document.querySelector('.inspo-head'); const m = main.getBoundingClientRect(); const sd = sideCol.getBoundingClientRect();
    const tiles = [...main.querySelectorAll('.viz-color')].map((n) => n.getBoundingClientRect()); const cols = new Set(tiles.map((r) => Math.round(r.left))).size;
    const over = [...document.querySelectorAll('.viz-color, .viz-row, .viz-size, .viz-family, .viz-radius, .viz-easing, .viz-card, .viz-rule')].filter((n) => n.scrollWidth > n.clientWidth + 1).length;
    return { window: innerWidth + 'x' + innerHeight, beside: Math.round(sd.left) >= Math.round(m.right) - 1 && Math.abs(sd.top - m.top) < 2, sideWidth: Math.round(sd.width), mainWidth: Math.round(m.width), colourColumns: cols, over, mainSideways: main.scrollWidth - main.clientWidth, sideSideways: sideCol.scrollWidth - sideCol.clientWidth, pageSideways: document.documentElement.scrollWidth - innerWidth, headFits: head.scrollWidth <= head.clientWidth, headRows: new Set([...head.children].filter((c) => c.getClientRects().length).map((c) => { const b = c.getBoundingClientRect(); return Math.round((b.top + b.height / 2) / 24); })).size, mainScrolls: main.scrollHeight > main.clientHeight }; })()`;
  const laptop = await js(geometry);
  check('1280×720: the two columns stand side by side and scroll by themselves; nothing runs over or sideways; the head is one row', laptop.beside && laptop.sideWidth === 340 && laptop.over === 0 && laptop.mainSideways <= 0 && laptop.sideSideways <= 0 && laptop.pageSideways <= 0 && laptop.headFits && laptop.headRows === 1 && laptop.mainScrolls && laptop.colourColumns >= 4, laptop);
  win.setSize(1920, 1080); await sleep(1200);
  const wide = await js(geometry);
  check('1920×1080: more swatches a row, still nothing over or sideways', wide.beside && wide.colourColumns > laptop.colourColumns && wide.over === 0 && wide.mainSideways <= 0 && wide.pageSideways <= 0 && wide.headRows === 1, wide);
  await shot('visualizer-studio-1920.jpg');
  win.setSize(1000, 700); await sleep(1200);
  const small = await js(`(() => { const main = document.querySelector('.viz-main'); const sideCol = document.querySelector('.viz-side'); const cols = document.querySelector('.viz-cols'); return { below: sideCol.getBoundingClientRect().top >= main.getBoundingClientRect().bottom - 1, scrolls: cols.scrollHeight > cols.clientHeight && getComputedStyle(cols).overflowY === 'auto', sideways: cols.scrollWidth - cols.clientWidth, pageSideways: document.documentElement.scrollWidth - innerWidth, over: [...document.querySelectorAll('.viz-color, .viz-row, .viz-size, .viz-family, .viz-radius, .viz-easing, .viz-card, .viz-rule')].filter((n) => n.scrollWidth > n.clientWidth + 1).length }; })()`);
  check('1000×700: one column, the board and the rules under the values, the whole part scrolling', small.below && small.scrolls && small.sideways <= 0 && small.pageSideways <= 0 && small.over === 0, small);
  await shot('visualizer-studio-1000.jpg');
  win.setSize(1280, 720); await sleep(800);
  win.webContents.focus();
  await js(`document.querySelector('.viz-color .viz-src').focus()`);
  await key('Tab');
  const focus = await js(`(() => { const n = document.activeElement; const cs = getComputedStyle(n); return { cls: n.className, outline: cs.outlineStyle, text: n.textContent }; })()`);
  check('Tab goes from a value\'s file:line to its count, with a visible ring', /viz-count/.test(focus.cls) && focus.outline === 'solid', focus);
  await js(`document.getElementById('theme-toggle').click()`); await sleep(600);
  const light = await js(`({ theme: document.documentElement.dataset.theme, ink: getComputedStyle(document.querySelector('.viz-name')).color, bar: getComputedStyle(document.querySelector('.viz-bar')).backgroundColor, swatch: getComputedStyle(document.querySelector('.viz-color[data-value="--accent"] .viz-swatch')).backgroundColor })`);
  check('the light theme draws the part from its own tokens, and a project\'s colour stays the project\'s', light.theme === 'light' && light.ink === 'rgb(31, 28, 24)' && light.bar === 'rgb(63, 58, 51)' && light.swatch === 'rgb(214, 164, 85)', light);
  win.setSize(1282, 720); await sleep(500); win.setSize(1280, 720); await sleep(900);
  const lightShot = await shot('visualizer-light-1280.jpg');
  const px = pixel(lightShot, 6, lightShot.getSize().height - 6);
  check('the captured picture is the light theme', px[0] > 200 && px[1] > 200 && px[2] > 190, px);
  await js(`document.getElementById('theme-toggle').click()`); await sleep(300);

  // The other parts stand as before.
  await segClick('Fixed rules');
  await sleep(600);
  const rules = await js(state);
  check('Fixed rules shows the rules alone, with Add rule; the Visualizer\'s buttons are gone', rules.hash === '#/inspiration/rules' && rules.rulesShown && !rules.vizShown && rules.primaries.join() === 'Add rule' && rules.buttons.join() === 'Add rule', rules);
  await segClick('Board');
  await sleep(600);
  const again = await js(state);
  check('Board brings the board back, with Add as the one primary button', again.hash === '#/inspiration' && again.boardShown && !again.vizShown && again.primaries.join() === 'Add', again);
  check('no console errors', errors.length === 0, errors);
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(2); });
