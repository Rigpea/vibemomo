// The Codex console backend (server/lib/codex.mjs) with a fake codex CLI (tests/fixtures/fake-codex.mjs) and a temp
// CODEX_HOME. No real codex and no network. Risks covered: the JSONL stream must become the turn and events every
// backend records; a second message must resume the thread Codex named; the child must never see OPENAI_API_KEY or
// the host Claude Code session variables; the sandbox must be read-only unless chosen and never anything else; the
// model and effort must be config.toml's unless chosen; no CLI, signed out and a refused model must each say what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConsole } from '../server/lib/console.mjs';
import { codexArgs, createCodexParser, parseCodexConfig, parseCodexModels, codexChoices, checkCodexChoice, commandWords, codexErrorOf, parseLoginStatus, dropCodexKeys, CODEX_FALLBACK_MODELS, CODEX_NO_CLI, CODEX_SIGNED_OUT } from '../server/lib/codex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-codex.mjs');
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');

const CACHE = { models: [
  { slug: 'gpt-b', display_name: 'GPT-B', visibility: 'list', priority: 2, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
  { slug: 'gpt-a', display_name: 'GPT-A', visibility: 'list', priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
  { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 3, supported_reasoning_levels: [{ effort: 'low' }] },
  { slug: 'gpt-refused', display_name: 'GPT-Refused', visibility: 'list', priority: 4, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
] };
const CONFIG = 'model = "gpt-a"\nmodel_reasoning_effort = "high"\n\n[tui]\nmodel = "not-this-one"\n\n[mcp_servers.node_repl]\ncommand = "node"\n';

function setup({ env = {}, config = CONFIG, cache = CACHE, companionContext = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-codex-'));
  const studioDir = path.join(root, 'studio');
  const projectDir = path.join(root, 'project');
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(path.join(studioDir, 'bin'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(home);
  if (config != null) fs.writeFileSync(path.join(home, 'config.toml'), config);
  if (cache != null) fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(cache));
  const events = [];
  const c = createConsole({
    dataDir: path.join(root, 'data'), studioDir, studioOrigin: 'http://127.0.0.1:4999',
    projectFolders: async () => [projectDir],
    loadProject: async (id) => ({ path: projectDir, project: { id } }),
    getSettings: async () => ({ console: {} }),
    emit: (type, payload) => events.push({ type, payload }),
    env: { ...process.env, ATELIER_CLAUDE_BIN: FAKE_CLAUDE, ATELIER_CODEX_BIN: FAKE, CODEX_HOME: home, FAKE_CODEX_LOGIN: 'chatgpt', ...env },
    companionContext,
  });
  const finished = async (runId, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = events.find((e) => (e.type === 'console.done' || e.type === 'console.error') && e.payload.runId === runId);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting; events: ${events.map((e) => e.type).join(',')}`);
  };
  const statusLines = (turn, word) => turn.events.filter((e) => e.kind === 'status' && e.summary.startsWith(`${word} `)).map((e) => e.summary);
  return { c, events, finished, root, projectDir, studioDir, home, statusLines };
}

// ---------- the pure parts ----------
test('config.toml: only the top-level model and effort are read, never a table\'s', () => {
  assert.deepEqual(parseCodexConfig(CONFIG), { model: 'gpt-a', effort: 'high' });
  assert.deepEqual(parseCodexConfig("# none\nmodel = 'gpt-6-astra' # mine\n[profiles.x]\nmodel_reasoning_effort = \"low\"\n"), { model: 'gpt-6-astra', effort: null });
  assert.deepEqual(parseCodexConfig('[tui]\nmodel = "x"\n'), { model: null, effort: null });
  assert.deepEqual(parseCodexConfig('model = "--bad flag"\n'), { model: null, effort: null }, 'a value that is not a model id is not passed on');
});

test('models_cache.json: listed models in Codex\'s order with their efforts; hidden ones left out', () => {
  const models = parseCodexModels(CACHE);
  assert.deepEqual(models.map((m) => m.id), ['gpt-a', 'gpt-b', 'gpt-refused']);
  assert.deepEqual(models[0], { id: 'gpt-a', name: 'GPT-A', efforts: ['low', 'high', 'ultra'], defaultEffort: 'low' });
  assert.deepEqual(parseCodexModels({}), []);
  assert.deepEqual(parseCodexModels(null), []);
});

test('choices: the cache and config when readable, else the built-in list and no defaults', async () => {
  const { home, root } = setup();
  const a = await codexChoices(home);
  assert.equal(a.source, 'models_cache.json');
  assert.deepEqual(a.defaults, { model: 'gpt-a', effort: 'high' });
  const b = await codexChoices(path.join(root, 'nowhere'));
  assert.equal(b.source, 'built-in');
  assert.deepEqual(b.models.map((m) => m.id), CODEX_FALLBACK_MODELS.map((m) => m.id));
  assert.deepEqual(b.defaults, { model: null, effort: null });
  assert.equal(b.configRead, false);
  // A config model the list does not hold (a hidden one) can still be the chosen model.
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-hidden"\n');
  assert.equal((await codexChoices(home)).models[0].id, 'gpt-hidden');
});

test('argv: exec --json with the sandbox, model and effort; resume names the thread; never a bypass', () => {
  const first = codexArgs({ model: 'gpt-a', effort: 'high', sandbox: 'read-only' });
  assert.deepEqual(first, ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-a', '-c', 'model_reasoning_effort="high"', '-c', 'sandbox_mode="read-only"', '-']);
  const again = codexArgs({ model: 'gpt-a', sandbox: 'workspace-write', codexThreadId: '01a1d72b-7a98-7dd1-b518-80156c8ba227' });
  assert.deepEqual(again, ['exec', 'resume', '--json', '--skip-git-repo-check', '-m', 'gpt-a', '-c', 'sandbox_mode="workspace-write"', '01a1d72b-7a98-7dd1-b518-80156c8ba227', '-']);
  assert.deepEqual(codexArgs({}).slice(-3), ['-c', 'sandbox_mode="read-only"', '-'], 'no sandbox on the record is read-only');
  assert.throws(() => codexArgs({ sandbox: 'danger-full-access' }), /sandbox must be read-only or workspace-write/);
  assert.throws(() => codexArgs({ sandbox: 'none' }), /sandbox must be/);
  // A thread id that could read as a flag is not passed (the run starts a new thread instead).
  assert.ok(!codexArgs({ codexThreadId: '--dangerously-bypass-approvals-and-sandbox' }).some((a) => a.startsWith('--dangerously')));
  const mcp = codexArgs({ sandbox: 'read-only' }, { mcp: { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\studio\\bin\\atelier-mcp.mjs', '--studio', 'http://127.0.0.1:4747', '--project', 'p_x'], env: { ATELIER_SESSION_ID: 'cs_abc' } } });
  assert.ok(mcp.includes('mcp_servers.atelier.command="C:\\\\Program Files\\\\nodejs\\\\node.exe"'));
  assert.ok(mcp.includes('mcp_servers.atelier.args=["C:\\\\studio\\\\bin\\\\atelier-mcp.mjs","--studio","http://127.0.0.1:4747","--project","p_x"]'));
  assert.ok(mcp.includes('mcp_servers.atelier.env={ATELIER_SESSION_ID="cs_abc"}'));
  assert.ok(mcp.includes('mcp_servers.atelier.default_tools_approval_mode="approve"'));
  for (const a of [...first, ...again, ...mcp]) assert.ok(!/danger|bypass|approval_policy/.test(a), a);
});

test('a choice is checked against what Codex offers: unknown model, effort or sandbox is a 400', async () => {
  const { home } = setup();
  const choices = await codexChoices(home);
  assert.deepEqual(checkCodexChoice(choices, { model: 'gpt-b', effort: 'medium', sandbox: 'workspace-write' }), { model: 'gpt-b', effort: 'medium', sandbox: 'workspace-write' });
  assert.throws(() => checkCodexChoice(choices, { model: 'gpt-nope' }), (e) => e.status === 400 && /model must be one of gpt-a, gpt-b, gpt-refused/.test(e.message));
  assert.throws(() => checkCodexChoice(choices, { effort: 'ultra' }, { model: 'gpt-b' }), (e) => e.status === 400 && /effort must be one of low, medium, high for gpt-b/.test(e.message));
  // A model change that would leave an effort the new model lacks is refused: the person picks, nothing is moved.
  assert.throws(() => checkCodexChoice(choices, { model: 'gpt-b' }, { model: 'gpt-a', effort: 'ultra' }), (e) => e.status === 400);
  assert.deepEqual(checkCodexChoice(choices, { model: 'gpt-b', effort: null }, { model: 'gpt-a', effort: 'ultra' }), { model: 'gpt-b', effort: null });
  for (const sandbox of ['danger-full-access', 'none', '', null]) assert.throws(() => checkCodexChoice(choices, { sandbox }), (e) => e.status === 400 && /never runs Codex without a sandbox/.test(e.message));
});

test('words: a wrapped command reads as typed; Codex\'s JSON error gives its message; login status in words', () => {
  assert.equal(commandWords('"C:\\\\Users\\\\x\\\\pwsh.exe" -Command \'git status --short\''), 'git status --short');
  assert.equal(commandWords('bash -lc "npm test"'), 'npm test');
  assert.equal(commandWords('git log -3'), 'git log -3');
  assert.equal(commandWords('git -c core.quotepath=off status'), 'git -c core.quotepath=off status', 'a -c of the command itself is not a shell wrapper');
  assert.equal(commandWords('/bin/zsh -lc \'ls src\''), 'ls src');
  assert.equal(commandWords('cmd.exe /c dir'), 'dir');
  assert.deepEqual(codexErrorOf('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported.","code":"model_not_found"}}'), { message: 'The model is not supported.', code: 'model_not_found', status: 400 });
  assert.deepEqual(codexErrorOf('stream disconnected'), { message: 'stream disconnected', code: null, status: null });
  assert.deepEqual(parseLoginStatus('Logged in using ChatGPT\n'), { loggedIn: true, login: 'chatgpt' });
  assert.deepEqual(parseLoginStatus('Logged in using an API key - sk-***\n'), { loggedIn: true, login: 'api-key' });
  assert.deepEqual(parseLoginStatus('', 'Not logged in\n'), { loggedIn: false, login: null });
  assert.deepEqual(parseLoginStatus('', ''), { loggedIn: null, login: null });
  assert.deepEqual(Object.keys(dropCodexKeys({ PATH: 'x', OpenAI_Api_Key: 'k', CODEX_API_KEY: 'k', CODEX_ACCESS_TOKEN: 't', CODEX_HOME: 'h' })), ['PATH', 'CODEX_HOME']);
});

test('the parser: messages join, a command is a call and its result, a refused MCP call is denied, usage is kept', () => {
  const turn = { text: '', events: [] };
  const streamed = [];
  let threadId = null;
  let t = 1000;
  const p = createCodexParser({ turn, startedMs: 1000, now: () => t, event: (e) => { turn.events.push(e); streamed.push(e.kind); }, text: (x) => streamed.push(`text:${x.length}`), thread: (id) => { threadId = id; } });
  const feed = (o) => p.line(JSON.stringify(o));
  feed({ type: 'thread.started', thread_id: '01a1d72b-7a98' });
  feed({ type: 'turn.started' });
  feed({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'First.\n' } });
  t = 3000;
  feed({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "git status"', aggregated_output: '', exit_code: null, status: 'in_progress' } });
  feed({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "git status"', aggregated_output: 'clean\n', exit_code: 0, status: 'completed' } });
  feed({ type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', server: 'atelier', tool: 'atelier_read_file', arguments: { path: 'src/a.js' }, result: { content: [{ type: 'text', text: 'line one' }] }, error: null, status: 'completed' } });
  feed({ type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'x', tool: 'y', arguments: {}, result: null, error: { message: 'MCP tool call requires approval, but approval policy is never' }, status: 'failed' } });
  feed({ type: 'item.started', item: { id: 'item_4', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }, { path: 'b.js', kind: 'add' }, { path: 'c.js', kind: 'delete' }], status: 'in_progress' } });
  feed({ type: 'item.completed', item: { id: 'item_4', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }, { path: 'b.js', kind: 'add' }, { path: 'c.js', kind: 'delete' }], status: 'completed' } });
  feed({ type: 'item.completed', item: { id: 'item_5', type: 'command_execution', command: 'rm x', aggregated_output: 'denied by sandbox', exit_code: 1, status: 'failed' } });
  feed({ type: 'item.completed', item: { id: 'item_6', type: 'reasoning', text: 'Thinking about it' } });
  p.line('a plain warning line');
  feed({ type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: 'Second.' } });
  feed({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 } });

  assert.equal(threadId, '01a1d72b-7a98');
  assert.equal(turn.text, 'First.\n\nSecond.');
  const calls = turn.events.filter((e) => e.kind === 'tool').map((e) => `${e.name} ${e.summary}`);
  assert.deepEqual(calls, ['Shell git status', 'mcp__atelier__atelier_read_file src/a.js', 'mcp__x__y ', 'Edit a.js', 'Write b.js', 'Delete c.js', 'Shell rm x']);
  assert.equal(turn.events.find((e) => e.kind === 'tool' && e.id === 'item_1').ms, 2000, 'ms since the run began');
  assert.deepEqual(turn.events.find((e) => e.kind === 'tool-result' && e.id === 'item_1'), { kind: 'tool-result', id: 'item_1', name: 'Shell', ok: true, summary: 'clean', detail: 'clean' });
  assert.equal(turn.events.find((e) => e.kind === 'tool-result' && e.id === 'item_2').summary, 'line one');
  assert.deepEqual(turn.events.find((e) => e.kind === 'denied'), { kind: 'denied', id: 'item_3', name: 'mcp__x__y', summary: 'MCP tool call requires approval, but approval policy is never' });
  assert.equal(turn.events.find((e) => e.kind === 'tool-result' && e.id === 'item_5').ok, false);
  assert.ok(turn.events.some((e) => e.kind === 'status' && e.name === 'reasoning' && e.summary === 'Thinking about it'));
  assert.ok(turn.events.some((e) => e.kind === 'status' && e.summary === 'a plain warning line'));
  assert.deepEqual(turn.usage, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4, reasoning_output_tokens: 1 });
  assert.deepEqual(p.result({ code: 0 }), { error: null, signedOut: false, modelRefused: false });
});

test('the parser: a refused model and a missing login each end in one sentence saying what to do', () => {
  const refused = createCodexParser({ turn: { text: '', events: [] } });
  refused.line(JSON.stringify({ type: 'turn.failed', error: { message: '{"type":"error","status":400,"error":{"message":"The \'gpt-x\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}' } }));
  const r = refused.result({ code: 1, model: 'gpt-x' });
  assert.equal(r.modelRefused, true);
  assert.match(r.error, /^Codex refused the model gpt-x: choose another model in the tab and send the message again\. Codex said: The 'gpt-x' model is not supported/);
  const out = createCodexParser({ turn: { text: '', events: [] } });
  const o = out.result({ code: 1, stderr: 'Error: Not logged in. Run `codex login`.' });
  assert.equal(o.signedOut, true);
  assert.ok(o.error.startsWith(CODEX_SIGNED_OUT));
  const other = createCodexParser({ turn: { text: '', events: [] } });
  other.line(JSON.stringify({ type: 'error', message: 'stream disconnected before completion' }));
  assert.deepEqual(other.result({ code: 1 }), { error: 'Codex: stream disconnected before completion', signedOut: false, modelRefused: false });
  assert.deepEqual(createCodexParser({ turn: { text: '', events: [] } }).result({ code: 1, cancelled: true }), { error: null, signedOut: false, modelRefused: false });
});

// ---------- through the console, with the fake CLI ----------
test('codex: a session takes config.toml\'s model and effort and the read-only sandbox unless chosen', async () => {
  const { c, projectDir } = setup();
  const s = await c.createSession({ backend: 'codex', projectId: 'p_x' });
  assert.equal(s.backend, 'codex');
  assert.equal(s.model, 'gpt-a');
  assert.equal(s.effort, 'high');
  assert.equal(s.sandbox, 'read-only');
  assert.equal(s.cwd, projectDir);
  assert.equal(s.codexThreadId, null);
  assert.equal(s.permissionMode, null);
  const chosen = await c.createSession({ backend: 'codex', projectId: 'p_x', model: 'gpt-b', effort: 'low', sandbox: 'workspace-write', tools: 'studio' });
  assert.deepEqual([chosen.model, chosen.effort, chosen.sandbox, chosen.tools], ['gpt-b', 'low', 'workspace-write', 'studio']);
  // config's effort is not forced onto a model that does not take it
  const other = await c.createSession({ backend: 'codex', projectId: 'p_x', model: 'gpt-refused' });
  assert.equal(other.effort, 'high');
  fs.writeFileSync(path.join(path.dirname(projectDir), 'codex-home', 'config.toml'), 'model = "gpt-a"\nmodel_reasoning_effort = "ultra"\n');
  assert.equal((await c.createSession({ backend: 'codex', projectId: 'p_x', model: 'gpt-b' })).effort, null);
});

test('codex: an unknown sandbox, model or effort is refused, at create and at patch; other backends take no sandbox', async () => {
  const { c } = setup();
  for (const sandbox of ['danger-full-access', 'full', 'off']) {
    await assert.rejects(c.createSession({ backend: 'codex', projectId: 'p_x', sandbox }), (e) => e.status === 400 && /sandbox must be read-only or workspace-write/.test(e.message));
  }
  await assert.rejects(c.createSession({ backend: 'codex', projectId: 'p_x', model: 'gpt-nope' }), (e) => e.status === 400);
  await assert.rejects(c.createSession({ backend: 'codex', projectId: 'p_x', effort: 'max' }), (e) => e.status === 400);
  await assert.rejects(c.createSession({ backend: 'claude-code', projectId: 'p_x', sandbox: 'read-only' }), (e) => e.status === 400 && /Only a Codex session has a sandbox/.test(e.message));
  const s = await c.createSession({ backend: 'codex', projectId: 'p_x' });
  await assert.rejects(c.patchSession(s.id, { sandbox: 'danger-full-access' }), (e) => e.status === 400);
  await assert.rejects(c.patchSession(s.id, { permissionMode: 'bypassPermissions' }), (e) => e.status === 400 && /Cannot patch permissionMode/.test(e.message));
  const p = await c.patchSession(s.id, { model: 'gpt-b', effort: 'medium', sandbox: 'workspace-write' });
  assert.deepEqual([p.model, p.effort, p.sandbox], ['gpt-b', 'medium', 'workspace-write']);
  assert.equal((await c.patchSession(s.id, { sandbox: 'read-only' })).sandbox, 'read-only');
  assert.equal((await c.getSession(s.id)).model, 'gpt-b', 'a sandbox patch leaves the model');
});

test('codex: the stream becomes a turn; the env has no OPENAI_API_KEY and no host Claude Code variables; a second send resumes the thread', async () => {
  const { c, events, finished, projectDir, statusLines } = setup({
    env: { OPENAI_API_KEY: 'sk-should-not-leak', openai_api_key: 'sk-lower', CODEX_API_KEY: 'k', ANTHROPIC_API_KEY: 'a', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
    companionContext: async () => 'Studio context (test pack)\nProject: Test',
  });
  const b = (await c.backends()).backends.find((x) => x.id === 'codex');
  assert.equal(b.available, true);
  assert.match(b.detail, /fake-codex\.mjs · codex-cli 0\.0\.0-fake/);

  const s = await c.createSession({ backend: 'codex', projectId: 'p_x', tools: 'studio' });
  const { runId } = await c.send(s.id, { text: 'Is the tree clean? TOOLS EDIT' });
  const done = await finished(runId);
  assert.equal(done.type, 'console.done');
  const turn = done.payload.turn;
  assert.equal(turn.backend, 'codex');
  assert.equal(turn.model, 'gpt-a');
  assert.equal(turn.sandbox, 'read-only');
  assert.equal(turn.login, 'chatgpt');
  assert.match(turn.text, /^I’ll look at the working tree\.\n\necho: You are answering in the Codex tab/);
  assert.ok(turn.text.includes(projectDir), 'cwd is the project folder');
  assert.match(turn.text, /Your sandbox is read-only/);
  assert.match(turn.text, /The studio's tools \(the atelier MCP server\) are attached/);
  assert.match(turn.text, /Studio context \(test pack\)\nProject: Test\n\n---\n\nIs the tree clean\?/);
  assert.equal(turn.contextUsed, 'the studio context');
  assert.deepEqual(turn.usage, { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 100, reasoning_output_tokens: 2 });
  assert.ok(turn.durationMs >= 0);

  // the env: nothing a run could bill, nothing of the host Claude Code session
  assert.deepEqual(statusLines(turn, 'env'), ['env OPENAI_API_KEY=absent CODEX_API_KEY=absent ANTHROPIC_API_KEY=absent CLAUDECODE=absent CLAUDE_CODE_ENTRYPOINT=absent']);
  // the argv: exec, json, the config model and effort, read-only, the message on stdin
  assert.deepEqual(statusLines(turn, 'argv'), ['argv ["exec","--json","--skip-git-repo-check","-m","gpt-a","-c","model_reasoning_effort=\\"high\\"","-c","sandbox_mode=\\"read-only\\"","-"]']);
  // the studio's tools: the same server and session id the Companion's session gets
  const mcp = statusLines(turn, 'mcp').join('\n');
  assert.match(mcp, /mcp_servers\.atelier\.command=/);
  assert.match(mcp, /atelier-mcp\.mjs","--studio","http:\/\/127\.0\.0\.1:4999","--project","p_x"\]/);
  assert.ok(mcp.includes(`mcp_servers.atelier.env={ATELIER_SESSION_ID="${s.id}"}`));
  assert.match(mcp, /default_tools_approval_mode="approve"/);

  // the events: the command and its result, the studio tool, a refused call, the file changes, a failed command
  const ev = turn.events;
  assert.ok(ev.some((e) => e.kind === 'tool' && e.name === 'Shell' && e.summary === 'git status --short' && typeof e.ms === 'number'));
  assert.ok(ev.some((e) => e.kind === 'tool-result' && e.name === 'Shell' && e.ok === true && e.summary === 'M index.html'));
  assert.ok(ev.some((e) => e.kind === 'tool' && e.name === 'mcp__atelier__atelier_read_briefing'));
  assert.ok(ev.some((e) => e.kind === 'tool-result' && e.name === 'mcp__atelier__atelier_read_briefing' && e.summary === 'Briefing of Test (p_x)'));
  assert.ok(ev.some((e) => e.kind === 'denied' && e.name === 'mcp__other__write_thing' && e.summary === 'a.txt'));
  assert.deepEqual(ev.filter((e) => e.kind === 'tool' && e.name === 'Edit').map((e) => e.summary), [path.join(projectDir, 'src', 'app.js')], 'one row per changed file, though the item is reported twice');
  assert.deepEqual(ev.filter((e) => e.kind === 'tool' && e.name === 'Write').map((e) => e.summary), [path.join(projectDir, 'src', 'new.js')]);
  assert.ok(ev.some((e) => e.kind === 'tool-result' && e.name === 'Shell' && e.ok === false && /Read-only file system/.test(e.summary)));
  assert.ok(events.some((e) => e.type === 'console.chunk' && e.payload.kind === 'text' && e.payload.runId === runId));
  assert.ok(events.some((e) => e.type === 'console.chunk' && e.payload.kind === 'tool' && e.payload.name === 'Shell' && e.payload.runId === runId));

  const rec = await c.getSession(s.id);
  assert.equal(rec.status, 'idle');
  assert.match(rec.codexThreadId, /^[0-9a-f-]{36}$/);
  assert.equal(rec.turns[0].text, 'Is the tree clean? TOOLS EDIT', 'the record keeps the person\'s words alone');

  const second = await c.send(s.id, { text: 'And now?' });
  const d2 = await finished(second.runId);
  assert.match(d2.payload.turn.text, new RegExp(`resumed ${rec.codexThreadId}\\. echo: And now\\?`));
  assert.ok(!/You are answering in the Codex tab/.test(d2.payload.turn.text), 'the role goes with the first message only');
  assert.match(statusLines(d2.payload.turn, 'argv')[0], new RegExp(`^argv \\["exec","resume","--json".*"${rec.codexThreadId}","-"\\]$`));
  assert.equal((await c.getSession(s.id)).codexThreadId, rec.codexThreadId);

  // the person switches to workspace-write: the next run has it, and Codex is told once
  await c.patchSession(s.id, { sandbox: 'workspace-write' });
  const d3 = await finished((await c.send(s.id, { text: 'Third' })).runId);
  assert.match(statusLines(d3.payload.turn, 'argv')[0], /"sandbox_mode=\\"workspace-write\\""/);
  assert.match(d3.payload.turn.text, /echo: \[Studio: the person changed the sandbox\. Your sandbox is workspace-write/);
  assert.equal(d3.payload.turn.sandbox, 'workspace-write');
  const d4 = await finished((await c.send(s.id, { text: 'Fourth' })).runId);
  assert.match(d4.payload.turn.text, /echo: Fourth \(cwd/);
});

test('codex: without Studio tools no MCP server is attached', async () => {
  const { c, finished, statusLines } = setup();
  const s = await c.createSession({ backend: 'codex', projectId: 'p_x' });
  const done = await finished((await c.send(s.id, { text: 'Hello' })).runId);
  assert.deepEqual(statusLines(done.payload.turn, 'mcp'), []);
  assert.ok(!/atelier MCP server/.test(done.payload.turn.text));
});

test('codex: a refused model is a failed turn with one sentence; the session keeps its model', async () => {
  const { c, finished } = setup();
  const s = await c.createSession({ backend: 'codex', projectId: 'p_x', model: 'gpt-refused' });
  const done = await finished((await c.send(s.id, { text: 'Hello' })).runId);
  assert.equal(done.type, 'console.error');
  const turn = done.payload.turn;
  assert.equal(turn.modelRefused, true);
  assert.equal(turn.isError, true);
  assert.match(turn.error, /^Codex refused the model gpt-refused: choose another model in the tab and send the message again\./);
  assert.ok(!turn.signedOut);
  assert.equal((await c.getSession(s.id)).model, 'gpt-refused', 'nothing switched the model');
});

test('codex: signed out is said before anything is recorded', async () => {
  const out = setup({ env: { FAKE_CODEX_LOGIN: 'out' } });
  const st = await out.c.codexStatus();
  assert.equal(st.cli, true);
  assert.equal(st.loggedIn, false);
  assert.equal(st.problem, CODEX_SIGNED_OUT);
  const s = await out.c.createSession({ backend: 'codex', projectId: 'p_x' });
  await assert.rejects(out.c.send(s.id, { text: 'Hello' }), (e) => e.status === 503 && e.code === 'console_codex_signed_out' && e.message === CODEX_SIGNED_OUT);
  const rec = await out.c.getSession(s.id);
  assert.equal(rec.turns.length, 0);
  assert.equal(rec.status, 'idle');
});

test('codex: a run that finds itself signed out is a signedOut turn with the sentence; the next send is refused', async () => {
  const s0 = setup();
  const loginFile = path.join(s0.root, 'login.txt');
  fs.writeFileSync(loginFile, 'chatgpt');
  const { c, finished } = setup({ env: { FAKE_CODEX_LOGIN_FILE: loginFile } });
  assert.equal((await c.codexStatus()).loggedIn, true); // the studio's answer for the next minute
  const s = await c.createSession({ backend: 'codex', projectId: 'p_x' });
  fs.writeFileSync(loginFile, 'out');
  const done = await finished((await c.send(s.id, { text: 'Hello' })).runId);
  assert.equal(done.type, 'console.error');
  assert.equal(done.payload.turn.signedOut, true);
  assert.ok(done.payload.turn.error.startsWith(CODEX_SIGNED_OUT), done.payload.turn.error);
  assert.ok(!done.payload.turn.modelRefused);
  // the run's finding dropped the cached answer: the status and the next send ask the CLI again
  assert.equal((await c.codexStatus()).loggedIn, false);
  await assert.rejects(c.send(s.id, { text: 'Again' }), (e) => e.code === 'console_codex_signed_out');
  assert.equal((await c.getSession(s.id)).turns.length, 2);
  fs.writeFileSync(loginFile, 'chatgpt');
  const back = await finished((await c.send(s.id, { text: 'Back' })).runId);
  assert.equal(back.type, 'console.done', 'signed in again: the fresh check lets the message through');
});

test('codex: no CLI is a 503 with what to do, and the status says so', async () => {
  const { c, root } = setup({ env: { ATELIER_CODEX_BIN: path.join(os.tmpdir(), 'no-such-codex-binary') } });
  const st = await c.codexStatus();
  assert.equal(st.cli, false);
  assert.equal(st.problem, CODEX_NO_CLI);
  assert.ok(st.models.length > 0, 'the choices still read');
  assert.equal((await c.backends()).backends.find((x) => x.id === 'codex').available, false);
  const s = await c.createSession({ backend: 'codex', projectId: 'p_x' });
  await assert.rejects(c.send(s.id, { text: 'Hello' }), (e) => e.status === 503 && e.code === 'console_no_codex' && e.message === CODEX_NO_CLI);
  assert.equal((await c.getSession(s.id)).turns.length, 0);
  assert.ok(root);
});

test('codex: the status names the login kind, the models from the cache and config.toml\'s defaults', async () => {
  const { c } = setup();
  const st = await c.codexStatus();
  assert.deepEqual([st.cli, st.loggedIn, st.login, st.version], [true, true, 'chatgpt', 'codex-cli 0.0.0-fake']);
  assert.deepEqual(st.defaults, { model: 'gpt-a', effort: 'high' });
  assert.equal(st.source, 'models_cache.json');
  assert.deepEqual(st.sandboxes, ['read-only', 'workspace-write']);
  assert.equal(st.defaultSandbox, 'read-only');
  assert.equal(st.problem, null);
  const key = setup({ env: { FAKE_CODEX_LOGIN: 'key' } });
  assert.equal((await key.c.codexStatus()).login, 'api-key');
});

test('codex: Stop cancels the running turn', async () => {
  const { c, finished } = setup();
  const s = await c.createSession({ backend: 'codex', projectId: 'p_x' });
  const { runId } = await c.send(s.id, { text: 'SLEEP' });
  await assert.rejects(c.send(s.id, { text: 'again' }), (e) => e.status === 409);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await c.cancel(s.id)).cancelled, true);
  const done = await finished(runId);
  assert.equal(done.payload.turn.cancelled, true);
  assert.equal(done.type, 'console.done');
});
