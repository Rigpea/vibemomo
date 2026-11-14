// Audio workbench panel: the manifest's cues, a "Trigger" button per cue (posts
// {type:"atelier:cue", id}), and which cues fired recently according to the product's own
// atelier:event messages. A product confirms a triggered cue with atelier:event "cue"
// {id, played, reason?, seconds?, peak?}; "played" is shown only from that acknowledgement.
// A product also plays a cue by itself: atelier:event named after the cue, {seconds?, peak?, how?}.
// A row counts both kinds of play from the bus log, and its line describes the newest one.
// The studio cannot hear the product: a length and a level are shown only when the product reports both.
// The product is called a game for kind game, an app for web-app and a product otherwise (productWord).
// "Render to file" posts {type:"atelier:render", id} to the preview; the product answers with atelier:event
// "render" {id, wav, seconds, peak, sampleRate, tuning?} or {id, error|reason}, and the server writes dist/audio/<id>.wav
// with the tuning beside it. What is on disk comes from the server's list on mount and on every reload (st.disk), so it
// survives a view change; a row shows its file's line, a hint when its values differ from the tuning file's, and a waveform of its bytes.
// Side-by-side frames report too (bus.frameEvents): a Trigger reads "played in main, A, B", a press in a frame "fired in A · key".
// An audio project has no Play or Devices panel, so its readiness checklist lives here, below the cue rows.
// A row is rebuilt only when what it says changes (rowView, compared as text with the times left out), so a node
// stays the same one while nothing happens. The ticker and every bus event only refresh the times and the 10 s mark on the nodes that are there.
import { el, clear, button, stateChip, ago } from '/components/ui.js';
import { renderLine } from '/components/render-line.js';
import { peaksFromWav, wavInfo, wavPeak } from '/components/wave-peaks.js';
import { readinessChecklist } from '/components/readiness.js';

const RENDER_WAIT_MS = 3000;
// How far apart reports may be and still be one play in several frames. A product measures its peak before it
// answers, so the frames do not report in the same instant. A Trigger gets the time its acknowledgement gets.
const SAME_PRESS_MS = 300;
const SAME_TRIGGER_MS = 1000;
let st = null;

export function mount(container, ctx) {
  // The checklist sits outside the rows, or a row's redraw could take the focus off a checkbox.
  const head = el('div');
  const list = el('ul.cue-list');
  const foot = el('div');
  const checklist = ctx.manifest.kind === 'audio' ? readinessChecklist(ctx) : null;
  clear(container, el('div', head, list, foot), checklist ? el('div', { style: { marginTop: 'var(--s4)' } }, checklist.node) : null);
  st = { ctx, container, head, list, foot, headSig: null, footSig: null, rows: [], checklist, sent: {}, renders: {}, disk: {}, listTurn: 0, listError: '', offs: [], ticker: null, waves: [] };
  st.offs.push(ctx.bus.on('event', onEvent), ctx.bus.on('frame-event', render), ctx.bus.on('frame-reload', render), ctx.bus.on('reload', onReload), ctx.bus.on('ready', render));
  st.ticker = setInterval(render, 5000);
  // The dock can resize, or show a panel that was hidden with no width to draw in.
  st.resize = new ResizeObserver(() => st?.waves.forEach(paintWave));
  st.resize.observe(container);
  render();
  listRenders();
}

export function unmount() {
  if (!st) return;
  st.offs.forEach((off) => off());
  st.resize.disconnect();
  clearInterval(st.ticker);
  Object.values(st.sent).forEach((s) => clearTimeout(s.timer));
  Object.values(st.renders).forEach((r) => clearTimeout(r.timer));
  st = null;
}

// The bundle was refreshed: a tuning file saved, a version restored, a task finished. Any of them can change a file's standing.
export function update() {
  st?.checklist?.render();
  render();
  listRenders();
}

function productWord() {
  const { kind } = st.ctx.manifest;
  return kind === 'game' ? 'game' : kind === 'web-app' ? 'app' : 'product';
}

const decibels = (peak) => `${Math.round(20 * Math.log10(peak))} dB`;
const hasNumbers = ({ seconds, peak }) => Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(peak) && peak >= 0;

const levelText = (data) => `${data.seconds.toFixed(2)} s · ${data.peak > 0 ? decibels(data.peak) : 'silent'}`;

// "played", with the length and level only when the product reported both as real numbers.
function playedText(data) {
  return hasNumbers(data) ? `played · ${levelText(data)}` : 'played';
}

const isAck = (ev, id) => ev.name === 'cue' && ev.data?.id === id && ev.data.played === true;

// Every play of a cue since the preview loaded, oldest first: a Trigger the product confirmed, and its own plays
// under the cue's name. One play can sound in several frames, so reports close in time from different frames are
// one play, which keeps the first report's numbers. A second report from the same frame is always a new play.
function playsOf(id) {
  const { events, frameEvents } = st.ctx.bus;
  const plays = [];
  for (const ev of [...events, ...frameEvents].filter((x) => x.name === id || isAck(x, id)).sort((x, y) => x.at - y.at)) {
    const place = ev.frame || 'main';
    const ack = isAck(ev, id);
    const cur = plays[plays.length - 1];
    if (cur && cur.ack === ack && ev.at - cur.at < (ack ? SAME_TRIGGER_MS : SAME_PRESS_MS) && !cur.where.includes(place)) cur.where.push(place);
    else plays.push({ at: ev.at, data: ev.data, ack, where: [place] });
  }
  return plays;
}

// The frames to name, or '' when only the main preview is in question: no side frame reported and none was open for a Trigger.
function placesOf(id, play) {
  const s = st.sent[id];
  const named = play.where.some((p) => p !== 'main') || (play.ack && s?.framesOpen && play.at >= s.at);
  return named ? ['main', 'A', 'B'].filter((p) => play.where.includes(p)).join(', ') : '';
}

// The row's one line. A plain acknowledgement says "played" and nothing more, as it always has.
// A line that names frames is longer by those words, so it gives up the count and the time; the row's title keeps them.
function playsLine(id, plays, age = ago) {
  const last = plays[plays.length - 1];
  const { ack } = last;
  const numbers = hasNumbers(last.data);
  const places = placesOf(id, last);
  const level = numbers ? levelText(last.data) : null;
  const how = ack ? 'Trigger' : typeof last.data.how === 'string' ? last.data.how : '';
  if (places) return (ack ? [`played in ${places}`, level] : [`fired in ${places}`, how, level]).filter(Boolean).join(' · ');
  if (ack && !numbers) return 'played';
  const when = `last ${age(new Date(last.at).toISOString())}`;
  return [numbers ? playedText(last.data) : `fired ${plays.length}×`, numbers ? `${plays.length}×` : null, when, how].filter(Boolean).join(' · ');
}

function onEvent(ev) {
  if (ev.name === 'cue' && ev.data && typeof ev.data.id === 'string') {
    const s = st?.sent[ev.data.id];
    if (s && !s.ack) { // a late acknowledgement still counts: it is the product's own word
      s.ack = { played: ev.data.played === true, reason: ev.data.reason ? String(ev.data.reason) : '', seconds: ev.data.seconds, peak: ev.data.peak };
      clearTimeout(s.timer);
    }
  }
  if (ev.name === 'render') onRenderAnswer(ev.data);
  render();
}

// A reload ends any render in flight, so its silence says nothing about a handler.
function onReload() {
  for (const [id, r] of Object.entries(st.renders)) {
    if (r.phase === 'sent' || r.phase === 'no-handler') { clearTimeout(r.timer); delete st.renders[id]; }
  }
  render();
  listRenders();
}

// The server's list replaces what the panel knew. A file that has not changed keeps the waveform it has.
// Only the newest ask counts, and a save calls off any ask in flight: its answer may predate the file.
async function listRenders() {
  const mine = st;
  const turn = ++mine.listTurn;
  let list;
  try {
    list = await mine.ctx.api.audioRenders(mine.ctx.projectId);
  } catch (err) {
    if (st !== mine || turn !== mine.listTurn) return;
    mine.listError = err.message;
    return render();
  }
  if (st !== mine || turn !== mine.listTurn) return;
  const before = mine.disk;
  mine.listError = '';
  mine.disk = Object.fromEntries(list.map((file) => {
    const old = before[file.id];
    const same = old?.wave && old.mtime === file.mtime && old.bytes === file.bytes;
    return [file.id, same ? { ...file, wave: old.wave } : file];
  }));
  render();
  const cues = new Set((mine.ctx.manifest.cues || []).map((c) => c.id));
  list.filter((file) => cues.has(file.id) && !file.error && !mine.disk[file.id].wave).forEach((file) => fetchWave(mine, file.id));
}

async function fetchWave(mine, id) {
  const entry = mine.disk[id];
  let wave;
  try {
    wave = readWave(await mine.ctx.api.audioRenderBytes(mine.ctx.projectId, id));
  } catch (err) {
    wave = { error: err.message };
  }
  if (st !== mine || mine.disk[id] !== entry) return;
  entry.wave = wave;
  render();
}

function renderToFile(id) {
  if (st.renders[id]) clearTimeout(st.renders[id].timer);
  const r = { phase: 'sent', text: '' };
  r.timer = setTimeout(() => { r.phase = 'no-handler'; render(); }, RENDER_WAIT_MS);
  st.renders[id] = r;
  // The main preview only: its answers are the ones the bus hears, and a side-by-side frame must not render too.
  st.ctx.previewFrame.contentWindow?.postMessage({ type: 'atelier:render', id }, location.origin);
  render();
}

// Only an answer to a click writes a file, once. A late answer still counts, as for cues.
function onRenderAnswer(data) {
  const r = typeof data?.id === 'string' ? st?.renders[data.id] : null;
  if (!r || !(r.phase === 'sent' || r.phase === 'no-handler')) return;
  clearTimeout(r.timer);
  const failure = data.error || data.reason;
  if (failure || typeof data.wav !== 'string') {
    settle(r, 'failed', `not rendered: ${failure || 'the product sent no file'}`);
    return returnFocus(data.id);
  }
  r.phase = 'saving';
  const { id, wav, seconds, peak, sampleRate, tuning } = data;
  const wave = fromBase64(wav);
  const body = { id, wav, seconds, peak, sampleRate };
  if (tuning !== undefined) body.tuning = tuning;
  // The module holds one panel: after a project switch the answer belongs to a panel that is gone.
  const mine = st;
  mine.ctx.api.audioRender(mine.ctx.projectId, body).then(
    (saved) => {
      if (st !== mine) return;
      mine.listTurn++;
      delete mine.renders[id];
      mine.disk[id] = { id, ...saved, wave };
      render();
      returnFocus(id);
    },
    (err) => {
      if (st !== mine) return;
      settle(r, 'failed', `not rendered: ${err.message}`);
      returnFocus(id);
    });
}

// The person stays where they were: with no focus left anywhere it goes to the row's Render button. A focus they have
// since put somewhere else, another row's button, a field or the preview, stays there. A hidden panel's button takes no focus.
function returnFocus(id) {
  const { activeElement } = document;
  if (activeElement && activeElement !== document.body) return;
  st.rows.find((row) => row.id === id)?.renderButton.focus();
}

function fromBase64(wav) {
  try {
    return readWave(Uint8Array.from(atob(wav), (c) => c.charCodeAt(0)));
  } catch (err) {
    return { error: err.message };
  }
}

// serial tells two waves apart for a row's comparison: a file rendered again can have the same numbers.
let waveSerial = 0;
function readWave(bytes) {
  try {
    return { serial: ++waveSerial, bytes, seconds: wavInfo(bytes).seconds, peak: wavPeak(bytes), columns: 0, peaks: [] };
  } catch (err) {
    return { serial: ++waveSerial, error: err.message };
  }
}

function waveRow(row, wave) {
  if (wave.error) return el('div.small.muted.cue-wave-note', `no waveform: ${wave.error}`);
  const label = `${wave.seconds.toFixed(2)} s · ${wave.peak > 0 ? `drawn to its peak, ${decibels(wave.peak)}` : 'silent'}`;
  const canvas = el('canvas', { role: 'img', 'aria-label': `Waveform of the rendered file, ${label}` });
  row.wave = { canvas, wave, painted: '' };
  return el('div.cue-wave', el('div', canvas), el('span.small.muted', label));
}

// A text node whose words hold a relative time: the row keeps it, and refreshing it touches nothing else.
function liveText(row, words) {
  const node = document.createTextNode(words());
  row.live.push({ node, words });
  return node;
}

// What the row says about its file: the Saved line and, when its values differ from the tuning file's or are not known, one sentence under it.
function fileLines(row, file) {
  if (file.error) return el('div.small', { style: { color: 'var(--warn)' } }, `${file.path} cannot be read: ${file.error}`);
  const line = renderLine(file);
  return [
    el('div.small', { style: { color: line.warn ? 'var(--warn)' : 'var(--ok)' } }, liveText(row, () => renderLine(file, file.mtime ? ago(file.mtime) : '').text)),
    file.staleAgainstTuning ? el('div.small', { style: { color: 'var(--warn)' } }, 'rendered at other values than the saved tuning') : null,
    file.tuningUnknown ? el('div.small.muted', 'tuning at render unknown') : null,
  ];
}

// One line per device-pixel column, from that column's lowest to its highest sample, scaled so the file's own
// peak reaches the edge (quiet cues would otherwise be a flat line); the label says so. A silent file stays on the centre line.
// The canvas stays transparent, so the background is the panel's own in either theme.
// A canvas that lasts is painted again only when its size or its colours changed; the ticker's call is how a new theme reaches it.
function paintWave(shownWave) {
  const { canvas, wave } = shownWave;
  const shown = canvas.clientWidth;
  if (!shown) return; // hidden: the resize observer paints it when it has a width
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(shown * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  const styles = getComputedStyle(canvas);
  const lineColour = styles.getPropertyValue('--line').trim();
  const waveColour = styles.getPropertyValue('--muted').trim();
  const painted = [width, height, lineColour, waveColour].join();
  if (shownWave.painted === painted) return;
  shownWave.painted = painted;
  if (wave.columns !== width) {
    wave.peaks = peaksFromWav(wave.bytes, width);
    wave.columns = width;
  }
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  g.fillStyle = lineColour;
  g.fillRect(0, Math.floor(height / 2), width, 1);
  g.fillStyle = waveColour;
  const scale = wave.peak > 0 ? 1 / wave.peak : 1;
  wave.peaks.forEach(({ min, max }, x) => {
    const top = Math.floor((1 - max * scale) * height / 2);
    const bottom = Math.ceil((1 - min * scale) * height / 2);
    g.fillRect(x, top, 1, Math.max(1, bottom - top));
  });
}

function settle(r, phase, text) {
  r.phase = phase;
  r.text = text;
  render();
}

function renderStatus(r) {
  if (!r) return null;
  if (r.phase === 'sent') return el('div.small.muted', 'rendering…');
  if (r.phase === 'saving') return el('div.small.muted', 'saving…');
  if (r.phase === 'no-handler') return el('div.small', { style: { color: 'var(--warn)' }, title: `This project did not answer within 3 s. Older ${productWord()}s have no render handler.` }, 'sent · no render handler');
  return el('div.small', { style: { color: 'var(--warn)' } }, r.text);
}

function trigger(id) {
  const prev = st.sent[id];
  if (prev) clearTimeout(prev.timer);
  const s = { at: Date.now(), ack: null, timedOut: false, framesOpen: (st.ctx.app?.previewTargets?.size || 0) > 0 };
  s.timer = setTimeout(() => { s.timedOut = !s.ack; render(); }, 1000);
  st.sent[id] = s;
  st.ctx.post({ type: 'atelier:cue', id });
  render();
}

function render() {
  if (!st) return;
  const focused = st.container.contains(document.activeElement) ? document.activeElement : null;
  draw();
  // A rebuilt row took the focus with it: the same button in the new row gets it back.
  if (!focused || focused.isConnected) return;
  const { cue, render: rendered } = focused.dataset;
  if (cue) st.container.querySelector(`[data-cue="${cue}"]`)?.focus();
  else if (rendered) st.container.querySelector(`[data-render="${rendered}"]`)?.focus();
}

// Everything a row's words, colours and tooltips depend on, except the passing of time.
function rowFacts(c) {
  const plays = playsOf(c.id);
  const last = plays[plays.length - 1];
  const r = st.renders[c.id];
  const busy = r?.phase === 'sent' || r?.phase === 'saving';
  const file = busy ? null : st.disk[c.id]; // a refused render leaves the earlier file in place, so it is still shown
  const s = st.sent[c.id];
  const status = statusOf(s);
  const fired = last ? {
    words: playsLine(c.id, plays, () => ''),
    title: `${plays.length}×, last at ${new Date(last.at).toLocaleTimeString()}`,
    ok: hasNumbers(last.data) || last.ack,
  } : null;
  const showFired = !!fired && (!s || last.at >= s.at);
  const fileFacts = file && [file.path, file.bytes, file.mtime, file.seconds, file.peak, file.error, !!file.staleAgainstTuning, !!file.tuningUnknown, file.wave?.serial];
  const sig = JSON.stringify([c.id, c.label, c.trigger, productWord(), r?.phase, r?.text, fileFacts, showFired ? fired : status]);
  return { c, plays, r, file, status, fired, showFired, sig, recent: !!last && Date.now() - last.at < 10000 };
}

// One state per row: the newest of "the product fired it" and "the studio triggered it".
function statusOf(s) {
  if (!s) return null;
  const locked = (reason) => /lock|gesture|suspend/i.test(reason || '');
  if (s.ack?.played) return { words: playedText(s.ack), color: 'var(--ok)' };
  if (s.ack) return { words: `not played: ${s.ack.reason || 'no reason given'}${locked(s.ack.reason) ? ` (click in the ${productWord()} first)` : ''}`, color: 'var(--warn)', title: locked(s.ack.reason) ? 'Browsers keep sound off until you click or press a key in the page.' : undefined };
  if (s.timedOut) return { words: 'sent · no acknowledgement', color: 'var(--warn)', title: `This project does not confirm cues. New ${productWord()} projects do; older ones need the cue handler.` };
  return { words: 'sent…', muted: true };
}

function statusLine(status) {
  if (!status) return el('div.muted', 'not fired yet');
  if (status.muted) return el('div.muted', status.words);
  return el('div', { style: { color: status.color }, title: status.title }, status.words);
}

function buildRow({ c, plays, r, file, status, fired, showFired, sig }) {
  const row = { id: c.id, sig, live: [], wave: null, node: null, renderButton: null };
  row.renderButton = button('Render to file', { small: true, title: `Render this cue through the product to dist/audio/${c.id}.wav`, 'data-render': c.id, onclick: () => renderToFile(c.id) });
  row.node = el('li',
    el('div', { style: { minWidth: 0 } },
      el('div', el('strong', c.label || c.id), ' ', el('span.mono.small.muted', c.id)),
      el('div.small.muted.ellipsis', `Plays on: ${c.trigger || '—'}`),
      renderStatus(r),
      file ? fileLines(row, file) : null),
    el('div.small', { style: { textAlign: 'right' } },
      showFired
        ? el('div', { title: fired.title, style: fired.ok ? { color: 'var(--ok)' } : undefined }, liveText(row, () => playsLine(c.id, plays)))
        : statusLine(status)),
    el('div', { style: { display: 'flex', gap: '4px' } },
      button('Trigger', { small: true, title: 'Play this cue in the preview', 'data-cue': c.id, onclick: () => trigger(c.id) }),
      row.renderButton),
    file?.wave ? waveRow(row, file.wave) : null);
  return row;
}

function drawRows(cues) {
  const facts = cues.map(rowFacts);
  const rows = facts.map((f, i) => (st.rows[i]?.sig === f.sig ? st.rows[i] : buildRow(f)));
  if (rows.length !== st.rows.length) clear(st.list, rows.map((row) => row.node));
  else rows.forEach((row, i) => { if (row !== st.rows[i]) st.list.replaceChild(row.node, st.rows[i].node); });
  st.rows = rows;
  rows.forEach((row, i) => {
    row.node.classList.toggle('fired', facts[i].recent);
    for (const { node, words } of row.live) {
      const now = words();
      if (node.data !== now) node.data = now;
    }
  });
  st.waves = rows.map((row) => row.wave).filter(Boolean);
  st.waves.forEach(paintWave);
}

function drawHead(cues) {
  const sig = JSON.stringify([cues.length > 0, st.ctx.bus.ready, productWord(), st.listError]);
  if (sig === st.headSig) return;
  st.headSig = sig;
  if (!cues.length) return clear(st.head, el('div.empty.compact', el('p.empty-title', 'No cues yet. Add "cues": [{"id","label","trigger"}] to atelier.json.')));
  clear(st.head,
    el('div.panel-bar',
      st.ctx.bus.ready ? stateChip('Connected', 'ok') : stateChip('Not reporting', 'warn'),
      el('span.meta', `Events come from the ${productWord()}; a marked row fired in the last 10 s`)),
    st.listError ? el('div.small', { style: { color: 'var(--warn)' } }, `renders not listed: ${st.listError}`) : null);
}

function drawFoot(cues) {
  const known = new Set(cues.map((c) => c.id));
  const others = cues.length ? Object.values(st.disk).filter((file) => !known.has(file.id)).map((file) => file.path) : [];
  const sig = others.join();
  if (sig === st.footSig) return;
  st.footSig = sig;
  clear(st.foot, others.length ? el('div.small.muted', `Also on disk, for no cue here: ${others.join(', ')}`) : null);
}

function draw() {
  const cues = st.ctx.manifest.cues || [];
  drawHead(cues);
  drawRows(cues);
  drawFoot(cues);
}

