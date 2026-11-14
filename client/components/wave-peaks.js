// Reads a complete WAV file's bytes: 16-bit PCM, mono or stereo (of stereo, the first channel). Pure, no DOM.
// Anything else throws an Error whose message says what is wrong with the file.
const text = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function parse(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('not the bytes of a file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || text(view, 0) !== 'RIFF' || text(view, 8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt = null;
  let data = null;
  // A chunk of odd size is followed by one pad byte.
  for (let at = 12; at + 8 <= bytes.length && !(fmt && data); at += 8 + size(view, at) + (size(view, at) & 1)) {
    const id = text(view, at);
    const body = at + 8;
    if (id === 'fmt ' && !fmt) {
      if (size(view, at) < 16 || body + 16 > bytes.length) throw new Error('the fmt chunk is too short');
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data' && !data) {
      if (body + size(view, at) > bytes.length) throw new Error('the data chunk runs past the end of the file');
      data = { start: body, length: size(view, at) };
    }
  }
  if (!fmt) throw new Error('no fmt chunk');
  if (!data) throw new Error('no data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('not 16-bit PCM');
  if (fmt.channels !== 1 && fmt.channels !== 2) throw new Error(`${fmt.channels} channels; only mono or stereo`);
  if (fmt.sampleRate === 0) throw new Error('a sample rate of 0');
  return { view, start: data.start, step: fmt.channels * 2, frames: Math.floor(data.length / (fmt.channels * 2)), channels: fmt.channels, sampleRate: fmt.sampleRate };
}

const size = (view, at) => view.getUint32(at + 4, true);

/** What the file itself says: {sampleRate, channels, frames, seconds}. */
export function wavInfo(bytes) {
  const { sampleRate, channels, frames } = parse(bytes);
  return { sampleRate, channels, frames, seconds: frames / sampleRate };
}

/** [{min, max}] per column, in -1..1: the lowest and highest sample of that column's slice of the file. */
export function peaksFromWav(bytes, columns) {
  if (!Number.isInteger(columns) || columns < 1) throw new Error('columns must be a whole number of at least 1');
  const { view, start, step, frames } = parse(bytes);
  const peaks = [];
  for (let c = 0; c < columns; c++) {
    if (!frames) { peaks.push({ min: 0, max: 0 }); continue; }
    const from = Math.floor(c * frames / columns);
    // More columns than frames: a column still shows the frame it falls on.
    const to = Math.max(from + 1, Math.floor((c + 1) * frames / columns));
    let low = Infinity;
    let high = -Infinity;
    for (let f = from; f < to; f++) {
      const s = view.getInt16(start + f * step, true);
      if (s < low) low = s;
      if (s > high) high = s;
    }
    peaks.push({ min: unit(low), max: unit(high) });
  }
  return peaks;
}

/** The largest absolute sample of the whole file, every channel, in 0..1. */
export function wavPeak(bytes) {
  const { view, start, frames, channels } = parse(bytes);
  let peak = 0;
  for (let i = 0; i < frames * channels; i++) {
    const level = Math.abs(unit(view.getInt16(start + i * 2, true)));
    if (level > peak) peak = level;
  }
  return peak;
}

// 16-bit full scale is -32768..32767; both ends read as exactly -1 and 1.
const unit = (s) => (s < 0 ? s / 32768 : s / 32767);
