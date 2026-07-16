const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, screen, nativeImage, desktopCapturer } = require('electron');

// ---- RAM Saver: Dieta do Chromium ----
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-spell-checking');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('disable-pdf-extension');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-metrics');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');

const args = process.argv.map(a => a.toLowerCase());
const _isScreensaver = args.includes('/s') || args.includes('-s');
const _isConfigMode = args.includes('/c') || args.includes('-c');
if (args.find(a => a.startsWith('/p') || a.startsWith('-p'))) {
  app.exit(0); // Preview mode not supported yet due to HWND complexity
}
try { require('electron-reload')(__dirname); } catch (_) {}
const path       = require('path');
const fs         = require('fs');
const { execSync } = require('child_process');
const Store      = require('./src/store');
const Playlist   = require('./src/playlist');

let controlWin = null;
let tray       = null;
const store    = new Store();
const playlist = new Playlist(store);
let _pendingWorkshopId = null;

function appLog(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('app-log', { ts, msg, level });
  }
}
appLog.ok    = (msg) => appLog(msg, 'success');
appLog.warn  = (msg) => appLog(msg, 'warn');
appLog.err   = (msg) => appLog(msg, 'error');
appLog.debug = (msg) => appLog(msg, 'debug');


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

  wallpaperWindows.set(display.id, win);
}

function sendToAllWallpapers(channel, ...args) {
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

// ---- Control panel ----
function createControlWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  controlWin = new BrowserWindow({
    width: 980, height: 680,
    minWidth: 800, minHeight: 500,
    frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#0d0d0d',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true },
  });

  controlWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  controlWin.once('ready-to-show', () => controlWin.show());
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

// ---- Win32 WorkerW embedding ----
function embedWallpaperBehindDesktop(win) {
  if (process.platform !== 'win32') return;
  try {
    const { embedBehindDesktop } = require('./src/workerw');
    const hwnd = win.getNativeWindowHandle();
    if (!embedBehindDesktop(hwnd)) console.warn('[main] WorkerW embedding failed');
  } catch (err) {
    console.error('[main] WorkerW error:', err.message);
  }
}

// ---- System tray ----
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
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
    { label: 'Próximo wallpaper',  click: () => playlist.next() },
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

// ---- Fullscreen monitor ----
let _appState = { pause: false, mute: false, stop: false };
let _manualPause = false;
let _fsTimer = null;

ipcMain.handle('toggle-playback', () => {
  _manualPause = !_manualPause;
  sendToAllWallpapers(_manualPause ? 'pause' : 'resume');
  _appState.pause = _manualPause;
  return { paused: _manualPause };
});

function getRunningProcesses() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('tasklist /FO CSV /NH', (err, stdout) => {
      if (err) return resolve([]);
      const processes = stdout.split('\\n')
        .map(line => line.split(',')[0])
        .map(name => name.replace(/"/g, '').trim().toLowerCase())
        .filter(name => name.length > 0);
      resolve(processes);
    });
  });
}

function startFullscreenMonitor() {
  _fsTimer = setInterval(async () => {
    const settings = store.get('settings') || {};
    let rulesActive = { pause: false, mute: false, stop: false };
    
    // 1. App Rules
    if (settings.appRules && settings.appRules.length > 0) {
      const running = await getRunningProcesses();
      for (const rule of settings.appRules) {
        if (running.includes(rule.exe.toLowerCase())) {
          if (rule.action === 'pause') rulesActive.pause = true;
          if (rule.action === 'mute') rulesActive.mute = true;
          if (rule.action === 'stop') rulesActive.stop = true;
        }
      }
    }

    // 2. Fullscreen Rules
    if (settings.pauseOnFullscreen || settings.muteOnFullscreen) {
      try {
        const { isFullscreenAppRunning } = require('./src/fullscreen');
        const isFs = isFullscreenAppRunning(screen.getAllDisplays());
        if (isFs) {
          if (settings.pauseOnFullscreen) rulesActive.pause = true;
          if (settings.muteOnFullscreen) rulesActive.mute = true;
        }
      } catch {}
    }

    // Manual pause from the control panel's play/pause button always wins,
    // regardless of what the automation rules computed this tick.
    if (_manualPause) rulesActive.pause = true;

    const vol = settings.volume ?? 50;

    // Apply Stop/Unstop
    if (rulesActive.stop !== _appState.stop) {
      sendToAllWallpapers(rulesActive.stop ? 'stop' : 'unstop');
    }
    
    // Apply Pause/Resume (only if not stopped)
    if (!rulesActive.stop) {
      if (rulesActive.pause !== _appState.pause) {
        sendToAllWallpapers(rulesActive.pause ? 'pause' : 'resume');
      }
    }

    // Apply Mute/Unmute
    if (rulesActive.mute !== _appState.mute) {
      sendToAllWallpapers(rulesActive.mute ? 'mute' : 'unmute', vol);
    }

    _appState = rulesActive;
  }, 3000);
}

// ---- Time-based switching ----
let _timeTimer = null;
let _lastAppliedTimeRule = null;

function startTimeRulesMonitor() {
  _timeTimer = setInterval(() => {
    const rules = store.get('timeRules') || [];
    if (!rules.length) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const library = store.get('library') || [];

    // Find the most recent rule that has passed
    const sorted = [...rules].sort((a, b) => a.time.localeCompare(b.time));
    let match = null;
    for (const r of sorted) {
      if (r.time <= hhmm) match = r;
    }
    if (!match) match = sorted[sorted.length - 1]; // wrap to last rule of previous day

    if (!match || match.id === _lastAppliedTimeRule) return;
    _lastAppliedTimeRule = match.id;

    const wallpaper = library.find(w => w.id === match.wallpaperId);
    if (!wallpaper) return;

    store.set('current', wallpaper);
    sendToAllWallpapers('set-wallpaper', wallpaper);
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('wallpaper-changed', wallpaper);
    }
  }, 60000);
}

// ---- IPC Handlers ----
ipcMain.handle('get-library', () => {
  const library = store.get('library') || [];
  let updated = false;
  library.forEach(w => {
    if (w.workshopId && !w.properties && w.src) {
      const parsed = parseSingleWorkshopItem(path.dirname(w.src), w.workshopId);
      if (parsed && parsed.properties) {
        w.properties = parsed.properties;
        updated = true;
      }
    }
  });
  if (updated) store.set('library', library);
  return library;
});
ipcMain.handle('get-current',          () => store.get('current') || null);
ipcMain.handle('get-playlist-config',  () => store.get('playlistConfig') || { enabled: false, interval: 30, shuffle: false });
const DEFAULT_CLOCK_OVERLAY = { enabled: false, position: 'top-left', format24h: true, showSeconds: false, showDate: true, showDayName: true, color: '#ffffff', fontSize: 48 };
ipcMain.handle('get-settings',         () => store.get('settings') || { volume: 50, pauseOnFullscreen: true, muteOnFullscreen: false, startWithWindows: true, audioReactive: false, clockOverlay: DEFAULT_CLOCK_OVERLAY });
ipcMain.handle('get-displays',         () => screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, label: d.label || null })));
ipcMain.handle('get-display-wallpapers', () => store.get('displayWallpapers') || {});
ipcMain.handle('get-time-rules',       () => store.get('timeRules') || []);

ipcMain.handle('set-wallpaper', (_, wallpaper, displayId) => {
  if (displayId) {
    const win = wallpaperWindows.get(displayId);
    if (win && !win.isDestroyed()) win.webContents.send('set-wallpaper', wallpaper);
    const dw = store.get('displayWallpapers') || {};
    dw[displayId] = wallpaper;
    store.set('displayWallpapers', dw);
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

ipcMain.handle('should-show-we-scene-notice', () => !store.get('weSceneNoticeShown'));
ipcMain.handle('mark-we-scene-notice-shown', () => { store.set('weSceneNoticeShown', true); return true; });

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

ipcMain.handle('set-playlist-config', (_, config) => {
  store.set('playlistConfig', config);
  playlist.configure(config);
  return true;
});

ipcMain.on('update-native-prop', (_, data) => {
  sendToAllWallpapers('update-native-prop', data);
});

ipcMain.handle('get-desktop-audio-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false });
  return sources[0]?.id;
});

ipcMain.handle('set-settings', (_, settings) => {
  store.set('settings', settings);
  sendToAllWallpapers('update-settings', settings);
  // Start with Windows
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, path: process.execPath });
  } catch {}
  return true;
});

ipcMain.handle('set-time-rules', (_, rules) => {
  store.set('timeRules', rules);
  _lastAppliedTimeRule = null;
  return true;
});

ipcMain.handle('open-file-dialog', async (_, options) => dialog.showOpenDialog(controlWin, options));

ipcMain.handle('open-in-steam', (_, workshopId) => {
  const { shell } = require('electron');
  shell.openExternal(`steam://url/CommunityFilePage/${workshopId}`);
});

ipcMain.handle('window-minimize', () => controlWin?.minimize());
ipcMain.handle('window-maximize', () => controlWin?.isMaximized() ? controlWin.unmaximize() : controlWin?.maximize());
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
function resolveWeSceneDir(wpDir, workshopId) {
  if (fs.existsSync(path.join(wpDir, 'scene.json'))) return wpDir;

  const pkgPath = path.join(wpDir, 'scene.pkg');
  if (!fs.existsSync(pkgPath)) return null;

  const cacheDir = path.join(app.getPath('userData'), 'we-scene-cache', workshopId);
  if (fs.existsSync(path.join(cacheDir, 'scene.json'))) return cacheDir;

  try {
    const { unpackPkg } = require('./src/we-scene');
    unpackPkg(pkgPath, cacheDir);
    return fs.existsSync(path.join(cacheDir, 'scene.json')) ? cacheDir : null;
  } catch (err) {
    appLog.warn(`Não foi possível descompactar scene.pkg de ${workshopId}: ${err.message}`);
    return null;
  }
}

function parseSingleWorkshopItem(wpDir, id) {
  const pf = path.join(wpDir, 'project.json');
  if (!fs.existsSync(pf)) return null;
  let project; try { project = JSON.parse(fs.readFileSync(pf, 'utf-8')); } catch { return null; }
  const type = (project.type || '').toLowerCase();
  if (type !== 'video' && type !== 'web' && type !== 'scene') return null;

  let preview = null;
  for (const n of [project.preview, 'preview.gif', 'preview.jpg', 'preview.png'].filter(Boolean)) {
    const pp = path.join(wpDir, n);
    if (fs.existsSync(pp)) { preview = pp; break; }
  }

  if (type === 'scene') {
    if (!preview) return null;
    return {
      workshopId: id,
      name: project.title || `Workshop ${id}`,
      type: 'scene',
      src: preview,
      preview,
      weSceneDir: resolveWeSceneDir(wpDir, id),
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

    if (idList.length === 0) return { items: [], total: 0 };

    // Step 2: Get full details via Steam public API (no key needed)
    const formData = { itemcount: idList.length };
    idList.forEach((id, i) => { formData[`publishedfileids[${i}]`] = id; });
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
    
    const loginWin = new BrowserWindow({
      width: 800,
      height: 600,
      title: 'Login Seguro - Steam',
      autoHideMenuBar: true,
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

ipcMain.handle('download-workshop-item', async (_, { workshopId, name, previewUrl, fileUrl }) => {
  try {
    appLog(`Iniciando download web do wallpaper "${name}" (ID: ${workshopId})`);
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('download-progress', { state: 'preparing', name });

    const cookies = store.get('steamWebCookies');
    if (!cookies || !cookies.sessionid || !cookies.steamLoginSecure) {
      appLog.warn(`Cookies da Steam não encontrados. Redirecionando para login.`);
      return { ok: false, msg: 'needs_login' };
    }

    const { sessionid, steamLoginSecure } = cookies;

    // Fazer a inscrição (Subscribe) via POST HTTP
    const reqOptions = {
      method: 'POST',
      headers: {
        'Cookie': `sessionid=${sessionid}; steamLoginSecure=${steamLoginSecure}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: `id=${workshopId}&appid=431960&sessionid=${sessionid}`
    };

    const response = await fetch('https://steamcommunity.com/sharedfiles/subscribe', reqOptions);
    if (!response.ok) {
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
    
    return new Promise((resolve) => {
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
        } else if (attempts >= 120) { // 2 minutos de espera
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

// ---- Playlist ----
playlist.on('change', (wallpaper) => {
  store.set('current', wallpaper);
  sendToAllWallpapers('set-wallpaper', wallpaper);
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('wallpaper-changed', wallpaper);
});

// ---- Boot ----
app.whenReady().then(() => {
  // First boot configuration
  if (!store.get('settings')) {
    const defaultSettings = { volume: 50, pauseOnFullscreen: true, muteOnFullscreen: false, startWithWindows: true, audioReactive: false };
    store.set('settings', defaultSettings);
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }

  createWallpaperWindows();
  playlist.start();
  
  if (!_isScreensaver && !_isConfigMode) {
    createControlWindow();
    createTray();
    startFullscreenMonitor();
    startTimeRulesMonitor();
  } else if (_isConfigMode) {
    createControlWindow();
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  tray?.destroy();
  playlist.stop();
  if (_fsTimer)   clearInterval(_fsTimer);
  if (_timeTimer) clearInterval(_timeTimer);
});
