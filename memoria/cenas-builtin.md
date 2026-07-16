# Cenas Built-in — Engine Wallpaper

Todas ficam em `wallpaper/scenes/`. Cada cena é uma classe com métodos `start()`, `stop()` e `resize()`.

---

## 1. Particles (`particles.js`) — Three.js

Campo de partículas 3D com física simples.

**Tecnologia:** Three.js (`require('three/build/three.cjs')`)

**Opções configuráveis:**
```javascript
{
  count: 3000,       // número de partículas
  color: '#4fc3f7',  // cor das partículas
  speed: 0.3,        // velocidade de movimento
  size: 1.5          // tamanho dos pontos
}
```

**Como funciona:**
- `BufferGeometry` com `count * 3` posições aleatórias em range `-100..100`
- Velocidades aleatórias por partícula (`velocities`)
- Camera perspectiva em `z = 80`, FOV 75°
- A cada frame: posições += velocidades, wrap quando saem dos bounds
- `WebGLRenderer` com alpha (fundo transparente)

---

## 2. Waves (`waves.js`) — Three.js

Plano wireframe animado com deformação por função seno.

**Tecnologia:** Three.js

**Opções configuráveis:**
```javascript
{
  color: '#00e5ff',
  speed: 0.5,
  amplitude: 2.0   // altura das ondas
}
```

**Como funciona:**
- `PlaneGeometry` com segmentos (grade densa)
- `MeshBasicMaterial` wireframe
- A cada frame: cada vértice Y = `sin(x * freq + time) * amplitude`
- Camera olhando levemente para baixo

---

## 3. Matrix (`matrix.js`) — Canvas 2D

Chuva de caracteres japoneses (estilo Matrix).

**Tecnologia:** Canvas 2D API (sem Three.js)

**Opções configuráveis:**
```javascript
{
  color: '#00ff41',  // cor dos caracteres (verde Matrix padrão)
  speed: 1.0,        // velocidade da chuva
  fontSize: 14       // tamanho da fonte
}
```

**Como funciona:**
- Colunas de caracteres que caem independentemente
- Cada coluna tem posição Y e timer aleatório de reset
- Background com alpha baixo para criar efeito de rastro (`rgba(0,0,0,0.05)`)
- Caracteres: mix de katakana e números

---

## 4. Aurora (`aurora.js`) — Canvas 2D

Animação de Aurora Boreal com gradientes suaves.

**Tecnologia:** Canvas 2D API

**Opções configuráveis:**
```javascript
{
  colors: ['#00f5a0', '#00d9f5', '#7b2ff7'],  // paleta de cores
  speed: 0.3
}
```

**Como funciona:**
- Múltiplas camadas de gradientes lineares com offset senoidal
- Cada camada tem fase e frequência independentes
- Mistura com `globalAlpha` e `globalCompositeOperation`
- Animação suave sem Three.js — leve e eficiente

---

## 5. Visualizer (`visualizer.js`) — Canvas 2D

Visualizador de áudio reativo em tempo real.

**Tecnologia:** Canvas 2D API

**Opções configuráveis:**
```javascript
{
  style: 'bars',     // 'bars' | 'wave' | 'circle'
  color: '#5a54f9',
  sensitivity: 1.0
}
```

**Como funciona:**
- Recebe dados de frequência via `audioData` (array 128 valores 0-1)
- `bars`: barras verticais como equalizer
- `wave`: linha contínua suavizada
- `circle`: forma radial centralizada
- Se não há áudio, exibe animação idle suave

---

## Como adicionar uma nova cena

1. Crie `wallpaper/scenes/minhasCena.js` com a classe:
```javascript
class MinhaCena {
  constructor(canvas, options = {}) { ... }
  start() { /* inicia animationFrame */ }
  stop() { /* cancela animationFrame, limpa recursos */ }
  resize(w, h) { /* adapta ao novo tamanho */ }
}
module.exports = MinhaCena;
```

2. Em `wallpaper/wallpaper.js`, no handler de `set-wallpaper`:
```javascript
case 'scene':
  const SceneClass = require(`./scenes/${wallpaper.sceneId}`);
  currentScene = new SceneClass(canvasEl, wallpaper.options);
  currentScene.start();
  break;
```

3. Em `ui/app.js`, adicione a cena nas opções de biblioteca/seleção.
