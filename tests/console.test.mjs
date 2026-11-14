// Console backends with a fake claude CLI (tests/fixtures/fake-claude.mjs), a local command
// and a fake utility. No real claude or API calls. Risks covered: the CLI child must never see
// an API key; resume uses the recorded session id; cancel really stops the process; one run per session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConsole, titleOf, claudeArgs, STUDIO_TOOLS_RULE, STUDIO_TOOLS_PROMPT } from '../server/lib/console.mjs';
import { UtilityError } from '../server/api-utility/index.mjs';
import { TASK_MAP } from '../server/api-utility/tasks.mjs';
import { validate } from '../server/api-utility/validate.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

function setup({ env = {}, settings = {}, utility = null, companionContext = null, claudeToken = null, claudeTokenInfo = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-console-'));
  const studioDir = path.join(root, 'studio');
  const projectDir = path.join(root, 'project');
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(projectsDir);
  fs.mkdirSync(path.join(studioDir, '.studio'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.studio', 'BRIEFING.md'), '# Briefing for the test project');
  const events = [];
  const s = { console: { ...settings } };
  const c = createConsole({
    dataDir: path.join(root, 'data'),
    studioDir,
    projectsDir,
    projectFolders: async () => [projectDir],
    loadProject: async (id) => ({ path: projectDir, project: { id } }),
    getSettings: async () => s,
    utility,
    emit: (type, payload) => events.push({ type, payload }),
    env: { ...process.env, ATELIER_CLAUDE_BIN: FAKE, ...env },
    companionContext,
    ...(claudeToken ? { claudeToken } : {}),
    ...(claudeTokenInfo ? { claudeTokenInfo } : {}),
  });
  const waitFor = async (pred, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting; events: ${events.map((e) => e.type).join(',')}`);
  };
  const finished = (runId) => waitFor((e) => (e.type === 'console.done' || e.type === 'console.error') && e.payload.runId === runId);
  return { c, events, waitFor, finished, root, projectDir, projectsDir, studioDir, settings: s };
}

test('title is the first sentence, at most 80 chars', () => {
  assert.equal(titleOf('Fix the dock. Then the rest.'), 'Fix the dock.');
  assert.equal(titleOf('x'.repeat(200)).length, 80);
});

test('title: a first sentence longer than 80 chars ends on a whole word and an ellipsis', () => {
  const sentence = 'Make the session list keep its order when a long running answer finishes in the background while I read another one.';
  assert.ok(sentence.length > 80);
  const title = titleOf(`${sentence} Then the rest.`);
  assert.ok(title.length <= 80, title);
  assert.ok(title.endsWith('…'), title);
  const head = title.slice(0, -1);
  assert.ok(sentence.startsWith(`${head} `), `cut at a word end: "${title}"`);
  // A sentence that fits is left whole, with no mark.
  assert.equal(titleOf('Fix the dock.'), 'Fix the dock.');
});

test('claude-code: a turn records text, model, session id, duration and streams; a second send resumes', async () => {
  const { c, events, finished, projectDir } = setup();
  const b = await c.backends();
  const cc = b.backends.find((x) => x.id === 'claude-code');
  assert.equal(cc.available, true);
  assert.match(cc.detail, /fake-claude\.mjs · 0\.0\.0-fake/);
  assert.deepEqual(b.models, ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

  const s = await c.createSession({ backend: 'claude-code', projectId: 'p_x', model: 'claude-fable-5-1' });
  assert.equal(s.permissionMode, 'acceptEdits');
  assert.equal(s.cwd, projectDir);
  const { runId } = await c.send(s.id, { text: 'What is open? More text here.' });
  const done = await finished(runId);
  assert.equal(done.type, 'console.done');
  const turn = done.payload.turn;
  assert.match(turn.text, /echo: What is open\?/);
  assert.ok(turn.text.includes(projectDir), 'cwd is the project folder');
  assert.deepEqual(Object.keys(turn.modelUsage), ['claude-fable-5-1']);
  assert.equal(turn.costUsd, 0.0123);
  assert.ok(turn.durationMs > 0);
  assert.ok(turn.events.some((e) => e.kind === 'tool' && e.name === 'Read' && e.summary === 'CLAUDE.md'));
  assert.ok(events.some((e) => e.type === 'console.started' && e.payload.runId === runId));
  assert.ok(events.some((e) => e.type === 'console.chunk' && e.payload.kind === 'text' && e.payload.runId === runId));
  assert.ok(events.some((e) => e.type === 'console.chunk' && e.payload.kind === 'tool' && e.payload.runId === runId));

  const rec = await c.getSession(s.id);
  assert.equal(rec.status, 'idle');
  assert.equal(rec.title, 'What is open?');
  assert.match(rec.claudeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(rec.turns.length, 2);

  const second = await c.send(s.id, { text: 'And now?' });
  const d2 = await finished(second.runId);
  assert.match(d2.payload.turn.text, new RegExp(`^resumed ${rec.claudeSessionId}`));
  assert.equal((await c.getSession(s.id)).claudeSessionId, rec.claudeSessionId);
  const list = await c.listSessions({ projectId: 'p_x' });
  assert.equal(list.length, 1);
  assert.equal(list[0].turnCount, 4);
  assert.equal((await c.listSessions({ projectId: 'p_other' })).length, 0);
});

test('claude-code: a sub-agent\'s message does not rename the turn\'s model; sessionRecords gives the records whole', async () => {
  const { c, finished } = setup();
  const s = await c.createSession({ backend: 'claude-code', projectId: 'p_x', model: 'claude-opus-5-5' });
  const done = await finished((await c.send(s.id, { text: 'SUBAGENT look around' })).runId);
  assert.equal(done.payload.turn.model, 'claude-opus-5-5', 'the session\'s model, not the sub-agent\'s claude-haiku-5-5');
  // What the usage tally reads (server/lib/usage.mjs): every record with its turns and their recorded figures.
  const records = await c.sessionRecords();
  const rec = records.find((r) => r.id === s.id);
  assert.deepEqual([rec.model, rec.turns.length, rec.turns[1].model, rec.turns[1].costUsd, rec.turns[1].usage.output_tokens], ['claude-opus-5-5', 2, 'claude-opus-5-5', 0.0123, 4]);
});

test('claude-code: the child env has neither API key even when the parent sets both', async () => {
  const { c, finished } = setup({ env: { STUDIO_ANTHROPIC_API_KEY: 'sk-ant-test-studio', ANTHROPIC_API_KEY: 'sk-ant-test-plain', anthropic_api_key: 'sk-ant-test-lower' } });
  const s = await c.createSession({ backend: 'claude-code' });
  const { runId } = await c.send(s.id, { text: 'env?' });
  const turn = (await finished(runId)).payload.turn;
  const status = turn.events.find((e) => e.kind === 'status' && e.summary.startsWith('env '));
  assert.ok(status, 'fake claude printed its env status line');
  assert.equal(status.summary, 'env STUDIO_ANTHROPIC_API_KEY=absent ANTHROPIC_API_KEY=absent');
});

const argvOf = (turn) => {
  const line = turn.events.find((e) => e.kind === 'status' && e.summary.startsWith('argv '));
  assert.ok(line, 'fake claude printed its argv');
  return JSON.parse(line.summary.slice(5));
};

test('allowStudioCli: on adds the studio CLI rules (node, npm run, npm test, git read commands; PowerShell off) as separate argv entries; off does not', async () => {
  const { c, finished } = setup();
  const on = await c.createSession({ backend: 'claude-code', allowStudioCli: true, title: 'Task t_1: Fix it', taskId: 't_1' });
  assert.equal(on.allowStudioCli, true);
  assert.equal(on.title, 'Task t_1: Fix it');
  assert.equal(on.taskId, 't_1');
  const r1 = await c.send(on.id, { text: 'go' });
  const a1 = argvOf((await finished(r1.runId)).payload.turn);
  const i = a1.indexOf('--allowedTools');
  assert.ok(i > 0, JSON.stringify(a1));
  assert.deepEqual(a1.slice(i, i + 10), ['--allowedTools', 'Bash(node:*)', 'Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', '--disallowedTools', 'PowerShell']);
  const gitRules = a1.filter((x) => x.startsWith('Bash(git'));
  assert.deepEqual(gitRules, ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'], 'the only git rules are these four read commands');
  assert.equal((await c.getSession(on.id)).title, 'Task t_1: Fix it', 'a given title is not replaced by the first message');

  const words = 'Tune the jump so the crate can be reached from the second platform without a running start';
  assert.ok(words.length > 80);
  const long = await c.createSession({ backend: 'claude-code', title: `  ${words}  ` });
  assert.ok(long.title.length <= 80, long.title);
  assert.ok(long.title.endsWith('…'), long.title);
  assert.ok(words.startsWith(`${long.title.slice(0, -1)} `), `a given title ends on a word: "${long.title}"`);

  const off = await c.createSession({ backend: 'claude-code' });
  assert.equal(off.allowStudioCli, false);
  assert.equal(off.taskId, null);
  const r2 = await c.send(off.id, { text: 'go' });
  const a2 = argvOf((await finished(r2.runId)).payload.turn);
  assert.ok(!a2.includes('--allowedTools') && !a2.some((x) => x.includes('node:*')), JSON.stringify(a2));

  await assert.rejects(c.createSession({ backend: 'claude-code', allowStudioCli: 'yes' }), (e) => e.status === 400);
});

test('tool results and permission denials become tool-result and denied events and chunks', async () => {
  const { c, events, finished } = setup();
  const s = await c.createSession({ backend: 'claude-code' });
  const { runId } = await c.send(s.id, { text: 'please DENY' });
  const turn = (await finished(runId)).payload.turn;
  const okResult = turn.events.find((e) => e.kind === 'tool-result' && e.name === 'Read');
  assert.deepEqual(okResult, { kind: 'tool-result', id: 'tu_1', name: 'Read', ok: true, summary: '# CLAUDE.md contents', detail: '# CLAUDE.md contents' });
  assert.equal(turn.events.find((e) => e.kind === 'tool' && e.name === 'Bash').id, 'tu_2', 'a stored call carries its tool_use id');
  assert.ok(!turn.events.some((e) => e.kind === 'tool-result' && e.name === 'Bash'), 'a refused call is not a failed tool result');
  // shown once: live from the tool_result, not again from permission_denials at the result line
  assert.deepEqual(turn.events.filter((e) => e.kind === 'denied'), [{ kind: 'denied', id: 'tu_2', name: 'Bash', summary: 'node x task start t_1' }]);
  assert.ok(turn.events.some((e) => e.kind === 'status' && /1 permission denial/.test(e.summary)), 'the status count stays');
  const chunks = events.filter((e) => e.type === 'console.chunk' && e.payload.runId === runId).map((e) => e.payload);
  assert.ok(!chunks.some((ch) => ch.kind === 'tool-result' && ch.id === 'tu_2'));
  assert.equal(chunks.find((ch) => ch.kind === 'tool' && ch.name === 'Bash').id, 'tu_2', 'the live call carries the id its result will name');
  assert.deepEqual(chunks.filter((ch) => ch.kind === 'denied'), [{ sessionId: s.id, runId, kind: 'denied', id: 'tu_2', name: 'Bash', summary: 'node x task start t_1' }]);
  // without DENY there are no denials
  const r2 = await c.send(s.id, { text: 'fine' });
  assert.equal((await finished(r2.runId)).payload.turn.events.filter((e) => e.kind === 'denied').length, 0);
});

test('an is_error tool_result that reads as a refusal is denied during the run; other failures stay failed', async () => {
  const { c, events, finished } = setup();
  const s = await c.createSession({ backend: 'claude-code' });
  const { runId } = await c.send(s.id, { text: 'please REFUSE' });
  const turn = (await finished(runId)).payload.turn;
  assert.deepEqual(turn.events.filter((e) => e.kind === 'denied'), [{ kind: 'denied', id: 'tu_3', name: 'Bash', summary: 'git log --all' }]);
  assert.deepEqual(turn.events.filter((e) => e.kind === 'tool-result' && !e.ok), [{ kind: 'tool-result', id: 'tu_4', name: 'Read', ok: false, summary: 'File does not exist.', detail: 'File does not exist.' }]);
  assert.ok(!turn.events.some((e) => e.kind === 'status' && /permission denial/.test(e.summary)), 'no permission_denials entry, no count line');
  const chunks = events.filter((e) => e.type === 'console.chunk' && e.payload.runId === runId).map((e) => e.payload);
  const deniedAt = chunks.findIndex((ch) => ch.kind === 'denied');
  const answerAt = chunks.findIndex((ch) => ch.kind === 'text');
  assert.ok(deniedAt >= 0 && deniedAt < answerAt, 'the denied chunk streams before the answer, not at the end');
  assert.equal(chunks[deniedAt].id, 'tu_3');
});

test('resultSummary and denialSummary', async () => {
  const { resultSummary, denialSummary } = await import('../server/lib/console.mjs');
  assert.equal(resultSummary('x'.repeat(300)).length, 160);
  assert.equal(resultSummary([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a b');
  assert.equal(denialSummary({ file_path: 'src/x.js', content: '…' }), 'src/x.js');
  assert.equal(denialSummary({ url: 'https://example.com' }), '{"url":"https://example.com"}');
});

test('command backend: stdin mode echoes the message; a missing command is reported', async () => {
  const { c, finished, settings } = setup({ settings: { command: `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`, commandMode: 'stdin' } });
  assert.equal((await c.backends()).backends.find((x) => x.id === 'command').available, true);
  const s = await c.createSession({ backend: 'command' });
  const { runId } = await c.send(s.id, { text: 'hello from the console' });
  const done = await finished(runId);
  assert.equal(done.type, 'console.done');
  assert.equal(done.payload.turn.text, 'hello from the console');
  assert.equal(done.payload.turn.exitCode, 0);

  assert.equal(done.payload.turn.contextUsed, 'none');

  settings.console.command = '';
  assert.deepEqual((await c.backends()).backends.find((x) => x.id === 'command'), { id: 'command', available: false, detail: 'No command set. Settings › Console › Command.' });
  await assert.rejects(c.send(s.id, { text: 'again' }), (e) => e.status === 400 && e.code === 'console_no_command');
  assert.equal((await c.getSession(s.id)).turns.length, 2, 'a refused send records nothing');
});

test('command backend: context briefing sends the project briefing before the message on stdin', async () => {
  const { c, finished } = setup({ settings: { command: `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`, commandMode: 'stdin' } });
  const s = await c.createSession({ backend: 'command', projectId: 'p_x' });
  const { runId } = await c.send(s.id, { text: 'what next?', context: 'briefing' });
  const turn = (await finished(runId)).payload.turn;
  assert.equal(turn.text, 'Project briefing:\n# Briefing for the test project\n\n---\n\nMessage:\nwhat next?');
  assert.equal(turn.contextUsed, 'briefing');
  // history keeps its earlier shape
  const r2 = await c.send(s.id, { text: 'and then?', context: 'history' });
  const t2 = (await finished(r2.runId)).payload.turn;
  assert.match(t2.text, /^user: what next\?\nassistant: Project briefing:/);
  assert.match(t2.text, /\nuser: and then\?$/);
  assert.equal(t2.contextUsed, 'history');
});

test('cancel kills a SLEEP run within 2 s and marks the turn cancelled; busy is 409', async () => {
  const { c, finished } = setup();
  const s = await c.createSession({ backend: 'claude-code' });
  const { runId } = await c.send(s.id, { text: 'please SLEEP' });
  await assert.rejects(c.send(s.id, { text: 'second' }), (e) => e.status === 409 && e.code === 'console_busy');
  assert.equal((await c.getSession(s.id)).status, 'running');
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  assert.equal((await c.cancel(s.id)).cancelled, true);
  const done = await finished(runId);
  assert.ok(Date.now() - t0 < 2000, `cancel took ${Date.now() - t0} ms`);
  assert.equal(done.payload.turn.cancelled, true);
  const rec = await c.getSession(s.id);
  assert.equal(rec.status, 'idle');
  assert.equal(rec.turns.at(-1).cancelled, true);
  assert.equal((await c.listSessions()).find((x) => x.id === s.id).answerCount, 0, 'a cancelled empty turn is not an answer');
});

test('isAnswer: the server and the client agree, turn by turn', async () => {
  const { isAnswer: server } = await import('../server/lib/console.mjs');
  const { isAnswer: client } = await import('../client/components/is-answer.js');
  for (const [turn, expected] of [
    [{ role: 'assistant', text: 'Hello' }, true],
    [{ role: 'assistant', text: '' }, true], // finished normally: an empty reply is still its reply
    [{ role: 'assistant', text: '', cancelled: true }, false],
    [{ role: 'assistant', text: 'Partly', cancelled: true }, true],
    [{ role: 'assistant', text: '', isError: true }, false],
    [{ role: 'assistant', text: 'Partly', isError: true }, true],
    [{ role: 'user', text: 'Hi' }, false],
  ]) {
    assert.equal(server(turn), expected, `server ${JSON.stringify(turn)}`);
    assert.equal(client(turn), expected, `client ${JSON.stringify(turn)}`);
  }
});

test('validation: text, backend, model, permission mode, ids', async () => {
  const { c } = setup();
  await assert.rejects(c.createSession({ backend: 'nope' }), (e) => e.status === 400);
  await assert.rejects(c.createSession({ backend: 'claude-code', model: 'claude-nope-1' }), (e) => e.status === 400);
  await assert.rejects(c.createSession({ backend: 'claude-code', effort: 'huge' }), (e) => e.status === 400);
  await assert.rejects(c.createSession({ backend: 'claude-code', permissionMode: 'yolo' }), (e) => e.status === 400);
  const s = await c.createSession({ backend: 'claude-code', permissionMode: 'plan' });
  await assert.rejects(c.send(s.id, { text: '  ' }), (e) => e.status === 400);
  await assert.rejects(c.send(s.id, { text: 'x'.repeat(20001) }), (e) => e.status === 400);
  await assert.rejects(c.send(s.id, { text: 'hi', context: 'everything' }), (e) => e.status === 400);
  await assert.rejects(c.getSession('cs_missing'), (e) => e.status === 404);
  await assert.rejects(c.getSession('../registry'), (e) => e.status === 404);
});

test('api backend: reply recorded from a fake utility; a UtilityError propagates unchanged', async () => {
  const calls = [];
  let fail = null;
  const utility = {
    status: async () => ({ configured: true, paused: false, model: 'claude-haiku-5-5' }),
    run: async (task, args, opts) => {
      calls.push({ task, args, opts });
      if (fail) throw fail;
      return { runId: opts.runId, output: { reply: 'Hello **there**' }, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001, model: 'claude-haiku-5-5', durationMs: 42 };
    },
    cancel: () => true,
  };
  const { c, events } = setup({ utility });
  assert.deepEqual((await c.backends()).backends.find((x) => x.id === 'api'), { id: 'api', available: true, detail: 'claude-haiku-5-5' });
  const plain = async (st) => (await setup({ utility: { ...utility, status: async () => ({ model: 'm', ...st }) } }).c.backends()).backends.find((x) => x.id === 'api').detail;
  assert.equal(await plain({ configured: false, paused: false }), 'No API key. Settings › API key.');
  assert.equal(await plain({ configured: true, paused: true, pausedReason: 'user' }), 'API utilities are paused. Budget.');
  const s = await c.createSession({ backend: 'api', projectId: 'p_x' });
  const { runId } = await c.send(s.id, { text: 'Help me', context: 'briefing' });
  assert.equal(calls[0].task, 'console-chat');
  assert.equal(calls[0].opts.runId, runId);
  assert.equal(calls[0].args.input.context, '# Briefing for the test project');
  assert.deepEqual(calls[0].args.input.messages, [{ role: 'user', text: 'Help me' }]);
  assert.deepEqual(validate(TASK_MAP.get('console-chat').inputSchema, calls[0].args.input), []);
  const rec = await c.getSession(s.id);
  assert.equal(rec.turns[1].text, 'Hello **there**');
  assert.equal(rec.turns[1].contextUsed, 'briefing');
  assert.equal(rec.turns[1].costUsd, 0.0001);
  assert.deepEqual(Object.keys(rec.turns[1].modelUsage), ['claude-haiku-5-5']);
  assert.ok(events.some((e) => e.type === 'console.done' && e.payload.runId === runId));

  fail = new UtilityError('budget_paused', 'API utility is paused (user)');
  await assert.rejects(c.send(s.id, { text: 'Again' }), (e) => e === fail && e.status === 402 && e.code === 'budget_paused');
  const after = await c.getSession(s.id);
  assert.equal(after.status, 'idle');
  assert.equal(after.turns.at(-1).isError, true);
  assert.ok(events.some((e) => e.type === 'console.error'));
  // the error turn is not sent back to the model as transcript
  fail = null;
  await c.send(s.id, { text: 'Third' });
  assert.deepEqual(calls.at(-1).args.input.messages.map((m) => m.text), ['Help me', 'Hello **there**', 'Again', 'Third']);
});

test('api refusal: an error turn in plain words, no cost, duration or context, and not an answer', async () => {
  const utility = {
    status: async () => ({ configured: false, paused: false, model: 'm' }),
    run: async () => { throw new UtilityError('not_configured', 'No API key configured (set STUDIO_ANTHROPIC_API_KEY or ~/.atelier/secrets.json)'); },
    cancel: () => true,
  };
  const { c, events, root } = setup({ utility });
  const s = await c.createSession({ backend: 'api', projectId: 'p_x' });
  await assert.rejects(c.send(s.id, { text: 'Say hello', context: 'briefing' }), (e) => e.code === 'not_configured');
  const refused = (await c.getSession(s.id)).turns.at(-1);
  assert.equal(refused.isError, true);
  assert.equal(refused.refused, 'not_configured');
  assert.equal(refused.error, 'No API key: add one in Settings › API key. Nothing was sent.');
  for (const k of ['costUsd', 'durationMs', 'contextUsed', 'usage']) assert.equal(refused[k], undefined, k);
  assert.ok(events.some((e) => e.type === 'console.error' && e.payload.message === refused.error));
  const listed = (await c.listSessions()).find((x) => x.id === s.id);
  assert.equal(listed.turnCount, 2);
  assert.equal(listed.answerCount, 0);
  // a record written before this shape reads the same
  const file = path.join(root, 'data', 'console', `${s.id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.turns[1] = { role: 'assistant', text: '', backend: 'api', contextUsed: 'briefing', durationMs: 3, isError: true, error: 'not_configured: No API key configured (set STUDIO_ANTHROPIC_API_KEY or ~/.atelier/secrets.json)' };
  fs.writeFileSync(file, JSON.stringify(rec));
  const old = (await c.getSession(s.id)).turns[1];
  assert.equal(old.error, refused.error);
  assert.equal(old.durationMs, undefined);
  assert.equal(old.contextUsed, undefined);
  assert.equal((await c.listSessions()).find((x) => x.id === s.id).answerCount, 0);
});

test('refusalText: a pause says nothing was sent; only a missing key gets the key sentence', async () => {
  const { refusalText } = await import('../server/lib/console.mjs');
  assert.equal(refusalText('budget_paused', 'API utilities are paused (by you on 2026-11-04). Resume them in Budget to run this. Nothing was spent.'), 'API utilities are paused (by you on 2026-11-04). Resume them in Budget to run this. Nothing was sent.');
  assert.equal(refusalText('not_configured', 'model "m" has no pricing entry (pricing x); refusing to run unbounded'), 'model "m" has no pricing entry (pricing x); refusing to run unbounded. Nothing was sent.');
});

test('console-chat task fences context and transcript inside <input>', () => {
  const t = TASK_MAP.get('console-chat');
  const u = t.buildUser({ messages: [{ role: 'user', text: 'hi' }], context: 'CTX' });
  assert.match(u, /^<input>\n<context>\nCTX\n<\/context>\n<transcript>\n\[user\]\nhi\n<\/transcript>\n<\/input>$/);
  assert.equal(t.maxOutputTokens, 2000);
  assert.deepEqual(validate(t.outputSchema, { reply: 'ok' }), []);
});

test('strippedEnv drops API keys and host Claude Code session markers, keeps CLAUDE_CONFIG_DIR', async () => {
  const { strippedEnv } = await import('../server/lib/console.mjs');
  const out = strippedEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'k', STUDIO_ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'e', CLAUDE_CONFIG_DIR: 'C:/cfg' });
  assert.deepEqual(Object.keys(out).sort(), ['CLAUDE_CONFIG_DIR', 'PATH']);
});

test('Studio tools: tools studio adds the inline --mcp-config, the mcp__atelier__* rule and the prompt; off adds none; the record keeps it', async () => {
  const studioDir = path.join(os.tmpdir(), 'studio-x');
  const base = { model: 'claude-opus-5-5', permissionMode: 'acceptEdits', projectId: 'p_abc123' };
  const on = claudeArgs({ ...base, tools: 'studio' }, { studioDir, studioOrigin: 'http://127.0.0.1:4800', nodePath: 'C:\\node\\node.exe' });
  const i = on.indexOf('--mcp-config');
  assert.ok(i > 0, JSON.stringify(on));
  assert.deepEqual(JSON.parse(on[i + 1]), { mcpServers: { atelier: { command: 'C:\\node\\node.exe', args: [path.join(studioDir, 'bin', 'atelier-mcp.mjs'), '--studio', 'http://127.0.0.1:4800', '--project', 'p_abc123'] } } });
  const a = on.indexOf('--allowedTools');
  assert.deepEqual(on.slice(a, a + 2), ['--allowedTools', 'mcp__atelier__*']);
  assert.equal(STUDIO_TOOLS_RULE, 'mcp__atelier__*');
  const p = on.indexOf('--append-system-prompt');
  assert.equal(on[p + 1], STUDIO_TOOLS_PROMPT);
  assert.equal(STUDIO_TOOLS_PROMPT.split(/(?<=\.) /).length, 2, 'two sentences');
  assert.match(STUDIO_TOOLS_PROMPT, /goes through a task .* or a kept version .*, not by editing its files, unless the person asked/);

  const noProject = claudeArgs({ ...base, projectId: null, tools: 'studio' }, { studioDir });
  assert.ok(!JSON.parse(noProject[noProject.indexOf('--mcp-config') + 1]).mcpServers.atelier.args.includes('--project'), 'no project, no --project');
  assert.equal(JSON.parse(noProject[noProject.indexOf('--mcp-config') + 1]).mcpServers.atelier.command, process.execPath);

  const both = claudeArgs({ ...base, tools: 'studio', allowStudioCli: true }, { studioDir });
  assert.deepEqual(both.filter((x) => x === '--allowedTools').length, 2, 'the studio CLI rules and the tools rule');
  assert.ok(both.includes('Bash(node:*)') && both.includes('mcp__atelier__*'));

  for (const rec of [base, { ...base, tools: null }, { ...base, allowStudioCli: true }]) {
    const off = claudeArgs(rec, { studioDir });
    assert.ok(!off.includes('--mcp-config') && !off.includes('mcp__atelier__*') && !off.includes('--append-system-prompt'), JSON.stringify(off));
  }

  const { c, finished } = setup();
  const s = await c.createSession({ backend: 'claude-code', projectId: 'p_x', tools: 'studio' });
  assert.equal(s.tools, 'studio');
  assert.equal((await c.createSession({ backend: 'claude-code' })).tools, null, 'off by default');
  assert.equal((await c.createSession({ backend: 'command', tools: 'studio' })).tools, null, 'only Claude Code attaches tools');
  await assert.rejects(c.createSession({ backend: 'claude-code', tools: 'everything' }), (e) => e.status === 400);
  // The run uses the same argv (the fake prints it; the status line is cut at 300 characters, past --mcp-config).
  const r = await c.send(s.id, { text: 'go' });
  const turn = (await finished(r.runId)).payload.turn;
  const line = turn.events.find((e) => e.kind === 'status' && e.summary.startsWith('argv '));
  assert.ok(line?.summary.includes('"--mcp-config","{\\"mcpServers\\":{\\"atelier\\"'), line?.summary);
});

test('addDirs: extra folders become --add-dir argv entries; bad input is 400', async () => {
  const { c, finished, projectsDir } = setup();
  const sibling = path.join(projectsDir, 'room-one');
  fs.mkdirSync(sibling);
  const s = await c.createSession({ backend: 'claude-code', addDirs: [sibling] });
  const r = await c.send(s.id, { text: 'hello' });
  const argv = argvOf((await finished(r.runId)).payload.turn);
  const i = argv.indexOf('--add-dir');
  assert.ok(i > 0, JSON.stringify(argv));
  assert.equal(argv[i + 1], sibling);
  await assert.rejects(() => c.createSession({ backend: 'claude-code', addDirs: 'x' }), /addDirs/);
});

test('addDirs: accepts a folder in the projects root, the studio and a registered project, stored resolved', async () => {
  const { c, projectDir, projectsDir, studioDir } = setup();
  const sibling = path.join(projectsDir, 'room-one');
  const templates = path.join(studioDir, 'templates');
  const dotted = path.join(projectsDir, '..room');
  for (const d of [sibling, templates, dotted]) fs.mkdirSync(d);
  const unresolved = `${path.join(projectsDir, 'room-one', 'x')}${path.sep}..`;
  const s = await c.createSession({ backend: 'claude-code', addDirs: [unresolved, templates, studioDir, projectDir, dotted] });
  assert.deepEqual(s.addDirs, [sibling, templates, studioDir, projectDir, dotted]);
});

test('addDirs: a missing folder, a file, a drive root, a relative path and a folder elsewhere are 400 naming the entry', async () => {
  const { c, root, projectsDir } = setup();
  const refused = async (entry, why) => {
    await assert.rejects(() => c.createSession({ backend: 'claude-code', addDirs: [entry] }), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'invalid_input');
      assert.ok(err.message.includes(entry), err.message);
      assert.match(err.message, why);
      return true;
    });
  };
  await refused(path.join(projectsDir, 'missing'), /not an existing folder/);
  const file = path.join(projectsDir, 'a-file');
  fs.writeFileSync(file, 'x');
  await refused(file, /not an existing folder/);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  await refused(elsewhere, /outside/);
  await refused(projectsDir, /outside/); // the root itself would hand over every product
  await refused(path.dirname(projectsDir), /outside/);
  await refused(`${projectsDir}${path.sep}..`, /outside/);
  await refused(path.parse(projectsDir).root, /outside/);
  // On Windows path.resolve('C:') is the working folder, which can be the studio, so these never reach it.
  await refused('C:', /absolute/);
  await refused('C:\\', process.platform === 'win32' ? /outside/ : /absolute/);
  await refused('room-one', /absolute/);
});

test('addDirs: a non-Claude backend ignores them, as it always did', async () => {
  const { c } = setup();
  const s = await c.createSession({ backend: 'command', addDirs: ['C:\\'] });
  assert.deepEqual(s.addDirs, []);
});

test('context companion: the role joins the tools\' prompt in one --append-system-prompt; without it the prompt is the tools\' alone', async () => {
  const { COMPANION_PROMPT, companionReach } = await import('../server/lib/companion.mjs');
  const { MAIL_PROMPT, CHROME_PROMPT } = await import('../server/lib/console.mjs');
  const studioDir = path.join(os.tmpdir(), 'studio-x');
  const base = { model: 'claude-opus-5-5', permissionMode: 'acceptEdits', projectId: 'p_abc123', tools: 'studio' };
  const on = claudeArgs({ ...base, context: 'companion' }, { studioDir, studioProjectId: 'p_studio1' });
  assert.equal(on.filter((x) => x === '--append-system-prompt').length, 1);
  assert.equal(on[on.indexOf('--append-system-prompt') + 1], `${STUDIO_TOOLS_PROMPT}\n\n${COMPANION_PROMPT}\n\n${companionReach(studioDir, 'p_studio1')}\n\n${MAIL_PROMPT}\n\n${CHROME_PROMPT}`);
  // The studio's reach (decision row 127): its folder added, the CLI rules on, the sentence naming the folder and the checkpoint command.
  assert.equal(on[on.indexOf('--add-dir') + 1], studioDir, 'the studio folder is open to the companion');
  assert.ok(on.includes('Bash(node:*)') && on.includes('Bash(npm run:*)'), 'node and npm run without asking');
  assert.match(companionReach(studioDir, 'p_studio1'), /lives in .*studio-x and is open to this session/);
  // The manager (server/lib/workers.mjs): a studio change is a task for a worker in the studio's own project.
  assert.match(companionReach(studioDir, 'p_studio1'), /atelier_start_task with project p_studio1/);
  assert.match(companionReach(studioDir, null), /once the studio is registered/);
  assert.match(COMPANION_PROMPT, /You are the manager/);
  assert.match(COMPANION_PROMPT, /\[Studio report: not from the person\]/);
  // Departments for managers: every task gets one, atelier_list_skills when unsure, the skills that matter named.
  const deptRule = COMPANION_PROMPT.split(/(?<=\.) /).find((s) => s.startsWith('Give every task a department'));
  assert.ok(deptRule, 'the department sentence is in the prompt');
  assert.match(deptRule, /department input of atelier_create_task/);
  assert.match(deptRule, /when unsure .*atelier_list_skills/);
  assert.match(deptRule, /name in the request the skills that matter/);
  assert.ok(COMPANION_PROMPT.indexOf(deptRule) < COMPANION_PROMPT.indexOf('Before you start a worker'), 'said before the worker is started');
  const withEffort = claudeArgs({ ...base, context: 'companion', effort: 'high' }, { studioDir });
  assert.equal(withEffort[withEffort.indexOf('--effort') + 1], 'high', 'the effort level reaches the CLI');
  assert.ok(!claudeArgs({ ...base, context: 'companion', effort: null }, { studioDir }).includes('--effort'), 'none: the CLI\'s default');
  const withDirs = claudeArgs({ ...base, context: 'companion', addDirs: [studioDir, path.join(os.tmpdir(), 'other')] }, { studioDir });
  assert.equal(withDirs.filter((x) => x === '--add-dir').length, 2, 'the studio folder is not added twice');
  for (const words of [/partner inside the Atelier studio for this one project/, /through its tools/, /with the code in hand/, /A change to files goes to a worker/, /do not carry out the change in your own turn/, /naming the files you looked at/]) {
    assert.match(COMPANION_PROMPT, words);
  }
  const plain = claudeArgs(base, { studioDir });
  assert.equal(plain[plain.indexOf('--append-system-prompt') + 1], STUDIO_TOOLS_PROMPT);
  const roleOnly = claudeArgs({ ...base, tools: null, context: 'companion' }, { studioDir });
  assert.equal(roleOnly[roleOnly.indexOf('--append-system-prompt') + 1], `${COMPANION_PROMPT}\n\n${companionReach(studioDir, null)}\n\n${MAIL_PROMPT}\n\n${CHROME_PROMPT}`);
  assert.ok(!plain.includes('--add-dir') && !plain.includes('Bash(node:*)'), 'a plain tools session has no studio reach');
});

test('context companion: the first send carries the context pack ahead of the message, the second resumes without it', async () => {
  const asked = [];
  const pack = ['Studio context (test):', 'Project: Harbor', 'Phone: Android: Booted'].join('\n');
  const { c, finished } = setup({ companionContext: async (rec) => { asked.push(rec.id); return pack; } });
  await assert.rejects(c.createSession({ backend: 'claude-code', context: 'companion' }), (e) => e.status === 400, 'a companion needs a project');
  await assert.rejects(c.createSession({ backend: 'command', projectId: 'p_x', context: 'companion' }), (e) => e.status === 400, 'and Claude Code');
  await assert.rejects(c.createSession({ backend: 'claude-code', projectId: 'p_x', context: 'all' }), (e) => e.status === 400);
  assert.equal((await c.createSession({ backend: 'claude-code', projectId: 'p_x' })).context, null, 'no context by default');
  const s = await c.createSession({ backend: 'claude-code', projectId: 'p_x', tools: 'studio', context: 'companion', title: 'Companion · Harbor' });
  assert.equal(s.context, 'companion');

  const r1 = await c.send(s.id, { text: 'What is this card?' });
  const t1 = (await finished(r1.runId)).payload.turn;
  assert.match(t1.text, /^echo: Studio context \(test\):\nProject: Harbor\nPhone: Android: Booted\n\n---\n\nWhat is this card\? \(cwd /, 'the pack, a rule, then the words');
  assert.equal(t1.contextUsed, 'the studio context');
  const rec1 = await c.getSession(s.id);
  assert.equal(rec1.turns[0].text, 'What is this card?', 'the record keeps what the person wrote');
  assert.equal(rec1.turns[0].contextPack, 3, 'and how many lines went with it');
  assert.deepEqual(asked, [s.id]);

  const r2 = await c.send(s.id, { text: 'And the next one?' });
  const t2 = (await finished(r2.runId)).payload.turn;
  assert.match(t2.text, new RegExp(`^resumed ${rec1.claudeSessionId}\. echo: And the next one\?`));
  assert.equal(t2.contextUsed, undefined);
  assert.deepEqual(asked, [s.id], 'asked once');
  assert.equal((await c.getSession(s.id)).turns[2].contextPack, undefined);

  // A pack that cannot be made does not stop the message: it goes alone.
  const broken = setup({ companionContext: async () => { throw new Error('no project'); } });
  const b = await broken.c.createSession({ backend: 'claude-code', projectId: 'p_x', context: 'companion' });
  const rb = await broken.c.send(b.id, { text: 'hello' });
  assert.match((await broken.finished(rb.runId)).payload.turn.text, /^echo: hello \(cwd /);
});

test('tool calls carry ms, when in the run they came, for the trajectory; list entries say whether the last answer asks', async () => {
  const { c, finished, root } = setup();
  const s = await c.createSession({ backend: 'claude-code', projectId: 'p_x' });
  const r = await c.send(s.id, { text: 'go' });
  const call = (await finished(r.runId)).payload.turn.events.find((e) => e.kind === 'tool');
  assert.ok(Number.isInteger(call.ms) && call.ms >= 0, JSON.stringify(call));
  const asks = async () => (await c.listSessions()).find((x) => x.id === s.id).asks;
  assert.equal(await asks(), false, 'the fake\'s answer ends with the cwd in brackets');
  // The record as an answer that ends on a question, then as one that failed after asking.
  const file = path.join(root, 'data', 'console', `${s.id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.turns[1].text = 'The card is span.mini-case-label in index.html.\n\nShould I make it a task?';
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(await asks(), true);
  rec.turns[1].isError = true;
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(await asks(), false, 'a failed run waits on no answer');
  rec.turns[1].isError = false;
  rec.turns.push({ role: 'user', text: 'Yes', at: rec.turns[1].at });
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(await asks(), false, 'answered');
});

test('claudeEnv: the saved token rides only the studio claude runs; the desktop app host-session variables are dropped (decision row 129)', async () => {
  const { claudeEnv, strippedEnv } = await import('../server/lib/console.mjs');
  const parent = {
    PATH: 'p', CLAUDE_CONFIG_DIR: 'C:/cfg', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_ACCOUNT_UUID: 'a', CLAUDE_CODE_ORGANIZATION_UUID: 'o',
    CLAUDE_CODE_OAUTH_SCOPES: 's', CLAUDE_CODE_MESSAGING_SOCKET: 'm', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_HOST_SESSION_ID: 'h',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_DESKTOP_APP_VERSION: '1', CLAUDE_AGENT_SDK_VERSION: '1', USE_LOCAL_OAUTH: '', USE_STAGING_OAUTH: '',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_EXECPATH: 'x', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', CLAUDE_CODE_USE_BEDROCK: '',
  };
  assert.deepEqual(Object.keys(strippedEnv(parent)).sort(), ['CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'PATH'], 'the person\'s own settings stay');
  assert.equal(claudeEnv(parent, null).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'no token saved: none added');
  assert.equal(claudeEnv(parent, null).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined, 'no token: the session\'s commands keep the person\'s env');
  assert.equal(claudeEnv(parent, 'tok-123').CLAUDE_CODE_OAUTH_TOKEN, 'tok-123');
  assert.equal(claudeEnv({ ...parent, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }, 'tok-123').CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1', 'with the token, its commands, hooks and MCP servers never see it');
  const one = claudeEnv({ ...parent, claude_code_oauth_token: 'old' }, 'tok-123');
  assert.deepEqual(Object.keys(one).filter((k) => k.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN'), ['CLAUDE_CODE_OAUTH_TOKEN'], 'one spelling only, the saved one');
});

test('a signed-out run is a signedOut turn; the saved token reaches the claude child; authStatus asks the CLI in that env (decision row 129)', async () => {
  let token = null;
  const { c, finished } = setup({
    env: { CLAUDE_CODE_HOST_SESSION_ID: 'host-1', CLAUDE_CODE_OAUTH_TOKEN: '' },
    claudeToken: async () => token,
    claudeTokenInfo: async () => (token ? { saved: true, savedAt: '2026-11-07T12:00:00.000Z', endsAbout: '2027-11-07T12:00:00.000Z' } : { saved: false, savedAt: null, endsAbout: null }),
  });
  const s = await c.createSession({ backend: 'claude-code' });
  let turn = (await finished((await c.send(s.id, { text: 'SIGNED_OUT' })).runId)).payload.turn;
  assert.equal(turn.signedOut, true);
  assert.equal(turn.isError, true);
  assert.match(turn.text, /^Failed to authenticate: OAuth session expired/);
  let st = await c.authStatus({ fresh: true });
  assert.deepEqual({ cli: st.cli, loggedIn: st.loggedIn, authMethod: st.authMethod, saved: st.studioToken.saved }, { cli: true, loggedIn: false, authMethod: 'none', saved: false });
  token = 'sk-ant-oat01-console-test-token-0123';
  turn = (await finished((await c.send(s.id, { text: 'AUTH?' })).runId)).payload.turn;
  assert.ok(turn.events.some((e) => e.kind === 'status' && e.summary === 'auth CLAUDE_CODE_OAUTH_TOKEN=present CLAUDE_CODE_HOST_SESSION_ID=absent'), 'the token reached the child, the host session id did not');
  assert.equal(turn.signedOut, undefined, 'a working run is not signed out');
  st = await c.authStatus({ fresh: true });
  assert.deepEqual({ loggedIn: st.loggedIn, authMethod: st.authMethod, saved: st.studioToken.saved }, { loggedIn: true, authMethod: 'oauth_token', saved: true });
  assert.ok(!JSON.stringify(st).includes('console-test-token'), 'the status never carries the token');
  token = null;
  assert.equal((await c.authStatus()).loggedIn, true, 'a minute\'s answer is reused unless fresh');
  assert.equal((await c.authStatus({ fresh: true })).loggedIn, false);
});

test('upgradeSignedOut: a kept turn whose CLI words say it had no sign-in reads as signed out; other failures do not', async () => {
  const { upgradeSignedOut } = await import('../server/lib/console.mjs');
  const kept = { role: 'assistant', backend: 'claude-code', text: 'Failed to authenticate: OAuth session expired and could not be refreshed', events: [], isError: true, exitCode: 1, error: 'claude exited with 1' };
  assert.equal(upgradeSignedOut(kept).signedOut, true);
  assert.equal(upgradeSignedOut({ ...kept, text: 'The build failed: npm run check exited with 1' }).signedOut, undefined, 'another failure stays a failure');
  assert.equal(upgradeSignedOut({ ...kept, events: [{ kind: 'tool', name: 'Read' }] }).signedOut, undefined, 'a run that called tools had a sign-in');
  assert.equal(upgradeSignedOut({ ...kept, isError: false }).signedOut, undefined, 'an answer quoting the words is not a failure');
  assert.equal(upgradeSignedOut({ ...kept, backend: 'api' }).signedOut, undefined);
});

test('Fable 5.2: a session on claude-fable-5-2 is accepted and runs with --model claude-fable-5-2; an unknown id is still 400', async () => {
  const { c, finished } = setup();
  const s = await c.createSession({ backend: 'claude-code', projectId: 'p_x', model: 'claude-fable-5-2' });
  assert.equal(s.model, 'claude-fable-5-2');
  const turn = (await finished((await c.send(s.id, { text: 'which model?' })).runId)).payload.turn;
  const argv = argvOf(turn);
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-fable-5-2');
  assert.deepEqual(Object.keys(turn.modelUsage), ['claude-fable-5-2']);
  await assert.rejects(c.createSession({ backend: 'claude-code', projectId: 'p_x', model: 'claude-fable-5-3' }), /model/i);
});

test('Chrome and read-only Gmail (decision row 150): a companion runs with --chrome unless switched off, every run denies Gmail\'s sending tools', async () => {
  const { GMAIL_WRITE_TOOLS, MAIL_PROMPT, CHROME_PROMPT } = await import('../server/lib/console.mjs');
  const base = { model: 'claude-opus-5-5', permissionMode: 'auto', projectId: 'p_abc123', tools: 'studio' };
  const denied = (args) => args.flatMap((a, i) => (args[i - 1] === '--disallowedTools' ? a.split(',') : []));
  const comp = claudeArgs({ ...base, context: 'companion' }, { studioDir: '/s' });
  assert.ok(comp.includes('--chrome'), 'a companion record without the field works in Chrome');
  const prompt = comp[comp.indexOf('--append-system-prompt') + 1];
  assert.ok(prompt.includes(MAIL_PROMPT) && prompt.includes(CHROME_PROMPT));
  for (const t of ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward', 'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__trash_thread']) assert.ok(denied(comp).includes(t), t);
  for (const t of ['search_threads', 'get_thread', 'get_message', 'list_labels', 'download_gmail_attachment']) assert.ok(!denied(comp).includes(`mcp__claude_ai_Gmail__${t}`), `${t} stays`);
  assert.ok(denied(comp).includes('PowerShell'), 'the studio CLI rules still deny PowerShell');
  assert.equal(GMAIL_WRITE_TOOLS.length, 24);
  const off = claudeArgs({ ...base, context: 'companion', chrome: false }, { studioDir: '/s' });
  assert.ok(!off.includes('--chrome') && !off[off.indexOf('--append-system-prompt') + 1].includes(CHROME_PROMPT), 'switched off: no Chrome and no Chrome sentence');
  const worker = claudeArgs({ ...base, tools: null }, { studioDir: '/s' });
  assert.ok(!worker.includes('--chrome'), 'other sessions never get Chrome');
  assert.ok(denied(worker).includes('mcp__claude_ai_Gmail__send_message'), 'but their Gmail is read-only too');
});

test('chrome on a session record: a companion starts with it on, takes false, a PATCH switches it; other sessions refuse it', async () => {
  const { c } = setup();
  const comp = await c.createSession({ backend: 'claude-code', projectId: 'p_x', context: 'companion', tools: 'studio' });
  assert.equal(comp.chrome, true);
  assert.equal((await c.createSession({ backend: 'claude-code', projectId: 'p_x', context: 'companion', chrome: false })).chrome, false);
  assert.equal((await c.patchSession(comp.id, { chrome: false })).chrome, false);
  assert.equal((await c.patchSession(comp.id, { chrome: true })).chrome, true);
  await assert.rejects(c.patchSession(comp.id, { chrome: 'yes' }), /chrome must be a boolean/);
  const plain = await c.createSession({ backend: 'claude-code', projectId: 'p_x' });
  assert.equal(plain.chrome, null);
  await assert.rejects(c.patchSession(plain.id, { chrome: true }), /Only a companion session/);
  await assert.rejects(c.createSession({ backend: 'claude-code', projectId: 'p_x', context: 'companion', chrome: 1 }), /chrome must be a boolean/);
});
