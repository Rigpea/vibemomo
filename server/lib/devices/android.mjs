// The Android provider: adb and the emulator from the Android SDK, a Capacitor (or plain Gradle) build, and
// the app's WebView over the DevTools protocol for inspect. Contract: ./provider.mjs; docs/ARCHITECTURE.md
// section 10. Every answer comes from a tool that ran; a missing tool or device is an answer with its reason.
import path from 'node:path';
import { DATA_DIR, folderKey, insideProject, nowIso } from '../paths.mjs';
import { fail } from './provider.mjs';
import { realDeps } from './runner.mjs';
import { resolveTools, resolveAndroidConfig, publicTools, toolEnv, buildSteps } from './android-config.mjs';
import { runs } from '../runs.mjs';
import { pngSize, mapDevicePoint, findDevtoolsSocket, pickPage, socketUrlOn, openCdp, DESCRIBE_FN, VIEW_EXPRESSION, findCandidates, searchRootOf } from './inspect.mjs';

export const BOOT_TIMEOUT_MS = 180000;
export const BUILD_LOG_LINES = 400;

// ---------- parsing adb's answers (pure) ----------

/** `adb devices` -> [{ serial, state, emulator }]; the header and daemon notices are skipped. */
export function parseDevices(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || /^List of devices/i.test(line)) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    out.push({ serial: m[1], state: m[2].trim(), emulator: /^emulator-\d+$/.test(m[1]) });
  }
  return out;
}

/** `adb emu avd name` answers the name, then OK. */
export function parseAvdName(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || /^KO\b/.test(lines[0]) || lines[0] === 'OK') return null;
  return lines[0];
}

/** `pm list packages <id>` lists every package containing the id; installed only on the exact line. */
export const parseInstalled = (text, appId) => String(text || '').split(/\r?\n/).some((l) => l.trim() === `package:${appId}`);

/** `pidof <id>`: the first pid, or null (pidof exits 1 and prints nothing when the app is not running). */
export function parsePid(text) {
  const m = String(text || '').trim().match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The device actions act on: the emulator running the project's AVD, else the first device online. */
export function pickTarget(devices, avd) {
  const online = devices.filter((d) => d.state === 'device');
  return (avd && online.find((d) => d.emulator && d.avd === avd)) || online[0] || null;
}

/**
 * The package in front, from `adb shell dumpsys window`: the mCurrentFocus line, the window that has input
 * focus, e.g. "mCurrentFocus=Window{1a2b u0 com.google.android.apps.nexuslauncher/....NexusLauncherActivity}".
 * Chosen over `dumpsys activity activities`, whose mResumedActivity lines are one per task and display since
 * Android 10, so the first one is not always the screen's; mCurrentFocus is one line in every version up to
 * API 36 as documented (not yet seen on a real API 36 emulator). A focus window with no package/activity (the
 * notification shade, a system dialog) is named by its title. When mCurrentFocus is null, mFocusedApp (an
 * ActivityRecord) gives the package. null when neither line is there.
 */
export function parseFront(text) {
  const s = String(text || '');
  const focus = s.match(/mCurrentFocus=Window\{\S+ \S+ ([^}\s]+)\}/);
  if (focus) return focus[1].split('/')[0];
  const app = s.match(/mFocusedApp=\S*ActivityRecord\{\S+ \S+ ([^\s/}]+)\//);
  return app ? app[1] : null;
}

/** The last n lines of a log's text, without the empty end. */
export function tailLines(text, n = 20) {
  const lines = String(text || '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n);
}

/** Where the emulator's output goes: the studio's data dir, never inside the project. */
export const emulatorLogPath = (projectId, dataDir = DATA_DIR) => (typeof projectId === 'string' && /^[\w-]+$/.test(projectId) ? path.join(dataDir, 'devices', projectId, 'emulator.log') : null);

const firstLine = (...texts) => texts.map((t) => String(t || '').trim()).filter(Boolean).map((t) => t.split(/\r?\n/)[0])[0] || '';

// ---------- input (pure) ----------

export const KEYS = {
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', enter: 'KEYCODE_ENTER', delete: 'KEYCODE_DEL',
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
};
export const TEXT_MAX = 500;

/**
 * `input text` runs in the device's shell: a space is %s, and every shell metacharacter and quote gets a
 * backslash. A "%s" typed as such becomes a space, which input cannot express otherwise.
 */
export function escapeInputText(text) {
  let out = '';
  for (const ch of text) out += ch === ' ' ? '%s' : /[\\'"`$&|;<>()*?~#!\[\]{}^]/.test(ch) ? `\\${ch}` : ch;
  return out;
}

const coord = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000 ? Math.round(v) : null);

/** The arguments after `adb shell` for an input action, or the invalid_input answer. */
export function inputArgs(action) {
  if (!action || typeof action !== 'object') return fail('invalid_input', 'input needs { type, ... }');
  const { type } = action;
  if (type === 'tap') {
    const [x, y] = [coord(action.x), coord(action.y)];
    if (x === null || y === null) return fail('invalid_input', 'tap needs x and y in device pixels (numbers, 0 or more)');
    return { ok: true, args: ['input', 'tap', String(x), String(y)] };
  }
  if (type === 'swipe') {
    const p = ['x', 'y', 'x2', 'y2'].map((k) => coord(action[k]));
    if (p.includes(null)) return fail('invalid_input', 'swipe needs x, y, x2 and y2 in device pixels');
    const ms = action.ms === undefined ? 300 : action.ms;
    if (!Number.isInteger(ms) || ms < 1 || ms > 10000) return fail('invalid_input', 'swipe ms must be an integer 1..10000');
    return { ok: true, args: ['input', 'swipe', ...p.map(String), String(ms)] };
  }
  if (type === 'key') {
    const name = String(action.key ?? '');
    const code = KEYS[name.toLowerCase()] || (Object.values(KEYS).includes(name) ? name : null);
    if (!code) return fail('invalid_input', `key must be one of ${Object.keys(KEYS).join(', ')}`);
    return { ok: true, args: ['input', 'keyevent', code] };
  }
  if (type === 'text') {
    const text = action.text;
    if (typeof text !== 'string' || !text.length) return fail('invalid_input', 'text needs a non-empty string');
    if (/[\r\n]/.test(text)) return fail('invalid_input', 'text cannot hold a newline; send the enter key instead');
    if (text.length > TEXT_MAX) return fail('invalid_input', `text is at most ${TEXT_MAX} characters`);
    if (/[^\x20-\x7e]/.test(text)) return fail('invalid_input', 'adb input text types plain ASCII only (letters, digits, punctuation, spaces)');
    return { ok: true, args: ['input', 'text', escapeInputText(text)] };
  }
  return fail('invalid_input', 'type must be tap, swipe, key or text');
}

// ---------- builds: one at a time per project, kept in memory ----------

const builds = new Map(); // folderKey -> { state, lines, listeners, startedAt, endedAt, step, exitCode, message, steps }

const summary = (rec) => (rec ? { state: rec.state, startedAt: rec.startedAt, endedAt: rec.endedAt, step: rec.step, exitCode: rec.exitCode, message: rec.message, steps: rec.steps } : { state: 'none', note: 'No build since the studio started' });

/** For the log route: the kept lines and live lines after them; null when no build ran. */
export function followBuild(projectPath, { line, end } = {}) {
  const rec = builds.get(folderKey(projectPath));
  if (!rec) return null;
  const listener = { line, end };
  if (rec.state === 'running') rec.listeners.add(listener);
  return { lines: [...rec.lines], ...summary(rec), unsubscribe: () => rec.listeners.delete(listener) };
}

export const buildState = (projectPath) => summary(builds.get(folderKey(projectPath)));

/** Tests only: forget every build record. */
export const resetBuilds = () => builds.clear();

// ---------- the provider ----------

export function createAndroid({ projectPath, projectId = null, dataDir = DATA_DIR, manifest = {}, settings = {}, deps: given = {}, env = process.env, platform = process.platform } = {}) {
  const deps = { ...realDeps, ...given };
  const emulatorLog = emulatorLogPath(projectId, dataDir);
  const logTail = async () => {
    if (!emulatorLog) return [];
    try { return tailLines(await deps.readText(emulatorLog), 20); } catch { return []; }
  };
  let toolsP = null;
  let configP = null;
  const tools = () => (toolsP ||= resolveTools({ projectPath, settings, env, platform, deps }));
  const config = () => (configP ||= resolveAndroidConfig(projectPath, manifest, deps));
  const envFor = async () => toolEnv(await tools(), env, platform);

  async function adb(args, opts = {}) {
    const t = await tools();
    return deps.run(t.adb.command, [...t.adb.lead, ...args], { timeout: 20000, env: await envFor(), ...opts });
  }
  const noAdb = async () => {
    const t = await tools();
    return t.adb.found ? null : fail('tool_missing', t.adb.reason, { tried: t.adb.path });
  };

  /** adb devices, with each emulator's AVD name and each online device's boot state. */
  async function listDevices() {
    const list = await adb(['devices'], { timeout: 15000 });
    if (list.code !== 0) return fail('adb_failed', `adb devices failed: ${firstLine(list.stderr, list.error) || `exit ${list.code}`}`);
    const devices = parseDevices(list.stdout);
    for (const d of devices) {
      if (d.emulator) d.avd = parseAvdName((await adb(['-s', d.serial, 'emu', 'avd', 'name'], { timeout: 10000 })).stdout);
      if (d.state === 'device') {
        const b = await adb(['-s', d.serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 });
        d.booted = b.code === 0 && String(b.stdout).trim() === '1';
      } else d.booted = false;
    }
    return { ok: true, devices };
  }

  async function target() {
    const missing = await noAdb();
    if (missing) return missing;
    const listed = await listDevices();
    if (!listed.ok) return listed;
    const t = pickTarget(listed.devices, (await config()).avd);
    if (!t) return fail('no_device', 'No device online: boot the emulator or connect a phone with USB debugging on', { devices: listed.devices });
    return { ok: true, ...t };
  }

  async function appIdOrFail() {
    const c = await config();
    return c.appId ? null : fail('no_app_id', 'No app id: set devices.android.appId in atelier.json, or add a capacitor.config.json with appId');
  }

  async function status() {
    const [t, c] = await Promise.all([tools(), config()]);
    const base = { ok: true, id: 'android', label: 'Android', tools: publicTools(t), config: c, build: buildState(projectPath), emulatorLog };
    if (!t.adb.found) return { ...base, available: false, reason: t.adb.reason, devices: [], target: null, app: null };
    const listed = await listDevices();
    if (!listed.ok) return { ...base, available: false, reason: listed.message, devices: [], target: null, app: null };
    const tgt = pickTarget(listed.devices, c.avd);
    const app = { appId: c.appId, serial: tgt?.serial || null, installed: null, running: null, pid: null };
    if (c.appId && tgt?.booted) {
      app.installed = parseInstalled((await adb(['-s', tgt.serial, 'shell', 'pm', 'list', 'packages', c.appId])).stdout, c.appId);
      const pid = await adb(['-s', tgt.serial, 'shell', 'pidof', c.appId]);
      app.pid = pid.code === 0 ? parsePid(pid.stdout) : null;
      app.running = app.pid !== null;
    }
    const reason = !listed.devices.length ? 'No device attached' : !tgt ? 'No device online' : !tgt.booted ? `${tgt.serial} is still booting` : null;
    return { ...base, available: true, reason, devices: listed.devices, target: tgt?.serial || null, app };
  }

  /** The emulator serial running `avd`, from adb devices and emu avd name. */
  async function serialOf(avd) {
    const listed = await listDevices();
    return listed.ok ? listed.devices.find((d) => d.emulator && d.avd === avd) || null : null;
  }

  async function boot({ timeoutMs = BOOT_TIMEOUT_MS, pollMs = 2000 } = {}) {
    const [t, c] = await Promise.all([tools(), config()]);
    if (!c.avd) return fail('no_avd', 'No AVD named: set devices.android.avd in atelier.json');
    if (!t.adb.found) return fail('tool_missing', t.adb.reason, { tried: t.adb.path });
    if (!t.emulator.found) return fail('tool_missing', t.emulator.reason, { tried: t.emulator.path });
    const t0 = deps.now();
    const waited = [];
    const after = () => deps.now() - t0;
    const log = emulatorLog;
    let found = await serialOf(c.avd);
    if (found?.booted) return { ok: true, serial: found.serial, already: true, waited, log };
    // The Working now row (server/lib/runs.mjs): a boot is a run from here to boot_completed or its failure.
    const row = runs.start({ kind: 'device', projectId, name: c.avd, latest: found ? `serial up (${found.serial}), waiting for boot_completed` : 'starting the emulator' });
    const ended = (out) => {
      runs.end(row.id, out.ok ? { state: 'Done', latest: `booted ${out.serial}` } : { state: 'Failed', reason: out.message });
      return out;
    };
    try {
      return ended(await waitForBoot(found, { c, t, after, waited, log, timeoutMs, pollMs, row }));
    } catch (err) {
      runs.end(row.id, { state: 'Failed', reason: err.message });
      throw err;
    }
  }

  async function waitForBoot(found, { c, t, after, waited, log, timeoutMs, pollMs, row }) {
    // Started the way the first phone project's Start-Android.ps1 starts it (the run that booted): the script's environment, the
    // output in a log file, a window of its own. The stall of 2026-11-06 is not explained; the log is there so
    // the next one is.
    const handle = found ? null : deps.start(t.emulator.command, [...t.emulator.lead, '-avd', c.avd, '-no-boot-anim'], { cwd: projectPath, env: await envFor(), log, windowsHide: false });
    let serial = found?.serial || null;
    if (serial) waited.push({ for: 'serial', serial, afterMs: 0 });
    while (after() < timeoutMs) {
      const st = handle?.state();
      if (st?.exited) return fail('emulator_exited', `The emulator exited${st.code !== null ? ` with ${st.code}` : ''} before ${c.avd} came up${st.error ? `: ${st.error}` : ''}`, { waited, log, logTail: await logTail() });
      if (!serial) {
        found = await serialOf(c.avd);
        if (found) {
          serial = found.serial;
          waited.push({ for: 'serial', serial, afterMs: after() });
          runs.update(row.id, { latest: `serial up (${serial}), waiting for boot_completed` });
        }
      }
      if (serial) {
        const b = await adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 });
        if (b.code === 0 && String(b.stdout).trim() === '1') {
          waited.push({ for: 'sys.boot_completed = 1', serial, afterMs: after() });
          return { ok: true, serial, already: false, waited, log };
        }
      }
      await deps.sleep(pollMs);
    }
    const what = serial ? `sys.boot_completed = 1 on ${serial}` : `a serial for ${c.avd} in adb devices`;
    return fail('boot_timeout', `Waited ${Math.round(timeoutMs / 1000)} s for ${what}`, { waitedFor: serial ? 'sys.boot_completed' : 'serial', serial, waited, log, logTail: await logTail() });
  }

  /** Not async on purpose: the record exists before the first await, so a second call sees it. */
  function build({ log } = {}) {
    const key = folderKey(projectPath);
    if (builds.get(key)?.state === 'running') return Promise.resolve(fail('build_running', 'A build is already running for this project'));
    const rec = { state: 'running', lines: [], listeners: new Set(), startedAt: nowIso(), endedAt: null, step: null, exitCode: null, message: null, steps: [] };
    builds.set(key, rec);
    // The Working now row (server/lib/runs.mjs): the step in words while it runs, the failed step as the reason.
    const row = runs.start({ kind: 'build', projectId, name: 'Build and install' });
    const say = (line) => {
      rec.lines.push(line);
      if (rec.lines.length > BUILD_LOG_LINES) rec.lines.splice(0, rec.lines.length - BUILD_LOG_LINES);
      try { log?.(line); } catch { /* a caller's log must not stop the build */ }
      for (const l of rec.listeners) { try { l.line?.(line); } catch { /* listener gone */ } }
    };
    const end = (state, message, exitCode = null) => {
      Object.assign(rec, { state, message, exitCode, endedAt: nowIso() });
      say(message);
      for (const l of rec.listeners) { try { l.end?.(summary(rec)); } catch { /* listener gone */ } }
      rec.listeners.clear();
      runs.end(row.id, state === 'ok' ? { state: 'Done', latest: message } : { state: 'Failed', reason: message });
      return state === 'ok' ? { ok: true, steps: rec.steps, message } : fail('build_failed', message, { step: rec.step, exitCode, steps: rec.steps });
    };
    return (async () => {
      try {
        const [t, c] = await Promise.all([tools(), config()]);
        const steps = buildSteps({ config: c, tools: t, projectPath, platform, isFile: deps.isFile });
        const childEnv = await envFor();
        for (const [i, s] of steps.entries()) {
          rec.step = { index: i + 1, of: steps.length, label: s.label };
          runs.update(row.id, { latest: `${i + 1} of ${steps.length} · ${s.label}` });
          say(`> ${s.label}`);
          if (s.missing) return end('failed', `Step ${i + 1} (${s.label}) could not start: ${s.missing}`);
          let args = s.args;
          let command = s.command;
          if (s.adb) {
            const tgt = await target();
            if (!tgt.ok) return end('failed', `Step ${i + 1} (${s.label}) has no device: ${tgt.message}`);
            command = t.adb.command;
            args = [...t.adb.lead, '-s', tgt.serial, ...s.args];
          }
          const started = deps.now();
          const r = await deps.stream(command, args, { cwd: s.cwd, env: childEnv, shell: !!s.shell, onLine: say });
          rec.steps.push({ label: s.label, code: r.code, ms: deps.now() - started });
          if (r.code !== 0) return end('failed', r.code === null ? `Step ${i + 1} (${s.label}) could not run: ${r.error || 'no exit code'}` : `Step ${i + 1} (${s.label}) exited with ${r.code}`, r.code);
        }
        return end('ok', `Build finished: ${steps.length} step${steps.length > 1 ? 's' : ''} passed`, 0);
      } catch (err) {
        return end('failed', `Build stopped: ${err.message}`);
      }
    })();
  }

  async function launch() {
    const c = await config();
    const no = await appIdOrFail();
    if (no) return no;
    const tgt = await target();
    if (!tgt.ok) return tgt;
    const component = `${c.appId}/${c.activity}`;
    const r = await adb(['-s', tgt.serial, 'shell', 'am', 'start', '-n', component]);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0 || /\bError\b|Exception/.test(text)) return fail('launch_failed', `am start ${component}: ${firstLine(text.split(/\r?\n/).find((l) => /Error|Exception/.test(l)), r.stderr, r.error, r.stdout) || `exit ${r.code}`}`, { serial: tgt.serial });
    return { ok: true, serial: tgt.serial, component, output: firstLine(r.stdout) };
  }

  async function stop() {
    const tgt = await target();
    if (!tgt.ok) return tgt;
    if (!tgt.emulator) return fail('cannot_stop', `${tgt.serial} is a phone over USB; the studio cannot switch it off`, { serial: tgt.serial });
    const r = await adb(['-s', tgt.serial, 'emu', 'kill']);
    if (r.code !== 0) return fail('stop_failed', `emu kill on ${tgt.serial}: ${firstLine(r.stderr, r.error, r.stdout) || `exit ${r.code}`}`, { serial: tgt.serial });
    return { ok: true, serial: tgt.serial };
  }

  async function screenshotOn(serial) {
    const r = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 20000 });
    const png = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout || ''), 'binary');
    const size = pngSize(png);
    if (r.code !== 0) return fail('screenshot_failed', `screencap on ${serial}: ${firstLine(r.stderr, r.error) || `exit ${r.code}`}`, { serial });
    if (!size) return fail('screenshot_failed', `screencap on ${serial} did not answer with a PNG`, { serial });
    return { ok: true, serial, png, ...size };
  }

  async function screenshot() {
    const tgt = await target();
    return tgt.ok ? screenshotOn(tgt.serial) : tgt;
  }

  async function input(action) {
    const cmd = inputArgs(action);
    if (!cmd.ok) return cmd;
    const tgt = await target();
    if (!tgt.ok) return tgt;
    const r = await adb(['-s', tgt.serial, 'shell', ...cmd.args]);
    if (r.code !== 0 || /Exception|Error:/.test(String(r.stderr))) return fail('input_failed', `input on ${tgt.serial}: ${firstLine(r.stderr, r.error) || `exit ${r.code}`}`, { serial: tgt.serial });
    return { ok: true, serial: tgt.serial, command: cmd.args.join(' ') };
  }

  async function inspect({ x, y } = {}) {
    const [px, py] = [coord(x), coord(y)];
    if (px === null || py === null) return fail('invalid_input', 'inspect needs x and y in device pixels');
    const no = await appIdOrFail();
    if (no) return no;
    const c = await config();
    const tgt = await target();
    if (!tgt.ok) return tgt;
    const serial = tgt.serial;
    const pidR = await adb(['-s', serial, 'shell', 'pidof', c.appId]);
    const pid = pidR.code === 0 ? parsePid(pidR.stdout) : null;
    if (!pid) return fail('app_not_running', `${c.appId} is not running on ${serial}; launch it first`, { serial });
    // A running app's WebView answers even when another app covers it, so what is in front is asked first.
    // When dumpsys cannot be read the check cannot say, and inspect goes on as before.
    const win = await adb(['-s', serial, 'shell', 'dumpsys', 'window']);
    const front = win.code === 0 ? parseFront(win.stdout) : null;
    if (front && front !== c.appId) return fail('not_in_front', `${c.appId} is not on the screen: ${front} is`, { serial, pid, front });
    const unix = await adb(['-s', serial, 'shell', 'cat', '/proc/net/unix']);
    const socket = findDevtoolsSocket(unix.stdout, pid);
    if (!socket) return fail('no_webview_socket', `No WebView DevTools socket for ${c.appId} (pid ${pid}); a debug build has one once its WebView loads`, { serial, pid });
    const shot = await screenshotOn(serial);
    if (!shot.ok) return shot;
    const fwd = await adb(['-s', serial, 'forward', 'tcp:0', `localabstract:${socket}`]);
    const port = Number.parseInt(String(fwd.stdout).trim(), 10);
    if (fwd.code !== 0 || !Number.isInteger(port) || port <= 0) return fail('forward_failed', `adb forward for ${socket}: ${firstLine(fwd.stderr, fwd.error, fwd.stdout) || `exit ${fwd.code}`}`, { serial, pid });
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) });
      const page = pickPage(await res.json());
      if (!page) return fail('no_page', `The WebView of ${c.appId} lists no page`, { serial, pid });
      const cdp = await openCdp(socketUrlOn(port, page.webSocketDebuggerUrl), deps.WebSocket);
      try {
        const view = await cdp.send('Runtime.evaluate', { expression: VIEW_EXPRESSION, returnByValue: true });
        const v = view.result?.value;
        if (!v || !(v.dpr > 0) || !(v.innerHeight > 0)) return fail('inspect_failed', 'The page did not report devicePixelRatio and innerHeight', { serial, pid });
        const point = mapDevicePoint({ x: px, y: py, dpr: v.dpr, innerHeight: v.innerHeight, screenHeight: shot.height });
        await cdp.send('DOM.getDocument', { depth: 0 });
        const at = await cdp.send('DOM.getNodeForLocation', { x: Math.floor(point.css.x), y: Math.floor(point.css.y) });
        let element = null;
        if (at.backendNodeId) {
          const described = await cdp.send('DOM.describeNode', { backendNodeId: at.backendNodeId });
          const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: at.backendNodeId });
          const info = await cdp.send('Runtime.callFunctionOn', { objectId: resolved.object?.objectId, functionDeclaration: DESCRIBE_FN, returnByValue: true });
          element = info.result?.value ? { ...info.result.value, nodeName: described.node?.nodeName || null } : null;
        }
        const rel = searchRootOf(manifest, c);
        const root = insideProject(projectPath, rel);
        const candidates = element ? await findCandidates({ projectPath, root, element }) : [];
        return { ok: true, serial, pid, page: { url: page.url }, viewport: v, point, element, candidates, searched: rel.split(path.sep).join('/') };
      } finally {
        cdp.close();
      }
    } catch (err) {
      return fail('inspect_failed', err.message, { serial, pid });
    } finally {
      await adb(['-s', serial, 'forward', '--remove', `tcp:${port}`]);
    }
  }

  return {
    id: 'android', label: 'Android',
    status, boot, build, launch, stop, screenshot, input, inspect,
    buildState: () => buildState(projectPath),
    followBuild: (handlers) => followBuild(projectPath, handlers),
  };
}
