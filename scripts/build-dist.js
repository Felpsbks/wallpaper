// Creates dist/Engine Wallpaper/ — a ready-to-run distribution folder.
// Renames electron.exe → Engine Wallpaper.exe and embeds the custom icon.
// Run with: npm run dist
const fs         = require('fs');
const path       = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { signExe } = require('./sign');

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
    copyDirWithVerify(src, dst);
  } else {
    fs.copyFileSync(src, dst);
  }
}

// Achado ao vivo (2026-07-24): xcopy de bin/resources/ (o app.asar de
// ~40MB) pra dist/ às vezes termina com status 0 ("copiado com sucesso")
// mas o arquivo de destino sai MENOR que o original — sem nenhum erro
// visível, sem detecção nova no Windows Defender no momento, reproduzido
// duas vezes rodando o pipeline completo (gen-icon+pack+build-dist em
// sequência) e nenhuma vez isolado — tudo aponta pra alguma varredura em
// tempo real (antivírus) segurando uma leitura do arquivo recém-escrito
// bem nesse instante. Sem esse retry, isso publicava silenciosamente uma
// release faltando main.js inteiro (app não abre pra ninguém). Compara o
// tamanho total de cada árvore copiada contra a original; se não bater,
// apaga e tenta de novo (até 3x, com uma pequena pausa).
function dirSizeBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    const s = fs.statSync(p);
    total += s.isDirectory() ? dirSizeBytes(p) : s.size;
  }
  return total;
}
function copyDirWithVerify(src, dst) {
  const expected = dirSizeBytes(src);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    spawnSync('xcopy', [`"${src}"`, `"${dst}"`, '/E', '/I', '/Q'], { shell: true });
    const actual = fs.existsSync(dst) ? dirSizeBytes(dst) : -1;
    if (actual === expected) return;
    console.warn(`Cópia de "${path.basename(src)}" incompleta (esperado ${expected} bytes, veio ${actual}) — tentativa ${attempt}/3, tentando de novo...`);
    if (attempt < 3) {
      const waitMs = 1500 * attempt;
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* pausa síncrona curta antes de tentar de novo */ }
    }
  }
  throw new Error(`Falha ao copiar "${src}" pra "${dst}" corretamente depois de 3 tentativas — build abortado antes de publicar algo quebrado.`);
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

// Assinatura com certificado autoassinado local — só some o aviso comum do
// SmartScreen, e só nesta máquina (ver scripts/sign.js). Não resolve Smart
// App Control em outras máquinas.
signExe(exePath);

// --- 4. Publish WallpaperHost.exe (Modo de compatibilidade WebView2) ---
// NÃO vai dentro de dist/Engine Wallpaper/ (o pacote que todo mundo baixa) —
// é um runtime .NET self-contained de ~80MB usado só por quem liga o toggle
// experimental "Modo de compatibilidade (WebView2)" (GPU rejeitada pelo
// Chromium num PC específico). Publica numa pasta de staging temporária,
// zipa como asset de release separado (wallpaperhost.zip), e main.js's
// ensureWallpaperHostInstalled() baixa/extrai isso sob demanda na primeira
// vez que o usuário liga o toggle — em vez de todo instalador carregar esse
// peso pra sempre. Melhor esforço: se o SDK do .NET não estiver instalado
// nesta máquina de build, avisa e segue sem gerar esse asset.
const whHostRoot = path.join(root, 'native', 'WallpaperHost');
const whPublishSrc = path.join(whHostRoot, 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish');
const whStagingDir = path.join(distRoot, '_wallpaperhost_staging');
console.log('\nPublishing WallpaperHost.exe (Modo de compatibilidade WebView2)...');
const dotnetResult = spawnSync('dotnet', ['publish', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true'], {
  cwd: whHostRoot, stdio: 'inherit', shell: true,
});
let whBundled = false;
if (dotnetResult.status !== 0 || !fs.existsSync(path.join(whPublishSrc, 'WallpaperHost.exe'))) {
  console.warn('dotnet publish falhou ou não encontrado — pulando WallpaperHost.exe. "Modo de compatibilidade (WebView2)" vai baixar sozinho na primeira vez que alguém ligar o toggle, mas só se essa release tiver o asset wallpaperhost.zip anexado.');
} else {
  fs.mkdirSync(whStagingDir, { recursive: true });
  spawnSync('xcopy', [`"${whPublishSrc}"`, `"${whStagingDir}"`, '/E', '/I', '/Q'], { shell: true });
  signExe(path.join(whStagingDir, 'WallpaperHost.exe'));

  // wallpaper/ precisa andar JUNTO do WallpaperHost.exe, dentro do mesmo
  // zip — ver getWallpaperContentDir() em main.js. Copiado direto da fonte
  // (wallpaper/ do repo): desde 2026-07-26 o pack.js empacota wallpaper/
  // INTEIRO dentro do asar (a pasta app.asar.unpacked/wallpaper não existe
  // mais — era a causa raiz das instalações rodando renderer stale pra
  // sempre, ver comentário no pack.js), então o repo é a única fonte real.
  const wallpaperSrc = path.join(root, 'wallpaper');
  if (fs.existsSync(wallpaperSrc)) {
    const whContentDir = path.join(whStagingDir, 'content');
    copyDirWithVerify(wallpaperSrc, whContentDir);
    whBundled = true;
  } else {
    console.warn('wallpaper/ não encontrado no repo — WallpaperHost.exe ficou sem conteúdo pra servir.');
  }
}

// --- 5. Assets de release prontos pra upload (auto-update leve + instalação sob demanda) ---
// wallpaperhost.zip: pequeno (só o runtime .NET self-contained + conteúdo
// web) — o mesmo asset serve dois propósitos: apply-update (main.js) baixa e
// troca sozinho quando já instalado, e ensureWallpaperHostInstalled() baixa
// na primeira vez que o toggle é ligado num PC que nunca teve esse
// componente. Ver memória project_update_checker. EngineWallpaper-
// <versão>-win64.zip: pacote completo, pra instalação manual do zero — NÃO
// inclui wallpaperhost/ por design, mesma lógica de download sob demanda.
// Compress-Archive (PowerShell) em vez de alguma lib de zip em Node — mesma
// ferramenta já usada manualmente nesta sessão pra gerar as releases, sem
// dependência nova.
console.log('\nGerando assets de release (.zip)...');
if (whBundled) {
  const whZipPath = path.join(distRoot, 'wallpaperhost.zip');
  spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${whStagingDir}\\*' -DestinationPath '${whZipPath}' -Force`,
  ], { stdio: 'inherit' });
  console.log(fs.existsSync(whZipPath)
    ? `wallpaperhost.zip pronto (${(fs.statSync(whZipPath).size / 1024 / 1024).toFixed(1)} MB)`
    : 'Falha ao gerar wallpaperhost.zip — Compress-Archive não rodou.');
  fs.rmSync(whStagingDir, { recursive: true, force: true });
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
