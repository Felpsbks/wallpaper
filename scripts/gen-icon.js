// Generates assets/tray.png (64x64), assets/icon.png (256x256) and
// assets/icon.ico (16/32/48/256) from the real app logo (ui/logo-tray.png —
// the mark-only, no-text version; the square/zoomed variants have "FYNIX
// WALLPAPER ENGINE" text baked in, illegible at 16x16/32x32).
// Run with: node scripts/gen-icon.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcLogo = path.join(root, 'ui', 'logo-tray.png');
const assetsDir = path.join(root, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

if (!fs.existsSync(srcLogo)) {
  console.error(`Logo de origem não encontrado: ${srcLogo}`);
  process.exit(1);
}

// Redimensiona via System.Drawing (.NET já vem com o Windows, sem precisar
// de nenhuma dependência nova tipo sharp/jimp) — mesma técnica já usada
// nesta sessão pra extrair/conferir ícones de exe.
const SIZES = [16, 32, 48, 64, 256];
const tmpDir = path.join(os.tmpdir(), 'ew-gen-icon-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

const psLines = [
  'Add-Type -AssemblyName System.Drawing',
  `$src = [System.Drawing.Image]::FromFile("${srcLogo}")`,
  ...SIZES.map(s => [
    `$bmp = New-Object System.Drawing.Bitmap ${s}, ${s}`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
    '$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    `$g.DrawImage($src, 0, 0, ${s}, ${s})`,
    `$bmp.Save("${path.join(tmpDir, `icon-${s}.png`)}", [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('\r\n')),
  '$src.Dispose()',
].join('\r\n');

const psPath = path.join(tmpDir, 'resize.ps1');
fs.writeFileSync(psPath, psLines, 'utf8');
execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, { windowsHide: true });

const pngFor = (size) => fs.readFileSync(path.join(tmpDir, `icon-${size}.png`));

fs.writeFileSync(path.join(assetsDir, 'tray.png'), pngFor(64));
console.log('Generated assets/tray.png  (64x64, do logo real)');

fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngFor(256));
console.log('Generated assets/icon.png  (256x256, do logo real)');

// ICO com PNGs embutidos direto (compatível com Vista+) — cada entrada do
// diretório aponta pro PNG já pronto, sem reencodar nada.
function makeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let dataOffset = 6 + 16 * images.length;
  const dirs = images.map(({ size, buf }) => {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size; // width  (0 means 256)
    dir[1] = size >= 256 ? 0 : size; // height
    dir[2] = 0;                        // color count (0 = true color)
    dir[3] = 0;                        // reserved
    dir.writeUInt16LE(1, 4);           // planes
    dir.writeUInt16LE(32, 6);          // bits per pixel
    dir.writeUInt32LE(buf.length, 8);
    dir.writeUInt32LE(dataOffset, 12);
    dataOffset += buf.length;
    return dir;
  });

  return Buffer.concat([header, ...dirs, ...images.map(i => i.buf)]);
}

const icoImages = [16, 32, 48, 256].map(size => ({ size, buf: pngFor(size) }));
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), makeICO(icoImages));
console.log('Generated assets/icon.ico  (16/32/48/256, do logo real)');

fs.rmSync(tmpDir, { recursive: true, force: true });
