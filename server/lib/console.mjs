// Console: talk to Claude Code (headless CLI), the bounded API utility or a local command
// from inside the studio. Contract: docs/ARCHITECTURE.md section 7.
// Hard rule: a claude-code turn runs on the person's Claude Code plan. The child env never
// contains STUDIO_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY, so it can never bill the API.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { HttpError, newId, nowIso } from './paths.mjs';
import { readJson, writeJson, ensureDir } from './fsutil.mjs';
import { shortLabel } from './tasks.mjs';
import { COMPANION_PROMPT, companionReach, withContextPack } from './companion.mjs';
import { asksQuestion } from '../../client/components/companion-words.js';
import { sessionName, sessionEnd, toolWords } from './runs.mjs';

import { CONSOLE_MODELS } from './models.mjs';
import { createCodexRunner, codexChoices, codexHome, checkCodexChoice, effortsOf, CODEX_DEFAULT_SANDBOX, CODEX_NO_CLI, CODEX_ROLE, CODEX_TOOLS_SENTENCE, codexSandboxSentence } from './codex.mjs';
export { CONSOLE_MODELS }; // the list lives in models.mjs, where projects.mjs can read it without an import cycle
/** The CLI's --effort levels (claude 2.1.316: low, medium, high, xhigh, max); null leaves the CLI's default. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CONSOLE_BACKENDS = ['claude-code', 'api', 'command', 'codex']; // codex: the person's Codex CLI (server/lib/codex.mjs)
// The CLI's --permission-mode choices (claude 2.1.316). A -p session cannot answer a prompt, so manual asks are denials.
export const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual'];
export const CONTEXTS = ['none', 'briefing', 'history'];
/** A worker session's turn (server/lib/workers.mjs) may run long: a whole task, not one answer. */
export const WORKER_TIMEOUT_MS = 90 * 60 * 1000;
export const CONSOLE_DEFAULTS = { command: '', commandMode: 'stdin', timeoutMs: 600000, claudePath: '', codexPath: '', terminalFont: '' };
// Extra CLI rules for a session that reports back on a studio task (allowStudioCli): the studio
// CLI is `node …/bin/atelier.mjs`, which acceptEdits alone would refuse to run. This list is what
// Claude Code runs without asking, not a sandbox: node is unrestricted, npm run runs scripts the
// session may edit, and the git rules match as typed (git diff --no-index reads any file, --output=
// writes one). The protections are strippedEnv, the visible transcript and what the prompt asks.
export const STUDIO_CLI_ARGS = ['--allowedTools', 'Bash(node:*)', 'Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', '--disallowedTools', 'PowerShell']; // probe-allowed-tools-2.json: PowerShell(node:*) was still denied; with the PowerShell tool off, Bash(node:*) runs with zero denials
// Studio tools (tools: 'studio'): the companion's MCP server (bin/atelier-mcp.mjs; docs/ARCHITECTURE.md section 11)
// attached inline with --mcp-config, its tools allowed without asking, and two sentences on how to use them.
export const SESSION_TOOLS = ['studio'];
// A session's context (context: 'companion'): the Companion tab's session, with the companion's role in the system
// prompt and the context pack on its first message (server/lib/companion.mjs; docs/ARCHITECTURE.md section 12).
export const SESSION_CONTEXTS = ['companion'];
export const CONTEXT_PACK_LABEL = 'the studio context'; // the answer's meta line reads "with the studio context"
export const STUDIO_TOOLS_RULE = 'mcp__atelier__*';
export const STUDIO_TOOLS_PROMPT = 'The Atelier studio\'s tools (mcp__atelier__*) are available in this session: they read the project\'s briefing, memory, files, versions and diffs, look at its phone, move the studio window, and record tasks, unresolved items, memory and kept versions. Every change to a project goes through a task (atelier_create_task) or a kept version (atelier_keep_version), not by editing its files, unless the person asked for an edit.';
export const DEFAULT_STUDIO_ORIGIN = 'http://127.0.0.1:4747';
// The person's claude.ai connectors reach every studio run through their own login (Gmail among them, since
// 2026-11-13). The studio keeps Gmail read-only (decision row 150): these tools send, reply, forward, draft, label,
// trash or mark mail, and every claude run gets them denied. Searching, reading threads and messages, listing labels
// and drafts and downloading attachments stay. If Google adds a tool, the init event's tool list shows it.
export const GMAIL_WRITE_TOOLS = ['apply_sensitive_message_label', 'apply_sensitive_thread_label', 'create_draft', 'create_label',
  'delete_draft', 'delete_label', 'forward', 'label_message', 'label_thread', 'mark_message_spam', 'mark_thread_spam', 'reply',
  'send_message', 'trash_message', 'trash_thread', 'unlabel_message', 'unlabel_thread', 'unmark_message_spam', 'unmark_thread_spam',
  'untrash_message', 'untrash_thread', 'update_draft', 'update_label', 'update_message_labels'].map((t) => `mcp__claude_ai_Gmail__${t}`);
export const READ_ONLY_MAIL_ARGS = ['--disallowedTools', GMAIL_WRITE_TOOLS.join(',')];
/** What a companion session is told about the person's mail and, with --chrome, their browser. */
export const MAIL_PROMPT = 'Gmail in this studio can search and read the person\'s mail (threads, messages, labels, attachments) but cannot send, reply, forward, draft, label or delete; if they want a mail sent, write the text for them to send.';
/** The computer the studio runs on, named to a companion so it picks that browser when several are connected. */
export const HOST_OS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform;
export const CHROME_PROMPT = `The claude-in-chrome tools act in the person's own Chrome, signed in as them: use them to find and read pages, in tabs you open; leave their own tabs alone, and never send, post, submit a form, buy, accept terms or change account settings there unless their message asks for that exact step. A login page or a CAPTCHA is theirs to handle: say so and stop. This turn cannot ask a question, so when more than one browser is connected, call list_connected_browsers and select_browser yourself and use the one on this computer (${HOST_OS}), where the studio runs; say which one you used.`;

/** The MCP config a Studio tools session gets inline: the studio's own server, run with the studio's Node.
 *  sessionId: the console session the server belongs to, as ATELIER_SESSION_ID in its env, so atelier_start_task and
 *  atelier_review_task can name the manager a worker reports back to (server/lib/workers.mjs). */
export function studioMcpConfig({ studioDir, studioOrigin = DEFAULT_STUDIO_ORIGIN, projectId = null, nodePath = process.execPath, sessionId = null }) {
  const args = [path.join(studioDir, 'bin', 'atelier-mcp.mjs'), '--studio', studioOrigin];
  if (projectId) args.push('--project', projectId);
  const server = { command: nodePath, args };
  if (sessionId) server.env = { ATELIER_SESSION_ID: sessionId };
  return { mcpServers: { atelier: server } };
}

/** The claude CLI's argv for a turn of a session record (no shell quoting: each entry is one argument). */
/** studioProjectId: the studio's own project id, named to a companion session for its checkpoint command. */
export function claudeArgs(rec, { studioDir, studioOrigin = DEFAULT_STUDIO_ORIGIN, nodePath = process.execPath, studioProjectId = null } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', rec.model, '--permission-mode', rec.permissionMode || 'acceptEdits'];
  if (rec.claudeSessionId && /^[\w-]{1,128}$/.test(rec.claudeSessionId)) args.push('--resume', rec.claudeSessionId);
  // A companion session has the studio's reach (decision row 127): the CLI rules, the studio's folder, the sentence.
  const companion = rec.context === 'companion';
  if (rec.effort && EFFORTS.includes(rec.effort)) args.push('--effort', rec.effort);
  if (rec.allowStudioCli === true || companion) args.push(...STUDIO_CLI_ARGS);
  args.push(...READ_ONLY_MAIL_ARGS); // every run: the person's Gmail connector stays read-only in the studio
  // The person's own Chrome for a companion session (Claude in Chrome), unless they switched it off (decision row 150).
  const chrome = companion && rec.chrome !== false;
  if (chrome) args.push('--chrome');
  if (rec.tools === 'studio') {
    args.push('--mcp-config', JSON.stringify(studioMcpConfig({ studioDir, studioOrigin, projectId: rec.projectId, nodePath, sessionId: rec.id || null })));
    args.push('--allowedTools', STUDIO_TOOLS_RULE);
  }
  // One --append-system-prompt: the tools' two sentences, then the companion's role (server/lib/companion.mjs).
  const prompt = [rec.tools === 'studio' ? STUDIO_TOOLS_PROMPT : null, companion ? COMPANION_PROMPT : null, companion && studioDir ? companionReach(studioDir, studioProjectId) : null, companion ? MAIL_PROMPT : null, chrome ? CHROME_PROMPT : null].filter(Boolean);
  if (prompt.length) args.push('--append-system-prompt', prompt.join('\n\n'));
  const dirs = [...(rec.addDirs || [])];
  if (companion && studioDir && !dirs.some((d) => path.resolve(d) === path.resolve(studioDir))) dirs.push(studioDir);
  for (const d of dirs) args.push('--add-dir', d);
  return args;
}
export const STRIPPED_ENV = ['STUDIO_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'];
// Host Claude Code session markers: the studio may itself be started from inside a Claude Code
// session, and a child `claude` must not think it is nested in it. That includes the desktop app's host
// session (its account and organization ids, OAuth scopes, messaging socket, host and child-session ids,
// Agent SDK markers): a studio restarted from a desktop Code session inherits them (decision row 129).
// CLAUDE_CONFIG_DIR is kept: it is the person's own setting (machine env on this computer).
export const HOST_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|CLAUDE_AGENT_SDK_.*|USE_LOCAL_OAUTH|USE_STAGING_OAUTH|CLAUDE_CODE_(SESSION_.*|SDK_.*|ENTRYPOINT|SIMPLE|STARTUP_.*|TERMINAL_.*|USER_EMAIL|ACCOUNT_UUID|ORGANIZATION_UUID|OAUTH_SCOPES|MESSAGING_.*|HOST_.*|CHILD_SESSION|DESKTOP_.*|EXECPATH|REPORT_FINDINGS|EMIT_.*|EAGER_FLUSH|ENABLE_SDK_.*|ENABLE_ASK_USER_QUESTION_TOOL))$/i;
/** What the CLI prints when it has no working sign-in (the run fails before any model call). */
export const SIGNED_OUT_RE = /Failed to authenticate|OAuth (session|token)[^\n]{0,40}(expired|revoked|invalid)|could not be refreshed|Login expired|Not logged in|Please run \/login|Invalid bearer token|authentication_error/i;
const MAX_TEXT = 20000;
const MAX_EVENTS = 200;
const STDERR_TAIL = 2000;

/** The env of the studio's own claude runs: strippedEnv, plus the studio's saved Claude Code token when there is
 *  one (CLAUDE_CODE_OAUTH_TOKEN outranks the machine's saved login; decision row 129). Shells and commands never
 *  get the token, and with it Claude Code is told to scrub credentials from the commands, hooks and MCP servers
 *  it starts (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB), so a session's env or echo cannot print it into a transcript. */
export function claudeEnv(env, token = null) {
  const out = strippedEnv(env);
  if (token) {
    for (const k of Object.keys(out)) if (['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'].includes(k.toUpperCase())) delete out[k];
    out.CLAUDE_CODE_OAUTH_TOKEN = token;
    out.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  }
  return out;
}

/** Copy of env without the API keys (case-insensitive, since Windows env names are). */
export function strippedEnv(env) {
  const drop = new Set(STRIPPED_ENV);
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!drop.has(k.toUpperCase()) && !HOST_SESSION_ENV.test(k)) out[k] = v;
  return out;
}

export function titleOf(text) {
  const first = String(text).trim().split(/\r?\n/)[0];
  const sentence = first.split(/(?<=[.!?])\s/)[0];
  return shortLabel(sentence, 80);
}

export function toolSummary(input) {
  if (!input || typeof input !== 'object') return String(input ?? '').slice(0, 80);
  for (const k of ['file_path', 'command', 'pattern', 'path', 'url', 'description']) {
    if (typeof input[k] === 'string' && input[k]) return input[k].slice(0, 160);
  }
  return JSON.stringify(input).slice(0, 80);
}

/** Text of a tool_result block's content (string or array of text blocks), first 160 chars. */
export function resultSummary(content) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) t = content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text || '' : '')).filter(Boolean).join(' ');
  return t.trim().slice(0, 160);
}

/** The result text itself, capped, so the transcript can expand a result line. */
export function resultDetail(content) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) t = content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text || '' : '')).filter(Boolean).join('\n');
  return t.trim().slice(0, 4000);
}

/** One line for a permission denial: the command, the file path, or the input as JSON. */
/** A failed tool_result whose text reads as a permission refusal rather than a tool failure. */
export const DENIED_RE = /permission|denied|not allowed|requires approval/i;

export function denialSummary(input) {
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string' && input.command) return input.command.slice(0, 160);
    if (typeof input.file_path === 'string' && input.file_path) return input.file_path.slice(0, 160);
  }
  return JSON.stringify(input ?? null).slice(0, 120);
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** True when `p` is strictly inside `root` (both absolute); a folder named "..x" is inside. */
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
const isSameOrInside = (root, p) => path.relative(root, p) === '' || isInside(root, p);

/** Utility errors raised before any request leaves: the API backend could not run this turn. */
const REFUSED_CODES = ['not_configured', 'budget_paused', 'budget_exceeded', 'concurrency_limit'];

/** The refusal as the person reads it in the transcript, one line ending in "Nothing was sent." */
export function refusalText(code, message) {
  const m = String(message || '').trim();
  if (code === 'not_configured' && /API key/.test(m)) return 'No API key: add one in Settings › API key. Nothing was sent.';
  const body = m.replace(/\s*Nothing was (sent or )?spent\.?$/i, '');
  return `${/[.!?]$/.test(body) ? body : `${body}.`} Nothing was sent.`;
}

/** An answer is an assistant turn that said something; a failure or a cancel with no text is not one.
 *  The client has the same rule in client/components/is-answer.js; tests/console.test.mjs holds them together. */
export const isAnswer = (t) => t.role !== 'user' && !((t.isError || t.cancelled) && !t.text);

/** Records written before refusals had their own shape read like new ones: no duration, no context line. */
/** A Claude Code turn kept before turns carried signedOut (2026-11-07): the CLI's own words say it had no sign-in. */
export function upgradeSignedOut(t) {
  if (t.signedOut || t.backend !== 'claude-code' || !t.isError || t.cancelled) return t;
  if ((t.events || []).some((e) => e.kind === 'tool') || !SIGNED_OUT_RE.test(String(t.text || ''))) return t;
  return { ...t, signedOut: true };
}

function upgradeRefusal(t) {
  const m = t.backend === 'api' && t.isError && !t.text && !t.refused ? String(t.error || '').match(/^(\w+): ([\s\S]*)$/) : null;
  if (!m || !REFUSED_CODES.includes(m[1])) return t;
  const { durationMs, contextUsed, ...rest } = t;
  return { ...rest, refused: m[1], error: refusalText(m[1], m[2]) };
}

export function createConsole({ dataDir, studioDir, studioOrigin = DEFAULT_STUDIO_ORIGIN, projectsDir = null, projectFolders = async () => [], studioProjectId = async () => null, claudeToken = async () => null, claudeTokenInfo = async () => ({ saved: false, savedAt: null, endsAbout: null }), loadProject, getSettings, utility, emit, env = process.env, companionContext = null, runs: registry = null, onTurnEnd = null }) {
  if (!dataDir || !studioDir) throw new Error('createConsole: dataDir and studioDir are required');
  const dir = path.join(dataDir, 'console');
  const runs = new Map(); // sessionId -> { runId, child?, cancelled, timedOut, timer }
  const versions = new Map(); // binary path -> version string | null
  const send = (type, payload) => { try { emit?.(type, payload); } catch { /* SSE must never break a run */ } };
  const fileOf = (id) => {
    if (!/^cs_[a-z0-9]+$/.test(String(id))) throw new HttpError(404, 'not_found', `Console session ${id} not found`);
    return path.join(dir, `${id}.json`);
  };

  async function settings() {
    const s = (await getSettings?.()) || {};
    return { ...CONSOLE_DEFAULTS, ...(s.console || {}) };
  }

  // ---------- backend resolution ----------
  function searchPath(names) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    const dirs = String((key && env[key]) || '').split(path.delimiter).filter(Boolean);
    dirs.push(path.join(os.homedir(), '.local', 'bin'));
    for (const d of dirs) for (const n of names) {
      const p = path.join(d.replace(/^"|"$/g, ''), n);
      if (isFile(p)) return p;
    }
    return null;
  }
  async function resolveClaude() {
    const fromEnv = env.ATELIER_CLAUDE_BIN;
    if (fromEnv) return isFile(fromEnv) ? fromEnv : null;
    const configured = (await settings()).claudePath;
    if (configured) return isFile(configured) ? configured : null;
    return searchPath(process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']);
  }
  /** [command, leadingArgs, useShell] for a resolved binary. */
  function launcher(bin) {
    if (/\.(m?js)$/i.test(bin)) return [process.execPath, [bin], false];
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) return [`"${bin}"`, [], true];
    return [bin, [], false];
  }
  function versionOf(bin) {
    if (versions.has(bin)) return Promise.resolve(versions.get(bin));
    const [cmd, lead, shell] = launcher(bin);
    return new Promise((resolve) => {
      execFile(cmd, [...lead, '--version'], { timeout: 3000, windowsHide: true, shell, env: strippedEnv(env) }, (err, stdout) => {
        const v = err ? null : String(stdout).trim().split(/\r?\n/)[0].slice(0, 80) || null;
        versions.set(bin, v);
        resolve(v);
      });
    });
  }

  // ---------- Codex (server/lib/codex.mjs): the person's own Codex CLI, found, checked and run by its runner ----------
  const codex = createCodexRunner({
    env, settings, searchPath, launcher, versionOf, baseEnv: strippedEnv,
    mcpFor: (rec) => studioMcpConfig({ studioDir, studioOrigin, projectId: rec.projectId, sessionId: rec.id || null }).mcpServers.atelier,
    attachChild: (...a) => attachChild(...a), armTimeout: (...a) => armTimeout(...a), pushEvent: (...a) => pushEvent(...a), send, registry, toolWords,
  });

  // ---------- sign-in (decision row 129) ----------
  let authCache = null; // { at, value }: `claude auth status` takes a second or two, so a minute's answer is reused
  /** Whether the studio's claude runs have a sign-in: the CLI's own `auth status` in their env (it says what kind,
   *  it does not test the token: a real turn does), and what may be said about the studio's saved token. */
  async function authStatus({ fresh = false } = {}) {
    if (!fresh && authCache && Date.now() - authCache.at < 60000) return authCache.value;
    const bin = await resolveClaude();
    const token = await claudeToken().catch(() => null);
    const studioToken = await claudeTokenInfo().catch(() => ({ saved: false, savedAt: null, endsAbout: null }));
    let cli = null;
    if (bin) {
      const [cmd, lead, shell] = launcher(bin);
      cli = await new Promise((resolve) => {
        execFile(cmd, [...lead, 'auth', 'status', '--json'], { timeout: 15000, windowsHide: true, shell, env: claudeEnv(env, token) }, (err, stdout) => {
          try { const j = JSON.parse(String(stdout || '')); resolve({ loggedIn: j.loggedIn === true, authMethod: typeof j.authMethod === 'string' ? j.authMethod.slice(0, 40) : null }); } catch { resolve(null); }
        });
      });
    }
    const value = { cli: !!bin, loggedIn: cli ? cli.loggedIn : null, authMethod: cli ? cli.authMethod : null, studioToken, checkedAt: nowIso() };
    authCache = { at: Date.now(), value };
    return value;
  }

  async function backends() {
    const s = await settings();
    const bin = await resolveClaude();
    const version = bin ? await versionOf(bin) : null;
    let api = { id: 'api', available: false, detail: 'API utilities are not available in this studio.' };
    if (utility) {
      const st = await utility.status();
      const detail = !st.configured ? 'No API key. Settings › API key.' : st.paused ? 'API utilities are paused. Budget.' : st.model;
      api = { id: 'api', available: !!st.configured && !st.paused, detail };
    }
    const command = String(s.command || '').trim();
    const codexBin = await codex.resolve();
    const codexVersion = codexBin ? await versionOf(codexBin) : null;
    return {
      backends: [
        { id: 'claude-code', available: !!bin, detail: bin ? `${bin}${version ? ` · ${version}` : ''}` : 'claude CLI not found (set ATELIER_CLAUDE_BIN or Settings > console.claudePath)' },
        api,
        { id: 'command', available: !!command, detail: command ? `${command} (${s.commandMode})` : 'No command set. Settings › Console › Command.' },
        { id: 'codex', available: !!codexBin, detail: codexBin ? `${codexBin}${codexVersion ? ` · ${codexVersion}` : ''}` : CODEX_NO_CLI },
      ],
      models: [...CONSOLE_MODELS],
    };
  }

  // ---------- records ----------
  async function load(id) {
    const rec = await readJson(fileOf(id), null);
    if (!rec) throw new HttpError(404, 'not_found', `Console session ${id} not found`);
    if (rec.status === 'running' && !runs.has(id)) rec.status = 'idle'; // the studio restarted mid-run
    rec.turns = (rec.turns || []).map(upgradeRefusal).map(upgradeSignedOut);
    return rec;
  }
  async function save(rec) {
    rec.updatedAt = nowIso();
    await ensureDir(dir);
    await writeJson(fileOf(rec.id), rec);
    return rec;
  }

  async function listSessions({ projectId = null } = {}) {
    await ensureDir(dir);
    const out = [];
    for (const name of await fsp.readdir(dir)) {
      if (!/^cs_[a-z0-9]+\.json$/.test(name)) continue;
      try {
        const rec = await load(name.slice(0, -5));
        if (projectId && rec.projectId !== projectId) continue;
        const { turns, ...rest } = rec;
        const last = turns.at(-1);
        // asks: the last turn is an answer whose last paragraph is a question (the app bar's "needs you").
        const asks = !!last && last.role !== 'user' && !last.isError && !last.cancelled && asksQuestion(last.text);
        out.push({ ...rest, turnCount: turns.length, answerCount: turns.filter(isAnswer).length, asks });
      } catch { /* skip unreadable */ }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** Every session record whole, turns included: what the usage tally counts (server/lib/usage.mjs). */
  async function sessionRecords() {
    await ensureDir(dir);
    const out = [];
    for (const name of await fsp.readdir(dir)) {
      if (!/^cs_[a-z0-9]+\.json$/.test(name)) continue;
      try { out.push(await load(name.slice(0, -5))); } catch { /* skip unreadable */ }
    }
    return out;
  }

  /** Each entry resolved, or a 400 naming the folder: an existing folder inside the projects root,
   * the studio or a registered project. Relative forms are refused first, because on Windows
   * path.resolve('C:') is the server's own working folder on that drive, not the drive. */
  async function checkAddDirs(list) {
    const registered = (await projectFolders()).filter(Boolean).map((p) => path.resolve(p));
    return list.map((d) => {
      const refuse = (why) => new HttpError(400, 'invalid_input', `addDirs: ${d} ${why}`);
      if (!path.isAbsolute(d)) throw refuse('is not an absolute folder path');
      const full = path.resolve(d);
      const allowed = (projectsDir && isInside(path.resolve(projectsDir), full)) || isSameOrInside(path.resolve(studioDir), full) || registered.some((r) => isSameOrInside(r, full));
      if (!allowed) throw refuse('is outside the projects root, the studio and every registered project');
      if (!isDir(full)) throw refuse('is not an existing folder');
      return full;
    });
  }

  async function createSession({ backend = 'claude-code', projectId = null, model = null, permissionMode = 'acceptEdits', allowStudioCli = false, title = '', taskId = null, addDirs = [], tools = null, context = null, effort = null, worker = false, department = null, chrome = null, sandbox = null } = {}) {
    if (tools === '' || tools === 'none') tools = null;
    if (tools != null && !SESSION_TOOLS.includes(tools)) throw new HttpError(400, 'invalid_input', `tools must be ${SESSION_TOOLS.join(' or ')}, or left out`);
    if (context === '' || context === 'none') context = null;
    if (context != null && !SESSION_CONTEXTS.includes(context)) throw new HttpError(400, 'invalid_input', `context must be ${SESSION_CONTEXTS.join(' or ')}, or left out`);
    if (context === 'companion' && (backend !== 'claude-code' || !projectId)) throw new HttpError(400, 'invalid_input', 'context companion needs the claude-code backend and a projectId');
    // addDirs: extra folders the CLI may read and edit (--add-dir), e.g. a sibling product a studio task must copy from.
    if (addDirs == null) addDirs = [];
    if (!Array.isArray(addDirs) || addDirs.length > 8 || addDirs.some((d) => typeof d !== 'string' || !d.trim() || d.length > 500)) throw new HttpError(400, 'invalid_input', 'addDirs must be up to 8 folder paths');
    addDirs = addDirs.map((d) => d.trim());
    if (!CONSOLE_BACKENDS.includes(backend)) throw new HttpError(400, 'invalid_input', `backend must be one of ${CONSOLE_BACKENDS.join(', ')}`);
    if (backend === 'claude-code') {
      model = model || 'claude-opus-5-5';
      if (!CONSOLE_MODELS.includes(model)) throw new HttpError(400, 'invalid_input', `model must be one of ${CONSOLE_MODELS.join(', ')}`);
      addDirs = await checkAddDirs(addDirs);
    } else if (backend === 'api') {
      model = (await utility?.status?.())?.model || null; // the utility's model; informational
    } else if (backend === 'codex') {
      // What the person chose, else what ~/.codex/config.toml says; kept on the record, so the tab names what runs.
      // The sandbox is read-only unless they chose workspace-write (decision row 151).
      const choices = await codexChoices(codexHome(env));
      const m = model || choices.defaults.model || null;
      const kept = effort || (choices.defaults.effort && effortsOf(choices, m).includes(choices.defaults.effort) ? choices.defaults.effort : null);
      ({ model, effort, sandbox } = checkCodexChoice(choices, { model: m, effort: kept, sandbox: sandbox || CODEX_DEFAULT_SANDBOX }));
    } else model = null;
    if (backend !== 'codex' && sandbox != null) throw new HttpError(400, 'invalid_input', 'Only a Codex session has a sandbox');
    permissionMode = permissionMode || 'acceptEdits';
    if (!PERMISSION_MODES.includes(permissionMode)) throw new HttpError(400, 'invalid_input', `permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
    if (backend !== 'codex' && effort != null && effort !== '' && !EFFORTS.includes(effort)) throw new HttpError(400, 'invalid_input', `effort must be one of ${EFFORTS.join(', ')}`);
    if (chrome != null && typeof chrome !== 'boolean') throw new HttpError(400, 'invalid_input', 'chrome must be a boolean');
    if (allowStudioCli == null) allowStudioCli = false;
    if (typeof allowStudioCli !== 'boolean') throw new HttpError(400, 'invalid_input', 'allowStudioCli must be a boolean');
    if (typeof title !== 'string') title = '';
    if (taskId != null && !/^t_[a-z0-9]+$/.test(String(taskId))) throw new HttpError(400, 'invalid_input', 'taskId must be a task id');
    let cwd = studioDir;
    if (projectId) cwd = (await loadProject(projectId)).path;
    const now = nowIso();
    const rec = {
      id: newId('cs'), backend, projectId: projectId || null, cwd, title: shortLabel(title, 80), model,
      permissionMode: backend === 'claude-code' ? permissionMode : null,
      effort: (backend === 'claude-code' || backend === 'codex') && effort ? effort : null,
      ...(backend === 'codex' ? { sandbox, codexThreadId: null } : {}),
      // A companion session works in the person's Chrome unless they said no (claudeArgs reads rec.chrome !== false).
      chrome: backend === 'claude-code' && context === 'companion' ? chrome !== false : null,
      allowStudioCli: backend === 'claude-code' ? allowStudioCli : false,
      addDirs: backend === 'claude-code' ? addDirs : [],
      tools: backend === 'claude-code' || backend === 'codex' ? tools ?? null : null,
      context: context || null,
      taskId: taskId || null,
      // The bound task's department name, shown with the session's run (Processes); words only, the task holds the id.
      department: taskId && typeof department === 'string' && department.trim() ? shortLabel(department.trim(), 40) : null,
      worker: worker === true && backend === 'claude-code', // run by the manager's worker queue (server/lib/workers.mjs)
      claudeSessionId: null, status: 'idle', createdAt: now, updatedAt: now, turns: [],
    };
    return save(rec);
  }

  const getSession = (id) => load(id);

  /** The model, the permission mode or the effort of a Claude Code session, changed between turns (claudeArgs reads
   *  the record per turn, so the next turn runs with them; the CLI keeps the conversation through --resume). */
  async function patchSession(id, partial = {}) {
    const rec = await load(id);
    if (rec.backend === 'codex') {
      // A Codex session's model, effort and sandbox, changed between turns: codexArgs reads the record per turn.
      const { model, effort, sandbox, ...rest } = partial || {};
      for (const key of Object.keys(rest)) throw new HttpError(400, 'invalid_field', `Cannot patch ${key}`);
      Object.assign(rec, checkCodexChoice(await codexChoices(codexHome(env)), { model, effort, sandbox }, rec));
      return save(rec);
    }
    if (rec.backend !== 'claude-code') throw new HttpError(400, 'invalid_input', 'Only a Claude Code or Codex session has a model and an effort');
    const { model, permissionMode, effort, chrome, ...rest } = partial || {};
    for (const key of Object.keys(rest)) throw new HttpError(400, 'invalid_field', `Cannot patch ${key}`);
    if (model !== undefined) {
      if (!CONSOLE_MODELS.includes(model)) throw new HttpError(400, 'invalid_input', `model must be one of ${CONSOLE_MODELS.join(', ')}`);
      rec.model = model;
    }
    if (permissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(permissionMode)) throw new HttpError(400, 'invalid_input', `permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
      rec.permissionMode = permissionMode;
    }
    if (effort !== undefined) {
      if (effort !== null && effort !== '' && !EFFORTS.includes(effort)) throw new HttpError(400, 'invalid_input', `effort must be one of ${EFFORTS.join(', ')}, or null for the default`);
      rec.effort = effort || null;
    }
    if (chrome !== undefined) {
      if (typeof chrome !== 'boolean') throw new HttpError(400, 'invalid_input', 'chrome must be a boolean');
      if (rec.context !== 'companion') throw new HttpError(400, 'invalid_input', 'Only a companion session works in the person\'s Chrome');
      rec.chrome = chrome;
    }
    rec.updatedAt = nowIso();
    return save(rec);
  }

  async function deleteSession(id) {
    await load(id);
    if (runs.has(id)) await cancel(id);
    await fsp.rm(fileOf(id), { force: true });
    return { removed: id };
  }

  // ---------- runs ----------
  function pushEvent(turn, ev) {
    turn.events ||= [];
    if (turn.events.length < MAX_EVENTS) turn.events.push(ev);
  }

  async function finish(rec, turn, run, { error = null } = {}) {
    if (run.timer) clearTimeout(run.timer);
    if (!turn.refused) turn.durationMs ??= Date.now() - run.startedMs; // a refusal ran nothing, so it took no time
    if (run.cancelled) turn.cancelled = true;
    if (run.timedOut) { turn.timedOut = true; turn.error = `timed out after ${run.timeoutMs} ms`; }
    if (error) { turn.isError = true; turn.error = error; }
    turn.at = nowIso();
    rec.turns.push(turn);
    rec.status = 'idle';
    runs.delete(rec.id);
    try { await save(rec); } catch (err) { console.error('[atelier] console save failed', err.message); }
    // The Working now row: how the turn ended, as the turn itself records it (server/lib/runs.mjs).
    registry?.end(run.runId, sessionEnd(turn));
    if (error && !run.cancelled) send('console.error', { sessionId: rec.id, runId: run.runId, message: error, turn });
    else send('console.done', { sessionId: rec.id, runId: run.runId, turn });
    // The worker queue hears every turn's end: a worker's ends its task's run, a companion's lets a held report through.
    if (onTurnEnd) Promise.resolve().then(() => onTurnEnd(rec, turn)).catch((err) => console.error('[atelier] turn end hook failed', err.message));
  }

  function armTimeout(rec, run, timeoutMs) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : CONSOLE_DEFAULTS.timeoutMs;
    run.timeoutMs = ms;
    run.timer = setTimeout(() => { run.timedOut = true; cancel(rec.id); }, ms);
    run.timer.unref?.();
  }

  function attachChild(rec, turn, run, child, { onStdoutLine, onStderr, onExit }) {
    run.child = child;
    let buf = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onStdoutLine(line, false);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-STDERR_TAIL);
      onStderr?.(d);
    });
    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    let done = false;
    const end = (fn) => { if (done) return; done = true; fn(); };
    child.on('error', (err) => end(() => finish(rec, turn, run, { error: `could not start: ${err.message}` })));
    child.on('close', (code, signal) => end(() => {
      if (buf) onStdoutLine(buf.replace(/\r$/, ''), true);
      turn.exitCode = code;
      const error = onExit(code, signal, stderr.trim());
      finish(rec, turn, run, { error });
    }));
  }

  async function runClaude(rec, text, run, { pack = null } = {}) {
    const bin = await resolveClaude();
    if (!bin) throw new HttpError(503, 'console_no_claude', 'claude CLI not found (set ATELIER_CLAUDE_BIN or Settings > console.claudePath)');
    const s = await settings();
    const args = claudeArgs(rec, { studioDir, studioOrigin, studioProjectId: rec.context === 'companion' ? await studioProjectId().catch(() => null) : null }); // argv entries, no shell quoting
    const [cmd, lead, shell] = launcher(bin);
    const turn = { role: 'assistant', text: '', at: nowIso(), backend: 'claude-code', events: [] };
    if (pack) turn.contextUsed = CONTEXT_PACK_LABEL;
    const token = await claudeToken().catch(() => null); // the studio's own sign-in, if the person saved one
    const child = spawn(cmd, [...lead, ...args], { cwd: rec.cwd, env: claudeEnv(env, token), windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunk = (c) => send('console.chunk', { sessionId: rec.id, runId: run.runId, ...c });
    const status = (t) => { pushEvent(turn, { kind: 'status', name: 'status', summary: t.slice(0, 300) }); chunk({ kind: 'status', text: t }); };
    let resultText = '';
    const toolNames = new Map(); // tool_use_id -> tool name, for tool_result blocks
    const toolInputs = new Map(); // tool_use_id -> tool input, for a denied event's summary
    const deniedIds = new Set(); // tool_use_ids already shown as denied during the run
    const onLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { status(line); return; }
      if (!ev || typeof ev !== 'object') { status(line); return; }
      if (ev.session_id && /^[\w-]{1,128}$/.test(ev.session_id)) rec.claudeSessionId = ev.session_id;
      if (ev.type === 'system' && ev.subtype === 'init') {
        if (ev.model) turn.model = ev.model;
      } else if (ev.type === 'assistant') {
        // The turn's model is the session's own: a sub-agent's message (parent_tool_use_id) names the sub-agent's model.
        if (ev.message?.model && !ev.parent_tool_use_id) turn.model = ev.message.model;
        for (const b of ev.message?.content || []) {
          if (b?.type === 'text' && b.text) {
            const piece = turn.text && !/\n$/.test(turn.text) ? `\n\n${b.text}` : b.text;
            turn.text += piece;
            chunk({ kind: 'text', text: piece });
          } else if (b?.type === 'tool_use') {
            if (b.id) { toolNames.set(String(b.id), String(b.name || 'tool')); toolInputs.set(String(b.id), b.input); }
            const summary = toolSummary(b.input);
            const id = String(b.id || '');
            const ms = Date.now() - run.startedMs; // when in the run the call came: the trajectory's time column
            pushEvent(turn, { kind: 'tool', id, name: String(b.name || 'tool'), summary, ms });
            chunk({ kind: 'tool', id, name: String(b.name || 'tool'), summary, ms });
            registry?.update(run.runId, { latest: toolWords(b.name, summary) });
          }
        }
      } else if (ev.type === 'user') {
        const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const id = String(b.tool_use_id || '');
          const name = toolNames.get(id) || 'tool';
          const ok = !b.is_error;
          const text = resultSummary(b.content);
          if (!ok && DENIED_RE.test(text)) { // a refusal, shown as denied at once rather than as a failure
            const summary = denialSummary(toolInputs.get(id));
            if (id) deniedIds.add(id);
            pushEvent(turn, { kind: 'denied', id, name, summary });
            chunk({ kind: 'denied', id, name, summary });
            continue;
          }
          const detail = resultDetail(b.content);
          pushEvent(turn, { kind: 'tool-result', id, name, ok, summary: text, detail });
          chunk({ kind: 'tool-result', id, name, ok, summary: text, detail });
        }
      } else if (ev.type === 'result') {
        if (ev.usage) turn.usage = ev.usage;
        if (ev.modelUsage) turn.modelUsage = ev.modelUsage;
        if (typeof ev.total_cost_usd === 'number') turn.costUsd = ev.total_cost_usd; // list-price equivalent, not a charge
        if (typeof ev.duration_ms === 'number') turn.durationMs = ev.duration_ms;
        if (ev.is_error) turn.isError = true;
        const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0;
        for (const d of denials ? ev.permission_denials : []) {
          const name = String(d?.tool_name || 'tool');
          const summary = denialSummary(d?.tool_input);
          // already shown during the run: same tool_use_id, or (without one) the same tool and summary
          if (d?.tool_use_id ? deniedIds.has(String(d.tool_use_id)) : turn.events.some((e) => e.kind === 'denied' && e.name === name && e.summary === summary)) continue;
          const id = String(d?.tool_use_id || '');
          pushEvent(turn, { kind: 'denied', id, name, summary });
          chunk({ kind: 'denied', id, name, summary });
        }
        if (denials) status(`${denials} permission denial(s) (permission mode ${rec.permissionMode})`);
        if (typeof ev.result === 'string') resultText = ev.result;
      }
    };
    attachChild(rec, turn, run, child, {
      onStdoutLine: onLine,
      onExit: (code, signal, stderr) => {
        if (!turn.text && resultText) { turn.text = resultText; chunk({ kind: 'text', text: resultText }); }
        if (run.cancelled) return null;
        // No working sign-in: the CLI failed before any model call. The turn says so, so the person is told what to do.
        if ((code !== 0 || turn.isError) && !turn.events.some((e) => e.kind === 'tool') && SIGNED_OUT_RE.test(`${turn.text}\n${resultText}\n${stderr}`)) {
          turn.signedOut = true;
          authCache = null;
        }
        if (code !== 0) return `claude exited with ${code ?? signal}${stderr ? `: ${stderr.slice(-600)}` : ''}`;
        return null;
      },
    });
    armTimeout(rec, run, rec.worker ? WORKER_TIMEOUT_MS : s.timeoutMs);
    child.stdin.end(pack ? withContextPack(pack, text) : text);
  }

  async function runCommand(rec, text, context, run, s) {
    const command = String(s.command || '').trim();
    const mode = s.commandMode === 'arg' ? 'arg' : 'stdin';
    let line = command;
    let input = '';
    let contextUsed = 'none';
    if (mode === 'arg') {
      // A command line has no room for a briefing (Windows caps it near 8 KB): the text only.
      const quoted = JSON.stringify(text);
      line = command.includes('{prompt}') ? command.split('{prompt}').join(quoted) : `${command} ${quoted}`;
    } else if (context === 'briefing') {
      // Same source as the API backend: the project's .studio/BRIEFING.md.
      const brief = (await briefingText(rec)).trim();
      input = brief ? `Project briefing:\n${brief}\n\n---\n\nMessage:\n${text}\n` : text;
      if (brief) contextUsed = 'briefing';
    } else {
      const prior = rec.turns.slice(0, -1).slice(-10);
      const withHistory = context === 'history' && prior.length > 0;
      input = withHistory ? `${prior.map((t) => `${t.role}: ${t.text}`).join('\n')}\nuser: ${text}\n` : text;
      if (withHistory) contextUsed = 'history';
    }
    const turn = { role: 'assistant', text: '', at: nowIso(), backend: 'command', command, contextUsed, events: [] };
    if (context !== 'none' && contextUsed === 'none') {
      pushEvent(turn, { kind: 'status', name: 'context', summary: mode === 'arg' ? `${context} not sent: this command takes the message as an argument` : `no ${context} to send` });
    }
    const child = spawn(line, { cwd: rec.cwd, env: strippedEnv(env), windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunk = (c) => send('console.chunk', { sessionId: rec.id, runId: run.runId, ...c });
    attachChild(rec, turn, run, child, {
      onStdoutLine: (l, last) => {
        const piece = last ? l : `${l}\n`;
        turn.text += piece;
        chunk({ kind: 'text', text: piece });
      },
      onStderr: (d) => {
        pushEvent(turn, { kind: 'status', name: 'stderr', summary: String(d).trim().slice(0, 300) });
        chunk({ kind: 'status', text: String(d) });
      },
      onExit: (code, signal, stderr) => {
        turn.text = turn.text.replace(/\n$/, '');
        if (run.cancelled) return null;
        return code === 0 ? null : `command exited with ${code ?? signal}${stderr ? `: ${stderr.slice(-600)}` : ''}`;
      },
    });
    armTimeout(rec, run, s.timeoutMs);
    child.stdin.end(input);
  }

  async function briefingText(rec) {
    const base = rec.projectId ? (await loadProject(rec.projectId)).path : studioDir;
    try { return (await fsp.readFile(path.join(base, '.studio', 'BRIEFING.md'), 'utf8')).slice(0, 40000); } catch { return ''; }
  }

  async function runApi(rec, context, run) {
    const messages = rec.turns.filter((t) => !t.isError && t.text).slice(-20).map((t) => ({ role: t.role, text: String(t.text).slice(0, MAX_TEXT) }));
    const input = { messages, context: context === 'briefing' ? await briefingText(rec) : '' };
    // The API backend always sends the recent turns; the briefing only when asked for and present.
    const contextUsed = input.context ? 'briefing' : messages.length > 1 ? 'history' : 'none';
    const turn = { role: 'assistant', text: '', at: nowIso(), backend: 'api', contextUsed, events: [] };
    let result;
    try {
      result = await utility.run('console-chat', { projectId: rec.projectId, input }, { runId: run.runId, track: false }); // the session's row is this run
    } catch (err) {
      if (REFUSED_CODES.includes(err.code)) {
        // Nothing left this machine: an error turn with no context, duration or cost.
        delete turn.contextUsed;
        turn.refused = err.code;
        await finish(rec, turn, run, { error: refusalText(err.code, err.message) });
      } else {
        if (typeof err.costUsd === 'number' && err.costUsd > 0) turn.costUsd = err.costUsd; // attempts that were billed before the failure
        await finish(rec, turn, run, { error: `${err.code || 'error'}: ${err.message}` });
      }
      throw err; // UtilityError unchanged: the HTTP layer maps it like every utility
    }
    turn.text = String(result?.output?.reply ?? result?.reply ?? '');
    if (result?.model) { turn.model = result.model; if (result.usage) turn.modelUsage = { [result.model]: result.usage }; }
    if (result?.usage) turn.usage = result.usage;
    if (typeof result?.costUsd === 'number') turn.costUsd = result.costUsd;
    if (typeof result?.durationMs === 'number') turn.durationMs = result.durationMs;
    send('console.chunk', { sessionId: rec.id, runId: run.runId, kind: 'text', text: turn.text });
    await finish(rec, turn, run);
  }

  /** What a Codex turn reads on stdin. Codex has no system prompt flag, so the first message opens with its role,
   *  the tools' sentence and the sandbox it runs in, then the context pack; a later message opens with the sandbox
   *  only when the person changed it since Codex was last told. The record keeps the person's words alone. */
  function codexInput(rec, text, { first, pack }) {
    const sandbox = rec.sandbox || CODEX_DEFAULT_SANDBOX;
    const told = rec.sandboxTold === sandbox;
    rec.sandboxTold = sandbox;
    if (first) {
      const role = [CODEX_ROLE, rec.tools === 'studio' ? CODEX_TOOLS_SENTENCE : null, codexSandboxSentence(sandbox)].filter(Boolean).join(' ');
      return withContextPack(pack ? `${role}\n\n${pack}` : role, text);
    }
    return told ? text : `[Studio: the person changed the sandbox. ${codexSandboxSentence(sandbox)}]\n\n${text}`;
  }

  async function sendMessage(id, { text, context = 'none' } = {}) {
    fileOf(id);
    if (runs.has(id)) throw new HttpError(409, 'console_busy', 'This console session is already running a turn');
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'invalid_input', 'text is required');
    if (text.length > MAX_TEXT) throw new HttpError(400, 'invalid_input', `text must be at most ${MAX_TEXT} characters`);
    context = context || 'none';
    if (!CONTEXTS.includes(context)) throw new HttpError(400, 'invalid_input', `context must be one of ${CONTEXTS.join(', ')}`);
    const run = { runId: newId('cr'), cancelled: false, timedOut: false, timer: null, child: null, startedMs: Date.now() };
    runs.set(id, run); // claimed synchronously so a second send gets 409
    try {
      const rec = await load(id);
      const s = await settings();
      if (rec.backend === 'command' && !String(s.command || '').trim()) throw new HttpError(400, 'console_no_command', 'No command set. Settings › Console › Command.');
      if (rec.backend === 'claude-code' && !(await resolveClaude())) throw new HttpError(503, 'console_no_claude', 'claude CLI not found (set ATELIER_CLAUDE_BIN or Settings > console.claudePath)');
      if (rec.backend === 'api' && !utility) throw new HttpError(503, 'not_configured', 'API utility unavailable');
      if (rec.backend === 'codex') await codex.ready(); // no CLI, or signed out: a 503 with what to do, before anything is recorded
      // A companion session's first message carries the context pack; later ones resume the same conversation.
      // A Codex session's first message carries it too when it has a project, after its role (see codexInput).
      const first = !rec.turns.some((t) => t.role === 'user');
      let pack = null;
      if (first && companionContext && ((rec.backend === 'claude-code' && rec.context === 'companion') || (rec.backend === 'codex' && rec.projectId))) {
        try { pack = await companionContext(rec); } catch (err) { console.error('[atelier] companion context failed', err.message); }
      }
      const codexText = rec.backend === 'codex' ? codexInput(rec, text, { first, pack }) : null;
      rec.turns.push({ role: 'user', text, at: nowIso(), context, ...(pack ? { contextPack: pack.split('\n').length } : {}) });
      if (!rec.title) rec.title = titleOf(text);
      rec.status = 'running';
      await save(rec);
      send('console.started', { sessionId: id, runId: run.runId });
      registry?.start({ id: run.runId, kind: 'session', projectId: rec.projectId, name: sessionName(rec), department: rec.department || null });
      if (rec.backend === 'claude-code') await runClaude(rec, text, run, { pack });
      else if (rec.backend === 'codex') await codex.run(rec, codexText, run, { contextUsed: pack ? CONTEXT_PACK_LABEL : null });
      else if (rec.backend === 'command') await runCommand(rec, text, context, run, s);
      else await runApi(rec, context, run);
      return { runId: run.runId };
    } catch (err) {
      registry?.end(run.runId, { state: 'Failed', reason: err.message }); // nothing when it never started or already ended
      if (runs.get(id) === run && !run.child) {
        runs.delete(id);
        try { const rec = await load(id); if (rec.status === 'running') { rec.status = 'idle'; await save(rec); } } catch { /* gone */ }
      }
      throw err;
    }
  }

  async function cancel(id) {
    const run = runs.get(id);
    if (!run) return { cancelled: false };
    run.cancelled = true;
    if (run.child?.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      } else run.child.kill('SIGTERM');
    } else if (utility && run.runId) utility.cancel(run.runId);
    return { cancelled: true, runId: run.runId };
  }

  /** Whether a turn of this session runs in this process now (the worker queue's restart check). */
  const isRunning = (id) => runs.has(id);

  return { backends, authStatus, codexStatus: (opts) => codex.status(opts), listSessions, sessionRecords, createSession, getSession, patchSession, deleteSession, send: sendMessage, cancel, isRunning };
}
