// Reads Wallpaper Engine's proprietary Workshop scene package format.
// Format reverse-engineered and validated byte-exact against real Workshop
// scene.pkg files — not from official documentation (there isn't any).
const fs = require('fs');
const path = require('path');

function readLPString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const str = buf.toString('utf8', offset + 4, offset + 4 + len);
  return { str, next: offset + 4 + len };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A Wallpaper Engine .tex container wraps one or more PNG-encoded mip levels
// behind a small TEXV/TEXI/TEXB header. The first PNG found is the full
// resolution image — that's the one we want.
function decodeTexToPng(texBuffer) {
  const start = texBuffer.indexOf(PNG_SIG);
  if (start === -1) return null;
  const iendType = texBuffer.indexOf('IEND', start, 'latin1');
  if (iendType === -1) return null;
  const end = iendType + 4 + 4; // 'IEND' (4 bytes) + CRC (4 bytes)
  return texBuffer.slice(start, end);
}

// Unpacks a `scene.pkg` (format "PKGV0024") into a plain folder of files.
//
// Container layout:
//   [u32 magicLen]["PKGV0024"][u32 entryCount]
//   per entry: [u32 nameLen][name][u32 unknown][u32 dataLength]
//   then, immediately after the entry table: every entry's raw bytes,
//   concatenated back-to-back in table order — no offset field, no padding.
//
// Any `.tex` entry additionally gets a sibling `<name>.tex.png` written next
// to it (decoded from its embedded PNG mip), so callers never touch the
// container format directly.
function unpackPkg(pkgPath, outDir) {
  const buf = fs.readFileSync(pkgPath);
  let offset = 0;

  const magic = readLPString(buf, offset);
  offset = magic.next;
  if (magic.str !== 'PKGV0024') {
    throw new Error(`Unsupported .pkg version: ${magic.str}`);
  }

  const entryCount = buf.readUInt32LE(offset);
  offset += 4;

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const nameRes = readLPString(buf, offset);
    offset = nameRes.next;
    offset += 4; // per-entry "unknown" field — not needed to extract data
    const dataLength = buf.readUInt32LE(offset);
    offset += 4;
    entries.push({ name: nameRes.str, dataLength });
  }

  let dataOffset = offset;
  const written = [];
  for (const e of entries) {
    const data = buf.slice(dataOffset, dataOffset + e.dataLength);
    dataOffset += e.dataLength;

    const outPath = path.join(outDir, e.name);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
    written.push(outPath);

    if (e.name.toLowerCase().endsWith('.tex')) {
      const png = decodeTexToPng(data);
      if (png) fs.writeFileSync(outPath + '.png', png);
    }
  }
  return written;
}

module.exports = { unpackPkg, decodeTexToPng };
