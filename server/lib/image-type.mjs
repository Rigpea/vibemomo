// What an image is, read from its bytes and never from its name or a header someone sent: the type (png, jpg, gif,
// webp, svg) and, where the header holds it, the size in pixels. The inspiration board (server/lib/inspiration.mjs)
// keeps only files this names, under the extension this gives. Pure: no fs, no network.

export const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
export const IMAGE_WORDS = 'PNG, JPEG, WebP, GIF and SVG';

const starts = (buf, bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** The start of an SVG document as text, past a BOM, an XML declaration, comments and a doctype; null when the
 *  bytes are not UTF-8 text or do not open with an <svg> element. */
function svgHead(buf) {
  if (buf.includes(0)) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 64 * 1024))); } catch {
    // A cut inside a multi-byte character at 64 KB is not a fault of the file: read it loosely then.
    if (buf.length <= 64 * 1024) return null;
    text = new TextDecoder('utf-8').decode(buf.subarray(0, 64 * 1024));
  }
  let s = text.replace(/^﻿/, '');
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '').replace(/^<\?xml[\s\S]*?\?>/i, '').replace(/^<!--[\s\S]*?-->/, '').replace(/^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/i, '');
    if (s === before) break;
  }
  return /^<svg[\s>/]/i.test(s) ? s : null;
}

/** png, jpg, gif, webp or svg by content; null for anything else. */
export function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  if (starts(buf, ascii('GIF87a')) || starts(buf, ascii('GIF89a'))) return 'gif';
  if (starts(buf, ascii('RIFF')) && starts(buf, ascii('WEBP'), 8)) return 'webp';
  return svgHead(buf) ? 'svg' : null;
}

function jpgSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill bytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    const len = buf.readUInt16BE(i + 2);
    // A start-of-frame marker holds the size: C0 to CF without C4 (tables), C8 (reserved) and CC (arithmetic conditioning).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  return null;
}

function svgSize(buf) {
  const head = svgHead(buf);
  const tag = head?.match(/^<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const num = (name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9]*\\.?[0-9]+)(px)?\\s*["']`, 'i')); return m ? Number(m[1]) : null; };
  let width = num('width');
  let height = num('height');
  if (!width || !height) {
    const box = tag.match(/\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i);
    if (box) { width = Number(box[1]); height = Number(box[2]); }
  }
  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null;
}

/** { width, height } in pixels as the file's own header says, or null when it does not say (or says zero). */
export function imageSize(buf, type = imageType(buf)) {
  let size = null;
  try {
    if (type === 'png' && buf.length >= 24) size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    else if (type === 'gif' && buf.length >= 10) size = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    else if (type === 'jpg') size = jpgSize(buf);
    else if (type === 'webp') size = webpSize(buf);
    else if (type === 'svg') size = svgSize(buf);
  } catch { size = null; }
  return size && size.width > 0 && size.height > 0 && size.width <= 100000 && size.height <= 100000 ? size : null;
}
