// Reads Wallpaper Engine's proprietary Workshop scene package format.
// Format reverse-engineered and validated byte-exact against real Workshop
// scene.pkg files — not from official documentation (there isn't any).
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

function readLPString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const str = buf.toString('utf8', offset + 4, offset + 4 + len);
  return { str, next: offset + 4 + len };
}

const PNG_SIG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);

function looksLikeImageStart(buf, offset) {
  return buf.slice(offset, offset + 8).equals(PNG_SIG) || buf.slice(offset, offset + 3).equals(JPEG_SOI);
}

// ---- CRC32 + minimal PNG encoder (no image-library dependency) ----
// Only ever needs to wrap a full RGBA8888 buffer we already decompressed
// ourselves — one IDAT chunk, filter type 0 (None) per scanline.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
// Expande pixels de 1 canal (cinza, ex: máscaras/sprites de partícula) ou 3
// canais (RGB) pra RGBA8888, pra reusar o mesmo caminho de encodeRgbaToPng
// em qualquer caso.
//
// Canal único = intensidade/alfa, não uma cor cinza opaca — usado tanto por
// máscaras de efeito (lidas via `.r` no shader do foliagesway, que nunca
// olha o alfa) quanto por sprites de partícula em escala de cinza (ex:
// "particle/fog/fog1", uma névoa branca cujo único canal É a forma/opacidade
// da fumaça). Bug real encontrado 2026-07-17: alfa saía sempre 255 (opaco)
// aqui, então o "source-atop" de _getTintedSprite (we-scene-render.js)
// pintava um RETÂNGULO SÓLIDO da cor do tint (preenche onde o alfa já é
// opaco) em vez de respeitar a forma da névoa/glow — visível como uma caixa
// branca lavada por cima da cena sempre que uma partícula usava textura de
// 1 canal. Setar alpha=g corrige isso sem afetar o foliagesway (que nunca
// lê o canal alfa, só `.r`, que continua igual a g como antes).
function expandToRgba(raw, bytesPerPixel, pixelCount) {
  const out = Buffer.alloc(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    if (bytesPerPixel === 1) {
      const g = raw[i];
      out[i * 4] = g; out[i * 4 + 1] = g; out[i * 4 + 2] = g; out[i * 4 + 3] = g;
    } else { // 3 (RGB888)
      out[i * 4] = raw[i * 3]; out[i * 4 + 1] = raw[i * 3 + 1]; out[i * 4 + 2] = raw[i * 3 + 2]; out[i * 4 + 3] = 255;
    }
  }
  return out;
}

function encodeRgbaToPng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Pure-JS LZ4 block-format decompressor ----
// Not the framed format (no magic header) — WE stores raw LZ4 blocks and
// already tells us the exact uncompressed size via the .tex header, which is
// exactly what block-format decompression needs. Validated byte-exact
// against a real texture's output (both the reference `lz4` Python binding
// and this implementation produce identical bytes).
function lz4BlockDecompress(input, inOffset, inLength, uncompressedSize) {
  const out = Buffer.alloc(uncompressedSize);
  let ip = inOffset;
  const iend = inOffset + inLength;
  let op = 0;
  while (ip < iend) {
    const token = input[ip++];
    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let b;
      do { b = input[ip++]; literalLength += b; } while (b === 255);
    }
    if (literalLength > 0) {
      input.copy(out, op, ip, ip + literalLength);
      ip += literalLength;
      op += literalLength;
    }
    if (ip >= iend) break; // final literal run, no match follows
    const matchOffset = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    let matchLength = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b;
      do { b = input[ip++]; matchLength += b; } while (b === 255);
    }
    let matchPos = op - matchOffset;
    for (let i = 0; i < matchLength; i++) out[op++] = out[matchPos++];
  }
  return out;
}

// A Wallpaper Engine .tex container wraps one or more image-encoded mip
// levels behind a small TEXV/TEXI/TEXB header. Byte-exact reverse-engineered
// against real "TEXB0004" blocks — confirmed against resourcecompiler64.exe's
// own format-name strings (TEXB0004/TEXI0001/TEXV0005, "LZ4 error.", plus a
// DXT/BC format table) and validated against real texture files:
//   "TEXBxxxx\0" (9 bytes) then either 8 or 9x u32 LE depending on the
//   version suffix — confirmed against three real versions:
//     TEXB0004 (9 fields): [0]=?, [1]=format, [2]=?, [3]=mip count,
//       [4]=width, [5]=height, [6]=flag, [7]=uncompressed size, [8]=data length
//     TEXB0003 (8 fields, no mip-count field): [0]=?, [1]=format, [2]=?,
//       [3]=width, [4]=height, [5]=flag, [6]=uncompressed size, [7]=data length
//     TEXB0002 (7 fields, width/height one slot earlier than 0003): [0]=?,
//       [1]=format, [2]=width, [3]=height, [4]=?, [5]=uncompressed size,
//       [6]=data length — always found wrapped inside a "TEXV0005" container
//       in every real sample seen (see below), never standalone so far.
//   Format 2 == plain embedded JPEG. Formats seen otherwise (0xFFFFFFFF, 6,
//   8, 9...) == raw RGBA/grayscale, LZ4-block-compressed — uncompressed size
//   == width*height*bytesPerPixel regardless of the exact numeric format id,
//   so bytesPerPixel is what actually gates the raw-decode path, not a
//   hardcoded format-id allowlist. Data starts right after the fields either
//   way.
// Large (4K) backgrounds and small particle sprites alike commonly use the
// LZ4+raw-RGBA variant, not a plain PNG/JPEG — that was the actual bug behind
// fully-black and half-broken scenes: the old code only ever looked for a
// PNG signature. Falls back to a blind PNG-signature scan (the original
// method) if neither structural read checks out.
//
// "TEXV0005" wrapper (confirmed 2026-07-17 against 4 real stock WE particle
// textures: particle/drop, particle/fire/fire1, particle/debris/debris1,
// particle/lightning/lightning1): "TEXV0005" + null + "TEXI0001" + null + 7x
// u32 (purpose beyond rough format/width/height not confirmed — decoding
// only ever needs the nested TEXB, not these) + a nested "TEXBxxxx" (version
// 0002 in every sample) holding the actual pixel data, same as a standalone
// .tex. `indexOf('TEXB', ...)` below already finds this nested block
// correctly regardless of the TEXV wrapper — the only thing missing was the
// TEXB0002 field layout itself, which is why these previously decoded as
// garbage (nonsensical width/height from misreading TEXB0004's layout)
// instead of throwing or falling back. Not every TEXV is multi-frame —
// particle/drop is a single static sprite despite the wrapper; some others
// (fire1, lightning1) turned out to be full spritesheet grids baked into
// one image, same deal as a bare-TEXB grid like particle/fog/fog1 — decoded
// whole either way, per-frame UV slicing is a separate unimplemented
// feature (see [[project_we_particles_hierarchy]]/roadmap item 8).
function decodeTexToPng(texBuffer) {
  const texbIdx = texBuffer.indexOf('TEXB', 0, 'latin1');
  if (texbIdx !== -1) {
    const version = texBuffer.toString('latin1', texbIdx + 4, texbIdx + 8);
    const fieldsStart = texbIdx + 9; // "TEXBxxxx\0"
    const layouts = version === '0003'
      ? { formatOff: 4, widthOff: 12, heightOff: 16, uncompOff: 24, lenOff: 28, headerSize: 32 }
      : version === '0002'
      ? { formatOff: 4, widthOff: 8, heightOff: 12, uncompOff: 20, lenOff: 24, headerSize: 28 }
      : { formatOff: 4, widthOff: 16, heightOff: 20, uncompOff: 28, lenOff: 32, headerSize: 36 }; // TEXB0004 and unknown versions

    if (fieldsStart + layouts.headerSize <= texBuffer.length) {
      const format           = texBuffer.readUInt32LE(fieldsStart + layouts.formatOff);
      const width             = texBuffer.readUInt32LE(fieldsStart + layouts.widthOff);
      const height             = texBuffer.readUInt32LE(fieldsStart + layouts.heightOff);
      const uncompressedSize = texBuffer.readUInt32LE(fieldsStart + layouts.uncompOff);
      const dataLength         = texBuffer.readUInt32LE(fieldsStart + layouts.lenOff);
      const dataStart           = fieldsStart + layouts.headerSize;

      if (format === 2 && dataLength > 0 && dataStart + dataLength <= texBuffer.length && looksLikeImageStart(texBuffer, dataStart)) {
        return texBuffer.slice(dataStart, dataStart + dataLength);
      }

      // Formato "cru + LZ4" também é usado por texturas de 1 canal (máscaras
      // de opacidade em escala de cinza, ex: effects/foliagesway's g_Texture1)
      // e de 3 canais (RGB sem alfa) — não só RGBA8888. bytesPerPixel vem do
      // próprio header (uncompressedSize / pixelCount), confirmado byte-exato
      // contra uma máscara real de 1920x1080 com uncompressedSize=2073600
      // (= width*height*1).
      const pixelCount = width * height;
      const bytesPerPixel = pixelCount > 0 ? uncompressedSize / pixelCount : 0;
      if (dataLength > 0 && dataStart + dataLength <= texBuffer.length && width > 0 && height > 0
          && Number.isInteger(bytesPerPixel) && (bytesPerPixel === 1 || bytesPerPixel === 3 || bytesPerPixel === 4)) {
        try {
          const raw = lz4BlockDecompress(texBuffer, dataStart, dataLength, uncompressedSize);
          const rgba = bytesPerPixel === 4 ? raw : expandToRgba(raw, bytesPerPixel, pixelCount);
          return encodeRgbaToPng(rgba, width, height);
        } catch (_) { /* falls through to the blind scan below */ }
      }
    }
  }

  // Fallback: blind scan for an embedded PNG mip.
  const start = texBuffer.indexOf(PNG_SIG);
  if (start === -1) return null;
  const iendType = texBuffer.indexOf('IEND', start, 'latin1');
  if (iendType === -1) return null;
  const end = iendType + 4 + 4; // 'IEND' (4 bytes) + CRC (4 bytes)
  return texBuffer.slice(start, end);
}

// Unpacks a `scene.pkg` into a plain folder of files. Originally
// reverse-engineered against "PKGV0024"; "PKGV0018" (an older Workshop
// upload) was later confirmed byte-exact against the identical container
// layout below — Wallpaper Engine appears to have kept this format stable
// across at least these two version numbers, only the header string differs.
// Validated the same way both times: total extracted data length must equal
// every remaining byte in the file exactly, and scene.json must parse as JSON.
//
// Container layout:
//   [u32 magicLen]["PKGV00xx"][u32 entryCount]
//   per entry: [u32 nameLen][name][u32 unknown][u32 dataLength]
//   then, immediately after the entry table: every entry's raw bytes,
//   concatenated back-to-back in table order — no offset field, no padding.
//
// "PKGV0023" confirmed byte-exact the same way 2026-07-18 (real download,
// workshop id 3280146735, "Music Visualizer | iOS Style"): total entry
// dataLength sums to exactly the remaining file length, and scene.json
// decodes as valid JSON with the expected top-level keys. Bonus find: the
// per-entry "unknown" u32 turns out to be a running cumulative offset into
// the concatenated data blob (each entry's value == previous entry's
// unknown + previous entry's dataLength) — not needed for extraction since
// we just walk sequentially, but it's a nice internal-consistency check that
// the layout reading is aligned correctly.
//
// "PKGV0013" ALSO confirmed byte-exact the same way, same day (real
// download, workshop id 2149068390, "Music Cat") — a much older upload,
// yet identical layout. Four different version numbers (13, 18, 23, 24)
// all sharing the exact same binary container now, zero exceptions —
// clearly one stable format across the version string, not something to
// keep allowlisting one number at a time forever. Switched from a
// hardcoded Set of known-good version strings to a structural check: any
// magic matching /^PKGV\d+$/ is attempted, and the real validation is that
// the entry table's summed dataLength lands exactly on the end of the file
// (the same invariant manually checked by hand for every version confirmed
// above). A genuinely incompatible future format reusing the "PKGV" prefix
// would fail that check and still throw here — this only removes the need
// to add version numbers by hand.
//
// Any `.tex` entry additionally gets a sibling `<name>.tex.png` written next
// to it (decoded from its embedded PNG mip), so callers never touch the
// container format directly.
function unpackPkg(pkgPath, outDir) {
  const buf = fs.readFileSync(pkgPath);
  let offset = 0;

  const magic = readLPString(buf, offset);
  offset = magic.next;
  if (!/^PKGV\d+$/.test(magic.str)) {
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

  const totalDataLength = entries.reduce((sum, e) => sum + e.dataLength, 0);
  if (offset + totalDataLength !== buf.length) {
    throw new Error(`Unsupported .pkg layout (magic "${magic.str}" doesn't match the known container structure)`);
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

// Puppet ("*_puppet.mdl") — Wallpaper Engine's 2D rigged mesh format,
// referenced by a model.json's "puppet" field alongside its usual
// "material". Shares the "MDLV" magic family with the rigid 3D .mdl format
// (confirmed MDLV0017 there vs MDLV0016 here) but this is a separate,
// simpler layout. Only the static bind-pose mesh is decoded — a second
// "MDLSxxxx"-tagged trailer (skeleton/physics) follows the index block and
// is NOT decoded yet, so this draws the puppet at rest with no articulation.
//
// Layout, validated byte-exact against 4 real MDLV0016 files (2998757800's
// 眉毛/眼睛/睫毛/lituoliao_5_rw_puppet.mdl — 70/480/597/4077 vertices): for
// every one, the max index value in the index block equals vertexCount-1
// exactly (no out-of-bounds reference), and the smallest one's vertex x/y
// range sits inside its material texture's own decoded pixel dimensions
// (眉毛's verts span x∈[160,308] y∈[802,860], its material texture decodes
// to exactly 1415×2047 — matching the owning scene object's own "size"
// field exactly). So vertex.xy is already in texture-pixel space, same as
// the flat-quad image case.
//
// NOTE: the embedded UV field (see below) does NOT agree with that same
// x/y-as-texture-pixel reading (e.g. y=802/2047=39% down vs v=9.8%) — it
// most likely addresses a separate shared rig atlas this decoder doesn't
// have access to, not the per-part material texture. Left decoded for
// completeness, but callers should derive their own UV from x/y against the
// material texture's own dimensions instead of trusting this field.
//
//   "MDLVxxxx" (8 bytes) + null-terminated UTF-8 material path string
//   (starting at a fixed offset 21 — the 13 bytes in between were constant
//   across every sample seen) + a chunk tag whose low byte varies but whose
//   next 3 bytes are always [0x00, 0x80, 0x01] (searched for, not assumed
//   at a fixed offset — see findVertexChunkTag) + u32 vertex-block byte
//   length N + N bytes of vertex data (stride 52 = 13x float32: pos.xyz,
//   boneIndices.xyzw, boneWeights.xyzw, uv.xy) + u32 index-block byte
//   length M + M bytes of uint16 LE triangle-list indices.
//
// A second real sub-format was found in the wild (MDLV0023, seen on two
// other Workshop items) with a different, still-undeciphered vertex stride
// (48 bytes, not 52) whose index block does NOT reference every vertex —
// the self-consistency check below (maxIndex === vertexCount-1) catches
// and rejects it rather than risk drawing a corrupted mesh from a wrong
// guess. Only MDLV0016-shaped puppets render today; others fail loudly so
// the caller can fall back, same as any other unsupported asset.
function findVertexChunkTag(buf, from) {
  const limit = Math.min(buf.length - 8, from + 256);
  for (let i = from; i < limit; i++) {
    if (buf[i + 1] === 0x00 && buf[i + 2] === 0x80 && buf[i + 3] === 0x01) return i;
  }
  return -1;
}

function decodePuppetMdl(buf) {
  const magic = buf.toString('ascii', 0, 8);
  if (!magic.startsWith('MDLV')) throw new Error(`Unsupported puppet .mdl magic: ${magic}`);

  const mat = readCString(buf, 21);
  const tagOff = findVertexChunkTag(buf, mat.next);
  if (tagOff === -1) throw new Error(`Puppet vertex chunk tag not found (unrecognized layout, magic ${magic})`);

  const VERTEX_STRIDE = 52;
  let offset = tagOff + 4;
  const vlen = buf.readUInt32LE(offset); offset += 4;
  const vertexCount = vlen / VERTEX_STRIDE;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
    throw new Error(`Puppet vertex block size is not a multiple of the vertex stride (unrecognized layout, magic ${magic})`);
  }

  const vertices = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const base = offset + i * VERTEX_STRIDE;
    vertices[i] = {
      x: buf.readFloatLE(base), y: buf.readFloatLE(base + 4),
      u: buf.readFloatLE(base + 44), v: buf.readFloatLE(base + 48),
    };
  }
  offset += vlen;

  const ilen = buf.readUInt32LE(offset); offset += 4;
  const indexCount = ilen / 2;
  if (!Number.isInteger(indexCount) || indexCount <= 0) {
    throw new Error(`Puppet index block size is not a multiple of 2 (unrecognized layout, magic ${magic})`);
  }
  const indices = new Uint16Array(indexCount);
  let maxIndex = 0;
  for (let i = 0; i < indexCount; i++) {
    const v = buf.readUInt16LE(offset + i * 2);
    indices[i] = v;
    if (v > maxIndex) maxIndex = v;
  }

  if (maxIndex !== vertexCount - 1) {
    throw new Error(`Puppet mesh failed self-consistency check (maxIndex=${maxIndex}, vertexCount=${vertexCount}, magic ${magic}) — unrecognized layout variant, refusing to guess`);
  }

  return { materialPath: mat.str, vertices, indices };
}

function readCString(buf, offset) {
  let end = offset;
  while (buf[end] !== 0) end++;
  return { str: buf.toString('utf-8', offset, end), next: end + 1 };
}

module.exports = { unpackPkg, decodeTexToPng, decodePuppetMdl };
