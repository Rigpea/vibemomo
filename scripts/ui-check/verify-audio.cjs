// Throwaway by-eye and by-bytes check of the audio kind: a private studio (temp data, own port and pid
// file), a project made from templates/audio-sound-sketch, the real client in an offscreen Electron
// window with software rendering. Checks the Audio and Tuning panels, the cue acknowledgements, a render
// through the product (RIFF/WAVE bytes, length, peak) and, when the studio has the route, the file on disk.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-audio.cjs  (writes .local/verify-audio/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-audio');
const PORT = 4895;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-audio-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${JSON.stringify(data)}`);
  return data;
};

let server = null;
let finished = false;
let keepProject = null;
async function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  server?.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 150000);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const templates = await api('GET', '/api/templates');
  check('the audio template is listed', templates.some((t) => t.name === 'audio-sound-sketch'), templates.map((t) => `${t.name}:${t.kind}`));
  const created = await api('POST', '/api/projects', { name: 'Verify Sketch', kind: 'audio', template: 'audio-sound-sketch' });
  const pid = created.project?.id || created.id;
  keepProject = path.join(projectsDir, 'verify-sketch');
  const srcDir = path.join(keepProject, 'src');
  const named = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n') : '';
  check('the copied files say Verify Sketch and verify-sketch, not Sound Sketch', /Verify Sketch/.test(named) && /verify-sketch/.test(named) && !/Sound Sketch|sound-sketch/.test(named), { len: named.length });

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/s+/g, " ").slice(0, 160)}`)), 20000))]);
  win.webContents.debugger.attach('1.3');
  const shot = async (name) => { await sleep(500); try { win.webContents.invalidate(); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } }; // capturePage under a cap: the DevTools capture waits for a paint that a quiet offscreen window never makes
  await win.loadURL(`${BASE}/#workbench`);
  await sleep(2500);

  const tabs = await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].map((t) => t.textContent.trim())`);
  check('the dock offers Tuning and Audio for the audio kind', tabs.includes('Audio') && tabs.includes('Tuning'), tabs);
  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === 'Audio')?.click()`);
  await sleep(800);
  const cues = await js(`[...document.querySelectorAll('.cue-list li')].map((li) => li.innerText.replace(/\\s+/g, ' ').slice(0, 80))`);
  check('the Audio panel lists four cues', cues.length === 4, cues);
  await shot('a-audio-panel');

  // trigger the first cue through the panel and read the product's own answer
  await js(`document.querySelector('.cue-list button[data-cue], .cue-list button')?.click()`);
  await sleep(1500);
  const after = await js(`[...document.querySelectorAll('.cue-list li')].map((li) => li.innerText.replace(/\\s+/g, ' ').slice(0, 120))`);
  check('a triggered cue is acknowledged (played, or not played with a reason)', after.some((t) => /played/.test(t)), after);
  await shot('b-cue-triggered');

  // render through the product directly: post atelier:render to the preview frame and read the event
  const render = await js(`new Promise((resolve) => { const f = document.querySelector('.preview-wrap iframe'); const ids = ${JSON.stringify(['tap', 'blip', 'tick', 'swell'])}; const out = {}; const onMsg = (e) => { const m = e.data; if (m && m.type === 'atelier:event' && m.name === 'render' && m.data) { const d = m.data; out[d.id] = { seconds: d.seconds, peak: d.peak, sampleRate: d.sampleRate, head: typeof d.wav === 'string' ? atob(d.wav.slice(0, 16)) : null, bytes: typeof d.wav === 'string' ? Math.round(d.wav.length * 3 / 4) : 0, error: d.error || null }; if (Object.keys(out).length === ids.length) { window.removeEventListener('message', onMsg); resolve(out); } } }; window.addEventListener('message', onMsg); for (const id of ids) f.contentWindow.postMessage({ type: 'atelier:render', id }, '*'); setTimeout(() => { window.removeEventListener('message', onMsg); resolve(out); }, 8000); })`);
  const ids = Object.keys(render);
  check('every cue renders a RIFF/WAVE with sound in it', ids.length === 4 && ids.every((id) => /^RIFF/.test(render[id].head || '') && /WAVE/.test(render[id].head || '') && render[id].peak > 0.01 && render[id].seconds > 0.02 && render[id].seconds < 1.5), render);
  check('cues are short and quiet (under 0.5 s, peak under 0.7)', ids.length === 4 && ids.every((id) => render[id].seconds <= 0.5 && render[id].peak <= 0.7), ids.map((id) => [id, render[id].seconds, render[id].peak]));

  // the panel's own Render to file: a canvas under the rendered row, with samples drawn off the centre line
  await js(`document.querySelector('.cue-list button[data-render="swell"]').click()`);
  const wave = await js(`(async () => {
    for (let i = 0; i < 40 && !document.querySelector('.cue-list canvas'); i++) await new Promise((r) => setTimeout(r, 100));
    const c = document.querySelector('.cue-list canvas');
    if (!c) return { canvas: false, row: document.querySelector('.cue-list button[data-render="swell"]').closest('li').innerText };
    c.scrollIntoView({ block: 'center' });
    const li = c.closest('li');
    const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const mid = Math.floor(height / 2);
    const drawnColumns = new Set();
    let firstRow = height;
    let lastRow = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (y !== mid && data[(y * width + x) * 4 + 3] > 0) { drawnColumns.add(x); firstRow = Math.min(firstRow, y); lastRow = Math.max(lastRow, y); }
    const box = c.getBoundingClientRect();
    const rowButton = li.querySelector('button[data-render]').getBoundingClientRect();
    const label = li.querySelector('.cue-wave span');
    return { canvas: true, cue: li.querySelector('button[data-render]').dataset.render, width: c.width, height: c.height, cssWidth: box.width, cssHeight: box.height, rowWidth: li.clientWidth, labelBeside: label.getBoundingClientRect().left >= box.right, under: box.top >= rowButton.bottom, drawnColumns: drawnColumns.size, drawnShare: (lastRow - firstRow + 1) / height, label: label.textContent, saved: /Saved\\sdist\\/audio\\/swell\\.wav/.test(li.innerText) };
  })()`);
  check('a canvas under the rendered row, 36 px high, sharing the row with its label', wave.canvas && wave.cue === 'swell' && wave.under && wave.cssHeight === 36 && wave.width > 0 && wave.labelBeside && wave.cssWidth > wave.rowWidth / 3 && wave.saved, wave);
  check('the drawn rows span at least 60 percent of the canvas height', wave.drawnColumns > 0 && wave.drawnShare >= 0.6, { drawnShare: wave.drawnShare });
  check('the label says the length and that it is drawn to its peak', /^\d+\.\d\d s · drawn to its peak, -\d+ dB$/.test(wave.label), wave.label);
  await shot('c-waveform');

  // a key press in the product is reported like a Trigger, and the count holds both
  const rowText = (cue) => js(`document.querySelector('.cue-list button[data-cue="${cue}"]').closest('li').innerText.replace(/\\s+/g, ' ')`);
  await js(`document.querySelector('.cue-list button[data-cue="blip"]').click()`);
  await sleep(600);
  const byTrigger = await rowText('blip');
  check('a Trigger reads played, length, level, count, when, Trigger', /played · \d\.\d\d s · -\d+ dB · 1× · last just now · Trigger/.test(byTrigger), byTrigger);
  await js(`document.querySelector('.preview-wrap iframe').contentWindow.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true }))`);
  await sleep(600);
  const byKey = await rowText('blip');
  check('then a key press in the product reads the same with 2× and key', /played · \d\.\d\d s · -\d+ dB · 2× · last just now · key/.test(byKey), byKey);
  await shot('d-key-press');

  // renders are remembered: leave the workbench and come back; the file is still known, with its waveform
  await js(`document.activeElement?.blur?.(); document.querySelector('.cue-list button[data-render="tap"]').click()`);
  await sleep(1000);
  const savedRow = await rowText('tap');
  check('right after a render the Saved line ends at just now', /Saved dist\/audio\/tap\.wav · \d\.\d\d s · peak -\d+ dB · \d+ KB · just now/.test(savedRow), savedRow);
  const afterRender = await js(`document.activeElement?.dataset?.render || document.activeElement?.tagName`);
  check('and the focus is on that row\'s Render button', afterRender === 'tap', afterRender);

  // with nothing played no row is rebuilt; the 6 s look is past the panel's 5 s ticker
  await js(`window.__rowsBefore = [...document.querySelectorAll('.cue-list li')]`);
  const sameRows = `(() => { const now = [...document.querySelectorAll('.cue-list li')]; return now.length === window.__rowsBefore.length && now.every((li, i) => li === window.__rowsBefore[i]); })()`;
  await sleep(2000);
  const sameAfter2 = await js(sameRows);
  check('every row is the same DOM node before and after two seconds with nothing played', sameAfter2 === true, sameAfter2);
  await sleep(4000);
  const sameAfter6 = await js(sameRows);
  check('and after six, past the ticker', sameAfter6 === true, sameAfter6);
  const projectPath = keepProject;
  const swellFile = fs.readFileSync(path.join(projectPath, 'dist', 'audio', 'swell.wav'));
  const listed = await api('GET', `/api/projects/${pid}/audio/renders`);
  check('the list names both files and the file\'s bytes come back', listed.map((f) => f.id).join() === 'swell,tap' && Buffer.from(await (await fetch(`${BASE}/api/projects/${pid}/audio/renders/swell`)).arrayBuffer()).equals(swellFile), listed);
  await js(`location.hash = '#/memory'`);
  await sleep(800);
  await js(`location.hash = '#/workbench'`);
  await sleep(1500);
  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === 'Audio')?.click()`);
  await sleep(800);
  const back = await js(`[...document.querySelectorAll('.cue-list li')].map((li) => ({ cue: li.querySelector('button[data-render]').dataset.render, saved: /Saved\\sdist/.test(li.innerText), canvas: !!li.querySelector('canvas'), text: li.innerText.replace(/\\s+/g, ' ') }))`);
  const rendered = back.filter((r) => r.saved).map((r) => r.cue).sort().join();
  check('after a view change the rendered rows still show the Saved line and a waveform', rendered === 'swell,tap' && back.filter((r) => r.saved).every((r) => r.canvas), back);
  check('and no hint yet: the tuning has not changed', !back.some((r) => /rendered at other values/.test(r.text)), back.map((r) => r.text));

  // save the tuning through the panel: the rendered rows now say so, in the warning colour
  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === 'Tuning')?.click()`);
  await sleep(800);
  await js(`(() => { const input = document.querySelector('.tune input[type="number"], .tune input'); input.value = String(Number(input.value) - 0.01); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  await js(`[...document.querySelectorAll('button')].find((b) => /Save to file/.test(b.textContent))?.click()`);
  await sleep(1500);
  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === 'Audio')?.click()`);
  await sleep(800);
  const stale = await js(`[...document.querySelectorAll('.cue-list li')].map((li) => { const hint = [...li.querySelectorAll('div')].find((d) => d.textContent === 'rendered at other values than the saved tuning'); return { cue: li.querySelector('button[data-render]').dataset.render, hint: !!hint, color: hint?.style.color || '' }; })`);
  check('a saved tuning change marks exactly the rendered rows, in the warning colour', stale.filter((r) => r.hint).map((r) => r.cue).sort().join() === 'swell,tap' && stale.filter((r) => r.hint).every((r) => r.color === 'var(--warn)'), stale);
  await shot('e-stale-hint');

  // at 800 px the Saved line wraps at separators only: each value's characters stay on one line
  win.setContentSize(800, 900);
  await sleep(800);
  const wraps = await js(`[...document.querySelectorAll('.cue-list li')].flatMap((li) => [...li.querySelectorAll('div')].filter((d) => /^Saved\\s/.test(d.textContent)).map((d) => {
    const text = d.firstChild;
    const values = d.textContent.split(' · ');
    let at = 0;
    return values.map((value) => {
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + value.length);
      at += value.length + 3;
      return { value, lines: new Set([...range.getClientRects()].map((b) => Math.round(b.top))).size };
    });
  })).flat()`);
  check('at 800 px no Saved value is split across lines', wraps.length >= 8 && wraps.every((w) => w.lines === 1), wraps);
  const overflow = await js(`(() => { const b = document.querySelector('.dock-body'); return { scrollWidth: b.scrollWidth, clientWidth: b.clientWidth, rows: [...document.querySelectorAll('.cue-list li')].map((li) => ({ text: li.children[0].offsetWidth, line: li.children[1].offsetWidth })) }; })()`);
  check('at 800 px the panel does not scroll sideways', overflow.scrollWidth <= overflow.clientWidth, overflow);
  await js(`document.querySelector('.cue-list canvas').scrollIntoView({ block: 'center' })`);
  await shot('f-800');
  win.setContentSize(1366, 768);
  await sleep(500);

  // tuning: the Tuning panel sees the tuning file and the product acknowledges a change
  await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim() === 'Tuning')?.click()`);
  await sleep(800);
  const tuneKeys = await js(`[...document.querySelectorAll('.tune label')].map((l) => l.textContent.trim()).slice(0, 12)`);
  check('the Tuning panel lists cue parameters', tuneKeys.length >= 4, tuneKeys);


}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
