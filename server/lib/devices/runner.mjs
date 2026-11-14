// The real runner behind the device providers. Providers take a deps object with the same shape, so the
// tests pass a fake and nothing here ever runs under test. No shell: execFile/spawn with an argument list,
// except stream(..., { shell: true }) for a project's own build command line and the Windows Gradle wrapper.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Run to the end. Never rejects: { code, stdout, stderr, error }; code is null when the tool did not start or timed out. */
function run(command, args = [], { timeout = 20000, cwd, env, encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout, cwd, env, encoding, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: String(stderr ?? ''), error: err && code === null ? (err.killed ? `timed out after ${timeout / 1000} s` : err.message) : null });
      });
    } catch (err) {
      resolve({ code: null, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: '', error: err.message });
    }
  });
}

/**
 * Start and leave running (the emulator), detached and unref'd. With `log`, stdout and stderr are appended to
 * that file (its folder is made), after a line naming the time and the command, as Start-Android.ps1 redirects
 * the emulator's output to a file instead of dropping it. windowsHide is false by default: the emulator is a
 * window. state() says whether it has exited, and how.
 */
function start(command, args = [], { cwd, env, log = null, windowsHide = false } = {}) {
  const st = { exited: false, code: null, error: null };
  let fd = null;
  try {
    if (log) {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fd = fs.openSync(log, 'a');
      fs.writeSync(fd, `\n--- ${new Date().toISOString()} ${command} ${args.join(' ')}\n`);
    }
    const child = spawn(command, args, { cwd, env, detached: true, windowsHide, stdio: fd === null ? 'ignore' : ['ignore', fd, fd] });
    child.on('error', (err) => { st.exited = true; st.error = err.message; });
    child.on('exit', (code) => { st.exited = true; st.code = code; });
    child.unref();
    return { pid: child.pid ?? null, state: () => ({ ...st }) };
  } catch (err) {
    return { pid: null, state: () => ({ exited: true, code: null, error: err.message }) };
  } finally {
    // The child holds its own copy of the handle; the studio's is closed at once.
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** Run with every output line passed to onLine as it comes. Never rejects: { code, error }. */
function stream(command, args = [], { cwd, env, shell = false, onLine } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const done = (out) => { if (!settled) { settled = true; resolve(out); } };
    try {
      child = spawn(command, args, { cwd, env, shell, windowsHide: true });
    } catch (err) {
      return done({ code: null, error: err.message });
    }
    const lines = (s) => {
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        for (const l of parts) onLine?.(l);
      });
      s.on('end', () => { if (buf) onLine?.(buf); buf = ''; });
    };
    lines(child.stdout);
    lines(child.stderr);
    let error = null;
    child.on('error', (err) => { error = err.message; done({ code: null, error }); });
    child.on('close', (code) => done({ code, error }));
  });
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export const realDeps = {
  run,
  start,
  stream,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  isFile,
  isDir,
  readText: (p) => fsp.readFile(p, 'utf8'),
  fetch: (...a) => globalThis.fetch(...a),
  WebSocket: globalThis.WebSocket,
};

/** "node C:\x\fake-adb.mjs" -> ['node', 'C:\x\fake-adb.mjs']; double or single quotes keep spaces in one token. */
export function splitCommand(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(text ?? '').trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
  }
  if (started || cur) out.push(cur);
  return out;
}

/** A bare command name looked up on PATH (with PATHEXT on Windows); a path is checked as it is. */
export function onPath(name, { env = process.env, platform = process.platform, exists = isFile } = {}) {
  if (!name) return null;
  if (/[\\/]/.test(name)) return exists(name) ? name : null;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((x) => x.toLowerCase())] : [''];
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String((key && env[key]) || '').split(sep).filter(Boolean)) {
    for (const x of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + x);
      if (exists(p)) return p;
    }
  }
  return null;
}
