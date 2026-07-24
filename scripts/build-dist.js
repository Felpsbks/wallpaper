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
  // Arquivo temporário que o rcedit às vezes deixa pra trás (confirmado ao
  // vivo, 2026-07-20 — um "RCXXXXX.tmp" de 33MB inflou o pacote final por
  // engano) — nunca deve ser copiado, não importa o nome exato.
  if (/^RC[0-9A-F]+\.tmp$/i.test(entry)) continue;
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

// --- 4. Publish + bundle WallpaperHost.exe (Modo de compatibilidade WebView2) ---
// Fica FORA do app.asar, ao lado do exe principal — é um runtime .NET
// self-contained próprio (não faz sentido empacotar isso dentro do asar,
// que é pro código JS do app). src/wallpaper-host-process.js's
// getWallpaperHostExePath() procura exatamente nesse caminho relativo ao exe
// empacotado. Melhor esforço: se o SDK do .NET não estiver instalado nesta
// máquina de build, avisa e segue sem essa feature — não trava o dist inteiro
// por causa de uma feature experimental opcional.
const whHostRoot = path.join(root, 'native', 'WallpaperHost');
const whPublishSrc = path.join(whHostRoot, 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish');
const whDistDir = path.join(distApp, 'wallpaperhost');
console.log('\nPublishing WallpaperHost.exe (Modo de compatibilidade WebView2)...');
const dotnetResult = spawnSync('dotnet', ['publish', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true'], {
  cwd: whHostRoot, stdio: 'inherit', shell: true,
});
let whBundled = false;
if (dotnetResult.status !== 0 || !fs.existsSync(path.join(whPublishSrc, 'WallpaperHost.exe'))) {
  console.warn('dotnet publish falhou ou não encontrado — pulando WallpaperHost.exe. "Modo de compatibilidade (WebView2)" não vai funcionar neste pacote (o toggle aparece, mas cai no aviso de "executável não encontrado").');
} else {
  fs.mkdirSync(whDistDir, { recursive: true });
  spawnSync('xcopy', [`"${whPublishSrc}"`, `"${whDistDir}"`, '/E', '/I', '/Q'], { shell: true });

  // wallpaper/ precisa andar JUNTO do WallpaperHost.exe, dentro da mesma
  // pasta — ver getWallpaperContentDir() em main.js. Copiado da cópia já
  // desempacotada pelo pack.js (bin/resources/app.asar.unpacked/wallpaper),
  // fonte única de verdade, em vez de ler wallpaper/ direto (evita duas
  // lógicas de "qual é o conteúdo real" divergindo).
  const wallpaperUnpackedSrc = path.join(root, 'bin', 'resources', 'app.asar.unpacked', 'wallpaper');
  if (fs.existsSync(wallpaperUnpackedSrc)) {
    const whContentDir = path.join(whDistDir, 'content');
    fs.mkdirSync(whContentDir, { recursive: true });
    spawnSync('xcopy', [`"${wallpaperUnpackedSrc}"`, `"${whContentDir}"`, '/E', '/I', '/Q'], { shell: true });
    whBundled = true;
  } else {
    console.warn('bin/resources/app.asar.unpacked/wallpaper não encontrado — rode "node scripts/pack.js" antes deste script. WallpaperHost.exe ficou sem conteúdo pra servir.');
  }
  console.log('WallpaperHost.exe empacotado em dist/Engine Wallpaper/wallpaperhost/');
}

// --- 5. Assets de release prontos pra upload (auto-update leve + instalação manual) ---
// wallpaperhost.zip: pequeno (só o runtime .NET self-contained + conteúdo
// web), o segundo asset opcional que apply-update (main.js) sabe baixar e
// trocar sozinho junto do app.asar — ver memória project_update_checker.
// EngineWallpaper-<versão>-win64.zip: pacote completo, pra instalação manual
// do zero (o auto-update não serve pra quem ainda não tem o app instalado).
// Compress-Archive (PowerShell) em vez de alguma lib de zip em Node — mesma
// ferramenta já usada manualmente nesta sessão pra gerar as releases, sem
// dependência nova.
console.log('\nGerando assets de release (.zip)...');
if (whBundled) {
  const whZipPath = path.join(distRoot, 'wallpaperhost.zip');
  spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${whDistDir}\\*' -DestinationPath '${whZipPath}' -Force`,
  ], { stdio: 'inherit' });
  console.log(fs.existsSync(whZipPath)
    ? `wallpaperhost.zip pronto (${(fs.statSync(whZipPath).size / 1024 / 1024).toFixed(1)} MB)`
    : 'Falha ao gerar wallpaperhost.zip — Compress-Archive não rodou.');
}

const appVersion = require(path.join(root, 'package.json')).version;
const fullZipPath = path.join(distRoot, `EngineWallpaper-${appVersion}-win64.zip`);
spawnSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${distApp}\\*' -DestinationPath '${fullZipPath}' -Force`,
], { stdio: 'inherit' });
console.log(fs.existsSync(fullZipPath)
  ? `EngineWallpaper-${appVersion}-win64.zip pronto (${(fs.statSync(fullZipPath).size / 1024 / 1024).toFixed(1)} MB)`
  : 'Falha ao gerar o zip completo — Compress-Archive não rodou.');

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
