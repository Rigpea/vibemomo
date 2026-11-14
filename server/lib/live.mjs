// Live: a project's own local server, declared in its atelier.json and shown in the Workbench preview instead of the
// static /preview/ files. Contract: docs/ARCHITECTURE.md section 20. Opt-in on both sides: the project declares
// live { label, command[], cwd }, and nothing runs until the person allowed that exact command and cwd and pressed
// the switch. One process per project, in memory only; restarts are the person's, never automatic.
//
// Security rules (the brief's, kept here so a change sees them):
//  - argv without a shell (spawn with shell false; a .cmd/.bat is refused because Windows would run it through cmd);
//  - cwd inside the project (insideProject, so not .git or .studio either);
//  - the ready line's URL is http on 127.0.0.1 or localhost with a port, nothing else;
//  - consent is keyed to the folder, the exact argv and the cwd, kept in the studio's data folder, not the project's;
//  - the URL's fragment (the token) is masked in the log and in every answer; only GET /live/<id> hands it on, as a
//    302 to the Workbench frame;
//  - the process tree goes on off, on project close (another project activated, or the project removed) and on quit.
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { HttpError, insideProject, folderKey, nowIso } from './paths.mjs';
import { readJson, writeJson } from './fsutil.mjs';
import { terminalEnv } from './terminal.mjs';
import { durationWords } from '../../client/components/run-words.js';

export const READY_TIMEOUT_MS = 20000;
export const LOG_MAX_LINES = 400;
export const LINE_MAX = 2000;
export const LIVE_STATES = ['off', 'starting', 'running', 'failed'];
const LIVE_KEYS = ['label', 'command', 'cwd'];
const MASK = '•••';

// ---------- the manifest entry ----------

/**
 * Check atelier.json's live entry against the contract. Returns { live, problem }: live is the normalised entry
 * { label, command, cwd } or null; problem a sentence when the entry exists and is not valid (null when it is
 * valid or absent). projectPath is needed for the cwd confinement.
 */
export function checkLive(entry, projectPath) {
  if (entry === undefined || entry === null) return { live: null, problem: null };
  const bad = (problem) => ({ live: null, problem });
  if (typeof entry !== 'object' || Array.isArray(entry)) return bad('live must be an object { label, command, cwd }');
  for (const k of Object.keys(entry)) if (!LIVE_KEYS.includes(k)) return bad(`live.${k} is not part of the contract (label, command, cwd)`);
  const { label = 'Live', command, cwd = '.' } = entry;
  if (typeof label !== 'string' || !label.trim() || label.length > 120 || /[\r\n]/.test(label)) return bad('live.label must be one line of at most 120 characters');
  if (!Array.isArray(command) || command.length < 1 || command.length > 64) return bad('live.command must be an argv array of 1 to 64 strings');
  for (const [i, a] of command.entries()) {
    if (typeof a !== 'string' || a.length > 4000 || a.includes('\0')) return bad(`live.command[${i}] must be a string of at most 4000 characters`);
  }
  if (!command[0].trim()) return bad('live.command[0] (the program) must not be empty');
  // Windows runs a .cmd or .bat through cmd.exe whatever spawn is told, which would be a shell after all.
  if (/\.(cmd|bat)$/i.test(command[0].trim())) return bad('live.command[0] must be a program, not a .cmd or .bat script (they run through a shell)');
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 400) return bad('live.cwd must be a folder relative to the project');
  if (path.isAbsolute(cwd) || /^[a-zA-Z]:/.test(cwd) || cwd.startsWith('\\\\')) return bad('live.cwd must be relative to the project, not an absolute path');
  try {
    insideProject(projectPath, cwd);
  } catch (err) {
    return bad(`live.cwd ${err.code === 'path_outside_project' ? 'leaves the project folder' : 'may not be .git or .studio'}: ${JSON.stringify(cwd)}`);
  }
  return { live: { label: label.trim(), command: [...command], cwd }, problem: null };
}

/** What is spawned: { file, args, cwd } with cwd confined (throws 400 otherwise). "node" is the studio's own Node. */
export function launchOf(live, projectPath, execPath = process.execPath) {
  const cwd = insideProject(projectPath, live.cwd);
  const [program, ...args] = live.command;
  const file = program === 'node' ? execPath : program;
  return { file, args, cwd };
}

// ---------- the ready line ----------

/**
 * A URL the frame may open: http, host 127.0.0.1 or localhost, an explicit port, no user or password.
 * Returns { url } (a URL object) or { error }.
 */
export function loopbackUrl(text) {
  let u;
  try { u = new URL(String(text)); } catch { return { error: 'the URL does not parse' }; }
  if (u.protocol !== 'http:') return { error: `only http URLs are accepted, not ${u.protocol.replace(/:$/, '')}` };
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return { error: `only 127.0.0.1 or localhost is accepted, not ${u.hostname}` };
  if (!u.port) return { error: 'the URL must name its port' };
  if (u.username || u.password) return { error: 'the URL may not carry a user or password' };
  return { url: u };
}

/**
 * One stdout line: null when it is not a ready line (ordinary output), { url, secrets } when it is a valid one,
 * { error } when it claims to be one ({"atelierLive":1,...}) but its URL is not accepted.
 * secrets: the strings to mask from now on (the fragment and its k= value).
 */
export function parseReadyLine(line) {
  const t = String(line ?? '').trim();
  if (!t.startsWith('{') || !t.includes('atelierLive')) return null;
  let j;
  try { j = JSON.parse(t); } catch { return null; }
  if (!j || typeof j !== 'object' || j.atelierLive !== 1) return null;
  if (typeof j.url !== 'string') return { error: 'the ready line has no url' };
  const { url, error } = loopbackUrl(j.url);
  if (error) return { error: `the ready line's URL was refused: ${error}` };
  return { url: url.href, secrets: secretsOf(url) };
}

function secretsOf(url) {
  const out = [];
  const frag = url.hash.replace(/^#/, '');
  if (frag) out.push(frag);
  for (const part of frag.split('&')) {
    const v = part.includes('=') ? part.slice(part.indexOf('=') + 1) : '';
    if (v) out.push(v);
  }
  return out.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

// ---------- masking ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Mask what could be the token: every URL fragment, every k= parameter, and each known secret wherever it appears
 * (a server that prints its token alone on a line). Used for the log and every answer.
 */
export function maskSecrets(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) if (secret) s = s.replace(new RegExp(escapeRe(secret), 'g'), MASK);
  s = s.replace(/(https?:\/\/[^\s#"'<>]*)#[^\s"'<>]+/g, `$1#${MASK}`);
  s = s.replace(/([#?&]k=)(?!•••)[^\s&"'<>]+/g, `$1${MASK}`);
  return s;
}

/** The URL as answers show it: the fragment masked. */
export const maskUrl = (href) => (href ? maskSecrets(href) : null);

// ---------- the log ----------

/** A bounded ring of { at, stream, text } lines, stored masked. remask() applies secrets learnt later. */
export function createLogRing(max = LOG_MAX_LINES) {
  const lines = [];
  return {
    push(stream, text, secrets) {
      const cut = text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text;
      lines.push({ at: nowIso(), stream, text: maskSecrets(cut, secrets) });
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    remask(secrets) { for (const l of lines) l.text = maskSecrets(l.text, secrets); },
    all: () => lines.map((l) => ({ ...l })),
    get size() { return lines.length; },
  };
}

/** Split a stream into lines; feed(chunk) calls onLine for each complete one, flush() for the rest. */
function lineSplitter(onLine) {
  let rest = '';
  return {
    feed(chunk) {
      rest += chunk.toString('utf8');
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        onLine(rest.slice(0, i).replace(/\r$/, ''));
        rest = rest.slice(i + 1);
      }
      if (rest.length > 64 * 1024) { onLine(rest); rest = ''; } // a stream with no newline still reaches the log
    },
    flush() { if (rest) onLine(rest); rest = ''; },
  };
}

// ---------- consent ----------

/** The allowance's key: the folder, the exact argv and the cwd. Any change asks again. */
export function consentKey({ folder, command, cwd }) {
  return crypto.createHash('sha256').update(JSON.stringify({ folder: folderKey(folder), command, cwd })).digest('hex');
}

const sameLive = (a, b) => a && b && a.cwd === b.cwd && Array.isArray(a.command) && Array.isArray(b.command)
  && a.command.length === b.command.length && a.command.every((x, i) => x === b.command[i]);

/** The origin the Workbench frames from: what the client says when it is this studio's loopback origin, else 127.0.0.1. */
export function frameOrigin(requested, port) {
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return allowed.includes(requested) ? requested : allowed[0];
}

// ---------- the process tree ----------

/** End a child and everything it started. Synchronous, so it also works in an exit handler. */
export function killTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch { /* already gone */ }
    return;
  }
  // Elsewhere the child leads its own process group (spawned detached): signal the group.
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
}

// ---------- the service ----------

/**
 * createLive({ loadProject, emit, runs, consentFile, port, studioDir, env, readyTimeoutMs, execPath })
 * Every answer is masked; frameUrl() is the only place the full URL leaves this module.
 */
export function createLive({ loadProject, emit = null, runs = null, consentFile, port, studioDir = '', env = process.env, readyTimeoutMs = READY_TIMEOUT_MS, execPath = process.execPath } = {}) {
  if (!consentFile) throw new Error('createLive: consentFile is required');
  const entries = new Map(); // projectId -> { state, reason, child, pid, command, cwd, label, startedAt, readyAt, endedAt, url, secrets, origin, log, runId, timer }
  const send = (projectId, extra = {}) => { try { emit?.('live.changed', { projectId, ...extra }); } catch { /* events never break a process */ } };
  const logTimer = new Map();
  const sendLog = (projectId) => {
    if (logTimer.has(projectId)) return;
    logTimer.set(projectId, setTimeout(() => { logTimer.delete(projectId); send(projectId, { log: true }); }, 250));
    logTimer.get(projectId).unref?.();
  };

  const readConsent = async () => (await readJson(consentFile, {})) || {};
  async function consentOf(projectId, projectPath, live) {
    const c = (await readConsent())[projectId];
    if (!c || !live) return { allowed: false, allowedAt: null, changed: !!c };
    const ok = c.key === consentKey({ folder: projectPath, command: live.command, cwd: live.cwd });
    return { allowed: ok, allowedAt: ok ? c.allowedAt : null, changed: !ok }; // changed: an allowance exists for another command
  }

  async function declared(projectId) {
    const ctx = await loadProject(projectId);
    const { live, problem } = checkLive(ctx.manifest?.live, ctx.path);
    return { ctx, live, problem };
  }

  function entryInfo(e) {
    if (!e) return { state: 'off', reason: null, pid: null, startedAt: null, readyAt: null, endedAt: null, url: null, origin: null, running: null, log: [] };
    return {
      state: e.state, reason: e.reason ? maskSecrets(e.reason, e.secrets) : null, pid: e.state === 'starting' || e.state === 'running' ? e.pid : null,
      startedAt: e.startedAt, readyAt: e.readyAt, endedAt: e.endedAt, url: maskUrl(e.url), origin: e.origin,
      running: { label: e.label, command: e.command, cwd: e.cwd }, log: e.log.all(),
    };
  }

  /** Everything the Workbench and the companion read: the declared entry, the allowance, the state and the masked log. */
  async function status(projectId) {
    const { ctx, live, problem } = await declared(projectId);
    const e = entries.get(projectId) || null;
    const info = entryInfo(e);
    const active = e && (e.state === 'starting' || e.state === 'running');
    return {
      projectId, declared: live, problem, cwdPath: live ? insideProject(ctx.path, live.cwd) : null,
      consent: await consentOf(projectId, ctx.path, live),
      ...info,
      // The manifest changed while the process runs: it keeps running what was allowed; off and on runs the new one.
      stale: !!(active && live && !sameLive(live, e)),
    };
  }

  /** The person allowed the command they were shown. It must still be the manifest's, or the click consented to something else. */
  async function allow(projectId, shown = {}) {
    const { ctx, live, problem } = await declared(projectId);
    if (!live) throw new HttpError(400, problem ? 'live_invalid' : 'live_not_declared', problem || 'This project declares no live server in atelier.json');
    if (!sameLive(live, { command: shown.command, cwd: shown.cwd })) throw new HttpError(409, 'live_changed', 'The live command in atelier.json changed since it was shown; look at it again before allowing it');
    const all = await readConsent();
    all[projectId] = { key: consentKey({ folder: ctx.path, command: live.command, cwd: live.cwd }), command: live.command, cwd: live.cwd, folder: ctx.path, allowedAt: nowIso() };
    await writeJson(consentFile, all);
    send(projectId);
    return status(projectId);
  }

  async function forget(projectId) {
    const all = await readConsent();
    if (all[projectId]) { delete all[projectId]; await writeJson(consentFile, all); }
    send(projectId);
    return status(projectId);
  }

  function finish(projectId, e, state, reason) {
    if (e.ended) return;
    e.ended = true;
    clearTimeout(e.timer);
    e.state = state;
    e.reason = reason;
    e.endedAt = nowIso();
    const ran = durationWords(Date.parse(e.endedAt) - Date.parse(e.startedAt));
    if (e.runId) runs?.end(e.runId, { state: state === 'off' ? 'Stopped' : 'Failed', reason: maskSecrets(reason || '', e.secrets) || null, latest: `${state === 'off' ? 'stopped' : 'ended'} after ${ran}` });
    send(projectId);
  }

  async function start(projectId, { origin = null } = {}) {
    const { ctx, live, problem } = await declared(projectId);
    if (!live) throw new HttpError(400, problem ? 'live_invalid' : 'live_not_declared', problem || 'This project declares no live server in atelier.json');
    const consent = await consentOf(projectId, ctx.path, live);
    if (!consent.allowed) throw new HttpError(403, 'live_consent_needed', consent.changed ? 'The live command changed since you allowed it; allow the new command first' : 'Allow this project\'s live command first');
    const prev = entries.get(projectId);
    if (prev && (prev.state === 'starting' || prev.state === 'running')) throw new HttpError(409, 'live_running', `Live is already ${prev.state}; switch it off first`);
    const { file, args, cwd } = launchOf(live, ctx.path, execPath);
    const frameFrom = frameOrigin(origin, port);
    const childEnv = { ...terminalEnv(env, { projectId, studioDir }), ATELIER_FRAME_ORIGIN: frameFrom };
    const e = { state: 'starting', reason: null, child: null, pid: null, label: live.label, command: live.command, cwd: live.cwd, startedAt: nowIso(), readyAt: null, endedAt: null, url: null, secrets: [], origin: frameFrom, log: createLogRing(), runId: null, timer: null, ended: false, stopping: false };
    entries.set(projectId, e);
    let child;
    try {
      child = spawn(file, args, { cwd, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (err) {
      finish(projectId, e, 'failed', `could not start ${live.command[0]}: ${err.code || err.message}`);
      return status(projectId);
    }
    e.child = child;
    e.pid = child.pid || null;
    e.runId = runs?.start({ kind: 'live', projectId, name: live.label, latest: 'starting' })?.id || null;
    const out = lineSplitter((line) => {
      if (e.state === 'starting' && !e.stopping) {
        const ready = parseReadyLine(line);
        if (ready?.error) {
          e.log.push('stdout', line, e.secrets);
          finish(projectId, e, 'failed', ready.error);
          e.stopping = true;
          killTree(child);
          return;
        }
        if (ready) {
          e.secrets = ready.secrets;
          e.log.remask(e.secrets);
          e.log.push('stdout', line, e.secrets);
          e.url = ready.url;
          e.readyAt = nowIso();
          e.state = 'running';
          clearTimeout(e.timer);
          const u = new URL(ready.url);
          if (e.runId) runs?.update(e.runId, { latest: `serving ${u.host}` });
          send(projectId);
          return;
        }
      }
      e.log.push('stdout', line, e.secrets);
      sendLog(projectId);
    });
    const errs = lineSplitter((line) => { e.log.push('stderr', line, e.secrets); sendLog(projectId); });
    child.stdout.on('data', (c) => out.feed(c));
    child.stderr.on('data', (c) => errs.feed(c));
    child.on('error', (err) => finish(projectId, e, 'failed', `could not start ${live.command[0]}: ${err.code || err.message}`));
    child.on('exit', (code, signal) => {
      out.flush(); errs.flush();
      const how = signal ? `signal ${signal}` : `code ${code}`;
      if (e.stopping) return finish(projectId, e, e.state === 'failed' ? 'failed' : 'off', e.reason);
      finish(projectId, e, 'failed', e.state === 'starting' ? `it exited before it was ready (${how})` : `it exited by itself (${how})`);
    });
    e.timer = setTimeout(() => {
      if (e.state !== 'starting' || e.ended) return;
      finish(projectId, e, 'failed', `no ready line within ${Math.round(readyTimeoutMs / 1000)} s`);
      e.stopping = true;
      killTree(child);
    }, readyTimeoutMs);
    e.timer.unref?.();
    send(projectId);
    return status(projectId);
  }

  /** Stop the project's process tree (why: the reason in words). Off also clears a failure. Synchronous kill. */
  function stopNow(projectId, why = 'you switched Live off') {
    const e = entries.get(projectId);
    if (!e) return false;
    const active = !e.ended && (e.state === 'starting' || e.state === 'running');
    if (active) {
      e.stopping = true;
      killTree(e.child);
      finish(projectId, e, 'off', why);
    } else {
      e.state = 'off';
      e.reason = why;
      send(projectId);
    }
    return active;
  }

  async function stop(projectId, why) {
    await loadProject(projectId); // 404 for an unknown id
    stopNow(projectId, why);
    return status(projectId);
  }

  /** Another project became active: this window's preview left the others, so their live servers stop. */
  function stopOthers(projectId, why = 'the project was closed') {
    const stopped = [];
    for (const id of entries.keys()) if (id !== projectId && stopNow(id, why)) stopped.push(id);
    return stopped;
  }

  function stopAll(why = 'the studio quit') {
    const stopped = [];
    for (const id of entries.keys()) if (stopNow(id, why)) stopped.push(id);
    return stopped;
  }

  /** The full URL, for the Workbench frame's redirect only. null unless running. */
  function frameUrl(projectId) {
    const e = entries.get(projectId);
    return e && e.state === 'running' && !e.ended ? e.url : null;
  }

  /** Test hook: the child process of a project (or null). */
  const childOf = (projectId) => entries.get(projectId)?.child || null;

  return { status, allow, forget, start, stop, stopNow, stopOthers, stopAll, frameUrl, childOf };
}

/** GET /live/<projectId>: a 302 to the live URL (token included) for the Workbench frame, or a short page when off. */
export function serveLiveFrame(res, url) {
  if (url) {
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }
  const page = Buffer.from('<!doctype html><meta charset="utf-8"><title>Live is off</title><body style="font:14px system-ui;color:#cfd3da;background:#15171b;margin:0;display:grid;place-items:center;height:100vh"><p style="max-width:40ch;text-align:center">Live is not running for this project. Switch Live on above the preview, or go back to the files on disk.</p></body>');
  res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-store' });
  res.end(page);
}
