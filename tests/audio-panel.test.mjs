// The real workbenches/audio/panel.js and the real preview bus, with a stub for the DOM helpers: what
// "Render to file" posts, what it saves and what the row says. Layout is not covered here; scripts/ui-check/verify-audio.cjs does that.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { createBus } from '../client/components/bus.js';
import { renderLine } from '../client/components/render-line.js';
import { peaksFromWav, wavInfo, wavPeak } from '../client/components/wave-peaks.js';

const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
const el = (tag, ...rest) => {
  const isAttrs = (a) => a && typeof a === 'object' && !Array.isArray(a) && !('kids' in a);
  const attrs = isAttrs(rest[0]) ? rest.shift() : {};
  const node = {
    tag,
    attrs,
    kids: flatten(rest),
    marks: new Set(),
    classList: { toggle: (name, on) => { if (on) node.marks.add(name); else node.marks.delete(name); } },
    replaceChild: (next, old) => { node.kids[node.kids.indexOf(old)] = next; },
  };
  if (tag === 'canvas') Object.assign(node, fakeCanvas());
  return node;
};
// A canvas that records what is painted on it; the tests that do not set a width stay "hidden", so nothing paints.
const screen = { width: 0, ratio: 1, resized: null };
function fakeCanvas() {
  const rects = [];
  const g = { fillStyle: '', fillRect: (x, y, w, h) => rects.push({ x, y, w, h, color: g.fillStyle }) };
  return { rects, clientWidth: screen.width, clientHeight: 36, getContext: () => g };
}
const focused = [];
const button = (label, attrs = {}) => ({ tag: 'button', attrs, kids: [label], focus() { focused.push(attrs['data-render'] || attrs['data-cue']); } });
// Non-breaking spaces read as spaces here; tests/audio-render-client.test.mjs checks where they go.
const textOf = (n) => (typeof n === 'string' || typeof n === 'number' ? String(n).replaceAll(' ', ' ') : 'data' in n ? textOf(n.data) : (n.kids || []).map(textOf).join(' '));
const buttons = (n) => (typeof n !== 'object' ? [] : [...(n.tag === 'button' ? [n] : []), ...(n.kids || []).flatMap(buttons)]);

globalThis.location = { origin: 'http://studio.test' };
globalThis.document = { activeElement: null, createTextNode: (data) => ({ data, kids: [] }) };
// The words ago() gives; a test changes them to see a time move.
const age = { words: 'now', asked: [] };
globalThis.__ui = { el, button, clear: (c, ...nodes) => { c.kids = flatten(nodes); }, stateChip: (t) => el('span', t), ago: (iso) => { age.asked.push(iso); return age.words; } };
globalThis.__renderLine = { renderLine };
globalThis.__wavePeaks = { peaksFromWav, wavInfo, wavPeak };
const checklists = [];
globalThis.__readiness = { readinessChecklist: () => { const c = { node: el('div', 'Readiness checklist'), renders: 0, render() { c.renders++; } }; checklists.push(c); return c; } };
globalThis.ResizeObserver = class { constructor(cb) { screen.resized = cb; } observe() {} disconnect() {} };
globalThis.window = { get devicePixelRatio() { return screen.ratio; } };
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => ` ${name} ` });

const source = (await fsp.readFile(new URL('../workbenches/audio/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\/components\/ui\.js';/, 'const { el, clear, button, stateChip, ago } = globalThis.__ui;')
  .replace(/import \{ renderLine \} from '\/components\/render-line\.js';/, 'const { renderLine } = globalThis.__renderLine;')
  .replace(/import \{ peaksFromWav, wavInfo, wavPeak \} from '\/components\/wave-peaks\.js';/, 'const { peaksFromWav, wavInfo, wavPeak } = globalThis.__wavePeaks;')
  .replace(/import \{ readinessChecklist \} from '\/components\/readiness\.js';/, 'const { readinessChecklist } = globalThis.__readiness;');
const panel = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const tick = () => new Promise((r) => setImmediate(r));
const FILE = { path: 'dist/audio/blip.wav', bytes: 27 * 1024, mtime: '2026-11-05T05:00:00.000Z', seconds: 0.31, peak: 0.25, sampleRate: 44100 };

// disk stands for the server: what the list answers, and each file's bytes. A save lands in it, as on the real one.
function setup(t, answer = async () => FILE, kind, disk = { list: [], bytes: {} }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const framePosts = [];
  const allFramePosts = [];
  const saves = [];
  const asked = { list: 0, bytes: [] };
  const bus = createBus();
  const container = { kids: [], contains: () => false };
  const ctx = {
    projectId: 'p_1',
    manifest: { kind, cues: [{ id: 'blip', label: 'Blip', trigger: 'Click' }] },
    bus,
    api: {
      audioRender: async (id, body) => {
        saves.push([id, body]);
        const saved = await answer();
        disk.list = [{ id: body.id, ...saved, staleAgainstTuning: false }];
        disk.bytes[body.id] = Buffer.from(body.wav, 'base64');
        return saved;
      },
      audioRenders: async () => { asked.list++; return disk.list; },
      audioRenderBytes: async (id, cue) => { asked.bytes.push(cue); return disk.bytes[cue]; },
    },
    previewFrame: { contentWindow: { postMessage: (msg, origin) => framePosts.push([msg, origin]) } },
    post: (msg) => allFramePosts.push(msg),
  };
  panel.mount(container, ctx);
  const click = () => buttons(container).find((b) => b.kids[0] === 'Render to file').attrs.onclick();
  const say = (data) => bus.receive({ type: 'atelier:event', name: 'render', t: 1, data });
  return { container, ctx, bus, disk, asked, framePosts, allFramePosts, saves, click, say, text: () => textOf(container) };
}

afterEach(() => { panel.unmount(); screen.width = 0; screen.ratio = 1; age.words = 'now'; age.asked.length = 0; focused.length = 0; document.activeElement = null; });

test('a render posts to the main preview only, saves the answer once and shows the server\'s line', async (t) => {
  const p = setup(t);
  p.click();
  assert.deepEqual(p.framePosts, [[{ type: 'atelier:render', id: 'blip' }, 'http://studio.test']]);
  assert.deepEqual(p.allFramePosts, [], 'side-by-side frames are not asked to render');
  assert.match(p.text(), /rendering…/);
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100, extra: 'x' });
  assert.match(p.text(), /saving…/);
  await tick();
  assert.deepEqual(p.saves, [['p_1', { id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 }]]);
  assert.match(p.text(), /Saved dist\/audio\/blip\.wav · 0\.31 s · peak -12 dB · 27 KB/);
  t.mock.timers.tick(4000);
  assert.match(p.text(), /Saved dist/, 'the 3 s wait was called off by the answer');
  assert.doesNotMatch(p.text(), /no render handler/);
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  await tick();
  assert.equal(p.saves.length, 1, 'a repeat answer does not write again');
});

test('no answer in 3 s says sent · no render handler; a late answer still saves', async (t) => {
  const p = setup(t);
  p.click();
  t.mock.timers.tick(2999);
  assert.match(p.text(), /rendering…/);
  assert.doesNotMatch(p.text(), /no render handler/);
  t.mock.timers.tick(1);
  assert.match(p.text(), /sent · no render handler/);
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  await tick();
  assert.match(p.text(), /Saved dist/);
  assert.doesNotMatch(p.text(), /no render handler/);
});

test('a product error shows not rendered, from error or from the template\'s reason, and writes nothing', async (t) => {
  const p = setup(t);
  p.click();
  p.say({ id: 'blip', error: 'no offline audio' });
  assert.match(p.text(), /not rendered: no offline audio/);
  p.click();
  p.say({ id: 'blip', reason: 'unknown cue' });
  assert.match(p.text(), /not rendered: unknown cue/);
  p.click();
  p.say({ id: 'blip', seconds: 1 });
  assert.match(p.text(), /not rendered: the product sent no file/);
  assert.equal(p.saves.length, 0);
});

test('a refusal from the server shows not rendered with its message', async (t) => {
  const p = setup(t, async () => { throw new Error('id must be lowercase letters'); });
  p.click();
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  await tick();
  assert.match(p.text(), /not rendered: id must be lowercase letters/);
});

test('a silent file is saved with a warning line', async (t) => {
  const p = setup(t, async () => ({ ...FILE, peak: 0 }));
  p.click();
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0, sampleRate: 44100 });
  await tick();
  assert.match(p.text(), /Saved dist\/audio\/blip\.wav · 0\.31 s · silent · 27 KB/);
});

test('an answer nobody asked for writes nothing', async (t) => {
  const p = setup(t);
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  await tick();
  assert.equal(p.saves.length, 0);
  assert.doesNotMatch(p.text(), /Saved/);
});

// Every string and tooltip in the tree, so words kept in a title are read too.
const allWords = (n) => (typeof n !== 'object' ? String(n) : [n.attrs?.title || '', ...(n.kids || []).map(allWords)].join(' '));
const triggerCue = (p) => buttons(p.container).find((b) => b.kids[0] === 'Trigger').attrs.onclick();
const sayCue = (p, data) => p.bus.receive({ type: 'atelier:event', name: 'cue', t: 1, data: { id: 'blip', ...data } });

for (const [kind, one, many] of [['game', 'game', 'games'], ['web-app', 'app', 'apps'], ['audio', 'product', 'products'], [undefined, 'product', 'products']]) {
  test(`kind ${kind} says "${one}" in every sentence that names the product`, (t) => {
    const p = setup(t, undefined, kind);
    // "product" is not checked: the Render to file tooltip says it on every kind.
    const others = ['game', 'app'].filter((w) => w !== one);
    const seen = [];
    const look = () => { seen.push(allWords(p.container)); };
    look();
    assert.ok(seen[0].includes(`Events come from the ${one}; a marked row fired in the last 10 s`));
    p.click();
    t.mock.timers.tick(3000);
    look();
    assert.ok(seen[1].includes(`This project did not answer within 3 s. Older ${many} have no render handler.`));
    triggerCue(p);
    t.mock.timers.tick(1000);
    look();
    assert.ok(seen[2].includes(`This project does not confirm cues. New ${one} projects do; older ones need the cue handler.`));
    triggerCue(p);
    sayCue(p, { played: false, reason: 'suspended: click in the page first' });
    look();
    assert.ok(seen[3].includes(`not played: suspended: click in the page first (click in the ${one} first)`));
    for (const word of others) assert.doesNotMatch(seen.join(' '), new RegExp(`\\b${word}s?\\b`), `${word} on kind ${kind}`);
  });
}

test('a played cue shows its length and level only when the product reports both', (t) => {
  const p = setup(t);
  const shown = (data) => { triggerCue(p); sayCue(p, { played: true, ...data }); return p.text(); };
  assert.match(shown({ seconds: 0.08, peak: 0.25 }), /played · 0\.08 s · -12 dB/);
  assert.match(shown({ seconds: 0.08, peak: 1 }), /played · 0\.08 s · 0 dB/);
  assert.match(shown({ seconds: 0.08, peak: 0 }), /played · 0\.08 s · silent/);
  for (const data of [{}, { seconds: 0.08 }, { peak: 0.25 }, { seconds: '0.08', peak: 0.25 }, { seconds: 0.08, peak: -1 }, { seconds: 0.08, peak: null }]) {
    const text = shown(data);
    assert.match(text, /played/);
    assert.doesNotMatch(text, / · /, `plain played for ${JSON.stringify(data)}`);
  }
});

test('a refused cue keeps its reason and shows no numbers', (t) => {
  const p = setup(t);
  triggerCue(p);
  sayCue(p, { played: false, reason: 'muted', seconds: 0.08, peak: 0.25 });
  assert.match(p.text(), /not played: muted/);
  assert.doesNotMatch(p.text(), /dB/);
});

// A real file: half a second of silence at 44100 Hz, mono, 16-bit.
function silentWav(seconds = 0.5, sampleAt = () => 0) {
  const frames = Math.round(seconds * 44100);
  const b = Buffer.alloc(44 + frames * 2);
  for (let i = 0; i < frames; i++) b.writeInt16LE(sampleAt(i, frames), 44 + i * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + frames * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(frames * 2, 40);
  return b.toString('base64');
}
const find = (n, tag) => (typeof n !== 'object' ? [] : [...(n.tag === tag ? [n] : []), ...(n.kids || []).flatMap((k) => find(k, tag))]);
const canvases = (p) => find(p.container, 'canvas');

test('a saved render shows a waveform with the length the file holds, and the Saved line stays as it was', async (t) => {
  const p = setup(t);
  p.click();
  p.say({ id: 'blip', wav: silentWav(0.5), seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  assert.equal(canvases(p).length, 0, 'nothing is drawn before the server has saved it');
  await tick();
  assert.equal(canvases(p).length, 1);
  assert.match(p.text(), /Saved dist\/audio\/blip\.wav · 0\.31 s · peak -12 dB · 27 KB/);
  assert.match(p.text(), /\b0\.50 s\b/, 'the length is read from the bytes, not the product\'s number');
  t.mock.timers.tick(10000);
  assert.equal(canvases(p).length, 1, 'the panel\'s own redraws keep it');
  p.bus.reset();
  assert.equal(canvases(p).length, 1, 'a preview reload keeps it');
});

test('the painting: a faint centre line, then one muted line per device pixel from min to max, at the file\'s real level', async (t) => {
  screen.width = 100;
  screen.ratio = 2;
  const p = setup(t);
  p.click();
  // First half silent, second half a full-scale square.
  p.say({ id: 'blip', wav: silentWav(0.5, (i, n) => (i < n / 2 ? 0 : i % 2 ? -32768 : 32767)), seconds: 0.5, peak: 1, sampleRate: 44100 });
  await tick();
  const [c] = canvases(p);
  assert.deepEqual([c.width, c.height], [200, 72], 'sharp on a 2x screen');
  assert.deepEqual(c.rects[0], { x: 0, y: 36, w: 200, h: 1, color: '--line' });
  const lines = c.rects.slice(1);
  assert.equal(lines.length, 200);
  assert.ok(lines.every((r, x) => r.x === x && r.w === 1 && r.color === '--muted'));
  assert.deepEqual([lines[0].y, lines[0].h], [36, 1], 'silence is one pixel on the centre line');
  assert.deepEqual([lines[199].y, lines[199].h], [0, 72], 'full scale fills the height');
});

test('a waveform hidden with no width paints when the panel gets one', async (t) => {
  const p = setup(t);
  p.click();
  p.say({ id: 'blip', wav: silentWav(), seconds: 0.5, peak: 0, sampleRate: 44100 });
  await tick();
  const [c] = canvases(p);
  assert.equal(c.rects.length, 0);
  c.clientWidth = 50;
  screen.resized();
  assert.equal(c.rects.length, 51);
});

test('a render under way hides the file; a refused one shows the earlier file again, still on disk', async (t) => {
  const p = setup(t);
  p.click();
  p.say({ id: 'blip', wav: silentWav(), seconds: 0.5, peak: 0, sampleRate: 44100 });
  await tick();
  assert.equal(canvases(p).length, 1);
  p.click();
  assert.equal(canvases(p).length, 0);
  assert.doesNotMatch(p.text(), /Saved/);
  p.say({ id: 'blip', reason: 'unknown cue' });
  assert.equal(canvases(p).length, 1);
  assert.match(p.text(), /not rendered: unknown cue/);
  assert.match(p.text(), /Saved dist/);
  p.click();
  p.say({ id: 'blip', wav: silentWav(), seconds: 0.5, peak: 0, sampleRate: 44100 });
  await tick();
  assert.equal(canvases(p).length, 1);
});

test('a file the server refused draws no waveform', async (t) => {
  const p = setup(t, async () => { throw new Error('file is open'); });
  p.click();
  p.say({ id: 'blip', wav: silentWav(), seconds: 0.5, peak: 0, sampleRate: 44100 });
  await tick();
  assert.equal(canvases(p).length, 0);
  assert.match(p.text(), /not rendered: file is open/);
  assert.doesNotMatch(p.text(), /no waveform/);
});

test('a saved file the panel cannot read keeps its Saved line and says why there is no waveform', async (t) => {
  const p = setup(t);
  p.click();
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  await tick();
  assert.equal(canvases(p).length, 0);
  assert.match(p.text(), /Saved dist\/audio\/blip\.wav/);
  assert.match(p.text(), /no waveform: not a RIFF\/WAVE file/);
});

test('a preview reload ends the wait instead of blaming a missing handler', (t) => {
  const p = setup(t);
  p.click();
  p.bus.reset();
  t.mock.timers.tick(4000);
  assert.doesNotMatch(p.text(), /rendering…|no render handler/);
});

// ---------- renders remembered from disk ----------
const STALE = 'rendered at other values than the saved tuning';
const onDisk = (over = {}, samples = (i) => (i % 2 ? -8000 : 8000)) => ({
  list: [{ id: 'blip', path: 'dist/audio/blip.wav', bytes: 27 * 1024, seconds: 0.31, peak: 0.25, sampleRate: 44100, mtime: '2026-11-04T20:00:00.000Z', staleAgainstTuning: false, ...over }],
  bytes: { blip: Buffer.from(silentWav(0.1, samples), 'base64') },
});

test('on mount every row shows its file from the list: the Saved line and the waveform of its bytes, no click needed', async (t) => {
  const p = setup(t, undefined, 'audio', onDisk());
  assert.equal(canvases(p).length, 0, 'nothing is claimed before the list answers');
  await tick();
  await tick();
  assert.match(p.text(), /Saved dist\/audio\/blip\.wav · 0\.31 s · peak -12 dB · 27 KB/);
  assert.deepEqual(p.asked.bytes, ['blip']);
  assert.equal(canvases(p).length, 1);
  assert.doesNotMatch(p.text(), new RegExp(STALE));
  panel.unmount();
  t.mock.timers.reset();
  const again = setup(t, undefined, 'audio', onDisk());
  await tick();
  await tick();
  assert.match(again.text(), /Saved dist\/audio\/blip\.wav/, 'a view change remounts the panel; the file is still known');
});

test('a file whose values differ from the tuning says so in one warning sentence, and a reload re-asks', async (t) => {
  const disk = onDisk({ staleAgainstTuning: true });
  const p = setup(t, undefined, 'audio', disk);
  await tick();
  await tick();
  assert.match(p.text(), new RegExp(STALE));
  const hint = (function look(n) { return typeof n !== 'object' ? null : (n.kids?.includes(STALE) ? n : n.kids?.map(look).find(Boolean) || null); }(p.container));
  assert.equal(hint.attrs.style.color, 'var(--warn)');
  disk.list = [{ ...disk.list[0], staleAgainstTuning: false }];
  p.bus.reset();
  await tick();
  assert.doesNotMatch(p.text(), new RegExp(STALE));
  assert.equal(p.asked.bytes.length, 1, 'an unchanged file keeps the waveform it has');
  assert.equal(canvases(p).length, 1);
  disk.list = [{ ...disk.list[0], staleAgainstTuning: true }];
  panel.update();
  await tick();
  assert.match(p.text(), new RegExp(STALE), 'a bundle refresh asks too: that is how a saved tuning arrives');
});

test('a new render clears the hint at once, and a list that was asked before the save cannot bring it back', async (t) => {
  const disk = onDisk({ staleAgainstTuning: true });
  const p = setup(t, undefined, 'audio', disk);
  await tick();
  await tick();
  p.click();
  const staleList = disk.list;
  p.ctx.api.audioRenders = async () => { await tick(); await tick(); await tick(); return staleList; };
  panel.update(); // asked now, answered after the save below
  p.say({ id: 'blip', wav: silentWav(), seconds: 0.5, peak: 0, sampleRate: 44100 });
  await tick();
  assert.doesNotMatch(p.text(), new RegExp(STALE));
  for (let i = 0; i < 5; i++) await tick();
  assert.doesNotMatch(p.text(), new RegExp(STALE));
});

test('a file that cannot be decoded is named with why; a file for no cue is still mentioned; a failed list says so', async (t) => {
  const disk = onDisk({ seconds: undefined, peak: undefined, sampleRate: undefined, error: 'not 16-bit PCM' });
  disk.list.push({ id: 'old', path: 'dist/audio/old.wav', bytes: 100, seconds: 0.1, peak: 0.1, sampleRate: 44100, mtime: 'x', staleAgainstTuning: false });
  const p = setup(t, undefined, 'audio', disk);
  await tick();
  await tick();
  assert.match(p.text(), /dist\/audio\/blip\.wav cannot be read: not 16-bit PCM/);
  assert.deepEqual(p.asked.bytes, [], 'nothing is fetched for a file already known to be unreadable, or for no cue');
  assert.match(p.text(), /Also on disk, for no cue here: dist\/audio\/old\.wav/);
  p.ctx.api.audioRenders = async () => { throw new Error('offline'); };
  panel.update();
  await tick();
  assert.match(p.text(), /renders not listed: offline/);
});

test('an answer that lands after the panel is gone touches nothing', async (t) => {
  const p = setup(t, undefined, 'audio', onDisk());
  panel.unmount();
  await tick();
  await tick();
  assert.equal(p.asked.bytes.length, 0);
});

// ---------- one line per row, plays counted together ----------
const fireCue = (p, data = {}) => p.bus.receive({ type: 'atelier:event', name: 'blip', t: 1, data });
const NUMBERS = { seconds: 0.11, peak: 0.2 };

test('a key press shows like a Trigger, and the count holds both', (t) => {
  const p = setup(t);
  triggerCue(p);
  sayCue(p, { played: true, ...NUMBERS });
  assert.match(p.text(), /played · 0\.11 s · -14 dB · 1× · last now · Trigger/);
  fireCue(p, { ...NUMBERS, how: 'key' });
  assert.match(p.text(), /played · 0\.11 s · -14 dB · 2× · last now · key/);
  assert.doesNotMatch(p.text(), /fired \d/);
  fireCue(p, { ...NUMBERS, how: 'button' });
  assert.match(p.text(), /played · 0\.11 s · -14 dB · 3× · last now · button/);
  triggerCue(p);
  sayCue(p, { played: true, seconds: 0.11, peak: 0.1 });
  assert.match(p.text(), /played · 0\.11 s · -20 dB · 4× · last now · Trigger/, 'the numbers are the newest play\'s');
});

test('an older product: numbers without how end at the time; a refused Trigger is not a play', (t) => {
  const p = setup(t);
  fireCue(p, NUMBERS);
  assert.match(p.text(), /played · 0\.11 s · -14 dB · 1× · last now(?! ·)/);
  sayCue(p, { played: false, reason: 'muted' });
  fireCue(p, NUMBERS);
  assert.match(p.text(), / 2× /);
});

test('events with no numbers keep "fired N× · last now", as Room One sends them; its plain Trigger counts too', (t) => {
  const p = setup(t, undefined, 'game');
  fireCue(p);
  fireCue(p);
  assert.match(p.text(), /fired 2× · last now(?! ·)/);
  assert.doesNotMatch(p.text(), /played/);
  triggerCue(p);
  sayCue(p, { played: true });
  assert.match(p.text(), /Blip .*\bplayed\b/);
  assert.doesNotMatch(p.text(), /fired \d/);
  fireCue(p);
  assert.match(p.text(), /fired 4× · last now/);
});

test('another cue\'s acknowledgement is not this row\'s play', (t) => {
  const p = setup(t);
  p.bus.receive({ type: 'atelier:event', name: 'cue', t: 1, data: { id: 'tap', played: true, ...NUMBERS } });
  assert.match(p.text(), /not fired yet/);
});

// ---------- side-by-side frames ----------
const fromFrame = (p, frame, name, data) => p.bus.receiveFrame(frame, { type: 'atelier:event', name, t: 1, data });
const framesOpen = (p) => { p.ctx.app = { previewTargets: new Set([{}, {}]) }; };

test('a Trigger names every frame that acknowledged, with the first report\'s numbers', (t) => {
  const p = setup(t);
  framesOpen(p);
  triggerCue(p);
  sayCue(p, { played: true, ...NUMBERS });
  assert.match(p.text(), /played in main · 0\.11 s · -14 dB/, 'only main has answered yet');
  fromFrame(p, 'B', 'cue', { id: 'blip', played: true, seconds: 0.5, peak: 0.9 });
  fromFrame(p, 'A', 'cue', { id: 'blip', played: true, seconds: 0.5, peak: 0.9 });
  assert.match(p.text(), /played in main, A, B · 0\.11 s · -14 dB(?! ·)/);
  assert.match(allWords(p.container), /1×, last at /, 'the count and the time are in the title');
});

test('a plain acknowledgement names the frames and nothing more; a refusing frame is not named', (t) => {
  const p = setup(t, undefined, 'game');
  framesOpen(p);
  triggerCue(p);
  sayCue(p, { played: true });
  fromFrame(p, 'A', 'cue', { id: 'blip', played: false, reason: 'muted' });
  fromFrame(p, 'B', 'cue', { id: 'blip', played: true });
  assert.match(p.text(), /Blip .*played in main, B(?! ·)/);
});

test('with no frames open a Trigger reads as before', (t) => {
  const p = setup(t);
  triggerCue(p);
  sayCue(p, { played: true, ...NUMBERS });
  assert.match(p.text(), /played · 0\.11 s · -14 dB · 1×/);
});

test('a press inside a frame names it, a mirrored press is one play, and telemetry stays the main preview\'s', (t) => {
  const p = setup(t);
  fromFrame(p, 'A', 'blip', { how: 'key' });
  assert.match(p.text(), /fired in A · key(?! ·)/);
  fromFrame(p, 'B', 'blip', { how: 'key', ...NUMBERS });
  assert.match(p.text(), /fired in A, B · key(?! ·)/, 'the second frame joins, the first report\'s numbers stay');
  assert.match(allWords(p.container), /1×, last at /);
  fromFrame(p, 'B', 'blip', { how: 'key', ...NUMBERS });
  assert.match(p.text(), /fired in B · key · 0\.11 s · -14 dB(?! ·)/, 'the same frame again is a new play');
  assert.match(allWords(p.container), /2×, last at /);
  assert.equal(p.bus.events.length, 0);
});

test('presses in two frames further apart than one press are two plays', (t) => {
  const p = setup(t);
  const now = t.mock.method(Date, 'now', () => 1000);
  fromFrame(p, 'A', 'blip', { how: 'key' });
  now.mock.mockImplementation(() => 1400);
  fromFrame(p, 'B', 'blip', { how: 'key' });
  assert.match(p.text(), /fired in B · key(?! ·)/);
  assert.match(allWords(p.container), /2×, last at /);
});

test('a frame\'s render never reaches the panel\'s answer, and a preview reload forgets the frames', (t) => {
  const p = setup(t);
  p.click();
  fromFrame(p, 'A', 'render', { id: 'blip', wav: 'UklGRg==', seconds: 0.1, peak: 0.2, sampleRate: 44100 });
  assert.equal(p.saves.length, 0);
  assert.equal(p.bus.frameEvents[0].data.wav, undefined, 'the log keeps the facts only');
  fromFrame(p, 'A', 'blip', { how: 'key' });
  p.bus.reset();
  assert.match(p.text(), /not fired yet/);
});

test('a frame\'s own reload forgets its plays and keeps the other frame\'s and the main preview\'s', (t) => {
  const p = setup(t);
  fromFrame(p, 'A', 'blip', { how: 'key' });
  assert.match(p.text(), /fired in A · key/);
  p.bus.resetFrame('A');
  assert.match(p.text(), /not fired yet/, 'the row redraws at once');
  fromFrame(p, 'A', 'blip', { how: 'key' });
  fromFrame(p, 'B', 'blip', { how: 'key' });
  assert.match(p.text(), /fired in A, B · key/);
  p.bus.resetFrame('A');
  assert.match(p.text(), /fired in B · key/);
  assert.doesNotMatch(p.text(), /fired in A/);
  fireCue(p);
  p.bus.resetFrame('B');
  assert.match(p.text(), /fired 1× · last now/, 'the main preview\'s play stays');
  assert.equal(p.bus.events.length, 1);
});

// ---------- a render answer after a project switch ----------
// The POST for the first panel is held open until the test lets it answer.
function heldAnswer(body = FILE) {
  let finish;
  let refuse;
  const answer = () => new Promise((resolve, reject) => { finish = () => resolve(body); refuse = () => reject(new Error('file is open')); });
  return { answer, finish: () => finish(), refuse: () => refuse() };
}

const switchProject = async (t) => {
  panel.unmount();
  t.mock.timers.reset();
  const other = onDisk({ id: 'blip', path: 'dist/audio/blip.wav', bytes: 5 * 1024, seconds: 0.11, peak: 0.5 });
  const b = setup(t, async () => { throw new Error('nothing is saved for B'); }, 'audio', other);
  b.ctx.projectId = 'p_2';
  await tick();
  await tick();
  return b;
};

test('a render answer after a project switch leaves the new panel alone: its row and its list', async (t) => {
  const held = heldAnswer();
  const a = setup(t, held.answer);
  a.click();
  a.say({ id: 'blip', wav: silentWav(), seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  assert.equal(a.saves.length, 1, 'the POST is under way, for project A');
  const b = await switchProject(t);
  const shown = /Saved dist\/audio\/blip\.wav · 0\.11 s · peak -6 dB · 5 KB/;
  assert.match(b.text(), shown);
  const waveBefore = canvases(b)[0];
  b.ctx.api.audioRenders = async () => { await tick(); await tick(); return onDisk({ bytes: 6 * 1024, seconds: 0.22, peak: 0.5 }).list; };
  panel.update(); // a list of B's own is in flight when A's answer lands
  held.finish();
  await tick();
  assert.match(b.text(), shown, 'nothing of A\'s Saved line');
  assert.doesNotMatch(b.text(), /0\.31 s|27 KB/);
  assert.ok(waveBefore, 'B had its own waveform');
  assert.equal(canvases(b).length, 1, 'and A\'s did not join or replace it');
  for (let i = 0; i < 5; i++) await tick();
  assert.match(b.text(), /Saved dist\/audio\/blip\.wav · 0\.22 s · peak -6 dB · 6 KB/, 'B\'s own list still lands: A\'s answer called nothing off');
  assert.equal(b.saves.length, 0);
});

test('a refusal after a project switch writes nothing on the new panel', async (t) => {
  const held = heldAnswer();
  const a = setup(t, held.answer);
  a.click();
  a.say({ id: 'blip', wav: silentWav(), seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  const b = await switchProject(t);
  held.refuse();
  await tick();
  assert.doesNotMatch(b.text(), /not rendered/);
});

// ---------- where a render stands against the tuning file ----------
const OTHER_VALUES = 'rendered at other values than the saved tuning';

test('the product\'s tuning goes with the render; an older product\'s answer has none', async (t) => {
  const p = setup(t);
  p.click();
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100, tuning: { blipPitch: 880 } });
  await tick();
  assert.deepEqual(p.saves[0][1].tuning, { blipPitch: 880 });
  p.click();
  p.say({ id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 });
  await tick();
  assert.equal('tuning' in p.saves[1][1], false);
});

test('tuning at render unknown is a muted line, not the warning', async (t) => {
  const p = setup(t, undefined, 'audio', onDisk({ tuningUnknown: true }));
  await tick();
  await tick();
  const line = (function look(n) { return typeof n !== 'object' ? null : (n.kids?.includes('tuning at render unknown') ? n : n.kids?.map(look).find(Boolean) || null); }(p.container));
  assert.equal(line.tag, 'div.small.muted');
  assert.doesNotMatch(p.text(), new RegExp(OTHER_VALUES));
});

test('a render saved at values the tuning file does not hold says so at once: the answer decides, not the panel', async (t) => {
  const p = setup(t, async () => ({ ...FILE, staleAgainstTuning: true, tuningUnknown: false }));
  p.click();
  p.say({ id: 'blip', wav: silentWav(), seconds: 0.31, peak: 0.25, sampleRate: 44100, tuning: { blipPitch: 500 } });
  await tick();
  assert.match(p.text(), new RegExp(OTHER_VALUES));
});

// ---------- a row stays the same node while nothing changes ----------
const rowOf = (p) => find(p.container, 'li')[0];
const renderAnswer = { id: 'blip', wav: 'UklGRg==', seconds: 0.31, peak: 0.25, sampleRate: 44100 };

test('nothing happening leaves the row, its buttons and the bar as the same nodes: ticks, other events, a ready, a refresh with the same list', async (t) => {
  const p = setup(t, undefined, 'audio', onDisk());
  await tick();
  await tick();
  const row = rowOf(p);
  const [trigger, render] = buttons(row);
  const bar = find(p.container, 'div.panel-bar')[0];
  t.mock.timers.tick(20000);
  p.bus.receive({ type: 'atelier:event', name: 'jump', t: 1, data: {} });
  p.bus.receive({ type: 'atelier:event', name: 'tap', t: 1, data: { how: 'key' } });
  panel.update();
  await tick();
  assert.equal(rowOf(p), row);
  assert.deepEqual(buttons(rowOf(p)), [trigger, render]);
  assert.equal(find(p.container, 'div.panel-bar')[0], bar);
  assert.equal(p.asked.bytes.length, 1, 'the waveform was not fetched again');
});

test('a row is rebuilt when its words change, and only that row', (t) => {
  const p = setup(t);
  p.ctx.manifest.cues.push({ id: 'tap', label: 'Tap', trigger: 'Key' });
  panel.update();
  const [blip, tap] = find(p.container, 'li');
  fireCue(p);
  const [blipAfter, tapAfter] = find(p.container, 'li');
  assert.notEqual(blipAfter, blip);
  assert.equal(tapAfter, tap);
});

test('the time on the played line moves in its own text node; the row stays', (t) => {
  const p = setup(t);
  fireCue(p, NUMBERS);
  const row = rowOf(p);
  assert.match(p.text(), /1× · last now/);
  age.words = '1 min ago';
  t.mock.timers.tick(5000);
  assert.equal(rowOf(p), row);
  assert.match(p.text(), /1× · last 1 min ago/);
});

test('the mark of a recent play goes after 10 s without a new row', (t) => {
  const p = setup(t);
  const now = t.mock.method(Date, 'now', () => 1000);
  fireCue(p, NUMBERS);
  const row = rowOf(p);
  assert.ok(row.marks.has('fired'));
  now.mock.mockImplementation(() => 11001);
  t.mock.timers.tick(5000);
  assert.equal(rowOf(p), row);
  assert.equal(row.marks.has('fired'), false);
});

test('right after a render the Saved line ends at the file\'s own time, and the time moves without a new row', async (t) => {
  const p = setup(t);
  p.click();
  p.say(renderAnswer);
  age.words = 'just now';
  await tick();
  assert.match(p.text(), /Saved dist\/audio\/blip\.wav · 0\.31 s · peak -12 dB · 27 KB · just now/);
  assert.ok(age.asked.includes(FILE.mtime), 'the file\'s time, not the time of the answer');
  const row = rowOf(p);
  age.words = '1 min ago';
  t.mock.timers.tick(5000);
  assert.equal(rowOf(p), row);
  assert.match(p.text(), /27 KB · 1 min ago/);
});

test('a list that says the same as the save leaves the row and its waveform alone', async (t) => {
  const p = setup(t);
  p.click();
  p.say({ ...renderAnswer, wav: silentWav() });
  await tick();
  const row = rowOf(p);
  panel.update();
  await tick();
  assert.equal(rowOf(p), row);
  assert.deepEqual(p.asked.bytes, []);
});

test('a canvas that lasts is painted once, and again when its colours change', async (t) => {
  screen.width = 10;
  const p = setup(t);
  p.click();
  p.say({ ...renderAnswer, wav: silentWav(0.29) });
  await tick();
  const [c] = canvases(p);
  const painted = c.rects.length;
  t.mock.timers.tick(5000);
  assert.equal(c.rects.length, painted, 'no repaint on a tick with nothing changed');
  const real = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => ` light${name} ` });
  try {
    t.mock.timers.tick(5000);
  } finally {
    globalThis.getComputedStyle = real;
  }
  assert.equal(c.rects.length, painted * 2, 'a new theme reaches it by the next tick');
  assert.equal(c.rects[painted].color, 'light--line');
});

// ---------- the focus after a render ----------
test('with no focus anywhere a saved render puts it on that row\'s Render button', async (t) => {
  const p = setup(t);
  p.click();
  p.say(renderAnswer);
  assert.deepEqual(focused, [], 'not before the file is saved');
  await tick();
  assert.deepEqual(focused, ['blip']);
});

test('a refused render returns the focus too, from the product and from the server', async (t) => {
  const p = setup(t, async () => { throw new Error('file is open'); });
  p.click();
  p.say({ id: 'blip', reason: 'unknown cue' });
  assert.deepEqual(focused, ['blip']);
  p.click();
  p.say(renderAnswer);
  await tick();
  assert.deepEqual(focused, ['blip', 'blip']);
});

test('a focus the person put somewhere else stays there', async (t) => {
  const p = setup(t);
  p.click();
  document.activeElement = { dataset: {} };
  p.say(renderAnswer);
  await tick();
  assert.deepEqual(focused, []);
});

// ---------- the readiness checklist ----------
for (const [kind, shown] of [['audio', true], ['game', false], ['web-app', false]]) {
  test(`kind ${kind} ${shown ? 'has' : 'does not repeat'} the checklist in the Audio panel`, (t) => {
    const p = setup(t, undefined, kind);
    assert.equal(p.text().includes('Readiness checklist'), shown);
    if (!shown) return;
    const c = checklists[checklists.length - 1];
    const before = c.renders;
    assert.ok(p.text().indexOf('Readiness checklist') > p.text().indexOf('Plays on'), 'below the cue rows');
    triggerCue(p);
    assert.equal(c.renders, before, 'a row redraw leaves the checkboxes alone');
    assert.ok(p.container.kids.flatMap((k) => k.kids).includes(c.node), 'and the same node stays in place');
    panel.update();
    assert.equal(c.renders, before + 1, 'a new bundle refreshes the ticks');
  });
}

// ---------- the waveform drawn to its own peak ----------
test('a quiet cue is drawn to its own peak and labelled so; the decoder stays unscaled', async (t) => {
  screen.width = 100;
  const p = setup(t);
  p.click();
  // A square wave at a quarter of full scale, about -12 dB.
  const wav = silentWav(0.29, (i) => (i % 2 ? -8192 : 8191));
  p.say({ id: 'blip', wav, seconds: 0.29, peak: 0.25, sampleRate: 44100 });
  await tick();
  const [c] = canvases(p);
  const lines = c.rects.slice(1);
  assert.equal(Math.min(...lines.map((r) => r.y)), 0, 'the loudest sample reaches the top');
  assert.equal(Math.max(...lines.map((r) => r.y + r.h)), 36, 'and the bottom');
  assert.match(p.text(), /0\.29 s · drawn to its peak, -12 dB/);
  const raw = peaksFromWav(Buffer.from(wav, 'base64'), 1)[0];
  assert.ok(Math.abs(raw.max - 0.25) < 0.001 && Math.abs(raw.min + 0.25) < 0.001, 'peaksFromWav still reads the true level');
});

test('a silent file keeps the centre line and says silent', async (t) => {
  screen.width = 10;
  const p = setup(t);
  p.click();
  p.say({ id: 'blip', wav: silentWav(0.29), seconds: 0.29, peak: 0, sampleRate: 44100 });
  await tick();
  const lines = canvases(p)[0].rects.slice(1);
  assert.ok(lines.every((r) => r.y === 18 && r.h === 1));
  assert.match(p.text(), /0\.29 s · silent/);
  assert.doesNotMatch(p.text(), /drawn to its peak/);
});
