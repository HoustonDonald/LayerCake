/**
 * Draws desktop/layercake.ico, the icon desktop/build.mjs puts on
 * dist\LayerCake.exe: three cake layers, each a little narrower than the one
 * below, in three colours.
 *
 *   node scripts/make-icon.mjs
 *
 * The .ico is committed, so this runs only when the drawing changes. It needs
 * no dependency: a PNG is a zlib stream with CRCs, both in node:zlib, and an
 * .ico is a 6-byte header plus one 16-byte entry per image.
 *
 * Every size is stored as PNG. Windows has read PNG entries at any size since
 * Vista, and the Node that builds the exe needs Windows 10 anyway, so the BMP
 * entries older tools expect for small sizes would buy nothing here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outPath = path.join(root, 'desktop', 'layercake.ico');

const SIZES = [16, 32, 48, 256];

// The drawing, on a 16-unit grid so that at 16 px every edge lands on a pixel
// boundary and the smallest size stays crisp. Top to bottom: icing, sponge,
// chocolate, each 4 units tall with a 1-unit gap between them.
const LAYERS = [
  { x0: 3, x1: 13, y0: 1, y1: 5, rgb: [0xe8, 0x4a, 0x7f] },
  { x0: 2, x1: 14, y0: 6, y1: 10, rgb: [0xe9, 0xa2, 0x3b] },
  { x0: 1, x1: 15, y0: 11, y1: 15, rgb: [0x7b, 0x4a, 0x2d] },
];
const RADIUS = 0.75;
// The top slice of each layer is lightened, so the layers read as stacked
// slabs rather than flat bars at the larger sizes.
const HIGHLIGHT = 0.2;

function inRoundedRect(x, y, { x0, x1, y0, y1 }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + RADIUS), x1 - RADIUS);
  const cy = Math.min(Math.max(y, y0 + RADIUS), y1 - RADIUS);
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
}

/** RGBA pixels for one size, antialiased by averaging SS x SS samples per pixel. */
function render(size) {
  const SS = 8;
  const unit = 16 / size;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let hits = 0;
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxX + (sx + 0.5) / SS) * unit;
          const y = (py + (sy + 0.5) / SS) * unit;
          const layer = LAYERS.find((l) => inRoundedRect(x, y, l));
          if (!layer) continue;
          const lift = y - layer.y0 < (layer.y1 - layer.y0) * 0.25 ? HIGHLIGHT : 0;
          for (let c = 0; c < 3; c++) sum[c] += layer.rgb[c] + (255 - layer.rgb[c]) * lift;
          hits++;
        }
      }
      if (!hits) continue;
      const at = (py * size + pxX) * 4;
      for (let c = 0; c < 3; c++) px[at + c] = Math.round(sum[c] / hits);
      px[at + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGBA PNG, every scanline with filter type 0 (none). */
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type 1: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
fs.writeFileSync(outPath, ico(images));
process.stdout.write(`${outPath}: ${images.map((i) => `${i.size}px ${i.data.length} bytes`).join(', ')}\n`);
