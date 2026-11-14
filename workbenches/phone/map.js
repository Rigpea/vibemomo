// Phone panel, the pure half: no DOM and no fetch, so tests/phone-panel.test.mjs reads it directly.
// What the chips say, which buttons apply, how a pointer on the screen image becomes device pixels and
// a tap or a swipe, and the words of the Point mode readout. Every value comes from a route's answer
// (workbenches/phone/server.mjs; docs/ARCHITECTURE.md section 10); nothing here makes a device up.

export const POLL_MS = 5000; // the status, while the panel is visible
export const SCREEN_MS = 300; // the wait after each screenshot before the next one
export const LOG_LINES = 400; // the build log keeps as many lines as the server does
export const TAP_SLOP_PX = 8; // a press and release closer than this (CSS pixels) is a tap
export const SWIPE_MS = { min: 1, max: 10000 }; // what the input route accepts

/** Keys on the focused screen that go to the phone; Esc is Back, as on the Android emulator. */
export const KEY_FOR = {
  Escape: 'back', Enter: 'enter', Backspace: 'delete', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * A point on the drawn image to device pixels, from the image's box as getBoundingClientRect gives it and the
 * natural size of the last frame that loaded (the panel keeps it, since naturalWidth reads 0 while the next
 * frame loads). The image is drawn object-fit: contain, so a box wider or taller than the frame's ratio holds
 * the frame centred at one scale; a box at the ratio is the plain naturalWidth / drawn width. A point in the
 * margin clamps to the screen's edge. Null when the image or the frame has no size.
 */
export function toDevice({ clientX, clientY }, rect, { naturalWidth, naturalHeight } = {}) {
  if (!(rect?.width > 0) || !(rect?.height > 0) || !(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const left = rect.left + (rect.width - naturalWidth * scale) / 2;
  const top = rect.top + (rect.height - naturalHeight * scale) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  return { x: clamp(Math.round(x), 0, naturalWidth - 1), y: clamp(Math.round(y), 0, naturalHeight - 1) };
}

/**
 * A press and its release as the input route's action: a tap where the press began when the pointer moved
 * at most TAP_SLOP_PX, else a swipe from the press to the release lasting as long as the drag did.
 * down and up: { clientX, clientY, t } with t in milliseconds. Null when the image has no size.
 */
export function gestureFrom(down, up, rect, natural, slop = TAP_SLOP_PX) {
  const a = toDevice(down, rect, natural);
  const b = toDevice(up, rect, natural);
  if (!a || !b) return null;
  if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) <= slop) return { type: 'tap', x: a.x, y: a.y };
  const ms = clamp(Math.round((up.t ?? 0) - (down.t ?? 0)), SWIPE_MS.min, SWIPE_MS.max);
  return { type: 'swipe', x: a.x, y: a.y, x2: b.x, y2: b.y, ms };
}

// ---------- the status answer ----------

export const providerOf = (status, id) => (status?.providers || []).find((p) => p?.id === id) || null;

/** The device actions act on, as GET /phone named it in `target`. */
export const targetOf = (android) => (android?.target ? (android.devices || []).find((d) => d.serial === android.target) || null : null);

const nameOf = (d) => d?.avd || d?.serial || '';
export const isBooted = (android) => !!targetOf(android)?.booted;

const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * The four chips: { key, text, tone, title, label }. `pending` is what this panel has posted and not had
 * answered yet ({ boot, build }); a Boot in flight reads Booting, a Build in flight reads Building.
 */
export function chipsFor(android, pending = {}, time = hhmm) {
  if (!android) return [];
  const tools = android.tools || {};
  const adb = tools.adb || {};
  const emu = tools.emulator || {};
  const chips = [];

  if (!adb.found) chips.push({ key: 'tools', text: 'adb missing', tone: 'danger', title: adb.reason || `adb not found${adb.path ? ` at ${adb.path}` : ''}` });
  else if (!emu.found) chips.push({ key: 'tools', text: 'emulator missing', tone: 'warn', title: emu.reason || `emulator not found${emu.path ? ` at ${emu.path}` : ''}` });
  else chips.push({ key: 'tools', text: 'Tools found', tone: 'ok', title: `adb: ${adb.path} · emulator: ${emu.path}` });

  const devices = android.devices || [];
  const tgt = targetOf(android);
  const avd = android.config?.avd || null;
  if (!adb.found || android.available === false) chips.push({ key: 'device', text: 'Device unknown', tone: 'neutral', title: android.reason || 'adb is needed to list devices' });
  else if (tgt?.booted) chips.push({ key: 'device', text: `Booted · ${nameOf(tgt)}`, tone: 'ok', title: `${tgt.serial}${tgt.avd ? ` runs ${tgt.avd}` : ''}; sys.boot_completed is 1` });
  else if (tgt) chips.push({ key: 'device', text: `Booting · ${nameOf(tgt)}`, tone: 'busy', title: `${tgt.serial} is online; sys.boot_completed is not 1 yet` });
  else if (pending.boot) chips.push({ key: 'device', text: `Booting${avd ? ` · ${avd}` : ''}`, tone: 'busy', title: 'Boot was sent; the studio waits for the device to come up' });
  else {
    const starting = devices.find((d) => d.emulator);
    if (starting) chips.push({ key: 'device', text: `Booting · ${nameOf(starting)}`, tone: 'busy', title: `${starting.serial} is ${starting.state}` });
    else if (devices.length) chips.push({ key: 'device', text: 'No device online', tone: 'warn', title: devices.map((d) => `${d.serial} is ${d.state}`).join('; ') });
    else chips.push({ key: 'device', text: 'No device', tone: 'neutral', title: android.reason || 'adb lists no device' });
  }

  const app = android.app;
  const appId = android.config?.appId || app?.appId || null;
  if (!appId) chips.push({ key: 'app', text: 'No app id', tone: 'warn', title: 'Set devices.android.appId in atelier.json, or add a capacitor.config.json with appId' });
  else if (!app || app.installed === null || app.installed === undefined) chips.push({ key: 'app', text: 'App not checked', tone: 'neutral', title: `${appId}: no booted device to ask` });
  else if (app.running) chips.push({ key: 'app', text: 'App running', tone: 'ok', title: `${appId}, pid ${app.pid} on ${app.serial}` });
  else if (app.installed) chips.push({ key: 'app', text: 'App installed', tone: 'neutral', title: `${appId} is installed on ${app.serial} and not running` });
  else chips.push({ key: 'app', text: 'App not installed', tone: 'neutral', title: `${appId} is not installed on ${app.serial}` });

  const build = android.build || { state: 'none' };
  if (pending.build || build.state === 'running') {
    const s = build.state === 'running' ? build.step : null;
    chips.push({ key: 'build', text: s ? `Building · step ${s.index} of ${s.of}` : 'Building', tone: 'busy', title: s?.label || 'The build was started' });
  } else if (build.state === 'failed') chips.push({ key: 'build', text: `Build failed · ${time(build.endedAt)}`, tone: 'danger', title: build.message || 'The build failed' });
  else if (build.state === 'ok') chips.push({ key: 'build', text: `Built · ${time(build.endedAt)}`, tone: 'ok', title: build.message || 'The build finished' });
  else chips.push({ key: 'build', text: 'Build idle', tone: 'neutral', title: build.note || 'No build since the studio started' });

  const word = { tools: 'Tools', device: 'Device', app: 'App', build: 'Build' };
  return chips.map((c) => ({ ...c, label: `${word[c.key]}: ${c.text}. ${c.title}` }));
}

/** Which action buttons apply: { boot, build, launch, stop } each { enabled, why }. why is the reason when not. */
export function actionsFor(android, pending = {}) {
  const off = (why) => ({ enabled: false, why });
  const on = { enabled: true, why: null };
  if (!android) { const no = off('No status from the phone route yet'); return { boot: no, build: no, launch: no, stop: no }; }
  const tools = android.tools || {};
  const adbFound = !!tools.adb?.found;
  const tgt = targetOf(android);
  const booted = !!tgt?.booted;
  const cfg = android.config || {};
  const building = pending.build || android.build?.state === 'running';
  const noAdb = off(tools.adb?.reason || 'adb not found');

  let boot;
  if (pending.boot) boot = off('Booting: the studio waits up to 3 minutes for the device');
  else if (!adbFound) boot = noAdb;
  else if (!tools.emulator?.found) boot = off(tools.emulator?.reason || 'emulator not found');
  else if (!cfg.avd) boot = off('No AVD named: set devices.android.avd in atelier.json');
  else if (booted) boot = off(`${nameOf(tgt)} is already up`);
  else boot = on;

  let build;
  if (building) build = off('A build is running');
  else if (cfg.build) build = on; // the project's own build line runs alone in its folder
  else if (!adbFound) build = noAdb;
  else if (!booted) build = off('Boot a device first: the last step installs the app on it');
  else build = on;

  let launch;
  if (pending.launch) launch = off('Launching');
  else if (!cfg.appId) launch = off('No app id: set devices.android.appId in atelier.json');
  else if (!booted) launch = off('No booted device');
  else if (android.app?.installed !== true) launch = off(`${cfg.appId} is not installed: build and install first`);
  else launch = on;

  let stop;
  if (pending.stop) stop = off('Stopping');
  else if (!tgt) stop = off('No device online');
  else if (!tgt.emulator) stop = off(`${tgt.serial} is a phone over USB; the studio cannot switch it off`);
  else stop = on;

  return { boot, build, launch, stop };
}

/** The line under the build log: the failing step and its exit code, or how the build ended. */
export function buildLine(build, time = hhmm) {
  if (!build || build.state === 'none' || !build.state) return '';
  if (build.state === 'running') return build.step ? `Step ${build.step.index} of ${build.step.of}: ${build.step.label}` : 'Running';
  if (build.state === 'failed') {
    const where = build.step ? `Failed at step ${build.step.index} of ${build.step.of} (${build.step.label})` : 'Failed';
    return build.exitCode !== null && build.exitCode !== undefined ? `${where} · exit code ${build.exitCode}` : `${where} · ${build.message || 'no exit code'}`;
  }
  return `${build.message || 'Build finished'} · ${time(build.endedAt)}`;
}

/** "Live, about N frames a second", from the times the last screenshots arrived. Null before two of them. */
export function rateLine(times) {
  if (!Array.isArray(times) || times.length < 2) return null;
  const span = times[times.length - 1] - times[0];
  if (!(span > 0)) return null;
  const fps = ((times.length - 1) * 1000) / span;
  const n = fps < 1.5 ? fps.toFixed(1) : String(Math.round(fps));
  return `Live, about ${n} frame${n === '1' || n === '1.0' ? '' : 's'} a second: still screenshots from the device, not video`;
}

// ---------- Point mode ----------

/** tag#id.class.class, as the element reads in the readout and in the copied block. */
export function elementName(element) {
  if (!element) return '';
  return `${element.tag || element.nodeName?.toLowerCase() || '?'}${element.id ? `#${element.id}` : ''}${(element.classes || []).map((c) => `.${c}`).join('')}`;
}

export const candidateRef = (c) => `${c.file}:${c.line}`;

/**
 * What the readout says for an inspect answer: { found, title, detail } when nothing was found, else
 * { found: true }. Plain words for the ways nothing is there (a native screen, no WebView, the app not running).
 */
export function readoutState(answer) {
  if (!answer) return { found: false, title: 'No answer from the phone' };
  if (answer.ok === false) {
    if (answer.code === 'no_webview_socket' || answer.code === 'no_page') return { found: false, title: 'Nothing found: this screen has no web page to read. It is a native screen, or the app has no debuggable WebView.', detail: answer.message };
    if (answer.code === 'not_in_front') return { found: false, title: answer.message || 'The app is not on the screen.' };
    if (answer.code === 'app_not_running') return { found: false, title: 'Nothing found: the app is not running. Launch it first.', detail: answer.message };
    if (answer.code === 'no_device') return { found: false, title: 'Nothing found: no device online.', detail: answer.message };
    if (answer.code === 'no_app_id') return { found: false, title: 'Nothing found: the project names no app id.', detail: answer.message };
    return { found: false, title: `Could not read the point: ${answer.message || answer.code || 'no reason given'}` };
  }
  if (!answer.element) return { found: false, title: 'Nothing found under this point in the page.', detail: answer.page?.url ? `Page: ${answer.page.url}` : null };
  return { found: true };
}

/** The block "Copy for a task" puts on the clipboard: the point, the element and the first three candidates. */
export function taskText(answer) {
  const { point, element, page, candidates = [], serial, searched } = answer || {};
  const lines = [];
  const dev = point?.device;
  const css = point?.css;
  lines.push(`Phone point: device ${dev ? `(${dev.x}, ${dev.y})` : '(?)'}${serial ? ` on ${serial}` : ''}${css ? `, page CSS (${css.x}, ${css.y})` : ''}`);
  if (element) {
    lines.push(`Element: ${elementName(element)}${element.selector ? ` (selector ${element.selector})` : ''}`);
    lines.push(`Text: ${element.text ? `"${element.text}"` : '(none)'}`);
  }
  if (page?.url || element?.url) lines.push(`Page: ${page?.url || element.url}`);
  const top = candidates.slice(0, 3);
  if (top.length) {
    lines.push('Files:');
    for (const c of top) lines.push(`- ${candidateRef(c)}${c.matched?.length ? ` (matches ${c.matched.join(', ')})` : ''}`);
  } else lines.push(`Files: none found${searched ? ` in ${searched}` : ''}`);
  return lines.join('\n');
}
