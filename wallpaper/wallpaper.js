const { ipcRenderer } = require('electron');
const path = require('path');

const videoEl  = document.getElementById('video-layer');
const imageEl  = document.getElementById('image-layer');
const webEl    = document.getElementById('web-layer');
const canvasEl = document.getElementById('scene-layer');

let currentScene = null;
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

initAudioVisualizer();

function hideAll() {
  videoEl.style.display = 'none';
  imageEl.style.display = 'none';
  webEl.style.display   = 'none';
  canvasEl.style.display = 'none';
  videoEl.pause();
  webEl.src = 'about:blank';
  if (currentScene) { currentScene.destroy(); currentScene = null; }
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

let _activeWallpaper = null;
function setWallpaper(wallpaper) {
  if (!wallpaper) return;
  _activeWallpaper = wallpaper;
  switch (wallpaper.type) {
    case 'video': showVideo(wallpaper); break;
    case 'image': showImage(wallpaper); break;
    case 'url':   showWeb(wallpaper);   break;
    case 'scene': showScene(wallpaper); break;
    default: console.warn('[wallpaper] Unknown type:', wallpaper.type);
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
});

window.addEventListener('resize', () => {
  canvasEl.width  = window.innerWidth;
  canvasEl.height = window.innerHeight;
  if (currentScene?.resize) currentScene.resize(window.innerWidth, window.innerHeight);
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
