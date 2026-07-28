#!/usr/bin/env node
/**
 * Generate raster favicons from the DROP logo mark.
 *
 * WHY THIS EXISTS: `src/dashboard/public/drop.svg` is the only logo asset the
 * platform served, and plenty of icon consumers do not render SVG — they ask
 * the origin for `/favicon.ico` and give up when it 404s. That covers browser
 * tabs on older engines, link unfurlers, and connector/integration listings.
 *
 * WHY IT REIMPLEMENTS THE SHAPE: rasterizing real SVG needs a rendering engine
 * (sharp/resvg/canvas), which is a heavyweight native dependency for four small
 * square images. The mark is one analytic path, so it is cheaper and more
 * portable to evaluate it directly. **drop.svg remains the source of truth** —
 * if the mark changes there, change GEOMETRY below and re-run this script.
 * Nothing regenerates these automatically; they are committed build outputs.
 *
 *   node scripts/generate-favicons.js
 *
 * No dependencies: PNG is encoded with the built-in zlib, and the .ico wraps
 * PNG payloads (the Vista+ ICO form every current consumer accepts).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * The mark, transcribed from drop.svg's single path.
 *
 * A 68x68 square inset at 16..84, rotated 45°, with three corners rounded to
 * r=34 (half the side, so they collapse into one circle centred at 50,50) and
 * the fourth at r=2 — the near-sharp corner that makes it read as a droplet
 * rather than a blob. Rotation sends that corner to roughly (2, 50): the point
 * aims left.
 */
const GEOMETRY = {
  box: { x0: 16, y0: 16, x1: 84, y1: 84 },
  round: 34,
  sharp: 2,
  rotationDeg: 45,
  viewBox: 100,
};

/** Light-scheme accent from drop.svg. A raster icon cannot follow the OS theme. */
const FILL = { r: 0x0a, g: 0x84, b: 0xe0 };

/** Whether a point (in unrotated square space) is inside the rounded square. */
function insideRoundedSquare(x, y) {
  const { box, round, sharp } = GEOMETRY;
  if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) return false;

  // The three r=34 corners share a centre, so one circle test covers all of
  // them: any point in a rounded quadrant must lie within it.
  const cx = box.x0 + round;
  const cy = box.y0 + round;
  const inRoundedQuadrant =
    (x <= cx && y <= cy) || (x >= cx && y <= cy) || (x >= cx && y >= cy);
  if (inRoundedQuadrant) {
    return (x - cx) ** 2 + (y - cy) ** 2 <= round * round;
  }

  // Bottom-left: filled except for the small r=2 rounding at the very tip.
  const sx = box.x0 + sharp;
  const sy = box.y1 - sharp;
  if (x <= sx && y >= sy) {
    return (x - sx) ** 2 + (y - sy) ** 2 <= sharp * sharp;
  }
  return true;
}

/** Whether a viewBox-space point is inside the mark (rotation undone first). */
function insideMark(x, y) {
  const c = GEOMETRY.viewBox / 2;
  const theta = (-GEOMETRY.rotationDeg * Math.PI) / 180;
  const dx = x - c;
  const dy = y - c;
  return insideRoundedSquare(
    c + dx * Math.cos(theta) - dy * Math.sin(theta),
    c + dx * Math.sin(theta) + dy * Math.cos(theta)
  );
}

/**
 * Render the mark to straight-alpha RGBA at `size`.
 *
 * 4x4 supersampling: these are rendered at 16px, where a hard edge test leaves
 * visible stair-stepping on the diagonal the whole mark is built from.
 */
function renderRgba(size) {
  const SAMPLES = 4;
  const pixels = Buffer.alloc(size * size * 4);
  const scale = GEOMETRY.viewBox / size;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          if (insideMark(x, y)) hits += 1;
        }
      }
      const offset = (py * size + px) * 4;
      pixels[offset] = FILL.r;
      pixels[offset + 1] = FILL.g;
      pixels[offset + 2] = FILL.b;
      pixels[offset + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Encode straight-alpha RGBA as a PNG (colour type 6, filter 0 per scanline). */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12: deflate compression, adaptive filtering, no interlace — all 0.

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Wrap PNG payloads in an ICO container (PNG-in-ICO, universally read today). */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 256 is encoded as 0 — the field is one byte.
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 4] = 1; // colour planes
    directory[at + 6] = 32; // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map(e => e.png)]);
}

const OUT_DIR = path.join(__dirname, '..', 'src', 'dashboard', 'public');

const icoSizes = [16, 32, 48];
const ico = encodeIco(
  icoSizes.map(size => ({ size, png: encodePng(size, renderRgba(size)) }))
);
fs.writeFileSync(path.join(OUT_DIR, 'favicon.ico'), ico);
console.log(`favicon.ico        ${ico.length} bytes (${icoSizes.join(', ')}px)`);

for (const [name, size] of [
  ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
]) {
  const png = encodePng(size, renderRgba(size));
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`${name.padEnd(19)}${png.length} bytes (${size}px)`);
}
