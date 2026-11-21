// Fake `codex` CLI for tests/codex.test.mjs and scripts/ui-check/verify-codex.cjs: prints `codex exec --json` lines
// as codex-cli 0.160.0 printed them on 2026-11-13 (thread.started, turn.started, item.started / item.completed with
// agent_message, command_execution and mcp_tool_call items, turn.completed with usage; error and turn.failed for a
// refused model). Never calls any service. FAKE_CODEX_LOGIN=out makes `login status` and a run read signed out;
// FAKE_CODEX_LOGIN=key makes `login status` say an API key. FAKE_CODEX_LOGIN_FILE names a file whose text is read
// for the same word on every call, so a driver can sign the fake out and in while the server runs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
let login = process.env.FAKE_CODEX_LOGIN || 'chatgpt';
try { if (process.env.FAKE_CODEX_LOGIN_FILE) login = fs.readFileSync(process.env.FAKE_CODEX_LOGIN_FILE, 'utf8').trim() || login; } catch { /* no file: the env's word */ }
if (argv.includes('--version')) {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  if (login === 'out') { console.error('Not logged in'); process.exit(1); }
  console.log(login === 'key' ? 'Logged in using an API key - sk-fake***' : 'Logged in using ChatGPT');
  process.exit(0);
}
if (argv[0] !== 'exec') { console.error(`fake codex: unknown command ${argv[0]}`); process.exit(2); }

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const resume = argv[1] === 'resume';
// The positionals after the flags: `exec resume … <thread id> -` or `exec … -`.
const flagsWithValue = new Set(['-c', '-m', '-i', '-s', '-C', '-p', '-o']);
const positionals = [];
for (let i = resume ? 2 : 1; i < argv.length; i++) {
  if (flagsWithValue.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith('--')) continue;
  positionals.push(argv[i]);
}
const threadId = resume ? positionals[0] : crypto.randomUUID();
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const model = opt('-m');
const overrides = argv.filter((a, i) => argv[i - 1] === '-c');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  out({ type: 'thread.started', thread_id: threadId });
  if (login === 'out') {
    out({ type: 'turn.started' });
    const message = JSON.stringify({ type: 'error', status: 401, error: { type: 'invalid_request_error', message: 'Not logged in. Run codex login.' } });
    out({ type: 'error', message });
    out({ type: 'turn.failed', error: { message } });
    process.exitCode = 1;
    return;
  }
  if (model && /refused/.test(model)) {
    out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: `Model metadata for \`${model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.` } });
    out({ type: 'turn.started' });
    const message = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`, code: 'model_not_found' } });
    out({ type: 'error', message });
    out({ type: 'turn.failed', error: { message } });
    process.exitCode = 1;
    return;
  }
  out({ type: 'turn.started' });
  const has = (k) => Object.keys(process.env).some((e) => e.toUpperCase() === k && process.env[e]);
  // Plain lines, as a CLI warning would print: the test reads the env and the argv from them.
  process.stdout.write(`env OPENAI_API_KEY=${has('OPENAI_API_KEY') ? 'present' : 'absent'} CODEX_API_KEY=${has('CODEX_API_KEY') ? 'present' : 'absent'} ANTHROPIC_API_KEY=${has('ANTHROPIC_API_KEY') ? 'present' : 'absent'} CLAUDECODE=${has('CLAUDECODE') ? 'present' : 'absent'} CLAUDE_CODE_ENTRYPOINT=${has('CLAUDE_CODE_ENTRYPOINT') ? 'present' : 'absent'}\n`);
  process.stdout.write(`argv ${JSON.stringify(argv.filter((a, i) => !(argv[i - 1] === '-c' && a.startsWith('mcp_servers.')) && !(a === '-c' && String(argv[i + 1]).startsWith('mcp_servers.'))))}\n`);
  process.stdout.write(`actor ATELIER_ACTOR=${process.env.ATELIER_ACTOR || 'unset'} CODEX_ACCESS_TOKEN=${has('CODEX_ACCESS_TOKEN') ? 'present' : 'absent'}\n`);
  for (const o of overrides.filter((x) => x.startsWith('mcp_servers.'))) process.stdout.write(`mcp ${o.slice(0, 280)}\n`); // one line each: a status line is cut at 300
  if (prompt.includes('SLEEP')) await new Promise((r) => setTimeout(r, 20000));
  // A worker's turn (FAKE_CODEX_WORKER, with a studio task's prompt): what a real Codex worker did on 2026-11-14.
  // finish: task start through the real studio CLI, one file written, then the finish recorded as the CLI records it
  // where .git cannot be written (tasks.requestFinish; the test machine's .git is writable, so the CLI itself would
  // commit). question: the CLI's task question. refused: a command the sandbox refuses, then words and no finish.
  const worker = process.env.FAKE_CODEX_WORKER;
  const tid = prompt.match(/Work on studio task (t_[a-z0-9]+)/)?.[1];
  if (worker && tid) {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'atelier.mjs');
    let item = 10;
    const command = (words, run) => {
      const id = `item_${item++}`;
      const wrapped = `"C:\\\\Windows\\\\pwsh.exe" -Command '${words}'`;
      out({ type: 'item.started', item: { id, type: 'command_execution', command: wrapped, aggregated_output: '', exit_code: null, status: 'in_progress' } });
      const r = run();
      out({ type: 'item.completed', item: { id, type: 'command_execution', command: wrapped, aggregated_output: r.output, exit_code: r.code, status: r.code === 0 ? 'completed' : 'failed' } });
      return r;
    };
    const studio = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: 'utf8' }); return { code: r.status, output: `${r.stdout}${r.stderr}` }; };
    if (worker === 'question') {
      command(`node atelier.mjs task question ${tid} "Which colour?"`, () => studio('task', 'question', tid, 'Which colour should the note be?'));
      out({ type: 'item.completed', item: { id: 'item_90', type: 'agent_message', text: 'I asked and stopped.' } });
    } else if (worker === 'refused') {
      command(`node atelier.mjs task start ${tid}`, () => studio('task', 'start', tid));
      command('bash tools/compile.sh', () => ({ code: 1, output: 'mkdir: cannot create directory ‘/c/Users/someone’: Permission denied\nBLOCKED: Unity has no licence on this machine.\n' }));
      out({ type: 'item.completed', item: { id: 'item_90', type: 'agent_message', text: 'The compile check cannot run in this sandbox, so I stopped.' } });
    } else {
      command(`node atelier.mjs task start ${tid}`, () => studio('task', 'start', tid));
      fs.mkdirSync(path.join(process.cwd(), 'notes'), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), 'notes', 'hello.txt'), 'hello from the worker\n');
      const changes = [{ path: path.join(process.cwd(), 'notes', 'hello.txt'), kind: 'add' }];
      out({ type: 'item.started', item: { id: 'item_50', type: 'file_change', changes, status: 'in_progress' } });
      out({ type: 'item.completed', item: { id: 'item_50', type: 'file_change', changes, status: 'completed' } });
      const tasks = await import('../../server/lib/tasks.mjs');
      await tasks.requestFinish(process.cwd(), tid, { summary: 'Added notes/hello.txt', verification: ['read the file back'], unresolved: [], decisions: [] }, tasks.actorOf());
      command(`node atelier.mjs task finish ${tid} --summary "Added notes/hello.txt"`, () => ({ code: 0, output: `task ${tid}: your finish is recorded.\n` }));
      out({ type: 'item.completed', item: { id: 'item_90', type: 'agent_message', text: 'Done: the finish is recorded.' } });
    }
    out({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 } });
    return;
  }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll look at the working tree.\n' } });
  const command = '"C:\\\\Windows\\\\pwsh.exe" -Command \'git status --short\'';
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command, aggregated_output: ' M index.html\n', exit_code: 0, status: 'completed' } });
  if (prompt.includes('TOOLS')) {
    out({ type: 'item.started', item: { id: 'item_2', type: 'mcp_tool_call', server: 'atelier', tool: 'atelier_read_briefing', arguments: {}, result: null, error: null, status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', server: 'atelier', tool: 'atelier_read_briefing', arguments: {}, result: { content: [{ type: 'text', text: 'Briefing of Test (p_x)' }] }, error: null, status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'other', tool: 'write_thing', arguments: { path: 'a.txt' }, result: null, error: { message: 'MCP tool call requires approval, but approval policy is never' }, status: 'failed' } });
  }
  if (prompt.includes('EDIT')) {
    // Absolute paths, started then completed, as the real CLI printed a file change on 2026-11-13.
    const changes = [{ path: path.join(process.cwd(), 'src', 'app.js'), kind: 'update' }, { path: path.join(process.cwd(), 'src', 'new.js'), kind: 'add' }];
    out({ type: 'item.started', item: { id: 'item_4', type: 'file_change', changes, status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'item_4', type: 'file_change', changes, status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'item_5', type: 'command_execution', command: 'bash -lc "rm -rf build"', aggregated_output: 'rm: cannot remove: Read-only file system\n', exit_code: 1, status: 'failed' } });
  }
  const text = `${resume ? `resumed ${threadId}. ` : ''}echo: ${prompt.trim()} (cwd ${process.cwd()})`;
  out({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 2 } });
});
