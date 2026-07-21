// Baixa um vídeo do YouTube (na melhor qualidade disponível, até 4K) e
// devolve o caminho do arquivo .mp4 final, pra virar um wallpaper de vídeo
// comum — pedido do usuário: NÃO quer o player do YouTube tocando ao vivo
// dentro do app (isso já existia via wallpaper "web"), quer o arquivo
// baixado de verdade, em alta qualidade, e aplicado como qualquer outro
// vídeo da biblioteca.
//
// Usa yt-dlp (sucessor ativo do youtube-dl — reimplementar a extração do
// YouTube por conta própria quebraria a cada mudança deles) + ffmpeg (só o
// yt-dlp precisa pra juntar vídeo+áudio — acima de 720p o YouTube quase
// sempre serve vídeo e áudio em streams separados, então merge é a regra,
// não exceção, pra qualquer coisa em alta qualidade). Nenhum dos dois vem
// junto com o app — são baixados na primeira vez que essa função roda e
// ficam em cache em userData/tools.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { app } = require('electron');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
// Build "latest" da BtbN (CI atualiza o asset dessa mesma tag continuamente)
// — link estável, não precisa saber a versão exata na hora de baixar.
const FFMPEG_ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

function toolsDir() {
  return path.join(app.getPath('userData'), 'tools');
}
function ytDlpPath() {
  return path.join(toolsDir(), 'yt-dlp.exe');
}
function ffmpegDir() {
  return path.join(toolsDir(), 'ffmpeg');
}

function findFileRecursive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
}

// Mesma lógica de httpDownload do main.js (redirect + progresso por bytes),
// duplicada aqui pra este módulo não depender de importar main.js.
function httpDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return httpDownload(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
      }
      const total = Number(res.headers['content-length']) || null;
      let received = 0;
      if (onProgress) {
        res.on('data', (chunk) => { received += chunk.length; onProgress(received, total); });
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function ensureYtDlp(onProgress) {
  const dest = ytDlpPath();
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(toolsDir(), { recursive: true });
  const tmp = dest + '.download';
  await httpDownload(YTDLP_URL, tmp, (received, total) => {
    if (onProgress) onProgress({ phase: 'yt-dlp', received, total });
  });
  fs.renameSync(tmp, dest);
  return dest;
}

async function ensureFfmpeg(onProgress) {
  const existing = findFileRecursive(ffmpegDir(), 'ffmpeg.exe');
  if (existing) return existing;
  fs.mkdirSync(ffmpegDir(), { recursive: true });
  const zipPath = path.join(toolsDir(), 'ffmpeg.zip');
  await httpDownload(FFMPEG_ZIP_URL, zipPath, (received, total) => {
    if (onProgress) onProgress({ phase: 'ffmpeg', received, total });
  });
  if (onProgress) onProgress({ phase: 'ffmpeg-extract' });
  const AdmZip = require('adm-zip');
  new AdmZip(zipPath).extractAllTo(ffmpegDir(), true);
  fs.unlinkSync(zipPath);
  const exe = findFileRecursive(ffmpegDir(), 'ffmpeg.exe');
  if (!exe) throw new Error('ffmpeg.exe não encontrado depois de extrair o pacote baixado.');
  return exe;
}

// outputBasePath: caminho SEM extensão — o yt-dlp escolhe/escreve a
// extensão final (forçamos mp4 via --merge-output-format, então na prática
// sempre vai ser "<outputBasePath>.mp4").
async function downloadYoutubeVideo({ url, outputBasePath, onProgress }) {
  const ytDlp = await ensureYtDlp(onProgress);
  const ffmpeg = await ensureFfmpeg(onProgress);
  const ffmpegLocation = path.dirname(ffmpeg);

  // Pedido do usuário: qualidade alta de verdade, não travado em 1080p —
  // pega a melhor combinação de vídeo+áudio disponível até 4K (a maioria
  // dos vídeos nem chega nisso, então na prática já pega o teto real de
  // cada um). O app já toca vídeo 4K sem problema (video wallpapers normais
  // já rodam nessa resolução).
  const args = [
    '-f', 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/best[height<=2160][ext=mp4]/best[height<=2160]/best',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegLocation,
    '--no-playlist',
    '--newline',
    '-o', `${outputBasePath}.%(ext)s`,
    url,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlp, args, { windowsHide: true });
    let lastErrorLine = '';

    const handleLine = (line) => {
      const dl = line.match(/\[download\]\s+([\d.]+)%/);
      if (dl) {
        if (onProgress) onProgress({ phase: 'video', pct: parseFloat(dl[1]) });
        return;
      }
      if (/\[Merger\]|Merging formats/i.test(line)) {
        if (onProgress) onProgress({ phase: 'merging' });
        return;
      }
      if (/^ERROR:/i.test(line.trim())) lastErrorLine = line.trim();
    };

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();
      lines.forEach(handleLine);
    });
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop();
      lines.forEach(handleLine);
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(lastErrorLine || `yt-dlp saiu com código ${code}`));
        return;
      }
      const finalPath = `${outputBasePath}.mp4`;
      if (!fs.existsSync(finalPath)) {
        reject(new Error('yt-dlp terminou mas o arquivo final não apareceu — o vídeo pode ser uma live, privado ou restrito por idade.'));
        return;
      }
      resolve(finalPath);
    });
  });
}

module.exports = { downloadYoutubeVideo, ensureYtDlp, ensureFfmpeg };
