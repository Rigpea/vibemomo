// NOT YET RUN: the session that wrote it was refused electron.exe. Run with
// node_modules/electron/dist/electron.exe scripts/ui-check/verify-sound-sketch.cjs
// Check for t_fycghhbc79: a private server (temp data, own port) and the real client in an offscreen
// Electron window at laptop width. A project made from the audio template opens with the Tuning and Audio
// panels, and the preview answers atelier:cue, atelier:tuning and atelier:render itself.
// Never touches the studio on 4747 or ~/.atelier.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sound must start locked, the way a browser starts it; the driver presses the page later.
app.commandLine.appendSwitch('autoplay-policy', 'document-user-activation-required');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'ui-check', 'verify-sound-sketch');
const PORT = 4896;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-'));
fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: path.join(tmp, 'projects'), ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => results.push({ name, ok: !!ok, seen });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

let server = null;
let done = false;
async function finish(code) {
  if (done) return;
  done = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  server?.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 90000);

// A complete WAV as a file reader would see it: walks the chunks, reads the samples.
function readWav(b64) {
  const b = Buffer.from(b64, 'base64');
  const out = { bytes: b.length, riff: b.toString('latin1', 0, 4), wave: b.toString('latin1', 8, 12), riffSizeOk: b.readUInt32LE(4) === b.length - 8 };
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') Object.assign(out, { format: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), sampleRate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) });
    if (id === 'data') {
      out.frames = size / 2;
      out.dataSizeOk = at + 8 + size === b.length;
      let peak = 0;
      let sounding = 0; // last frame above -60 dB, so the 50 ms tail can be seen
      for (let i = 0; i < out.frames; i++) {
        const s = Math.abs(b.readInt16LE(at + 8 + i * 2)) / 32768;
        if (s > peak) peak = s;
        if (s > 0.001) sounding = i;
      }
      out.peak = peak;
      out.soundingMs = Math.round((sounding / 44100) * 1000);
    }
    at += 8 + size;
  }
  return out;
}

async function main() {
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const state = (await api('GET', '/api/state')).data;
  const offered = (state.templates || []).find((t) => t.name === 'audio-sound-sketch');
  check('the New project form is offered the template as kind audio', offered?.kind === 'audio', offered);
  const created = await api('POST', '/api/projects', { name: 'Chime Box', kind: 'audio', template: 'audio-sound-sketch' });
  check('a project is created from the template', created.status < 300, created.status);
  const id = created.data.project?.id || created.data.entry?.id;
  await api('POST', `/api/projects/${id}/activate`).catch(() => {});

  const win = new BrowserWindow({ width: 1366, height: 768, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  await js(`window.__msgs = []; addEventListener('message', (e) => { if (e.data && e.data.type) window.__msgs.push(e.data); });`);

  const tabs = await js(`[...document.querySelectorAll('.dock-tabs [role=tab], .dock-tabs button')].map((b) => b.textContent.trim())`);
  check('the dock shows the Tuning and Audio panels', tabs.includes('Tuning') && tabs.includes('Audio'), tabs);

  const FRAME = `[...document.querySelectorAll('iframe')].find((f) => { try { return f.contentDocument && f.contentDocument.querySelector('[data-cue]'); } catch { return false; } })`;
  const frameTitle = await js(`(${FRAME})?.contentDocument.title ?? null`);
  check('the preview is titled with the project name', frameTitle === 'Chime Box', frameTitle);
  const key = await js(`(${FRAME})?.contentDocument.documentElement.dataset.storageKey ?? null`);
  check('the preview has the project storage key', key === 'chime-box', key);

  // Ask the preview and wait for the matching atelier:event.
  const ask = (msg, name, match = '') => js(`new Promise((resolve) => {
    const f = ${FRAME};
    const seen = window.__msgs.length;
    const started = Date.now();
    const look = () => {
      const hit = window.__msgs.slice(seen).find((m) => m.type === 'atelier:event' && m.name === ${JSON.stringify(name)} ${match});
      if (hit) return resolve(hit.data);
      if (Date.now() - started > 3000) return resolve({ timedOut: true });
      setTimeout(look, 20);
    };
    f.contentWindow.postMessage(${JSON.stringify(msg)}, location.origin);
    look();
  })`);

  // Nothing has been pressed yet, so the preview's first AudioContext has no gesture behind it.
  const CUES = ['tap', 'blip', 'tick', 'swell'];
  const locked = await ask({ type: 'atelier:cue', id: 'tap' }, 'cue');
  check('with no gesture a cue answers played:false, suspended', locked.played === false && locked.reason === 'suspended: click in the page first', locked);
  const unknown = await ask({ type: 'atelier:cue', id: 'nope' }, 'cue');
  check('an unknown cue answers played:false with a reason', unknown.played === false && unknown.reason === 'unknown cue', unknown);

  // Renders need no gesture, so they run while sound is still locked.
  const renders = {};
  for (const c of CUES) {
    const r = await ask({ type: 'atelier:render', id: c }, 'render');
    const wav = r.wav ? readWav(r.wav) : null;
    renders[c] = { seconds: r.seconds, peak: r.peak, sampleRate: r.sampleRate, ...wav };
    const whole = wav && wav.riff === 'RIFF' && wav.wave === 'WAVE' && wav.riffSizeOk && wav.dataSizeOk && wav.format === 1 && wav.channels === 1 && wav.bits === 16 && wav.sampleRate === 44100;
    check(`render ${c}: a complete WAV, under 450 ms, with sound in it and a modest peak`, whole && r.sampleRate === 44100 && r.seconds > 0.05 && r.seconds < 0.45 && r.peak > 0.01 && r.peak < 0.6 && Math.abs(wav.frames / 44100 - r.seconds) < 1e-6 && Math.abs(wav.peak - r.peak) < 0.001, renders[c]);
    fs.writeFileSync(path.join(OUT, `${c}.wav`), Buffer.from(r.wav || '', 'base64'));
  }
  const again = await ask({ type: 'atelier:render', id: 'tick' }, 'render');
  check('the same tuning renders the same bytes', renders.tick.bytes === Buffer.from(again.wav || '', 'base64').length && fs.readFileSync(path.join(OUT, 'tick.wav')).equals(Buffer.from(again.wav || '', 'base64')), null);
  const lengths = new Set(CUES.map((c) => renders[c].frames));
  check('the cues differ in length (a rough check; only an ear can say they are distinct)', lengths.size >= 3, CUES.map((c) => renders[c].frames));
  const badRender = await ask({ type: 'atelier:render', id: 'nope' }, 'render');
  check('an unknown render answers with a reason and no file', !badRender.wav && badRender.reason === 'unknown cue', badRender);

  const tuned = await ask({ type: 'atelier:tuning', tuning: { tapVolume: 0.1, tapDecayMs: 60, nope: 1, blipVolume: 5, swellPitch: 'high' } }, 'tuning');
  check('tuning answers applied and ignored', tuned.applied?.join() === 'tapVolume,tapDecayMs' && tuned.ignored?.join() === 'nope,blipVolume,swellPitch', tuned);
  const after = await ask({ type: 'atelier:render', id: 'tap' }, 'render');
  check('a tuned value changes the render', after.peak < renders.tap.peak && after.seconds > renders.tap.seconds, { before: [renders.tap.peak, renders.tap.seconds], after: [after.peak, after.seconds] });

  // A real press inside the frame unlocks sound. sendInputEvent is a trusted gesture.
  const box = await js(`(() => { const f = ${FRAME}; const a = f.getBoundingClientRect(); const b = f.contentDocument.querySelector('[data-cue="blip"]').getBoundingClientRect(); return { x: Math.round(a.x + b.x + b.width / 2), y: Math.round(a.y + b.y + b.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(500);
  const hand = await js(`window.__msgs.filter((m) => m.type === 'atelier:event' && m.name === 'blip').length`);
  check('a press on a cue button plays it and reports it fired', hand === 1, hand);
  for (const c of CUES) {
    const r = await ask({ type: 'atelier:cue', id: c }, 'cue');
    check(`after a press, cue ${c} answers played:true with its seconds and peak`, r.played === true && r.id === c && !r.reason && typeof r.seconds === 'number' && typeof r.peak === 'number', r);
  }

  // Mute: key M inside the page, kept under the project's own key, cues refuse.
  await js(`(${FRAME}).contentWindow.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm' }))`);
  const stored = await js(`({ own: localStorage.getItem('atelier.chime-box.muted'), template: localStorage.getItem('atelier.sound-sketch.muted'), pressed: (${FRAME}).contentDocument.getElementById('btn-mute').getAttribute('aria-pressed') })`);
  check('M mutes, kept under the project key', stored.own === '1' && stored.template === null && stored.pressed === 'true', stored);
  const silent = await ask({ type: 'atelier:cue', id: 'tap' }, 'cue');
  check('a muted cue answers played:false, muted', silent.played === false && silent.reason === 'muted', silent);
  const mutedRender = await ask({ type: 'atelier:render', id: 'tap' }, 'render');
  check('a render ignores mute', mutedRender.peak > 0, mutedRender.peak);
  await js(`(${FRAME}).contentWindow.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm' }))`);

  // The studio's own panels, not messages sent by this driver.
  await js(`[...document.querySelectorAll('.dock-tabs [role=tab], .dock-tabs button')].find((b) => b.textContent.trim() === 'Audio')?.click()`);
  await sleep(300);
  await js(`document.querySelector('button[data-cue="swell"]')?.click()`);
  await sleep(600);
  const row = await js(`[...document.querySelectorAll('.cue-list li')].map((l) => l.textContent)`);
  check('the Audio panel lists four cues and shows swell played with its length and level', row.length === 4 && /played · \d+\.\d\d s · (-?\d+ dB|silent)/.test(row[3] || '') && !/not played/.test(row[3] || ''), row);
  const words = await js(`[document.querySelector('.panel-bar')?.textContent ?? '', ...[...document.querySelectorAll('.cue-list li, .cue-list li [title]')].map((n) => n.title || '')].join(' ')`);
  check('the Audio panel says product, not game, on this project', /Events come from the product/.test(words) && !/\bgames?\b/i.test(words), words);
  fs.writeFileSync(path.join(OUT, 'audio-panel.png'), (await win.webContents.capturePage()).toPNG());

  await js(`[...document.querySelectorAll('.dock-tabs [role=tab], .dock-tabs button')].find((b) => b.textContent.trim() === 'Tuning')?.click()`);
  await sleep(500);
  const fields = await js(`[...document.querySelectorAll('.tuning-form label')].map((l) => l.textContent)`);
  check('the Tuning panel lists master plus three values per cue', fields.length === 13 && fields[0] === 'masterVolume', fields);
  await js(`[...document.querySelectorAll('.tuning-bar button')].find((b) => b.textContent.trim() === 'Apply live')?.click()`);
  await sleep(500);
  const bar = await js(`document.querySelector('.tuning-bar')?.textContent ?? ''`);
  check('Apply live shows the product acknowledgement', /applied/.test(bar) && !/ignored/.test(bar), bar);
  fs.writeFileSync(path.join(OUT, 'tuning-panel.png'), (await win.webContents.capturePage()).toPNG());

  const relevant = errors.filter((e) => !/favicon/.test(e));
  check('no console errors', relevant.length === 0, relevant);
  await finish(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err?.stack || err) }); finish(2); });
