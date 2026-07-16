const { ipcRenderer } = require('electron');
const path = require('path');

const videoEl    = document.getElementById('video-layer');
const imageEl    = document.getElementById('image-layer');
const webEl      = document.getElementById('web-layer');
const canvasEl   = document.getElementById('scene-layer');
const weSceneEl  = document.getElementById('we-scene-layer');
const clockEl    = document.getElementById('clock-overlay');

let currentScene   = null;
let currentWeScene  = null;
let savedVolume = 0.5;

let audioContext = null;
let analyser = null;
let dataArray = null;

async function initAudioVisualizer() {
  try {
    const sourceId = await ipcRenderer.invoke('get-desktop-audio-source');
    if (!sourceId) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
    });

    // Chromium requires the video constraint to unlock desktop-loopback audio,
    // but we only need the audio track — stop the video track immediately so
    // it isn't continuously captured/decoded in the background for nothing.
    stream.getVideoTracks().forEach(t => t.stop());

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    
    analyser.fftSize = 256; 
    analyser.smoothingTimeConstant = 0.5;
    
    source.connect(analyser);
    dataArray = new Uint8Array(analyser.frequencyBinCount);

    requestAnimationFrame(updateAudioData);
  } catch (err) {
    console.warn('[wallpaper] Audio capture failed:', err);
  }
}

function updateAudioData() {
  if (analyser && dataArray && webEl.style.display === 'block') {
    analyser.getByteFrequencyData(dataArray);
    
    const weArray = new Array(128).fill(0);
    for (let i = 0; i < 64; i++) {
      const val = (dataArray[i] || 0) / 255.0;
      weArray[i] = val;       
      weArray[i + 64] = val;  
    }

    const code = `
      if (window._weAudioCallback) {
        window._weAudioCallback(${JSON.stringify(weArray)});
      }
    `;
    webEl.executeJavaScript(code).catch(() => {});
  }
  requestAnimationFrame(updateAudioData);
}

// ---- Clock/date overlay ----
const MONTH_ABBR = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
let _clockTimer  = null;
let _clockConfig = null;

function renderClockOverlay() {
  if (!_clockConfig || !_clockConfig.enabled) return;
  const now = new Date();
  const parts = [];

  if (_clockConfig.showDayName) {
    parts.push(`<div class="co-day">${now.toLocaleDateString('pt-BR', { weekday: 'long' })}</div>`);
  }

  let h = now.getHours();
  let suffix = '';
  if (!_clockConfig.format24h) {
    suffix = h >= 12 ? ' PM' : ' AM';
    h = h % 12 || 12;
  }
  const hh = String(h).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = _clockConfig.showSeconds ? ':' + String(now.getSeconds()).padStart(2, '0') : '';
  const fontSize = _clockConfig.fontSize || 48;
  parts.push(`<div class="co-time" style="font-size:${fontSize}px">-${hh}:${mm}${ss}-${suffix}</div>`);

  if (_clockConfig.showDate) {
    parts.push(`<div class="co-date" style="font-size:${Math.round(fontSize * 0.32)}px">${now.getDate()} ${MONTH_ABBR[now.getMonth()]} ${now.getFullYear()}</div>`);
  }

  clockEl.innerHTML = parts.join('');
}

function applyClockOverlay(cfg) {
  _clockConfig = cfg || { enabled: false };
  clockEl.className = 'pos-' + (_clockConfig.position || 'top-left');
  clockEl.style.color = _clockConfig.color || '#ffffff';

  if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }

  if (_clockConfig.enabled) {
    clockEl.style.display = 'block';
    renderClockOverlay();
    _clockTimer = setInterval(renderClockOverlay, 1000);
  } else {
    clockEl.style.display = 'none';
    clockEl.innerHTML = '';
  }
}

ipcRenderer.invoke('get-settings').then(s => {
  if (s && s.audioReactive) initAudioVisualizer();
  if (s && s.clockOverlay) applyClockOverlay(s.clockOverlay);
});

function hideAll() {
  videoEl.style.display = 'none';
  imageEl.style.display = 'none';
  webEl.style.display   = 'none';
  canvasEl.style.display = 'none';
  weSceneEl.style.display = 'none';
  videoEl.pause();
  webEl.src = 'about:blank';
  if (currentScene)   { currentScene.destroy();   currentScene = null; }
  if (currentWeScene) { currentWeScene.destroy(); currentWeScene = null; }
}

function showVideo(wallpaper) {
  hideAll();
  videoEl.style.display = 'block';
  videoEl.src = wallpaper.src;
  savedVolume = (wallpaper.volume ?? 50) / 100;
  videoEl.volume = savedVolume;
  videoEl.loop = true;
  videoEl.play().catch(() => {});
}

function showImage(wallpaper) {
  hideAll();
  const src = wallpaper.src;
  imageEl.src = src.match(/^[a-z]+:\/\//i) ? src : 'file:///' + src.replace(/\\/g, '/');
  imageEl.style.display = 'block';
}

function showWeb(wallpaper) {
  hideAll();
  webEl.style.display = 'block';
  
  // Apply saved properties when webview finishes loading
  const onDomReady = () => {
    // Inject audio listener bridge
    const audioCode = `
      window.wallpaperRegisterAudioListener = function(cb) {
        window._weAudioCallback = cb;
      };
    `;
    webEl.executeJavaScript(audioCode).catch(() => {});

    if (wallpaper.options && Object.keys(wallpaper.options).length > 0) {
      const propsObj = {};
      for (const [key, val] of Object.entries(wallpaper.options)) {
        propsObj[key] = { value: val };
      }
      const code = `
        if (window.wallpaperPropertyListener && window.wallpaperPropertyListener.applyUserProperties) {
          window.wallpaperPropertyListener.applyUserProperties(${JSON.stringify(propsObj)});
        }
      `;
      webEl.executeJavaScript(code).catch(() => {});
    }
    webEl.removeEventListener('dom-ready', onDomReady);
  };
  webEl.addEventListener('dom-ready', onDomReady);
  
  webEl.src = wallpaper.src;
}

function showScene(wallpaper) {
  hideAll();
  canvasEl.style.display = 'block';
  canvasEl.width  = window.innerWidth;
  canvasEl.height = window.innerHeight;

  const sceneMap = {
    particles:  'scenes/particles.js',
    waves:      'scenes/waves.js',
    matrix:     'scenes/matrix.js',
    aurora:     'scenes/aurora.js',
    visualizer: 'scenes/visualizer.js',
  };
  const file = sceneMap[wallpaper.scene] || sceneMap.particles;
  const SceneModule = require(path.join(__dirname, file));
  currentScene = new SceneModule(canvasEl, wallpaper.options || {});
  currentScene.start();
}

// Renders a real, unpacked Wallpaper Engine Workshop scene (background image
// + live clock/date/day text objects) instead of falling back to a frozen
// preview image. See we-scene-render.js.
function showWeScene(wallpaper) {
  hideAll();
  weSceneEl.style.display = 'block';
  const { WeScene } = require(path.join(__dirname, 'we-scene-render.js'));
  currentWeScene = new WeScene(weSceneEl, wallpaper.weSceneDir, wallpaper.weSceneOverrides);
  try {
    currentWeScene.start();
  } catch (err) {
    console.warn('[wallpaper] we-scene render failed, falling back to preview image:', err.message);
    showImage(wallpaper);
  }
}

let _activeWallpaper = null;
function setWallpaper(wallpaper) {
  if (!wallpaper) return;
  _activeWallpaper = wallpaper;
  
  let renderType = wallpaper.type;
  // Steam Workshop scenes use Wallpaper Engine's proprietary engine. If we
  // managed to unpack its scene.pkg (see we-scene-render.js), render it for
  // real; otherwise fall back to its frozen preview image.
  if (renderType === 'scene' && wallpaper.workshopId) {
    renderType = wallpaper.weSceneDir ? 'we-scene' : 'image';
  }

  switch (renderType) {
    case 'video':    showVideo(wallpaper);   break;
    case 'image':    showImage(wallpaper);   break;
    case 'url':      showWeb(wallpaper);     break;
    case 'scene':    showScene(wallpaper);   break;
    case 'we-scene': showWeScene(wallpaper); break;
    default: console.warn('[wallpaper] Unknown type:', renderType);
  }
}

ipcRenderer.on('set-wallpaper',    (_, w) => setWallpaper(w));
ipcRenderer.on('stop',             ()     => { hideAll(); });
ipcRenderer.on('unstop',           ()     => { if (_activeWallpaper) setWallpaper(_activeWallpaper); });
ipcRenderer.on('pause',            ()     => { videoEl.pause(); });
ipcRenderer.on('resume',           ()     => { videoEl.play().catch(() => {}); });
ipcRenderer.on('mute',             ()     => { videoEl.volume = 0; });
ipcRenderer.on('unmute',           (_, v) => { savedVolume = v / 100; videoEl.volume = savedVolume; });
ipcRenderer.on('update-settings',  (_, s) => {
  if (s.volume !== undefined) { savedVolume = s.volume / 100; videoEl.volume = savedVolume; }
  if (s.audioReactive !== undefined) {
    if (s.audioReactive && !audioContext) initAudioVisualizer();
    else if (!s.audioReactive && audioContext) {
      audioContext.close();
      audioContext = null;
      analyser = null;
      dataArray = null;
    }
  }
  if (s.clockOverlay !== undefined) applyClockOverlay(s.clockOverlay);
});

// ---- We-scene manual layout editing ----
async function exitWeSceneEditAndSave() {
  if (!currentWeScene || !currentWeScene.editing || !_activeWallpaper) return;
  const overrides = currentWeScene.exitEditMode();
  await ipcRenderer.invoke('we-scene-save-overrides', { wallpaperId: _activeWallpaper.id, overrides });
}

// Wallpaper windows are `focusable: false` on purpose (never steal focus from
// normal desktop use), so they never receive keydown — exiting edit mode has
// to be a mouse click, handled by the on-screen button (see we-scene-render.js).
ipcRenderer.on('we-scene-enter-edit', () => {
  if (currentWeScene) currentWeScene.enterEditMode(exitWeSceneEditAndSave);
});

window.addEventListener('resize', () => {
  canvasEl.width  = window.innerWidth;
  canvasEl.height = window.innerHeight;
  if (currentScene?.resize)   currentScene.resize(window.innerWidth, window.innerHeight);
  if (currentWeScene?.resize) currentWeScene.resize();
});

ipcRenderer.on('update-native-prop', (_, data) => {
  if (webEl.style.display === 'block') {
    const code = `
      if (window.wallpaperPropertyListener && window.wallpaperPropertyListener.applyUserProperties) {
        window.wallpaperPropertyListener.applyUserProperties({
          "${data.key}": { value: ${JSON.stringify(data.value)} }
        });
      }
    `;
    webEl.executeJavaScript(code).catch(() => {});
  }
});
