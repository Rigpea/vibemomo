// Concrete risk: `npm run restart` must identify the studio's own server and nothing
// else. These pin the pid-file shapes and the port/process lookups it relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parsePidFile, pidFileContent, listenerPids, processImage, isNodeImage, alive } from '../server/lib/proc.mjs';

test('pid file: a bare number is legacy and unverified; JSON carries platform and port', () => {
  assert.deepEqual(parsePidFile('53268\n'), { pid: 53268, platform: null, port: null, startedAt: null, legacy: true });
  const json = pidFileContent({ pid: 41, port: 4747, startedAt: '2026-11-04T00:00:00.000Z' });
  assert.deepEqual(parsePidFile(json), { pid: 41, platform: process.platform, port: 4747, startedAt: '2026-11-04T00:00:00.000Z', legacy: false });
  assert.equal(parsePidFile(''), null);
  assert.equal(parsePidFile('not a pid'), null);
  assert.equal(parsePidFile('{"pid":"x"}'), null);
  assert.equal(parsePidFile('{broken'), null);
});

test('listenerPids names this process on a port it holds; processImage says node', async (t) => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const pids = listenerPids(port);
    if (pids.length === 0 && process.platform !== 'win32') { t.skip('no ss/lsof available'); return; }
    assert.ok(pids.includes(process.pid), `expected ${process.pid} in ${pids}`);
    assert.ok(isNodeImage(processImage(process.pid)), `image ${processImage(process.pid)}`);
    assert.equal(alive(process.pid), true);
  } finally {
    srv.close();
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!listenerPids(port).includes(process.pid), 'port released after close');
});

test('restart refuses pids it cannot verify', async () => {
  const { chooseTarget } = await import('../scripts/restart.mjs');
  const win = { ok: true, pid: 10, platform: 'win32' };
  assert.match(chooseTarget(win, null, [10], 'linux').refuse, /runs on win32/);
  assert.match(chooseTarget(win, null, [11], 'win32').refuse, /listener on port/);
  assert.deepEqual(chooseTarget({ reachable: false }, null, [], 'win32'), { none: true });
  assert.match(chooseTarget({ reachable: false }, { pid: 12, platform: 'linux', legacy: false }, [12], 'win32').refuse, /not verified/);
  assert.match(chooseTarget({ reachable: false }, { pid: 12, legacy: true }, [13], 'win32').refuse, /legacy pid file/);
  assert.match(chooseTarget({ reachable: false }, null, [13], 'win32').refuse, /no pid file/);
  // A pid file naming the node listener itself is enough when health cannot name a pid (this process is node).
  const mine = chooseTarget({ reachable: false }, { pid: process.pid, legacy: true }, [process.pid], process.platform);
  assert.equal(mine.pid, process.pid);
  assert.match(mine.how, /legacy pid file/);
});
