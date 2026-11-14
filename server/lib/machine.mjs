// What this computer is: CPU, memory, OS and GPU names, for Settings "This machine" and the
// desktop app. Collected once per process (the hardware does not change under a running
// server); `?refresh=1` collects again. Never throws: a probe that fails leaves its field partial.
import os from 'node:os';
import { execFile } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5000;

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    } catch {
      resolve('');
    }
  });
}

const lines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function powershell(command) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
}

async function physicalCores(threads) {
  if (process.platform === 'win32') {
    const n = lines(await powershell('Get-CimInstance Win32_Processor | Select-Object -ExpandProperty NumberOfCores'))
      .map(Number)
      .filter((x) => Number.isInteger(x) && x > 0)
      .reduce((a, b) => a + b, 0);
    if (n > 0) return n;
  }
  return threads;
}

async function gpuNames() {
  if (process.platform === 'win32') {
    return lines(await powershell('Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'));
  }
  if (process.platform === 'darwin') {
    return lines(await run('system_profiler', ['SPDisplaysDataType']))
      .filter((l) => l.startsWith('Chipset Model:'))
      .map((l) => l.slice('Chipset Model:'.length).trim());
  }
  return lines(await run('lspci', []))
    .filter((l) => /VGA compatible controller|3D controller|Display controller/i.test(l))
    .map((l) => l.replace(/^.*?(VGA compatible controller|3D controller|Display controller):\s*/i, ''));
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

export async function collectMachine() {
  const cpus = safe(() => os.cpus(), []) || [];
  const threads = cpus.length;
  const [cores, gpus] = await Promise.all([
    physicalCores(threads).catch(() => threads),
    gpuNames().catch(() => []),
  ]);
  const totalMem = safe(() => os.totalmem(), 0);
  return {
    cpu: { model: (cpus[0]?.model || '').trim() || null, cores: cores || null, threads: threads || null },
    memoryGb: totalMem ? Math.round((totalMem / 1024 ** 3) * 10) / 10 : null,
    arch: safe(() => os.arch(), process.arch),
    os: { name: safe(() => os.type(), null), version: safe(() => os.version(), null) || safe(() => os.release(), null) },
    gpus: [...new Set(gpus)],
    node: process.version,
    platform: process.platform,
    collectedAt: new Date().toISOString(),
  };
}

let cached = null;
/** Cached per process; `refresh` collects again. */
export function machineInfo({ refresh = false } = {}) {
  if (refresh || !cached) {
    const p = collectMachine();
    cached = p;
    p.catch(() => { if (cached === p) cached = null; });
  }
  return cached;
}
