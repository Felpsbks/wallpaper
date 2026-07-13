// Build: packs app as app.asar into bin/resources/
// Run with: npm run pack
// Requires: @electron/asar (npx) and electron binary in bin/

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const tmpSrc = path.join(os.tmpdir(), 'ew_app_src');
const resDir = path.join(root, 'bin', 'resources');
const outAsar = path.join(resDir, 'app.asar');

console.log('Preparing source...');
if (fs.existsSync(tmpSrc)) fs.rmSync(tmpSrc, { recursive: true });
fs.mkdirSync(path.join(tmpSrc, 'node_modules'), { recursive: true });

for (const f of ['main.js', 'package.json']) {
  fs.copyFileSync(path.join(root, f), path.join(tmpSrc, f));
}
for (const d of ['src', 'wallpaper', 'ui', 'assets']) {
  const src = path.join(root, d);
  if (fs.existsSync(src)) {
    spawnSync('xcopy', [`"${src}"`, `"${path.join(tmpSrc, d)}"`, '/E', '/I', '/Q'], { shell: true, stdio: 'inherit' });
  }
}

const nmSrc = path.join(root, 'node_modules');
const nmDst = path.join(tmpSrc, 'node_modules');
for (const mod of fs.readdirSync(nmSrc)) {
  if (mod === 'electron' || mod === '.bin') continue;
  spawnSync('xcopy', [`"${path.join(nmSrc, mod)}"`, `"${path.join(nmDst, mod)}"`, '/E', '/I', '/Q'], { shell: true });
}

fs.mkdirSync(resDir, { recursive: true });
console.log('Packing ASAR (native addons unpacked)...');
execSync(`npx @electron/asar pack "${tmpSrc}" "${outAsar}" --unpack "**/*.node"`, { stdio: 'inherit' });
fs.rmSync(tmpSrc, { recursive: true });

const size = fs.statSync(outAsar).size;
console.log(`Done: ${outAsar} (${(size / 1024 / 1024).toFixed(1)} MB)`);
