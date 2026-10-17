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
    } else if (bytesPerPixel === 2) {
      // RG88 (formato 8 do WE): mesma conversão do shader real
      // (common_fragment.h ConvertTexture0Format: `_sample.rrrg`) — R é a
      // luminância, G é o alfa. Usado por sprites de partícula em escala de
      // cinza com transparência (flare, névoa, feixes): 51 das 229 texturas
      // de estoque do WE não decodificavam sem isso (2026-10-13).
      const l = raw[i * 2], a = raw[i * 2 + 1];
      out[i * 4] = l; out[i * 4 + 1] = l; out[i * 4 + 2] = l; out[i * 4 + 3] = a;
    } else { // 3 (RGB888)
      out[i * 4] = raw[i * 3]; out[i * 4 + 1] = raw[i * 3 + 1]; out[i * 4 + 2] = raw[i * 3 + 2]; out[i * 4 + 3] = 255;
    }
  }
  return out;
}

// Descompressão DXT1/DXT3/DXT5 (BC1/BC2/BC3) pra RGBA. O formato vem do
// cabeçalho TEXV (u32 logo após "TEXV0005\0TEXI0001\0"): 4 = DXT5, 6 = DXT3,
// 7 = DXT1. DXT5/DXT3 ocupam 1 byte por pixel — o mesmo tamanho de R8 —
// então o tamanho sozinho não diferencia: sem isso as texturas DXT5 da cena
// 3762437755 (cenário 4K, personagem) saíam como listras cinzas (2026-10-16).
function decodeDxtToRgba(data, width, height, format) {
  const blockBytes = format === 7 ? 8 : 16;
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  if (data.length < bw * bh * blockBytes) throw new Error('DXT data too short');
  const out = Buffer.alloc(width * height * 4);
  const c = new Uint8Array(16), a = new Uint8Array(16);
  const rgb565 = (v, o) => {
    const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    c[o] = (r << 3) | (r >> 2); c[o + 1] = (g << 2) | (g >> 4); c[o + 2] = (b << 3) | (b >> 2); c[o + 3] = 255;
  };
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let p = (by * bw + bx) * blockBytes;
      const alpha = new Uint8Array(16).fill(255);
      if (format === 4) { // DXT5: alfa interpolado de 2 extremos + índices de 3 bits
        a[0] = data[p]; a[1] = data[p + 1];
        if (a[0] > a[1]) for (let i = 1; i < 7; i++) a[i + 1] = ((7 - i) * a[0] + i * a[1] + 3) / 7 | 0;
        else { for (let i = 1; i < 5; i++) a[i + 1] = ((5 - i) * a[0] + i * a[1] + 2) / 5 | 0; a[6] = 0; a[7] = 255; }
        let bits = 0, nbits = 0, q = p + 2;
        for (let i = 0; i < 16; i++) {
          if (nbits < 3) { bits |= data[q++] << nbits; nbits += 8; }
          alpha[i] = a[bits & 7]; bits >>= 3; nbits -= 3;
        }
        p += 8;
      } else if (format === 6) { // DXT3: alfa explícito de 4 bits
        for (let i = 0; i < 16; i++) { const v = (data[p + (i >> 1)] >> ((i & 1) * 4)) & 15; alpha[i] = v * 17; }
        p += 8;
      }
      const c0 = data[p] | (data[p + 1] << 8), c1 = data[p + 2] | (data[p + 3] << 8);
      rgb565(c0, 0); rgb565(c1, 4);
      if (c0 > c1 || format !== 7) {
        for (let k = 0; k < 3; k++) { c[8 + k] = (2 * c[k] + c[4 + k] + 1) / 3 | 0; c[12 + k] = (c[k] + 2 * c[4 + k] + 1) / 3 | 0; }
        c[11] = 255; c[15] = 255;
      } else {
        for (let k = 0; k < 3; k++) c[8 + k] = (c[k] + c[4 + k]) >> 1;
        c[11] = 255; c[12] = c[13] = c[14] = 0; c[15] = 0; // DXT1 com transparência de 1 bit
      }
      const idx = data[p + 4] | (data[p + 5] << 8) | (data[p + 6] << 16) | (data[p + 7] << 24);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
        if (x >= width || y >= height) continue;
        const ci = ((idx >>> (i * 2)) & 3) * 4, o = (y * width + x) * 4;
        out[o] = c[ci]; out[o + 1] = c[ci + 1]; out[o + 2] = c[ci + 2];
        out[o + 3] = format === 7 ? c[ci + 3] : alpha[i];
      }
    }
  }
  return out;
}

// A textura alocada é arredondada pra potência de 2 (ex: 1024×1024) mas a
// imagem útil pode ser menor (ex: 1000×1000) — o resto é preenchimento que o
// WE nunca mostra (o UV dele vai só até imgW/texW). O cabeçalho TEXV traz os
// dois tamanhos (u32 em 26/30 = textura, 34/38 = imagem). Sem recortar, a
// imagem inteira ficava esticada no objeto, com borda vazia — 91 das 365
// texturas do cache têm preenchimento (2026-10-16).
function encodeTexRgba(texBuffer, rgba, width, height) {
  if (texBuffer.length >= 42 && texBuffer.toString('latin1', 0, 4) === 'TEXV') {
    const imgW = texBuffer.readUInt32LE(34), imgH = texBuffer.readUInt32LE(38);
    if (imgW > 0 && imgH > 0 && imgW <= width && imgH <= height && (imgW < width || imgH < height)) {
      const out = Buffer.alloc(imgW * imgH * 4);
      for (let y = 0; y < imgH; y++) rgba.copy(out, y * imgW * 4, y * width * 4, y * width * 4 + imgW * 4);
      return encodeRgbaToPng(out, imgW, imgH);
    }
  }
  return encodeRgbaToPng(rgba, width, height);
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

    // TEXB0001 (container antigo, ex: textura de estoque util/noflow.tex que
    // o efeito "shake" usa como mapa de direção padrão — sem isso o shake
    // falhava em toda cena que não traz o próprio mapa). Layout lido dos
    // bytes reais (2026-10-13): [u32 imagens][u32 mips][u32 largura]
    // [u32 altura][u32 tamanho] + pixels CRUS (sem LZ4), 1/3/4 bytes por pixel.
    if (version === '0001' && fieldsStart + 20 <= texBuffer.length) {
      const width = texBuffer.readUInt32LE(fieldsStart + 8);
      const height = texBuffer.readUInt32LE(fieldsStart + 12);
      const dataLength = texBuffer.readUInt32LE(fieldsStart + 16);
      const dataStart = fieldsStart + 20;
      const pixelCount = width * height;
      const bpp = pixelCount > 0 ? dataLength / pixelCount : 0;
      if (dataStart + dataLength <= texBuffer.length && (bpp === 1 || bpp === 2 || bpp === 3 || bpp === 4)) {
        const raw = texBuffer.subarray(dataStart, dataStart + dataLength);
        return encodeTexRgba(texBuffer, bpp === 4 ? raw : expandToRgba(raw, bpp, pixelCount), width, height);
      }
    }

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

      // DXT: o formato está no cabeçalho TEXV, não no TEXB (ver decodeDxtToRgba).
      const texvFormat = texBuffer.toString('latin1', 0, 4) === 'TEXV' && texBuffer.length >= 22 ? texBuffer.readUInt32LE(18) : -1;
      if ((texvFormat === 4 || texvFormat === 6 || texvFormat === 7) && format !== 2 && width > 0 && height > 0
          && dataLength > 0 && dataStart + dataLength <= texBuffer.length) {
        const flagOff = version === '0003' ? 20 : version === '0002' ? 16 : 24; // campo "flag": 1 = LZ4
        const lz4 = texBuffer.readUInt32LE(fieldsStart + flagOff) === 1;
        try {
          const data = lz4
            ? lz4BlockDecompress(texBuffer, dataStart, dataLength, uncompressedSize)
            : texBuffer.subarray(dataStart, dataStart + dataLength);
          return encodeTexRgba(texBuffer, decodeDxtToRgba(data, width, height, texvFormat), width, height);
        } catch (_) { /* cai no scan cego abaixo */ }
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
          && Number.isInteger(bytesPerPixel) && (bytesPerPixel === 1 || bytesPerPixel === 2 || bytesPerPixel === 3 || bytesPerPixel === 4)) {
        try {
          const raw = lz4BlockDecompress(texBuffer, dataStart, dataLength, uncompressedSize);
          const rgba = bytesPerPixel === 4 ? raw : expandToRgba(raw, bytesPerPixel, pixelCount);
          return encodeTexRgba(texBuffer, rgba, width, height);
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
      const video = extractTexVideo(data);
      if (video) fs.writeFileSync(outPath + '.mp4', video);
      else {
        const png = decodeTexToPng(data);
        if (png) fs.writeFileSync(outPath + '.png', png);
      }
    }
  }
  markSceneCacheCurrent(outDir);
  return written;
}

// Versão do decodificador de .tex gravada no cache por unpackPkg. Quando o
// decodificador passa a entender um formato novo, os .tex.png antigos do
// cache ficam errados (ex: DXT5 gravado como listras cinzas até 2026-10-16) —
// subir este número faz o main desempacotar de novo, uma vez por cena.
const TEX_DECODER_VERSION = 3; // 3: recorte do preenchimento (encodeTexRgba)
const TEX_DECODER_MARKER = '.tex-decoder-version';
function isSceneCacheCurrent(cacheDir) {
  try { return fs.readFileSync(path.join(cacheDir, TEX_DECODER_MARKER), 'utf-8').trim() === String(TEX_DECODER_VERSION); }
  catch { return false; }
}
function markSceneCacheCurrent(cacheDir) {
  fs.writeFileSync(path.join(cacheDir, TEX_DECODER_MARKER), String(TEX_DECODER_VERSION));
}
// .tex cujo .png o decodificador antigo gravava errado (DXT1/3/5).
function isDxtTex(buf) {
  return buf.length >= 22 && buf.toString('latin1', 0, 4) === 'TEXV' && [4, 6, 7].includes(buf.readUInt32LE(18));
}

// Puppet ("*_puppet.mdl") — Wallpaper Engine's 2D rigged mesh format,
// referenced by a model.json's "puppet" field alongside its usual
// "material". Shares the "MDLV" magic family with the rigid 3D .mdl format
// (confirmed MDLV0017 there vs MDLV0016 here) but this is a separate,
// simpler layout. Three blocks are decoded: mesh (bind-pose
// vertices/indices), skeleton (bone hierarchy + bind matrices, see
// decodePuppetSkeleton) and keyframe animation ("MDLAxxxx", see
// decodePuppetAnimations — layout read from WE's own loader, 2026-10-13).
// The bind pose of many puppets is a spread-out "cut-out sheet" of parts;
// it's the animation (skinned in we-scene-render.js) that assembles the
// character — confirmed live with the Miku puppet (3005028837).
//
// Layout lido do próprio loader do Wallpaper Engine (wallpaper64.exe,
// FUN_140261880, decompilado via REA/Ghidra em 2026-10-16) e validado contra
// os 12 puppets reais do cache (MDLV0016 e MDLV0023, MDLS0002 e MDLS0004,
// MDLA0003 e MDLA0006): todas as trilhas passam nas mesmas checagens de
// tamanho que o WE faz, e a leitura termina exatamente no bloco seguinte.
// Antes disso o parser procurava uma "tag" e assumia stride 52 fixo, o que
// recusava todo MDLV0023 (puppets viravam blocos brancos).
//
//   "MDLVxxxx\0" (magic como string C, versão = os 4 dígitos)
//   u32 formato padrão + u32 strings por malha + u32 quantidade de malhas
//   por malha:
//     N strings C (a 1ª é o material)
//     v>=4:  u32 flags (se flags & 2, mais um u32)
//     v>=17: 6×f32 bbox + u32 formato do vértice; v15/16: só o u32 formato
//     u32 tamanho + bloco de vértices; u32 tamanho + índices u16
//     v>20:  bool → (u32 + blob); bool → blob
//     v>22:  u32 quantidade de morphs (+ registros, pulados — o esqueleto
//            é localizado pela magic "MDLS" logo depois)
//
// O formato do vértice é uma máscara de bits; os atributos vêm nesta ordem:
// posição 12 (0x1), normal 12 (0x2), tangente 16 (0x4), índices de osso
// u32×4 (0x800000), pesos f32×4 (0x1000000), uv 8 (0x8). MDLV0016 usa
// 0x1800009 (stride 52), MDLV0023 usa 0x180000f (stride 80). Os índices de
// osso são inteiros de verdade (lidos como float dão denormais tipo 5.6e-45).
//
// vertex.xy está no espaço de pixels da textura do material (igual ao quad
// de imagem); o uv embutido é o real, mas com v invertido (ver
// we-scene-render.js, que usa 1 - v).
const PUPPET_VERTEX_ATTRS = [
  // [bit, bytes, campo] — na ordem em que o WE grava os atributos
  [0x1, 12, 'pos'], [0x2, 12, 'normal'], [0x4, 16, 'tangent'],
  [0x800000, 16, 'bones'], [0x1000000, 16, 'weights'], [0x8, 8, 'uv'],
];

function puppetVertexLayout(format) {
  const known = PUPPET_VERTEX_ATTRS.reduce((m, [bit]) => m | bit, 0);
  if (format & ~known) throw new Error(`Puppet vertex format 0x${format.toString(16)} has unsupported attributes`);
  const offsets = {};
  let stride = 0;
  for (const [bit, size, field] of PUPPET_VERTEX_ATTRS) {
    if (format & bit) { offsets[field] = stride; stride += size; }
  }
  if (offsets.pos === undefined) throw new Error('Puppet vertex format has no position');
  return { stride, offsets };
}

function readMagicVersion(buf, offset, prefix) {
  const { str, next } = readCString(buf, offset);
  const version = parseInt(str.slice(4), 10);
  if (!str.startsWith(prefix) || !Number.isInteger(version)) throw new Error(`Unrecognized block magic: ${str}`);
  return { version, next };
}

function decodePuppetMdl(buf) {
  const head = readMagicVersion(buf, 0, 'MDLV');
  const version = head.version;
  let offset = head.next;
  const defaultFormat = buf.readUInt32LE(offset);
  const stringsPerMesh = buf.readUInt32LE(offset + 4);
  const meshCount = buf.readUInt32LE(offset + 8);
  offset += 12;
  if (!(meshCount >= 1 && meshCount < 64) || !(stringsPerMesh >= 1 && stringsPerMesh < 16)) {
    throw new Error(`Implausible puppet header (meshes=${meshCount}, strings=${stringsPerMesh}, magic MDLV${version})`);
  }

  // Todos os puppets vistos têm 1 malha; se vier mais de uma, só a 1ª é
  // desenhada (o resto é lido só pra achar onde o esqueleto começa).
  let first = null;
  let morphCount = 0;
  for (let m = 0; m < meshCount; m++) {
    const strings = [];
    for (let k = 0; k < stringsPerMesh; k++) { const s = readCString(buf, offset); strings.push(s.str); offset = s.next; }
    if (version >= 4) {
      const flags = buf.readUInt32LE(offset); offset += 4;
      if (flags & 2) offset += 4;
    }
    let format = defaultFormat;
    if (version >= 17) { offset += 24; format = buf.readUInt32LE(offset); offset += 4; }
    else if (version >= 15) { format = buf.readUInt32LE(offset); offset += 4; }

    const vlen = buf.readUInt32LE(offset); offset += 4;
    const vstart = offset; offset += vlen;
    const ilen = buf.readUInt32LE(offset); offset += 4;
    const istart = offset; offset += ilen;
    if (offset > buf.length) throw new Error(`Puppet mesh block overruns the file (magic MDLV${version})`);
    if (version > 20) {
      if (buf[offset++]) { offset += 4; offset += 4 + buf.readUInt32LE(offset); }
      if (buf[offset++]) { offset += 4 + buf.readUInt32LE(offset); }
    }
    if (version > 22) { morphCount = buf.readUInt32LE(offset); offset += 4; }
    if (!first) first = { materialPath: strings[0], format, vstart, vlen, istart, ilen };
  }

  const { stride, offsets } = puppetVertexLayout(first.format);
  const vertexCount = first.vlen / stride;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
    throw new Error(`Puppet vertex block size ${first.vlen} is not a multiple of stride ${stride} (magic MDLV${version})`);
  }
  const vertices = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const base = first.vstart + i * stride;
    const p = base + offsets.pos;
    const v = { x: buf.readFloatLE(p), y: buf.readFloatLE(p + 4), boneIndices: [0, 0, 0, 0], boneWeights: [1, 0, 0, 0], u: 0, v: 0 };
    if (offsets.bones !== undefined) {
      const o = base + offsets.bones;
      v.boneIndices = [buf.readUInt32LE(o), buf.readUInt32LE(o + 4), buf.readUInt32LE(o + 8), buf.readUInt32LE(o + 12)];
    }
    if (offsets.weights !== undefined) {
      const o = base + offsets.weights;
      v.boneWeights = [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)];
    }
    if (offsets.uv !== undefined) {
      const o = base + offsets.uv;
      v.u = buf.readFloatLE(o); v.v = buf.readFloatLE(o + 4);
    }
    vertices[i] = v;
  }

  const indexCount = first.ilen / 2;
  if (!Number.isInteger(indexCount) || indexCount <= 0) {
    throw new Error(`Puppet index block size is not a multiple of 2 (magic MDLV${version})`);
  }
  const indices = new Uint16Array(indexCount);
  let maxIndex = 0;
  for (let i = 0; i < indexCount; i++) {
    const idx = buf.readUInt16LE(first.istart + i * 2);
    indices[i] = idx;
    if (idx > maxIndex) maxIndex = idx;
  }
  if (maxIndex >= vertexCount) {
    throw new Error(`Puppet index ${maxIndex} out of range (vertexCount=${vertexCount}, magic MDLV${version})`);
  }

  // Esqueleto e animação nunca lançam: puppet sem esqueleto/animação
  // reconhecidos cai pro desenho estático na pose de bind.
  let skeleton = null;
  try {
    const so = buf.indexOf('MDLS', offset, 'ascii');
    if (so !== -1) skeleton = decodePuppetSkeleton(buf, so);
  } catch { /* sem esqueleto reconhecido — segue sem articulação */ }

  let animations = [];
  if (skeleton) {
    try {
      animations = decodePuppetAnimations(buf, skeleton.end, skeleton.bones.length, skeleton.extras.length, morphCount);
    } catch { /* animação não reconhecida — segue na pose de bind */ }
  }

  return { materialPath: first.materialPath, vertices, indices, skeleton, animations };
}

// Quadros de spritesheet embutidos no .tex (bloco "TEXS0002", depois dos
// pixels): u32 quantidade + por quadro 32 bytes = u32 imagem, f32 tempo,
// f32 x, f32 y, f32 eixoX.x, f32 eixoX.y, f32 eixoY.x, f32 eixoY.y (em
// pixels). Conferido em particle/fire/fire1 (64 quadros de 128×128) e fire2
// (32): o bloco termina exatamente no fim do arquivo. É a fonte real da
// grade das partículas animadas (antes era chute de células de 128 px).
function parseTexSpriteFrames(buf) {
  const i = buf.lastIndexOf('TEXS', buf.length, 'latin1');
  if (i < 0 || buf.toString('latin1', i, i + 6) !== 'TEXS00') return null;
  const n = buf.readUInt32LE(i + 9);
  const start = i + 13;
  if (!(n > 0 && n < 100000) || start + n * 32 > buf.length) return null;
  const frames = [];
  for (let k = 0; k < n; k++) {
    const o = start + k * 32;
    const x = buf.readFloatLE(o + 8), y = buf.readFloatLE(o + 12);
    const w = Math.hypot(buf.readFloatLE(o + 16), buf.readFloatLE(o + 20));
    const h = Math.hypot(buf.readFloatLE(o + 24), buf.readFloatLE(o + 28));
    frames.push({ x, y, w, h, time: buf.readFloatLE(o + 4) });
  }
  return frames;
}

// Textura de VÍDEO (flag 32 no cabeçalho TEXV, ex: flags 34 = vídeo +
// clamp): o conteúdo do TEXB é um MP4 inteiro embutido, não pixels. Achado
// em 4 texturas reais do cache (3765643610, 3768450569, 3768497818) que nunca
// decodificavam — o fundo dessas cenas sumia. Devolve os bytes do MP4.
function extractTexVideo(buf) {
  if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'TEXV') return null;
  if (!(buf.readUInt32LE(22) & 32)) return null;
  const limit = Math.min(buf.length - 4, 512);
  for (let i = 8; i < limit; i++) {
    if (buf[i] === 0x66 && buf.toString('latin1', i, i + 4) === 'ftyp') return buf.subarray(i - 4);
  }
  return null;
}

// Bloco "MDLAxxxx" — animação por keyframes do puppet (mesma fonte: loader
// do WE via REA). Formato:
//   "MDLAxxxx\0" + u32 tamanho do bloco + i32 quantidade de animações
//   por animação:
//     u64 id (o número que scene.json referencia em
//       animationlayers[].animation — ex: 143 na Miku)
//     string nome + string modo ("loop") + f32 fps + i32 numFrames +
//     i32 flags + i32 quantidade de trilhas (uma por osso)
//     por trilha: u32 + u32 tamanho + (numFrames+1) quadros de 9×f32 =
//       posição xyz, rotação xyz (radianos), escala xyz — transformação
//       LOCAL do osso. O quadro extra fecha o loop.
//     v>1:  uma trilha 9×f32 por "extra" do esqueleto + uma trilha 1×f32
//           por morph da malha
//     v>2:  u32 n + n trilhas 1×f32; bool → uma trilha 1×f32 por osso
//     v>=4: bool → bloco por malha (não visto em arquivo real; recusado)
//     v>4:  6×u32 de parâmetros
//     v>5:  bool → uma trilha 1×f32 por osso
//     flags & 1: struct extra (não visto em arquivo real; recusado)
//     u32 n + n eventos (u32 quadro + string nome)
//   Toda "trilha 1×f32" é u32 + u32 tamanho + (numFrames+1)×f32.
// A leitura para na primeira animação que não fechar — as anteriores
// continuam valendo.
function decodePuppetAnimations(buf, from, boneCount, extraCount = 0, morphCount = 0) {
  const start = buf.indexOf('MDLA', from, 'ascii');
  if (start === -1) return [];
  const head = readMagicVersion(buf, start, 'MDLA');
  const version = head.version;
  let offset = head.next + 4; // + tamanho do bloco (o WE só usa como limite)
  const animCount = buf.readInt32LE(offset); offset += 4;
  if (!(animCount > 0 && animCount < 1024)) throw new Error(`Implausible animation count: ${animCount}`);

  const FRAME_FLOATS = 9;
  const animations = [];
  for (let a = 0; a < animCount; a++) {
    const id = Number(buf.readBigUInt64LE(offset)); offset += 8;
    const name = readCString(buf, offset); offset = name.next;
    const mode = readCString(buf, offset); offset = mode.next;
    const fps = buf.readFloatLE(offset);
    const numFrames = buf.readInt32LE(offset + 4);
    const flags = buf.readInt32LE(offset + 8);
    const trackCount = buf.readInt32LE(offset + 12);
    offset += 16;
    if (!(fps > 0) || !(numFrames > 0) || trackCount !== boneCount) break;
    const frameCount = numFrames + 1;

    // Lê u32 + u32 tamanho + dados, conferindo o tamanho como o WE confere.
    const readTrack = (floatsPerFrame) => {
      offset += 4;
      const len = buf.readUInt32LE(offset); offset += 4;
      if (len !== frameCount * floatsPerFrame * 4 || offset + len > buf.length) throw new Error('bad track');
      const at = offset; offset += len;
      return at;
    };

    try {
      const tracks = new Array(trackCount);
      for (let t = 0; t < trackCount; t++) {
        const at = readTrack(FRAME_FLOATS);
        const frames = new Float32Array(frameCount * FRAME_FLOATS);
        for (let k = 0; k < frames.length; k++) frames[k] = buf.readFloatLE(at + k * 4);
        tracks[t] = frames;
      }
      if (version > 1) {
        for (let t = 0; t < extraCount; t++) readTrack(FRAME_FLOATS);
        for (let t = 0; t < morphCount; t++) readTrack(1);
      }
      if (version > 2) {
        const n = buf.readUInt32LE(offset); offset += 4;
        for (let t = 0; t < n; t++) readTrack(1);
        if (buf[offset++]) for (let t = 0; t < trackCount; t++) readTrack(1);
      }
      if (version >= 4 && buf[offset++]) throw new Error('per-mesh animation data not supported');
      if (version > 4) offset += 24;
      if (version > 5 && buf[offset++]) for (let t = 0; t < trackCount; t++) readTrack(1);
      if (flags & 1) throw new Error('animation flag 1 struct not supported');
      const eventCount = buf.readUInt32LE(offset); offset += 4;
      for (let e = 0; e < eventCount; e++) { offset += 4; offset = readCString(buf, offset).next; }
      animations.push({ id, name: name.str, mode: mode.str, fps, numFrames, tracks });
    } catch {
      break;
    }
  }
  return animations;
}

// Bloco "MDLSxxxx" — esqueleto do puppet (hierarquia + pose de bind), logo
// depois da malha. Formato (loader do WE via REA):
//   "MDLSxxxx\0" + u32 tamanho do bloco + u32 quantidade de ossos
//   por osso: string nome (vazia em todos os vistos) + u32 tipo +
//     i32 índice do pai (-1 = raiz; sempre menor que o próprio índice) +
//     u32 tamanho da matriz (64) + 4x4 f32 row-major LOCAL de bind
//     (relativa ao pai; translação nos floats 12/13/14) +
//     string JSON de metadados (pode ser vazia)
//   v>=2: u16 quantidade de "extras" + por extra: string + f32 + f32 + 64 bytes
function decodePuppetSkeleton(buf, offset) {
  const head = readMagicVersion(buf, offset, 'MDLS');
  offset = head.next + 4; // tamanho do bloco
  const boneCount = buf.readUInt32LE(offset); offset += 4;
  if (!(boneCount > 0 && boneCount < 512)) throw new Error(`Implausible bone count: ${boneCount}`);

  const bones = new Array(boneCount);
  for (let i = 0; i < boneCount; i++) {
    const name = readCString(buf, offset); offset = name.next;
    offset += 4; // tipo
    const parentIndex = buf.readInt32LE(offset); offset += 4;
    const matrixSize = buf.readUInt32LE(offset); offset += 4;
    if (matrixSize !== 64 || parentIndex >= i || parentIndex < -1) throw new Error(`Bad bone record ${i}`);
    const localMatrix = new Array(16);
    for (let m = 0; m < 16; m++) { localMatrix[m] = buf.readFloatLE(offset); offset += 4; }
    const meta = readCString(buf, offset); offset = meta.next;
    bones[i] = { name: name.str, parentIndex, localMatrix, meta: meta.str };
  }

  const extras = [];
  if (head.version >= 2) {
    const n = buf.readUInt16LE(offset); offset += 2;
    for (let e = 0; e < n; e++) {
      const name = readCString(buf, offset); offset = name.next + 8 + 64;
      extras.push({ name: name.str });
    }
  }
  return { bones, extras, end: offset };
}

function readCString(buf, offset) {
  let end = offset;
  while (buf[end] !== 0) end++;
  return { str: buf.toString('utf-8', offset, end), next: end + 1 };
}

module.exports = { parseTexSpriteFrames, extractTexVideo, unpackPkg, isSceneCacheCurrent, markSceneCacheCurrent, isDxtTex, decodeTexToPng, decodePuppetMdl, decodePuppetSkeleton, decodePuppetAnimations };
