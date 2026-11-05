// Generates the Tabkeeper icons as PNGs without dependencies. Run: npm run icons
//
// Mark: two overlapping browser tabs resting on a tab-strip baseline, white on a
// blue rounded tile. The front tab is solid, the back tab is translucent.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x1a, 0x5f, 0xd6]; // tile blue
const FG = [255, 255, 255];

// ---- PNG encoding ----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
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
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- geometry (all in unit coordinates 0..1) ----
function roundedRect(x, y, w, h, r) {
  return (px, py) => {
    if (px < x || px > x + w || py < y || py > y + h) return false;
    const cx = Math.min(Math.max(px, x + r), x + w - r);
    const cy = Math.min(Math.max(py, y + r), y + h - r);
    return Math.hypot(px - cx, py - cy) <= r;
  };
}
/** Browser tab: rounded top corners, square bottom (sits on the baseline). */
function tab(x, y, w, h, r) {
  const top = roundedRect(x, y, w, h + r, r);
  return (px, py) => py <= y + h && top(px, py);
}

function render(size) {
  // Small sizes get bolder strokes so the mark survives at 16 px.
  const small = size <= 32;
  const tile = roundedRect(0, 0, 1, 1, 0.22);
  const baselineY = small ? 0.70 : 0.68;
  const baselineH = small ? 0.12 : 0.085;
  const baseline = roundedRect(0.16, baselineY, 0.68, baselineH, baselineH / 2);
  const tabH = small ? 0.30 : 0.30;
  const back = tab(0.46, baselineY - tabH + (small ? 0.06 : 0.05), 0.33, tabH - (small ? 0.06 : 0.05), small ? 0.07 : 0.06);
  const front = tab(0.21, baselineY - tabH, 0.36, tabH, small ? 0.08 : 0.07);
  const SS = 5; // supersampling grid
  return (px, py) => {
    let tileCov = 0;
    let frontCov = 0;
    let backCov = 0;
    let baseCov = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / size;
        const y = (py + (sy + 0.5) / SS) / size;
        if (!tile(x, y)) continue;
        tileCov++;
        if (baseline(x, y)) baseCov++;
        else if (front(x, y)) frontCov++;
        else if (back(x, y)) backCov++;
      }
    }
    const n = SS * SS;
    const alpha = tileCov / n;
    if (alpha === 0) return [0, 0, 0, 0];
    // Composite: back tab at 55% white, front tab and baseline at 100% white, over blue.
    const white = (frontCov + baseCov) / tileCov + (backCov / tileCov) * 0.55;
    const mix = (c, w) => Math.round(c + (w - c) * white);
    return [mix(BG[0], FG[0]), mix(BG[1], FG[1]), mix(BG[2], FG[2]), Math.round(alpha * 255)];
  };
}

for (const size of [16, 32, 48, 128, 256, 512]) {
  writeFileSync(join(outDir, `icon${size}.png`), png(size, render(size)));
}
console.log('icons written to', outDir);
