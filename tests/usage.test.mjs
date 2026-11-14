// The worker and companion usage tally (server/lib/usage.mjs). Risks covered: a turn counts only in the windows it
// ended in; sessions and turns are counted per model and per kind (worker, companion, other); tokens and cost are the
// recorded figures summed, never guessed, and a row or a window whose turns recorded none says "not recorded"; a
// reported model id with a suffix is the studio's id; API and command sessions are left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyUsage, usageText, usageRowWords, studioModelId, turnModel, sessionKind, USAGE_WINDOWS } from '../server/lib/usage.mjs';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();
const usage = (input, output, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
const turn = (hours, extra = {}) => ({ role: 'assistant', backend: 'claude-code', at: ago(hours), text: 'ok', ...extra });
const user = (hours) => ({ role: 'user', at: ago(hours), text: 'go' });

const RECORDS = [
  // a worker on Fable 5.2: one turn 2 h ago with every figure
  { id: 'cs_w1', backend: 'claude-code', projectId: 'p_a', worker: true, model: 'claude-fable-5-2', turns: [user(3), turn(2, { model: 'claude-fable-5-2', usage: usage(100, 2000, 50000, 3000), costUsd: 1.5, modelUsage: { 'claude-fable-5-2': { inputTokens: 100, outputTokens: 1800, cacheReadInputTokens: 50000, cacheCreationInputTokens: 3000, costUSD: 1.4 }, 'claude-haiku-5-5': { inputTokens: 40, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 } } })] },
  // a second worker on Fable 5.2, in another project: one turn 30 h ago (7 d only), cut off with no result event
  { id: 'cs_w2', backend: 'claude-code', projectId: 'p_b', worker: true, model: 'claude-fable-5-2', turns: [user(31), turn(30, { isError: true, error: 'claude exited with 1' })] },
  // a worker on Haiku: two turns, 1 h and 5 h ago, one with usage only
  { id: 'cs_w3', backend: 'claude-code', projectId: 'p_a', worker: true, model: 'claude-haiku-5-5', turns: [user(6), turn(5, { model: 'claude-haiku-5-5', usage: usage(10, 300) }), user(2), turn(1, { model: 'claude-haiku-5-5' })] },
  // the companion: the session is on Opus now, an older turn was reported with a suffixed Fable id; one turn 9 days old
  { id: 'cs_c1', backend: 'claude-code', projectId: 'p_a', context: 'companion', model: 'claude-opus-5-5', turns: [user(220), turn(216, { model: 'claude-opus-5-5', usage: usage(1, 1), costUsd: 9 }), user(50), turn(49, { model: 'claude-fable-5-2[1m]', usage: usage(5, 500, 1000, 0), costUsd: 0.25 }), user(4), turn(3, { usage: usage(7, 700, 2000, 100), costUsd: 0.5 })] },
  // another studio session (a Chat task session), and sessions the tally leaves out
  { id: 'cs_o1', backend: 'claude-code', projectId: 'p_b', model: 'claude-sonnet-5-5', turns: [user(11), turn(10, { model: 'claude-sonnet-5-5', usage: usage(3, 30), costUsd: 0.01 })] },
  { id: 'cs_api', backend: 'api', projectId: 'p_a', model: 'claude-haiku-5-5', turns: [user(2), { role: 'assistant', backend: 'api', at: ago(1), usage: { input_tokens: 999 }, costUsd: 5 }] },
  { id: 'cs_cmd', backend: 'command', projectId: 'p_a', model: null, turns: [user(2), { role: 'assistant', backend: 'command', at: ago(1), text: 'x' }] },
];

test('model ids and kinds: a suffixed or dated id is the studio\'s id; the turn\'s reported model, else the session\'s', () => {
  assert.equal(studioModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(studioModelId('claude-fable-5-2-20261101'), 'claude-fable-5-2');
  assert.equal(studioModelId('claude-fable-5-1'), 'claude-fable-5-1');
  assert.equal(studioModelId('<synthetic>'), null);
  assert.equal(turnModel({ model: 'claude-opus-5-5' }, { model: '<synthetic>' }), 'claude-opus-5-5', 'a model the studio does not know: the session\'s');
  assert.equal(turnModel({ model: 'claude-opus-5-5' }, { model: 'claude-haiku-5-5' }), 'claude-haiku-5-5');
  assert.equal(turnModel({}, {}), 'unknown');
  assert.deepEqual([sessionKind({ worker: true, context: 'companion' }), sessionKind({ context: 'companion' }), sessionKind({})], ['worker', 'companion', 'other']);
  assert.deepEqual(USAGE_WINDOWS.map((w) => [w.id, w.ms / 3600000]), [['24h', 24], ['7d', 168]]);
});

test('24 hours and 7 days: sessions and turns per model and kind, recorded figures summed, missing ones null', () => {
  const tally = tallyUsage(RECORDS, { now: NOW });
  assert.equal(tally.sessionsRead, 5, 'Claude Code sessions only');
  const [day, week] = tally.windows;
  const row = (w, kind, model) => w.rows.find((r) => r.kind === kind && r.model === model);

  assert.deepEqual([day.sessions, day.turns], [4, 5]);
  assert.deepEqual(row(day, 'worker', 'claude-fable-5-2'), { kind: 'worker', model: 'claude-fable-5-2', turns: 1, turnsWithTokens: 1, tokens: { input: 100, output: 2000, cacheRead: 50000, cacheWrite: 3000 }, turnsWithCost: 1, costUsd: 1.5, sessions: 1 });
  const haiku = row(day, 'worker', 'claude-haiku-5-5');
  assert.deepEqual([haiku.sessions, haiku.turns, haiku.turnsWithTokens, haiku.tokens, haiku.turnsWithCost, haiku.costUsd], [1, 2, 1, { input: 10, output: 300, cacheRead: 0, cacheWrite: 0 }, 0, null], 'cost never recorded: null, not 0');
  const opus = row(day, 'companion', 'claude-opus-5-5');
  assert.deepEqual([opus.sessions, opus.turns, opus.costUsd], [1, 1, 0.5], 'a turn with no reported model counts on the session\'s');
  assert.equal(row(day, 'companion', 'claude-fable-5-2'), undefined, '49 h ago is outside the day');
  assert.deepEqual(day.rows.map((r) => r.kind), ['worker', 'worker', 'companion', 'other'], 'workers first, then the companion, then the rest');
  assert.deepEqual(day.answering.map((a) => [a.model, a.output, a.costUsd]), [['claude-fable-5-2', 1800, 1.4], ['claude-haiku-5-5', 200, 0.1]], 'modelUsage by the model that answered, a sub-agent\'s too');

  assert.deepEqual([week.sessions, week.turns], [5, 7], 'the 9-day-old turn is in neither window');
  const fable = row(week, 'worker', 'claude-fable-5-2');
  assert.deepEqual([fable.sessions, fable.turns, fable.turnsWithTokens, fable.turnsWithCost, fable.costUsd], [2, 2, 1, 1, 1.5], 'two sessions on the model; the cut-off turn recorded nothing');
  assert.deepEqual([row(week, 'companion', 'claude-fable-5-2').turns, row(week, 'companion', 'claude-opus-5-5').turns], [1, 1], 'one session counted under each model it ran on');

  const one = tallyUsage(RECORDS, { now: NOW, projectId: 'p_b' });
  assert.deepEqual([one.sessionsRead, one.windows[0].turns, one.windows[1].turns], [2, 1, 2], 'one project\'s sessions only');
  const none = tallyUsage([], { now: NOW });
  assert.deepEqual(none.windows.map((w) => [w.turns, w.rows, w.answering]), [[0, [], []], [0, [], []]]);
});

test('the words: every figure as recorded, "not recorded" where it was not, and no word about what the plan has left', () => {
  const text = usageText(tallyUsage(RECORDS, { now: NOW }));
  assert.match(text, /^Worker and companion usage of every project, counted from the studio's own Claude Code session records \(5 records read\) at 2026-11-11T12:00:00\.000Z\./);
  // within a kind, the model with the most turns first
  assert.match(text, /\nLast 24 hours: 4 sessions, 5 turns, by model and who ran on it\.\n- claude-haiku-5-5 · workers: 1 session, 2 turns · tokens \(recorded for 1 of 2 turns\): in 10, out 300, cache read 0, cache write 0 · cost: not recorded\n- claude-fable-5-2 · workers: 1 session, 1 turn · tokens: in 100, out 2,000, cache read 50,000, cache write 3,000 · cost as Claude Code reported it: \$1\.50\n/);
  assert.match(text, /\n- claude-opus-5-5 · companion \(manager\): 1 session, 1 turn · /);
  assert.match(text, /\n- claude-sonnet-5-5 · other studio sessions: 1 session, 1 turn · /);
  assert.match(text, /\nBy the model that answered, sub-agents included \(Claude Code's modelUsage\): claude-fable-5-2 in 100, out 1,800, cache read 50,000, cache write 3,000; claude-haiku-5-5 in 40, out 200, /);
  assert.match(text, /\nLast 7 days: 5 sessions, 7 turns, /);
  assert.match(text, /- claude-fable-5-2 · workers: 2 sessions, 2 turns · tokens \(recorded for 1 of 2 turns\): .* · cost as Claude Code reported it \(recorded for 1 of 2 turns\): \$1\.50/);
  assert.match(text, /the studio does not know the plan's limits or what is left of them/);
  assert.match(text, /Cost is the list-price figure in Claude Code's result event, not a charge on the plan\./);
  assert.ok(!/remaining|% of|percent/i.test(text), 'no allowance is estimated');

  assert.equal(usageRowWords({ kind: 'worker', model: 'claude-fable-5-2', sessions: 1, turns: 3, turnsWithTokens: 0, tokens: null, turnsWithCost: 0, costUsd: null }), '- claude-fable-5-2 · workers: 1 session, 3 turns · tokens: not recorded · cost: not recorded');
  const quiet = usageText(tallyUsage([RECORDS[1]], { now: NOW }), { scope: 'Room (p_b)' });
  assert.match(quiet, /usage of Room \(p_b\), .*\(1 record read\)/);
  assert.match(quiet, /\nLast 24 hours: no turn of a studio Claude Code session ended in this window\.\n/);
  assert.match(quiet, /\nLast 7 days: 1 session, 1 turn, .*\n- claude-fable-5-2 · workers: 1 session, 1 turn · tokens: not recorded · cost: not recorded\nBy the model that answered: not recorded \(no turn in this window kept Claude Code's modelUsage\)\./);
});
