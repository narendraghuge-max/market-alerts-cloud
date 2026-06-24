// Investment Navigator — PWA icon + manifest generator (zero dependencies).
// Renders a clean "IN" monogram on a navy→blue gradient, anti-aliased via
// supersampling, and writes PNGs + a web manifest into the target dir.
// Usage: node make_icon.mjs [outDir=.]
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] || '.';

// ---- CRC32 + PNG chunk encoder ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  // raw scanlines, filter byte 0 per row
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- geometry: distance from point P to segment AB (normalized coords) ----
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// "IN" monogram as stroked segments (normalized 0..1), bold rounded strokes.
const STROKE = 0.052;
const SEGS = [
  // I
  [0.345, 0.31, 0.345, 0.69],
  // N: left vertical, diagonal (top-left -> bottom-right), right vertical
  [0.485, 0.69, 0.485, 0.31],
  [0.485, 0.31, 0.665, 0.69],
  [0.665, 0.69, 0.665, 0.31],
];
function insGlyph(x, y) {
  for (const s of SEGS) if (distSeg(x, y, s[0], s[1], s[2], s[3]) <= STROKE) return true;
  return false;
}

// gradient colors (top navy -> bottom blue)
const C0 = [17, 34, 63], C1 = [37, 99, 235], WHITE = [255, 255, 255];

function render(size) {
  const SS = 3; // supersample factor for smooth edges
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) / size;
          const fy = (y + (sy + 0.5) / SS) / size;
          // background gradient
          const br = C0[0] + (C1[0] - C0[0]) * fy;
          const bg = C0[1] + (C1[1] - C0[1]) * fy;
          const bb = C0[2] + (C1[2] - C0[2]) * fy;
          if (insGlyph(fx, fy)) { r += WHITE[0]; g += WHITE[1]; b += WHITE[2]; }
          else { r += br; g += bg; b += bb; }
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      buf[i] = Math.round(r / n); buf[i + 1] = Math.round(g / n); buf[i + 2] = Math.round(b / n); buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

writeFileSync(join(outDir, 'apple-touch-icon.png'), render(180));
writeFileSync(join(outDir, 'icon-192.png'), render(192));
writeFileSync(join(outDir, 'icon-512.png'), render(512));
writeFileSync(join(outDir, 'manifest.webmanifest'), JSON.stringify({
  name: 'Investment Navigator',
  short_name: 'Navigator',
  description: 'Always watching your money — like a fund manager who never logs off.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0f1115',
  theme_color: '#0f1115',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
}, null, 2));

console.log('wrote icons + manifest to', outDir);
