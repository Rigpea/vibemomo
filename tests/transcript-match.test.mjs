// Pairing results and denials with their calls (client/components/transcript-match.js).
// Regression: docs/evidence/ui/uc/run8-result-under-git-diff.jpg, where a refused call never got a
// result, so every later result of that tool slid one call back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRows } from '../client/components/transcript-match.js';

const call = (summary, id) => ({ kind: 'tool', ...(id ? { id } : {}), name: 'Bash', summary });
const denied = (summary, id) => ({ kind: 'denied', ...(id ? { id } : {}), name: 'Bash', summary });
const result = (summary, id, ok = true) => ({ kind: 'tool-result', ...(id ? { id } : {}), name: 'Bash', ok, summary });

/** The rows that are calls, as [call summary, result summary or null, denied?]. */
const pairs = (rows) => rows.filter((r) => r?.e).map((r) => [r.e.summary, r.result ? r.result.summary : null, !!r.denied]);

test('with ids, each result and denial goes to the call with its id, whatever the order', () => {
  const rows = matchRows([
    call('git status', 'a'), call('git diff', 'b'), call('git log', 'c'),
    result('log out', 'c'), denied('git diff', 'b'), result('status out', 'a'),
  ]);
  assert.deepEqual(pairs(rows), [['git status', 'status out', false], ['git diff', null, true], ['git log', 'log out', false]]);
  assert.deepEqual(rows.slice(3), [null, null, null], 'matched events are drawn with their call');
});

test('ids pair calls of the same tool even when the summaries say nothing', () => {
  const rows = matchRows([call('', 'a'), call('', 'b'), result('second', 'b'), result('first', 'a')]);
  assert.deepEqual(rows.filter((r) => r?.e).map((r) => r.result.summary), ['first', 'second']);
});

test('without ids, two refusals before a successful call: the result lands on the successful call', () => {
  const rows = matchRows([
    call('git diff'), denied('git diff'),
    call('git diff --stat'), denied('git diff --stat'),
    call('git status --short'), result('M a.js'),
    call('node finish'), result('{"ok":true}'),
  ]);
  assert.deepEqual(pairs(rows), [
    ['git diff', null, true],
    ['git diff --stat', null, true],
    ['git status --short', 'M a.js', false],
    ['node finish', '{"ok":true}', false],
  ]);
});

test('without ids, a call that already has a result is skipped too', () => {
  const rows = matchRows([call('one'), result('first'), call('two'), result('second')]);
  assert.deepEqual(pairs(rows), [['one', 'first', false], ['two', 'second', false]]);
});

test('without ids, a denial still needs a matching input summary', () => {
  const rows = matchRows([call('git status'), call('git diff'), denied('git diff')]);
  assert.deepEqual(pairs(rows), [['git status', null, false], ['git diff', null, true]]);
});

test('an event with an id does not take a call that has a different id', () => {
  const rows = matchRows([call('git status', 'a'), result('out', 'z', false), denied('git status', 'y')]);
  assert.deepEqual(pairs(rows), [['git status', null, false]]);
  assert.equal(rows[1].orphan.id, 'z');
  assert.equal(rows[2].orphan.id, 'y');
});

test('an end-of-turn denial without an id still finds a call that has one', () => {
  const rows = matchRows([call('git diff', 'a'), denied('git diff')]);
  assert.deepEqual(pairs(rows), [['git diff', null, true]]);
});

test('a result that matches nothing is an orphan; a denial too', () => {
  const failed = result('boom', null, false);
  const refused = denied('git log');
  assert.deepEqual(matchRows([failed, refused]), [{ orphan: failed, tone: 'danger' }, { orphan: refused, tone: 'warn' }]);
});

test('a failed result after the only call was refused is an orphan, not a second answer', () => {
  const failed = result('boom', null, false);
  const rows = matchRows([call('git diff'), denied('git diff'), failed]);
  assert.deepEqual(rows[2], { orphan: failed, tone: 'danger' });
  assert.deepEqual(pairs(rows), [['git diff', null, true]]);
});

test('a successful result that matches nothing draws no row: there is no call to put it under', () => {
  assert.deepEqual(matchRows([result('out')]), [null]);
});

test('status events stay lines, in place', () => {
  const status = { kind: 'status', name: 'status', summary: 'hello' };
  assert.deepEqual(matchRows([status]), [{ line: status }]);
});
