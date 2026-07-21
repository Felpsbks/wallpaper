// Creates dist/Engine Wallpaper/ — a ready-to-run distribution folder.
// Renames electron.exe → Engine Wallpaper.exe and embeds the custom icon.
// Run with: npm run dist
const fs         = require('fs');
const path       = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root    = path.join(__dirname, '..');
const binSrc  = path.join(root, 'bin');
const distApp = path.join(root, 'dist', 'Engine Wallpaper');
const exeName = 'Engine Wallpaper.exe';
const icoPath = path.join(root, 'assets', 'icon.ico');
const rcedit  = path.join(binSrc, 'rcedit.exe');

// --- 1. Clean dist ---
const distRoot = path.join(root, 'dist');
if (fs.existsSync(distRoot)) fs.rmSync(distRoot, { recursive: true });
fs.mkdirSync(distApp, { recursive: true });

// --- 2. Copy bin/ → dist/Engine Wallpaper/, renaming electron.exe ---
console.log('Copying Electron runtime...');
for (const entry of fs.readdirSync(binSrc)) {
  // Ferramentas de build que não devem ir pro pacote do usuário final.
  if (['rcedit.exe', '7z.exe', '7z.sfx', '7z.dll'].includes(entry)) continue;
  const src  = path.join(binSrc, entry);
  const name = entry === 'electron.exe' ? exeName : entry;
  const dst  = path.join(distApp, name);

  if (fs.statSync(src).isDirectory()) {
    spawnSync('xcopy', [`"${src}"`, `"${dst}"`, '/E', '/I', '/Q'], { shell: true });
  } else {
    fs.copyFileSync(src, dst);
  }
}

// --- 3. Apply icon + version info via rcedit ---
const exePath = path.join(distApp, exeName);

if (!fs.existsSync(rcedit)) {
  console.warn('rcedit.exe not found in bin/ — skipping icon embedding.');
  console.warn('Download it from https://github.com/electron/rcedit/releases');
} else if (!fs.existsSync(icoPath)) {
  console.warn('assets/icon.ico not found — run npm run icons first.');
} else {
  console.log('Embedding icon and version info...');
  try {
    execFileSync(rcedit, [
      exePath,
      '--set-icon',            icoPath,
      '--set-file-version',    '1.0.0.0',
      '--set-product-version', '1.0.0.0',
      '--set-version-string',  'FileDescription',  'Engine Wallpaper',
      '--set-version-string',  'ProductName',       'Engine Wallpaper',
      '--set-version-string',  'OriginalFilename',  exeName,
      '--set-version-string',  'InternalName',      'engine-wallpaper',
      '--set-version-string',  'LegalCopyright',    '2025',
    ], { stdio: 'inherit' });
    console.log('Icon embedded successfully.');
  } catch (err) {
    console.error('rcedit failed:', err.message);
  }
}

// --- Done ---
const size = dirSizeMB(distApp);
console.log(`\nDone!  dist/Engine Wallpaper/  (${size} MB)`);
console.log(`Run:   dist\\Engine Wallpaper\\${exeName}`);

function dirSizeMB(dir) {
  let total = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p);
      else total += s.size;
    }
  }
  walk(dir);
  return (total / 1024 / 1024).toFixed(1);
}
