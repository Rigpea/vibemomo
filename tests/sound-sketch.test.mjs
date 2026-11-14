// The audio template's studio link: sketch.js run in Node against a fake Web Audio that refuses what
// the real one refuses (an exponential ramp to 0, a stop before a start). This tests what the page
// answers and what it schedules. It cannot test how a real browser sounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'audio-sound-sketch');
const sketchText = fs.readFileSync(path.join(root, 'src', 'sketch.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'atelier.json'), 'utf8'));
const CUES = manifest.cues.map((c) => c.id);

function param(value = 0) {
  return {
    value,
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) {
      if (!(v > 0)) throw new RangeError('exponential ramp needs a positive value');
      this.value = v;
    },
  };
}

class FakeContext {
  constructor(sampleRate) { this.sampleRate = sampleRate; this.currentTime = 0; this.destination = {}; this.played = []; }
  node(extra) { return { connect(to) { return to; }, ...extra }; }
  source(extra) {
    const rec = { start: null, stop: null };
    this.played.push(rec);
    return this.node({
      ...extra,
      start(t) { rec.start = t; },
      stop(t) { if (rec.start === null || t <= rec.start) throw new Error('stop before start'); rec.stop = t; },
    });
  }
  createGain() { return this.node({ gain: param(1) }); }
  createBiquadFilter() { return this.node({ type: '', frequency: param(), Q: param() }); }
  createOscillator() { return this.source({ type: 'sine', frequency: param() }); }
  createBufferSource() { return this.source({ buffer: null }); }
  createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
}

/** Load sketch.js as an embedded page. `unlocked` says whether the fake context may run. */
function page({ unlocked = true, storageKey = 'chime-box', offline = true } = {}) {
  const offlineRuns = [];
  const posted = [];
  const listeners = { message: [], keydown: [] };
  const stored = {};
  const contexts = [];
  const buttons = CUES.map((id) => ({ id, clicks: [], getAttribute: () => id, addEventListener(_n, fn) { this.clicks.push(fn); } }));
  const parent = { postMessage: (m) => posted.push(m) };
  class AudioContext extends FakeContext {
    constructor() { super(48000); this.state = 'suspended'; contexts.push(this); }
    resume() {
      if (!unlocked) return new Promise(() => {}); // a real blocked resume() stays pending
      this.state = 'running';
      return Promise.resolve();
    }
  }
  class OfflineAudioContext extends FakeContext {
    constructor(channels, length, sampleRate) { super(sampleRate); this.channels = channels; this.length = length; }
    startRendering() {
      offlineRuns.push(this);
      const data = new Float32Array(this.length);
      data[10] = 0.25;
      data[20] = -0.5;
      data[this.length - 1] = 0.125; // the last sample must reach the file
      return Promise.resolve({ length: this.length, getChannelData: () => data });
    }
  }
  const window = {
    ATELIER_TUNING: {},
    parent,
    AudioContext,
    OfflineAudioContext: offline ? OfflineAudioContext : undefined,
    addEventListener: (name, fn) => (listeners[name] ||= []).push(fn),
    performance: { now: () => 5 },
    localStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } },
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
  };
  const element = () => ({ textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} });
  const elements = { status: element(), 'btn-mute': element() };
  const document = {
    documentElement: { dataset: storageKey ? { storageKey } : {} },
    getElementById: (id) => elements[id],
    querySelectorAll: () => buttons,
  };
  vm.runInNewContext(sketchText, { window, document, setTimeout });
  const send = (data) => listeners.message.forEach((fn) => fn({ source: parent, data }));
  const answer = async (data, name) => {
    const seen = posted.length;
    send(data);
    for (let i = 0; i < 100; i++) {
      const hit = posted.slice(seen).find((m) => m.type === 'atelier:event' && m.name === name);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no ${name} answer to ${JSON.stringify(data)}`);
  };
  const key = (code, extra = {}) => listeners.keydown.forEach((fn) => fn({ code, ...extra }));
  return { window, posted, parent, send, answer, key, stored, contexts, offlineRuns, buttons, elements, listeners };
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('load: reports ready with the active tuning', () => {
  const { posted } = page();
  assert.equal(posted[0].type, 'atelier:ready');
  assert.equal(posted[0].tuning.masterVolume, 0.8);
});

test('cue: a running context schedules the sound, under 400 ms, and answers played', async () => {
  const p = page();
  for (const id of CUES) {
    const ev = await p.answer({ type: 'atelier:cue', id }, 'cue');
    assert.deepEqual(plain(ev.data), { id, played: true, seconds: p.window.Sketch.cueLengthMs(id) / 1000, peak: 0.5 });
    assert.equal(typeof ev.t, 'number');
    const ac = p.contexts[0];
    assert.ok(ac.played.length > 0, `${id} scheduled nothing`);
    const last = ac.played.at(-1);
    assert.ok(last.stop - last.start < 0.4, `${id} lasts ${last.stop - last.start} s`);
    ac.played.length = 0;
  }
});

test('cue: the peak is rendered once per cue and tuning, and again only when the tuning changes', async () => {
  const p = page();
  const play = (id) => p.answer({ type: 'atelier:cue', id }, 'cue');
  assert.equal(p.offlineRuns.length, 0, 'nothing is rendered before a cue is played');
  await play('tap');
  assert.equal(p.offlineRuns.length, 1);
  await play('tap');
  assert.equal(p.offlineRuns.length, 1, 'the same tuning reuses the measurement');
  await play('blip');
  assert.equal(p.offlineRuns.length, 2, 'each cue has its own');
  const same = p.window.Sketch.getTuning().tapVolume;
  p.send({ type: 'atelier:tuning', tuning: { tapVolume: same } });
  await play('tap');
  assert.equal(p.offlineRuns.length, 2, 'sending the same value is not a change');
  p.send({ type: 'atelier:tuning', tuning: { tapVolume: same / 2, tapDecayMs: 60 } });
  const tuned = await play('tap');
  assert.equal(p.offlineRuns.length, 3, 'a new value measures again');
  assert.equal(tuned.data.seconds, 62 / 1000);
  await play('blip');
  assert.equal(p.offlineRuns.length, 4, 'the whole cache goes: masterVolume reaches every cue');
});

test('cue: a measurement overtaken by a tuning change answers its own play and is not kept', async () => {
  const p = page();
  const first = p.answer({ type: 'atelier:cue', id: 'tap' }, 'cue');
  for (let i = 0; i < 100 && !p.offlineRuns.length; i++) await new Promise((r) => setTimeout(r, 1));
  p.send({ type: 'atelier:tuning', tuning: { tapDecayMs: 60 } });
  assert.equal((await first).data.seconds, 32 / 1000);
  await p.answer({ type: 'atelier:cue', id: 'tap' }, 'cue');
  assert.equal(p.offlineRuns.length, 2);
  assert.equal(p.offlineRuns[1].length, Math.ceil(44100 * (62 + 50) / 1000), 'the second run renders the new tuning');
});

test('cue: without an offline render a played cue reports no peak, and still played', async () => {
  const p = page({ offline: false });
  const ev = await p.answer({ type: 'atelier:cue', id: 'tap' }, 'cue');
  assert.deepEqual(plain(ev.data), { id: 'tap', played: true, seconds: 32 / 1000 });
  assert.ok(p.contexts[0].played.length > 0);
});

test('cue: a refused cue renders nothing; a refused hand play reports nothing', async () => {
  const p = page();
  p.key('KeyM');
  const refused = await p.answer({ type: 'atelier:cue', id: 'tap' }, 'cue');
  assert.deepEqual(plain(refused.data), { id: 'tap', played: false, reason: 'muted' });
  p.key('Digit2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.posted.filter((m) => m.name === 'blip').length, 0);
  assert.equal(p.offlineRuns.length, 0);
});

test('fired: a key or a button reports the same seconds and peak as a Trigger, and says how', async () => {
  const p = page();
  const played = await p.answer({ type: 'atelier:cue', id: 'blip' }, 'cue');
  p.key('Digit2');
  p.buttons.find((b) => b.id === 'blip').clicks[0]();
  await new Promise((r) => setTimeout(r, 20));
  const [key, press] = p.posted.filter((m) => m.name === 'blip');
  assert.deepEqual(plain(key.data), { how: 'key', seconds: played.data.seconds, peak: played.data.peak });
  assert.deepEqual(plain(press.data), { how: 'button', seconds: played.data.seconds, peak: played.data.peak });
  assert.equal(p.offlineRuns.length, 1, 'the peak is measured once per tuning, whoever asks');
});

test('fired: without an offline render a hand play reports no peak, and still fires', async () => {
  const p = page({ offline: false });
  p.key('Digit1');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(plain(p.posted.find((m) => m.name === 'tap').data), { how: 'key', seconds: 32 / 1000 });
});

test('cue: a suspended context answers played:false with the exact reason and schedules nothing', async () => {
  const p = page({ unlocked: false });
  const ev = await p.answer({ type: 'atelier:cue', id: 'tap' }, 'cue');
  assert.deepEqual(plain(ev.data), { id: 'tap', played: false, reason: 'suspended: click in the page first' });
  assert.equal(p.contexts[0].played.length, 0);
});

test('cue: unknown, muted and silent cues say why', async () => {
  const p = page();
  assert.equal((await p.answer({ type: 'atelier:cue', id: 'nope' }, 'cue')).data.reason, 'unknown cue');
  // A cue id must not reach Object.prototype.
  assert.equal((await p.answer({ type: 'atelier:cue', id: 'constructor' }, 'cue')).data.reason, 'unknown cue');
  p.send({ type: 'atelier:tuning', tuning: { tickVolume: 0 } });
  assert.equal((await p.answer({ type: 'atelier:cue', id: 'tick' }, 'cue')).data.reason, 'volume is 0');
  p.key('KeyM');
  const muted = await p.answer({ type: 'atelier:cue', id: 'tap' }, 'cue');
  assert.equal(muted.data.played, false);
  assert.equal(muted.data.reason, 'muted');
});

test('tuning: answers applied and ignored; unknown keys, wrong types and out-of-range values are rejected', async () => {
  const p = page();
  const ev = await p.answer({ type: 'atelier:tuning', tuning: { tapVolume: 0.1, swellDecayMs: 150, nope: 1, blipVolume: 2, tickDecayMs: 9999, swellPitch: 'high', toString: 1 } }, 'tuning');
  assert.deepEqual(plain(ev.data), { applied: ['tapVolume', 'swellDecayMs'], ignored: ['nope', 'blipVolume', 'tickDecayMs', 'swellPitch', 'toString'] });
  assert.equal(p.window.Sketch.getTuning().tapVolume, 0.1);
  assert.equal(p.window.Sketch.getTuning().blipVolume, 0.25);
  assert.equal(p.window.Sketch.cueLengthMs('swell'), 330);
});

test('render: needs no gesture, ignores mute, and answers a complete WAV', async () => {
  const p = page({ unlocked: false });
  p.key('KeyM');
  for (const id of CUES) {
    const { data } = await p.answer({ type: 'atelier:render', id }, 'render');
    const frames = Math.ceil(44100 * (p.window.Sketch.cueLengthMs(id) + 50) / 1000);
    assert.equal(data.id, id);
    assert.equal(data.sampleRate, 44100);
    assert.equal(data.seconds, frames / 44100);
    assert.equal(data.peak, 0.5);
    const b = Buffer.from(data.wav, 'base64');
    assert.equal(b.length, 44 + frames * 2, `${id}: the base64 holds the whole file`);
    assert.equal(b.toString('latin1', 0, 4), 'RIFF');
    assert.equal(b.readUInt32LE(4), b.length - 8);
    assert.equal(b.toString('latin1', 8, 16), 'WAVEfmt ');
    assert.equal(b.readUInt16LE(20), 1);
    assert.equal(b.readUInt16LE(22), 1);
    assert.equal(b.readUInt32LE(24), 44100);
    assert.equal(b.readUInt32LE(28), 88200);
    assert.equal(b.readUInt16LE(32), 2);
    assert.equal(b.readUInt16LE(34), 16);
    assert.equal(b.toString('latin1', 36, 40), 'data');
    assert.equal(b.readUInt32LE(40), frames * 2);
    assert.equal(b.readInt16LE(44 + 20), Math.round(0.25 * 32767));
    assert.equal(b.readInt16LE(44 + 40), Math.round(-0.5 * 32768));
    assert.equal(b.readInt16LE(44 + (frames - 1) * 2), Math.round(0.125 * 32767), `${id}: the last sample survives the base64 chunks`);
  }
  assert.equal(p.contexts.length, 0, 'a render made no AudioContext');
});

test('render: the answer carries the tuning it rendered with, even when new values arrive during the render', async () => {
  const p = page();
  const first = await p.answer({ type: 'atelier:render', id: 'tap' }, 'render');
  assert.deepEqual(plain(first.data.tuning), plain(p.window.Sketch.getTuning()));
  p.send({ type: 'atelier:tuning', tuning: { tapDecayMs: 60 } });
  const during = p.answer({ type: 'atelier:render', id: 'tap' }, 'render');
  p.send({ type: 'atelier:tuning', tuning: { tapDecayMs: 90 } });
  const { data } = await during;
  assert.equal(data.tuning.tapDecayMs, 60, 'the values the nodes were built with');
  assert.equal(p.window.Sketch.getTuning().tapDecayMs, 90);
});

test('render: an unknown cue answers a reason and no file', async () => {
  const { data } = await page().answer({ type: 'atelier:render', id: 'nope' }, 'render');
  assert.deepEqual(plain(data), { id: 'nope', reason: 'unknown cue' });
});

test('page: mute is kept under the project key; hand plays report as fired; messages from elsewhere are ignored', async () => {
  const p = page();
  p.key('KeyM');
  assert.equal(p.stored['atelier.chime-box.muted'], '1');
  assert.equal(p.elements['btn-mute'].attrs['aria-pressed'], 'true');
  p.key('KeyM');
  assert.equal(p.stored['atelier.chime-box.muted'], '0');

  p.key('Digit2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.posted.filter((m) => m.name === 'blip').length, 1);
  p.key('Digit2', { repeat: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.posted.filter((m) => m.name === 'blip').length, 1, 'a held key does not repeat');
  p.buttons.find((b) => b.id === 'swell').clicks[0]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.posted.filter((m) => m.name === 'swell').length, 1);

  const before = p.posted.length;
  p.listeners.message.forEach((fn) => fn({ source: {}, data: { type: 'atelier:tuning', tuning: { tapVolume: 0.1 } } }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.posted.length, before);
});

test('a project of this manifest gets the Tuning and Audio panels', async () => {
  const { panelKinds } = await import('../client/components/dock.js');
  assert.deepEqual(panelKinds(manifest), ['companion', 'codex', 'source', 'terminal', 'action', 'audio']);
});
