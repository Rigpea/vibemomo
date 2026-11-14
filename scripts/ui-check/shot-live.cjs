// Read-only screenshot of the LIVE studio (http://127.0.0.1:4747) in an offscreen Electron window with
// software rendering: for a by-eye check when the browser pane is not available. It only reads: it
// clicks a project row, moves to a view, optionally expands one task row, and captures the page.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/shot-live.cjs <view> <projectName> <outName> [width] [height] [taskTitlePart]
//   view: workbench | tasks | claude-code | memory | budget | settings   outName: file name without extension
//   panelTab (7th, optional): focus | task, the Workbench panel tab to show, with every disclosure opened
//   panelScroll (8th, optional): bottom, to scroll the panel to its end before the capture
// Writes .local/shot-live/<outName>.jpg and prints one line of facts (JSON) about what it saw.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'shot-live');
const BASE = process.env.ATELIER_LIVE || 'http://127.0.0.1:4747';
const [view = 'workbench', projectName = '', outName = 'shot', width = '1366', height = '800', taskTitlePart = '', panelTab = '', panelScroll = ''] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
setTimeout(() => { console.log(JSON.stringify({ error: 'timed out' })); app.exit(2); }, 60000);

app.whenReady().then(async () => {
  const facts = { view, projectName, outName };
  try {
    const win = new BrowserWindow({ width: Number(width), height: Number(height), show: false, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2000);
    if (projectName) {
      facts.projectClicked = await js(`(() => { const rows = [...document.querySelectorAll('#rail button.item, .rail button.item')]; const row = rows.find((r) => (r.querySelector('.item-title')?.textContent || r.textContent).trim() === ${JSON.stringify(projectName)}) || rows.find((r) => r.textContent.trim().startsWith(${JSON.stringify(projectName)})); if (!row) return false; row.click(); return true; })()`);
      await sleep(1500);
    }
    await js(`location.hash = ${JSON.stringify('#/' + view)}`);
    await sleep(1200 + Number(process.env.ATELIER_SHOT_WAIT || 0)); // ATELIER_SHOT_WAIT: extra ms for a view that loads lazily (Claude Code)
    if (taskTitlePart) {
      if (view === 'tasks') { facts.scopeAll = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'All projects'); if (!b) return false; b.click(); return true; })()`); await sleep(800); }
      await js(`document.querySelectorAll('details').forEach((d) => { d.open = true; })`); // a collapsed Done group hides its rows
      await sleep(600);
      facts.taskExpanded = await js(`(() => { const sums = [...document.querySelectorAll('.task-sum')]; const s = sums.find((x) => x.textContent.includes(${JSON.stringify(taskTitlePart)})); if (!s) return false; if (s.getAttribute('aria-expanded') !== 'true') s.click(); return true; })()`);
      await sleep(1200);
      facts.taskText = await js(`(() => { const sums = [...document.querySelectorAll('.task-sum')]; const s = sums.find((x) => x.textContent.includes(${JSON.stringify(taskTitlePart)})); const art = s && s.closest('article'); return art ? art.innerText.replace(/\\s+/g, ' ').slice(0, 600) : null; })()`);
      facts.buttons = await js(`(() => { const sums = [...document.querySelectorAll('.task-sum')]; const s = sums.find((x) => x.textContent.includes(${JSON.stringify(taskTitlePart)})); const art = s && s.closest('article'); return art ? [...art.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean) : []; })()`);
    }
    if (panelTab) {
      facts.panelTab = await js(`(() => { const b = [...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim().toLowerCase() === ${JSON.stringify(panelTab.toLowerCase())}); if (!b) return false; b.click(); return true; })()`);
      await sleep(900);
      await js(`document.querySelectorAll('.focus details, .collab details').forEach((d) => { d.open = true; })`);
      if (panelScroll === 'bottom') { facts.scrolled = await js(`(() => { let p = document.querySelector('.focus') || document.querySelector('.collab'); while (p && p.scrollHeight <= p.clientHeight + 2) p = p.parentElement; if (!p) return false; p.scrollTop = p.scrollHeight; return p.className || p.tagName; })()`); }
      await sleep(1500); // the offscreen window paints late: give the tab switch time before the capture
      facts.panelText = await js(`(document.querySelector('.focus') || document.querySelector('.collab'))?.innerText.replace(/\\s+/g, ' ').slice(${panelScroll === 'bottom' ? -1400 : 0}, ${panelScroll === 'bottom' ? 'undefined' : 1400}) || null`);
    }
    facts.title = await js('document.title');
    facts.activeView = await js(`document.querySelector('.app')?.dataset.view || null`);
    const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]);
    fs.writeFileSync(path.join(OUT, `${outName}.jpg`), img.toJPEG(85));
    facts.file = path.join(OUT, `${outName}.jpg`);
  } catch (err) {
    facts.error = String(err && err.message || err);
  }
  console.log(JSON.stringify(facts));
  app.exit(facts.error ? 1 : 0);
});
