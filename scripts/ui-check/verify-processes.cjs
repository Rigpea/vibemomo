// The Processes tab beside Task inspector and Focus: the picker (the open project, other projects with runs this hour,
// All projects), the hub, a node per run of the last hour, the legend and a node's reports; All projects with a hub per
// project; the choice kept across a reload (sessionStorage). Offscreen on the LIVE studio; it only reads (the tab and
// the picker choice are this window's sessionStorage).
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-processes.cjs <projectName>
// Writes .local/shot-live/processes.jpg (the open project), processes-all.jpg (All projects) and processes-other.jpg
// (another project with runs, when there is one) and prints the facts as JSON.
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
setTimeout(() => { console.log(JSON.stringify({ error: 'timed out' })); app.exit(2); }, 90000);

const READ = `(() => { const g = document.querySelector('.process-graph'); const s = g?.querySelector('.pg-select'); return g && { shown: !g.hidden,
  picker: s && { value: s.value, options: [...s.options].map((o) => [o.value, o.textContent]) }, note: g.querySelector('.pg-note')?.textContent || '',
  count: g.querySelector('.pg-count')?.textContent, hubs: [...g.querySelectorAll('.pg-hub')].map((h) => ({ project: h.dataset.project, text: h.textContent, button: h.getAttribute('role') === 'button' })),
  nodes: [...g.querySelectorAll('.pg-node')].map((n) => n.getAttribute('aria-label')),
  edges: [...g.querySelectorAll('path.pg-edge')].map((p) => p.getAttribute('class')), more: [...g.querySelectorAll('.pg-more-line, .pg-more')].map((m) => m.textContent),
  detail: g.querySelector('.pg-detail-head')?.textContent || '', reports: [...g.querySelectorAll('.pg-reports li')].map((l) => l.textContent).slice(0, 3),
  kept: sessionStorage.getItem('atelier.processesOf'), svgHeight: g.querySelector('.pg-svg')?.getAttribute('height') }; })()`;
const choose = (value) => `(() => { const s = document.querySelector('.process-graph .pg-select'); if (!s || ![...s.options].some((o) => o.value === ${JSON.stringify(value)})) return false; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return true; })()`;

app.whenReady().then(async () => {
  const facts = {};
  try {
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => { win.webContents.invalidate(); await sleep(900); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toJPEG(85)); };
    const openTab = () => js(`(() => { const b = [...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim() === 'Processes'); if (!b) return false; b.click(); return true; })()`);
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2500);
    await js(`sessionStorage.removeItem('atelier.processesOf')`);
    if (projectName) {
      facts.picked = await js(`(() => { const s = document.querySelector('#project-pick select'); const o = [...(s?.options || [])].find((x) => x.textContent.replace('● ', '') === ${JSON.stringify(projectName)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(2500);
    }
    facts.clicked = await openTab();
    await sleep(1200);
    facts.open = await js(READ);
    await shot('processes.jpg');

    facts.choseAll = await js(choose('all'));
    await sleep(800);
    facts.all = await js(READ);
    await shot('processes-all.jpg');

    // Another project with runs, if the picker lists one: its runs as the hub and nodes.
    const other = (facts.open?.picker?.options || []).map((o) => o[0]).find((v) => v !== 'open' && v !== 'all');
    if (other) {
      facts.choseOther = await js(choose(other));
      await sleep(800);
      facts.other = await js(READ);
      await shot('processes-other.jpg');
    }

    // Kept for the session: a reload of the same window comes back to the same choice.
    const keptBefore = await js(`sessionStorage.getItem('atelier.processesOf')`);
    await win.webContents.reload();
    await sleep(3000);
    await openTab();
    await sleep(1200);
    facts.afterReload = { keptBefore, ...(await js(`(() => { const s = document.querySelector('.process-graph .pg-select'); return { value: s?.value, kept: sessionStorage.getItem('atelier.processesOf') }; })()`)) };

    // A hub among all projects is a button: Enter on it shows that project alone.
    await js(choose('all'));
    await sleep(800);
    facts.hubKey = await js(`(() => { const h = [...document.querySelectorAll('.process-graph .pg-hub[role=button]')].pop(); if (!h) return null; h.focus(); const was = document.activeElement === h; h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return { focused: was, project: h.dataset.project, value: document.querySelector('.process-graph .pg-select').value, focusOn: document.activeElement?.className }; })()`);
    await js(`sessionStorage.removeItem('atelier.processesOf')`);
  } catch (err) { facts.error = err.message; }
  console.log(JSON.stringify(facts, null, 1));
  app.exit(0);
});
