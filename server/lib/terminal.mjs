// Terminal: a real pseudo-terminal on this machine (node-pty; prebuilt ConPTY on Windows) running
// the person's shell in a project folder or the studio. Contract: docs/ARCHITECTURE.md section 8.
// The studio only relays bytes: output over SSE (attach), input and resize over POST.
// Hard rule (same as the console): the child env never contains STUDIO_ANTHROPIC_API_KEY or
// ANTHROPIC_API_KEY. In memory only; nothing here survives a server restart.
import { execFileSync } from 'node:child_process';
import { HttpError, newId, nowIso } from './paths.mjs';
import { strippedEnv } from './console.mjs';
import { shellName } from './runs.mjs';
import { durationWords } from '../../client/components/run-words.js';

export const TERMINAL_LIMIT = 8;
export const SCROLLBACK_MAX = 256 * 1024;
export const INPUT_MAX = 64 * 1024;
const ID_RE = /^term_[a-z0-9]+$/;
// Markers of a host Claude Code session (set when the studio itself was started from one, e.g. by
// `npm run restart` inside Claude Code). Inherited, they make an interactive `claude` typed here
// behave as a nested session; a shell the person opens must look like Windows Terminal instead.
// CLAUDE_CONFIG_DIR is kept: it is the person's own setting (machine env on this computer).
const HOST_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|CLAUDE_CODE_(SESSION_.*|SDK_.*|ENTRYPOINT|SIMPLE|STARTUP_.*|TERMINAL_.*|USER_EMAIL))$/i;

/** The shell's env: the console's stripped env (no API keys) without host-session markers. */
export function terminalEnv(env, { projectId = null, studioDir = '' } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(strippedEnv(env))) if (!HOST_SESSION_ENV.test(k)) out[k] = v;
  out.ATELIER_PROJECT = projectId || '';
  out.ATELIER_STUDIO = studioDir;
  if (!out.COLORTERM) out.COLORTERM = 'truecolor';
  return out;
}

let ptyModule = null;
let ptyError = null;
/** Lazy import so the studio runs (without terminals) when node-pty cannot load. */
export async function loadPty() {
  if (ptyModule) return ptyModule;
  if (ptyError) throw ptyError;
  try {
    const m = await import('node-pty');
    ptyModule = m.default && typeof m.default.spawn === 'function' ? m.default : m;
    return ptyModule;
  } catch (err) {
    ptyError = new HttpError(503, 'terminal_unavailable', `node-pty could not be loaded: ${err.message}`);
    throw ptyError;
  }
}

let defaultShellCache = null;
/** pwsh.exe if `where pwsh` finds it, else powershell.exe (Windows); $SHELL or /bin/bash elsewhere. */
export function defaultShell(env = process.env) {
  if (process.platform !== 'win32') return env.SHELL || '/bin/bash';
  if (defaultShellCache) return defaultShellCache;
  try {
    execFileSync('where', ['pwsh'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 3000 });
    defaultShellCache = 'pwsh.exe';
  } catch {
    defaultShellCache = 'powershell.exe';
  }
  return defaultShellCache;
}

const shellArgs = (shell) => (/(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shell) ? ['-NoLogo'] : []);

function checkSize(cols, rows) {
  const ok = (n) => Number.isInteger(n) && n >= 2 && n <= 500;
  if (!ok(cols) || !ok(rows)) throw new HttpError(400, 'invalid_input', 'cols and rows must be integers 2..500');
}

export function createTerminals({ studioDir, loadProject, env = process.env, emit, limit = TERMINAL_LIMIT, runs: registry = null } = {}) {
  if (!studioDir) throw new Error('createTerminals: studioDir is required');
  const terms = new Map(); // id -> { id, pty, cwd, shell, pid, projectId, createdAt, scrollback, exited, exitCode, clients:Set<res> }
  const send = (type, payload) => { try { emit?.(type, payload); } catch { /* events must never break a terminal */ } };
  const get = (id) => {
    const t = ID_RE.test(String(id)) ? terms.get(id) : null;
    if (!t) throw new HttpError(404, 'not_found', `Terminal ${id} not found`);
    return t;
  };
  const sse = (res, text) => { try { res.write(text); } catch { /* client went away */ } };
  const info = (t) => ({
    id: t.id, cwd: t.cwd, shell: t.shell, pid: t.pid, projectId: t.projectId, createdAt: t.createdAt,
    ...(t.exited ? { exited: true, exitCode: t.exitCode } : {}),
  });

  async function open({ projectId = null, cols = 100, rows = 30, shell = null } = {}) {
    cols = Number(cols); rows = Number(rows);
    checkSize(cols, rows);
    if (shell !== null && shell !== undefined && (typeof shell !== 'string' || !shell.trim() || shell.length > 260)) {
      throw new HttpError(400, 'invalid_input', 'shell must be a non-empty string');
    }
    if (terms.size >= limit) throw new HttpError(409, 'terminal_limit', `At most ${limit} terminals can be open; close one first`);
    const pty = await loadPty();
    const cwd = projectId ? (await loadProject(projectId)).path : studioDir;
    if (terms.size >= limit) throw new HttpError(409, 'terminal_limit', `At most ${limit} terminals can be open; close one first`);
    const childEnv = terminalEnv(env, { projectId, studioDir });
    const spawnWith = (sh) => pty.spawn(sh, shellArgs(sh), { name: 'xterm-256color', cols, rows, cwd, env: childEnv, useConpty: true });
    let chosen = shell ? shell.trim() : defaultShell(env);
    let p;
    try {
      p = spawnWith(chosen);
    } catch (err) {
      if (shell || process.platform !== 'win32' || chosen === 'powershell.exe') throw new HttpError(500, 'terminal_spawn_failed', `Could not start ${chosen}: ${err.message}`);
      chosen = 'powershell.exe'; // pwsh was found but would not start: fall back once
      p = spawnWith(chosen);
    }
    const t = { id: newId('term'), pty: p, cwd, shell: chosen, pid: p.pid, projectId: projectId || null, createdAt: nowIso(), scrollback: '', exited: false, exitCode: null, clients: new Set() };
    terms.set(t.id, t);
    p.onData((d) => {
      t.scrollback += d;
      if (t.scrollback.length > SCROLLBACK_MAX) t.scrollback = t.scrollback.slice(-SCROLLBACK_MAX);
      const line = `data: ${JSON.stringify({ d })}\n\n`;
      for (const res of t.clients) sse(res, line);
    });
    p.onExit(({ exitCode }) => {
      t.exited = true;
      t.exitCode = typeof exitCode === 'number' ? exitCode : null;
      const line = `event: exit\ndata: ${JSON.stringify({ code: t.exitCode })}\n\n`;
      for (const res of t.clients) sse(res, line);
      send('terminal.changed', { id: t.id, exited: true, exitCode: t.exitCode });
      // The shell ended by itself (exit typed, or it crashed): its row is Stopped with the exit code.
      registry?.end(t.id, { state: 'Stopped', reason: t.exitCode === null ? 'exited' : `exit code ${t.exitCode}`, latest: `exited after ${durationWords(Date.now() - Date.parse(t.createdAt))}` });
    });
    send('terminal.changed', { id: t.id, opened: true });
    registry?.start({ id: t.id, kind: 'terminal', projectId: t.projectId, name: shellName(chosen) });
    return info(t);
  }

  function write(id, data) {
    const t = get(id);
    if (typeof data !== 'string') throw new HttpError(400, 'invalid_input', 'data must be a string');
    if (data.length > INPUT_MAX) throw new HttpError(400, 'invalid_input', `data must be at most ${INPUT_MAX} characters`);
    if (t.exited) throw new HttpError(409, 'terminal_exited', `Terminal ${id} has exited`);
    t.pty.write(data);
    return { ok: true };
  }

  function resize(id, cols, rows) {
    const t = get(id);
    checkSize(cols, rows);
    if (!t.exited) {
      try { t.pty.resize(cols, rows); } catch (err) { throw new HttpError(409, 'terminal_exited', `Resize failed: ${err.message}`); }
    }
    return { ok: true, cols, rows };
  }

  function close(id) {
    const t = get(id);
    terms.delete(id);
    // Closed by the person; a shell that had already exited keeps the end it reported (a second end changes nothing).
    registry?.end(id, { state: 'Stopped', reason: 'closed', latest: `closed after ${durationWords(Date.now() - Date.parse(t.createdAt))}` });
    // Always kill, even after the shell exited by itself: node-pty only releases its ConPTY
    // handles (and lets the process exit) on kill().
    // On Windows end the whole process tree first (claude or a dev server started in the shell),
    // because node-pty's own console-list helper cannot always attach to a closing ConPTY.
    if (!t.exited && process.platform === 'win32' && t.pid) {
      try { execFileSync('taskkill', ['/PID', String(t.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch { /* already gone */ }
    }
    try { t.pty.kill(); } catch { /* already gone */ }
    for (const res of t.clients) { try { res.end(); } catch { /* ignore */ } }
    t.clients.clear();
    send('terminal.changed', { id, closed: true });
    return { closed: id };
  }

  const list = () => [...terms.values()].map(info);

  /** SSE: the scrollback first (one event, replay: true), then each chunk; `event: exit` when the shell ends. */
  function attach(id, res) {
    const t = get(id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // replay: true lets the client ignore its own answers to old terminal queries (DA, cursor
    // position, focus) contained in the scrollback, so a reattach never types into the shell.
    if (t.scrollback) sse(res, `data: ${JSON.stringify({ d: t.scrollback, replay: true })}\n\n`);
    if (t.exited) sse(res, `event: exit\ndata: ${JSON.stringify({ code: t.exitCode })}\n\n`);
    t.clients.add(res);
    const ping = setInterval(() => sse(res, ': ping\n\n'), 25000);
    ping.unref?.();
    res.on('close', () => { clearInterval(ping); t.clients.delete(res); });
  }

  function closeAll() {
    for (const id of [...terms.keys()]) { try { close(id); } catch { /* keep going */ } }
  }

  return { open, write, resize, close, list, attach, closeAll };
}
