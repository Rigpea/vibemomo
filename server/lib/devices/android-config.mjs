// Where the Android tools are and what the project says about its app: resolved from studio settings,
// the project's own tool file and atelier.json, with what was inferred named. No tool runs here.
import path from 'node:path';
import { strippedEnv } from '../console.mjs';
import { realDeps, splitCommand, onPath } from './runner.mjs';

export const DEFAULT_ACTIVITY = '.MainActivity';
export const DEFAULT_APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
export const TOOL_KEYS = ['sdkRoot', 'javaHome', 'nodeRoot'];
export const TOOL_FILE = path.join('.local', 'android-tools.json');

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const exe = (platform, name) => (platform === 'win32' ? `${name}.exe` : name);

async function readJsonFile(file, deps) {
  try {
    const value = JSON.parse(await deps.readText(file));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * One tool: an override from the environment (a path, or a command line split into command and leading
 * arguments, as the tests use "node fake-adb.mjs"), else <sdkRoot>/<sub>/<name>(.exe).
 * { command, lead, path, found, source, reason } where path is what was tried.
 */
export function resolveTool(name, { override, sdkRoot, sdkSource, sub, platform, env, deps }) {
  if (str(override)) {
    if (deps.isFile(override.trim())) return { command: override.trim(), lead: [], path: override.trim(), found: true, source: 'env', reason: null };
    const [command, ...lead] = splitCommand(override);
    const found = !!onPath(command, { env, platform, exists: deps.isFile });
    return { command, lead, path: override.trim(), found, source: 'env', reason: found ? null : `${name} not found: ${command} (from the environment)` };
  }
  if (!sdkRoot) return { command: null, lead: [], path: null, found: false, source: null, reason: `${name} not found: no Android SDK folder set (Settings › Devices › SDK folder)` };
  const p = path.join(sdkRoot, sub, exe(platform, name));
  const found = deps.isFile(p);
  return { command: p, lead: [], path: p, found, source: sdkSource, reason: found ? null : `${name} not found at ${p}` };
}

/**
 * Tool folders: studio settings first, then the project's .local/android-tools.json for any left empty,
 * then ANDROID_SDK_ROOT / ANDROID_HOME for the SDK. ATELIER_ADB and ATELIER_EMULATOR override the tools.
 */
export async function resolveTools({ projectPath = null, settings = {}, env = process.env, platform = process.platform, deps = realDeps } = {}) {
  const set = settings?.devices?.android || {};
  const file = projectPath ? (await readJsonFile(path.join(projectPath, TOOL_FILE), deps)) || {} : {};
  const values = {};
  const sources = {};
  for (const k of TOOL_KEYS) {
    if (str(set[k])) { values[k] = str(set[k]); sources[k] = 'settings'; }
    else if (str(file[k])) { values[k] = str(file[k]); sources[k] = 'project'; }
    else { values[k] = null; sources[k] = null; }
  }
  if (!values.sdkRoot && str(env.ANDROID_SDK_ROOT || env.ANDROID_HOME)) {
    values.sdkRoot = str(env.ANDROID_SDK_ROOT || env.ANDROID_HOME);
    sources.sdkRoot = 'env';
  }
  const common = { sdkRoot: values.sdkRoot, sdkSource: sources.sdkRoot, platform, env, deps };
  return {
    ...values,
    sources,
    adb: resolveTool('adb', { ...common, override: env.ATELIER_ADB, sub: 'platform-tools' }),
    emulator: resolveTool('emulator', { ...common, override: env.ATELIER_EMULATOR, sub: 'emulator' }),
  };
}

/** What the routes and settings show: the paths tried and what was found, without the runner's split. */
export function publicTools(tools) {
  const one = ({ path: p, found, source, reason }) => ({ path: p, found, source, reason });
  return { sdkRoot: tools.sdkRoot, javaHome: tools.javaHome, nodeRoot: tools.nodeRoot, sources: tools.sources, adb: one(tools.adb), emulator: one(tools.emulator) };
}

/**
 * The project's Android config: atelier.json devices.android { avd, appId, activity, build, apk }, with appId and
 * webDir from capacitor.config.json when atelier.json leaves them out. `inferred` names what came from Capacitor,
 * `defaults` what came from the studio's defaults.
 */
export async function resolveAndroidConfig(projectPath, manifest = {}, deps = realDeps) {
  const own = manifest?.devices?.android && typeof manifest.devices.android === 'object' ? manifest.devices.android : {};
  const capFile = path.join(projectPath, 'capacitor.config.json');
  const hasCap = deps.isFile(capFile);
  const cap = hasCap ? (await readJsonFile(capFile, deps)) || {} : {};
  const inferred = [];
  const defaults = [];
  let appId = str(own.appId);
  if (!appId && str(cap.appId)) { appId = str(cap.appId); inferred.push('appId'); }
  let webDir = str(own.webDir);
  if (!webDir && str(cap.webDir)) { webDir = str(cap.webDir); inferred.push('webDir'); }
  const activity = str(own.activity) || (defaults.push('activity'), DEFAULT_ACTIVITY);
  const apk = str(own.apk) || (defaults.push('apk'), DEFAULT_APK);
  const build = str(own.build);
  if (!build) defaults.push('build');
  return {
    avd: str(own.avd), appId, activity, apk, build, webDir,
    capacitor: hasCap, androidFolder: deps.isDir(path.join(projectPath, 'android')),
    inferred, defaults,
  };
}

/** Does Android apply: an android/ folder, a capacitor.config.json or devices.android in atelier.json. */
export function androidApplies(projectPath, manifest = {}, deps = realDeps) {
  return deps.isDir(path.join(projectPath, 'android')) || deps.isFile(path.join(projectPath, 'capacitor.config.json')) || !!(manifest?.devices?.android && typeof manifest.devices.android === 'object');
}

/**
 * The env for adb, the emulator and build steps, as the first phone project's Start-Android.ps1 sets it before it starts the
 * emulator: no API keys; PATH with platform-tools, emulator and the Node folder first (the settings' Node
 * folder, else the folder of the node running the studio), then the JDK's bin; ANDROID_HOME and
 * ANDROID_SDK_ROOT to the SDK folder and JAVA_HOME to the JDK when they are known. What the studio does not
 * know (a JAVA_HOME of the environment, say) passes through as it is.
 */
export function toolEnv(tools, env = process.env, platform = process.platform, execPath = process.execPath) {
  const out = strippedEnv(env);
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  const nodeDir = tools.nodeRoot || (execPath ? path.dirname(execPath) : null);
  const extra = [
    tools.sdkRoot ? path.join(tools.sdkRoot, 'platform-tools') : null,
    tools.sdkRoot ? path.join(tools.sdkRoot, 'emulator') : null,
    nodeDir, tools.nodeRoot && platform !== 'win32' ? path.join(tools.nodeRoot, 'bin') : null,
    tools.javaHome ? path.join(tools.javaHome, 'bin') : null,
  ].filter(Boolean);
  out[key] = [...extra, out[key]].filter(Boolean).join(sep);
  if (tools.javaHome) out.JAVA_HOME = tools.javaHome;
  if (tools.sdkRoot) { out.ANDROID_HOME = tools.sdkRoot; out.ANDROID_SDK_ROOT = tools.sdkRoot; }
  return out;
}

/** node and npm's npx-cli.js under a Node folder, so npx runs without a shell; null when not there. */
function npxUnder(root, platform, isFile) {
  if (!root) return null;
  const nodes = platform === 'win32' ? [path.join(root, 'node.exe')] : [path.join(root, 'bin', 'node'), path.join(root, 'node')];
  const clis = [path.join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js'), path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')];
  const node = nodes.find(isFile);
  const cli = clis.find(isFile);
  return node && cli ? { node, cli } : null;
}

/**
 * The build as steps, in order. A project's own build line runs alone through the system shell in its folder.
 * The generic steps: npx cap sync android (Capacitor projects only), gradlew assembleDebug --console=plain in
 * android/, adb install -r <apk>. A step with `adb: true` gets adb's leading args and -s <serial> at run time.
 * The Gradle wrapper runs by its absolute path with cwd android/: named bare through cmd.exe it was "not
 * recognized" on the first phone project (2026-11-06). On Windows it is a .bat, which only a shell runs (Node refuses to spawn a
 * .bat without one), so that step is one quoted command line through the shell; its words are fixed, nothing
 * from input reaches it. Elsewhere ./gradlew runs without a shell.
 */
export function buildSteps({ config, tools, projectPath, platform = process.platform, isFile = realDeps.isFile, execPath = process.execPath }) {
  if (config.build) return [{ label: config.build, command: config.build, args: [], shell: true, cwd: projectPath }];
  const steps = [];
  if (config.capacitor) {
    const npx = npxUnder(tools.nodeRoot, platform, isFile) || (!tools.nodeRoot ? npxUnder(path.dirname(execPath), platform, isFile) : null);
    const sync = ['cap', 'sync', 'android'];
    steps.push({
      label: 'npx cap sync android', cwd: projectPath,
      ...(npx ? { command: npx.node, args: [npx.cli, ...sync] } : platform === 'win32' ? { command: 'cmd.exe', args: ['/d', '/c', 'npx', ...sync] } : { command: 'npx', args: sync }),
    });
  }
  const androidDir = path.join(projectPath, 'android');
  const wrapper = path.join(androidDir, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const gradleArgs = ['assembleDebug', '--console=plain'];
  steps.push({
    label: 'gradlew assembleDebug --console=plain', cwd: androidDir,
    ...(platform === 'win32' ? { command: `"${wrapper}" ${gradleArgs.join(' ')}`, args: [], shell: true } : { command: wrapper, args: gradleArgs }),
    missing: isFile(wrapper) ? null : `no Gradle wrapper at ${wrapper} (npx cap add android makes one)`,
  });
  steps.push({ label: `adb install -r ${config.apk}`, cwd: projectPath, adb: true, command: tools.adb.command, args: ['install', '-r', path.resolve(projectPath, config.apk)], missing: tools.adb.found ? null : tools.adb.reason });
  return steps;
}
