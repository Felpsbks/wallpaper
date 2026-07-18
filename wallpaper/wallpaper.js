const { ipcRenderer } = require('electron');
const path = require('path');

let videoEl      = document.getElementById('video-layer');
let videoElB     = document.getElementById('video-layer-b'); // hidden pre-buffer for the boomerang loop
const imageEl    = document.getElementById('image-layer');
const webEl      = document.getElementById('web-layer');
const canvasEl   = document.getElementById('scene-layer');
const weSceneEl  = document.getElementById('we-scene-layer');
const clockEl    = document.getElementById('clock-overlay');
const transitionEl = document.getElementById('transition-overlay');

let currentScene   = null;
let currentWeScene  = null;
let savedVolume = 0.5;

// Diagnostic: proves whether this renderer's JS is still executing when the
// visual content looks frozen, vs. JS running fine but paint/composite not
// refreshing — two very different bugs with different fixes. Forwarded to
// main.js -> the app's own log tab, no separate devtools window needed.
setInterval(() => {
  ipcRenderer.send('wallpaper-heartbeat', { display: `${window.innerWidth}x${window.innerHeight}`, ts: Date.now() });
}, 5000);

// FPS real deste wallpaper (contagem de frames via requestAnimationFrame,
// não um número inventado) — mandado pro painel de controle mostrar no
// bloco de sistema.
let _fpsFrameCount = 0;
let _fpsLastReport = performance.now();
function _fpsTick() {
  _fpsFrameCount++;
  const now = performance.now();
  const elapsed = now - _fpsLastReport;
  if (elapsed >= 1000) {
    ipcRenderer.send('wallpaper-fps', { fps: Math.round((_fpsFrameCount * 1000) / elapsed) });
    _fpsFrameCount = 0;
    _fpsLastReport = now;
  }
  requestAnimationFrame(_fpsTick);
}
requestAnimationFrame(_fpsTick);

// Diagnostic: this wallpaper window should be full click-through (mouse
// clicks pass to the desktop icons/apps behind it) — it should NEVER receive
// a real click. If this fires, click-through broke (possibly a side effect
// of the WS_CHILD/style changes in src/workerw.js) and clicks on the desktop
// are landing on us instead of passing through, which could plausibly
// trigger whatever is freezing the render.
window.addEventListener('mousedown', (e) => {
  ipcRenderer.send('wallpaper-click-received', { x: e.clientX, y: e.clientY, ts: Date.now() });
});

// Diagnostic: Chromium has its own internal "is this page visible/occluded"
// state, separate from whether its JS is running — it's tied to whether the
// renderer bothers compositing new frames at all. If Windows tells our
// window it's occluded right when the desktop is clicked (plausible, given
// we're now a real WS_CHILD sibling of the icons layer), this would fire and
// would explain a freeze that isn't a JS hang and isn't a re-embed.
document.addEventListener('visibilitychange', () => {
  ipcRenderer.send('wallpaper-visibility-change', { hidden: document.hidden, state: document.visibilityState, ts: Date.now() });
});

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
  videoElB.style.display = 'none';
  imageEl.style.display = 'none';
  webEl.style.display   = 'none';
  canvasEl.style.display = 'none';
  weSceneEl.style.display = 'none';
  videoEl.pause();
  videoElB.pause();
  // Pausar sozinho não solta o arquivo — o Chromium mantém o handle aberto
  // num <video> pausado. Isso já travou a Steam com "File locked" ao tentar
  // gravar num item do Workshop enquanto outro vídeo do Workshop tocava.
  // Limpar o src força o handle a ser liberado de verdade.
  videoEl.removeAttribute('src');
  videoEl.load();
  videoElB.removeAttribute('src');
  videoElB.load();
  webEl.src = 'about:blank';
  if (currentScene)   { currentScene.destroy();   currentScene = null; }
  if (currentWeScene) { currentWeScene.destroy(); currentWeScene = null; }
}

function attachVideoDiagnostics(el) {
  // el.play()'s own rejection only covers autoplay-policy failures — a
  // bad path, missing codec, or file that doesn't exist fails silently later
  // via the element's own 'error' event instead.
  el.addEventListener('error', () => {
    const err = el.error;
    ipcRenderer.send('wallpaper-video-error', {
      stage: 'load', code: err?.code, message: err?.message, src: el.src, ts: Date.now(),
    });
  });
}

function makeVideoElement(id) {
  const el = document.createElement('video');
  el.id = id;
  el.autoplay = true;
  el.muted = true;
  el.playsInline = true;
  el.style.display = 'none';
  attachVideoDiagnostics(el);
  return el;
}

// Reusing the same long-lived <video> element across many switches — just
// overwriting `.src` — could leave at least one specific real-world file
// (a 4K, audio-less Workshop video) stuck showing only its first frame,
// forever, with no error event and no crash, but *only* when switched into
// from a different video already playing (fine on a fresh page load). Rather
// than chase the exact internal Chromium state causing that one file to get
// stuck, sidestep the whole bug class: tear down and recreate both video DOM
// nodes on every genuine *wallpaper* switch instead of mutating them. Does
// NOT run on every boomerang segment swap (see armBoomerang below) — only
// when a different wallpaper is actually selected.
function recreateVideoElements() {
  const freshA = makeVideoElement('video-layer');
  const freshB = makeVideoElement('video-layer-b');
  videoEl.replaceWith(freshA);
  videoElB.replaceWith(freshB);
  videoEl = freshA;
  videoElB = freshB;
}

// "Bumerangue": toca o vídeo pra frente até quase o fim, troca (num segundo
// elemento, pré-carregado com antecedência) pra uma cópia do MESMO vídeo já
// invertida por FFmpeg (ver ensureReversedVideo em main.js), deixa ela tocar
// até o fim, troca de volta pro arquivo original, repete pra sempre. Como o
// último frame de um lado é literalmente o primeiro frame do outro (é o
// mesmo vídeo, só invertido), a troca é entre frames que já combinam — ao
// contrário da tentativa anterior de fazer isso lopando um único arquivo
// (ver [[project_video_switch_bugs]] "bug 5"), que crossfadeava frames sem
// nenhuma relação (fim x início do mesmo clipe) e por isso piscava. Troca é
// um corte instantâneo (display none/block), sem transição CSS nenhuma —
// lição da tentativa anterior: misturar (crossfade) dois frames é o que
// pareceu um flash, não o corte em si.
const PREBUFFER_LEAD_S = 0.28; // segundos antes do fim pra começar a pré-carregar o próximo segmento

function armBoomerang(front, currentSrc, nextSrc) {
  const onTimeUpdate = () => {
    const dur = front.duration;
    if (!dur || !isFinite(dur)) return;
    if (dur <= PREBUFFER_LEAD_S) {
      // Curto demais pra dar tempo de pré-carregar — troca direto no fim.
      front.removeEventListener('timeupdate', onTimeUpdate);
      front.addEventListener('ended', () => {
        front.src = nextSrc;
        front.currentTime = 0;
        front.play().catch(() => {});
        armBoomerang(front, nextSrc, currentSrc);
      }, { once: true });
      return;
    }
    if (front.currentTime < dur - PREBUFFER_LEAD_S) return;
    front.removeEventListener('timeupdate', onTimeUpdate);

    const back = (front === videoEl) ? videoElB : videoEl;
    back.src = nextSrc;
    back.volume = front.volume;
    back.currentTime = 0;
    back.play().catch(() => {});

    const onPlaying = () => {
      back.removeEventListener('playing', onPlaying);
      back.style.display = 'block';
      front.style.display = 'none';
      if (front === videoEl) { videoEl = back; videoElB = front; }
      else                   { videoElB = back; videoEl = front; }
      front.pause(); // lado antigo, agora oculto — congela até virar o próximo buffer
      armBoomerang(back, nextSrc, currentSrc); // alterna: o destino seguinte é o segmento de onde acabamos de sair
    };
    back.addEventListener('playing', onPlaying);
  };
  front.addEventListener('timeupdate', onTimeUpdate);
}

function showVideo(wallpaper) {
  hideAll();
  recreateVideoElements();
  videoEl.style.display = 'block';
  videoEl.src = wallpaper.src;
  savedVolume = (wallpaper.volume ?? 50) / 100;
  videoEl.volume = savedVolume;
  videoEl.loop = true; // padrão seguro até (e a menos que) a cópia invertida fique pronta
  videoEl.play().catch((err) => {
    ipcRenderer.send('wallpaper-video-error', { stage: 'play', message: err.message, src: videoEl.src, ts: Date.now() });
  });

  // Gera (ou reusa, se já em cache) a cópia invertida em segundo plano — não
  // bloqueia nada, o vídeo já está tocando normalmente com loop simples
  // enquanto isso. Só liga o bumerangue se, quando isso terminar, o usuário
  // ainda não tiver trocado de wallpaper.
  ipcRenderer.invoke('ensure-reversed-video', wallpaper.src).then((reversedSrc) => {
    if (!reversedSrc || _activeWallpaper !== wallpaper) return;
    videoEl.loop = false;
    armBoomerang(videoEl, wallpaper.src, reversedSrc);
  }).catch(() => {});

  // Diagnostic: some failures (this app's "7ucky's" repro) show the correct
  // first frame but never advance — no error event fires either, since
  // nothing about the load is actually invalid, it just never progresses.
  // Snapshot the element's real state a couple seconds in so we have actual
  // numbers (is it paused? does currentTime ever move? what dimensions did
  // it decode?) instead of guessing from symptoms alone.
  const snapshotSrc = videoEl.src;
  setTimeout(() => {
    if (videoEl.src !== snapshotSrc) return; // switched again since, stale
    ipcRenderer.send('wallpaper-video-state', {
      src: videoEl.src,
      paused: videoEl.paused,
      ended: videoEl.ended,
      currentTime: videoEl.currentTime,
      readyState: videoEl.readyState,
      networkState: videoEl.networkState,
      videoWidth: videoEl.videoWidth,
      videoHeight: videoEl.videoHeight,
      ts: Date.now(),
    });
  }, 3000);
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

  // Effective General Properties: each property's own default `value`,
  // overridden by whatever the user changed in the Properties modal.
  const propValues = {};
  if (wallpaper.properties) {
    for (const [key, prop] of Object.entries(wallpaper.properties)) propValues[key] = prop.value;
  }
  if (wallpaper.options) Object.assign(propValues, wallpaper.options);

  const label = wallpaper.name || wallpaper.workshopId;
  currentWeScene = new WeScene(weSceneEl, wallpaper.weSceneDir, wallpaper.weSceneOverrides, propValues, label);
  try {
    currentWeScene.start();
  } catch (err) {
    console.warn('[wallpaper] we-scene render failed, falling back to preview image:', err.message);
    ipcRenderer.send('we-scene-issue', { label, message: `cena não renderizou, caiu pro preview estático: ${err.message}` });
    showImage(wallpaper);
  }
}

let _activeWallpaper = null;
function applyWallpaperNow(wallpaper) {
  if (!wallpaper) return;
  _activeWallpaper = wallpaper;

  let renderType = wallpaper.type;
  // Steam Workshop scenes use Wallpaper Engine's proprietary engine. If we
  // managed to unpack its scene.pkg (see we-scene-render.js), render it for
  // real; otherwise fall back to its frozen preview image.
  if (renderType === 'scene' && wallpaper.workshopId) {
    renderType = wallpaper.weSceneDir ? 'we-scene' : 'image';
  }

  ipcRenderer.send('wallpaper-set-attempt', {
    id: wallpaper.id, name: wallpaper.name, type: wallpaper.type, renderType, src: wallpaper.src, ts: Date.now(),
  });

  switch (renderType) {
    case 'video':    showVideo(wallpaper);   break;
    case 'image':    showImage(wallpaper);   break;
    case 'url':      showWeb(wallpaper);     break;
    case 'scene':    showScene(wallpaper);   break;
    case 'we-scene': showWeScene(wallpaper); break;
    default: console.warn('[wallpaper] Unknown type:', renderType);
  }
}

// Fades to black, swaps the content underneath (instant, same as before),
// then fades back in — works uniformly for every wallpaper type since it
// never touches each type's own show*() logic, just hides the swap itself
// behind an opaque overlay. If a new switch arrives mid-transition, the
// newest one always wins; stale fade-in timers from a superseded switch are
// cancelled so they can't fight over the overlay's opacity afterwards.
const TRANSITION_MS = 350;
let _transitionToken = 0;
function setWallpaper(wallpaper) {
  if (!wallpaper) return;
  const token = ++_transitionToken;

  transitionEl.style.opacity = '1';
  setTimeout(() => {
    if (token !== _transitionToken) return; // superseded by a newer switch
    applyWallpaperNow(wallpaper);
    requestAnimationFrame(() => {
      if (token !== _transitionToken) return;
      transitionEl.style.opacity = '0';
    });
  }, TRANSITION_MS);
}

ipcRenderer.on('set-wallpaper',    (_, w) => setWallpaper(w));
ipcRenderer.on('stop',             ()     => { hideAll(); });
ipcRenderer.on('unstop',           ()     => { if (_activeWallpaper) setWallpaper(_activeWallpaper); });
ipcRenderer.on('pause',            ()     => { videoEl.pause(); videoElB.pause(); });
ipcRenderer.on('resume',           ()     => { videoEl.play().catch(() => {}); });
ipcRenderer.on('mute',             ()     => { videoEl.volume = 0; videoElB.volume = 0; });
ipcRenderer.on('unmute',           (_, v) => { savedVolume = v / 100; videoEl.volume = savedVolume; videoElB.volume = savedVolume; });
ipcRenderer.on('update-settings',  (_, s) => {
  if (s.volume !== undefined) { savedVolume = s.volume / 100; videoEl.volume = savedVolume; videoElB.volume = savedVolume; }
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
