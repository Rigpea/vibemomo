// `npm run restart` [--stop | --status]
// Stops only a server proven to be this studio's, three ways: it reports its own pid and
// platform on /api/health, that pid is the listener on the studio port, and the process
// is node. Then starts a fresh detached server and waits for its health answer.
// A pid file alone never authorises a kill: a pid written under WSL means nothing to
// Windows (and can name an unrelated process), and the reverse.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePidFile, listenerPids, processImage, isNodeImage, alive } from '../server/lib/proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ATELIER_PORT || 4747);
const pidFile = path.join(ROOT, '.local', 'server.pid');
const logFile = path.join(ROOT, '.local-server.log');
const mode = process.argv.includes('--stop') ? 'stop' : process.argv.includes('--status') ? 'status' : 'restart';
// Each line carries its time, so .local/restart.log says when a restart ran (and whether one ran after a change).
const log = (m) => console.log(`[restart] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sideName = (platform) => (platform === 'win32' ? 'a Windows terminal' : platform === 'linux' ? 'WSL (or that Linux shell)' : platform);

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { reachable: true, ok: false, status: res.status };
    return { reachable: true, ok: true, ...(await res.json()) };
  } catch (err) {
    return { reachable: false, error: err.cause?.code || err.name || err.message };
  }
}

async function readPidFile() {
  try { return parsePidFile(await fsp.readFile(pidFile, 'utf8')); } catch { return null; }
}

/** Decide what may be stopped: {pid, how} | {none: true} | {refuse: reason}. */
export function chooseTarget(h, pf, listeners, platform = process.platform) {
  if (h.ok && h.pid) {
    if (h.platform && h.platform !== platform) {
      return { refuse: `the studio answering on port ${PORT} runs on ${h.platform} and this script runs on ${platform}; restart it from ${sideName(h.platform)}: cd <studio folder> && npm run restart` };
    }
    if (!listeners.includes(h.pid)) {
      return { refuse: `the server reports pid ${h.pid} but the listener on port ${PORT} is ${listeners.join(', ') || 'not visible'} (a proxy, or another platform); stop it by hand` };
    }
    const image = processImage(h.pid);
    if (!isNodeImage(image)) return { refuse: `pid ${h.pid} is ${image || 'an unknown image'}, not node; stop it by hand` };
    return { pid: h.pid, how: `it answers /api/health with that pid, listens on ${PORT}, image ${image}` };
  }
  if (listeners.length === 0) return { none: true };
  // The port is held but health did not name a pid (older server, or hung): trust the pid file only
  // when it names the listener itself and does not claim another platform. Listener pids come from this
  // platform's own tools, so a WSL pid number that merely collides with one is never a match by itself.
  if (pf && listeners.includes(pf.pid) && (pf.legacy || (pf.platform === platform && (!pf.port || pf.port === PORT)))) {
    const image = processImage(pf.pid);
    if (isNodeImage(image)) return { pid: pf.pid, how: `health did not name it; the ${pf.legacy ? 'legacy pid file' : `pid file (written on ${platform})`} names the node listener on ${PORT}, image ${image}` };
    return { refuse: `pid ${pf.pid} from the pid file listens on ${PORT} but is ${image || 'an unknown image'}, not node` };
  }
  const pfText = !pf ? 'no pid file' : pf.legacy ? `legacy pid file (${pf.pid}, platform unknown)` : `pid file says ${pf.pid} on ${pf.platform}`;
  const inspect = platform === 'win32' ? 'tasklist /FI "PID eq <pid>"' : 'ps -p <pid>';
  return { refuse: `pid ${listeners.join(', ')} holds port ${PORT} but is not verified as this studio's server (${pfText}); check it (${inspect}) and stop it by hand` };
}

async function stopTarget(pid) {
  try { process.kill(pid); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(150);
  if (alive(pid) && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 20 && listenerPids(PORT).includes(pid); i++) await sleep(150);
  return !listenerPids(PORT).includes(pid);
}

async function start() {
  const out = await fsp.open(logFile, 'a');
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, detached: true, stdio: ['ignore', out.fd, out.fd], windowsHide: true });
  child.unref();
  await out.close();
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const h = await health();
    if (h.ok) {
      log(`studio server running: pid ${h.pid}${h.pid === child.pid ? '' : ` (spawned ${child.pid})`} on http://127.0.0.1:${PORT}`);
      return true;
    }
  }
  log(`server not reachable after 6 s; see ${logFile}`);
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const h = await health();
  const pf = await readPidFile();
  const listeners = listenerPids(PORT);
  if (mode === 'status') {
    log(h.ok ? `health: pid ${h.pid} on ${h.platform}, started ${h.startedAt}, version ${h.version}` : h.reachable ? `health: HTTP ${h.status}` : `health: not reachable (${h.error})`);
    log(`pid file: ${pf ? `${pf.pid}${pf.legacy ? ' (legacy, platform unknown)' : ` on ${pf.platform}, started ${pf.startedAt}`}` : 'none'}`);
    log(`listening on ${PORT}: ${listeners.length ? listeners.map((p) => `${p} (${processImage(p) || '?'})`).join(', ') : 'nothing'}`);
    const t = chooseTarget(h, pf, listeners);
    log(t.refuse ? `verdict: would refuse: ${t.refuse}` : t.none ? 'verdict: nothing to stop' : `verdict: would stop pid ${t.pid} (${t.how})`);
    process.exit(0);
  }
  const t = chooseTarget(h, pf, listeners);
  if (t.refuse) {
    log(`refusing to stop anything: ${t.refuse}`);
    process.exit(1);
  }
  if (t.none) {
    log(`nothing listening on port ${PORT}${pf ? ` (pid file ${pf.pid}${pf.legacy ? ', legacy format' : ''} is stale)` : ''}`);
  } else {
    log(`stopping pid ${t.pid}: ${t.how}`);
    const stopped = await stopTarget(t.pid);
    if (!stopped) {
      log(`pid ${t.pid} still holds port ${PORT}; not starting another server`);
      process.exit(1);
    }
    log(`stopped pid ${t.pid}`);
  }
  if (mode === 'stop') process.exit(0);
  process.exit((await start()) ? 0 : 1);
}
