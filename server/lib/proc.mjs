// Process facts about the studio's own server: the pid-file shape, who listens on a
// port, and what a pid is. Pure lookups (no killing); used by scripts/restart.mjs and
// the tests. A pid alone never identifies the studio: this workspace is used from WSL
// and from Windows, and a pid written on one side can name an unrelated process on the other.
import { execFileSync } from 'node:child_process';

/**
 * Parse `.local/server.pid`. New shape: JSON {pid, platform, port, startedAt} written by
 * the server. A bare number is the legacy shape: `legacy: true` and nothing else is known.
 * Returns null when the text is not a pid at all.
 */
export function parsePidFile(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { return null; }
    const pid = Number(j.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, platform: j.platform || null, port: Number(j.port) || null, startedAt: j.startedAt || null, legacy: false };
  }
  const pid = Number(t);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, platform: null, port: null, startedAt: null, legacy: true };
}

export function pidFileContent({ pid, port, startedAt }) {
  return `${JSON.stringify({ pid, platform: process.platform, port, startedAt }, null, 2)}\n`;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 });
  } catch {
    return '';
  }
}

/** PIDs of processes listening on TCP <port> (any address). Empty when nothing listens or no tool answered. */
export function listenerPids(port) {
  const pids = new Set();
  const tail = new RegExp(`:${port}(\\s|$)`);
  if (process.platform === 'win32') {
    for (const line of run('netstat', ['-ano', '-p', 'tcp']).split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING' || !tail.test(cols[1])) continue;
      const pid = Number(cols[4]);
      if (pid > 0) pids.add(pid);
    }
    return [...pids];
  }
  const ss = run('ss', ['-ltnpH']);
  if (ss.trim()) {
    for (const line of ss.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || !tail.test(cols[3])) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
    }
    if (pids.size) return [...pids];
  }
  for (const l of run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n')) {
    const pid = Number(l.trim());
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Executable name of a pid ("node.exe", "node", "python3", …) or null when unknown. */
export function processImage(pid) {
  if (process.platform === 'win32') {
    const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1] : null;
  }
  const out = run('ps', ['-p', String(pid), '-o', 'comm=']).trim();
  return out ? out.split('/').pop() : null;
}

export const isNodeImage = (image) => /^node(js)?(\.exe)?$/i.test(String(image || '').trim());

/** True when a process with this pid exists (a process we may not signal still counts). */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
