// Build: packs app as app.asar into bin/resources/
// Run with: npm run pack
// Requires: @electron/asar (npx) and electron binary in bin/

const { execSync, execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const tmpSrc = path.join(os.tmpdir(), 'ew_app_src');
const resDir = path.join(root, 'bin', 'resources');
const outAsar = path.join(resDir, 'app.asar');

// Guarda contra a causa exata do bug do v1.0.20/v1.0.21: UPDATE_CHECK_REPO em
// main.js é uma string solta, sem nenhuma ligação com o remoto real do git —
// ficou apontando pro nome antigo do repositório (fynix-connect) por quem
// sabe quantas releases, e nenhum release "quebrado" assim nunca falha visivelmente:
// o app só nunca detecta a própria atualização, silenciosamente, pra sempre.
// Falhar o build aqui, comparando contra o remoto real, é o único jeito de
// pegar esse tipo de desvio ANTES de publicar, em vez de descobrir meses
// depois que ninguém recebeu updates.
(function checkUpdateRepoMatchesGitRemote() {
  let remoteUrl;
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (err) {
    console.warn('[pack] Não consegui ler o remoto do git — pulando checagem do UPDATE_CHECK_REPO.');
    return;
  }
  const remoteMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/i);
  if (!remoteMatch) return;
  const realRepo = remoteMatch[1];

  const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const constMatch = mainJs.match(/UPDATE_CHECK_REPO\s*=\s*['"]([^'"]+)['"]/);
  if (!constMatch) {
    console.error('[pack] UPDATE_CHECK_REPO não encontrado em main.js — build abortado.');
    process.exit(1);
  }
  const configuredRepo = constMatch[1];

  if (configuredRepo.toLowerCase() !== realRepo.toLowerCase()) {
    console.error(`[pack] UPDATE_CHECK_REPO ('${configuredRepo}') não bate com o remoto real do git ('${realRepo}'). O checador de atualização ficaria quebrado silenciosamente nesta build. Corrija main.js antes de empacotar.`);
    process.exit(1);
  }
})();

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

// --- Rebrand bin/electron.exe in place ---
// `npm run dist` (scripts/build-dist.js) already rebrands its own renamed
// copy of this exe, but that's a separate output folder — the actual binary
// run day-to-day (`npm start`, this dev watcher, and the Startup-folder
// autostart .lnk, which points at process.execPath) is THIS file, and it
// still ships with Electron's own icon baked into its PE resources until we
// rewrite them here too. Runs on every pack (cheap, idempotent) so dev and
// autostart never show the Electron logo again.
const electronExe = path.join(root, 'bin', 'electron.exe');
const rcedit       = path.join(root, 'bin', 'rcedit.exe');
const icoPath       = path.join(root, 'assets', 'icon.ico');
if (fs.existsSync(rcedit) && fs.existsSync(icoPath) && fs.existsSync(electronExe)) {
  console.log('Rebranding bin/electron.exe icon...');
  try {
    execFileSync(rcedit, [
      electronExe,
      '--set-icon',           icoPath,
      '--set-version-string', 'FileDescription', 'Engine Wallpaper',
      '--set-version-string', 'ProductName',      'Engine Wallpaper',
      '--set-version-string', 'InternalName',     'engine-wallpaper',
      '--set-version-string', 'OriginalFilename', 'electron.exe',
    ], { stdio: 'inherit' });
  } catch (err) {
    // Most likely cause: a previous Electron process still holds the file
    // open (dev.js kills it before calling pack(), but a manual `npm run
    // pack` while the app is running would hit this) — not fatal, the app
    // still runs fine with the old icon until the next successful pack.
    console.warn('Icon rebrand skipped (electron.exe may be running):', err.message);
  }
} else {
  console.warn('rcedit.exe or assets/icon.ico missing — skipping bin/electron.exe rebrand.');
}
