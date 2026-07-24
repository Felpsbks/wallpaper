// Transport-agnostic: works under both the Electron BrowserWindow host (today's
// production path) and the native WallpaperHost.exe (WebView2 compat mode, see
// project_workerw_fragility memory) via window.hostBridge (host-bridge.js,
// loaded before this file — see wallpaper/index.html). Never touch ipcRenderer
// or window.chrome.webview directly from this file again.

let videoEl      = document.getElementById('video-layer');
const imageEl    = document.getElementById('image-layer');
const canvasEl   = document.getElementById('scene-layer');
const weSceneEl  = document.getElementById('we-scene-layer');
const clockEl    = document.getElementById('clock-overlay');
const transitionEl = document.getElementById('transition-overlay');

let currentScene   = null;
let currentWeScene  = null;
let savedVolume = 0.5;
// Wallpaper tipo "web" (BrowserView, controlado pelo main.js — ver showWeb).
// Só existe no host Electron; no WallpaperHost.exe (WebView2), type:'url' é
// interceptado e tratado inteiramente do lado nativo, sem nunca chegar aqui.
let _webWallpaperActive = false;

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
    hostBridge.send('wallpaper-fps', { fps: Math.round((_fpsFrameCount * 1000) / elapsed) });
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
  hostBridge.send('wallpaper-click-received', { x: e.clientX, y: e.clientY, ts: Date.now() });
});

// Diagnostic: Chromium has its own internal "is this page visible/occluded"
// state, separate from whether its JS is running — it's tied to whether the
// renderer bothers compositing new frames at all. If Windows tells our
// window it's occluded right when the desktop is clicked (plausible, given
// we're now a real WS_CHILD sibling of the icons layer), this would fire and
// would explain a freeze that isn't a JS hang and isn't a re-embed.
document.addEventListener('visibilitychange', () => {
  hostBridge.send('wallpaper-visibility-change', { hidden: document.hidden, state: document.visibilityState, ts: Date.now() });
});

let audioContext = null;
let analyser = null;
let dataArray = null;

async function initAudioVisualizer() {
  try {
    const sourceId = await hostBridge.invoke('get-desktop-audio-source');
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
  if (analyser && dataArray && _webWallpaperActive) {
    analyser.getByteFrequencyData(dataArray);

    const weArray = new Array(128).fill(0);
    for (let i = 0; i < 64; i++) {
      const val = (dataArray[i] || 0) / 255.0;
      weArray[i] = val;
      weArray[i + 64] = val;
    }

    hostBridge.send('web-wallpaper-audio-data', weArray);
  }
  requestAnimationFrame(updateAudioData);
}

// ---- Clock/date overlay ----
const MONTH_ABBR = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
let _clockTimer  = null;
let _clockConfig = null;
let _currentRenderType = null;

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

  // WE scenes render their own native clock/date objects when the scene
  // defines them — our own overlay on top would duplicate it (confirmed
  // live 2026-07-18: a ghost clock floating above the scene's real one,
  // "Music Visualizer" has its own datetime widget already).
  if (_clockConfig.enabled && _currentRenderType !== 'we-scene') {
    clockEl.style.display = 'block';
    renderClockOverlay();
    _clockTimer = setInterval(renderClockOverlay, 1000);
  } else {
    clockEl.style.display = 'none';
    clockEl.innerHTML = '';
  }
}

hostBridge.invoke('get-settings').then(s => {
  if (s && s.audioReactive) initAudioVisualizer();
  if (s && s.clockOverlay) applyClockOverlay(s.clockOverlay);
});

function hideAll() {
  videoEl.style.display = 'none';
  imageEl.style.display = 'none';
  canvasEl.style.display = 'none';
  weSceneEl.style.display = 'none';
  videoEl.pause();
  // Pausar sozinho não solta o arquivo — o Chromium mantém o handle aberto
  // num <video> pausado. Isso já travou a Steam com "File locked" ao tentar
  // gravar num item do Workshop enquanto outro vídeo do Workshop tocava.
  // Limpar o src força o handle a ser liberado de verdade.
  videoEl.removeAttribute('src');
  videoEl.load();
  // Só esconde/reseta o BrowserView do wallpaper "web" se ele estava mesmo
  // em uso — mesma cautela que já existia com a antiga <webview>. No modo
  // WebView2, _webWallpaperActive nunca fica true (showWeb não roda lá).
  if (_webWallpaperActive) {
    _webWallpaperActive = false;
    hostBridge.send('web-wallpaper-hide');
  }
  if (currentScene)   { currentScene.destroy();   currentScene = null; }
  if (currentWeScene) { currentWeScene.destroy(); currentWeScene = null; }
}

function attachVideoDiagnostics(el) {
  // el.play()'s own rejection only covers autoplay-policy failures — a
  // bad path, missing codec, or file that doesn't exist fails silently later
  // via the element's own 'error' event instead.
  el.addEventListener('error', () => {
    const err = el.error;
    hostBridge.send('wallpaper-video-error', {
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
// stuck, sidestep the whole bug class: tear down and recreate the video DOM
// node on every genuine *wallpaper* switch instead of mutating it.
function recreateVideoElements() {
  const fresh = makeVideoElement('video-layer');
  videoEl.replaceWith(fresh);
  videoEl = fresh;
}

// Caminhos locais de wallpaper vêm como path bruto do Windows (ex:
// "C:\Users\...\video.mp4"), nunca uma URL — sob o Electron isso funciona
// porque a própria página é servida via file://, e o resolvedor de URL do
// Chromium aceita um path com letra de unidade de boa nesse caso. Debaixo do
// WebView2 (MainForm.cs), a shell é servida via https://wallpaper.local — um
// path bruto vira uma URL relativa inválida ali, o <video> nunca carrega nada
// e a tela fica preta sólida (sem nenhum erro visível). MainForm.cs já mapeia
// cada letra de unidade como https://localfs-<letra>/ especificamente pra
// isso — só faltava alguém converter o path antes de atribuir a .src.
function toPlayableSrc(rawSrc) {
  if (!rawSrc) return rawSrc;
  if (/^[a-z]+:\/\//i.test(rawSrc)) return rawSrc; // já é uma URL (http(s)/file/etc)
  if (!hostBridge.isWebView2) return rawSrc; // Electron: path bruto já funciona como está
  const m = rawSrc.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return rawSrc;
  const drive = m[1].toLowerCase();
  const rest = m[2].split(/[\\/]/).map(encodeURIComponent).join('/');
  return `https://localfs-${drive}/${rest}`;
}

function showVideo(wallpaper) {
  hideAll();
  recreateVideoElements();
  videoEl.style.display = 'block';
  videoEl.src = toPlayableSrc(wallpaper.src);
  savedVolume = (wallpaper.volume ?? 50) / 100;
  videoEl.volume = savedVolume;
  videoEl.loop = true;
  // makeVideoElement() sempre cria o elemento com muted=true — obrigatório
  // pra autoplay funcionar (o Chromium bloqueia autoplay com som, só permite
  // autoplay mudo). Sem desmutar de novo depois que o play() realmente
  // começa, o som nunca toca em wallpaper nenhum, não importa o volume —
  // bug real, .muted sempre vence sobre .volume. Só desmuta DEPOIS do
  // play() resolver (não antes/junto), senão o autoplay é rejeitado de novo.
  videoEl.play().then(() => {
    videoEl.muted = savedVolume <= 0;
  }).catch((err) => {
    hostBridge.send('wallpaper-video-error', { stage: 'play', message: err.message, src: videoEl.src, ts: Date.now() });
  });

  // Diagnostic: some failures (this app's "7ucky's" repro) show the correct
  // first frame but never advance — no error event fires either, since
  // nothing about the load is actually invalid, it just never progresses.
  // Snapshot the element's real state a couple seconds in so we have actual
  // numbers (is it paused? does currentTime ever move? what dimensions did
  // it decode?) instead of guessing from symptoms alone.
  const snapshotSrc = videoEl.src;
  setTimeout(() => {
    if (videoEl.src !== snapshotSrc) return; // switched again since, stale
    hostBridge.send('wallpaper-video-state', {
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
  // file:/// funciona sob o Electron, mas o WebView2 bloqueia como mixed
  // content vindo de https://wallpaper.local (ver comentário de
  // toPlayableSrc acima) — mesma conversão pro caso de imagem cair aqui como
  // fallback (ex: erro ao renderizar cena WE) mesmo no modo de compatibilidade.
  imageEl.src = hostBridge.isWebView2
    ? toPlayableSrc(src)
    : (src.match(/^[a-z]+:\/\//i) ? src : 'file:///' + src.replace(/\\/g, '/'));
  imageEl.style.display = 'block';
}

// Wallpaper tipo "web": renderizado via BrowserView, controlado pelo processo
// principal (ver main.js). Achado ao vivo (2026-07-21): a tag <webview> desta
// versão do Electron tem um bug interno não contornável — o canal que
// sincroniza o tamanho do conteúdo com o elemento host falha sempre,
// travando a altura da página em 150px mesmo com o host do tamanho certo.
// BrowserView é a superfície nativa que a própria Electron recomenda no
// lugar de <webview> justamente por causa desse tipo de bug.
// Só roda debaixo do Electron — no host WebView2 (WallpaperHost.exe), type
// 'url' nunca chega até aqui: é interceptado e tratado direto do lado nativo
// (ShowWebWallpaper em MainForm.cs), antes de repassar qualquer coisa pra
// esta página.
function showWeb(wallpaper) {
  hideAll();
  _webWallpaperActive = true;
  hostBridge.send('web-wallpaper-show', { src: wallpaper.src, options: wallpaper.options, properties: wallpaper.properties });
}

function showScene(wallpaper) {
  hideAll();
  // require() só existe sob o Electron (nodeIntegration) — cenas/partículas
  // continuam exclusivas desse host por enquanto. O toggle "Modo de
  // compatibilidade (WebView2)" nas Configurações troca TODAS as janelas de
  // wallpaper pro WallpaperHost.exe, não só as de vídeo/YouTube — se o
  // usuário tiver esse modo ligado e escolher uma cena mesmo assim, falha
  // limpo aqui em vez de estourar um ReferenceError não tratado.
  if (typeof require !== 'function') {
    console.warn('[wallpaper] Cenas não são suportadas no Modo de compatibilidade (WebView2).');
    hostBridge.send('we-scene-issue', { label: wallpaper.name || wallpaper.id, message: 'cenas não são suportadas no Modo de compatibilidade (WebView2) — troque pra vídeo/YouTube ou desligue o modo nas Configurações.' });
    return;
  }
  canvasEl.style.display = 'block';
  canvasEl.width  = window.innerWidth;
  canvasEl.height = window.innerHeight;

  const path = require('path');
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
// preview image. See we-scene-render.js. Electron-only, same reasoning as
// showScene above.
function showWeScene(wallpaper) {
  hideAll();
  // Mesmo motivo do guard em showScene acima — sem require() debaixo do
  // WebView2 (Modo de compatibilidade), falha limpo pro fallback de preview
  // em vez de estourar um ReferenceError não tratado.
  if (typeof require !== 'function') {
    console.warn('[wallpaper] Cenas WE não são suportadas no Modo de compatibilidade (WebView2).');
    hostBridge.send('we-scene-issue', { label: wallpaper.name || wallpaper.workshopId, message: 'cenas WE não são suportadas no Modo de compatibilidade (WebView2) — troque pra vídeo/YouTube ou desligue o modo nas Configurações.' });
    showImage(wallpaper);
    return;
  }
  weSceneEl.style.display = 'block';
  const path = require('path');
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
    hostBridge.send('we-scene-issue', { label, message: `cena não renderizou, caiu pro preview estático: ${err.message}` });
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
  _currentRenderType = renderType;
  applyClockOverlay(_clockConfig); // re-avalia visibilidade pro novo renderType

  hostBridge.send('wallpaper-set-attempt', {
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

hostBridge.on('set-wallpaper',    (w) => setWallpaper(w));
hostBridge.on('stop',             ()  => { hideAll(); });
hostBridge.on('unstop',           ()  => { if (_activeWallpaper) setWallpaper(_activeWallpaper); });
hostBridge.on('pause',            ()  => { videoEl.pause(); });
hostBridge.on('resume',           ()  => { videoEl.play().catch(() => {}); });
hostBridge.on('mute',             ()  => { videoEl.muted = true; });
hostBridge.on('unmute',           (v) => { savedVolume = v / 100; videoEl.volume = savedVolume; videoEl.muted = savedVolume <= 0; });
hostBridge.on('update-settings',  (s) => {
  if (s.volume !== undefined) { savedVolume = s.volume / 100; videoEl.volume = savedVolume; videoEl.muted = savedVolume <= 0; }
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
  await hostBridge.invoke('we-scene-save-overrides', { wallpaperId: _activeWallpaper.id, overrides });
}

// Wallpaper windows are `focusable: false` on purpose (never steal focus from
// normal desktop use), so they never receive keydown — exiting edit mode has
// to be a mouse click, handled by the on-screen button (see we-scene-render.js).
hostBridge.on('we-scene-enter-edit', () => {
  if (currentWeScene) currentWeScene.enterEditMode(exitWeSceneEditAndSave);
});

window.addEventListener('resize', () => {
  canvasEl.width  = window.innerWidth;
  canvasEl.height = window.innerHeight;
  if (currentScene?.resize)   currentScene.resize(window.innerWidth, window.innerHeight);
  if (currentWeScene?.resize) currentWeScene.resize();
});

// Wallpaper "web" agora é um BrowserView controlado pelo main.js, que já
// encaminha update-native-prop direto pra view ativa (ver ipcMain.on lá).
