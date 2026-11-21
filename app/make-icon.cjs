// Writes the app icons without any dependency: app/icon.png (256x256, the window, taskbar and
// packaged-exe icon), app/tray.png (32x32, the tray) and app/icon.ico (16 to 256 px, the Desktop
// shortcut). An anti-aliased "V" for vibeMomo, the same two strokes as the favicon and the header mark,
// in the studio's ink (--ink) on its canvas (--bg), inside a rounded square with transparent corners.
// Run once (`node app/make-icon.cjs`); the files are committed, so the app never needs this at
// runtime. Shapes are signed-distance tests sampled 4x4 per pixel, so any size renders cleanly.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const BG = [0x23, 0x22, 0x21]; // --bg #232221, the canvas (a locked token)
const FG = [0xec, 0xe8, 0xe1]; // --ink #ece8e1 (a locked token)
const SUB = 4; // subsamples per axis

// Geometry in a 0..1 square: a rounded square, and a "V" of two thick strokes meeting at the foot.
const SHAPE = {
  corner: 0.22,
  strokes: [
    { a: [0.285, 0.235], b: [0.5, 0.765], w: 0.105 }, // left arm
    { a: [0.715, 0.235], b: [0.5, 0.765], w: 0.105 }, // right arm
  ],
};

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return Math.hypot(dx, dy);
}

function roundedSquareDistance(px, py, r) {
  const qx = Math.abs(px - 0.5) - (0.5 - r), qy = Math.abs(py - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Coverage (0..1) of the background square and of the glyph at pixel (x, y) of a size*size image. */
function coverage(x, y, size) {
  let bg = 0, fg = 0;
  for (let sy = 0; sy < SUB; sy++) {
    for (let sx = 0; sx < SUB; sx++) {
      const px = (x + (sx + 0.5) / SUB) / size, py = (y + (sy + 0.5) / SUB) / size;
      if (roundedSquareDistance(px, py, SHAPE.corner) > 0) continue;
      bg++;
      if (SHAPE.strokes.some((s) => segmentDistance(px, py, s.a, s.b) <= s.w / 2)) fg++;
    }
  }
  return [bg / (SUB * SUB), fg / (SUB * SUB)];
}

function pixel(x, y, size) {
  const [bg, fg] = coverage(x, y, size);
  if (bg === 0) return [0, 0, 0, 0];
  const mix = fg / bg; // share of the covered area that is glyph
  const c = BG.map((b, i) => Math.round(b + (FG[i] - b) * mix));
  return [c[0], c[1], c[2], Math.round(255 * bg)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) Buffer.from(pixel(x, y, size)).copy(raw, row + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A Windows .ico holding one PNG per size (Vista and later read PNG entries). */
function ico(sizes) {
  const images = sizes.map((size) => png(size));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; // 0 means 256
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

if (require.main === module) {
  for (const [name, size] of [["icon.png", 256], ["tray.png", 32]]) {
    const out = path.join(__dirname, name);
    fs.writeFileSync(out, png(size));
    console.log(`wrote ${out} (${size}x${size})`);
  }
  const out = path.join(__dirname, "icon.ico");
  fs.writeFileSync(out, ico(ICO_SIZES));
  console.log(`wrote ${out} (${ICO_SIZES.join(", ")})`);
}
module.exports = { png, ico, ICO_SIZES };
