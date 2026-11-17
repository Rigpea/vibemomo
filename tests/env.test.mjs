// A fresh checkout must honor .env before any module captures paths or the port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-env-'));
  try {
    const studio = path.join(root, 'studio');
    for (const relative of ['server/lib/paths.mjs', 'client/components/release-notes.js', 'server/lib/env.cjs']) {
      const destination = path.join(studio, relative);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(path.join(ROOT, relative), destination);
    }
    await fsp.writeFile(path.join(studio, 'package.json'), '{"type":"module"}');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('ATELIER_') && !['NODE_TEST_CONTEXT', 'STUDIO_ANTHROPIC_API_KEY', 'NODE_OPTIONS'].includes(key)));
    const read = (overrides = {}) => {
      const url = pathToFileURL(path.join(studio, 'server/lib/paths.mjs')).href;
      const code = `import { PORT, DATA_DIR, PROJECTS_DIR } from ${JSON.stringify(url)}; console.log(JSON.stringify({ PORT, DATA_DIR, PROJECTS_DIR }));`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    await run({ root, studio, read });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('.env beside the studio supplies paths and port even from another working directory', async () => {
  await fixture(async ({ root, studio, read }) => {
    const data = path.join(root, 'custom data');
    const projects = path.join(root, 'custom projects');
    await fsp.writeFile(path.join(studio, '.env'), `ATELIER_PORT=4955\nATELIER_DATA_DIR='${data}'\nATELIER_PROJECTS_DIR='${projects}'\n`);
    assert.deepEqual(read(), { PORT: 4955, DATA_DIR: data, PROJECTS_DIR: projects });
    const shellData = path.join(root, 'shell data');
    assert.deepEqual(read({ ATELIER_PORT: '4956', ATELIER_DATA_DIR: shellData }), {
      PORT: 4956, DATA_DIR: shellData, PROJECTS_DIR: projects,
    });
  });
});

test('a checkout without .env uses the normal defaults', async () => {
  await fixture(async ({ root, read }) => {
    assert.deepEqual(read(), { PORT: 4747, DATA_DIR: path.join(os.homedir(), '.atelier'), PROJECTS_DIR: root });
  });
});
