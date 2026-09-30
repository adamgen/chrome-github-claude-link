// Renders icons/icon{16,32,48,128}.png (orange rounded square + white spark)
// with no dependencies: point-in-polygon with 4x4 supersampling, then a
// minimal PNG encoder.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

// Same spark as the in-page icon (16×16 viewBox).
const SPARK = [
  [8, 0], [9.6, 5.1], [15, 3.6], [11.1, 7.6], [15, 12.4], [9.6, 10.9],
  [8, 16], [6.4, 10.9], [1, 12.4], [4.9, 7.6], [1, 3.6], [6.4, 5.1],
];
const BG = [217, 119, 87];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4, pad = 0.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
          if (!inRoundedSquare(u, v, 0.22)) continue;
          bg++;
          const gx = ((u - pad) / (1 - 2 * pad)) * 16, gy = ((v - pad) / (1 - 2 * pad)) * 16;
          if (inPolygon(gx, gy, SPARK)) fg++;
        }
      }
      const n = S * S, a = bg / n, f = bg ? fg / bg : 0, o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - f) + 255 * f);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), render(size));
}
console.log("icons written");
