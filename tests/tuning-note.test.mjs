// What Keep version says about an unsaved tuning draft (client/components/tuning-note.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsavedTuningNote } from '../client/components/tuning-note.js';

const bundle = (tuningDraft, tuning = 'src/tuning.js') => ({ manifest: { tuning }, project: { ui: { tuningDraft } } });
const draft = { file: 'src/tuning.js', values: { jumpVelocity: 920 }, at: '2026-11-04T10:00:00.000Z' };

test('a draft the product acknowledged says applied live and names the file and the step', () => {
  assert.equal(unsavedTuningNote(bundle(draft), { applied: true }),
    'Your tuning change is applied live but not saved to src/tuning.js. Save it first (Tuning › Save to file), then keep.');
});

test('a draft with no acknowledgement does not claim to be live', () => {
  assert.equal(unsavedTuningNote(bundle(draft)),
    'Your tuning change is not saved to src/tuning.js. Save it first (Tuning › Save to file), then keep.');
});

test('no note without a draft the panel would show', () => {
  assert.equal(unsavedTuningNote(null), null);
  assert.equal(unsavedTuningNote(bundle(null)), null);
  assert.equal(unsavedTuningNote(bundle({ ...draft, values: {} })), null);
  assert.equal(unsavedTuningNote(bundle(draft, 'src/other.js')), null);
});
