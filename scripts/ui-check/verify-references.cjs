// References (docs/DESIGN.md section 13, docs/ARCHITECTURE.md section 25), driven in a real window: the third part of
// the Inspiration view and its address, the empty state, Add reference through the dialog for each kind, a private
// address and a missing title refused in the dialog, a real link's title fetched by the server, one Copy button on a
// prompt, an entry arriving from outside the window, the search and the tag filter, Edit by Enter, Remove after one
// question, a reload that finds the entries, another project showing its own, a paste that adds no card, and the
// layout at 1280, 1920 and 1000 px and in the light theme.
// A private server (temp data and projects, a port the system picks): it never touches the studio on 4747 or
// ~/.atelier. Offscreen. The clipboard is the page's own stand-in, so the person's clipboard is left alone.
// --offline skips the one check that needs the network (the title of https://example.com/).
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-references.cjs [--offline]
// Writes .local/shot-live/references-*.jpg and prints the checks; exit 0 when every check holds.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'shot-live');
const OFFLINE = process.argv.includes('--offline');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-refs-'));
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
  fs.writeFileSync(path.join(OUT, 'references-results.json'), JSON.stringify(results, null, 1));
  for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : `\n     ${JSON.stringify(r.seen)}`));
  console.log(results.filter((r) => r.ok).length + ' of ' + results.length + ' checks hold');
  server?.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 170000);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const SNIPPET = 'let timer;\nconst save = () => {\n  clearTimeout(timer);\n  timer = setTimeout(write, 300);\n};';
const LONG = Array.from({ length: 30 }, (_, i) => `export const step${i + 1} = (state) => ({ ...state, step: ${i + 1}, at: Date.now(), note: 'a line long enough to run past the column edge' });`).join('\n');
const PROMPT = 'Name the smallest piece of this that would make it real, and build only that.\nSay what you left out.';

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
  const one = (await api('POST', '/api/projects', { name: 'Refs Check', kind: 'web-app', template: 'web-app-notes' })).data.project;
  const two = (await api('POST', '/api/projects', { name: 'Other Check', kind: 'web-app', template: 'web-app-notes' })).data.project;
  await api('POST', `/api/projects/${two.id}/references`, { kind: 'note', text: 'The other project keeps one note of its own.' });
  const R = `/api/projects/${one.id}/references`;

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { win.webContents.invalidate(); await sleep(600); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name), image.toJPEG(88)); return image; };
  const pixel = (image, x, y) => { const { width } = image.getSize(); const b = image.toBitmap(); const i = (Math.round(y) * width + Math.round(x)) * 4; return [b[i + 2], b[i + 1], b[i]]; };
  const key = async (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(350); };
  const pick = async (id) => { await js(`(() => { const s = document.querySelector('#project-pick select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`); await sleep(1800); };
  const visible = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((n) => n.getClientRects().length)`;
  const state = `(() => { const r = document.querySelector('.inspo'); if (!r) return null; const refs = [...r.querySelectorAll('.ref')]; const fill = r.querySelector('.refs-fill');
    return { hash: location.hash, tab: document.querySelector('#view-tabs a[aria-current="page"]')?.textContent, seg: [...r.querySelectorAll('.inspo-head .seg button')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.textContent + ']' : b.textContent)),
      head: r.querySelector('.inspo-count').textContent, primaries: ${visible('.inspo .btn.primary')}.map((b) => b.textContent), boardShown: !!r.querySelector('.inspo-scroll').getClientRects().length, fieldShown: !!r.querySelector('.inspo-add').getClientRects().length, rulesShown: !!r.querySelector('.rules').getClientRects().length,
      barShown: !!r.querySelector('.refs-bar').getClientRects().length, fill: fill.hidden ? null : fill.textContent, groups: [...r.querySelectorAll('.refs-group')].map((g) => g.querySelector('.refs-kind').textContent + ': ' + g.querySelectorAll('.ref').length),
      refs: refs.map((n) => n.getAttribute('aria-label')), tags: [...r.querySelectorAll('.refs-bar .inspo-filter-tag')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.textContent + ']' : b.textContent)), search: r.querySelector('.refs-search').value,
      focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.name || document.activeElement?.tagName }; })()`;
  const dialogState = `(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, wide: d.classList.contains('wide'), kinds: [...d.querySelectorAll('.seg button')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.textContent + ']' : b.textContent)),
    labels: [...d.querySelectorAll('.field > label')].map((l) => l.textContent), reason: d.querySelector('.note.danger')?.hidden ? null : d.querySelector('.note.danger')?.textContent, buttons: [...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent),
    focus: document.activeElement?.name || document.activeElement?.tagName, mono: !!d.querySelector('textarea.mono'),
    reasonInSight: (() => { const n = d.querySelector('.note.danger'); if (!n || n.hidden) return false; const r = n.getBoundingClientRect(); const box = d.getBoundingClientRect(); return r.height > 0 && r.top >= box.top && r.bottom <= Math.min(box.bottom, innerHeight); })() }; })()`;
  const fill = (fields) => js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const set = (name, v) => { const f = d.querySelector('[name="' + name + '"]'); f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); };
    for (const [k, v] of Object.entries(${JSON.stringify(fields)})) set(k, v); })()`);
  const press = (words) => js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => b.textContent === ${JSON.stringify(words)}).click()`);
  const kindBtn = (words) => js(`[...document.querySelectorAll('dialog.dialog[open] .seg button')].find((b) => b.textContent === ${JSON.stringify(words)}).click()`);
  const openAdd = async () => { await js(`${visible('.inspo .btn.primary')}[0].click()`); await sleep(400); };
  const dialogOpen = () => js(`!!document.querySelector('dialog.dialog[open]')`);
  const segClick = (starts) => js(`[...document.querySelectorAll('.inspo-head .seg button')].find((b) => b.textContent.startsWith(${JSON.stringify(starts)})).click()`);
  const focusRef = (words) => js(`[...document.querySelectorAll('.ref')].find((r) => r.getAttribute('aria-label').includes(${JSON.stringify(words)})).focus()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  // The page's clipboard is a stand-in for this run: what Copy writes is read back from the page, not from the system.
  const standIn = `(() => { window.__copied = []; const fake = { writeText: async (t) => { window.__copied.push(t); } }; try { Object.defineProperty(navigator, 'clipboard', { value: fake, configurable: true }); } catch { navigator.clipboard.writeText = fake.writeText; } })()`;
  await js(standIn);
  await pick(one.id);
  await js(`document.getElementById('main').focus()`);
  await key('3');
  await sleep(1200);
  const board = await js(state);
  check('key 3 opens Inspiration on the board; the switch has its four parts', board?.hash === '#/inspiration' && board.seg.join(' ') === '[Board] Fixed rules References Visualizer' && board.boardShown && board.fieldShown && board.primaries.join() === 'Add', board);

  await segClick('References');
  await sleep(700);
  const empty = await js(state);
  check('References has its own address and keeps the Inspiration tab current', empty.hash === '#/inspiration/references' && empty.tab === 'Inspiration' && empty.seg.join(' ') === 'Board Fixed rules [References] Visualizer', empty);
  check('only Add reference is in sight as a primary button; the board, its field and the rules are out of sight', empty.primaries.join() === 'Add reference' && !empty.boardShown && !empty.fieldShown && !empty.rulesShown, empty);
  check('the empty state says what a reference is; no search bar over nothing', /^No references yet\. A reference is something to build from/.test(empty.fill || '') && empty.head === 'Refs Check · 0 references' && !empty.barShown, [empty.fill, empty.head, empty.barShown]);
  await shot('references-empty-1280.jpg');

  // Add reference: a link first. A private address is refused in the dialog, with the focus on the address.
  await openAdd();
  const dlg = await js(dialogState);
  check('the Add reference dialog starts on Link: the four kinds, its fields, the focus in the address', dlg?.title === 'Add reference' && dlg.kinds.join(' ') === '[Link] Snippet Prompt Note' && dlg.labels.join(' | ') === 'Address | Title (optional) | Use it for (optional) | Tags | Where it came from (optional)' && dlg.focus === 'reference-url' && dlg.buttons.join() === 'Cancel,Add link' && !dlg.wide, dlg);
  await shot('references-dialog-link-1280.jpg');
  await fill({ 'reference-url': `${BASE}/api/state` });
  await press('Add link');
  await sleep(800);
  const unsafe = await js(dialogState);
  check('a private address is refused with a sentence in the dialog, the focus on the address', /private or local address \(127\.0\.0\.1\); the studio does not fetch or keep those/.test(unsafe?.reason || '') && unsafe.focus === 'reference-url', unsafe);
  check('nothing was added by the refusal', (await api('GET', R)).data.entries.length === 0);
  if (!OFFLINE) {
    await fill({ 'reference-url': 'https://example.com/', 'reference-use': 'a page that always answers', 'reference-tags': 'docs, Example' });
    await press('Add link');
    for (let i = 0; i < 24 && await dialogOpen(); i++) await sleep(500);
    await sleep(700);
    const link = (await api('GET', R)).data.entries[0];
    const row = await js(`(() => { const n = document.querySelector('.ref-link'); return n && { title: n.querySelector('a.ref-title')?.textContent, href: n.querySelector('a.ref-title')?.getAttribute('href'), rel: n.querySelector('a.ref-title')?.rel, target: n.querySelector('a.ref-title')?.target, meta: n.querySelector('.ref-main .ref-meta')?.textContent, copy: !!n.querySelector('.ref-actions .btn:not(.icon-only)') }; })()`);
    check('a real link is kept with the title its page gave (or, when the page did not answer, as a plain link that says why)', link?.kind === 'link' && link.url === 'https://example.com/' && (link.preview.ok ? link.title === 'Example Domain' && row?.title === 'Example Domain' : /^No preview: /.test(link.preview.reason) && row?.title === 'https://example.com/') && row.href === 'https://example.com/' && row.target === '_blank' && /noopener/.test(row.rel) && !row.copy && link.tags.join() === 'docs,example', { link, row });
  } else {
    await js(`document.querySelector('dialog.dialog[open] .dialog-head button').click()`);
    await sleep(300);
  }

  // A snippet: the dialog widens and takes code in the mono; no title is refused with the focus on the title.
  await openAdd();
  await kindBtn('Snippet');
  await sleep(300);
  const sn = await js(dialogState);
  check('Snippet: a wide dialog with Title, Language and Code in the mono', sn.kinds.join(' ') === 'Link [Snippet] Prompt Note' && sn.wide && sn.mono && sn.labels.join(' | ') === 'Title | Language (optional) | Code | Use it for (optional) | Tags | Where it came from (optional)' && sn.buttons.join() === 'Cancel,Add snippet', sn);
  await fill({ 'reference-text': SNIPPET, 'reference-language': 'JS' });
  await press('Add snippet');
  await sleep(700);
  const noTitle = await js(dialogState);
  check('a snippet with no title is refused with a sentence that is in sight over the buttons, the focus on the title', noTitle?.reason === 'A snippet needs a title to find it by' && noTitle.focus === 'reference-title' && noTitle.reasonInSight, noTitle);
  await fill({ 'reference-title': 'Debounced save', 'reference-use': 'saving a note while it is typed', 'reference-tags': 'storage, notes', 'reference-source': 'app.js of the notes template' });
  await shot('references-dialog-snippet-1280.jpg');
  await press('Add snippet');
  await sleep(900);
  const first = await js(state);
  check('the snippet is listed under Snippets and holds the focus', first.refs.includes('Snippet: Debounced save') && first.groups.includes('Snippets1: 1') && first.focus === 'Snippet: Debounced save', first);
  const code = await js(`(() => { const n = document.querySelector('.ref-snippet'); const pre = n.querySelector('pre.ref-code'); const cs = getComputedStyle(pre); return { text: pre.textContent, font: cs.fontFamily.split(',')[0], white: cs.whiteSpace, translate: pre.getAttribute('translate'), meta: n.querySelector('.ref-rest .ref-meta').textContent, use: n.querySelector('.ref-use').textContent, copy: [...n.querySelectorAll('.ref-actions .btn')].map((b) => b.textContent || b.getAttribute('aria-label')) }; })()`);
  check('its code shows in the mono as typed, with its language, tags and source under it, and one Copy button', code.text === SNIPPET && /Cascadia|Consolas|monospace/.test(code.font) && code.white === 'pre' && code.translate === 'no' && code.meta === 'js, 5 lines · storage · notes · from app.js of the notes template' && code.use === 'Use it for saving a note while it is typed' && code.copy.join(' | ') === 'Edit this snippet (Enter) | Remove this snippet (Delete) | Copy', code);

  // A prompt: one Copy button, and it copies the prompt's words.
  await openAdd();
  await kindBtn('Prompt');
  await sleep(300);
  await fill({ 'reference-title': 'Name the smallest piece', 'reference-text': PROMPT, 'reference-tags': 'method' });
  await press('Add prompt');
  await sleep(900);
  const copyButtons = await js(`[...document.querySelector('.ref-prompt').querySelectorAll('.ref-actions .btn')].filter((b) => b.textContent === 'Copy').length`);
  await js(`[...document.querySelector('.ref-prompt').querySelectorAll('.ref-actions .btn')].find((b) => b.textContent === 'Copy').click()`);
  await sleep(500);
  const copied = await js(`({ copied: window.__copied, toast: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent) })`);
  check('a prompt has one Copy button, which copies its words and says so', copyButtons === 1 && copied.copied.length === 1 && copied.copied[0] === PROMPT && copied.toast.some((t) => t.startsWith('Copied the prompt: Name the smallest piece')), copied);

  // A note from outside the window arrives by itself; a long snippet shows its first lines and one button for the rest.
  await api('POST', R, { kind: 'note', text: 'localStorage is keyed per project because every preview shares one origin.', tags: ['storage'], source: 'docs/DECISIONS.md' });
  await api('POST', R, { kind: 'snippet', title: 'Thirty steps', language: 'js', text: LONG, tags: ['steps'] });
  await sleep(1300);
  const arrived = await js(state);
  const total = OFFLINE ? 4 : 5;
  check('entries added elsewhere appear without a reload, by kind, newest first within a kind', arrived.refs.length === total && arrived.groups.join() === `${OFFLINE ? '' : 'Links1: 1,'}Snippets2: 2,Prompts1: 1,Notes1: 1` && arrived.refs.indexOf('Snippet: Thirty steps') < arrived.refs.indexOf('Snippet: Debounced save') && arrived.head === `Refs Check · ${total} references`, arrived);
  check('the switch counts the references', (await js(`document.querySelectorAll('.inspo-seg-n')[1].textContent`)) === String(total));
  const long = `(() => { const n = [...document.querySelectorAll('.ref-snippet')].find((r) => r.textContent.includes('Thirty steps')); const pre = n.querySelector('pre'); const more = n.querySelector('.ref-more'); return { lines: pre.textContent.split('\\n').length, more: more?.textContent, expanded: more?.getAttribute('aria-expanded'), sideways: pre.scrollWidth > pre.clientWidth, rowSideways: n.scrollWidth - n.clientWidth }; })()`;
  const clamped = await js(long);
  await js(`[...document.querySelectorAll('.ref-snippet')].find((r) => r.textContent.includes('Thirty steps')).querySelector('.ref-more').click()`);
  await sleep(300);
  const opened = await js(long);
  check('a long snippet shows 12 lines and Show all 30 lines; the button opens and closes it; long lines scroll inside the code, not the page', clamped.lines === 12 && clamped.more === 'Show all 30 lines' && clamped.expanded === 'false' && clamped.sideways && clamped.rowSideways <= 0 && opened.lines === 30 && opened.more === 'Show less' && opened.expanded === 'true', { clamped, opened });
  await js(`[...document.querySelectorAll('.ref-snippet')].find((r) => r.textContent.includes('Thirty steps')).querySelector('.ref-more').click()`);
  await sleep(300);
  await shot('references-1280.jpg');

  // Search over titles, text and tags; the tag filter; both narrow together; Esc clears the search.
  const type = async (q) => { await js(`(() => { const s = document.querySelector('.refs-search'); s.focus(); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(400); };
  await type('settimeout');
  const byText = await js(state);
  check('a search finds a word of the text and the head says how many', byText.refs.join() === 'Snippet: Debounced save' && byText.head === `Refs Check · 1 of ${total} references · “settimeout”` && byText.focus === 'Search the references', byText);
  await type('smallest method');
  const byBoth = await js(state);
  check('every word must be there, in a title or a tag alike', byBoth.refs.join() === 'Prompt: Name the smallest piece', byBoth);
  await type('kubernetes');
  const nothing = await js(state);
  check('a search that finds nothing says so and offers the way back', /^No reference matches\./.test(nothing.fill || '') && nothing.refs.length === 0 && nothing.barShown, nothing);
  await shot('references-nomatch-1280.jpg');
  win.webContents.focus();
  await js(`document.querySelector('.refs-search').focus()`);
  await key('Escape');
  const cleared = await js(state);
  check('Esc in the search clears it', cleared.search === '' && cleared.refs.length === total, cleared);
  await js(`[...document.querySelectorAll('.refs-bar .inspo-filter-tag')].find((b) => b.textContent.startsWith('storage')).click()`);
  await sleep(400);
  const byTag = await js(state);
  check('the tag filter shows the entries with that tag, and the tags with their counts', byTag.refs.join(' | ') === 'Snippet: Debounced save | Note: localStorage is keyed per project because every preview shares one origin.' && byTag.tags.includes('[storage2]') && byTag.tags[0] === `All${total}` && byTag.head === `Refs Check · 2 of ${total} references · storage`, byTag);
  await type('debounced');
  check('the tag and the search narrow together', (await js(state)).refs.join() === 'Snippet: Debounced save');
  await type('');
  await js(`document.querySelector('.refs-bar .inspo-filter-tag').click()`);
  await sleep(400);

  // Edit by Enter on the focused entry; nothing changed closes without a write.
  await focusRef('localStorage');
  await key('Enter');
  const editDlg = await js(dialogState);
  check('Enter on an entry opens its Edit dialog: its kind in the title, no kind switch', editDlg?.title === 'Edit note' && editDlg.kinds.length === 0 && editDlg.labels.join(' | ') === 'Title (optional) | Note | Use it for (optional) | Tags | Where it came from (optional)' && editDlg.buttons.join() === 'Cancel,Save', editDlg);
  await fill({ 'reference-title': 'Storage keys', 'reference-use': 'anything that keeps data in the browser' });
  await press('Save');
  await sleep(900);
  const edited = await js(state);
  check('the edit shows and the entry holds the focus again', edited.refs.includes('Note: Storage keys') && edited.focus === 'Note: Storage keys', edited);

  // While the references are shown, a paste adds no card to the board.
  await js(`(() => { document.getElementById('main').focus(); const dt = new DataTransfer(); dt.setData('text/plain', '#ff0000'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await sleep(900);
  check('a paste on the references adds no card', (await api('GET', `/api/projects/${one.id}/inspiration`)).data.cards.length === 0);

  // Remove asks once: Keep it leaves the entry, Remove takes it.
  await focusRef('Name the smallest piece');
  await key('Delete');
  const ask = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, words: d.querySelector('.dialog-body').textContent, buttons: [...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent) }; })()`);
  check('Delete asks once, in words that say what stops', ask?.title === 'Remove prompt' && ask.words === "Remove this prompt from Refs Check's references? Claude will no longer get it in a brief." && ask.buttons.join() === 'Keep it,Remove', ask);
  await press('Keep it');
  await sleep(400);
  const kept = (await js(state)).refs.length;
  await focusRef('Name the smallest piece');
  await key('Delete');
  await press('Remove');
  await sleep(1000);
  const removed = await js(state);
  check('Keep it keeps the entry; Remove takes it and the focus goes to the next entry', kept === total && removed.refs.length === total - 1 && !removed.refs.some((t) => t.includes('smallest')) && removed.focus === 'Note: Storage keys', { kept, removed });

  // A reload finds the same part and the same entries; another project shows its own.
  win.webContents.reloadIgnoringCache();
  await sleep(3500);
  await js(standIn);
  const reloaded = await js(state);
  check('a reload stays on References with the entries as they were', reloaded?.hash === '#/inspiration/references' && reloaded.seg.join(' ') === `Board Fixed rules [References${total - 1}] Visualizer` && reloaded.refs.join(' | ') === removed.refs.join(' | '), reloaded);
  await pick(two.id);
  const other = await js(state);
  check('switching the project shows that project\'s references', other.refs.join() === 'Note: The other project keeps one note of its own.' && other.head === 'Other Check · 1 reference', other);
  await pick(one.id);
  const back = await js(state);
  check('and back', back.refs.join(' | ') === removed.refs.join(' | ') && back.head === `Refs Check · ${total - 1} references`, back);

  // The layout with more entries: laptop, wide, small, light.
  const more = [
    { kind: 'link', url: 'https://example.org/', title: 'A typed title for a second link, long enough to wrap onto a second line in a column', useFor: 'checking how a long title wraps', tags: ['docs'] },
    { kind: 'prompt', title: 'Review a diff', text: 'Review this diff for correctness.\nName each fault with its line and say what input shows it.\n\n' + 'Then list what you did not check. '.repeat(30), useFor: 'a second opinion before a version is kept', tags: ['review', 'method'], source: 'the Codex tab' },
    { kind: 'note', title: 'Chips', text: 'Chips are for states only; kinds and modes are plain words.', tags: ['design'], source: 'docs/DESIGN.md section 1' },
    { kind: 'snippet', title: 'A hairline row', language: 'css', text: '.row {\n  padding: var(--s3) 0;\n  border-top: 1px solid var(--line);\n}', useFor: 'lists that are read, not picked from', tags: ['design', 'css'] },
    { kind: 'note', text: 'A note with no title: its words are its name, in the ink, and it can run to a second line when it has more to say than fits in one.' },
  ];
  if (!OFFLINE) for (const m of more) { const r = await api('POST', R, m); if (r.status !== 200) throw new Error(`fixture refused: ${JSON.stringify(r.data)}`); }
  else for (const m of more.filter((x) => x.kind !== 'link')) await api('POST', R, m);
  await sleep(1500);
  const geometry = `(() => { const host = document.querySelector('.refs-scroll'); const rows = [...host.querySelectorAll('.ref')].map((n) => n.getBoundingClientRect()); const cols = [...new Set(rows.map((r) => Math.round(r.left)))].sort((a, b) => a - b); let overlaps = 0;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) { const p = rows[i], q = rows[j]; if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) overlaps++; }
    const head = document.querySelector('.inspo-head'); const bar = document.querySelector('.refs-bar');
    return { window: innerWidth + 'x' + innerHeight, refs: rows.length, columns: cols.length, columnWidth: Math.round(rows[0]?.width || 0), overlaps, sideways: host.scrollWidth - host.clientWidth, pageSideways: document.documentElement.scrollWidth - innerWidth, headFits: head.scrollWidth <= head.clientWidth, barFits: bar.scrollWidth <= bar.clientWidth, scrolls: host.scrollHeight > host.clientHeight }; })()`;
  const laptop = await js(geometry);
  check('1280×720: two columns, nothing overlaps, no sideways scroll, the head and the bar fit', laptop.columns === 2 && laptop.overlaps === 0 && laptop.sideways <= 0 && laptop.pageSideways <= 0 && laptop.headFits && laptop.barFits && laptop.columnWidth <= 640, laptop);
  await shot('references-full-1280.jpg');
  const clampedPrompt = await js(`(() => { const n = [...document.querySelectorAll('.ref-prompt')].find((r) => r.textContent.includes('Review a diff')); const p = n.querySelector('.ref-text'); return { clamped: p.classList.contains('clamped'), cut: p.scrollHeight > p.clientHeight + 2, more: n.querySelector('.ref-more')?.textContent }; })()`);
  check('a long prompt shows its first lines and Show all', clampedPrompt.clamped && clampedPrompt.cut && clampedPrompt.more === 'Show all', clampedPrompt);
  // The focus by the keyboard, as a person reaches an entry: from its first button, Shift+Tab lands on the entry itself.
  win.webContents.focus();
  await sleep(300);
  await js(`document.querySelector('.ref-note .ref-tools button').focus()`);
  await key('Tab', ['shift']);
  const focusLook = await js(`(() => { const n = document.activeElement; const a = n.querySelector('.ref-tools'); const cs = getComputedStyle(n); return { isRef: n.classList.contains('ref'), outline: cs.outlineStyle, tools: a && getComputedStyle(a).opacity, buttons: a && [...a.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) }; })()`);
  check('a focused entry shows its ring and its actions, each button named', focusLook.isRef && focusLook.outline === 'solid' && focusLook.tools === '1' && focusLook.buttons.join(' | ') === 'Edit this note (Enter) | Remove this note (Delete)', focusLook);
  await shot('references-focus-1280.jpg');
  win.setSize(1920, 1080); await sleep(1200);
  const wide = await js(geometry);
  check('1920×1080: three columns of a readable measure, nothing overlaps, no sideways scroll', wide.columns === 3 && wide.overlaps === 0 && wide.sideways <= 0 && wide.pageSideways <= 0 && wide.headFits && wide.columnWidth <= 640, wide);
  await shot('references-1920.jpg');
  win.setSize(1000, 700); await sleep(1200);
  const small = await js(geometry);
  check('1000×700: still no overlap and no sideways scroll', small.overlaps === 0 && small.sideways <= 0 && small.pageSideways <= 0, small);
  await shot('references-1000.jpg');
  win.setSize(1280, 720); await sleep(800);
  await openAdd();
  await kindBtn('Snippet');
  await sleep(300);
  await fill({ 'reference-title': 'A snippet being written', 'reference-language': 'js', 'reference-text': SNIPPET, 'reference-tags': 'storage' });
  const dialogBox = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const r = d.getBoundingClientRect(); const b = d.querySelector('.dialog-body'); return { width: Math.round(r.width), fits: r.bottom <= innerHeight && r.top >= 0, sideways: b.scrollWidth - b.clientWidth, tagButtons: [...d.querySelectorAll('.inspo-tagbtn')].map((t) => (t.getAttribute('aria-pressed') === 'true' ? '[' + t.textContent + ']' : t.textContent)) }; })()`);
  check('the snippet dialog fits the laptop window with no sideways scroll, and offers the tags in use', dialogBox.fits && dialogBox.sideways <= 0 && dialogBox.width === 720 && dialogBox.tagButtons.includes('[storage]') && dialogBox.tagButtons.includes('design'), dialogBox);
  await shot('references-dialog-1280.jpg');
  await js(`document.querySelector('dialog.dialog[open] .dialog-head button').click()`);
  await sleep(300);
  await js(`document.getElementById('theme-toggle').click()`); await sleep(600);
  const light = await js(`({ theme: document.documentElement.dataset.theme, ink: getComputedStyle(document.querySelector('.ref-title')).color, code: getComputedStyle(document.querySelector('.ref-code')).backgroundColor })`);
  check('the light theme draws the references from its own tokens', light.theme === 'light' && light.ink === 'rgb(31, 28, 24)' && light.code === 'rgb(243, 244, 247)', light);
  win.setSize(1282, 720); await sleep(500); win.setSize(1280, 720); await sleep(900);
  const lightShot = await shot('references-light-1280.jpg');
  const corner = pixel(lightShot, 6, lightShot.getSize().height - 6);
  check('the captured picture is the light theme', corner[0] > 200 && corner[1] > 200 && corner[2] > 190, corner);
  await js(`document.getElementById('theme-toggle').click()`); await sleep(300);

  // The other parts stand as before: Fixed rules, then the board with Add as its one primary button.
  await segClick('Fixed rules');
  await sleep(600);
  const rules = await js(state);
  check('Fixed rules shows the rules part alone, with Add rule', rules.hash === '#/inspiration/rules' && rules.rulesShown && !rules.barShown && rules.primaries.join() === 'Add rule', rules);
  await segClick('Board');
  await sleep(600);
  const again = await js(state);
  check('Board brings the board back, with Add as the one primary button', again.hash === '#/inspiration' && again.boardShown && again.fieldShown && !again.barShown && again.primaries.join() === 'Add' && again.head === 'Refs Check · 0 cards', again);
  check('no console errors', errors.length === 0, errors);
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(2); });
