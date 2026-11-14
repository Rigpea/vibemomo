// Device providers with a fake runner: nothing here starts adb, the emulator or a build.
// The inspect test talks to a fake DevTools endpoint (tests/fixtures/fake-cdp.mjs) over a real WebSocket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAndroid, parseDevices, parseAvdName, parsePid, parseInstalled, parseFront, tailLines, inputArgs, escapeInputText, resetBuilds } from '../server/lib/devices/android.mjs';
import { DEFAULT_APK, resolveTools, buildSteps } from '../server/lib/devices/android-config.mjs';
import { mapDevicePoint, findCandidates, pngSize, findDevtoolsSocket } from '../server/lib/devices/inspect.mjs';
import { createIos, NEEDS_MAC } from '../server/lib/devices/ios.mjs';
import { providersFor, devicesFor } from '../server/lib/devices/index.mjs';
import { implementsContract, PROVIDER_METHODS } from '../server/lib/devices/provider.mjs';
import { splitCommand } from '../server/lib/devices/runner.mjs';
import { tinyPng } from './fixtures/fake-adb.mjs';
import { startFakeCdp } from './fixtures/fake-cdp.mjs';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-devices-'));
after(() => fsp.rm(tmp, { recursive: true, force: true }));
let n = 0;
const newFolder = async () => { const p = path.join(tmp, `p${++n}`); await fsp.mkdir(p, { recursive: true }); return p; };

const SDK = path.join(tmp, 'sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const EMULATOR = path.join(SDK, 'emulator', 'emulator.exe');
const settings = { devices: { android: { sdkRoot: SDK } } };

/** The adb answers of a phone set-up: an emulator running the AVD and a phone that is offline. */
function adbAnswers(args, state = {}) {
  let rest = args;
  let serial = null;
  if (rest[0] === '-s') { serial = rest[1]; rest = rest.slice(2); }
  const line = rest.join(' ');
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  if (line === 'devices') return ok(state.devices ?? 'List of devices attached\nemulator-5554\tdevice\nR58N1234\toffline\n\n');
  if (line === 'emu avd name') return serial.startsWith('emulator') ? ok('Harbor_Pixel_7\r\nOK\r\n') : { code: 1, stdout: '', stderr: 'KO' };
  if (line === 'shell getprop sys.boot_completed') return ok(state.booted ?? '1\n');
  if (rest[1] === 'pm') return ok('package:com.example.harbor\npackage:com.example.harbor.test\n');
  if (rest[1] === 'pidof') return state.running === false ? { code: 1, stdout: '', stderr: '' } : ok('4242\n');
  if (rest[1] === 'input') return ok('');
  if (line === 'shell dumpsys window') return ok(`  mCurrentFocus=Window{5e1c2a u0 ${state.front ?? 'com.example.harbor'}/com.x.MainActivity}\n`);
  if (rest[1] === 'cat') return ok('00000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_4242\n');
  if (line === 'exec-out screencap -p') return { code: 0, stdout: tinyPng(10, 20), stderr: '' };
  if (rest[0] === 'forward' && rest[1] === '--remove') return ok('');
  if (rest[0] === 'forward') return ok(`${state.port}\n`);
  if (line === 'emu kill') return ok('OK');
  if (rest[1] === 'am') return ok(`Starting: Intent { cmp=${rest[4]} }`);
  return { code: 1, stdout: '', stderr: `no answer for ${line}` };
}

function fakeDeps({ files = [ADB, EMULATOR], dirs = [], texts = {}, state = {}, stream } = {}) {
  const calls = [];
  const fileSet = new Set(files);
  let clock = 0;
  const deps = {
    run: async (command, args, opts) => { calls.push({ command, args, opts }); return adbAnswers(args, typeof state === 'function' ? state() : state); },
    isFile: (p) => fileSet.has(p) || Object.hasOwn(texts, p),
    isDir: (p) => dirs.includes(p),
    readText: async (p) => { if (Object.hasOwn(texts, p)) return texts[p]; throw new Error('ENOENT'); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    start: (command, args, opts) => { calls.push({ start: true, command, args, opts }); return { pid: 1, state: () => ({ exited: false, code: null, error: null }) }; },
    stream: stream || (async () => ({ code: 0, error: null })),
  };
  return { calls, deps };
}

const capConfig = (folder) => ({ [path.join(folder, 'capacitor.config.json')]: JSON.stringify({ appId: 'com.example.harbor', webDir: 'dist' }) });

test('adb answers parse: two devices with one offline, the AVD name, pid and packages', () => {
  assert.deepEqual(parseDevices('* daemon started successfully\nList of devices attached\nemulator-5554\tdevice\nR58N1234\toffline\n\n'), [
    { serial: 'emulator-5554', state: 'device', emulator: true },
    { serial: 'R58N1234', state: 'offline', emulator: false },
  ]);
  assert.equal(parseAvdName('Harbor_Pixel_7\r\nOK\r\n'), 'Harbor_Pixel_7');
  assert.equal(parseAvdName('KO: unknown command'), null);
  assert.equal(parsePid('4242\n'), 4242);
  assert.equal(parsePid(''), null);
  assert.equal(parseInstalled('package:com.x.app.test\npackage:com.x.app\n', 'com.x.app'), true);
  assert.equal(parseInstalled('package:com.x.app.test\n', 'com.x.app'), false);
  assert.deepEqual(splitCommand('node "C:\\a b\\fake-adb.mjs" --x'), ['node', 'C:\\a b\\fake-adb.mjs', '--x']);
});

test('status: devices with AVD name and boot state, the target, installed and running, the inferred appId', async () => {
  const folder = await newFolder();
  const { deps, calls } = fakeDeps({ texts: capConfig(folder) });
  const android = createAndroid({ projectPath: folder, manifest: { devices: { android: { avd: 'Harbor_Pixel_7' } } }, settings, deps, env: {}, platform: 'win32' });
  assert.ok(implementsContract(android));
  const st = await android.status();
  assert.equal(st.ok, true);
  assert.equal(st.available, true);
  assert.equal(st.tools.adb.path, ADB);
  assert.equal(st.tools.adb.source, 'settings');
  assert.deepEqual(st.devices, [
    { serial: 'emulator-5554', state: 'device', emulator: true, avd: 'Harbor_Pixel_7', booted: true },
    { serial: 'R58N1234', state: 'offline', emulator: false, booted: false },
  ]);
  assert.equal(st.target, 'emulator-5554');
  assert.deepEqual(st.app, { appId: 'com.example.harbor', serial: 'emulator-5554', installed: true, running: true, pid: 4242 });
  assert.equal(st.config.activity, '.MainActivity');
  assert.equal(st.config.apk, DEFAULT_APK);
  assert.deepEqual(st.config.inferred, ['appId', 'webDir']);
  assert.equal(st.build.state, 'none');
  assert.ok(calls.every((c) => c.command === ADB), 'every call goes to the adb that was found');
  assert.ok(!calls.some((c) => c.args.includes('R58N1234') && c.args.includes('getprop')), 'an offline device is not asked for its boot state');
});

test('status without adb says so with the path tried; the project tool file fills an empty setting', async () => {
  const folder = await newFolder();
  const { deps } = fakeDeps({ files: [], texts: capConfig(folder) });
  const st = await createAndroid({ projectPath: folder, settings: {}, deps, env: {}, platform: 'win32' }).status();
  assert.equal(st.available, false);
  assert.match(st.reason, /no Android SDK folder set/);
  const own = path.join(tmp, 'own-sdk');
  const { deps: d2 } = fakeDeps({ files: [], texts: { [path.join(folder, '.local', 'android-tools.json')]: JSON.stringify({ sdkRoot: own, javaHome: 'C:\\jdk' }) } });
  const tools = await resolveTools({ projectPath: folder, settings: { devices: { android: { sdkRoot: '', javaHome: 'C:\\mine' } } }, env: {}, platform: 'win32', deps: d2 });
  assert.equal(tools.sdkRoot, own);
  assert.equal(tools.sources.sdkRoot, 'project');
  assert.equal(tools.javaHome, 'C:\\mine');
  assert.equal(tools.sources.javaHome, 'settings');
  assert.equal(tools.adb.found, false);
  assert.equal(tools.adb.reason, `adb not found at ${path.join(own, 'platform-tools', 'adb.exe')}`);
});

test('input: commands composed from the action, text escaped for the device shell, bad input refused', async () => {
  assert.deepEqual(inputArgs({ type: 'tap', x: 10.4, y: 20 }).args, ['input', 'tap', '10', '20']);
  assert.deepEqual(inputArgs({ type: 'swipe', x: 1, y: 2, x2: 3, y2: 4 }).args, ['input', 'swipe', '1', '2', '3', '4', '300']);
  assert.deepEqual(inputArgs({ type: 'key', key: 'back' }).args, ['input', 'keyevent', 'KEYCODE_BACK']);
  assert.deepEqual(inputArgs({ type: 'key', key: 'delete' }).args, ['input', 'keyevent', 'KEYCODE_DEL']);
  assert.equal(inputArgs({ type: 'key', key: 'power' }).code, 'invalid_input');
  assert.equal(escapeInputText(`it's a $5 deal; ok`), "it\\'s%sa%s\\$5%sdeal\\;%sok");
  assert.equal(escapeInputText('a"b&c|d(e)`f'), 'a\\"b\\&c\\|d\\(e\\)\\`f');
  assert.deepEqual(inputArgs({ type: 'text', text: 'hi there' }).args, ['input', 'text', 'hi%sthere']);
  assert.equal(inputArgs({ type: 'text', text: 'two\nlines' }).code, 'invalid_input');
  assert.equal(inputArgs({ type: 'tap', x: -1, y: 2 }).code, 'invalid_input');
  assert.equal(inputArgs({ type: 'pinch' }).code, 'invalid_input');
  const folder = await newFolder();
  const { deps, calls } = fakeDeps({ texts: capConfig(folder) });
  const out = await createAndroid({ projectPath: folder, settings, deps, env: {}, platform: 'win32' }).input({ type: 'tap', x: 5, y: 6 });
  assert.equal(out.ok, true);
  assert.deepEqual(calls.at(-1).args, ['-s', 'emulator-5554', 'shell', 'input', 'tap', '5', '6']);
});

test('inspect mapping: dpr 2.75 with inset 0 and with inset 132', () => {
  assert.deepEqual(mapDevicePoint({ x: 550, y: 1100, dpr: 2.75, innerHeight: 873, screenHeight: 2400 }), { device: { x: 550, y: 1100 }, dpr: 2.75, inset: 0, screenHeight: 2400, css: { x: 200, y: 400 } });
  assert.deepEqual(mapDevicePoint({ x: 275, y: 1232, dpr: 2.75, innerHeight: 824, screenHeight: 2398 }), { device: { x: 275, y: 1232 }, dpr: 2.75, inset: 132, screenHeight: 2398, css: { x: 100, y: 400 } });
  assert.equal(mapDevicePoint({ x: 0, y: 50, dpr: 2.75, innerHeight: 824, screenHeight: 2398 }).css.y, 0, 'a point in the status bar maps to the top');
  assert.deepEqual(pngSize(tinyPng(10, 20)), { width: 10, height: 20 });
  assert.equal(pngSize(Buffer.from('not a png at all, really not')), null);
  assert.equal(findDevtoolsSocket('0: 1 @webview_devtools_remote_41\n0: 1 @webview_devtools_remote_4242\n', 4242), 'webview_devtools_remote_4242');
  assert.equal(findDevtoolsSocket('0: 1 @webview_devtools_remote_42420\n', 4242), null);
});

test('file candidates: lines with the id, classes and text, most matched first, at most eight', async () => {
  const folder = await newFolder();
  const web = path.join(folder, 'dist', 'welcome');
  await fsp.mkdir(path.join(web, 'node_modules'), { recursive: true });
  await fsp.writeFile(path.join(web, 'index.html'), '<main>\n  <button id="start" class="btn primary">Start the\n  round now</button>\n  <button class="btn">Start   the round now please</button>\n</main>\n');
  await fsp.writeFile(path.join(web, 'app.js'), "const b = document.querySelector('#start');\nconst restart = 'start-over';\n");
  await fsp.writeFile(path.join(web, 'node_modules', 'x.js'), 'start btn primary');
  // Only the first six words are searched: the seventh, "Later", is in no file.
  const element = { id: 'start', classes: ['btn', 'primary'], text: 'Start the round now please, friend Later' };
  await fsp.writeFile(path.join(web, 'index.html'), '<main>\n  <button id="start" class="btn primary">Start the\n  round now</button>\n  <button class="btn">Start   the round now please, friend</button>\n</main>\n');
  const found = await findCandidates({ projectPath: folder, root: web, element });
  assert.deepEqual(found, [
    { file: 'dist/welcome/index.html', line: 2, matched: ['start', 'btn', 'primary'] },
    { file: 'dist/welcome/index.html', line: 4, matched: ['btn', 'Start the round now please, friend'] },
    { file: 'dist/welcome/app.js', line: 1, matched: ['start'] },
  ]);
  const many = Array.from({ length: 12 }, (_, i) => `<i class="btn">${i}</i>`).join('\n');
  await fsp.writeFile(path.join(web, 'many.html'), many);
  assert.equal((await findCandidates({ projectPath: folder, root: web, element: { classes: ['btn'] } })).length, 8);
});

test('build: the generic steps in order, the log streamed, and a failing step named with its exit code', async () => {
  resetBuilds();
  const folder = await newFolder();
  const nodeRoot = path.join(tmp, 'node');
  const cli = path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const ran = [];
  let failGradle = false;
  const isGradle = (command) => /gradlew/.test(command);
  const stream = async (command, args, { cwd, shell, onLine }) => {
    ran.push({ command, args, cwd, shell });
    onLine(`out of ${isGradle(command) ? 'gradle' : command === ADB ? 'adb' : 'npx'}`);
    return { code: failGradle && isGradle(command) ? 1 : 0, error: null };
  };
  const wrapper = path.join(folder, 'android', 'gradlew.bat');
  const { deps } = fakeDeps({ files: [ADB, EMULATOR, path.join(nodeRoot, 'node.exe'), cli, wrapper], texts: capConfig(folder), stream });
  const make = () => createAndroid({ projectPath: folder, settings: { devices: { android: { sdkRoot: SDK, nodeRoot } } }, deps, env: {}, platform: 'win32' });
  const log = [];
  const ok = await make().build({ log: (l) => log.push(l) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // The wrapper by its absolute path from android/: named bare it was "not recognized" on the first phone project (2026-11-06).
  assert.deepEqual(ran.map((r) => [r.command, r.args, r.cwd, !!r.shell]), [
    [path.join(nodeRoot, 'node.exe'), [cli, 'cap', 'sync', 'android'], folder, false],
    [`"${wrapper}" assembleDebug --console=plain`, [], path.join(folder, 'android'), true],
    [ADB, ['-s', 'emulator-5554', 'install', '-r', path.resolve(folder, DEFAULT_APK)], folder, false],
  ]);
  assert.ok(path.isAbsolute(wrapper), 'the wrapper is named by an absolute path');
  assert.deepEqual(log.slice(0, 2), ['> npx cap sync android', 'out of npx']);
  assert.equal(make().buildState().state, 'ok');

  ran.length = 0;
  failGradle = true;
  const failed = await make().build({});
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'build_failed');
  assert.equal(failed.message, 'Step 2 (gradlew assembleDebug --console=plain) exited with 1');
  assert.equal(failed.exitCode, 1);
  assert.equal(ran.length, 2, 'install does not run after a failed step');
  const state = make().buildState();
  assert.equal(state.state, 'failed');
  assert.deepEqual(state.step, { index: 2, of: 3, label: 'gradlew assembleDebug --console=plain' });
});

test('build steps off Windows run ./gradlew by its path without a shell; a missing wrapper stops step 2 with its path', async () => {
  const folder = path.join(tmp, 'linux-project');
  const tools = { nodeRoot: null, adb: { command: '/sdk/platform-tools/adb', found: true } };
  const config = { capacitor: false, apk: DEFAULT_APK, build: null };
  const wrapper = path.join(folder, 'android', 'gradlew');
  const steps = buildSteps({ config, tools, projectPath: folder, platform: 'linux', isFile: (p) => p === wrapper });
  assert.deepEqual(steps.map((s) => [s.label, s.command, s.args, s.cwd, !!s.shell, s.missing ?? null]), [
    ['gradlew assembleDebug --console=plain', wrapper, ['assembleDebug', '--console=plain'], path.join(folder, 'android'), false, null],
    [`adb install -r ${DEFAULT_APK}`, '/sdk/platform-tools/adb', ['install', '-r', path.resolve(folder, DEFAULT_APK)], folder, false, null],
  ]);
  const none = buildSteps({ config, tools, projectPath: folder, platform: 'win32', isFile: () => false });
  assert.equal(none[0].missing, `no Gradle wrapper at ${path.join(folder, 'android', 'gradlew.bat')} (npx cap add android makes one)`);

  resetBuilds();
  const p = await newFolder();
  const ran = [];
  const { deps } = fakeDeps({ texts: capConfig(p), stream: async (command) => { ran.push(command); return { code: 0, error: null }; } });
  const out = await createAndroid({ projectPath: p, settings, deps, env: {}, platform: 'win32' }).build({});
  assert.equal(out.code, 'build_failed');
  assert.equal(out.message, `Step 2 (gradlew assembleDebug --console=plain) could not start: no Gradle wrapper at ${path.join(p, 'android', 'gradlew.bat')} (npx cap add android makes one)`);
  assert.equal(ran.length, 1, 'only the sync ran');
});

test('build: one at a time per project; a project build line runs alone through the shell', async () => {
  resetBuilds();
  const folder = await newFolder();
  let release;
  const ran = [];
  const stream = (command, args, opts) => { ran.push({ command, opts }); return new Promise((r) => { release = () => r({ code: 0, error: null }); }); };
  const { deps } = fakeDeps({ texts: capConfig(folder), stream });
  const manifest = { devices: { android: { build: 'powershell -NoProfile -ExecutionPolicy Bypass -File Start-Android.ps1 -Build' } } };
  const make = () => createAndroid({ projectPath: folder, manifest, settings, deps, env: {}, platform: 'win32' });
  const first = make().build({});
  const second = await make().build({});
  assert.equal(second.code, 'build_running');
  await new Promise((r) => setTimeout(r, 20));
  release();
  assert.equal((await first).ok, true);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].command, manifest.devices.android.build);
  assert.equal(ran[0].opts.shell, true);
  assert.equal(ran[0].opts.cwd, folder);
});

test('boot starts the AVD and waits for its serial, then sys.boot_completed = 1', async () => {
  const folder = await newFolder();
  let polls = 0;
  const state = () => {
    polls++;
    if (polls < 3) return { devices: 'List of devices attached\n\n' };
    return { devices: 'List of devices attached\nemulator-5554\tdevice\n', booted: polls < 12 ? '0\n' : '1\n' };
  };
  const { deps, calls } = fakeDeps({ texts: capConfig(folder), state });
  const dataDir = path.join(tmp, 'data');
  const log = path.join(dataDir, 'devices', 'p_boot1', 'emulator.log');
  const nodeRoot = path.join(tmp, 'node-boot');
  const javaHome = path.join(tmp, 'jdk');
  const mine = { devices: { android: { sdkRoot: SDK, nodeRoot, javaHome } } };
  const env = { Path: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', STUDIO_ANTHROPIC_API_KEY: 'sk-secret' };
  const make = (d, manifest = { devices: { android: { avd: 'Harbor_Pixel_7' } } }) => createAndroid({ projectPath: folder, projectId: 'p_boot1', dataDir, manifest, settings: mine, deps: d, env, platform: 'win32' });
  const out = await make(deps).boot();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.serial, 'emulator-5554');
  assert.equal(out.log, log, 'the boot answer names the log');
  assert.deepEqual(out.waited.map((w) => w.for), ['serial', 'sys.boot_completed = 1']);
  const started = calls.find((c) => c.start);
  assert.deepEqual([started.command, started.args], [EMULATOR, ['-avd', 'Harbor_Pixel_7', '-no-boot-anim']]);
  // Started as Start-Android.ps1 starts it: its output to the log under the data dir, a window, the script's env.
  assert.equal(started.opts.log, log);
  assert.ok(!started.opts.log.startsWith(folder), 'never inside the project');
  assert.equal(started.opts.windowsHide, false);
  const e = started.opts.env;
  assert.equal(e.ANDROID_HOME, SDK);
  assert.equal(e.ANDROID_SDK_ROOT, SDK);
  assert.equal(e.JAVA_HOME, javaHome);
  assert.equal(e.STUDIO_ANTHROPIC_API_KEY, undefined, 'no API key reaches the emulator');
  assert.deepEqual(e.Path.split(';'), [path.join(SDK, 'platform-tools'), path.join(SDK, 'emulator'), nodeRoot, path.join(javaHome, 'bin'), 'C:\\Windows\\system32']);
  assert.equal(e.SystemRoot, 'C:\\Windows');
  const st = await make(deps).status();
  assert.equal(st.emulatorLog, log, 'status names the log');
  assert.equal((await make(deps, {}).boot()).code, 'no_avd');

  // A boot that times out carries the log's last 20 lines.
  const printed = Array.from({ length: 30 }, (_, i) => `emulator line ${i + 1}`).join('\r\n') + '\r\n\r\n';
  const { deps: never, calls: neverCalls } = fakeDeps({ texts: { ...capConfig(folder), [log]: printed }, state: { devices: 'List of devices attached\n\n' } });
  const timedOut = await make(never).boot();
  assert.equal(timedOut.code, 'boot_timeout');
  assert.equal(timedOut.waitedFor, 'serial');
  assert.equal(timedOut.log, log);
  assert.equal(timedOut.logTail.length, 20);
  assert.deepEqual([timedOut.logTail[0], timedOut.logTail[19]], ['emulator line 11', 'emulator line 30']);
  assert.equal(neverCalls.find((c) => c.start).opts.log, log);
  // No project id (a caller outside the routes): no log is named, and the timeout's tail is empty.
  const { deps: bare } = fakeDeps({ texts: capConfig(folder), state: { devices: 'List of devices attached\n\n' } });
  const noId = await createAndroid({ projectPath: folder, manifest: { devices: { android: { avd: 'Harbor_Pixel_7' } } }, settings, deps: bare, env: {}, platform: 'win32' }).boot();
  assert.deepEqual([noId.log, noId.logTail], [null, []]);
  assert.deepEqual(tailLines('a\nb\n\n', 1), ['b']);
});

test('the real start() appends the child\'s stdout and stderr to the log after a line naming the command', async () => {
  const { realDeps } = await import('../server/lib/devices/runner.mjs');
  const log = path.join(tmp, 'data-real', 'devices', 'p_x', 'emulator.log');
  const args = ['-e', 'console.log("to stdout"); console.error("to stderr")'];
  for (let round = 0; round < 2; round++) {
    // windowsHide only here: a test run must not flash a console window.
    const h = realDeps.start(process.execPath, args, { log, windowsHide: true });
    for (let i = 0; i < 200 && !h.state().exited; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.state().code, 0);
  }
  const text = await fsp.readFile(log, 'utf8');
  assert.equal(text.match(/^--- \S+ .+ -e /gm).length, 2, 'two starts, two header lines: appended');
  assert.equal(text.match(/^to stdout\r?$/gm).length, 2, 'the header line names the script too, so whole lines are counted');
  assert.equal(text.match(/^to stderr\r?$/gm).length, 2);
});

test('stop kills an emulator, says a USB phone cannot be stopped; launch runs am start', async () => {
  const folder = await newFolder();
  const { deps, calls } = fakeDeps({ texts: capConfig(folder) });
  const android = createAndroid({ projectPath: folder, settings, deps, env: {}, platform: 'win32' });
  assert.equal((await android.stop()).ok, true);
  assert.deepEqual(calls.at(-1).args, ['-s', 'emulator-5554', 'emu', 'kill']);
  const launched = await android.launch();
  assert.equal(launched.ok, true);
  assert.deepEqual(calls.at(-1).args, ['-s', 'emulator-5554', 'shell', 'am', 'start', '-n', 'com.example.harbor/.MainActivity']);
  const { deps: usb } = fakeDeps({ texts: capConfig(folder), state: { devices: 'List of devices attached\nR58N1234\tdevice\n' } });
  const out = await createAndroid({ projectPath: folder, settings, deps: usb, env: {}, platform: 'win32' }).stop();
  assert.equal(out.code, 'cannot_stop');
});

test('inspect: device point to element and file candidates over a fake DevTools socket; the forward is removed', async () => {
  const cdp = await startFakeCdp();
  try {
    const folder = await newFolder();
    await fsp.mkdir(path.join(folder, 'src'));
    await fsp.writeFile(path.join(folder, 'src', 'index.html'), '<button id="start" class="btn primary">Start the round now</button>\n');
    const { deps, calls } = fakeDeps({ texts: capConfig(folder), state: { port: cdp.port } });
    const android = createAndroid({ projectPath: folder, manifest: { entry: 'src/index.html' }, settings, deps: { ...deps, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket }, env: {}, platform: 'win32' });
    const out = await android.inspect({ x: 5, y: 12 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.point, { device: { x: 5, y: 12 }, dpr: 1, inset: 2, screenHeight: 20, css: { x: 5, y: 10 } });
    assert.equal(out.element.id, 'start');
    assert.equal(out.element.nodeName, 'BUTTON');
    assert.equal(out.page.url, 'https://localhost/#/start');
    assert.equal(out.searched, 'src');
    assert.deepEqual(out.candidates, [{ file: 'src/index.html', line: 1, matched: ['start', 'btn', 'primary', 'Start the round now'] }]);
    assert.deepEqual(cdp.received.find((m) => m.method === 'DOM.getNodeForLocation').params, { x: 5, y: 10 });
    assert.deepEqual(calls.at(-1).args, ['-s', 'emulator-5554', 'forward', '--remove', `tcp:${cdp.port}`]);
    assert.ok(calls.some((c) => c.args.join(' ') === '-s emulator-5554 shell dumpsys window'), 'what is in front was asked');
    const { deps: stopped } = fakeDeps({ texts: capConfig(folder), state: { running: false } });
    assert.equal((await createAndroid({ projectPath: folder, settings, deps: stopped, env: {}, platform: 'win32' }).inspect({ x: 1, y: 1 })).code, 'app_not_running');
  } finally {
    await cdp.close();
  }
});

test('inspect with another app in front says so and reads no WebView', async () => {
  const folder = await newFolder();
  const launcher = 'com.google.android.apps.nexuslauncher';
  const { deps, calls } = fakeDeps({ texts: capConfig(folder), state: { front: launcher } });
  const out = await createAndroid({ projectPath: folder, settings, deps, env: {}, platform: 'win32' }).inspect({ x: 5, y: 12 });
  assert.deepEqual([out.ok, out.code, out.message], [false, 'not_in_front', `com.example.harbor is not on the screen: ${launcher} is`]);
  assert.equal(out.front, launcher);
  assert.ok(!calls.some((c) => c.args.includes('forward') || c.args.includes('cat')), 'no socket looked up and no port forwarded');
  const { readoutState } = await import('../workbenches/phone/map.js');
  assert.deepEqual(readoutState(out), { found: false, title: `com.example.harbor is not on the screen: ${launcher} is` });
});

test('parseFront reads mCurrentFocus, a titled system window, and mFocusedApp when the focus is null; the fake adb answers both ways', () => {
  assert.equal(parseFront('  mCurrentFocus=Window{5e1c2a u0 com.example.harbor/com.example.harbor.MainActivity}\n'), 'com.example.harbor');
  assert.equal(parseFront('  mCurrentFocus=Window{77aa u0 NotificationShade}\n'), 'NotificationShade');
  assert.equal(parseFront('  mCurrentFocus=null\n  mFocusedApp=ActivityRecord{9f3b11 u0 com.x.app/.MainActivity t7}\n'), 'com.x.app');
  assert.equal(parseFront('nothing useful'), null);
  const fake = fileURLToPath(new URL('./fixtures/fake-adb.mjs', import.meta.url));
  const ask = (front) => execFileSync(process.execPath, [fake, '-s', 'emulator-5554', 'shell', 'dumpsys', 'window'], { encoding: 'utf8', env: { ...process.env, FAKE_ADB_FRONT: front } });
  assert.equal(parseFront(ask('')), 'com.example.probe', 'the app is in front by default');
  assert.equal(parseFront(ask('com.google.android.apps.nexuslauncher')), 'com.google.android.apps.nexuslauncher');
});

test('iOS is an honest stub: every method needs a Mac, status says whether the project is set up', async () => {
  const folder = await newFolder();
  await fsp.mkdir(path.join(folder, 'ios'));
  const ios = createIos({ projectPath: folder, platform: 'win32' });
  assert.ok(implementsContract(ios));
  for (const m of PROVIDER_METHODS.filter((x) => x !== 'status')) assert.deepEqual(await ios[m]({}), { ok: false, code: 'needs_mac', message: NEEDS_MAC });
  const st = await ios.status();
  assert.equal(st.available, false);
  assert.equal(st.reason, NEEDS_MAC);
  assert.equal(st.projectSetUp, true);
});

test('providersFor and devicesFor: Capacitor gives Android, ios/ gives iOS, a plain folder gives none', async () => {
  const plain = await newFolder();
  assert.deepEqual(await providersFor(plain, {}, {}), []);
  assert.deepEqual(await devicesFor(plain, {}), {});
  const cap = await newFolder();
  await fsp.writeFile(path.join(cap, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.app', webDir: 'www' }));
  await fsp.mkdir(path.join(cap, 'ios'));
  assert.deepEqual((await providersFor(cap, {}, {})).map((p) => p.id), ['android', 'ios']);
  const devices = await devicesFor(cap, {});
  assert.equal(devices.android.appId, 'com.example.app');
  assert.equal(devices.android.webDir, 'www');
  assert.equal(devices.ios.projectSetUp, true);
  assert.deepEqual(Object.keys(await devicesFor(plain, { devices: { android: { appId: 'x.y' } } })), ['android']);
});

test('the dock shows the Phone tab only when manifest.devices has a key', async () => {
  const { panelKinds } = await import('../client/components/dock.js');
  assert.deepEqual(panelKinds({ kind: 'web-app', devices: { android: { appId: 'x.y' } } }, { phone: true }), ['companion', 'codex', 'page', 'source', 'terminal', 'web-app', 'phone']);
  assert.deepEqual(panelKinds({ kind: 'web-app', devices: { android: { appId: 'x.y' } } }), ['companion', 'codex', 'page', 'source', 'terminal', 'web-app'], 'no Phone tab unless the studio setting asks (decision row 125)');
  assert.deepEqual(panelKinds({ kind: 'web-app', devices: {} }), ['companion', 'codex', 'page', 'source', 'terminal', 'web-app']);
  assert.deepEqual(panelKinds({ kind: 'web-app' }), ['companion', 'codex', 'page', 'source', 'terminal', 'web-app']);
});
