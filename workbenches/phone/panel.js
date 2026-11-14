// Phone workbench panel over the routes in ./server.mjs (docs/ARCHITECTURE.md section 10).
// Header: one chip per state GET /phone reports (tools, device, app, build) and the Boot, Build and install,
// Launch and Stop buttons, each enabled only when that state allows it. The live screen is GET /screenshot
// reloaded 300 ms after each image arrives (through an offscreen Image, swapped in once loaded), while the
// panel is visible and the device is booted; a press on it, mapped with the last loaded frame's size,
// becomes a tap or a swipe in device pixels, keys on the focused image go through the key route. Point mode
// posts inspect instead and shows the element and the files that likely hold it. The build log follows
// GET /build/log over EventSource. The iPhone line is the iOS provider's reason, nothing more.
// Nothing here makes a device up: every chip, image and line comes from a route's answer.
// Timers run only while the panel is visible (IntersectionObserver: a hidden tab, a collapsed dock and a
// hidden window all stop them) and unmount clears every one of them. On wide windows the screen node moves beside the
// preview (./beside.js); then it counts as visible on its own, so the stream runs with the Phone tab closed.
import { el, clear, button, stateChip, toast, copyText } from '/components/ui.js';
import { POLL_MS, SCREEN_MS, LOG_LINES, KEY_FOR, gestureFrom, providerOf, targetOf, isBooted, chipsFor, actionsFor, buildLine, rateLine, elementName, candidateRef, readoutState, taskText } from './map.js';
import { pinFromReadout } from '/components/companion-words.js';
import { createBeside, BESIDE_LINE } from './beside.js';

let st = null;
const POINT_EVENT = 'atelier:point-mode'; // the Phone and Page Point modes are never both on

const ACTIONS = [
  ['boot', 'Boot'],
  ['build', 'Build and install'],
  ['launch', 'Launch'],
  ['stop', 'Stop'],
];

export function mount(container, ctx) {
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/phone`;
  const me = {
    ctx, container, base,
    status: null, statusError: null, pending: {}, lastAction: null,
    visible: true, poll: null, frameTimer: null, frameTimes: [], screenOn: false, screenError: null, down: null,
    loader: null, natural: null, // the offscreen Image of the frame in flight; the last loaded frame's natural size
    point: false, readout: null, es: null, log: [], logEnd: null, logFor: null, observer: null, offs: [],
  };
  st = me;
  container.classList?.add('phone-host');

  const n = (me.nodes = {});
  n.chips = el('div.phone-chips', { role: 'group', 'aria-label': 'Phone status' });
  n.toolsLine = el('p.meta.phone-tools', { hidden: true });
  n.reason = el('p.meta', { hidden: true });
  n.buttons = {};
  for (const [key, label] of ACTIONS) n.buttons[key] = button(label, { small: true, disabled: true, dataset: { action: key }, onclick: () => act(key) });
  n.actionLine = el('p.meta', { role: 'status' });
  n.img = el('img.phone-img', { tabIndex: 0, alt: 'Phone screen', hidden: true, ondragstart: (e) => e.preventDefault() });
  n.noScreen = el('p.meta.phone-noscreen', 'No screen yet: reading the phone status…');
  n.live = el('p.meta.phone-live');
  // The ghost marker's words (client/components/ghost.js): a build's step or a session's edit, over the image's top
  // edge, never over the live line below it or Point beside it.
  n.ghostLabel = el('span.ghost-label');
  n.ghost = el('p.phone-ghost', { hidden: true }, el('span.ghost-dot', { 'aria-hidden': 'true' }), n.ghostLabel);
  n.inputLine = el('p.meta', { role: 'status' });
  n.text = el('input.input.phone-text', { type: 'text', placeholder: 'Text to type on the phone', 'aria-label': 'Text to type on the phone', maxLength: 500 });
  n.send = button('Send', { small: true, type: 'submit' });
  n.form = el('form.phone-type', { onsubmit: (e) => { e.preventDefault(); sendText(); } }, n.text, n.send);
  n.back = button('Back', { small: true, variant: 'quiet', onclick: () => sendInput({ type: 'key', key: 'back' }) });
  n.home = button('Home', { small: true, variant: 'quiet', onclick: () => sendInput({ type: 'key', key: 'home' }) });
  n.pointBtn = button('Point mode', { small: true, 'aria-pressed': 'false', title: 'A tap on the screen reads the element under it instead of reaching the phone (Esc leaves)', onclick: () => setPoint(!me.point) });
  n.readout = el('div.phone-readout', { role: 'status' });
  n.logLine = el('p.meta');
  n.logPre = el('pre.phone-log-lines', { tabIndex: 0, 'aria-label': 'Build log lines' });
  n.log = el('details.phone-log', el('summary', 'Build log'), n.logLine, n.logPre);
  n.ios = el('p.meta.phone-ios', { hidden: true });
  n.drawNote = el('div.note.danger', { role: 'alert', hidden: true });

  n.img.addEventListener('pointerdown', onDown);
  n.img.addEventListener('pointerup', onUp);
  n.img.addEventListener('pointercancel', () => { me.down = null; });
  n.img.addEventListener('keydown', onImgKey);
  container.addEventListener?.('keydown', onPanelKey);
  n.screen = el('div.phone-screen', n.ghost, n.img, n.noScreen, n.live);
  n.screen.addEventListener('keydown', onPanelKey); // Esc leaves Point mode beside the preview too, outside the tab
  n.besideLine = el('p.meta.phone-beside-line', { hidden: true }, BESIDE_LINE);
  n.besideBox = el('input', { type: 'checkbox', checked: true });
  n.phone = el('div.phone', n.screen, n.besideLine,
    el('div.phone-side',
      n.drawNote, n.chips, n.toolsLine, n.reason,
      el('div.phone-actions', ACTIONS.map(([k]) => n.buttons[k])), n.actionLine,
      el('div.phone-keys', n.back, n.home, n.pointBtn), n.form, n.inputLine,
      el('label.check.small.phone-beside', { title: 'On windows 1440 px or wider the live screen sits to the right of the preview; off keeps it here at every width' }, n.besideBox, el('span', 'Beside the preview')),
      n.readout, n.log, n.ios));
  clear(container, n.phone);

  // Visible = the dock shows this tab, the dock is open, and the window is not hidden; or the screen is beside the
  // preview and on screen there. Entries name their target; one with none is the tab's container.
  me.seen = new Map();
  const onVis = () => setVisible(!document.hidden && (me.seen.get(container) !== false || (me.beside?.beside() && me.seen.get(n.screen) !== false)));
  if (typeof IntersectionObserver === 'function') {
    me.observer = new IntersectionObserver((entries) => { for (const e of entries) me.seen.set(e.target ?? container, e.isIntersecting); onVis(); });
    me.observer.observe(container);
    me.observer.observe(n.screen);
  }
  me.beside = createBeside({ ctx, screen: n.screen, phone: n.phone, line: n.besideLine, box: n.besideBox, host: container,
    onMove: () => { if (st === me && me.started) onVis(); },
    onError: (err) => { if (st === me) toast(`Beside the preview not saved: ${err.message}`, { tone: 'danger' }); } });
  document.addEventListener?.('visibilitychange', onVis);
  me.offs.push(() => document.removeEventListener?.('visibilitychange', onVis));
  const onOther = (e) => { if (st === me && e?.detail?.owner !== 'phone' && me.point) setPoint(false); };
  globalThis.window?.addEventListener?.(POINT_EVENT, onOther);
  me.offs.push(() => globalThis.window?.removeEventListener?.(POINT_EVENT, onOther));
  if (typeof ctx.app?.on === 'function') me.offs.push(ctx.app.on('ghost', onGhost));
  onGhost(ctx.app?.workbench?.ghost?.()); // mounted after the ghost last drew: start from its model
  me.visible = false;
  me.started = true;
  setVisible(!document.hidden);
}

export function unmount() {
  const me = st;
  if (!me) return;
  st = null;
  clearInterval(me.poll);
  clearTimeout(me.frameTimer);
  me.poll = me.frameTimer = null;
  me.loader = null;
  me.observer?.disconnect();
  me.es?.close();
  me.es = null;
  me.offs.forEach((off) => off());
  me.beside?.destroy(); // the screen leaves the slot beside the preview
  me.nodes.screen.removeEventListener?.('keydown', onPanelKey);
  if (me.readout) me.ctx.app?.emit?.('ghost-readout', { projectId: me.ctx.projectId, source: 'phone', selector: null });
  me.container.removeEventListener?.('keydown', onPanelKey);
  me.container.classList?.remove('phone-host');
}

/** The bundle was refreshed (a task finished, files changed): read the status again. */
export function update() {
  st?.beside?.place(); // the switch may have changed in another window
  if (st?.visible) refresh();
}

/** A command from the dock (studio.show from the companion): { point } turns Point mode on or off. Point mode needs
 *  a booted device, so before the first status says one is up the wish waits for it; a later off cancels it. */
export function command({ point } = {}) {
  const me = st;
  if (!me || typeof point !== 'boolean') return;
  if (!point) { me.wantPoint = false; if (me.point) setPoint(false); return; }
  if (isBooted(providerOf(me.status, 'android'))) setPoint(true);
  else {
    me.wantPoint = true;
    me.nodes.inputLine.textContent = 'Point mode turns on once the phone is up.';
  }
}

// ---------- visibility and timers ----------

function setVisible(on) {
  const me = st;
  if (!me || me.visible === on) return;
  me.visible = on;
  clearInterval(me.poll);
  me.poll = null;
  if (on) {
    me.poll = setInterval(refresh, POLL_MS);
    refresh();
  } else stopScreen();
}

// ---------- status ----------

async function getJson(url, method = 'GET', body) {
  const res = await fetch(url, method === 'GET' ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `${method} ${url} failed (${res.status})`), { code: data?.error?.code, status: res.status });
  return data;
}

async function refresh() {
  const me = st;
  if (!me) return;
  try {
    const status = await getJson(me.base);
    if (st !== me) return;
    me.status = status;
    me.statusError = null;
  } catch (err) {
    if (st !== me) return;
    me.status = null; // an old answer must not stand as the device's state
    me.statusError = err;
  }
  render();
  syncScreen();
  syncLog();
}

/** A draw that throws must not leave the panel frozen on its last good state: one danger note with a Retry, the
 *  error logged once per failure, and the next draw that works takes the note away. */
function render() {
  const me = st;
  if (!me) return;
  try {
    draw();
    if (me.drawError) { me.drawError = null; me.nodes.drawNote.hidden = true; clear(me.nodes.drawNote); }
  } catch (err) {
    const message = err?.message || String(err);
    if (me.drawError !== message) console.error('Phone view could not be drawn', err);
    me.drawError = message;
    me.nodes.drawNote.hidden = false;
    clear(me.nodes.drawNote, `The phone view could not be drawn: ${message}. `, button('Retry', { small: true, onclick: () => refresh() }));
  }
}

function draw() {
  const me = st;
  const n = me.nodes;
  const android = providerOf(me.status, 'android');
  clear(n.chips, chipsFor(android, me.pending).map((c) => {
    const chip = stateChip(c.text, c.tone, c.title);
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', c.label);
    chip.dataset.chip = c.key;
    return chip;
  }));

  const adb = android?.tools?.adb;
  const emu = android?.tools?.emulator;
  const missing = [adb, emu].filter((t) => t && !t.found);
  n.toolsLine.hidden = !missing.length;
  n.toolsLine.textContent = missing.map((t) => t.reason || `not found at ${t.path}`).join(' · ');

  const reason = me.statusError ? `Phone status not read: ${me.statusError.message}` : !me.status ? '' : !android ? 'No Android provider applies to this project.' : android.reason || '';
  n.reason.hidden = !reason;
  n.reason.textContent = reason;

  const acts = actionsFor(android, me.pending);
  for (const [k] of ACTIONS) {
    const b = n.buttons[k];
    b.disabled = !acts[k].enabled;
    b.title = acts[k].why || '';
  }
  n.actionLine.textContent = me.lastAction || '';

  const booted = isBooted(android);
  for (const b of [n.back, n.home, n.send]) b.disabled = !booted;
  n.text.disabled = !booted;
  n.pointBtn.disabled = !booted;
  if (!booted && me.point) setPoint(false);
  if (booted && me.wantPoint) { me.wantPoint = false; setPoint(true); }

  const ios = providerOf(me.status, 'ios');
  n.ios.hidden = !ios;
  n.ios.textContent = ios ? `iPhone: ${ios.reason}${ios.note ? ` ${ios.note}` : ''}` : '';

  const tgt = targetOf(android);
  const name = tgt ? (tgt.avd ? `${tgt.avd} (${tgt.serial})` : tgt.serial) : 'the phone';
  n.img.setAttribute('aria-label', `Screen of ${name}. Click to tap, drag to swipe; with the screen focused, Esc is Back and Enter, Backspace and the arrow keys go to the phone.`);
  n.img.alt = `Screen of ${name}`;
}

// ---------- actions ----------

async function act(key) {
  const me = st;
  if (!me || me.pending[key]) return;
  me.pending[key] = true;
  const label = ACTIONS.find(([k]) => k === key)[1];
  me.lastAction = key === 'boot' ? 'Boot sent: waiting for the device (up to 3 minutes)…' : `${label}: sent…`;
  render();
  let line;
  try {
    const out = await getJson(`${me.base}/${key}`, 'POST', {});
    if (st !== me) return;
    if (!out.ok) line = `${label}: ${out.message || out.code}`;
    else if (key === 'build') { line = 'Build started: the log follows below.'; me.logEnd = null; me.nodes.log.open = true; followLog(true); }
    else if (key === 'boot') line = out.already ? `Boot: ${out.serial} was already up` : `Booted ${out.serial}`;
    else if (key === 'launch') line = `Launched ${out.component || ''}`.trim();
    else line = `Stopped ${out.serial}`;
  } catch (err) {
    if (st !== me) return;
    line = `${label}: ${err.message}`;
  }
  me.pending[key] = false;
  me.lastAction = line;
  refresh();
}

async function post(path, body) {
  return getJson(`${st.base}/${path}`, 'POST', body);
}

async function sendInput(action) {
  const me = st;
  if (!me) return null;
  try {
    const out = await post('input', action);
    if (st !== me) return null;
    me.nodes.inputLine.textContent = out.ok ? '' : `Not sent: ${out.message || out.code}`;
    return out;
  } catch (err) {
    if (st === me) me.nodes.inputLine.textContent = `Not sent: ${err.message}`;
    return null;
  }
}

async function sendText() {
  const me = st;
  const text = me.nodes.text.value;
  if (!text) return;
  const out = await sendInput({ type: 'text', text });
  if (out?.ok && st === me) me.nodes.text.value = '';
}

// ---------- the live screen ----------

function syncScreen() {
  const me = st;
  const android = providerOf(me.status, 'android');
  const booted = isBooted(android);
  if (me.visible && booted) {
    if (!me.screenOn) { me.screenOn = true; me.screenError = null; nextFrame(0); }
  } else {
    stopScreen();
    const why = me.statusError ? 'the phone status could not be read' : !android ? 'no Android provider' : !android.tools?.adb?.found ? 'adb is missing' : targetOf(android) ? `${targetOf(android).serial} is still booting` : 'no device online';
    showNoScreen(`No screen: ${why}.`);
  }
}

function stopScreen() {
  const me = st;
  if (!me) return;
  me.screenOn = false;
  clearTimeout(me.frameTimer);
  me.frameTimer = null;
  me.loader = null; // a frame still in flight is dropped when it lands
  me.frameTimes = [];
}

function showNoScreen(text) {
  const n = st.nodes;
  n.img.hidden = true;
  n.noScreen.hidden = false;
  n.noScreen.textContent = text;
  n.live.textContent = '';
}

/**
 * The next frame loads in an offscreen Image; the visible image takes its src only once it has loaded, so the
 * screen never flashes empty and its last frame stays to be tapped while the next one is on its way.
 */
function nextFrame(wait = SCREEN_MS) {
  const me = st;
  clearTimeout(me.frameTimer);
  me.frameTimer = setTimeout(() => {
    me.frameTimer = null;
    if (st !== me || !me.screenOn) return;
    const url = `${me.base}/screenshot?t=${Date.now()}`;
    const loader = (me.loader = new Image());
    loader.addEventListener('load', () => {
      if (st !== me || me.loader !== loader) return;
      me.loader = null;
      onFrame(url, loader);
    });
    loader.addEventListener('error', () => {
      if (st !== me || me.loader !== loader) return;
      me.loader = null;
      onFrameError();
    });
    loader.src = url;
  }, wait);
}

function onFrame(url, loaded) {
  const me = st;
  if (!me) return;
  const n = me.nodes;
  if (loaded.naturalWidth > 0 && loaded.naturalHeight > 0) me.natural = { naturalWidth: loaded.naturalWidth, naturalHeight: loaded.naturalHeight };
  n.img.src = url;
  n.img.hidden = false;
  n.noScreen.hidden = true;
  me.frameTimes.push(Date.now());
  if (me.frameTimes.length > 6) me.frameTimes.shift();
  n.live.textContent = rateLine(me.frameTimes) || 'Live: the first screenshot arrived';
  if (me.screenOn) nextFrame();
}

/** An image cannot carry the route's JSON: ask once more as fetch for the reason, then wait for the next status. */
async function onFrameError() {
  const me = st;
  if (!me) return;
  stopScreen();
  let why = 'the screenshot did not load';
  try {
    const res = await fetch(`${me.base}/screenshot?t=${Date.now()}`);
    if (!res.ok) why = (await res.json().catch(() => null))?.error?.message || `the route answered ${res.status}`;
  } catch (err) { why = err.message; }
  if (st !== me) return;
  showNoScreen(`No screen: ${why}. The next status check tries again.`);
}

function onDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const me = st;
  me.nodes.img.focus?.();
  me.down = { clientX: e.clientX, clientY: e.clientY, t: e.timeStamp ?? Date.now() };
  try { me.nodes.img.setPointerCapture?.(e.pointerId); } catch { /* no capture: the release still lands here mostly */ }
}

function onUp(e) {
  const me = st;
  if (!me?.down) return;
  const down = me.down;
  me.down = null;
  const img = me.nodes.img;
  // The last loaded frame's size, not the element's: naturalWidth can read 0 while a src is changing.
  const natural = me.natural || { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  const g = gestureFrom(down, { clientX: e.clientX, clientY: e.clientY, t: e.timeStamp ?? Date.now() }, img.getBoundingClientRect(), natural);
  if (!g) return;
  if (me.point) {
    if (g.type === 'tap') inspect(g.x, g.y);
    else me.nodes.inputLine.textContent = 'Point mode reads a tap; a drag does nothing. Esc leaves Point mode.';
    return;
  }
  sendInput(g);
}

function onImgKey(e) {
  const me = st;
  if (e.key === 'Escape' && me.point) return; // the panel's handler leaves Point mode
  const key = KEY_FOR[e.key];
  if (!key) return;
  e.preventDefault();
  e.stopPropagation();
  sendInput({ type: 'key', key });
}

function onPanelKey(e) {
  if (e.key === 'Escape' && st?.point) {
    e.preventDefault();
    e.stopPropagation();
    setPoint(false);
  }
}

// ---------- Point mode ----------

function setPoint(on) {
  const me = st;
  me.point = on;
  // The Page tab's Point on the preview turns off when this one turns on (workbenches/page/panel.js listens).
  if (on) { try { globalThis.window?.dispatchEvent?.(new CustomEvent(POINT_EVENT, { detail: { owner: 'phone' } })); } catch { /* no window */ } }
  me.wantPoint = false; // a press, or the wish come true, ends a waiting command({ point })
  me.nodes.pointBtn.setAttribute('aria-pressed', String(on));
  me.nodes.img.classList?.toggle('pointing', on);
  me.nodes.inputLine.textContent = on ? 'Point mode: tap the screen to read the element under it. Nothing reaches the phone.' : '';
}

async function inspect(x, y) {
  const me = st;
  const turn = (me.inspectTurn = (me.inspectTurn || 0) + 1);
  clear(me.nodes.readout, el('p.meta', `Reading the element under (${x}, ${y})…`));
  let answer;
  try { answer = await post('inspect', { x, y }); } catch (err) { answer = { ok: false, code: err.code, message: err.message }; }
  if (st !== me || me.inspectTurn !== turn) return;
  me.readout = answer;
  showReadout(answer);
  // The readout links the element to its files: the ghost outlines it on the preview if the selector is found there.
  const found = readoutState(answer).found && answer.candidates?.length;
  me.ctx.app?.emit?.('ghost-readout', {
    projectId: me.ctx.projectId, source: 'phone', selector: found ? answer.element?.selector || null : null,
    element: found ? elementName(answer.element) : null, files: found ? answer.candidates.map(candidateRef) : [],
  });
}

/** The ghost's phone words: a running build's step, else the session's label; hidden when there is neither. */
function onGhost(e) {
  const me = st;
  if (!me || e?.projectId !== me.ctx.projectId) return;
  const words = e.model?.phone || '';
  const n = me.nodes.ghost;
  n.hidden = !words;
  n.title = e.model?.title || '';
  me.nodes.ghostLabel.textContent = words;
}

function showReadout(answer) {
  const box = st.nodes.readout;
  const s = readoutState(answer);
  if (!s.found) return clear(box, el('p', s.title), s.detail ? el('p.meta', s.detail) : null);
  const { element, page, point, candidates = [], searched } = answer;
  const row = (k, v) => el('div.phone-kv', el('span.meta', k), v);
  clear(box,
    row('Element', el('code', elementName(element))),
    row('Text', element.text ? el('span', element.text) : el('span.meta', 'no text')),
    row('Page', el('code', page?.url || element.url || '')),
    point ? row('Point', el('span.meta', `device (${point.device.x}, ${point.device.y}) · page (${point.css.x}, ${point.css.y})`)) : null,
    row('Files', candidates.length
      ? el('div.phone-files', candidates.map((c) => button(candidateRef(c), { small: true, variant: 'quiet', class: 'mono', title: `Open ${candidateRef(c)} in the Source tab (matches ${(c.matched || []).join(', ')})`, onclick: () => openSource(c) })),
        button('Copy', { small: true, variant: 'quiet', title: 'Copy these files as file:line, one per line', onclick: () => copy(candidates.map(candidateRef).join('\n'), filesWord(candidates.length)) }))
      : el('span.meta', `No file holds its id, classes or text${searched ? ` in ${searched}` : ''}`)),
    el('div.phone-files',
      button('Pin', { small: true, title: 'Keep this point for the companion: it is listed under the Companion thread and can ride a message', onclick: () => pin(answer) }),
      button('Copy for a task', { small: true, onclick: () => copy(taskText(answer), 'The point, the element and its first files') })));
}

/** The readout as a pin (.studio/pins.json, through the companion's route); the Companion tab lists it on pins.changed. */
async function pin(answer) {
  const me = st;
  try {
    const out = await getJson(`/api/projects/${encodeURIComponent(me.ctx.projectId)}/companion/pins`, 'POST', pinFromReadout(answer));
    if (st === me) toast(`Pinned ${out.element}: it is listed under the Companion thread`, { tone: 'ok' });
  } catch (err) {
    if (st === me) toast(`Pin: ${err.message}`, { tone: 'danger' });
  }
}

const filesWord = (n) => `${n} file${n === 1 ? '' : 's'} as file:line`;

/** A file:line button opens the file at the line in the Source tab (app.openSource; decision row 67 revised). */
function openSource(c) {
  const open = st?.ctx.app?.openSource;
  if (typeof open !== 'function') return toast('The Source tab is not available here', { tone: 'danger' });
  return open({ path: c.file, line: c.line });
}

async function copy(text, what = text) {
  const ok = await copyText(text);
  toast(ok ? `Copied ${what}` : 'Could not copy to the clipboard', { tone: ok ? 'neutral' : 'danger' });
}

// ---------- the build log ----------

function syncLog() {
  const me = st;
  const build = providerOf(me.status, 'android')?.build;
  me.nodes.logLine.textContent = buildLine(me.logEnd || build);
  if (!build || build.state === 'none') return;
  // A running build is followed; a finished one is read once for its kept lines.
  if (build.state === 'running' || me.logFor !== build.startedAt) followLog(false, build.startedAt);
}

function followLog(fresh, startedAt) {
  const me = st;
  if (me.es || typeof EventSource !== 'function') return;
  me.logFor = startedAt ?? me.logFor;
  if (fresh) { me.log = []; me.nodes.logPre.textContent = ''; }
  const es = (me.es = new EventSource(`${me.base}/build/log`));
  let replaying = true;
  es.onmessage = (e) => {
    if (st !== me) return;
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (typeof data?.line !== 'string') return;
    if (data.replay && replaying) { replaying = false; me.log = []; } // the kept lines come again on every open
    if (!data.replay) replaying = false;
    addLines([data.line]);
  };
  es.addEventListener('end', (e) => {
    es.close();
    if (st !== me) return;
    me.es = null;
    let end = null;
    try { end = JSON.parse(e.data); } catch { /* no state */ }
    if (end && end.state !== 'none') { me.logEnd = end; me.logFor = end.startedAt ?? me.logFor; }
    me.nodes.logLine.textContent = buildLine(me.logEnd);
    if (fresh) refresh();
  });
  es.onerror = () => {
    es.close();
    if (st !== me) return;
    me.es = null;
    me.nodes.logLine.textContent = 'The log stopped: the connection to the studio closed. The next status check follows it again.';
  };
}

function addLines(lines) {
  const me = st;
  const pre = me.nodes.logPre;
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  me.log.push(...lines);
  if (me.log.length > LOG_LINES) me.log.splice(0, me.log.length - LOG_LINES);
  pre.textContent = me.log.join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

/** Tests only: the panel's state, read without reaching into the DOM. */
export const _state = () => st;
