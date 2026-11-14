// The iOS provider, as an honest stub: the iPhone simulator (xcrun simctl) runs only on macOS, so on this
// machine every method says so. Nothing here imitates a phone. A Mac provider replaces this file later.
import path from 'node:path';
import fs from 'node:fs';
import { fail } from './provider.mjs';

export const NEEDS_MAC = 'The iPhone simulator runs only on macOS; connect a Mac to use it.';
const NOT_BUILT = 'This studio has only the iOS stub; the macOS provider is not built yet.';

/** platform is injectable for the tests; on a Mac the stub still cannot drive anything, and says that instead. */
export function createIos({ projectPath, manifest = {}, platform = process.platform } = {}) {
  const onMac = platform === 'darwin';
  const code = onMac ? 'not_built' : 'needs_mac';
  const message = onMac ? NOT_BUILT : NEEDS_MAC;
  const no = async () => fail(code, message);
  return {
    id: 'ios',
    label: 'iPhone',
    async status() {
      const setUp = !!projectPath && fs.existsSync(path.join(projectPath, 'ios'));
      return {
        ok: true, id: 'ios', label: 'iPhone', available: false, code, reason: message,
        projectSetUp: setUp,
        note: setUp ? 'The project is set up for iOS (it has an ios/ folder).' : manifest.devices?.ios ? 'atelier.json names devices.ios, but the project has no ios/ folder yet.' : null,
      };
    },
    boot: no, build: no, launch: no, stop: no, screenshot: no, input: no, inspect: no,
  };
}
