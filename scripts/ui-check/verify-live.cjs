// By-eye check of the Live switch (client/components/live-switch.js, ARCHITECTURE.md section 20) on a temp web-app
// project whose atelier.json declares the FAKE live server (tests/fixtures/fake-live.mjs): off; the consent dialog
// naming the exact argv and folder; running with the live page in the frame, the cap and no line under it, the runs
// strip hidden then shown by More · Show runs under the preview and kept after a reload (decision row 149); the masked log;
// off again with the files on disk back; a changed command asking again and failing; an invalid entry.
// A private studio (temp data, own port and pid file), the real client, a laptop-sized window (1280x800).
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-live.cjs  (writes .local/verify-live/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-live');
const PORT = 4912;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-live-'));
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const mask = (s) => String(s || '').replace(/#[^\s"]+/g, '#•••'); // results.json never holds the token

let server = null;
let pid = null;
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  try { if (pid) await api('POST', `/api/projects/${pid}/live/stop`); } catch { /* server gone */ }
  server?.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 150000);

app.disableHardwareAcceleration();

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const created = await api('POST', '/api/projects', { name: 'Verify Live', kind: 'web-app', template: 'web-app-notes' });
  pid = created.project?.id || created.id;
  await api('PUT', `/api/projects/${pid}/files`, { path: 'fake-live.mjs', content: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'fake-live.mjs'), 'utf8') });
  const manifest = JSON.parse((await api('GET', `/api/projects/${pid}/files?path=atelier.json`)).content);
  const setLive = async (live) => api('PUT', `/api/projects/${pid}/files`, { path: 'atelier.json', content: JSON.stringify({ ...manifest, live }, null, 2) });
  await setLive({ label: 'Live mode: fake editor + terminal', command: ['node', 'fake-live.mjs', '--atelier'], cwd: '.' });
  await api('POST', `/api/projects/${pid}/activate`);

  const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // A hidden window paints lazily: invalidate first, or the capture can be the frame before the last change.
  const shot = async (name) => { win.setSize(1281, 800); await sleep(150); win.setSize(1280, 800); win.webContents.invalidate(); await sleep(900); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const ctl = () => js(`(() => { const c = document.querySelector('#main .live-ctl'); const f = document.querySelector('#main .wb-stage iframe'); return c ? { hidden: c.hidden, checked: c.querySelector('input').checked, disabled: c.querySelector('input').disabled, chip: c.querySelector('.live-state')?.textContent || '', title: c.querySelector('.live-state .chip')?.title || '',frame: f?.getAttribute('src') || '', cap: document.querySelector('#main .stage-cap')?.textContent || '', foot: document.querySelector('#main .stage-foot')?.textContent || '', footHidden: document.querySelector('#main .stage-foot')?.hidden ?? null, selectTitle: [...document.querySelectorAll('#main .stage-head button')].find((b) => b.textContent.trim() === 'Select')?.title || '', select: [...document.querySelectorAll('#main .stage-head button')].find((b) => b.textContent.trim() === 'Select')?.disabled ?? null } : null; })()`);
  const fits = () => js(`(() => { const head = document.querySelector('#main .stage-head').getBoundingClientRect(); const items = [...document.querySelectorAll('#main .stage-head > *')].filter((n) => !n.hidden && n.getBoundingClientRect().width > 0 && !n.classList.contains('spacer')).map((n) => { const r = n.getBoundingClientRect(); return { t: (n.textContent || '').trim().slice(0, 14), l: Math.round(r.left), r: Math.round(r.right) }; }); const overlap = items.some((a, i) => i > 0 && a.l < items[i - 1].r - 1); return { ok: !overlap && items.every((x) => x.r <= Math.round(head.right) + 1), headRight: Math.round(head.right), items }; })()`);
  const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await ctl(); if (fn(v)) return v; if (Date.now() > end) return v; await sleep(150); } };
  const childUrls = () => win.webContents.mainFrame.framesInSubtree.map((f) => f.url).filter((u) => u && u !== 'about:blank');

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);

  // 1. Off.
  let c = await waitFor((v) => v && !v.hidden && v.chip === 'Off');
  check('the Live switch shows beside the preview controls, off', c && !c.hidden && !c.checked && c.chip === 'Off', c);
  check('the frame shows the files on disk', /^\/preview\//.test(c?.frame || ''), c?.frame);
  await shot('1-off');

  // 2. Consent: the exact argv and folder, before anything runs.
  await js(`document.querySelector('#main .live-ctl input').click()`);
  await sleep(600);
  const consent = await js(`(() => { const d = document.querySelector('dialog[open]'); return d ? { title: d.querySelector('h2')?.textContent, cmds: [...d.querySelectorAll('.live-cmd')].map((p) => p.textContent), text: d.textContent } : null; })()`);
  check('the consent dialog names the exact command and folder', consent && consent.cmds[0] === 'node fake-live.mjs --atelier' && consent.cmds[1].endsWith(path.basename(created.entry?.path || created.project?.path || 'verify-live')) , consent);
  const before = await api('GET', `/api/projects/${pid}/live`);
  check('nothing runs while the dialog asks', before.state === 'off' && !before.consent.allowed, { state: before.state, consent: before.consent });
  await shot('2-consent');

  // 3. Allow and start: running, the live page in the frame.
  await js(`[...document.querySelectorAll('dialog[open] .dialog-actions button')].find((b) => b.textContent.trim() === 'Allow and start').click()`);
  c = await waitFor((v) => v && v.chip === 'Running');
  check('Running, with its address in the line above the preview', c?.chip === 'Running' && /127\.0\.0\.1:\d+$/.test(c.cap), c);
  check('the frame opens /live/<id>, which lands on the live server', /^\/live\//.test(c?.frame || ''), c?.frame);
  await sleep(1200);
  const urls = childUrls();
  check('the frame\'s document is the FAKE server on loopback', urls.some((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u) && !u.startsWith(BASE)), urls.map(mask));
  check('the cap names Live and its label', /Live · Live mode: fake editor \+ terminal/.test(c?.cap || ''), { cap: c?.cap });
  check('no line under the preview while Live shows: the note is gone', c?.footHidden === true && !/still read the files on disk/.test(c?.foot || ''), { footHidden: c?.footHidden, foot: c?.foot });
  check('Select is off while Live shows, its tooltip one sentence about the files on disk', c?.select === true && /^Select reads the files on disk, not the live server: switch Live off to use it\.$/.test(c?.selectTitle || ''), { select: c?.select, title: c?.selectTitle });
  const fitRunning = await fits();
  check('every toolbar control fits the stage head without overlap while running at 1280 px', fitRunning.ok, fitRunning);
  // The runs strip: hidden by default, so the preview has its height; More · Show runs under the preview brings it back.
  const runsState = () => js(`(() => { const wn = document.querySelector('#main .working-now'); const item = document.querySelector('#main .wb-actions [role="menuitemcheckbox"]'); return { wnHidden: wn?.hidden ?? null, wnHeight: wn ? Math.round(wn.getBoundingClientRect().height) : null, preview: Math.round(document.querySelector('#main .preview-wrap').getBoundingClientRect().height), item: item?.textContent.trim() || null, checked: item?.getAttribute('aria-checked') || null, studio: window.atelier.state.settings?.ui?.layout?.runsShown ?? null, eff: window.atelier.layout().runsShown }; })()`);
  const pressRuns = async () => {
    await js(`document.querySelector('#main .wb-actions > summary').click()`);
    await sleep(300);
    if (!focusAfter.length) await shot('3a-more-menu'); // the toggle by eye, before the first press
    await js(`document.querySelector('#main .wb-actions [role="menuitemcheckbox"]').click()`);
    await sleep(1200);
    focusAfter.push(await js(`document.activeElement?.closest('details')?.className || document.activeElement?.tagName || null`));
  };
  const focusAfter = [];
  const hiddenRuns = await runsState();
  check('the runs strip is hidden by default and the More menu offers Show runs under the preview, unticked', hiddenRuns.wnHidden === true && hiddenRuns.wnHeight === 0 && hiddenRuns.item === 'Show runs under the preview' && hiddenRuns.checked === 'false', hiddenRuns);
  await shot('3-running');
  await pressRuns();
  const shownRuns = await runsState();
  check('the toggle shows the strip, the preview gives up that height, the item is ticked and the studio setting holds true', shownRuns.wnHidden === false && shownRuns.wnHeight > 40 && shownRuns.preview < hiddenRuns.preview && shownRuns.checked === 'true' && shownRuns.studio === true, { hidden: hiddenRuns, shown: shownRuns });
  await shot('3b-running-runs-shown');
  await win.loadURL(`${BASE}/#/workbench`);
  await waitFor((v) => v && v.chip === 'Running');
  await sleep(1500);
  const keptRuns = await runsState();
  check('the choice is remembered after a reload', keptRuns.wnHidden === false && keptRuns.checked === 'true' && keptRuns.eff?.scope === 'studio', keptRuns);
  await pressRuns();
  const offRuns = await runsState();
  check('after a press the focus is back on More, not on the Live Log', focusAfter.length === 2 && focusAfter.every((c) => /wb-actions/.test(c || '')), focusAfter);
  const logOpen = await js(`document.querySelector('#main .live-log')?.open ?? null`);
  check('the Live Log stays closed through the presses', logOpen === false, logOpen);
  check('a second press hides it again and gives the height back', offRuns.wnHidden === true && offRuns.checked === 'false' && offRuns.studio === false && offRuns.preview === hiddenRuns.preview, offRuns);

  // 4. The masked log.
  await js(`document.querySelector('#main .live-log > summary').click()`);
  await sleep(800);
  const log = await js(`document.querySelector('#main .live-log-lines')?.textContent || ''`);
  check('the log shows the token masked, also where it was printed before the ready line', /token •••/.test(log) && /#•••/.test(log) && !/k=[0-9a-f]{24}/.test(log), log.split('\n').slice(0, 10));
  await shot('4-log');
  await js(`document.querySelector('#main .live-log > summary').click()`);

  // 5. Off: the files on disk again, and the tree gone.
  const running = await api('GET', `/api/projects/${pid}/live`);
  await js(`document.querySelector('#main .live-ctl input').click()`);
  c = await waitFor((v) => v && v.chip === 'Off');
  check('off returns the frame to the files on disk', c?.chip === 'Off' && /^\/preview\//.test(c.frame), c);
  const after = await api('GET', `/api/projects/${pid}/live`);
  check('the process is gone after off', after.state === 'off' && after.pid === null && running.pid > 0, { before: running.pid, after: after.state });
  await shot('5-off-again');

  // 6. A changed command asks again, then fails with its reason.
  await setLive({ label: 'Live mode: fake editor + terminal', command: ['node', 'fake-live.mjs', '--mode=exit'], cwd: '.' });
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await js(`document.querySelector('#main .live-ctl input').click()`);
  await sleep(600);
  const again = await js(`document.querySelector('dialog[open]')?.textContent || ''`);
  check('a changed command asks again and says so', /The command changed since you allowed it/.test(again) && /--mode=exit/.test(again), again.slice(0, 300));
  await js(`[...document.querySelectorAll('dialog[open] .dialog-actions button')].find((b) => b.textContent.trim() === 'Allow and start').click()`);
  c = await waitFor((v) => v && v.chip === 'Failed');
  check('Failed, and the line under the preview says why', c?.chip === 'Failed' && /^Live failed: it exited before it was ready \(code 3\)\. The preview shows the files on disk\./.test(c.foot), c);
  check('the frame stays on the files on disk', /^\/preview\//.test(c?.frame || ''), c?.frame);
  const openDialogs = await js(`document.querySelectorAll('dialog[open]').length`);
  check('the consent dialog closed after Allow and start', openDialogs === 0, openDialogs);
  await shot('6-failed');

  // 7. An entry outside the contract.
  await setLive({ label: 'Escapes', command: ['node', 'x.mjs'], cwd: '..' });
  await win.loadURL(`${BASE}/#/workbench`);
  c = await waitFor((v) => v && v.chip === 'Invalid', 8000);
  check('an invalid entry reads Invalid, the switch is disabled and the line under the preview says why', c?.chip === 'Invalid' && /^Live is not valid: live\.cwd leaves the project folder/.test(c.foot) && c.disabled, c);
  const fitInvalid = await fits();
  check('every toolbar control fits the stage head without overlap with Invalid at 1280 px', fitInvalid.ok, fitInvalid);
  await shot('7-invalid');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
