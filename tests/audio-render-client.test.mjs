// The Audio panel's line about a rendered file, and the preview bus not hoarding rendered files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLine } from '../client/components/render-line.js';
import { createBus } from '../client/components/bus.js';

const saved = { path: 'dist/audio/blip.wav', bytes: 27 * 1024, seconds: 0.31, peak: 0.25, sampleRate: 44100 };

// The words as a person reads them; the next test checks the spaces themselves.
const read = (line) => line.text.replaceAll(' ', ' ');

test('renderLine says what the file is, in the agreed words', () => {
  assert.equal(read(renderLine(saved)), 'Saved dist/audio/blip.wav · 0.31 s · peak -12 dB · 27 KB');
  assert.equal(renderLine(saved).warn, false);
  assert.equal(read(renderLine({ ...saved, peak: 1 })), 'Saved dist/audio/blip.wav · 0.31 s · peak 0 dB · 27 KB');
  assert.equal(read(renderLine({ ...saved, bytes: 3 * 1024 * 1024 })), 'Saved dist/audio/blip.wav · 0.31 s · peak -12 dB · 3.0 MB');
});

test('renderLine can break only at a separator: every ordinary space is next to a dot', () => {
  const { text } = renderLine(saved);
  assert.deepEqual(text.split(' · '), ['Saved dist/audio/blip.wav', '0.31 s', 'peak -12 dB', '27 KB']);
  assert.equal(text.replaceAll(' · ', '').includes(' '), false);
});

test('renderLine ends at the file\'s relative time when given one, and that time holds together too', () => {
  const { text } = renderLine(saved, '2 min ago');
  assert.equal(read({ text }), 'Saved dist/audio/blip.wav · 0.31 s · peak -12 dB · 27 KB · 2 min ago');
  assert.equal(text.replaceAll(' · ', '').includes(' '), false);
});

test('renderLine calls a peak of 0 silent and marks it as a warning', () => {
  const line = renderLine({ ...saved, peak: 0 });
  assert.equal(read(line), 'Saved dist/audio/blip.wav · 0.31 s · silent · 27 KB');
  assert.equal(line.warn, true);
});

test('the bus hands a render event to listeners whole and logs it without the file', () => {
  const bus = createBus();
  const seen = [];
  bus.on('event', (ev) => seen.push(ev));
  bus.receive({ type: 'atelier:event', name: 'render', t: 1, data: { id: 'blip', wav: 'UklGRg==', seconds: 0.1, peak: 0.2, sampleRate: 44100 } });
  assert.equal(seen[0].data.wav, 'UklGRg==');
  assert.deepEqual(bus.events[0].data, { id: 'blip', seconds: 0.1, peak: 0.2, sampleRate: 44100 });
  bus.receive({ type: 'atelier:event', name: 'jump', t: 2, data: { jumps: 1 } });
  assert.deepEqual(bus.events[1].data, { jumps: 1 });
});
