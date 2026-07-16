# Módulo Wallpaper — Engine Wallpaper

Arquivos: `wallpaper/index.html` e `wallpaper/wallpaper.js`

Cada monitor tem sua própria instância desta janela (renderer process separado).

---

## Camadas de renderização (`wallpaper/index.html`)

A janela do wallpaper usa 4 camadas sobrepostas em `position: absolute; inset: 0`:

```html
<video   id="video-layer">   <!-- Vídeos (MP4, WebM, etc.) -->
<img     id="image-layer">   <!-- Imagens (PNG, JPG, etc.) -->
<webview id="web-layer">     <!-- Websites embutidos (URL) -->
<canvas  id="scene-layer">   <!-- Cenas 3D/2D nativas (Three.js/Canvas2D) -->
```

Apenas uma camada fica visível por vez (`display: block/none`).

---

## `wallpaper/wallpaper.js` — Lógica central

### Variáveis globais

```javascript
let currentScene = null;   // instância da cena ativa (particles, waves, etc.)
let savedVolume = 0.5;     // volume salvo para restore após mute
let audioContext = null;
let analyser = null;
let dataArray = null;
```

### Tipos de wallpaper e renderização

| Tipo | Camada ativada | Comportamento |
|------|---------------|---------------|
| `video` | `#video-layer` | `videoEl.src = path`, `.play()` |
| `image` | `#image-layer` | `imageEl.src = path` |
| `url` | `#web-layer` | `webEl.src = url` |
| `scene` | `#scene-layer` | Importa e instancia a classe da cena |

---

## Sistema de áudio

### Captura de áudio do desktop

```javascript
async function initAudioVisualizer() {
  const sourceId = await ipcRenderer.invoke('get-desktop-audio-source');
  
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop' } },
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
  });
  
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  dataArray = new Uint8Array(analyser.frequencyBinCount); // 128 values
}
```

### Injeção de áudio em webviews

Para wallpapers do tipo `url` (websites com Wallpaper Engine), o áudio é injetado via `executeJavaScript`:

```javascript
// Converte 64 bins → array de 128 (espelhado)
const weArray = new Array(128).fill(0);
for (let i = 0; i < 64; i++) {
  const val = dataArray[i] / 255.0;
  weArray[i] = val;        // primeira metade
  weArray[i + 64] = val;   // segunda metade (espelho)
}

webEl.executeJavaScript(`
  if (window._weAudioCallback) {
    window._weAudioCallback(${JSON.stringify(weArray)});
  }
`);
```

O callback `window._weAudioCallback` é a convenção do Wallpaper Engine para receber dados de áudio.

---

## IPC recebido pelo wallpaper (ipcRenderer.on)

| Canal | Ação |
|-------|------|
| `set-wallpaper` | Carrega novo wallpaper (limpa estado anterior, inicia novo) |
| `pause-wallpaper` | Pausa vídeo ou cena |
| `resume-wallpaper` | Retoma vídeo ou cena |
| `mute-wallpaper` | Muta/desmuta vídeo, salva/restaura volume |
| `set-volume` | Define volume do vídeo |
