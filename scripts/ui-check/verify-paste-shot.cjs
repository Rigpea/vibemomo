// Ctrl+V of a screenshot in the companion's composer attaches it (screenshot-<time>.png) and leaves the box empty;
// pasted text still lands as text. Offscreen on the LIVE studio, with a synthetic paste event: the system clipboard
// is never touched. The pasted image is saved under the project's .studio/attachments; the script prints its path.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-paste-shot.cjs <projectName>
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(path.resolve(__dirname, '..', '..'), '.local', 'shot-live');
const BASE = process.env.ATELIER_LIVE || 'http://127.0.0.1:4747';
const projectName = process.argv[2] || '';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
setTimeout(() => { console.log(JSON.stringify({ error: 'timed out' })); app.exit(2); }, 60000);

app.whenReady().then(async () => {
  const facts = {};
  try {
    const win = new BrowserWindow({ width: 1366, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2500);
    facts.picked = await js(`(() => { const s = document.querySelector('#project-pick select'); const o = [...(s?.options || [])].find((x) => x.textContent.replace('● ', '') === ${JSON.stringify(projectName)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(2500);
    await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim().startsWith('Claude Code'))?.click()`);
    await sleep(1500);
    facts.composer = await js(`!!document.querySelector('.cmp-composer textarea')`);
    // A running answer disables the box; this test window enables it to dispatch the paste (nothing is sent).
    const paste = (setup) => js(`(async () => { const ta = document.querySelector('.cmp-composer textarea'); ta.disabled = false; ta.value = '';
      const dt = new DataTransfer(); ${setup}
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); ta.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented }; })()`);
    const png = `const c = document.createElement('canvas'); c.width = 40; c.height = 24; c.getContext('2d').fillRect(0, 0, 40, 24);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png')); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));`;
    facts.imagePaste = await paste(png);
    await sleep(1500);
    facts.chips = await js(`[...document.querySelectorAll('.cmp-files .attach')].map((a) => ({ name: a.textContent.trim(), path: a.title.split(' · ')[0] }))`);
    facts.boxAfterImage = await js(`document.querySelector('.cmp-composer textarea').value`);
    facts.textPaste = await paste(`dt.setData('text/plain', 'hello');`);
    win.webContents.invalidate(); await sleep(900);
    fs.writeFileSync(path.join(OUT, 'paste-shot.jpg'), (await win.webContents.capturePage()).toJPEG(80));
  } catch (err) { facts.error = err.message; }
  console.log(JSON.stringify(facts, null, 1));
  app.exit(0);
});
