// Generates assets/tray.png (64x64) and assets/icon.png (256x256)
// Run with: node scripts/gen-icon.js
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- PNG encoder ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 8; k--;) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type);
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(d.length);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crc]);
}
function makePNG(w, h, fn) {
  const stride = 1 + w * 4;
  const rows = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    rows[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = y * stride + 1 + x * 4;
      rows[o]   = Math.max(0, Math.min(255, r | 0));
      rows[o+1] = Math.max(0, Math.min(255, g | 0));
      rows[o+2] = Math.max(0, Math.min(255, b | 0));
      rows[o+3] = Math.max(0, Math.min(255, a | 0));
    }
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Icon design ---
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
function triSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = triSign(px, py, ax, ay, bx, by);
  const d2 = triSign(px, py, bx, by, cx, cy);
  const d3 = triSign(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function drawPixel(x, y, size) {
  const cx = size / 2, cy = size / 2;
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const R = size * 0.46;
  const ringW = size * 0.055;

  if (dist > R + 1) return [0, 0, 0, 0];

  // Anti-aliased circle edge
  const circAlpha = dist > R ? Math.round((R + 1 - dist) * 255) : 255;

  // Outer ring (border)
  if (dist > R - ringW) {
    const t = (dist - (R - ringW)) / ringW;
    const rr = Math.round(lerp(50, 35, t));
    const gg = Math.round(lerp(55, 40, t));
    const bb = Math.round(lerp(80, 60, t));
    return [rr, gg, bb, circAlpha];
  }

  // Background gradient (dark blue/purple)
  const ny = (y - (cy - R)) / (2 * R);
  const bgR = Math.round(lerp(18, 28, ny));
  const bgG = Math.round(lerp(16, 22, ny));
  const bgB = Math.round(lerp(40, 55, ny));

  // Subtle background wave shimmer
  const shimmer = Math.sin(dx / size * Math.PI * 6 + dy / size * 4) * 6;

  // Play triangle (centered, pointing right)
  const tw = size * 0.28;
  const th = size * 0.38;
  const tx1 = cx - tw * 0.45, ty1 = cy - th / 2;  // top-left
  const tx2 = cx - tw * 0.45, ty2 = cy + th / 2;  // bottom-left
  const tx3 = cx + tw * 0.55, ty3 = cy;            // right

  if (inTri(x, y, tx1, ty1, tx2, ty2, tx3, ty3)) {
    const pt = (y - ty1) / (ty2 - ty1);
    return [
      Math.round(lerp(120, 79, pt)),
      Math.round(lerp(228, 195, pt)),
      Math.round(lerp(255, 247, pt)),
      circAlpha,
    ];
  }

  return [bgR + shimmer, bgG + shimmer * 0.5, bgB, circAlpha];
}

// --- ICO encoder (embeds PNG images directly — Vista+ compatible) ---
function makeICO(sizes) {
  // sizes = array of pixel sizes to render; each stored as PNG inside ICO
  const images = sizes.map(s => ({ s, buf: makePNG(s, s, (x, y) => drawPixel(x, y, s)) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let dataOffset = 6 + 16 * images.length;
  const dirs = images.map(({ s, buf }) => {
    const dir = Buffer.alloc(16);
    dir[0] = s >= 256 ? 0 : s;  // width  (0 means 256)
    dir[1] = s >= 256 ? 0 : s;  // height
    dir[2] = 0;                  // color count (0 = true color)
    dir[3] = 0;                  // reserved
    dir.writeUInt16LE(1, 4);     // planes
    dir.writeUInt16LE(32, 6);    // bits per pixel
    dir.writeUInt32LE(buf.length, 8);
    dir.writeUInt32LE(dataOffset, 12);
    dataOffset += buf.length;
    return dir;
  });

  return Buffer.concat([header, ...dirs, ...images.map(i => i.buf)]);
}

// --- Write files ---
const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

const tray = makePNG(64, 64, (x, y) => drawPixel(x, y, 64));
fs.writeFileSync(path.join(assetsDir, 'tray.png'), tray);
console.log('Generated assets/tray.png  (64x64 RGBA)');

const icon = makePNG(256, 256, (x, y) => drawPixel(x, y, 256));
fs.writeFileSync(path.join(assetsDir, 'icon.png'), icon);
console.log('Generated assets/icon.png  (256x256 RGBA)');

const ico = makeICO([16, 32, 48, 256]);
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);
console.log('Generated assets/icon.ico  (16/32/48/256 multi-size)');
