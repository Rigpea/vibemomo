// npm run check names the cause of a failing test file, from the real reporter's output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { failureLines } from '../scripts/test-failures.mjs';

test('a failing before hook: its message is shown and the passes of other files are not', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-check-'));
  try {
    await fsp.writeFile(path.join(dir, 'a.test.mjs'), "import { test } from 'node:test';\ntest('a pass worth no line', () => {});\n");
    await fsp.writeFile(path.join(dir, 'b.test.mjs'), "import { test, before } from 'node:test';\nbefore(() => { throw new Error('server did not start on port 1'); });\ntest('needs the server', () => {});\n");
    // Inside a test run the child would otherwise report in the runner's own binary format.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const r = spawnSync(process.execPath, ['--test', dir], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0);
    const shown = failureLines(r.stdout, r.stderr).join('\n');
    assert.match(shown, /server did not start on port 1/);
    assert.ok(!shown.includes('a pass worth no line'), shown);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('with no failing part: everything but passes and counts, stderr too; a long output is cut and says so', () => {
  assert.deepEqual(failureLines('✔ fine (1ms)\nkilled here\nℹ tests 1\n', 'and why\n'), ['killed here', '', 'and why']);
  assert.deepEqual(failureLines('\u001b[31m✖ failing tests:\u001b[0m\nboom\n'), ['✖ failing tests:', 'boom']);
  const cut = failureLines(`✖ failing tests:\n${'x\n'.repeat(10)}`, '', { limit: 3 });
  assert.deepEqual(cut, ['✖ failing tests:', 'x', 'x', '… 8 more lines']);
});
