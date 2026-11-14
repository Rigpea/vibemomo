// client/components/wave-peaks.js on WAV files built here, byte by byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { peaksFromWav, wavInfo } from '../client/components/wave-peaks.js';

function chunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
}

function fmtChunk({ format = 1, channels = 1, rate = 44100, bits = 16 } = {}) {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(format, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE(rate * channels * (bits / 8), 8);
  b.writeUInt16LE(channels * (bits / 8), 12);
  b.writeUInt16LE(bits, 14);
  return chunk('fmt ', b);
}

function pcm(samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

function riff(...chunks) {
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([head, body]));
}

const wav = (samples, fmt) => riff(fmtChunk(fmt), chunk('data', pcm(samples)));

test('silence gives flat peaks, one per column', () => {
  const peaks = peaksFromWav(wav(new Array(1000).fill(0)), 10);
  assert.equal(peaks.length, 10);
  for (const p of peaks) assert.deepEqual(p, { min: 0, max: 0 });
});

test('a full-scale square gives -1..1 in every column', () => {
  const square = Array.from({ length: 1000 }, (_, i) => (i % 2 ? -32768 : 32767));
  for (const p of peaksFromWav(wav(square), 10)) assert.deepEqual(p, { min: -1, max: 1 });
});

test('each column reads its own slice of the file', () => {
  const half = [...new Array(50).fill(0), ...new Array(50).fill(16384)];
  const peaks = peaksFromWav(wav(half), 2);
  assert.deepEqual(peaks[0], { min: 0, max: 0 });
  assert.ok(Math.abs(peaks[1].max - 0.5) < 0.001 && peaks[1].min === peaks[1].max);
});

test('a bad file throws and says why', () => {
  const good = wav([0, 1, 2, 3]);
  const notRiff = good.slice();
  notRiff[0] = 0x58;
  const notWave = good.slice();
  notWave[8] = 0x58;
  const cases = [
    [new Uint8Array(0), /RIFF/],
    [notRiff, /RIFF/],
    [notWave, /RIFF/],
    ['UklGRg==', /bytes/],
    [riff(chunk('data', pcm([0]))), /no fmt/],
    [riff(fmtChunk()), /no data/],
    [riff(chunk('fmt ', Buffer.alloc(4)), chunk('data', pcm([0]))), /too short/],
    [wav([0], { bits: 8 }), /16-bit PCM/],
    [wav([0], { format: 3, bits: 32 }), /16-bit PCM/],
    [wav([0, 0, 0], { channels: 3 }), /3 channels/],
    [wav([0], { rate: 0 }), /sample rate/],
    [good.subarray(0, good.length - 2), /past the end/],
  ];
  for (const [bytes, message] of cases) {
    assert.throws(() => peaksFromWav(bytes, 4), message);
    assert.throws(() => wavInfo(bytes), message);
  }
});

test('of stereo, only the first channel counts', () => {
  const left0right1 = Array.from({ length: 200 }, (_, i) => (i % 2 ? 32767 : 0));
  for (const p of peaksFromWav(wav(left0right1, { channels: 2 }), 4)) assert.deepEqual(p, { min: 0, max: 0 });
});

test('other chunks are stepped over, an odd one with its pad byte, and fmt may follow data', () => {
  const samples = new Array(100).fill(32767);
  const odd = riff(chunk('LIST', Buffer.alloc(3, 0x41)), fmtChunk(), chunk('data', pcm(samples)));
  assert.deepEqual(peaksFromWav(odd, 1), [{ min: 1, max: 1 }]);
  const swapped = riff(chunk('data', pcm(samples)), fmtChunk());
  assert.deepEqual(peaksFromWav(swapped, 1), [{ min: 1, max: 1 }]);
});

test('bytes that sit inside a larger buffer are read from their own start', () => {
  const file = wav(new Array(10).fill(32767));
  const roomy = new Uint8Array(file.length + 7);
  roomy.set(file, 7);
  assert.deepEqual(peaksFromWav(roomy.subarray(7), 1), [{ min: 1, max: 1 }]);
});

test('more columns than frames, or no frames at all, still gives one peak per column', () => {
  assert.deepEqual(peaksFromWav(wav([32767, -32768]), 4), [{ min: 1, max: 1 }, { min: 1, max: 1 }, { min: -1, max: -1 }, { min: -1, max: -1 }]);
  assert.deepEqual(peaksFromWav(wav([]), 2), [{ min: 0, max: 0 }, { min: 0, max: 0 }]);
});

test('columns must be a whole number of at least 1', () => {
  for (const columns of [0, -1, 1.5, undefined, '4']) assert.throws(() => peaksFromWav(wav([0]), columns), /columns/);
});

test('wavInfo gives the length the file itself holds', () => {
  assert.deepEqual(wavInfo(wav(new Array(22050).fill(0))), { sampleRate: 44100, channels: 1, frames: 22050, seconds: 0.5 });
  assert.equal(wavInfo(wav(new Array(44100).fill(0), { channels: 2 })).seconds, 0.5);
});
