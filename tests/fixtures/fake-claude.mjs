// Fake `claude` CLI for tests/console.test.mjs: prints stream-json lines modelled on
// docs/evidence/probe-stream-json.jsonl. Never calls any API.
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.0.0-fake (Claude Code)');
  process.exit(0);
}
// `claude auth status --json`: signed in only through CLAUDE_CODE_OAUTH_TOKEN, as the real CLI reports it (decision row 129).
if (argv[0] === 'auth' && argv[1] === 'status') {
  const token = Object.keys(process.env).some((k) => k.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN' && process.env[k]);
  console.log(JSON.stringify({ loggedIn: token, authMethod: token ? 'oauth_token' : 'none', apiProvider: 'firstParty' }, null, 2));
  process.exit(token ? 0 : 1);
}
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const model = opt('--model') || 'claude-opus-5-5';
const resume = opt('--resume');
const sessionId = resume || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const t0 = Date.now();
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model, permissionMode: opt('--permission-mode'), apiKeySource: 'none' });
  const has = (k) => Object.keys(process.env).some((e) => e.toUpperCase() === k);
  process.stdout.write(`env STUDIO_ANTHROPIC_API_KEY=${has('STUDIO_ANTHROPIC_API_KEY') ? 'present' : 'absent'} ANTHROPIC_API_KEY=${has('ANTHROPIC_API_KEY') ? 'present' : 'absent'}\n`);
  // The Gmail deny pair (decision row 150) is long: it is left out of the argv line, which the transcript cuts at 300
  // characters, and reported on its own line.
  const mailAt = argv.findIndex((a) => a.startsWith('mcp__claude_ai_Gmail__'));
  const shown = mailAt > 0 ? argv.filter((_, i) => i !== mailAt && i !== mailAt - 1) : argv;
  process.stdout.write(`argv ${JSON.stringify(shown)}\n`);
  process.stdout.write(`mail ${mailAt > 0 ? `${argv[mailAt].split(',').length} gmail tools denied` : 'not denied'}\n`);
  if (prompt.includes('AUTH?')) process.stdout.write(`auth CLAUDE_CODE_OAUTH_TOKEN=${has('CLAUDE_CODE_OAUTH_TOKEN') ? 'present' : 'absent'} CLAUDE_CODE_HOST_SESSION_ID=${has('CLAUDE_CODE_HOST_SESSION_ID') ? 'present' : 'absent'}\n`);
  if (prompt.includes('SIGNED_OUT')) { // what the real CLI printed on 2026-11-07 when its saved login could not be refreshed
    const said = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: said }] }, session_id: sessionId });
    out({ type: 'result', subtype: 'success', is_error: true, duration_ms: 151, result: said, session_id: sessionId });
    process.exitCode = 1;
    return;
  }
  if (prompt.includes('SLEEP')) await new Promise((r) => setTimeout(r, 20000));
  out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'CLAUDE.md' } }] }, session_id: sessionId });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '# CLAUDE.md contents' }] }] }, session_id: sessionId });
  const denials = [];
  if (prompt.includes('DENY')) {
    const input = { command: 'node x task start t_1', description: 'Report start' };
    out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input }] }, session_id: sessionId });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'Permission denied: this command requires approval', is_error: true }] }, session_id: sessionId });
    denials.push({ tool_name: 'Bash', tool_use_id: 'tu_2', tool_input: { command: 'node x task start t_1' } });
  }
  if (prompt.includes('REFUSE')) {
    // a refusal that only shows as an is_error tool_result (no permission_denials entry), then a real failure
    out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_3', name: 'Bash', input: { command: 'git log --all' } }] }, session_id: sessionId });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: 'Permission denied', is_error: true }] }, session_id: sessionId });
    out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_4', name: 'Read', input: { file_path: 'missing.txt' } }] }, session_id: sessionId });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_4', content: 'File does not exist.', is_error: true }] }, session_id: sessionId });
  }
  // ASK_ME: an answer whose last paragraph is a question to the person (tests/runs.test.mjs: Waiting for you).
  const text = prompt.includes('ASK_ME') ? 'The header has room now.\n\nShall I keep the old header as an option?' : `${resume ? `resumed ${resume}. ` : ''}echo: ${prompt.trim()} (cwd ${process.cwd()})`;
  out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 4 } }, session_id: sessionId });
  // SUBAGENT: the last assistant line is a sub-agent's (parent_tool_use_id), on another model than the session's.
  if (prompt.includes('SUBAGENT')) out({ type: 'assistant', parent_tool_use_id: 'tu_agent', message: { model: 'claude-haiku-5-5', role: 'assistant', content: [] }, session_id: sessionId });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: sessionId });
  out({
    type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0 + 1, result: text, session_id: sessionId,
    total_cost_usd: 0.0123, usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 10, cacheCreationInputTokens: 0, costUSD: 0.0123 } },
    permission_denials: denials,
  });
});
