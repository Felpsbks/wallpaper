const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, screen, nativeImage, desktopCapturer } = require('electron');

// ---- Trava de instância única ----
// Sem isso, cada relançamento (recarregamento automático do modo dev,
// duplo-clique sem querer, autostart + abertura manual) empilha um processo
// novo em vez de reaproveitar o que já está rodando — confirmado ao vivo:
// 7 processos "Engine Wallpaper" simultâneos no Gerenciador de Tarefas.
// Precisa vir antes de QUALQUER outra coisa, pra uma segunda instância
// desistir o mais rápido possível sem fazer nenhum trabalho à toa.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---- RAM Saver: Dieta do Chromium ----
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-spell-checking');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('disable-pdf-extension');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-metrics');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');

// The wallpaper window is *always* occluded from the OS's point of view — it
// permanently sits behind the desktop icons layer by design. Chromium's
// native-window-occlusion feature uses that exact signal to throttle/suspend
// work (including video decode, not just JS timers — `backgroundThrottling:
// false` on the BrowserWindow only covers the latter) for windows it thinks
// are hidden, to save power. Suspected cause of large/high-bitrate video
// wallpapers (4K60 50Mbps+) never producing a visible frame while lighter
// ones play fine — same root cause class as the equivalent WebView2 fix
// found during the (rolled-back) migration attempt, see
// project_webview2_migration memory.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Without this, Windows identifies the process by its exe's own identity
// (still literally called "electron.exe" in dev/autostart — see
// project_electron_binary memory) for taskbar grouping/jump lists/toast
// notifications, which is part of why the taskbar icon showed Electron's
// logo instead of ours after an autostart reboot.
if (process.platform === 'win32') app.setAppUserModelId('com.enginewallpaper.desktop');

const args = process.argv.map(a => a.toLowerCase());
const _isScreensaver = args.includes('/s') || args.includes('-s');
const _isConfigMode = args.includes('/c') || args.includes('-c');
if (args.find(a => a.startsWith('/p') || a.startsWith('-p'))) {
  app.exit(0); // Preview mode not supported yet due to HWND complexity
}

// Dev sempre roda o binário com o nome original "electron.exe" (bin/, via
// npm start/run pack/run dev). scripts/build-dist.js só renomeia pra
// "Engine Wallpaper.exe" na hora de gerar o pacote final pro usuário. Usa
// esse nome como o sinal "isto é uma build pra usuário final?", sem precisar
// de nenhuma flag/config nova pra alternar manualmente.
const _isEndUserBuild = require('path').basename(process.execPath).toLowerCase() !== 'electron.exe';
// electron-reload REMOVIDO: scripts/dev.js já tem seu próprio watcher
// completo (mata o processo antigo -> reempacota o ASAR -> sobe um processo
// novo) — ter os dois ativos ao mesmo tempo fazia cada salvamento de arquivo
// disparar DOIS relançamentos descoordenados brigando entre si (a causa real
// dos processos "zumbis"/janelas duplicadas). Além disso o electron-reload
// sozinho nunca ajudava de verdade aqui: ele só faz app.relaunch() sem
// reempacotar o ASAR, e este binário só carrega direito a partir do ASAR já
// empacotado (ver project_electron_binary) — então relançar sem reempacotar
// nem pegava as mudanças salvas.
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { execSync, exec, spawn } = require('child_process');
const Store      = require('./src/store');
const License    = require('./src/license');
const RoutineEngine = require('./src/routines/engine');
const routinesMigrate = require('./src/routines/migrate');
const TRIGGERS = require('./src/routines');
const { getRunningProcesses } = require('./src/routines/_processMatch');
const { reconcilePlaybackControls, appRulesNeedProcesses, setAppStatePause } = require('./src/playback-rules');

// Nudge the OS scheduler to favor this process over other startup apps
// competing for CPU/disk right after login — part of "start fast like
// Discord" (see project_packaging_requirements memory). Fired here, as early
// as the process exists, and asynchronously so it never blocks our own boot
// (a synchronous PowerShell spawn would defeat the purpose).
if (process.platform === 'win32') {
  exec(`powershell -NoProfile -WindowStyle Hidden -Command "(Get-Process -Id ${process.pid}).PriorityClass = 'AboveNormal'"`, { windowsHide: true }, () => {});
}

let controlWin = null;
let tray       = null;
const store    = new Store();
let _pendingWorkshopId = null;

// ---- Log de boot persistente em arquivo ----
// Investigando um travamento real relatado só logo após reiniciar o Windows
// (app abre mas fica transparente/sem responder, "não reproduz") — mas
// funciona normal quando reaberto manualmente depois. Como o problema é
// especificamente na janela de controle, o próprio mecanismo de log que
// espelha console.log pra dentro da UI (`_sendToUiLog` acima) é inútil pra
// diagnosticar isso: exige uma janela de controle funcionando, que é
// exatamente o que está travado. Grava em arquivo à parte, sobrescrito a
// cada boot (só precisa do ÚLTIMO boot, não histórico), com timestamp
// relativo em ms desde o início do processo — próxima vez que travar, dá pra
// ler o arquivo e ver exatamente em qual etapa parou, em vez de adivinhar.
const _bootStart = Date.now();
let _bootLogPath = null;
try {
  _bootLogPath = path.join(app.getPath('userData'), 'boot-log.txt');
  fs.writeFileSync(_bootLogPath, `boot iniciado ${new Date().toISOString()}\n`);
} catch (_) { _bootLogPath = null; }
function _bootLog(msg) {
  if (!_bootLogPath) return;
  try { fs.appendFileSync(_bootLogPath, `+${Date.now() - _bootStart}ms  ${msg}\n`); } catch (_) {}
}
_bootLog('process principal iniciado (topo do main.js)');

// Diagnóstico direto de um travamento real (confirmado 2026-07-20 via
// heartbeat contínuo do renderer — ver ctrlLog em ui/app.js — o JS da janela
// de controle NUNCA para de rodar, mas a tela congela e para de responder a
// clique nenhum): se o JS está provadamente vivo mas nada pinta/responde na
// tela, o processo de GPU compartilhado (não o processo do renderer em si)
// é o suspeito mais provável — os três eventos abaixo cobrem as diferentes
// APIs do Electron pra isso (v18 aqui: 'render-process-gone' é o atual,
// 'gpu-process-crashed'/'child-process-gone' cobrem variações mais antigas/
// novas, registrar todos não faz mal nenhum se algum não existir nesta
// versão). Registrado cedo, antes de qualquer BrowserWindow existir, pra não
// perder um crash que aconteça logo no boot.
app.on('render-process-gone', (_event, webContents, details) => {
  _bootLog(`app: render-process-gone (global) reason=${details.reason} exitCode=${details.exitCode}`);
});
if (typeof app.on === 'function') {
  try {
    app.on('gpu-process-crashed', (_event, killed) => _bootLog(`app: gpu-process-crashed killed=${killed}`));
  } catch (_) {}
  try {
    app.on('child-process-gone', (_event, details) => _bootLog(`app: child-process-gone type=${details.type} reason=${details.reason}`));
  } catch (_) {}
}


// Mirror ALL console output (from main.js and every required module, e.g.
// src/workerw.js's diagnostic logs) into the app's own "Terminal Logs" panel
// — `console` is a shared global, so overriding it here catches everything,
// not just calls made directly in this file. Lets the user read logs from
// inside the app itself instead of needing a separate terminal window open.
const _origConsoleLog   = console.log.bind(console);
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn  = console.warn.bind(console);

function _nowTs() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function _sendToUiLog(ts, msg, level) {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('app-log', { ts, msg, level });
  }
}

// JSON.stringify sozinho já rejeita referência circular direta (throw), mas
// não protege contra objetos MUITO profundos/grandes (ex: um Error com stack
// gigante, ou um objeto que referencia outro que referencia o primeiro
// indiretamente) — isso pode estourar a pilha de verdade dentro do próprio
// JSON.stringify/util.inspect do Node, derrubando o processo principal
// inteiro (aconteceu de verdade: RangeError dentro do console.error nativo,
// ao tentar formatar algo assim). O replacer com WeakSet guarda contra ciclo
// indireto, e o try/catch é a rede de segurança final — logar nunca pode
// crashar o app.
function _safeStringify(value) {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
    if (json && json.length > 4000) return json.slice(0, 4000) + '…(truncado)';
    return json;
  } catch (err) {
    return `[não foi possível formatar: ${err.message}]`;
  }
}

function _fmtArgs(args) {
  return args.map(a => (typeof a === 'string' ? a : _safeStringify(a))).join(' ');
}

function _wrapConsole(orig, level) {
  return (...args) => {
    try { orig(...args); } catch (_) { /* nunca deixa o log nativo derrubar o processo */ }
    try { _sendToUiLog(_nowTs(), _fmtArgs(args), level); } catch (_) { /* idem pro espelho na UI */ }
  };
}

console.log = _wrapConsole(_origConsoleLog, 'info');
console.error = _wrapConsole(_origConsoleError, 'error');
console.warn = _wrapConsole(_origConsoleWarn, 'warn');

function appLog(msg, level = 'info') {
  const ts = _nowTs();
  _origConsoleLog(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  _sendToUiLog(ts, msg, level);
}
appLog.ok    = (msg) => appLog(msg, 'success');
appLog.warn  = (msg) => appLog(msg, 'warn');
appLog.err   = (msg) => appLog(msg, 'error');
appLog.debug = (msg) => appLog(msg, 'debug');

const routineEngine = new RoutineEngine(store, (...args) => sendToAllWallpapers(...args), () => controlWin, appLog);


// Map of displayId -> BrowserWindow (wallpaper windows)
const wallpaperWindows = new Map();

app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// ---- Wallpaper windows (one per display) ----
function createWallpaperWindows() {
  for (const display of screen.getAllDisplays()) {
    spawnWallpaperWindow(display);
  }

  screen.on('display-added', (_, display) => spawnWallpaperWindow(display));
  screen.on('display-removed', (_, display) => {
    const win = wallpaperWindows.get(display.id);
    if (win && !win.isDestroyed()) win.destroy();
    wallpaperWindows.delete(display.id);
  });
}

function spawnWallpaperWindow(display) {
  const { bounds } = display;
  const win = new BrowserWindow({
    width: bounds.width, height: bounds.height,
    x: bounds.x, y: bounds.y,
    frame: false, transparent: true,
    resizable: false, movable: false,
    focusable: _isScreensaver, skipTaskbar: true, alwaysOnTop: _isScreensaver,
    fullscreen: _isScreensaver,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false,
      webviewTag: true, webSecurity: false,
      // This window is never focused and is always "covered" (behind icons,
      // behind every other app) from Chromium's point of view — without this,
      // it throttles/pauses timers and rendering in what it thinks is a
      // backgrounded page, which is exactly what a wallpaper window always
      // looks like to it. That's why the clock/live text can appear frozen
      // until switching windows briefly "wakes" it back up.
      backgroundThrottling: false,
    },
  });

  if (_isScreensaver) {
    win.setAlwaysOnTop(true, 'screen-saver');
  }

  win.loadFile(path.join(__dirname, 'wallpaper', 'index.html'));
  win.setIgnoreMouseEvents(!_isScreensaver);

  if (_isScreensaver) {
    win.webContents.on('before-input-event', () => app.exit(0));
    win.on('mousemove', () => app.exit(0)); // Exit on mouse move
    const uIOHook = require('uiohook-napi');
    uIOHook.uIOhook.on('mousemove', () => app.exit(0));
    uIOHook.uIOhook.on('keydown', () => app.exit(0));
    try { uIOHook.uIOhook.start(); } catch(e) {}
  }

  win.webContents.on('did-finish-load', () => {
    if (!_isScreensaver) embedWallpaperBehindDesktop(win);

    // Per-display wallpaper, fallback to global current
    const displayWallpapers = store.get('displayWallpapers') || {};
    const current = displayWallpapers[display.id] || store.get('current');
    if (current) win.webContents.send('set-wallpaper', current);
  });

  // If the renderer actually crashes/gets killed (vs. just failing to load a
  // video, which fires a normal 'error' event instead), the log simply goes
  // silent otherwise — no more heartbeats, no exception, nothing. Since the
  // window stays `transparent: true` and embedded behind the desktop icons,
  // a dead renderer paints nothing, which visually looks exactly like "it
  // fell back to the plain Windows wallpaper" (you're just seeing through to
  // the real desktop background underneath our now-blank window).
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] wallpaper renderer for display ${display.id} is gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  win.webContents.on('unresponsive', () => {
    console.error(`[main] wallpaper renderer for display ${display.id} became unresponsive`);
  });

  wallpaperWindows.set(display.id, win);
}

function sendToAllWallpapers(channel, ...args) {
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
  if (channel === 'set-wallpaper' && args[0]) updateNativeWallpaperSnapshot(args[0]);
}

// ---- Posição real do cursor (pra efeitos interativos: xray, depthparallax) ----
// A janela de wallpaper é sempre "ignoreMouseEvents" (click-through, ver
// spawnWallpaperWindow), então o DOM dela nunca recebe mousemove de
// verdade — a única forma de saber onde o cursor real está é perguntar pro
// SO diretamente (screen.getCursorScreenPoint(), que funciona independente
// de foco/click-through) e distribuir isso por IPC. Manda coordenada
// normalizada (0-1) relativa aos limites de CADA janela de wallpaper (cada
// monitor tem sua própria janela cobrindo a tela inteira dele).
setInterval(() => {
  if (wallpaperWindows.size === 0) return;
  const pt = screen.getCursorScreenPoint();
  for (const win of wallpaperWindows.values()) {
    if (win.isDestroyed()) continue;
    const b = win.getBounds();
    const x = (pt.x - b.x) / b.width;
    const y = (pt.y - b.y) / b.height;
    win.webContents.send('cursor-position', { x, y, inBounds: x >= 0 && x <= 1 && y >= 0 && y <= 1 });
  }
}, 33);

// Cliques reais no wallpaper — mesma razão do polling de posição acima
// (janela sempre click-through, `ignoreMouseEvents`, nunca recebe um
// mousedown de verdade do próprio Chromium). uiohook-napi já é dependência
// do projeto (usada no fluxo do screensaver) — aqui liga um hook global
// leve, sempre ativo enquanto existir pelo menos uma janela de wallpaper,
// só pra destravar os scripts reais de cursor (cursorDown/cursorClick) da
// Wallpaper Engine em objetos "solid" (ex.: botões de play/pause/skip do
// media player). Broadcast pro mesmo formato normalizado do cursor-position.
let _uiohookStarted = false;
function ensureClickBroadcast() {
  if (_uiohookStarted) return;
  _uiohookStarted = true;
  try {
    const { uIOhook } = require('uiohook-napi');
    const broadcastButtonState = (down) => {
      if (wallpaperWindows.size === 0) return;
      for (const win of wallpaperWindows.values()) {
        if (!win.isDestroyed()) win.webContents.send('cursor-button', { down });
      }
    };
    uIOhook.on('mousedown', (e) => {
      if (e.button !== 1) return; // só botão esquerdo — mesma convenção da WE (CursorEvent.button sempre 0/esquerdo)
      broadcastButtonState(true); // real: input.cursorLeftDown
      if (wallpaperWindows.size === 0) return;
      for (const win of wallpaperWindows.values()) {
        if (win.isDestroyed()) continue;
        const b = win.getBounds();
        const x = (e.x - b.x) / b.width;
        const y = (e.y - b.y) / b.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) continue;
        win.webContents.send('cursor-click', { x, y });
      }
    });
    uIOhook.on('mouseup', (e) => {
      if (e.button === 1) broadcastButtonState(false);
    });
    uIOhook.start();
  } catch (err) {
    console.warn('[main] uiohook indisponível — cursorDown/cursorClick dos scripts reais da WE não vão funcionar:', err.message);
  }
}
// Chamada real fica lá embaixo, dentro de app.whenReady().then(...), depois
// de createWallpaperWindows() — ver comentário lá pra saber por quê.

// ---- Integração real de media (Now Playing do Windows) ----
// Confirmado ao vivo 2026-07-18 contra uma aba real do YouTube tocando no
// Chrome: a API GlobalSystemMediaTransportControlsSessionManager (a mesma
// que alimenta o flyout de volume/tela de bloqueio do Windows) devolve
// título/artista/status de reprodução reais de QUALQUER app que reporte
// "Now Playing" pro sistema — Spotify, Chrome/YouTube, VLC, etc. Não existe
// binding Node/Electron direto pra essa API WinRT; a única forma viável
// encontrada foi via PowerShell (reflection real pra "esperar" as
// IAsyncOperation do WinRT, que o PowerShell não sabe await nativamente —
// ver scripts/media-session-poll.ps1). Roda como processo PERSISTENTE (um
// só PowerShell, iniciado uma vez), lendo o stdout linha a linha — cada
// linha é um JSON só quando o estado muda de verdade, não um poll bruto a
// cada segundo.
//
// Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlayback
// Status é um enum DIFERENTE do MediaPlaybackEvent real da própria WE
// (Closed=0/Opened=1/Changing=2/Stopped=3/Playing=4/Paused=5 vs
// STOPPED=0/PLAYING=1/PAUSED=2) — convertido aqui antes de mandar pro
// renderer, pra bater exato com o que os scripts reais esperam.
function mapPlaybackStatus(winStatus) {
  if (winStatus === 4) return 1; // Playing -> PLAYBACK_PLAYING
  if (winStatus === 5) return 2; // Paused  -> PLAYBACK_PAUSED
  return 0; // Closed/Opened/Changing/Stopped -> PLAYBACK_STOPPED
}

let _mediaSessionProc = null;
function ensureMediaSessionPoll() {
  if (_mediaSessionProc) return;
  const psScript = path.join(__dirname, 'scripts', 'media-session-poll.ps1');
  if (!fs.existsSync(psScript)) return;
  try {
    _mediaSessionProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    _mediaSessionProc.stdout.setEncoding('utf8');
    _mediaSessionProc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const data = JSON.parse(line);
          const payload = data.hasSession
            ? { hasSession: true, title: data.title, artist: data.artist, albumTitle: data.albumTitle, playbackStatus: mapPlaybackStatus(data.playbackStatus) }
            : { hasSession: false };
          for (const win of wallpaperWindows.values()) {
            if (!win.isDestroyed()) win.webContents.send('media-session-update', payload);
          }
        } catch (err) {
          appLog.warn(`media-session-poll: linha não é JSON válido: ${err.message}`);
        }
      }
    });
    _mediaSessionProc.on('exit', (code) => {
      appLog.warn(`media-session-poll.ps1 saiu (code ${code}) — integração de mídia parada até o app reiniciar.`);
      _mediaSessionProc = null;
    });
  } catch (err) {
    console.warn('[main] Falha ao iniciar integração de media session:', err.message);
  }
}
// Chamada real fica lá embaixo, dentro de app.whenReady().then(...), depois
// de createWallpaperWindows() — ver comentário lá pra saber por quê.

// O Windows desenha o efeito de vidro fosco (Mica/Acrylic) atrás da barra de
// tarefas olhando pro wallpaper REAL registrado no sistema — não pro que
// aparece na tela (nossa janela embutida via WorkerW nunca atualiza isso).
// Aqui a gente mantém o wallpaper nativo em sincronia como um "retrato" do
// que está sendo exibido, só pra a barra de tarefas ter algo de verdade pra
// borrar (não vai animar ali, é só uma foto — limitação do próprio Windows,
// que só suporta uma imagem estática via SystemParametersInfo).
//
// SystemParametersInfo força o Windows a redesenhar o wallpaper de verdade,
// o que pisca visivelmente na área de trabalho — por isso o throttle abaixo:
// numa playlist com Intervalo curto (ex: a cada 10s) não queremos piscar a
// cada troca, só de vez em quando é suficiente pra barra de tarefas não ficar
// muito desatualizada.
let _lastNativeWallpaperUpdateAt = 0;
const NATIVE_WALLPAPER_MIN_INTERVAL_MS = 60000;

// Sem isso, a "foto" da barra de tarefas só atualiza quando o wallpaper
// TROCA — enquanto o mesmo vídeo/cena continua tocando por horas, ela fica
// congelada no primeiro frame. Refresca sozinha no mesmo ritmo do throttle,
// pra acompanhar minimamente o que está passando (nunca vai ser ao vivo de
// verdade — o Windows só aceita imagem estática aqui — mas fica bem mais
// perto do que a Live Wallpaper faz do que uma foto única parada).
function startNativeWallpaperRefresh() {
  setInterval(() => {
    const current = store.get('current');
    // Imagem estática nunca muda de conteúdo — recapturar/reaplicar a cada
    // ciclo só arriscaria piscar a tela à toa, sem nenhum ganho real.
    if (current && current.type !== 'image') updateNativeWallpaperSnapshot(current);
  }, NATIVE_WALLPAPER_MIN_INTERVAL_MS);
}

function updateNativeWallpaperSnapshot(wallpaper) {
  if (!wallpaper) return;
  const now = Date.now();
  if (now - _lastNativeWallpaperUpdateAt < NATIVE_WALLPAPER_MIN_INTERVAL_MS) return;
  _lastNativeWallpaperUpdateAt = now;

  const { setNativeWallpaper } = require('./src/workerw');

  if (wallpaper.type === 'image' && wallpaper.src && fs.existsSync(wallpaper.src)) {
    setNativeWallpaper(wallpaper.src);
    return;
  }

  // Vídeo/cena/web: não existe um arquivo estático pra apontar, então
  // tiramos um "print" de verdade da janela do wallpaper. O delay dá tempo
  // do conteúdo novo (vídeo/cena) carregar antes da captura.
  setTimeout(async () => {
    try {
      const win = [...wallpaperWindows.values()].find(w => !w.isDestroyed());
      if (!win) return;
      const image = await win.webContents.capturePage();
      const dir = path.join(app.getPath('userData'), 'native-wallpaper-snapshot');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const snapPath = path.join(dir, 'snapshot.png');
      fs.writeFileSync(snapPath, image.toPNG());
      setNativeWallpaper(snapPath);
    } catch (err) {
      console.error('[main] Falha ao gerar retrato pro wallpaper nativo:', err.message);
    }
  }, 1200);
}

// ---- Control panel ----
// Blocks boot until a valid license key is entered. Resolves true once
// activation succeeds, false if the user closes the window without activating.
function showActivationWindow() {
  return new Promise((resolve) => {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const win = new BrowserWindow({
      width: 380, height: 320,
      resizable: false, frame: false,
      backgroundColor: '#0b0d14',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.loadFile(path.join(__dirname, 'ui', 'activation.html'));

    let settled = false;
    ipcMain.handle('license-activate', async (_event, key) => {
      const result = await License.activate(store, key);
      if (result.ok) {
        settled = true;
        ipcMain.removeHandler('license-activate');
        if (!win.isDestroyed()) win.close();
        resolve(true);
      }
      return result;
    });

    win.on('closed', () => {
      ipcMain.removeHandler('license-activate');
      if (!settled) resolve(false);
    });
  });
}

function createControlWindow() {
  _bootLog('createControlWindow: início');
  const iconPath = path.join(__dirname, 'ui', 'logo-app-max.png');
  controlWin = new BrowserWindow({
    width: 980, height: 680,
    resizable: false, maximizable: false, fullscreenable: false,
    frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#0d0d0d',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true },
  });
  _bootLog('createControlWindow: BrowserWindow criado, chamando loadFile');

  controlWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Diagnóstico do travamento real relatado logo após reiniciar o Windows
  // (janela abre mas fica transparente/sem responder) — funcionava normal ao
  // reabrir manualmente depois, então é uma condição de corrida específica
  // do boot, não um bug fixo de código. Esses eventos revelam ONDE
  // exatamente o carregamento trava na próxima vez que acontecer, em vez de
  // adivinhar de novo (ver _bootLog acima).
  controlWin.once('ready-to-show', () => { _bootLog('controlWin: ready-to-show'); controlWin.show(); });
  controlWin.webContents.once('did-finish-load', () => _bootLog('controlWin: did-finish-load'));
  controlWin.webContents.once('dom-ready', () => _bootLog('controlWin: dom-ready'));
  controlWin.webContents.on('did-fail-load', (_e, code, desc) => _bootLog(`controlWin: did-fail-load code=${code} desc=${desc}`));
  controlWin.webContents.on('render-process-gone', (_e, details) => _bootLog(`controlWin: render-process-gone reason=${details.reason}`));
  controlWin.webContents.on('unresponsive', () => _bootLog('controlWin: unresponsive (renderer travado)'));
  controlWin.webContents.on('responsive', () => _bootLog('controlWin: responsive de novo'));
  controlWin.on('closed', () => { controlWin = null; });

  controlWin.webContents.session.on('will-download', (_, item) => {
    const fname = item.getFilename();
    if (!fname.endsWith('.zip') && !item.getMimeType().includes('zip')) return;

    const wsId = _pendingWorkshopId || Date.now().toString();
    _pendingWorkshopId = null;

    const dlPath    = path.join(app.getPath('userData'), 'downloads', wsId + '.zip');
    const extractDir = path.join(app.getPath('userData'), 'wallpapers', wsId);
    fs.mkdirSync(path.dirname(dlPath), { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    item.setSavePath(dlPath);

    item.on('updated', (_, state) => {
      if (state === 'progressing' && !item.isPaused()) {
        const total = item.getTotalBytes();
        if (controlWin && !controlWin.isDestroyed()) {
          controlWin.webContents.send('download-progress', { state: 'progress', pct: total > 0 ? item.getReceivedBytes() / total : 0 });
        }
      }
    });

    item.once('done', (_, state) => {
      if (state !== 'completed') {
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: 'Download cancelado ou falhou.' });
        return;
      }
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(dlPath);
        zip.extractAllTo(extractDir, true);
        try { fs.unlinkSync(dlPath); } catch {}

        let wpItem = parseSingleWorkshopItem(extractDir, wsId);
        if (!wpItem) {
          const sub = fs.readdirSync(extractDir).filter(f => fs.statSync(path.join(extractDir, f)).isDirectory());
          if (sub.length > 0) wpItem = parseSingleWorkshopItem(path.join(extractDir, sub[0]), wsId);
        }
        if (wpItem) {
          const library = store.get('library') || [];
          wpItem.id = Date.now().toString();
          library.push(wpItem);
          store.set('library', library);
          if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'completed', wallpaper: wpItem });
        } else {
          if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: 'Formato inválido no ZIP baixado.' });
        }
      } catch (err) {
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: err.message });
      }
    });
  });
}

// ---- Detecção de outros gerenciadores de wallpaper concorrentes ----
// Incidente real (2026-07-20): o usuário tinha o Lively Wallpaper instalado
// (ver project_workerw_fragility memory) e, após reiniciar o PC, os dois
// apps competiram pela MESMA área do desktop (o truque Progman/WorkerW não é
// exclusivo nosso — Lively, Wallpaper Engine oficial etc. usam a mesma
// técnica não-documentada do Windows). Resultado: a janela de controle deste
// app ficava visível e com o JS rodando perfeitamente (confirmado via
// heartbeat contínuo em boot-log.txt), mas completamente surda a
// clique/teclado — sintoma indistinguível de um travamento real, só que a
// causa era outro processo brigando pelo mesmo SetParent/WorkerW, não um bug
// de código. Não dá pra "resolver" essa disputa de verdade (nenhum dos dois
// apps sabe do outro por design), então a proteção possível é AVISAR cedo, em
// vez de deixar o usuário achar que este app quebrou.
const KNOWN_CONFLICTING_WALLPAPER_APPS = [
  { match: /lively/i, label: 'Lively Wallpaper' },
  { match: /wallpaper(32|64)\.exe/i, label: 'Wallpaper Engine' },
  { match: /wallpaperservice(32|64)\.exe/i, label: 'Wallpaper Engine (serviço)' },
];

// Guarda o resultado da última checagem pra `should-show-wallpaper-conflict-
// notice` (chamado pelo renderer só depois que o usuário fecha o aviso de
// primeira execução) — em vez de um dialog.showMessageBox nativo (destoa do
// resto da UI própria do app, e não tem como lembrar "não mostrar de novo"
// sozinho), o aviso agora é um modal normal do app, com o mesmo checkbox de
// opt-out já usado no aviso de cenas do Workshop.
let _detectedWallpaperConflict = null;

function checkConflictingWallpaperApps() {
  if (process.platform !== 'win32') return;
  // `tasklist` é nativo do Windows, sem dependência nova — roda em background
  // (exec, não execSync) pra nunca atrasar createWallpaperWindows().
  exec('tasklist', { windowsHide: true }, (err, stdout) => {
    if (err || !stdout) return;
    const lines = stdout.split('\n');
    const found = new Set();
    for (const line of lines) {
      for (const conflictApp of KNOWN_CONFLICTING_WALLPAPER_APPS) {
        if (conflictApp.match.test(line)) found.add(conflictApp.label);
      }
    }
    if (found.size === 0) return;

    _detectedWallpaperConflict = [...found].join(', ');
    appLog.warn(`Detectado outro gerenciador de wallpaper rodando (${_detectedWallpaperConflict}) — pode causar conflito na área de trabalho (os dois tentam controlar o mesmo espaço atrás dos ícones), deixando este app com aparência de travado mesmo funcionando por dentro.`);
  });
}

ipcMain.handle('should-show-wallpaper-conflict-notice', () => {
  if (!_detectedWallpaperConflict) return null;
  if (store.get('wallpaperConflictNoticeOptOut')) return null;
  return _detectedWallpaperConflict;
});
ipcMain.handle('set-wallpaper-conflict-notice-optout', () => { store.set('wallpaperConflictNoticeOptOut', true); return true; });

// ---- Win32 WorkerW embedding ----
function embedWallpaperBehindDesktop(win) {
  if (process.platform !== 'win32') return;
  try {
    const { embedBehindDesktop } = require('./src/workerw');
    const hwnd = win.getNativeWindowHandle();
    // getBounds() still reflects this window's intended screen position/size
    // even after native reparenting (Electron's own model doesn't know we
    // called SetParent behind its back) — pass it through so workerw.js can
    // re-assert the correct position relative to WorkerW's coordinate space.
    if (!embedBehindDesktop(hwnd, win.getBounds())) console.warn('[main] WorkerW embedding failed');
  } catch (err) {
    console.error('[main] WorkerW error:', err.message);
  }
}

// Win+D ("show desktop") minimizes every top-level window it can find —
// our wallpaper window is still technically top-level to Windows even after
// SetParent-ing it under WorkerW, so it gets minimized too. Re-embedding
// alone doesn't fix that: a minimized window stays invisible regardless of
// who its parent is. Also covers the related case where Explorer recreates
// WorkerW itself and orphans the SetParent relationship.
//
// isEmbeddedCorrectly() is checked first every tick so we only actually call
// SetParent/SetWindowPos when something is really wrong — running those
// unconditionally every second (previous behavior) was itself causing
// periodic visible flicker, since reparenting forces a repaint even when the
// window was already exactly where it needed to be.
function startWorkerWWatchdog() {
  const { isEmbeddedCorrectly } = require('./src/workerw');
  setInterval(() => {
    for (const win of wallpaperWindows.values()) {
      if (win.isDestroyed()) continue;
      const hwnd = win.getNativeWindowHandle();

      if (win.isMinimized()) { win.restore(); console.log('[watchdog] wallpaper window was minimized — restored'); }
      if (!win.isVisible())  { win.showInactive(); console.log('[watchdog] wallpaper window was hidden — shown'); }

      if (isEmbeddedCorrectly(hwnd)) continue; // already correct, skip to avoid flicker

      console.log('[watchdog] wallpaper window not correctly embedded — re-attaching');
      embedWallpaperBehindDesktop(win);
    }
  }, 1000);
}

// Tried two nudge strategies here (resize +1px, then hide()+showInactive())
// to work around the wallpaper going visually stale when embedded as a
// WS_CHILD under Progman. Neither actually fixed it, and hide()+show caused
// a visible flicker of its own — worse than the problem. Removed pending a
// real fix; see project_workerw_fragility.md memory for the current theory
// (Electron's Chromium top-level window may not tolerate being forced into
// a foreign process's window tree the way a plain native window hosting a
// WebView2 *child control* — what Lively actually does — would).
function startRepaintNudge() {
  // intentionally a no-op for now
}

// ---- Autostart (Startup-folder .lnk, not the Registry Run key) ----
// The Registry Run-key mechanism (Electron's own `setLoginItemSettings`) has
// no "start in" concept — it launches bin\electron.exe with no working
// directory, and this build's Electron only registers its built-ins when
// launched from the packed ASAR relative to the repo root (see
// project_electron_binary memory), which is why a real reboot showed
// Electron's own default demo screen instead of the app. A .lnk shortcut in
// the Startup folder has an explicit WorkingDirectory field, matching what
// `scripts/dev.js` already does via `spawn(electronExe, [], { cwd: root })`.
// See project_autostart_bug memory for the full investigation history.
function setAutostart(enabled) {
  if (process.platform !== 'win32') return;

  const exePath = process.execPath;
  const workDir = path.dirname(path.dirname(exePath)); // .../bin/electron.exe -> repo root
  const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const lnkPath = path.join(startupDir, 'EngineWallpaper.lnk');

  const exists = fs.existsSync(lnkPath);
  if (enabled === exists) return; // already in the desired state — skip the slow PowerShell spawn

  // Always clear the old Run-key entry (harmless if it was never set) so the
  // two mechanisms can never coexist and double-launch the app.
  try { app.setLoginItemSettings({ openAtLogin: false, path: exePath }); } catch {}

  if (!enabled) {
    try { fs.unlinkSync(lnkPath); } catch {}
    return;
  }

  const psPath = path.join(os.tmpdir(), 'ew-mkshortcut.ps1');
  const ps = [
    '$s = New-Object -ComObject WScript.Shell',
    `$sc = $s.CreateShortcut("${lnkPath}")`,
    `$sc.TargetPath = "${exePath}"`,
    `$sc.WorkingDirectory = "${workDir}"`,
    '$sc.Save()',
  ].join('\r\n');

  try {
    fs.mkdirSync(startupDir, { recursive: true });
    fs.writeFileSync(psPath, ps, 'utf8');
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, { windowsHide: true });
    appLog.ok('Atalho de inicialização criado em ' + lnkPath);
  } catch (err) {
    appLog.err('Erro criando atalho de inicialização: ' + err.message);
  } finally {
    try { fs.unlinkSync(psPath); } catch {}
  }
}

// ---- System tray ----
function createTray() {
  const iconPath = path.join(__dirname, 'ui', 'logo-tray.png');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('Engine Wallpaper');

  const menu = Menu.buildFromTemplate([
    { label: 'Abrir painel',       click: () => { 
        if (!controlWin || controlWin.isDestroyed()) createControlWindow();
        else { controlWin.show(); controlWin.focus(); }
      } 
    },
    { type: 'separator' },
    { label: 'Próximo wallpaper',  click: () => {
        const library = store.get('library') || [];
        if (!library.length) return;
        const current = store.get('current');
        const idx = current ? library.findIndex(w => w.id === current.id) : -1;
        const next = library[(idx + 1) % library.length];
        store.set('current', next);
        sendToAllWallpapers('set-wallpaper', next);
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('wallpaper-changed', next);
      } },
    { label: 'Pausar',             click: () => sendToAllWallpapers('pause') },
    { type: 'separator' },
    { label: 'Sair',               click: () => app.exit(0) },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (!controlWin || controlWin.isDestroyed()) {
      createControlWindow();
    } else {
      controlWin.show();
      controlWin.focus();
    }
  });
}

// ---- Motor de automação (Playlists + Rotinas + pausa/muta/stop) ----
// Um único setInterval substitui os antigos startFullscreenMonitor (3s),
// startTimeRulesMonitor (60s) e o timer interno do extinto src/playlist.js.
// _manualPause continua aqui (é o botão de play/pause do painel, não uma
// rotina) — o resto (App Rules/fullscreen) mora em src/playback-rules.js e
// a arbitração de playlists em src/routines/engine.js (routineEngine).
let _manualPause = false;
let _engineTimer = null;
let _procCache = null; // { at, list } — evita rodar `tasklist` mais rápido que o antigo intervalo de 3s

ipcMain.handle('toggle-playback', () => {
  _manualPause = !_manualPause;
  sendToAllWallpapers(_manualPause ? 'pause' : 'resume');
  setAppStatePause(_manualPause);
  return { paused: _manualPause };
});

async function buildEngineContext(restrictedMode) {
  const now = new Date();
  const context = {
    now,
    hhmm: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    dayOfWeek: now.getDay(),
    month: now.getMonth(),
    runningProcesses: null,
    restrictedMode: !!restrictedMode,
  };
  if (restrictedMode) return context;

  const routines = store.get('routines') || [];
  const needsProcesses = appRulesNeedProcesses(store) || routines.some(r => (r.type === 'game' || r.type === 'application') && r.enabled);
  if (needsProcesses) {
    if (!_procCache || (now.getTime() - _procCache.at) > 3000) {
      _procCache = { at: now.getTime(), list: await getRunningProcesses() };
    }
    context.runningProcesses = _procCache.list;
  }
  return context;
}

function startAutomationEngine() {
  _engineTimer = setInterval(async () => {
    const restrictedMode = _isScreensaver || _isConfigMode;
    const context = await buildEngineContext(restrictedMode);
    if (!restrictedMode) reconcilePlaybackControls(store, sendToAllWallpapers, context, _manualPause);
    routineEngine.tick(context);
  }, 2000);
}

// ---- IPC Handlers ----
ipcMain.handle('get-library', () => {
  const library = store.get('library') || [];
  let updated = false;
  for (const w of library) {
    if (w.workshopId && !w.properties && w.src) {
      const parsed = parseSingleWorkshopItem(path.dirname(w.src), w.workshopId);
      if (parsed && parsed.properties) {
        w.properties = parsed.properties;
        updated = true;
      }
    }
  }
  if (updated) store.set('library', library);
  return library;
});
ipcMain.handle('get-favorites',        () => store.get('favorites') || []);
ipcMain.handle('toggle-favorite', (_, item) => {
  const favorites = store.get('favorites') || [];
  const idx = favorites.findIndex(f => f.workshopId === item.workshopId);
  let added;
  if (idx >= 0) {
    favorites.splice(idx, 1);
    added = false;
  } else {
    favorites.push(item);
    added = true;
  }
  store.set('favorites', favorites);
  return { added, favorites };
});
ipcMain.handle('get-current',          () => store.get('current') || null);
const DEFAULT_CLOCK_OVERLAY = { enabled: false, position: 'top-left', format24h: true, showSeconds: false, showDate: true, showDayName: true, color: '#ffffff', fontSize: 48 };
ipcMain.handle('get-settings',         () => store.get('settings') || { volume: 50, pauseOnFullscreen: true, performanceModeFullscreen: false, muteOnFullscreen: false, startWithWindows: true, audioReactive: false, hideTaskbarAndIcons: true, clockOverlay: DEFAULT_CLOCK_OVERLAY });
ipcMain.handle('get-displays',         () => screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, label: d.label || null })));
ipcMain.handle('get-display-wallpapers', () => store.get('displayWallpapers') || {});

// ---- Playlists + Rotinas ----
ipcMain.handle('get-playlists', () => store.get('smartPlaylists') || []);
ipcMain.handle('get-routines',  () => store.get('routines') || []);

ipcMain.handle('save-playlist', (_, playlist) => {
  const playlists = store.get('smartPlaylists') || [];
  if (playlist.id) {
    const idx = playlists.findIndex(p => p.id === playlist.id);
    if (idx !== -1) { playlists[idx] = { ...playlists[idx], ...playlist }; store.set('smartPlaylists', playlists); return playlists[idx]; }
  }
  const created = {
    id: Date.now().toString(),
    name: playlist.name || 'Nova Playlist',
    description: playlist.description || '',
    color: playlist.color || '#7c3aed',
    icon: playlist.icon || '🎵',
    wallpaperIds: playlist.wallpaperIds || [],
    createdAt: Date.now(),
    stats: { lastWallpaperId: null, lastAppliedAt: null, lastRotationAt: null, switchCount: 0, activeSinceMs: null },
  };
  playlists.push(created);
  store.set('smartPlaylists', playlists);
  return created;
});

ipcMain.handle('delete-playlist', (_, playlistId) => {
  const playlists = (store.get('smartPlaylists') || []).filter(p => p.id !== playlistId);
  const routines = (store.get('routines') || []).filter(r => r.playlistId !== playlistId);
  store.set('smartPlaylists', playlists);
  store.set('routines', routines);
  return true;
});

ipcMain.handle('duplicate-playlist', (_, playlistId) => {
  const playlists = store.get('smartPlaylists') || [];
  const original = playlists.find(p => p.id === playlistId);
  if (!original) return null;
  const copy = {
    ...original,
    id: Date.now().toString(),
    name: `${original.name} (cópia)`,
    createdAt: Date.now(),
    stats: { lastWallpaperId: null, lastAppliedAt: null, lastRotationAt: null, switchCount: 0, activeSinceMs: null },
  };
  playlists.push(copy);
  store.set('smartPlaylists', playlists);

  const routines = store.get('routines') || [];
  const copiedRoutines = routines.filter(r => r.playlistId === playlistId).map(r => ({ ...r, id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, playlistId: copy.id }));
  store.set('routines', routines.concat(copiedRoutines));
  return copy;
});

ipcMain.handle('apply-playlist-now', (_, playlistId) => routineEngine.applyPlaylistNow(playlistId));

ipcMain.handle('save-routine', (_, routine) => {
  const trigger = TRIGGERS[routine.type];
  if (trigger && trigger.validateConfig) {
    const result = trigger.validateConfig(routine.config);
    if (!result.ok) return { ok: false, msg: result.msg };
  }
  const routines = store.get('routines') || [];
  if (routine.id) {
    const idx = routines.findIndex(r => r.id === routine.id);
    if (idx !== -1) { routines[idx] = { ...routines[idx], ...routine }; store.set('routines', routines); return { ok: true, routine: routines[idx] }; }
  }
  const created = {
    id: Date.now().toString(),
    playlistId: routine.playlistId,
    type: routine.type,
    enabled: routine.enabled !== false,
    priority: routine.priority ?? (trigger ? trigger.defaultPriority : 0),
    config: routine.config || {},
  };
  routines.push(created);
  store.set('routines', routines);
  return { ok: true, routine: created };
});

ipcMain.handle('delete-routine', (_, routineId) => {
  store.set('routines', (store.get('routines') || []).filter(r => r.id !== routineId));
  return true;
});

ipcMain.handle('set-routine-enabled', (_, routineId, enabled) => {
  const routines = store.get('routines') || [];
  const idx = routines.findIndex(r => r.id === routineId);
  if (idx !== -1) { routines[idx].enabled = !!enabled; store.set('routines', routines); }
  return true;
});

ipcMain.handle('reorder-routines', (_, orderedIds) => {
  const routines = store.get('routines') || [];
  orderedIds.forEach((id, i) => {
    const idx = routines.findIndex(r => r.id === id);
    if (idx !== -1) routines[idx].priority = (orderedIds.length - i) * 10;
  });
  store.set('routines', routines);
  return true;
});

ipcMain.handle('set-wallpaper', (_, wallpaper, displayId) => {
  if (displayId) {
    const win = wallpaperWindows.get(displayId);
    if (win && !win.isDestroyed()) win.webContents.send('set-wallpaper', wallpaper);
    const dw = store.get('displayWallpapers') || {};
    dw[displayId] = wallpaper;
    store.set('displayWallpapers', dw);
    updateNativeWallpaperSnapshot(wallpaper);
  } else {
    store.set('current', wallpaper);
    sendToAllWallpapers('set-wallpaper', wallpaper);
  }
  return true;
});

ipcMain.handle('add-wallpaper', (_, wallpaper) => {
  const library = store.get('library') || [];
  wallpaper.id = Date.now().toString();
  library.push(wallpaper);
  store.set('library', library);
  return wallpaper;
});

ipcMain.handle('update-wallpaper', (_, wallpaper) => {
  const library = store.get('library') || [];
  const idx = library.findIndex(w => w.id === wallpaper.id);
  if (idx !== -1) { library[idx] = wallpaper; store.set('library', library); }
  // Re-apply if it's currently playing
  const current = store.get('current');
  if (current && current.id === wallpaper.id) {
    store.set('current', wallpaper);
    sendToAllWallpapers('set-wallpaper', wallpaper);
  }
  return wallpaper;
});

// ---- Oficina: Editor Visual de Wallpapers (V1 — imagem estática) ----
ipcMain.handle('get-editor-projects', () => store.get('editorProjects') || []);

ipcMain.handle('save-editor-project', (_, project) => {
  const projects = store.get('editorProjects') || [];
  if (project.id) {
    const idx = projects.findIndex(p => p.id === project.id);
    if (idx !== -1) { projects[idx] = { ...projects[idx], ...project }; store.set('editorProjects', projects); return projects[idx]; }
  }
  const created = { ...project, id: Date.now().toString(), createdAt: Date.now() };
  projects.push(created);
  store.set('editorProjects', projects);
  return created;
});

ipcMain.handle('export-editor-image', async (_, { dataUrl }) => {
  const dir = path.join(app.getPath('userData'), 'editor-exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}.png`);
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
});

// ---- We-scene manual layout editing ----
// Reverse-engineering WE's exact pixel formula for every scene field has no
// official spec to check against, so instead of chasing it forever the user
// can drag/scroll text objects to where they want and we persist that.
ipcMain.handle('we-scene-enter-edit', () => {
  // The control panel sits in front of the desktop — minimize it out of the
  // way so the user can actually see and drag the wallpaper's text objects.
  if (controlWin && !controlWin.isDestroyed()) controlWin.minimize();
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) {
      win.setIgnoreMouseEvents(false);
      win.webContents.send('we-scene-enter-edit');
    }
  }
});

// Shows every app launch by default (not just once ever) — the user has to
// explicitly opt out via the modal's checkbox for it to stop appearing.
ipcMain.handle('should-show-we-scene-notice', () => !store.get('weSceneNoticeOptOut'));
ipcMain.handle('set-we-scene-notice-optout', () => { store.set('weSceneNoticeOptOut', true); return true; });

ipcMain.handle('we-scene-save-overrides', (_, { wallpaperId, overrides }) => {
  const library = store.get('library') || [];
  const idx = library.findIndex(w => w.id === wallpaperId);
  if (idx !== -1) {
    library[idx].weSceneOverrides = { ...(library[idx].weSceneOverrides || {}), ...overrides };
    store.set('library', library);
    const current = store.get('current');
    if (current && current.id === wallpaperId) store.set('current', library[idx]);
  }
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(!_isScreensaver);
  }
  if (controlWin && !controlWin.isDestroyed()) { controlWin.restore(); controlWin.focus(); }
  return { ok: true };
});

ipcMain.on('update-native-prop', (_, data) => {
  sendToAllWallpapers('update-native-prop', data);
});

// Diagnostic: if this stops appearing while the wallpaper looks frozen, the
// renderer's JS itself has stopped (crash/hang/suspended process). If it
// keeps appearing on schedule while the screen still looks frozen, the JS is
// fine and it's specifically the paint/composite step that isn't refreshing
// — most likely suspect right now: WS_EX_LAYERED (added for "raised desktop"
// mode) fighting with Electron's own `transparent: true` compositing.
ipcMain.on('wallpaper-heartbeat', (_event, _info) => {
  // Silenced — was flooding the terminal every 5s. Uncomment the line below
  // if chasing the frozen-paint bug described above again.
  // console.log(`[heartbeat] wallpaper renderer alive — ${_info.display} at ${new Date(_info.ts).toLocaleTimeString('pt-BR')}`);
});

// Mesma técnica de diagnóstico do heartbeat acima, agora pra JANELA DE
// CONTROLE — investigando um travamento real relatado pelo usuário logo
// após abrir o app (modal de aviso aparece, botão fica clicável, mas depois
// disso nada mais responde a clique nenhum, nem os botões da própria
// titlebar). O boot do processo principal já é logado em _bootLog e
// terminou rápido e limpo (ver createControlWindow/did-finish-load acima) —
// o que falta é ver o que o JS do RENDERER (ui/app.js) estava fazendo no
// exato momento em que parou de responder. `_bootLog` grava em arquivo
// (não depende da própria UI travada pra ser lido depois).
ipcMain.on('control-log', (_event, msg) => _bootLog(`[renderer] ${msg}`));

// Repassa o FPS medido de verdade pelo próprio renderer do wallpaper (ver
// wallpaper.js) pro painel de controle — nenhum valor inventado aqui, só
// encaminha o que o requestAnimationFrame de lá já mediu.
ipcMain.on('wallpaper-fps', (_event, info) => {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('wallpaper-fps-update', info);
});

// CPU/RAM reais da máquina (não do processo do app sozinho) — usa só o
// módulo nativo `os`, sem dependência nova, seguindo a prioridade de
// footprint leve do projeto. CPU% precisa de duas amostras de os.cpus()
// com um intervalo entre elas (não dá pra ler "uso atual" de uma vez só).
function readCpuTimes() {
  return os.cpus().reduce((acc, core) => {
    acc.idle += core.times.idle;
    acc.total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
    return acc;
  }, { idle: 0, total: 0 });
}
let _lastCpuTimes = readCpuTimes();
function sampleSystemStats() {
  const now = readCpuTimes();
  const idleDelta = now.idle - _lastCpuTimes.idle;
  const totalDelta = now.total - _lastCpuTimes.total;
  _lastCpuTimes = now;
  const cpuPct = totalDelta > 0 ? Math.round(100 * (1 - idleDelta / totalDelta)) : 0;
  const ramPct = Math.round(100 * (1 - os.freemem() / os.totalmem()));
  return { cpu: Math.max(0, Math.min(100, cpuPct)), ram: Math.max(0, Math.min(100, ramPct)) };
}
setInterval(() => {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('system-stats', sampleSystemStats());
}, 2000);

// Status real da sessão Steam (usada pro badge no cabeçalho) — mesmos
// campos que já guardamos pra baixar/logar, só expostos pra UI conferir.
ipcMain.handle('get-steam-status', () => {
  const cookies = store.get('steamWebCookies');
  return { connected: !!(cookies && cookies.sessionid) };
});

// Diagnostic: this should NEVER fire — the wallpaper window is meant to be
// full click-through. If it does, mouse clicks on the desktop are landing on
// our window instead of passing through to icons/apps behind it.
ipcMain.on('wallpaper-click-received', (event, info) => {
  console.error(`[diag] !! WALLPAPER RECEIVED A REAL CLICK at (${info.x},${info.y}) — click-through is broken`);
});

// Diagnostic: Chromium's own visible/hidden page state — if this flips to
// hidden right when the freeze starts, that's the cause (Chromium stops
// compositing new frames while a page is "hidden", independent of JS/timers).
ipcMain.on('wallpaper-visibility-change', (event, info) => {
  console.log(`[diag] visibilitychange: hidden=${info.hidden} state=${info.state} at ${new Date(info.ts).toLocaleTimeString('pt-BR')}`);
});

ipcMain.on('wallpaper-set-attempt', (event, info) => {
  console.log(`[wallpaper] applying "${info.name || info.id}" type=${info.type} renderType=${info.renderType} src=${info.src}`);
});

ipcMain.on('wallpaper-video-error', (event, info) => {
  console.error(`[wallpaper] video ${info.stage} error (code=${info.code ?? 'n/a'}): ${info.message || 'unknown'} — src=${info.src}`);
});

ipcMain.on('wallpaper-video-state', (event, info) => {
  console.log(`[wallpaper] video state: paused=${info.paused} ended=${info.ended} currentTime=${info.currentTime.toFixed(2)} readyState=${info.readyState} networkState=${info.networkState} dims=${info.videoWidth}x${info.videoHeight} src=${info.src}`);
});

// Cenas WE que usam algo que nosso decodificador/renderer ainda não sabe ler
// direito hoje falhavam em silêncio (sem devtools aberto, o console da janela
// de wallpaper é invisível). Isso traz esses avisos pra aba Log do app.
ipcMain.on('we-scene-issue', (event, info) => {
  appLog.warn(`[Cena WE] ${info.label || '?'}: ${info.message}`);
});

ipcMain.handle('get-desktop-audio-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false });
  return sources[0]?.id;
});

ipcMain.handle('set-settings', (_, settings) => {
  store.set('settings', settings);
  sendToAllWallpapers('update-settings', settings);
  setAutostart(!!settings.startWithWindows);
  applyTaskbarIconsVisibility(settings);
  return true;
});

// Esconder barra de tarefas + ícones da área de trabalho (padrão ligado) —
// só faz sentido no modo normal, com a janela do wallpaper de verdade
// embutida atrás dos ícones (não em modo screensaver/config).
function applyTaskbarIconsVisibility(settings) {
  if (_isScreensaver || _isConfigMode) return;
  const { setDesktopIconsVisible, setTaskbarVisible } = require('./src/workerw');
  const hide = settings.hideTaskbarAndIcons !== false; // padrão true
  setDesktopIconsVisible(!hide);
  setTaskbarVisible(!hide);
}

ipcMain.handle('open-file-dialog', async (_, options) => dialog.showOpenDialog(controlWin, options));

ipcMain.handle('open-in-steam', (_, workshopId) => {
  const { shell } = require('electron');
  shell.openExternal(`steam://url/CommunityFilePage/${workshopId}`);
});

ipcMain.handle('window-minimize', () => controlWin?.minimize());
ipcMain.handle('window-close',    () => controlWin?.close());

// ---- Steam Workshop scanner ----
function getSteamPath() {
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM\\SOFTWARE\\Valve\\Steam']) {
    try {
      const out = execSync(`reg query "${key}" /v InstallPath`, { encoding: 'utf8' });
      const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/);
      if (m) return m[1].trim();
    } catch {}
  }
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getWorkshopDirs(steamPath) {
  const dirs = [];
  const tryAdd = (base) => {
    const p = path.join(base, 'steamapps', 'workshop', 'content', '431960');
    if (fs.existsSync(p)) dirs.push(p);
  };
  tryAdd(steamPath);
  const vdf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (fs.existsSync(vdf)) {
    const src = fs.readFileSync(vdf, 'utf-8');
    for (const [, p] of src.matchAll(/"path"\s+"([^"]+)"/g)) tryAdd(p.replace(/\\\\/g, '\\'));
  }
  return dirs;
}

// A Workshop "scene" item ships either as a loose scene.json (already
// unpacked) or as a packed scene.pkg. If it's packed, unpack it once into a
// cache folder so we-scene-render.js can read it like any other scene.
// Returns null if there's nothing we can read — callers keep the existing
// frozen-preview-image fallback in that case, so this never breaks import.
// Returns { dir, reason }. `dir` is null when we can't render this scene
// live — `reason` explains why, so the UI can tell the user what's going on
// instead of just silently showing a static image.
function resolveWeSceneDir(wpDir, workshopId) {
  if (fs.existsSync(path.join(wpDir, 'scene.json'))) return { dir: wpDir, reason: null };

  const pkgPath = path.join(wpDir, 'scene.pkg');
  if (!fs.existsSync(pkgPath)) return { dir: null, reason: 'no_scene_data' };

  const cacheDir = path.join(app.getPath('userData'), 'we-scene-cache', workshopId);
  if (fs.existsSync(path.join(cacheDir, 'scene.json'))) return { dir: cacheDir, reason: null };

  try {
    const { unpackPkg } = require('./src/we-scene');
    unpackPkg(pkgPath, cacheDir);
    if (fs.existsSync(path.join(cacheDir, 'scene.json'))) return { dir: cacheDir, reason: null };
    return { dir: null, reason: 'unpack_incomplete' };
  } catch (err) {
    appLog.warn(`Não foi possível descompactar scene.pkg de ${workshopId}: ${err.message}`);
    return { dir: null, reason: 'unsupported_package' };
  }
}

function parseSingleWorkshopItem(wpDir, id) {
  const pf = path.join(wpDir, 'project.json');
  if (!fs.existsSync(pf)) return null;
  let project; try { project = JSON.parse(fs.readFileSync(pf, 'utf-8')); } catch { return null; }
  const type = (project.type || '').toLowerCase();
  if (type !== 'video' && type !== 'web' && type !== 'scene') return null;

  // Builds pro usuário final (ver _isEndUserBuild) só mostram wallpapers de
  // vídeo do Steam Workshop. O renderer de "scene"/web é uma reimplementação
  // parcial e reversa do formato da Wallpaper Engine, ainda cheia de recursos
  // "não confirmados ao vivo" (ver memória do projeto) — não é algo pra expor
  // pra quem não está depurando isso de perto. No meu próprio dev
  // (bin/electron.exe) continua tudo liberado, sem filtro.
  if (_isEndUserBuild && type !== 'video') return null;

  let preview = null;
  for (const n of [project.preview, 'preview.gif', 'preview.jpg', 'preview.png'].filter(Boolean)) {
    const pp = path.join(wpDir, n);
    if (fs.existsSync(pp)) { preview = pp; break; }
  }

  if (type === 'scene') {
    if (!preview) return null;
    const { dir: weSceneDir, reason: weSceneFallbackReason } = resolveWeSceneDir(wpDir, id);
    return {
      workshopId: id,
      name: project.title || `Workshop ${id}`,
      type: 'scene',
      src: preview,
      preview,
      weSceneDir,
      weSceneFallbackReason,
      tags: Array.isArray(project.tags) ? project.tags : [],
      properties: project.general && project.general.properties ? project.general.properties : null,
    };
  }

  if (!project.file) return null;
  const filePath = path.join(wpDir, project.file);
  if (!fs.existsSync(filePath)) return null;
  return {
    workshopId: id,
    name: project.title || `Workshop ${id}`,
    type: type === 'video' ? 'video' : 'url',
    src: type === 'video' ? filePath : 'file:///' + filePath.replace(/\\/g, '/'),
    preview,
    tags: Array.isArray(project.tags) ? project.tags : [],
    properties: project.general && project.general.properties ? project.general.properties : null,
  };
}

function parseWorkshopDirectory(dir) {
  const wallpapers = [];
  let ids; try { ids = fs.readdirSync(dir); } catch { return wallpapers; }
  for (const id of ids) {
    const wpDir = path.join(dir, id);
    try { if (!fs.statSync(wpDir).isDirectory()) continue; } catch { continue; }
    const item = parseSingleWorkshopItem(wpDir, id);
    if (item) wallpapers.push(item);
  }
  return wallpapers;
}

ipcMain.handle('scan-steam-workshop', () => {
  const steamPath = getSteamPath();
  if (!steamPath) return { error: 'Steam não encontrado no sistema.', wallpapers: [] };
  const dirs = getWorkshopDirs(steamPath);
  if (!dirs.length) return { error: 'Pasta do Workshop não encontrada. Wallpaper Engine está instalado?', wallpapers: [] };

  let wallpapers = [];
  for (const dir of dirs) {
    wallpapers = wallpapers.concat(parseWorkshopDirectory(dir));
  }
  return { wallpapers };
});

ipcMain.handle('scan-custom-workshop', (_, customDir) => {
  if (!fs.existsSync(customDir)) return { error: 'Pasta inválida ou inexistente.', wallpapers: [] };
  const wallpapers = parseWorkshopDirectory(customDir);
  if (!wallpapers.length) return { error: 'Nenhum projeto encontrado nesta pasta.', wallpapers: [] };
  return { wallpapers };
});

// ---- Workshop Store (browse + download) ----
const https = require('https');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Igual ao httpGet acima, mas grava direto em disco em binário (não decodifica
// como texto) — usado só para baixar o asset .asar da release, que não é JSON.
function httpDownload(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return httpDownload(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} ao baixar atualização`));
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

// ---- Checagem de atualização (GitHub Releases, sem infraestrutura nova) ----
// Repositório público (Felpsbks/fynix-connect) — a API de releases da própria
// GitHub já dá tudo que precisa (tag/versão + link da página de download),
// sem precisar hospedar um version.json à parte nem tocar no license-server.
const APP_VERSION = require('./package.json').version;
const UPDATE_CHECK_REPO = 'Felpsbks/fynix-connect';
let _pendingUpdateInfo = null;

// Comparação simples de versão "x.y.z" — não é semver completo (sem
// pre-release/build metadata), mas é tudo que este projeto usa.
function isNewerVersion(remote, local) {
  const a = remote.split('.').map(Number);
  const b = local.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const na = a[i] || 0, nb = b[i] || 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

async function checkForUpdates() {
  try {
    const raw = await httpGet(`https://api.github.com/repos/${UPDATE_CHECK_REPO}/releases/latest`);
    const data = JSON.parse(raw);
    if (!data || !data.tag_name) return;
    const remoteVersion = String(data.tag_name).replace(/^v/i, '');
    if (!isNewerVersion(remoteVersion, APP_VERSION)) return;
    if (store.get('dismissedUpdateVersion') === remoteVersion) return;

    // Se a release tiver um asset chamado "app.asar" anexado, o app pode se
    // auto-atualizar (baixar + trocar o pacote + reabrir sozinho). Sem esse
    // asset (ex: release só com o zip/tar.gz automático do GitHub), cai no
    // fallback de abrir a página da release no navegador.
    const asset = Array.isArray(data.assets) ? data.assets.find(a => /^app\.asar$/i.test(a.name)) : null;

    _pendingUpdateInfo = {
      version: remoteVersion,
      url: data.html_url,
      assetUrl: asset ? asset.browser_download_url : null,
      assetSize: asset ? asset.size : null,
    };
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('update-available', _pendingUpdateInfo);
  } catch (err) {
    // Sem rede, GitHub fora do ar, ou repositório momentaneamente sem
    // releases — nunca deve incomodar o usuário nem travar nada, só não
    // mostra o aviso desta vez.
    console.warn('[main] checkForUpdates falhou:', err.message);
  }
}

// Renderer também pode puxar sob demanda (ex: se a checagem já rodou antes
// da janela de controle terminar de carregar e o webContents.send perdeu a
// hora certa) — não depende só do push.
ipcMain.handle('get-update-info', () => {
  if (_pendingUpdateInfo && store.get('dismissedUpdateVersion') === _pendingUpdateInfo.version) return null;
  return _pendingUpdateInfo;
});
ipcMain.handle('dismiss-update-notice', (_e, version) => { store.set('dismissedUpdateVersion', version); return true; });

// Auto-atualização "leve": este app sempre roda a partir de um único
// bin/resources/app.asar (nunca solto/unpacked — ver project_electron_binary
// na memória), então "instalar a atualização" é só baixar o app.asar novo e
// trocar o antigo por ele. Sem instalador, sem assinatura de código, sem
// electron-updater — só um hot-swap do pacote.
//
// O processo atual mantém o app.asar aberto pra leitura o tempo todo, então
// não dá pra sobrescrever com o app rodando. Um .bat descartável (gerado aqui,
// rodado detached) espera este processo (PID atual) terminar, só então troca
// o arquivo e reabre o exe — depois se autodeleta.
ipcMain.handle('apply-update', async () => {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' };
  if (!_pendingUpdateInfo || !_pendingUpdateInfo.assetUrl) return { ok: false, reason: 'no-asset' };

  const sendProgress = (payload) => {
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('update-apply-progress', payload);
  };

  try {
    const updateDir = path.join(app.getPath('temp'), 'engine-wallpaper-update');
    if (fs.existsSync(updateDir)) fs.rmSync(updateDir, { recursive: true, force: true });
    fs.mkdirSync(updateDir, { recursive: true });

    // NUNCA nomear o destino do download como "app.asar" (nem com esse
    // literal em nenhum trecho do caminho) — o Electron faz patch global
    // do módulo `fs` pra interceptar qualquer path contendo ".asar" e
    // tentar interpretar como um pacote ASAR de verdade. Isso quebra
    // `fs.createWriteStream`/`fs.statSync` num arquivo que ainda nem
    // terminou de ser escrito (ainda não é um ASAR válido), lançando
    // "Invalid package" — confirmado ao vivo 2026-07-20, travava o
    // processo principal inteiro (crash visível, sem stack útil pro
    // usuário). Baixa com um nome neutro; só vira literalmente "app.asar"
    // no `copy` do .bat abaixo, que roda via cmd.exe — fora do Node do
    // Electron, então esse patch nunca entra em ação ali.
    const downloadTmpPath = path.join(updateDir, 'app-update.download');
    sendProgress({ status: 'downloading' });
    await httpDownload(_pendingUpdateInfo.assetUrl, downloadTmpPath);

    const downloadedSize = fs.statSync(downloadTmpPath).size;
    if (!downloadedSize || (_pendingUpdateInfo.assetSize && downloadedSize !== _pendingUpdateInfo.assetSize)) {
      throw new Error('Download incompleto ou corrompido.');
    }

    const targetAsarPath = path.join(process.resourcesPath, 'app.asar');
    const exePath = process.execPath;
    const pid = process.pid;
    const batPath = path.join(updateDir, 'apply.bat');
    const batContents = [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${pid}" /NH | findstr /I "${pid}" >nul`,
      'if not errorlevel 1 (',
      '  timeout /t 1 /nobreak >nul',
      '  goto wait',
      ')',
      `copy /Y "${downloadTmpPath}" "${targetAsarPath}" >nul`,
      `start "" "${exePath}"`,
      'del "%~f0"',
    ].join('\r\n');
    fs.writeFileSync(batPath, batContents);

    sendProgress({ status: 'restarting' });
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch (err) {
    console.warn('[main] apply-update falhou:', err.message);
    sendProgress({ status: 'error', message: err.message });
    return { ok: false, reason: 'error', message: err.message };
  }
});

function httpPost(url, formData) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(formData).toString();
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPostJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://steamworkshopdownloader.io',
        'Referer': 'https://steamworkshopdownloader.io/',
        'Accept': 'application/json, text/plain, */*',
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Wallpaper Engine tags every Workshop item with exactly one content-type tag.
// 'application' items are proprietary executables we can never run; 'unknown'
// items didn't declare a recognizable type. Both get flagged as incompatible
// so the UI can filter them out before the user wastes time downloading.
const WA_TYPE_TAGS = ['video', 'web', 'scene', 'application'];
function inferWaType(tags) {
  const lower = (tags || []).map(t => t.toLowerCase());
  for (const t of WA_TYPE_TAGS) if (lower.includes(t)) return t;
  return 'unknown';
}

ipcMain.handle('get-workshop-details', async (_, ids) => {
  try {
    if (!ids || ids.length === 0) return { items: [] };
    const formData = { itemcount: ids.length };
    ids.forEach((id, i) => { formData[`publishedfileids[${i}]`] = id; });
    const detailJson = await httpPost('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', formData);
    const details = JSON.parse(detailJson);
    const items = (details.response?.publishedfiledetails || []).map(d => {
      const tags = (d.tags || []).map(t => t.tag);
      const waType = inferWaType(tags);
      return {
        workshopId: d.publishedfileid,
        title: d.title || 'Sem título',
        preview: d.preview_url || '',
        file_url: d.file_url || '',
        description: (d.description || '').substring(0, 200),
        tags,
        subscribers: d.subscriptions || 0,
        views: d.views || 0,
        favorited: d.favorited || 0,
        timeCreated: d.time_created || null,
        waType,
        compatible: waType === 'video' || waType === 'web' || waType === 'scene',
      };
    });
    return { items };
  } catch (e) {
    return { items: [], error: e.message };
  }
});

ipcMain.handle('browse-workshop', async (_, { sort, search, page, tag }) => {
  try {
    // Step 1: Scrape the browse page to get workshop item IDs
    let browseUrl = `https://steamcommunity.com/workshop/browse/?appid=431960&browsesort=${sort || 'trend'}&section=readytouseitems&actualsort=${sort || 'trend'}&p=${page || 1}`;
    if (search) browseUrl += '&searchtext=' + encodeURIComponent(search);
    if (tag) browseUrl += '&requiredtags%5B%5D=' + encodeURIComponent(tag);

    const html = await httpGet(browseUrl);
    const idPattern = /sharedfiles\/filedetails\/\?id=(\d+)/g;
    const ids = new Set();
    let m;
    while ((m = idPattern.exec(html)) !== null) ids.add(m[1]);
    const idList = [...ids];

    if (idList.length === 0) {
      appLog.warn(`browse-workshop (sort=${sort || 'trend'}, page=${page || 1}): scrape retornou 0 IDs (html length=${html.length}). Steam pode ter bloqueado/mudado a página.`);
      return { items: [], total: 0 };
    }

    // Step 2: Get full details via Steam public API (no key needed)
    const formData = { itemcount: idList.length };
    idList.forEach((id, i) => { formData[`publishedfileids[${i}]`] = id; });
    const detailJson = await httpPost('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', formData);
    let details;
    try {
      details = JSON.parse(detailJson);
    } catch (parseErr) {
      appLog.err(`browse-workshop (sort=${sort || 'trend'}): resposta da API de detalhes não é JSON válido (${idList.length} ids). Resposta: ${detailJson.slice(0, 200)}`);
      return { items: [], total: 0, error: 'Resposta inválida da Steam API' };
    }
    if (!details.response || !details.response.publishedfiledetails) {
      appLog.warn(`browse-workshop (sort=${sort || 'trend'}): API respondeu sem publishedfiledetails (${idList.length} ids enviados). result=${details.response && details.response.result}`);
    }

    const items = (details.response?.publishedfiledetails || []).map(d => {
      const tags = (d.tags || []).map(t => t.tag);
      const waType = inferWaType(tags);
      return {
        workshopId: d.publishedfileid,
        title: d.title || 'Sem título',
        preview: d.preview_url || '',
        file_url: d.file_url || '',
        description: (d.description || '').substring(0, 200),
        tags,
        subscribers: d.subscriptions || 0,
        views: d.views || 0,
        favorited: d.favorited || 0,
        timeCreated: d.time_created || null,
        waType,
        // 'scene' still works here — it just renders as a static preview image
        // instead of the animated proprietary scene (see wallpaper.js fallback).
        compatible: waType === 'video' || waType === 'web' || waType === 'scene',
      };
    });

    return { items, total: items.length };
  } catch (e) {
    console.error('[browse-workshop]', e.message);
    return { items: [], total: 0, error: e.message };
  }
});

// ---- Steam QR Auth ----
let _qrSession = null;

ipcMain.handle('steam-web-login', async () => {
  return new Promise((resolve) => {
    const { BrowserWindow, session } = require('electron');
    // Usar uma sessão separada para não misturar com os cookies principais do app, se desejar. 
    // Ou usar defaultSession. Vamos usar defaultSession para ser simples.
    
    const loginIconPath = path.join(__dirname, 'assets', 'icon.png');
    const loginWin = new BrowserWindow({
      width: 800,
      height: 600,
      title: 'Login Seguro - Steam',
      autoHideMenuBar: true,
      icon: fs.existsSync(loginIconPath) ? loginIconPath : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    loginWin.loadURL('https://steamcommunity.com/login/home/?goto=');

    // Monitor url changes to see when login is successful
    loginWin.webContents.on('did-navigate', async (event, url) => {
      if (url === 'https://steamcommunity.com/' || url.startsWith('https://steamcommunity.com/id/') || url.startsWith('https://steamcommunity.com/profiles/')) {
        // Obter os cookies
        const cookies = await session.defaultSession.cookies.get({ domain: 'steamcommunity.com' });
        const steamLoginSecure = cookies.find(c => c.name === 'steamLoginSecure')?.value;
        const sessionid = cookies.find(c => c.name === 'sessionid')?.value;
        
        if (steamLoginSecure && sessionid) {
          store.set('steamWebCookies', { steamLoginSecure, sessionid });
          loginWin.close();
          resolve({ ok: true });
        }
      }
    });

    loginWin.on('closed', () => {
      resolve({ ok: false, msg: 'Janela de login fechada.' });
    });
  });
});

// Exporta a sessão Steam atual como um código para colar em outro PC com a
// mesma conta (ex: mesmo dono, PC secundário), evitando refazer o login lá.
ipcMain.handle('export-steam-session', async () => {
  const cookies = store.get('steamWebCookies');
  if (!cookies || !cookies.sessionid || !cookies.steamLoginSecure) {
    return { ok: false, msg: 'Nenhuma sessão Steam ativa neste PC ainda. Faça login primeiro.' };
  }
  const code = Buffer.from(JSON.stringify(cookies), 'utf-8').toString('base64');
  return { ok: true, code };
});

ipcMain.handle('import-steam-session', async (_, code) => {
  try {
    const cookies = JSON.parse(Buffer.from(String(code).trim(), 'base64').toString('utf-8'));
    if (!cookies || !cookies.sessionid || !cookies.steamLoginSecure) {
      return { ok: false, msg: 'Código inválido.' };
    }
    store.set('steamWebCookies', cookies);
    return { ok: true };
  } catch (_) {
    return { ok: false, msg: 'Código inválido.' };
  }
});

ipcMain.handle('remove-wallpaper', async (_, id) => {
  try {
    const library = store.get('library') || [];
    const idx = library.findIndex(w => w.id === id);
    if (idx === -1) return { ok: false, msg: 'Wallpaper não encontrado na biblioteca.' };
    
    const wpItem = library[idx];
    
    // Se for da Steam e tiver workshopId, tentar desinscrever para que a Steam apague os arquivos físicos
    if (wpItem.workshopId) {
      const cookies = store.get('steamWebCookies');
      if (cookies && cookies.sessionid && cookies.steamLoginSecure) {
        const { sessionid, steamLoginSecure } = cookies;
        const reqOptions = {
          method: 'POST',
          headers: {
            'Cookie': `sessionid=${sessionid}; steamLoginSecure=${steamLoginSecure}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': `https://steamcommunity.com/sharedfiles/filedetails/?id=${wpItem.workshopId}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          body: `id=${wpItem.workshopId}&appid=431960&sessionid=${sessionid}`
        };
        // Requisição para desinscrever (não aguardamos/verificamos porque a exclusão local é nossa prioridade)
        fetch('https://steamcommunity.com/sharedfiles/unsubscribe', reqOptions).catch(() => {});
      }
    }

    library.splice(idx, 1);
    store.set('library', library);
    
    // Se era o wallpaper atual, limpar (o frontend lida com a troca)
    const current = store.get('current');
    if (current && current.id === id) {
      store.delete('current');
    }
    
    return { ok: true };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
});


function importFromContentDir(contentDir, workshopId) {
  let wpItem = parseSingleWorkshopItem(contentDir, workshopId);
  if (!wpItem) {
    const subs = fs.existsSync(contentDir)
      ? fs.readdirSync(contentDir).filter(f => fs.statSync(path.join(contentDir, f)).isDirectory())
      : [];
    if (subs.length) wpItem = parseSingleWorkshopItem(path.join(contentDir, subs[0]), workshopId);
  }
  if (wpItem) {
    const library = store.get('library') || [];
    wpItem.id = Date.now().toString();
    library.push(wpItem);
    store.set('library', library);
    return wpItem;
  }
  return null;
}

// SteamCMD REMOVIDO a pedido do usuário 2026-07-17 — já tinha dado problema
// antes. Download volta a ser: inscrever via sessão web + esperar o Steam
// Desktop baixar sozinho (mais lento, mas é o caminho pedido).

// Confirma se a conta Steam logada possui um app (ex: Wallpaper Engine, 431960),
// usando o mesmo cookie de sessão do login web — sem precisar de API key nem
// de nada hospedado por fora. Retorna null (não bloqueia) se não conseguir
// checar; só bloqueia quando a resposta confirma que o app NÃO está na conta.
async function checkOwnsApp(cookies, appId) {
  try {
    const res = await fetch('https://steamcommunity.com/dynamicstore/userdata/', {
      headers: {
        'Cookie': `sessionid=${cookies.sessionid}; steamLoginSecure=${cookies.steamLoginSecure}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.rgOwnedApps)) return null;
    return data.rgOwnedApps.includes(appId);
  } catch (_) {
    return null;
  }
}

ipcMain.handle('download-workshop-item', async (_, { workshopId, name }) => {
  // Um wallpaper de vídeo baixado do Workshop mantém o arquivo aberto o tempo
  // todo (tocando em loop) dentro de steamapps/workshop/content/431960/... —
  // a mesma árvore onde a Steam precisa gravar ao baixar um item novo. Isso já
  // causou "File locked" e pausou a fila de update dela (visto no
  // content_log.txt real). Solução: soltar esse arquivo antes de baixar, e
  // recarregar o wallpaper depois, seja qual for o resultado do download.
  const currentBeforeDownload = store.get('current');
  const shouldReleaseLock = !!(currentBeforeDownload && currentBeforeDownload.type === 'video' && currentBeforeDownload.workshopId);
  if (shouldReleaseLock) {
    appLog(`Pausando o wallpaper de vídeo atual (Workshop) para evitar lock de arquivo durante o download...`);
    sendToAllWallpapers('stop');
  }
  try {
    appLog(`Iniciando download web do wallpaper "${name}" (ID: ${workshopId})`);
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'preparing', name });

    const cookies = store.get('steamWebCookies');
    if (!cookies || !cookies.sessionid || !cookies.steamLoginSecure) {
      appLog.warn(`Cookies da Steam não encontrados. Redirecionando para login.`);
      return { ok: false, msg: 'needs_login' };
    }

    const owns = await checkOwnsApp(cookies, 431960);
    if (owns === false) {
      appLog.err(`Conta Steam não possui o Wallpaper Engine (appid 431960). Download bloqueado.`);
      if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: 'Sua conta Steam não possui o Wallpaper Engine. É necessário ter o app na biblioteca Steam para baixar itens do Workshop dele.' });
      return { ok: false, msg: 'not_owned' };
    }

    const { sessionid, steamLoginSecure } = cookies;

    // Fazer a inscrição (Subscribe) via POST HTTP
    const reqOptions = {
      method: 'POST',
      headers: {
        'Cookie': `sessionid=${sessionid}; steamLoginSecure=${steamLoginSecure}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`,
        'Origin': 'https://steamcommunity.com',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: `id=${workshopId}&appid=431960&sessionid=${sessionid}`
    };

    let response;
    try {
      response = await fetch('https://steamcommunity.com/sharedfiles/subscribe', { ...reqOptions, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      appLog.err(`Falha ao inscrever no item (Steam não respondeu): ${err.message}`);
      if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: 'A Steam não respondeu à inscrição. Verifique sua conexão e tente novamente.' });
      return { ok: false, msg: 'Timeout na inscrição.' };
    }
    if (response.status === 401 || response.status === 403) {
      appLog.warn(`Sessão da Steam expirada (HTTP ${response.status}). Pedindo novo login.`);
      store.delete('steamWebCookies');
      return { ok: false, msg: 'needs_login' };
    }
    if (!response.ok) {
      appLog.err(`Erro HTTP na inscrição da Steam: ${response.status}`);
      if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: `Erro HTTP na Steam: ${response.status}` });
      return { ok: false, msg: `Erro HTTP na Steam: ${response.status}` };
    }

    appLog.ok(`Inscrito com sucesso! Aguardando a Steam do PC baixar os arquivos...`);
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'progress', pct: 0.5, downloaded: 0, total: 100, speed: 0 });

    let steamPath = '';
    try {
      const out = require('child_process').execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').toString();
      const match = out.match(/SteamPath\s+REG_SZ\s+(.*)/i);
      if (match) steamPath = match[1].trim();
    } catch(e) {}
    if (!steamPath) steamPath = 'C:\\Program Files (x86)\\Steam';

    const contentDir = path.join(steamPath, 'steamapps', 'workshop', 'content', '431960', workshopId);

    return await new Promise((resolve) => {
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        if (fs.existsSync(contentDir) && fs.readdirSync(contentDir).length > 0) {
          clearInterval(timer);
          setTimeout(() => {
            const wpItem = importFromContentDir(contentDir, workshopId);
            if (wpItem) {
              appLog.ok(`Arquivo baixado pela Steam e importado com sucesso!`);
              if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'completed', wallpaper: wpItem });
              resolve({ ok: true });
            } else {
              appLog.err(`Formato não reconhecido na pasta baixada.`);
              if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: 'Formato não reconhecido.' });
              resolve({ ok: false, msg: 'Formato não reconhecido.' });
            }
          }, 3000);
        } else if (attempts >= 240) { // 4 minutos de espera — a sincronização da Steam às vezes demora bem mais que 2min
          clearInterval(timer);
          appLog.err(`Tempo limite esperando a Steam baixar o item.`);
          if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: 'Tempo esgotado. Verifique se a Steam está aberta e baixando.' });
          resolve({ ok: false, msg: 'Tempo limite.' });
        }
      }, 1000);
    });
  } catch (err) {
    appLog.err(`Erro na inscrição via web: ${err.message}`);
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'error', msg: err.message });
    return { ok: false, msg: err.message };
  } finally {
    if (shouldReleaseLock) {
      appLog(`Retomando o wallpaper de vídeo pausado...`);
      sendToAllWallpapers('unstop');
    }
  }
});

// Pede pra Steam verificar/retomar a atualização do Wallpaper Engine — útil
// quando ela pausa sozinha por "File locked" (ver content_log.txt da Steam).
ipcMain.handle('unstick-steam-downloads', async () => {
  try {
    const { shell } = require('electron');
    await shell.openExternal('steam://validate/431960');
    return { ok: true };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
});

ipcMain.handle('sync-steam-desktop', async () => {
  let steamPath = '';
  try {
    const out = require('child_process').execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').toString();
    const match = out.match(/SteamPath\s+REG_SZ\s+(.*)/i);
    if (match) steamPath = match[1].trim();
  } catch(e) {}
  
  if (!steamPath) steamPath = 'C:\\Program Files (x86)\\Steam';
  
  const contentDir = path.join(steamPath, 'steamapps', 'workshop', 'content', '431960');
  if (!fs.existsSync(contentDir)) return { count: 0, error: 'Pasta do Wallpaper Engine não encontrada na Steam' };
  
  const library = store.get('library') || [];
  let added = 0;
  for (const f of fs.readdirSync(contentDir)) {
    const p = path.join(contentDir, f);
    if (fs.statSync(p).isDirectory()) {
      if (!library.some(w => w.id === f || w.workshopId === f)) {
        let wpItem = parseSingleWorkshopItem(p, f);
        if (!wpItem) {
          const sub = fs.readdirSync(p).filter(subF => fs.statSync(path.join(p, subF)).isDirectory());
          if (sub.length > 0) wpItem = parseSingleWorkshopItem(path.join(p, sub[0]), f);
        }
        if (wpItem) {
          wpItem.id = f; // Use workshop ID as local ID for deduplication
          wpItem.workshopId = f;
          library.push(wpItem);
          added++;
        }
      }
    }
  }
  if (added > 0) store.set('library', library);
  return { count: added };
});

ipcMain.handle('install-screensaver', async () => {
  try {
    const binDir = path.join(__dirname, 'bin');
    const exePath = path.join(binDir, 'electron.exe');
    const scrPath = path.join(binDir, 'EngineWallpaper.scr');
    
    if (!fs.existsSync(exePath)) return { ok: false, msg: 'Execute o comando "npm run pack" primeiro.' };
    
    fs.copyFileSync(exePath, scrPath);
    
    const { execSync } = require('child_process');
    execSync(`reg add "HKCU\\Control Panel\\Desktop" /v SCRNSAVE.EXE /t REG_SZ /d "${scrPath}" /f`);
    execSync(`reg add "HKCU\\Control Panel\\Desktop" /v ScreenSaveActive /t REG_SZ /d "1" /f`);
    
    return { ok: true };
  } catch (err) {
    appLog.err('Erro instalando screensaver: ' + err.message);
    return { ok: false, msg: err.message };
  }
});

// ---- Boot ----
_bootLog('app.whenReady() disparado');
app.whenReady().then(async () => {
  _bootLog('dentro do callback de whenReady, chamando License.checkLicense');
  const licenseStatus = await License.checkLicense(store);
  _bootLog(`License.checkLicense retornou: ok=${licenseStatus.ok}`);
  if (!licenseStatus.ok) {
    _bootLog('licença precisa de ativação, abrindo showActivationWindow (bloqueia até o usuário agir)');
    const activated = await showActivationWindow();
    _bootLog(`showActivationWindow resolveu: activated=${activated}`);
    if (!activated) { app.quit(); return; }
  }

  // First boot configuration
  if (!store.get('settings')) {
    const defaultSettings = { volume: 50, pauseOnFullscreen: true, performanceModeFullscreen: false, muteOnFullscreen: false, startWithWindows: true, audioReactive: false, hideTaskbarAndIcons: true };
    store.set('settings', defaultSettings);
  }
  // Runs on every boot (cheap fs.existsSync check when already in sync — see
  // setAutostart) so existing installs self-migrate off the old Registry
  // Run-key mechanism without the user needing to re-toggle the setting.
  setAutostart(!!(store.get('settings') || {}).startWithWindows);
  applyTaskbarIconsVisibility(store.get('settings') || {});

  // Converte timeRules/playlistConfig antigos em Playlists+Rotinas uma única
  // vez (guardado por store.get('routinesMigrated')) antes do motor iniciar.
  routinesMigrate.run(store, appLog);
  _bootLog('configuração inicial + migração de rotinas concluídas, chamando createWallpaperWindows');

  createWallpaperWindows();
  _bootLog('createWallpaperWindows retornou');
  startAutomationEngine();
  if (!_isScreensaver) { startWorkerWWatchdog(); startRepaintNudge(); startNativeWallpaperRefresh(); checkConflictingWallpaperApps(); }

  // Adicionados 2026-07-18 (hook global de clique + integração de media
  // session) — DEPOIS que o wallpaper já existe de propósito. Achado real:
  // antes rodavam no topo do módulo, ou seja, ANTES até de app.whenReady()
  // e createWallpaperWindows() — se o hook nativo do uiohook ou o spawn do
  // PowerShell da media session travarem/demorarem no boot (ex.: antivírus
  // escaneando um binário nativo recém-tocado, mesma classe de problema já
  // visto com o bin/electron.exe), isso atrasava/travava o wallpaper
  // inteiro, que nem chegava a ser criado. Agora essas duas coisas nunca
  // podem bloquear o wallpaper aparecer — o pior caso é elas falharem
  // sozinhas (já tratado com try/catch), sem afetar o resto do app.
  ensureClickBroadcast();
  _bootLog('ensureClickBroadcast retornou');
  ensureMediaSessionPoll();
  _bootLog('ensureMediaSessionPoll retornou, chamando createControlWindow');

  if (!_isScreensaver && !_isConfigMode) {
    createControlWindow();
    _bootLog('createControlWindow retornou');
    createTray();
    _bootLog('createTray retornou — boot do main process concluído');

    // Checagem de atualização: nunca no caminho crítico do boot (chamada de
    // rede) — roda uma vez alguns segundos depois de tudo já estar de pé, e
    // depois a cada 6h (o app costuma ficar aberto o dia inteiro, rodando em
    // segundo plano).
    setTimeout(checkForUpdates, 8000);
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
  } else if (_isConfigMode) {
    createControlWindow();
  }
});

// Alguém tentou abrir uma segunda instância (a trava no topo do arquivo já
// barrou o processo dela) — em vez de simplesmente ignorar, traz a janela
// que já existe pra frente, que é o que o usuário esperava ao "abrir de novo".
app.on('second-instance', () => {
  if (controlWin && !controlWin.isDestroyed()) {
    if (controlWin.isMinimized()) controlWin.restore();
    controlWin.show();
    controlWin.focus();
  } else if (!_isScreensaver && !_isConfigMode) {
    createControlWindow();
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  tray?.destroy();
  if (_engineTimer) clearInterval(_engineTimer);
  // Sempre devolve ícones/barra de tarefas ao sair, mesmo que a opção esteja
  // ligada — senão o usuário fica com o Windows "quebrado" (sem ícones/barra)
  // depois de fechar o app.
  if (!_isScreensaver && !_isConfigMode) {
    const { setDesktopIconsVisible, setTaskbarVisible } = require('./src/workerw');
    setDesktopIconsVisible(true);
    setTaskbarVisible(true);
  }
});
