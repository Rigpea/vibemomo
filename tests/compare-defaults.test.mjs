// What Compare opens on (client/components/compare-defaults.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDefaults } from '../client/components/compare-defaults.js';

const cur = { id: 'v8' };
const prev = { id: 'v7' };

test('a non-current version compares with the current one, clean or dirty', () => {
  assert.deepEqual(compareDefaults({ cur, prev, dirty: false, a: 'v3' }), { a: 'v3', b: 'v8' });
  assert.deepEqual(compareDefaults({ cur, prev, dirty: true, a: 'v7' }), { a: 'v7', b: 'v8' });
});

test('the current version compares with the working tree when dirty', () => {
  assert.deepEqual(compareDefaults({ cur, prev, dirty: true, a: 'v8' }), { a: 'v8', b: 'head' });
});

test('the current version compares with the previous one when clean', () => {
  assert.deepEqual(compareDefaults({ cur, prev, dirty: false, a: 'v8' }), { a: 'v7', b: 'v8' });
});

test('the first version, clean, has nothing before it and stays on itself', () => {
  assert.deepEqual(compareDefaults({ cur, dirty: false, a: 'v8' }), { a: 'v8', b: 'v8' });
});

test('nothing given keeps the overview defaults', () => {
  assert.deepEqual(compareDefaults({ cur, prev, dirty: true }), { a: 'v8', b: 'head' });
  assert.deepEqual(compareDefaults({ cur, prev, dirty: false }), { a: 'v7', b: 'v8' });
});

test('an explicit b is respected', () => {
  assert.deepEqual(compareDefaults({ cur, prev, dirty: false, a: 'v3', b: 'head' }), { a: 'v3', b: 'head' });
  assert.deepEqual(compareDefaults({ cur, prev, dirty: false, a: 'v8', b: 'head' }), { a: 'v8', b: 'head' });
});
