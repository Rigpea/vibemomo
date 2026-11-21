// Codex: the studio's second brain (docs/ARCHITECTURE.md section 21). A `codex` console session runs the person's
// own Codex CLI headless (`codex exec --json`, then `exec resume <thread id>`) in the project folder and turns its
// JSONL events into the turn and events shape every console backend records (server/lib/console.mjs).
// Hard rules, as for Claude Code (decision row 151):
// - the child env never holds OPENAI_API_KEY, CODEX_API_KEY or CODEX_ACCESS_TOKEN, so a run uses the login the
//   person saved with `codex login` and nothing else; `codex login status` says which kind it is, and the tab and
//   every turn name it;
// - the sandbox is read-only unless the person chose workspace-write; danger-full-access and the bypass flags are
//   never passed, and codexArgs refuses any other sandbox;
// - the model, the effort and the sandbox are the session record's; nothing here changes them;
// - ~/.codex is only read (config.toml's model and effort, models_cache.json's list); the studio's tools are
//   attached per run with -c mcp_servers.atelier.* overrides.
// This module does not import console.mjs: console.mjs hands the runner what it needs.
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { HttpError, nowIso } from './paths.mjs';

export const CODEX_SANDBOXES = ['read-only', 'workspace-write'];
export const CODEX_DEFAULT_SANDBOX = 'read-only';
/** Efforts offered when the model list does not say (models_cache.json names them per model). */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
/** The short built-in list, used only when ~/.codex/models_cache.json cannot be read (as it read on 2026-11-13). */
export const CODEX_FALLBACK_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol' }, { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
].map((m) => ({ ...m, efforts: [...CODEX_EFFORTS], defaultEffort: null }));
/** Never in a Codex child's env: any of them would let a run bill an API key instead of the saved login. */
export const CODEX_STRIPPED_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
export const CODEX_NO_CLI = 'The Codex CLI was not found: install it, or set its path in Settings › Console (or ATELIER_CODEX_BIN).';
export const CODEX_SIGNED_OUT = 'Codex is signed out on this machine: run `codex login` in a terminal, then send the message again.';
/** What the first message of a Codex session carries before the person's words (Codex has no system prompt flag). */
export const CODEX_ROLE = 'You are answering in the Codex tab of the Atelier studio, beside the person\'s Claude Code companion: a second opinion on this one project. Review, question and explain with the code in hand, and name the files you looked at.';
export const CODEX_TOOLS_SENTENCE = 'The studio\'s tools (the atelier MCP server) are attached: they read the project\'s briefing, memory, files, versions and diffs, look at its phone and page, and record tasks and unresolved items. A change to the project is a studio task (atelier_create_task) unless the person asked you for an edit.';
export const codexSandboxSentence = (sandbox) => (sandbox === 'workspace-write'
  ? 'Your sandbox is workspace-write: you may edit files in this folder when the person asks for it.'
  : 'Your sandbox is read-only: you can read and run commands that change nothing; say what you would change instead of trying to.');

// A Codex worker (server/lib/workers.mjs; docs/ARCHITECTURE.md section 17): a studio task carried out by a Codex
// session. It has to write files, so its sandbox is workspace-write and nothing wider; like every Codex run it gets
// no bypass flag and no approval policy, so a command the sandbox refuses simply fails and Codex is told.
export const CODEX_WORKER_SANDBOX = 'workspace-write';
/** What a worker's first message opens with, in place of the tab's role. The facts are the ones a real run showed
 *  on 2026-11-14 (codex-cli 0.160.0, Windows): files in the folder and the temp folder are writable, .git and
 *  everything else outside are not, and commands had no internet. */
export const CODEX_WORKER_ROLE = 'You are a worker of the Atelier studio, running in the Codex CLI: one studio task in this project folder is yours to carry out, alone and to the end. Nobody can answer you or approve anything during this turn, so a refusal is final: when a command you need is refused, or a check cannot run here, do not look for a way around it. Run the task question command saying exactly what was refused and what you need, and stop.';
export const CODEX_WORKER_SANDBOX_SENTENCE = 'Your sandbox is workspace-write: you can edit files in this folder; you cannot write outside it (the temp folder aside) and commands may have no internet. You cannot write this folder\'s .git either, so you cannot commit, and the studio CLI\'s checkpoint and restore do not work here. The CLI knows this: its task finish records your finish, and the studio keeps the version when your turn ends. When task finish says your finish is recorded, that is the expected end: stop there.';
/** Every Codex child's env names it, so the studio CLI it runs records its events as Codex's (bin/atelier.mjs). */
export const CODEX_ACTOR_ENV = { ATELIER_ACTOR: 'codex' };

const MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const EFFORT_RE = /^[a-z]{2,12}$/;
const THREAD_RE = /^[A-Za-z0-9][\w-]{0,127}$/; // never starts with "-": it is an argv entry
const MAX_EVENTS = 200;
const DETAIL = 4000;

const envGet = (env, name) => { const k = Object.keys(env || {}).find((e) => e.toUpperCase() === name); return k ? env[k] : undefined; };

/** Copy of env without the keys a Codex run could bill (case-insensitive, since Windows env names are). */
export function dropCodexKeys(env) {
  const drop = new Set(CODEX_STRIPPED_ENV);
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!drop.has(k.toUpperCase())) out[k] = v;
  return out;
}

/** Where Codex keeps its files: CODEX_HOME when the person set it, else ~/.codex. Only ever read from here. */
export const codexHome = (env = process.env) => envGet(env, 'CODEX_HOME') || path.join(os.homedir(), '.codex');

/** config.toml's own model and effort: the top-level keys, which TOML puts before the first [table]. */
export function parseCodexConfig(text) {
  const out = { model: null, effort: null };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = line.match(/^(model|model_reasoning_effort)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/);
    if (!m) continue;
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
    if (m[1] === 'model' && MODEL_RE.test(value)) out.model = value;
    if (m[1] === 'model_reasoning_effort' && EFFORT_RE.test(value)) out.effort = value;
  }
  return out;
}

/** models_cache.json's models the picker lists (visibility "list"), in Codex's own order, or [] when it holds none. */
export function parseCodexModels(json) {
  const list = Array.isArray(json?.models) ? json.models : [];
  return list
    .filter((m) => m && typeof m.slug === 'string' && MODEL_RE.test(m.slug) && m.visibility !== 'hide')
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m) => {
      const efforts = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((l) => (typeof l === 'string' ? l : l?.effort)).filter((e) => typeof e === 'string' && EFFORT_RE.test(e));
      return { id: m.slug, name: typeof m.display_name === 'string' && m.display_name ? m.display_name.slice(0, 60) : m.slug, efforts: efforts.length ? efforts : [...CODEX_EFFORTS], defaultEffort: EFFORT_RE.test(String(m.default_reasoning_level || '')) ? m.default_reasoning_level : null };
    });
}

/**
 * What the tab offers and what it starts with: { models, source, defaults: { model, effort }, configRead }.
 * models come from models_cache.json (source 'models_cache.json') or the built-in list (source 'built-in');
 * defaults are config.toml's (null where it names none); a config model the list lacks is added so it can stay chosen.
 */
export async function codexChoices(home) {
  let models = [];
  try { models = parseCodexModels(JSON.parse(await fsp.readFile(path.join(home, 'models_cache.json'), 'utf8'))); } catch { /* the built-in list */ }
  const source = models.length ? 'models_cache.json' : 'built-in';
  if (!models.length) models = CODEX_FALLBACK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  let defaults = { model: null, effort: null };
  let configRead = false;
  try { defaults = parseCodexConfig(await fsp.readFile(path.join(home, 'config.toml'), 'utf8')); configRead = true; } catch { /* no config: Codex's own defaults */ }
  if (defaults.model && !models.some((m) => m.id === defaults.model)) models = [{ id: defaults.model, name: defaults.model, efforts: [...CODEX_EFFORTS], defaultEffort: null }, ...models];
  return { models, source, defaults, configRead };
}

/** The efforts a model takes, as the list says (a model the list lacks: the built-in efforts). */
export const effortsOf = (choices, model) => choices.models.find((m) => m.id === model)?.efforts || [...CODEX_EFFORTS];

/**
 * A change to a session's model, effort and sandbox, checked against what Codex offers here; a 400 names what does
 * not fit. patch holds only what changes (undefined: unchanged); current is the session as it is. The effort must be
 * one the resulting model takes, so a model change that leaves an effort the new model lacks is refused: the person
 * picks the effort, the studio does not move it. model null and effort null leave Codex's own default.
 */
export function checkCodexChoice(choices, patch = {}, current = {}) {
  const { model, effort, sandbox } = patch;
  const out = {};
  if (model !== undefined) {
    if (model !== null && !choices.models.some((m) => m.id === model)) throw new HttpError(400, 'invalid_input', `model must be one of ${choices.models.map((m) => m.id).join(', ')}`);
    out.model = model;
  }
  if (effort !== undefined) out.effort = effort === '' ? null : effort;
  if (model !== undefined || effort !== undefined) {
    const m = out.model !== undefined ? out.model : current.model ?? null;
    const e = out.effort !== undefined ? out.effort : current.effort ?? null;
    const allowed = effortsOf(choices, m);
    if (e !== null && !allowed.includes(e)) throw new HttpError(400, 'invalid_input', `effort must be one of ${allowed.join(', ')} for ${m || 'Codex\'s default model'}, or null for its default`);
  }
  if (sandbox !== undefined) {
    if (!CODEX_SANDBOXES.includes(sandbox)) throw new HttpError(400, 'invalid_input', `sandbox must be ${CODEX_SANDBOXES.join(' or ')}; the studio never runs Codex without a sandbox`);
    out.sandbox = sandbox;
  }
  return out;
}

/** A TOML value for a -c override: JSON strings and arrays of strings are valid TOML as they stand. */
const toml = (v) => JSON.stringify(v);

/**
 * The codex CLI's argv for a turn of a session record (no shell quoting: each entry is one argument); the message
 * goes in on stdin ("-"). mcp: the atelier server as studioMcpConfig gives it ({ command, args, env }), or null.
 * The sandbox goes as -c sandbox_mode because `exec resume` has no -s flag (codex-cli 0.160.0).
 */
export function codexArgs(rec, { mcp = null } = {}) {
  const sandbox = rec.sandbox || CODEX_DEFAULT_SANDBOX;
  if (!CODEX_SANDBOXES.includes(sandbox)) throw new HttpError(400, 'invalid_input', `sandbox must be ${CODEX_SANDBOXES.join(' or ')}`);
  const resume = typeof rec.codexThreadId === 'string' && THREAD_RE.test(rec.codexThreadId);
  const args = ['exec'];
  if (resume) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (rec.model && MODEL_RE.test(rec.model)) args.push('-m', rec.model);
  if (rec.effort && EFFORT_RE.test(rec.effort)) args.push('-c', `model_reasoning_effort=${toml(rec.effort)}`);
  args.push('-c', `sandbox_mode=${toml(sandbox)}`);
  if (mcp?.command) {
    args.push('-c', `mcp_servers.atelier.command=${toml(mcp.command)}`);
    args.push('-c', `mcp_servers.atelier.args=${toml((mcp.args || []).map(String))}`);
    const env = Object.entries(mcp.env || {}).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k));
    if (env.length) args.push('-c', `mcp_servers.atelier.env={${env.map(([k, v]) => `${k}=${toml(String(v))}`).join(',')}}`);
    // exec never asks, so an MCP call that needs approval is refused; the studio's own tools run without asking,
    // as the Companion's do (--allowedTools mcp__atelier__*). No other approval is given.
    args.push('-c', 'mcp_servers.atelier.default_tools_approval_mode="approve"');
  }
  if (resume) args.push(rec.codexThreadId);
  args.push('-');
  return args;
}

/** A command as the person would type it: Codex wraps it in its shell ("…pwsh.exe" -Command '…', bash -lc "…"). */
export function commandWords(command) {
  const c = String(command ?? '').trim();
  // Only a shell's own wrapper is taken off: "git -c key=value status" is a command, not a wrapper.
  const m = c.match(/^(?:"[^"]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"|(?:\S*[\\/])?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?)\s+(?:-NoProfile\s+|-NoLogo\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/i);
  let inner = m ? m[1].trim() : c;
  if (m && inner.length > 1 && ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"')))) inner = inner.slice(1, -1);
  return inner.replace(/\s+/g, ' ').slice(0, 160);
}

/** An MCP call's arguments in one line, as console.mjs's toolSummary reads a tool input. */
function argWords(input) {
  if (!input || typeof input !== 'object') return String(input ?? '').slice(0, 80);
  for (const k of ['file_path', 'path', 'file', 'command', 'pattern', 'url', 'title', 'description']) if (typeof input[k] === 'string' && input[k]) return input[k].slice(0, 160);
  const s = JSON.stringify(input);
  return s === '{}' ? '' : s.slice(0, 80);
}

const contentText = (result) => {
  const c = result?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : b?.type ? `[${b.type}]` : '')).filter(Boolean).join('\n');
  return result == null ? '' : typeof result === 'string' ? result : JSON.stringify(result);
};

/** Codex's error line is often JSON inside a string ({"error":{"message":…,"code":…}}): its message and code. */
export function codexErrorOf(message) {
  const raw = String(message ?? '').trim();
  try {
    const j = JSON.parse(raw);
    const e = j?.error && typeof j.error === 'object' ? j.error : j;
    if (e && typeof e.message === 'string') return { message: e.message, code: typeof e.code === 'string' ? e.code : null, status: Number.isFinite(j?.status) ? j.status : null };
  } catch { /* plain words */ }
  return { message: raw, code: null, status: null };
}

export const CODEX_SIGNED_OUT_RE = /not logged in|codex login|401 unauthorized|unauthorized|token (has |is )?expired|refresh token|sign in again|authentication (failed|required|error)|invalid_api_key|missing bearer/i;
export const CODEX_MODEL_REFUSED_RE = /model_not_found|model is not supported|is not supported when using codex|model .{0,80}does not exist|unknown model|invalid model/i;

/**
 * Reads `codex exec --json` lines into a turn. turn: { text, events }; event(ev): a tool, tool-result, denied or
 * status event to record and stream; text(piece): answer text to stream; thread(id): the thread id Codex named.
 * Event kinds and fields are the claude-code backend's, so the transcript and the trajectory draw them unchanged:
 * a command is the tool "Shell", an MCP call "mcp__<server>__<tool>", a file change "Write" (add), "Edit" (update)
 * or "Delete", a web search "WebSearch". ms is the time since the run began.
 */
export function createCodexParser({ turn, startedMs = Date.now(), now = () => Date.now(), event = () => {}, text = () => {}, thread = () => {} }) {
  const shown = new Set(); // item ids whose call row went out
  const state = { failed: null, errors: [], completed: false };
  const ms = () => now() - startedMs;
  const call = (id, name, summary) => { if (shown.has(id)) return; shown.add(id); event({ kind: 'tool', id, name, summary, ms: ms() }); };
  const status = (name, words) => { const s = String(words ?? '').trim(); if (s) event({ kind: 'status', name, summary: s.slice(0, 300) }); };

  function item(it, done) {
    if (!it || typeof it !== 'object') return;
    const id = String(it.id || '');
    if (it.type === 'agent_message') {
      if (!done || !it.text) return;
      const body = String(it.text).replace(/\s+$/, '');
      const piece = turn.text && !/\n$/.test(turn.text) ? `\n\n${body}` : body;
      turn.text += piece;
      text(piece);
    } else if (it.type === 'command_execution') {
      call(id, 'Shell', commandWords(it.command));
      if (!done) return;
      const out = String(it.aggregated_output ?? '').trim();
      if (it.status === 'declined') return event({ kind: 'denied', id, name: 'Shell', summary: commandWords(it.command) });
      const ok = it.exit_code === 0 || (it.exit_code == null && it.status === 'completed');
      event({ kind: 'tool-result', id, name: 'Shell', ok, summary: (out || (ok ? 'no output' : `exit code ${it.exit_code ?? 'unknown'}`)).slice(0, 160), detail: out.slice(0, DETAIL) });
    } else if (it.type === 'mcp_tool_call') {
      const name = `mcp__${it.server || 'mcp'}__${it.tool || 'tool'}`;
      call(id, name, argWords(it.arguments));
      if (!done) return;
      const err = it.error ? String(it.error.message || it.error) : null;
      if (err && /requires approval|not approved|denied/i.test(err)) return event({ kind: 'denied', id, name, summary: argWords(it.arguments) || err.slice(0, 160) });
      const out = err || contentText(it.result).trim();
      event({ kind: 'tool-result', id, name, ok: !err && it.status !== 'failed', summary: out.replace(/\s+/g, ' ').slice(0, 160), detail: out.slice(0, DETAIL) });
    } else if (it.type === 'file_change') {
      // As codex-cli 0.160.0 printed it on 2026-11-13: item.started then item.completed, each with
      // changes [{ path (absolute), kind: add | update | delete }]. The row shows when the change starts.
      (Array.isArray(it.changes) ? it.changes : []).forEach((c, i) => {
        const cid = `${id}:${i}`;
        const name = c?.kind === 'add' ? 'Write' : c?.kind === 'delete' ? 'Delete' : 'Edit';
        call(cid, name, String(c?.path || ''));
        if (done && it.status && it.status !== 'completed') event({ kind: 'tool-result', id: cid, name, ok: false, summary: `the change was not applied (${it.status})`, detail: '' });
      });
    } else if (it.type === 'web_search') {
      call(id, 'WebSearch', String(it.query || '').slice(0, 160));
    } else if (it.type === 'reasoning') {
      if (done) status('reasoning', it.text);
    } else if (it.type === 'todo_list') {
      if (done) status('plan', (Array.isArray(it.items) ? it.items : []).map((t) => `${t?.completed ? '[x]' : '[ ]'} ${t?.text || ''}`).join('; '));
    } else if (it.type === 'error') {
      if (done) status('codex', it.message); // a warning Codex carries on from (model metadata, a slow MCP server)
    } else if (done) status(String(it.type || 'item'), it.text || it.message || '');
  }

  function line(raw) {
    if (!String(raw).trim()) return;
    let ev;
    try { ev = JSON.parse(raw); } catch { return status('status', raw); }
    if (!ev || typeof ev !== 'object') return status('status', raw);
    if (ev.type === 'thread.started') {
      if (typeof ev.thread_id === 'string' && THREAD_RE.test(ev.thread_id)) thread(ev.thread_id);
    } else if (ev.type === 'item.started' || ev.type === 'item.updated') item(ev.item, false);
    else if (ev.type === 'item.completed') item(ev.item, true);
    else if (ev.type === 'turn.completed') {
      state.completed = true;
      const u = ev.usage;
      if (u && typeof u === 'object') {
        // The meta line and the tally read Claude Code's names; Codex's own figures are kept beside them.
        turn.usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens, reasoning_output_tokens: u.reasoning_output_tokens };
        for (const k of Object.keys(turn.usage)) if (typeof turn.usage[k] !== 'number') delete turn.usage[k];
      }
    } else if (ev.type === 'turn.failed') {
      state.failed = codexErrorOf(ev.error?.message ?? ev.error);
    } else if (ev.type === 'error') {
      state.errors.push(codexErrorOf(ev.message));
    }
  }

  /** How the run ended, once the child closed: { error, signedOut, modelRefused } (error null: it answered). */
  function result({ code = 0, signal = null, stderr = '', cancelled = false, model = null } = {}) {
    if (cancelled) return { error: null, signedOut: false, modelRefused: false };
    const said = state.failed || state.errors[state.errors.length - 1] || null;
    if (code === 0 && !said) return { error: null, signedOut: false, modelRefused: false };
    const words = said?.message || '';
    const all = `${words}\n${said?.code || ''}\n${stderr}`;
    const ranTools = turn.events.some((e) => e.kind === 'tool');
    if (CODEX_MODEL_REFUSED_RE.test(all)) return { error: `Codex refused the model ${model || 'it was given'}: choose another model in the tab and send the message again. Codex said: ${(words || stderr).split('\n')[0].slice(0, 240)}`, signedOut: false, modelRefused: true };
    if (!ranTools && (said?.status === 401 || CODEX_SIGNED_OUT_RE.test(all))) return { error: `${CODEX_SIGNED_OUT}${words || stderr ? ` Codex said: ${(words || stderr).split('\n')[0].slice(0, 240)}` : ''}`, signedOut: true, modelRefused: false };
    if (words) return { error: `Codex: ${words.slice(0, 600)}`, signedOut: false, modelRefused: false };
    return { error: `codex exited with ${code ?? signal}${stderr ? `: ${stderr.slice(-600)}` : ''}`, signedOut: false, modelRefused: false };
  }

  return { line, result, state };
}

/** `codex login status` in words: { loggedIn, login } with login 'chatgpt', 'api-key' or null (not told). */
export function parseLoginStatus(stdout, stderr = '') {
  const said = `${stdout}\n${stderr}`;
  if (/not logged in/i.test(said)) return { loggedIn: false, login: null };
  if (/logged in using chatgpt/i.test(said)) return { loggedIn: true, login: 'chatgpt' };
  if (/logged in using an? api key/i.test(said)) return { loggedIn: true, login: 'api-key' };
  if (/logged in/i.test(said)) return { loggedIn: true, login: null };
  return { loggedIn: null, login: null };
}

/**
 * The runner console.mjs uses for backend 'codex'. deps are the console's own: env, settings(), searchPath(names),
 * launcher(bin), versionOf(bin), baseEnv(env) (its strippedEnv), mcpFor(rec) (the atelier server for a session, or
 * null), attachChild, armTimeout, pushEvent, send(type, payload), registry, toolWords.
 */
export function createCodexRunner({ env, settings, searchPath, launcher, versionOf, baseEnv, mcpFor, attachChild, armTimeout, pushEvent, send, registry = null, toolWords = (n, s) => [n, s].filter(Boolean).join(' ') }) {
  const home = () => codexHome(env);
  const childEnv = () => ({ ...dropCodexKeys(baseEnv(env)), ...CODEX_ACTOR_ENV });
  let statusCache = null; // { at, bin, value }: `codex login status` takes a moment, so a minute's answer is reused

  const isFile = async (p) => { try { return (await fsp.stat(p)).isFile(); } catch { return false; } };
  /** The binary, found the way the console finds claude: ATELIER_CODEX_BIN, Settings › Console, else PATH. */
  async function resolved() {
    const fromEnv = env.ATELIER_CODEX_BIN;
    if (fromEnv) return (await isFile(fromEnv)) ? fromEnv : null;
    const configured = (await settings()).codexPath;
    if (configured) return (await isFile(configured)) ? configured : null;
    const found = searchPath(process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']);
    if (found) return found;
    // The Windows installer's own folder, for a studio started with a PATH from before Codex was installed.
    const local = process.platform === 'win32' ? envGet(env, 'LOCALAPPDATA') : null;
    const known = local ? path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : null;
    return known && (await isFile(known)) ? known : null;
  }

  /** What the tab needs before a run: the CLI, the login, the choices and config.toml's defaults. */
  async function status({ fresh = false } = {}) {
    const bin = await resolved();
    const choices = await codexChoices(home());
    if (!bin) return { cli: false, bin: null, version: null, loggedIn: null, login: null, ...choices, sandboxes: [...CODEX_SANDBOXES], defaultSandbox: CODEX_DEFAULT_SANDBOX, problem: CODEX_NO_CLI, checkedAt: nowIso() };
    let login = !fresh && statusCache && statusCache.bin === bin && Date.now() - statusCache.at < 60000 ? statusCache.value : null;
    if (!login) {
      const [cmd, lead, shell] = launcher(bin);
      login = await new Promise((done) => {
        execFile(cmd, [...lead, 'login', 'status'], { timeout: 15000, windowsHide: true, shell, env: childEnv() }, (_err, stdout, stderr) => done(parseLoginStatus(String(stdout || ''), String(stderr || ''))));
      });
      statusCache = { at: Date.now(), bin, value: login };
    }
    return { cli: true, bin, version: await versionOf(bin), ...login, ...choices, sandboxes: [...CODEX_SANDBOXES], defaultSandbox: CODEX_DEFAULT_SANDBOX, problem: login.loggedIn === false ? CODEX_SIGNED_OUT : null, checkedAt: nowIso() };
  }

  /** Before a message is recorded: the CLI is there and it is not signed out, or a 503 with the one sentence to act
   *  on. A signed-out answer is asked again fresh, since the person may have run `codex login` a moment ago. */
  async function ready() {
    let st = await status();
    if (!st.cli) throw new HttpError(503, 'console_no_codex', CODEX_NO_CLI);
    if (st.loggedIn === false) st = await status({ fresh: true });
    if (st.loggedIn === false) throw new HttpError(503, 'console_codex_signed_out', CODEX_SIGNED_OUT);
    return st;
  }

  /** One turn. text: what goes in on stdin (the person's words, with the first message's preface). timeoutMs: the
   *  studio's limit for this turn when it is not the console's own (a worker's whole task), after which the run is
   *  stopped and the turn says it timed out. Codex is given no time limit of its own. */
  async function run(rec, text, run, { contextUsed = null, timeoutMs = null } = {}) {
    const bin = await resolved();
    if (!bin) throw new HttpError(503, 'console_no_codex', CODEX_NO_CLI);
    const s = await settings();
    const args = codexArgs(rec, { mcp: rec.tools === 'studio' ? mcpFor(rec) : null });
    const [cmd, lead, shell] = launcher(bin);
    const login = statusCache?.bin === bin ? statusCache.value.login : null;
    const turn = { role: 'assistant', text: '', at: nowIso(), backend: 'codex', events: [], sandbox: rec.sandbox || CODEX_DEFAULT_SANDBOX, ...(rec.model ? { model: rec.model } : {}), ...(rec.effort ? { effort: rec.effort } : {}), ...(login ? { login } : {}) };
    if (contextUsed) turn.contextUsed = contextUsed;
    const child = spawn(cmd, [...lead, ...args], { cwd: rec.cwd, env: childEnv(), windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunk = (c) => send('console.chunk', { sessionId: rec.id, runId: run.runId, ...c });
    const parser = createCodexParser({
      turn, startedMs: run.startedMs,
      event: (ev) => {
        if (turn.events.length >= MAX_EVENTS) return;
        pushEvent(turn, ev);
        if (ev.kind === 'status') chunk({ kind: 'status', name: ev.name, text: ev.summary });
        else chunk(ev);
        if (ev.kind === 'tool') registry?.update(run.runId, { latest: toolWords(ev.name, ev.summary) });
      },
      text: (piece) => chunk({ kind: 'text', text: piece }),
      thread: (id) => { rec.codexThreadId = id; },
    });
    attachChild(rec, turn, run, child, {
      onStdoutLine: (l) => parser.line(l),
      onExit: (code, signal, stderr) => {
        const end = parser.result({ code, signal, stderr, cancelled: run.cancelled, model: rec.model });
        if (end.signedOut) { turn.signedOut = true; statusCache = null; }
        if (end.modelRefused) turn.modelRefused = true;
        return end.error;
      },
    });
    armTimeout(rec, run, timeoutMs || s.timeoutMs);
    child.stdin.end(text);
  }

  return { resolve: resolved, status, ready, run, childEnv };
}
