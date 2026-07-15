const { ipcRenderer } = require('electron');
const path = require('path');

const videoEl  = document.getElementById('video-layer');
const imageEl  = document.getElementById('image-layer');
const webEl    = document.getElementById('web-layer');
const canvasEl = document.getElementById('scene-layer');

let currentScene = null;
let savedVolume = 0.5;

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

function setWallpaper(wallpaper) {
  if (!wallpaper) return;
  switch (wallpaper.type) {
    case 'video': showVideo(wallpaper); break;
    case 'image': showImage(wallpaper); break;
    case 'url':   showWeb(wallpaper);   break;
    case 'scene': showScene(wallpaper); break;
    default: console.warn('[wallpaper] Unknown type:', wallpaper.type);
  }
}

ipcRenderer.on('set-wallpaper',    (_, w) => setWallpaper(w));
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
