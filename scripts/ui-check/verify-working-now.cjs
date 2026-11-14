// By-eye check of the timeline (client/components/working-now.js, ARCHITECTURE.md section 16; the reference's run
// timeline) on a temp web-app project from templates/web-app-notes: the section says "no run · nothing running" while
// nothing runs; a terminal opened through POST /api/terminal makes "current run · 1 working" with one numbered row, the
// shell's name with its dot, a bar reaching now, Working over "open …" as the latest action, and the rail's live dot on
// the project; closing the shell keeps the row as Stopped · closed under "nothing working, 1 ended this hour", and the
// app bar's chip reads "<project>: <shell> Stopped"; a click on the chip clears it. The version marks do not move.
// Sessions and devices cannot run here (no claude login, no adb): the registry's tests cover them. The strip is hidden
// by default (decision row 149), so this studio's settings show it first (runsShown, as More · Show runs does).
// A private studio (temp data, own port and pid file), the real client.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-working-now.cjs  (writes .local/verify-working-now/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-working-now');
const PORT = 4913;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-working-now-'));
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

let server = null;
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  try { for (const t of await api('GET', '/api/terminal')) await api('DELETE', `/api/terminal/${t.id}`); } catch { /* server gone */ }
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
  const created = await api('POST', '/api/projects', { name: 'Verify Working', kind: 'web-app', template: 'web-app-notes' });
  const pid = created.project?.id || created.id;
  await api('POST', `/api/projects/${pid}/activate`);
  await api('PATCH', '/api/settings', { ui: { layout: { runsShown: true } } });

  const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  const marksTop = () => js(`Math.round(document.querySelector('#main .vstrip-marks')?.getBoundingClientRect().top ?? -1)`);
  const railDot = () => js(`(() => { const d = document.querySelector('#rail [data-pid="${pid}"] .rail-dot'); return d ? d.title : null; })()`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3000);
  const idle = await js(`(() => { const n = document.querySelector('#main .working-now'); return { hidden: n?.hidden ?? null, empty: n?.classList.contains('empty'), title: n?.querySelector('.wn-title')?.textContent, count: n?.querySelector('.wn-count')?.textContent, rows: n?.querySelectorAll('.wn-row').length, runs: window.atelier.state.runs.length }; })()`);
  check('nothing runs: the section stays and says so', idle.hidden === false && idle.empty && idle.title === 'Verify Working / no run' && idle.count === 'nothing running' && idle.rows === 0, idle);
  check('nothing runs: no live dot on the rail', (await railDot()) === null);
  const top0 = await marksTop();
  await shot('1-idle');

  // A terminal opened through the route, as the brief says: the row comes from runs.changed, nothing polls.
  const t = await api('POST', '/api/terminal', { projectId: pid, cols: 80, rows: 24 });
  check('POST /api/terminal opened a shell', !!t.id && !t.error, t);
  const shell = String(t.shell || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  await sleep(1200);
  const row = await js(`(() => { const n = document.querySelector('#main .working-now'); return { hidden: n.hidden, empty: n.classList.contains('empty'), title: n.querySelector('.wn-title')?.textContent, count: n.querySelector('.wn-count')?.textContent, num: n.querySelector('.wn-row .wn-num')?.textContent, name: n.querySelector('.wn-row .wn-name')?.textContent, dots: n.querySelectorAll('.wn-row .wn-dot').length }; })()`);
  check('current run · 1 working, one numbered row with the shell\'s name and its dot', !row.hidden && !row.empty && row.title === 'Verify Working / current run' && row.count === '1 working' && row.num === '01' && row.name === shell && row.dots === 1, { row, shell });
  const dot = await railDot();
  check('the rail shows the live dot on the project, titled with the run', dot === `Working now: ${shell}`, dot);
  const dotColour = await js(`(() => { const d = document.querySelector('#rail .rail-dot'); const live = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim(); return { dot: d && getComputedStyle(d).backgroundColor, live }; })()`);
  check('the rail dot is the live colour', !!dotColour.dot, dotColour);
  await shot('2-working');

  const open = await js(`(() => {
    const r = document.querySelector('#main .wn-row'); const bar = r?.querySelector('.wn-bar'); const track = r?.querySelector('.wn-track');
    return { rows: document.querySelectorAll('#main .wn-row').length, name: r?.querySelector('.wn-name')?.textContent, state: r?.querySelector('.wn-state')?.textContent,
      latest: r?.querySelector('.wn-act')?.textContent, live: !!bar?.classList.contains('live'), barRight: bar && track ? Math.round(track.getBoundingClientRect().right - bar.getBoundingClientRect().right) : null,
      ticks: [...document.querySelectorAll('#main .wn-tick')].map((x) => x.textContent), foot: document.querySelector('#main .wn-foot')?.textContent };
  })()`);
  check('the row reads Working over open … as the latest action; the foot says who works', open.rows === 1 && open.name === shell && open.state === 'Working' && /^open under a minute · just now$/.test(open.latest) && open.foot === `${shell} is working; the bars cover the last hour.`, open);
  check('its bar reaches now (the right end of the track) as the live bar', open.live && open.barRight !== null && open.barRight <= 1, open);
  check('the hour axis is the only clock', JSON.stringify(open.ticks) === JSON.stringify(['60 min ago', '45 min ago', '30 min ago', '15 min ago', 'now']), open.ticks);
  check('the version marks did not move', (await marksTop()) === top0 || top0 === -1, { before: top0, after: await marksTop() });
  await shot('3-working-axis');

  // Closing the shell ends the row and the chip names it.
  await api('DELETE', `/api/terminal/${t.id}`);
  await sleep(1200);
  const ended = await js(`(() => { const n = document.querySelector('#main .working-now'); const r = n.querySelector('.wn-row'); return { state: r?.querySelector('.wn-state')?.textContent, live: !!r?.querySelector('.wn-dot'), bar: r?.querySelector('.wn-bar')?.classList.contains('live'), title: n.querySelector('.wn-title')?.textContent, count: n.querySelector('.wn-count')?.textContent, foot: n.querySelector('.wn-foot')?.textContent, chip: document.querySelector('#global-status .chip')?.textContent || null }; })()`);
  check('the row stays, now Stopped · closed with no dot; the head reads no run · nothing working, 1 ended this hour', ended.state === 'Stopped · closed' && !ended.live && !ended.bar && ended.title === 'Verify Working / no run' && ended.count === 'nothing working, 1 ended this hour' && ended.foot === 'Nothing works now; what ended in the last hour stays listed.', ended);
  check(`the chip reads "Verify Working: ${shell} Stopped"`, ended.chip === `Verify Working: ${shell} Stopped`, ended.chip);
  check('the rail dot is gone', (await railDot()) === null);
  await shot('4-stopped-chip');

  // The section never goes: the stage keeps its place.
  check('the section stays on screen with the ended row listed', await js(`!document.querySelector('#main .working-now').hidden && document.querySelectorAll('#main .wn-row').length === 1`));
  await js(`document.querySelector('#global-status button').click()`);
  await sleep(800);
  const after = await js(`({ chip: document.querySelector('#global-status .chip')?.textContent || null, hash: location.hash })`);
  check('a click on the chip clears it and stays on the Workbench', after.chip !== `Verify Working: ${shell} Stopped` && after.hash === '#/workbench', after);
  await shot('5-after-click');
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
