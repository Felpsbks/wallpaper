// Wrapper que faz um processo WallpaperHost.exe (native/WallpaperHost/, C#
// + WebView2) se parecer, do ponto de vista do resto do main.js, com uma
// entrada normal do Map `wallpaperWindows` (BrowserWindow do Electron) —
// implementa só a fatia de API que main.js realmente usa em cima dele
// (isDestroyed/getBounds/webContents.send), suficiente pra sendToAllWallpapers
// e o loop de posição do cursor funcionarem sem precisar ramificar em cada
// call site. Chamadas que só fazem sentido pro caminho Electron (watchdog de
// WorkerW, snapshot pro wallpaper nativo) já checam `isWebView2Host` e pulam
// essas entradas — o WallpaperHost.exe cuida do próprio reencaixe atrás do
// desktop sozinho (ver DesktopEmbedder.cs).
//
// Ver plano/memória project_workerw_fragility: esse caminho existe só pro
// "Modo de compatibilidade (WebView2)" opcional nas Configurações, pra PCs
// onde o Chromium do Electron recusa GPU (disabled_software) e o wallpaper
// trava em ~1 frame a cada alguns minutos — o WebView2 não sofre desse bug
// porque nunca é reparentado via SetParent depois de já existir.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// scripts/build-dist.js publica o WallpaperHost.exe (dotnet publish) e copia
// o resultado pra dist/Engine Wallpaper/wallpaperhost/ — ao lado do próprio
// "Engine Wallpaper.exe", fora do app.asar (é um binário nativo com runtime
// próprio, não faz sentido empacotar dentro do asar). process.execPath
// resolve pro exe certo tanto em dev (bin/electron.exe) quanto no pacote
// final (Engine Wallpaper.exe) — nos dois casos o candidato "empacotado" só
// existe de verdade quando build-dist.js já rodou; em dev cai pro caminho
// direto do publish/ dentro do próprio checkout.
function getWallpaperHostExePath() {
  const packaged = path.join(path.dirname(process.execPath), 'wallpaperhost', 'WallpaperHost.exe');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'native', 'WallpaperHost', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'WallpaperHost.exe');
}

// getWallpaperMuted: função (não valor) — chamada a cada 'set-wallpaper' de
// type 'url', pra sempre pegar o estado de mudo mais atual da store. Precisa
// disso porque, nesse tipo específico, a mensagem nunca passa pela shell
// (wallpaper.js) — é interceptada e tratada 100% do lado C#, então o mudo
// tem que vir embutido nela em vez de chegar por um canal 'mute' separado.
// onFatalLine: callback opcional, chamado com o texto completo de qualquer
// linha "[fatal]" que o processo mandar (ver Program.cs/MainForm.cs's
// ReportFatalAndExit/HandleHostMessage) — main.js usa isso pra mandar um
// relatório automático pro endpoint de diagnóstico remoto (ver
// license-server/api/diag-report.js), sem depender do usuário copiar/colar
// stack trace manualmente.
function spawnWallpaperHostProcess(display, contentDir, getWallpaperMuted, onFatalLine) {
  const exePath = getWallpaperHostExePath();
  if (!fs.existsSync(exePath)) {
    console.error(`[wallpaperhost] Executável não encontrado em ${exePath} — rode "dotnet publish -c Release -r win-x64 --self-contained true" dentro de native/WallpaperHost antes de ligar o Modo de compatibilidade (WebView2).`);
    return null;
  }

  const { bounds } = display;
  const child = spawn(
    exePath,
    [contentDir, String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height)],
    { windowsHide: true }
  );

  let destroyed = false;
  child.on('exit', (code, signal) => {
    destroyed = true;
    console.log(`[wallpaperhost] processo (display ${display.id}) saiu: code=${code} signal=${signal}`);
  });
  child.on('error', (err) => {
    destroyed = true;
    console.error(`[wallpaperhost] falha ao iniciar processo (display ${display.id}): ${err.message}`);
  });

  // stdout/stderr do processo já viram log mirrorado na aba do app (console.log
  // é sobrescrito globalmente em main.js) — só precisa quebrar em linhas, já
  // que o child pode mandar vários prints por chunk.
  function pipeLines(stream, isErr) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line) continue;
        (isErr ? console.error : console.log)(`[wallpaperhost] ${line}`);
        if (onFatalLine && /\[fatal\]/i.test(line)) {
          try { onFatalLine(line); } catch {}
        }
      }
    });
  }
  pipeLines(child.stdout, false);
  pipeLines(child.stderr, true);

  return {
    isWebView2Host: true,
    displayId: display.id,
    get pid() { return child.pid; },
    isDestroyed() { return destroyed; },
    getBounds() { return { ...bounds }; },
    webContents: {
      send(channel, ...args) {
        if (destroyed || !child.stdin.writable) return;
        let data = args[0];
        // type:'url' (YouTube ao vivo) é interceptado inteiramente do lado
        // C# — nunca chega na shell/wallpaper.js, então o mudo tem que ir
        // embutido aqui em vez de depender de um 'mute'/'unmute' separado.
        if (channel === 'set-wallpaper' && data && data.type === 'url') {
          data = { ...data, muted: !!getWallpaperMuted() };
        }
        try {
          child.stdin.write(JSON.stringify({ channel, data }) + '\n');
        } catch (err) {
          console.error(`[wallpaperhost] falha ao mandar mensagem (${channel}): ${err.message}`);
        }
      },
    },
    kill() {
      if (destroyed) return;
      try { child.kill(); } catch {}
    },
  };
}

module.exports = { spawnWallpaperHostProcess, getWallpaperHostExePath };
