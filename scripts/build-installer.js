// Empacota dist/Engine Wallpaper/ (gerada por `npm run dist`) num único
// "Engine Wallpaper Setup.exe" autoextraível — usando o módulo SFX do
// 7-Zip. Extração acontece silenciosa numa pasta temp; quem assume a partir
// daí é o próprio app (main.js, ver _isFirstRunInstall/runFirstRunInstall),
// mostrando a tela de instalação com a cara do app e copiando pro destino
// definitivo.
//
// Precisa de 7-Zip instalado (não vem com o Node nem é possível bundlar
// aqui automaticamente). Coloque `7z.exe` e `7z.sfx` em bin/ antes de
// rodar — mesmo padrão do rcedit.exe (ver scripts/pack.js): se não
// encontrar, avisa e sai sem quebrar o resto do processo de build.
//   1. Instale o 7-Zip: https://www.7-zip.org/download.html
//   2. Copie pra bin/ deste projeto:
//      - "C:\Program Files\7-Zip\7z.exe"      -> bin/7z.exe
//      - "C:\Program Files\7-Zip\7z.sfx"      -> bin/7z.sfx
//
// Run with: npm run dist-installer  (depois de `npm run dist`)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const distApp = path.join(root, 'dist', 'Engine Wallpaper');
const sevenZipExe = path.join(root, 'bin', '7z.exe');
const sevenZipSfx = path.join(root, 'bin', '7z.sfx');
const outDir = path.join(root, 'dist');
const archivePath = path.join(outDir, '_ew-installer-payload.7z');
const configPath = path.join(outDir, '_ew-installer-config.txt');
const outExe = path.join(outDir, 'Engine Wallpaper Setup.exe');

if (!fs.existsSync(distApp)) {
  console.error('dist/Engine Wallpaper/ não existe — rode "npm run dist" primeiro.');
  process.exit(1);
}

if (!fs.existsSync(sevenZipExe) || !fs.existsSync(sevenZipSfx)) {
  console.warn('7z.exe / 7z.sfx não encontrados em bin/ — pulando build do instalador.');
  console.warn('Veja as instruções no topo deste arquivo (scripts/build-installer.js) pra baixar o 7-Zip.');
  process.exit(0);
}

console.log('Compactando dist/Engine Wallpaper/ ...');
if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
execFileSync(sevenZipExe, ['a', '-t7z', '-mx=5', archivePath, path.join(distApp, '*')], { stdio: 'inherit' });

// Config do módulo SFX do 7-Zip. RunProgram roda relativo à pasta onde foi
// extraído (o próprio "Engine Wallpaper.exe", copiado da raiz do payload).
// NÃO verificado ao vivo ainda (precisa de 7-Zip instalado, que não está
// disponível neste ambiente) — na primeira vez que gerar o instalador,
// confira se ele realmente extrai silencioso e roda o programa sozinho;
// se aparecer alguma janela nativa do 7-Zip pedindo confirmação, essa
// config provavelmente precisa de ajuste (ver docs do 7-Zip SFX).
const sfxConfig = [
  ';!@Install@!UTF-8!',
  'Title="Engine Wallpaper"',
  'BeginPrompt=""',
  'RunProgram="Engine Wallpaper.exe"',
  ';!@InstallEnd@!',
].join('\r\n');
fs.writeFileSync(configPath, sfxConfig, 'utf8');

console.log('Montando Engine Wallpaper Setup.exe ...');
if (fs.existsSync(outExe)) fs.unlinkSync(outExe);
// Concatenação binária padrão de SFX: módulo + config + arquivo 7z.
const parts = [fs.readFileSync(sevenZipSfx), fs.readFileSync(configPath), fs.readFileSync(archivePath)];
fs.writeFileSync(outExe, Buffer.concat(parts));

fs.unlinkSync(archivePath);
fs.unlinkSync(configPath);

const sizeMB = (fs.statSync(outExe).size / 1024 / 1024).toFixed(1);
console.log(`\nDone! ${outExe} (${sizeMB} MB)`);
