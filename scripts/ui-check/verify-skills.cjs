// The Skills tab beside Task inspector, Processes and Focus: the tab and its count, the groups and cards, the filter,
// a card's SKILL.md read-only, and Add skill with a .zip put into the dialog's file input (a new skill, then the same
// one again: Replace waits for the box, then replaces), and a refused .zip. Offscreen. Add writes into the project's
// .claude/skills, so run it against a throwaway project or studio, never the person's own. Keep that project's folder
// outside any other git repo: git.isRepo answers true inside an enclosing repo, so create skips git init and its first
// checkpoint commits to the outer repo (seen on 2026-11-07 with a project under the studio's .local/).
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-skills.cjs <projectName> [baseUrl]
// Writes .local/shot-live/skills*.jpg and prints the facts as JSON.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');

const OUT = path.join(path.resolve(__dirname, '..', '..'), '.local', 'shot-live');
const projectName = process.argv[2] || '';
const BASE = process.argv[3] || process.env.ATELIER_LIVE || 'http://127.0.0.1:4747';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
setTimeout(() => { console.log(JSON.stringify({ error: 'timed out' })); app.exit(2); }, 90000);

const zipOf = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toString('base64');
const NAME = `tone-check-${Date.now().toString(36)}`; // a new name each run, so the first Add is a plain add
const GOOD = zipOf({ [`${NAME}/SKILL.md`]: `---\nname: ${NAME}\ndescription: Check the colour contrast and typography of a page against the design tokens.\n---\n\n# Tone check\n\nRead client/styles.css first.\n`, [`${NAME}/notes.md`]: 'notes' });
const BAD = zipOf({ 'nameless/SKILL.md': '---\nname: nameless\n---\nNo description here.\n' });

app.whenReady().then(async () => {
  const facts = {};
  try {
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => { win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toJPEG(85)); };
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2500);
    if (projectName) {
      facts.picked = await js(`(() => { const s = document.querySelector('#project-pick select'); const o = [...(s?.options || [])].find((x) => x.textContent.replace('● ', '') === ${JSON.stringify(projectName)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(2500);
    }
    facts.tabBefore = await js(`[...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim().startsWith('Skills'))?.textContent`);
    facts.clicked = await js(`(() => { const b = [...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim().startsWith('Skills')); if (!b) return false; b.click(); return true; })()`);
    await sleep(1500);
    const panelFacts = `(() => { const p = document.querySelector('.skills-panel'); return p && { shown: !p.hidden, title: document.querySelector('.collab-title')?.textContent,
      ownButtonHidden: [...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim().startsWith('Skills'))?.hidden, focus: document.activeElement?.getAttribute('aria-label'),
      summary: p.querySelector('.sk-count')?.textContent, groups: [...p.querySelectorAll('.sk-group')].map((g) => g.querySelector('h3').textContent),
      cards: p.querySelectorAll('.sk-card').length, first: [...p.querySelectorAll('.sk-card')].slice(0, 3).map((c) => [c.querySelector('.sk-name').textContent, c.querySelector('.tag').textContent, c.querySelector('.sk-desc').textContent.slice(0, 60)]),
      places: p.querySelector('.sk-places summary')?.textContent, intro: p.querySelector('.sk-intro')?.textContent.slice(0, 80) }; })()`;
    facts.panel = await js(panelFacts);
    // The head must fit on every tab: what it needs against what it has.
    facts.headFit = {};
    for (const t of ['task', 'processes', 'focus', 'skills']) facts.headFit[t] = await js(`(() => { const h = document.querySelector('.collab-head'); [...h.querySelectorAll('button')].find((b) => !b.hidden && b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(t === 'task' ? 'tasks' : t)}))?.click(); return h.scrollWidth + ' of ' + h.clientWidth; })()`);
    await shot('skills.jpg');

    // The filter, then Esc clears it.
    facts.filtered = await js(`(() => { const f = document.querySelector('.skills-panel input[type=search]'); f.value = 'backend'; f.dispatchEvent(new Event('input')); const p = document.querySelector('.skills-panel'); return { summary: p.querySelector('.sk-count').textContent, groups: [...p.querySelectorAll('.sk-group h3')].map((h) => h.textContent) }; })()`);
    facts.cleared = await js(`(() => { const f = document.querySelector('.skills-panel input[type=search]'); f.focus(); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return { value: f.value, summary: document.querySelector('.skills-panel .sk-count').textContent }; })()`);

    // A card's name by keyboard: focus, Enter (a button), the dialog with SKILL.md read-only. Since the departments the
    // card is a box holding the name's button and the department boxes, so the name is what opens SKILL.md.
    facts.cardFocus = await js(`(() => { const c = document.querySelector('.skills-panel .sk-card .sk-name'); c.focus(); const ok = document.activeElement === c; c.click(); return { focused: ok, name: c.textContent }; })()`);
    await sleep(1200);
    facts.file = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, where: d.querySelector('.sk-file-where')?.textContent, use: d.querySelector('.sk-file-use')?.textContent.slice(0, 100), meta: d.querySelector('.sk-file p.meta')?.textContent, text: d.querySelector('pre.sk-text')?.textContent.slice(0, 40), editable: !!d.querySelector('textarea, [contenteditable=true]') }; })()`);
    await sleep(1200); await js(`document.querySelector('dialog.dialog[open] pre.sk-text')?.scrollIntoView()`);
    await shot('skills-file.jpg');
    await js(`document.querySelector('dialog.dialog[open] .dialog-head button').click()`);
    await sleep(300);

    // Add skill: a .zip into the hidden file input, as a pick would.
    const putZip = (b64, name) => js(`(() => { const d = document.querySelector('dialog.dialog[open]'); const inp = d.querySelector('input[type=file][accept]'); const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u8], ${JSON.stringify(name)}, { type: 'application/zip' })); inp.files = dt.files; inp.dispatchEvent(new Event('change')); return inp.files.length; })()`);
    const planFacts = `(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, found: d.querySelector('.sk-add-found')?.textContent,
      targets: [...d.querySelectorAll('.sk-target')].map((t) => (t.querySelector('input').checked ? '(x) ' : '( ) ') + t.textContent), replaceBox: !!d.querySelector('#sk-replace') && d.querySelector('.sk-replace') !== null,
      add: [...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent + (b.disabled ? ' [disabled]' : '')), status: d.querySelector('.sk-add-status')?.textContent, focus: document.activeElement?.textContent, sideways: d.querySelector('.dialog-body').scrollWidth - d.querySelector('.dialog-body').clientWidth }; })()`;
    await js(`[...document.querySelectorAll('.skills-panel .sk-head button')].find((b) => b.textContent === 'Add skill').click()`);
    await sleep(400);
    facts.addOpen = await js(planFacts);
    facts.badPick = await putZip(BAD, 'nameless.zip');
    await sleep(1200);
    facts.addBad = await js(planFacts);
    await putZip(GOOD, `${NAME}.zip`);
    await sleep(1200);
    facts.addPlan = await js(planFacts);
    await shot('skills-add.jpg');
    await js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => /^Add/.test(b.textContent)).click()`);
    await sleep(1800);
    facts.toast = await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).slice(-1)[0]`);
    facts.afterAdd = await js(`(() => { const c = [...document.querySelectorAll('.skills-panel .sk-card')].find((x) => x.querySelector('.sk-name').textContent === ${JSON.stringify(NAME)}); return { summary: document.querySelector('.skills-panel .sk-count').textContent, card: c && [c.closest('.sk-group').querySelector('h3').textContent, c.querySelector('.tag').textContent], tab: [...document.querySelectorAll('.collab-head button')].find((x) => x.textContent.trim().startsWith('Skills'))?.textContent }; })()`);

    // The same skill again: the project target is taken, Replace waits for the box.
    await js(`[...document.querySelectorAll('.skills-panel .sk-head button')].find((b) => b.textContent === 'Add skill').click()`);
    await sleep(400);
    await putZip(GOOD, `${NAME}.zip`);
    await sleep(1200);
    facts.againPlan = await js(planFacts);
    await js(`(() => { const b = document.querySelector('dialog.dialog[open] #sk-replace'); b.click(); })()`);
    await sleep(200);
    facts.againChecked = await js(planFacts);
    await shot('skills-replace.jpg');
    await js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => b.textContent === 'Replace').click()`);
    await sleep(1800);
    facts.toastReplace = await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).slice(-1)[0]`);
    facts.dialogsOpen = await js(`document.querySelectorAll('dialog[open]').length`);
  } catch (err) { facts.error = err.message; }
  console.log(JSON.stringify(facts, null, 1));
  app.exit(0);
});
