// Which device providers apply to a project, and what the bundle's manifest says about them.
// Android: an android/ folder, a capacitor.config.json or devices.android in atelier.json.
// iOS: an ios/ folder or devices.ios in atelier.json (an honest stub off macOS).
import path from 'node:path';
import { realDeps } from './runner.mjs';
import { createAndroid } from './android.mjs';
import { createIos } from './ios.mjs';
import { androidApplies, resolveAndroidConfig } from './android-config.mjs';
import { implementsContract, PROVIDER_IDS } from './provider.mjs';

export { PROVIDER_IDS };

const iosApplies = (projectPath, manifest, deps) => deps.isDir(path.join(projectPath, 'ios')) || !!(manifest?.devices?.ios && typeof manifest.devices.ios === 'object');

/**
 * The providers for a project, Android first. `options` carries the project id (the emulator log's folder under
 * the data dir) and deps, env and platform for the tests.
 */
export async function providersFor(projectPath, manifest = {}, settings = {}, { projectId = null, deps = {}, env = process.env, platform = process.platform } = {}) {
  const d = { ...realDeps, ...deps };
  const out = [];
  if (androidApplies(projectPath, manifest, d)) out.push(createAndroid({ projectPath, projectId, manifest, settings, deps: d, env, platform }));
  if (iosApplies(projectPath, manifest, d)) out.push(createIos({ projectPath, manifest, platform }));
  for (const p of out) if (!implementsContract(p)) throw new Error(`Device provider ${p?.id} does not implement the contract`);
  return out;
}

/**
 * manifest.devices for the bundle, inferred like the entry is: { android?: resolved config, ios?: { projectSetUp } }.
 * A key is there only when that provider applies, so `Object.keys(devices).length` says whether to show the panel.
 */
export async function devicesFor(projectPath, manifest = {}, deps = realDeps) {
  const devices = {};
  if (androidApplies(projectPath, manifest, deps)) devices.android = await resolveAndroidConfig(projectPath, manifest, deps);
  if (iosApplies(projectPath, manifest, deps)) devices.ios = { ...(manifest?.devices?.ios && typeof manifest.devices.ios === 'object' ? manifest.devices.ios : {}), projectSetUp: deps.isDir(path.join(projectPath, 'ios')) };
  return devices;
}
