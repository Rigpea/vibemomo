// By-eye and by-bytes check of Build/Export for the audio kind: a private studio (temp data, own port and
// pid file), a project from templates/audio-sound-sketch, the real client in an offscreen Electron window.
// Exports with no renders, renders all four cues through the Audio panel, exports again, and reads the
// export dialog's Contents line and the unpacked folder.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-export.cjs  (writes .local/verify-export/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-export');
const PORT = 4896;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-export-'));
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const res = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Verify Export', kind: 'audio', template: 'audio-sound-sketch' }) });
  if (!res.ok) throw new Error(`create ${res.status} ${await res.text()}`);
  const pid = (await res.json()).project.id;

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  win.webContents.debugger.attach('1.3');
  const shot = async (name) => { await sleep(400); try { const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { console.log(`shot ${name} skipped: ${err.message}`); } }; // capturePage: the DevTools capture hangs over an open dialog
  const clickButton = (label) => js(`(() => { const all = [...document.querySelectorAll('dialog[open] button, button')]; const b = all.find((x) => x.textContent.trim() === ${JSON.stringify(label)} && x.offsetParent !== null); if (b) b.click(); return !!b; })()`);
  const untilDialog = async (title) => {
    for (let i = 0; i < 60; i++) {
      if (await js(`document.body.innerText.includes(${JSON.stringify(title)})`)) return true;
      await sleep(250);
    }
    return false;
  };
  const notesBox = `[...document.querySelectorAll('dialog[open] .field')].find((f) => f.querySelector('label')?.textContent === 'Release notes')`;
  const readNotes = () => js(`(() => { const f = ${notesBox}; const t = f?.querySelector('textarea'); return f ? { value: t.value, rows: t.rows, hint: f.querySelector('.hint')?.textContent, readonly: t.readOnly, bottomVisible: f.getBoundingClientRect().bottom <= f.closest('dialog').getBoundingClientRect().bottom, sideways: f.closest('.dialog-body').scrollWidth > f.closest('.dialog-body').clientWidth } : null; })()`);
  const typeNotes = (text) => js(`(() => { const t = ${notesBox}?.querySelector('textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const exportOnce = async (name, { edit } = {}) => {
    check(`${name}: the Build/Export button is there`, await clickButton('Build/Export'));
    for (let i = 0; i < 40 && (await readNotes())?.readonly !== false; i++) await sleep(100);
    drafts[name] = await readNotes();
    await shot(`${name}-dialog`);
    if (edit !== undefined) await typeNotes(edit);
    check(`${name}: the confirm button is there`, (await clickButton('Export anyway')) || (await clickButton('Export')));
    check(`${name}: the Export ready dialog opens`, await untilDialog('Export ready'));
    await sleep(300);
    const rows = await js(`(() => { const dts = [...document.querySelectorAll('dl.kv dt')]; const out = {}; for (const dt of dts) if (dt.offsetParent !== null) out[dt.textContent.trim()] = dt.nextElementSibling?.textContent.trim(); return out; })()`);
    const dd = await js(`(() => { const dt = [...document.querySelectorAll('dl.kv dt')].find((x) => x.textContent.trim() === 'Contents' && x.offsetParent !== null); const d = dt?.nextElementSibling; if (!d) return null; const r = d.getBoundingClientRect(); return { lines: Math.round(r.height / parseFloat(getComputedStyle(d).lineHeight)), overflow: d.scrollWidth > d.clientWidth }; })()`);
    await shot(name);
    await clickButton('Close');
    await sleep(400);
    return { rows, dd };
  };

  const drafts = {};
  await win.loadURL(`${BASE}/#workbench`);
  await sleep(2500);

  const bare = await exportOnce('a-no-renders');
  check('with no renders the dialog says so in one line', bare.rows.Contents === 'static copy, no rendered files yet' && bare.dd?.lines === 1 && !bare.dd?.overflow, bare);
  const bareFolder = bare.rows.Folder;
  check('with no renders the folder has no audio/', !fs.existsSync(path.join(bareFolder, 'audio')), bareFolder);
  const bareFiles = fs.readdirSync(bareFolder).sort();

  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === 'Audio')?.click()`);
  await sleep(800);
  for (const id of ['tap', 'blip', 'tick', 'swell']) {
    await js(`document.querySelector('[data-render="${id}"]')?.click()`);
    await sleep(1500);
  }
  await shot('b-rendered');
  const projectDir = path.dirname(path.dirname(bareFolder));
  const onDisk = fs.existsSync(path.join(projectDir, 'dist', 'audio')) ? fs.readdirSync(path.join(projectDir, 'dist', 'audio')).sort() : [];
  const wavs = onDisk.filter((n) => n.endsWith('.wav'));
  check('Render to file wrote four WAVs (sidecars beside them since #53)', wavs.join() === 'blip.wav,swell.wav,tap.wav,tick.wav', onDisk);

  const full = await exportOnce('c-with-renders');
  check('with renders the dialog names how many in one line', full.rows.Contents === 'static copy + 4 rendered files' && full.dd?.lines === 1 && !full.dd?.overflow, full);
  const carried = fs.existsSync(path.join(full.rows.Folder, 'audio')) ? fs.readdirSync(path.join(full.rows.Folder, 'audio')).sort() : [];
  check('the export folder carries the four WAVs and no sidecar', carried.join() === wavs.join() && carried.length === 4, carried);
  check('each carried file is byte for byte the render', carried.length === 4 && carried.every((f) => fs.readFileSync(path.join(full.rows.Folder, 'audio', f)).equals(fs.readFileSync(path.join(projectDir, 'dist', 'audio', f)))));
  check('the rest of the export is the same list as before', fs.readdirSync(full.rows.Folder).filter((f) => f !== 'audio').sort().join() === bareFiles.join(), bareFiles);
  check('the zip is on disk', fs.existsSync(full.rows.Zip), full.rows.Zip);

  // Release notes.
  const first = drafts['a-no-renders'];
  check('the first draft says First release and lists the version', /^First release\n#1 /.test(first?.value || ''), first);
  check('the notes are editable, 8 rows, with the hint', first && !first.readonly && first.rows === 8 && first.hint === 'Written into the export as RELEASE-NOTES.md and kept on the release record. Edit freely.', first);
  check('the notes field is inside the dialog and nothing runs sideways at 1366x768', first?.bottomVisible && !first.sideways, first);
  check('a second export of the same version drafts its one released line', /^This version was released as verify-export-v1\.zip on \d{4}-\d{2}-\d{2} \d{2}:\d{2}; no changes since\.$/.test(drafts['c-with-renders']?.value || ''), drafts['c-with-renders']);
  check('Export ready shows the date the record keeps', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(bare.rows.Built || ''), bare.rows);
  check('Export ready counts the notes', /^\d+ lines?, in RELEASE-NOTES\.md$/.test(bare.rows['Release notes'] || ''), bare.rows);
  check('Export ready shows the readiness count from the record', /readiness/i.test(bare.rows.Readiness || ''), bare.rows);
  // Both exports are of #1 and share a folder, so this is the second export's file.
  const notesFile = fs.readFileSync(path.join(full.rows.Folder, 'RELEASE-NOTES.md'), 'utf8');
  check('RELEASE-NOTES.md holds a heading, the draft and a last line', notesFile.startsWith('# Verify Export: #1 ') && notesFile.includes(`\n\n${drafts['c-with-renders']?.value}\n\n`) && /\n\d{4}-\d{2}-\d{2} \d{2}:\d{2} · [0-9a-f]{40}\n$/.test(notesFile), notesFile);

  const typed = 'Typed by the driver\n\nsecond paragraph';
  const edited = await exportOnce('d-edited', { edit: typed });
  check('what was typed is what ships', fs.readFileSync(path.join(edited.rows.Folder, 'RELEASE-NOTES.md'), 'utf8').includes(`\n\n${typed}\n\n`));
  check('Export ready counts what was typed', edited.rows['Release notes'] === '3 lines, in RELEASE-NOTES.md', edited.rows);

  const records = async () => (await (await fetch(`${BASE}/api/projects/${pid}/releases`)).json());
  check('the record keeps the text as typed', (await records()).at(-1).notes === typed);
  const none = await exportOnce('e-emptied', { edit: '' });
  check('emptied notes say so and leave no file', none.rows['Release notes'] === 'no release notes' && !fs.existsSync(path.join(none.rows.Folder, 'RELEASE-NOTES.md')), none.rows);

  const count = (await records()).length;
  await clickButton('Build/Export');
  for (let i = 0; i < 40 && (await readNotes())?.readonly !== false; i++) await sleep(100);
  await typeNotes('x'.repeat(21000));
  (await clickButton('Export anyway')) || (await clickButton('Export'));
  await sleep(500);
  const over = await readNotes();
  const alert = await js(`document.querySelector('dialog[open] [role="alert"]')?.textContent || null`);
  await shot('f-over-limit');
  check('over the limit the dialog stays open with the text and says why', over?.value.length === 21000 && /limit/.test(alert || ''), alert);
  await clickButton('Cancel');
  await sleep(400);
  check('Cancel discards: no build, no record', (await records()).length === count && !(await js(`!!document.querySelector('dialog[open]')`)));

  await js(`window.atelier.showPanel('focus')`);
  await sleep(600);
  const titles = await js(`[...document.querySelectorAll('.focus ul.releases li')].map((li) => li.querySelector('[title]')?.title || '')`);
  check('the Focus releases list shows the notes on hover', titles.some((t) => t.startsWith(`${typed}\n\n`)), titles);
  check('a release with no notes shows only its path', titles[0] !== undefined && !titles[0].includes(typed), titles);
  await shot('g-focus');
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
