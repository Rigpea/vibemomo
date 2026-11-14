// The pages column collapses to a tag at the stage head's left and opens again (button, tag, p key), in an offscreen
// window on the LIVE studio. Its layout pref is session-scoped, so the person's own window is untouched.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-left-tag.cjs [projectName]
// Writes .local/shot-live/left-tag-{open,collapsed,reopened}.jpg and prints the facts as JSON.
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
    const shot = async (name) => { win.webContents.invalidate(); await sleep(900); fs.writeFileSync(path.join(OUT, `left-tag-${name}.jpg`), (await win.webContents.capturePage()).toJPEG(80)); };
    const state = () => js(`(() => { const left = document.querySelector('.wb-left'); const tag = document.querySelector('.stage-head .left-tag');
      return { leftShown: !!left && getComputedStyle(left).display !== 'none', leftWidth: Math.round(left?.getBoundingClientRect().width || 0),
        tag: tag ? tag.textContent.trim() : null, tagX: tag ? Math.round(tag.getBoundingClientRect().left) : null, focused: document.activeElement?.className || '' }; })()`);
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2500);
    if (projectName) {
      facts.picked = await js(`(() => { const s = document.querySelector('#project-pick select'); const o = [...(s?.options || [])].find((x) => x.textContent.replace('● ', '') === ${JSON.stringify(projectName)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(2500);
    }
    facts.open = await state(); await shot('open');
    await js(`document.querySelector('.left-head .left-hide').click()`); await sleep(700);
    facts.collapsed = await state(); await shot('collapsed');
    await js(`document.querySelector('.stage-head .left-tag').click()`); await sleep(700);
    facts.reopened = await state(); await shot('reopened');
    await js(`document.body.focus(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))`); await sleep(700);
    facts.pKey = await state();
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))`); await sleep(700);
    facts.pKeyAgain = await state();
  } catch (err) { facts.error = err.message; }
  console.log(JSON.stringify(facts, null, 1));
  app.exit(0);
});
