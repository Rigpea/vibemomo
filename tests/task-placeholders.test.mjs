// The Task composer's example text follows the project kind (client/components/task-placeholders.js).
// Regression: every project, notes apps included, was asked about "the jump".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskPlaceholders } from '../client/components/task-placeholders.js';

const KINDS = ['game', 'web-app', 'action', 'audio', 'studio'];

test('every kind has its own request and acceptance example', () => {
  for (const key of ['request', 'acceptance']) {
    const seen = new Set(KINDS.map((k) => taskPlaceholders(k)[key]));
    assert.equal(seen.size, KINDS.length, key);
  }
  for (const k of KINDS) {
    assert.match(taskPlaceholders(k).request, /^What should change\? e\.g\. “.+”$/, k);
    assert.match(taskPlaceholders(k).acceptance, /^e\.g\. /, k);
  }
});

test('only the game talks about the jump', () => {
  assert.match(taskPlaceholders('game').request, /jump/);
  for (const k of KINDS.filter((x) => x !== 'game')) {
    const p = taskPlaceholders(k);
    assert.doesNotMatch(`${p.request} ${p.acceptance}`, /jump/i, k);
  }
});

test('an unknown or missing kind gets a neutral example, never undefined', () => {
  for (const k of ['other', undefined, null, '', 'constructor', 'toString']) {
    const p = taskPlaceholders(k);
    assert.equal(typeof p.request, 'string', String(k));
    assert.equal(typeof p.acceptance, 'string', String(k));
    assert.doesNotMatch(`${p.request} ${p.acceptance}`, /jump/i, String(k));
  }
});
