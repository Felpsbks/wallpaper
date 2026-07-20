// Renders an unpacked Wallpaper Engine scene folder (background image +
// live text objects + particle effects + real WebGL post-processing
// effects) instead of their proprietary engine. 3D model/PBR shaders
// (skinning, morph targets) are still silently skipped — those would need
// a much bigger vertical (real bone/morph animation), not attempted here.
const fs   = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { decodeTexToPng, decodePuppetMdl } = require('../src/we-scene.js');
const { compileGenericEffectSource, coerceUniformValue } = require('./we-shader-compiler.js');

// Formatos/recursos que a cena usa mas ainda não sabemos desenhar direito
// hoje falham em silêncio (nada no console de uma janela de wallpaper é
// visível sem abrir o devtools manualmente). Manda pro processo principal,
// que já loga na aba Log do app — mesmo caminho que outros avisos de
// wallpaper já usam.
function reportSceneIssue(label, message) {
  console.warn('[we-scene]', label || '', message);
  ipcRenderer.send('we-scene-issue', { label, message });
}

// Some particle systems (and other assets) reference materials that ship
// with Wallpaper Engine itself rather than inside the Workshop item's own
// package — e.g. "materials/particle/halo" is one of WE's built-in stock
// glow sprites, reused by many community particle effects instead of each
// one bundling its own copy. Resolved once and cached for the process.
let _weAssetsRoot;
function getWEAssetsRoot() {
  if (_weAssetsRoot !== undefined) return _weAssetsRoot;
  let steamPath = '';
  try {
    const out = require('child_process').execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').toString();
    const match = out.match(/SteamPath\s+REG_SZ\s+(.*)/i);
    if (match) steamPath = match[1].trim();
  } catch (_) {}
  if (!steamPath) steamPath = 'C:\\Program Files (x86)\\Steam';
  const assetsPath = path.join(steamPath, 'steamapps', 'common', 'wallpaper_engine', 'assets');
  _weAssetsRoot = fs.existsSync(assetsPath) ? assetsPath : null;
  return _weAssetsRoot;
}

// Wallpaper Engine text objects carry their live-update logic as real,
// embedded JavaScript (an ES-module-flavored script with an `update(value)`
// export). We run that exact script instead of reimplementing its format
// logic, so behavior (24h/12h, day names, delimiters, etc.) matches the
// original author's configuration exactly. `createScriptProperties()` is a
// no-op builder here because we already have the resolved property values
// straight from scene.json — we don't need to replay the WE editor's UI.
//
// Security note: this executes author-provided script from a downloaded
// Workshop item via `new Function`, with full access to this renderer's
// scope (nodeIntegration is on for wallpaper windows). That's the same
// trust boundary the app already extends to Workshop web wallpapers loaded
// via <webview>, not a new category of exposure — but worth knowing.
function compileWeTextScript(scriptSource, realProps) {
  const cleaned = scriptSource.replace(/^\s*export\s+/gm, '');
  const factory = new Function('createScriptProperties', cleaned + '\n;return update;');

  function createScriptProperties() {
    const obj = { ...realProps };
    const chain = {
      addCheckbox: () => chain, addText: () => chain, addCombo: () => chain,
      addSlider: () => chain, addColor: () => chain, addBool: () => chain,
      finish: () => obj,
    };
    return chain;
  }

  return factory(createScriptProperties);
}

// Detects whether a decoded particle texture is a baked animation grid
// (many frames in one image, e.g. a smoke puff growing/dissipating) rather
// than a single sprite. WE's real engine reads the true frame count from a
// `SPRITESHEET` shader combo + `g_RenderVar1` uniform (confirmed by reading
// the real genericparticle.frag/.vert + common_particles.h shader source
// from the local WE install) — that value isn't present anywhere in the
// scene/particle/material JSON we have access to, so it can't be read
// directly. Inferred instead from a real, consistent pattern found across
// every stock WE grid texture actually decoded so far (particle/fog/fog1,
// particle/fire/fire1, particle/debris/debris1, particle/lightning/lightning1):
// every one of them tiles in exact 128x128 cells, while every confirmed
// single-sprite texture (particle/drop 32x128, particle/chromaticdot 64x64,
// the various particle/halo* 64x64/128x128-as-one-frame sprites) is smaller
// than 128 in at least one dimension or isn't a clean multiple of it. This
// is a heuristic grounded in real samples, not a documented field — if a
// texture turns up that breaks the pattern (a single sprite that happens to
// be a multiple of 128, or a grid with a different cell size), this is the
// place to reconsider it.
function detectSpriteGrid(width, height) {
  const CELL = 128;
  if (width < CELL || height < CELL || width % CELL !== 0 || height % CELL !== 0) return null;
  const cols = width / CELL, rows = height / CELL;
  if (cols * rows <= 1) return null;
  return { cols, rows, totalFrames: cols * rows };
}

// Resolves a particle's `material` JSON to a drawable <img>, trying the
// scene's own materials/ folder first and falling back to Wallpaper
// Engine's bundled stock assets (see getWEAssetsRoot). Decodes on the fly
// via decodeTexToPng — particle sprites are small (a few KB), so there's no
// need to cache a file to disk for this.
function loadParticleTexture(sceneDir, materialRelPath) {
  return new Promise((resolve) => {
    try {
      const materialPath = path.join(sceneDir, materialRelPath);
      if (!fs.existsSync(materialPath)) return resolve(null);
      const material = JSON.parse(fs.readFileSync(materialPath, 'utf8'));
      const pass = material.passes && material.passes[0];
      const texRel = pass && pass.textures && pass.textures[0];
      if (!texRel) return resolve(null);
      const additive = pass.blending === 'additive';

      const candidates = [
        path.join(sceneDir, 'materials', texRel + '.tex'),
      ];
      const weAssets = getWEAssetsRoot();
      if (weAssets) candidates.push(path.join(weAssets, 'materials', texRel + '.tex'));

      for (const texPath of candidates) {
        if (!fs.existsSync(texPath)) continue;
        const png = decodeTexToPng(fs.readFileSync(texPath));
        if (!png) continue;
        const img = new Image();
        img.onload = () => resolve({ img, additive, grid: detectSpriteGrid(img.naturalWidth, img.naturalHeight) });
        img.onerror = () => resolve(null);
        img.src = 'data:image/png;base64,' + png.toString('base64');
        return;
      }
      resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

// ---- Efeito real "foliagesway" via WebGL ----
// Tradução direta (não aproximação) dos shaders reais de
// assets/effects/foliagesway/{foliagesway.vert,foliagesway.frag} da
// instalação local da Wallpaper Engine, adaptados de um dialeto próprio
// (mistura de convenções HLSL/GLSL com macros como mul/frac/saturate/CAST4/
// texSample2D injetadas pelo compilador deles, não presentes em disco) para
// GLSL ES 1.00 (WebGL1) real:
//   - mul(v, M)      -> WebGL não precisa: renderizamos um quad de tela
//                        cheia direto em clip space, sem matriz de câmera
//                        3D (não temos uma pra objetos 2D de fundo) — ver
//                        nota no vertex shader abaixo.
//   - frac/saturate/CAST2/CAST4/texSample2D -> substituídos inline por
//                        fract/clamp/vec2/vec4/texture2D (equivalentes
//                        diretos, não são aproximações).
// Só o branch MODE==0 ("UV", o modo default e o único usado nas 3 instâncias
// reais da cena da Akame) foi portado — MODE==1 ("Vertex", deslocamento real
// de vértice de malha) exigiria um objeto com malha subdividida, que não
// existe aqui (nossos objetos são um quad simples). Simplificação assumida
// e não confirmada: a correção de proporção `g_Texture1Resolution` pra
// quando a máscara tem resolução MUITO diferente da base foi omitida —
// usamos o mesmo UV normalizado pra base e máscara, o que é geometricamente
// correto quando as duas têm a mesma proporção (confirmado nas 2 máscaras
// reais da Akame: 1920x1080, metade da base 3840x2160, mesma proporção
// 16:9) mas pode ficar errado se algum dia aparecer uma cena com máscara em
// proporção diferente da base.
const FOLIAGESWAY_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
uniform vec4 g_Texture0Resolution; // (invW, invH, W, H) — aspect = z/w, confirmado contra o vertex shader real
uniform float g_NoiseScale;
uniform float g_Ratio;
uniform float g_Direction;
uniform float g_Strength;
varying vec4 v_TexCoordNoise;
varying vec3 v_Params;
varying vec4 v_TexCoord;

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main() {
  // Y invertido de propósito: framebuffers intermediários (as texturas dos
  // passes encadeados) não recebem o auto-flip de exibição que o canvas
  // final recebe do navegador — sem isso a imagem sai de cabeça pra baixo.
  gl_Position = vec4(a_Position.x, -a_Position.y, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  v_TexCoord.zw = a_TexCoord; // ver nota de simplificação acima

  float aspect = g_Texture0Resolution.z / g_Texture0Resolution.w * g_Ratio;
  v_TexCoordNoise.zw = rotateVec2(vec2(1.0 / aspect, aspect), g_Direction);
  v_TexCoordNoise.xy = a_TexCoord.xy * g_NoiseScale;

  v_Params.xy = rotateVec2(a_TexCoord.xy, g_Direction);
  v_Params.z = g_Strength * g_Strength * 0.005;
}
`;

const FOLIAGESWAY_FRAG = `
precision highp float;
uniform sampler2D g_Texture0; // imagem de entrada (base ou saída do passe anterior)
uniform sampler2D g_Texture1; // máscara de opacidade (onde o balanço se aplica)
uniform sampler2D g_Texture2; // ruído (assets/materials/util/noise.tex da própria WE)
uniform float g_Speed;  // material key real: "speeduv"
uniform float g_Power;
uniform float g_Phase;
uniform float g_Time;
varying vec4 v_TexCoordNoise;
varying vec3 v_Params;
varying vec4 v_TexCoord;

void main() {
  vec3 noise = texture2D(g_Texture2, v_TexCoordNoise.xy).rgb;
  float amp = v_Params.z;
  amp *= texture2D(g_Texture1, v_TexCoord.zw).r;

  float phase = (noise.g * 6.28318530718 + v_Params.x * 10.0 + v_Params.y * 5.0) * g_Phase;
  vec4 sines = vec4(phase) + g_Speed * g_Time * vec4(1.0, -0.16161616, 0.0083333, -0.00019841);
  sines = sin(sines);
  vec4 csines = vec4(0.4 + phase) + g_Speed * g_Time * vec4(-0.5, 0.041666666, -0.0013888889, 0.000024801587);
  csines = sin(csines);

  sines = pow(abs(sines), vec4(g_Power)) * sign(sines);
  csines = pow(abs(csines), vec4(g_Power)) * sign(csines);

  vec2 texCoordOffset;
  texCoordOffset.x = v_TexCoordNoise.z * dot(sines, vec4(amp));
  texCoordOffset.y = v_TexCoordNoise.w * dot(csines, vec4(amp));
  gl_FragColor = texture2D(g_Texture0, texCoordOffset + v_TexCoord.xy);
}
`;

// Shader mínimo pra malha de puppet: só posiciona e amostra a textura, sem
// nenhum efeito — o objetivo aqui é validar a geometria/UV, não estilizar.
const PUPPET_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
  v_TexCoord = a_TexCoord;
  gl_Position = vec4(a_Position, 0.0, 1.0);
}
`;
const PUPPET_FRAG = `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
void main() {
  gl_FragColor = texture2D(g_Texture0, v_TexCoord);
}
`;

// ---- Efeito real "chromatic aberration" via WebGL ----
// Porta quase byte-a-byte shaders/effects/chromatic_aberration.frag/.vert da
// instalação local da WE (mesma versão 2.8.42 usada no resto do projeto).
// Único ajuste mecânico: texSample2D->texture2D, CAST2(x)->vec2(x) (idênticos
// em GLSL puro) e rotateVec2 inlined (vem de common.h). MASK (textura de
// opacidade) não suportado — mesmo padrão do foliagesway/lightshafts: sem
// arquivo real que use isso pra validar contra, então pula em vez de
// adivinhar. Efeito estático (o shader real não tem g_Time/animação nenhuma),
// então renderiza uma vez só — sem custo de RAF loop pra sempre.
const CHROMATIC_ABERRATION_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
void main() {
  v_TexCoord = a_TexCoord.xyxy;
  gl_Position = vec4(a_Position, 0.0, 1.0);
}
`;

function buildChromaticAberrationFragSource({ mode, variation }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float u_Direction;
uniform float u_Strength;
uniform float u_CenterFalloff;
uniform vec2 u_Center;
#define MODE ${mode}
#define VARIATION ${variation}

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

#if MODE == 3
vec2 BC(vec2 coords, in float amt) {
  coords = coords * vec2(2.0) - vec2(1.0);
  float v = coords.x * coords.x + coords.y * coords.y;
  coords *= vec2(1.0 + amt * v);
  coords = coords * vec2(0.5) + vec2(0.5);
  return coords;
}
#endif

void main() {
  vec2 delta = v_TexCoord.xy - u_Center;

#if MODE == 0
  float falloff = mix(0.5 / (length(delta) + 0.0001), 1.0, u_CenterFalloff);
  delta *= u_Strength * 0.01 * falloff;
  vec2 coords0 = v_TexCoord.xy + delta;
  vec2 coords1 = v_TexCoord.xy - delta;
#endif

#if MODE == 1
  vec2 direction = vec2(-sin(u_Direction), cos(u_Direction));
  float falloff = mix(1.0, abs(dot(direction, delta)) * 2.0, u_CenterFalloff);
  direction *= u_Strength * 0.01 * falloff;
  vec2 coords0 = v_TexCoord.xy + direction;
  vec2 coords1 = v_TexCoord.xy - direction;
#endif

#if MODE == 2
  float falloff = mix(0.5 / (length(delta) + 0.0001), 1.0, u_CenterFalloff);
  float amt = u_Strength * 0.01 * falloff;
  vec2 coords0 = u_Center + rotateVec2(delta, amt);
  vec2 coords1 = u_Center + rotateVec2(delta, -amt);
#endif

#if MODE == 3
  vec2 refCoords = v_TexCoord.xy;
  refCoords -= vec2(0.5);
  refCoords *= vec2(1.0 - u_Strength * 0.0125);
  refCoords += vec2(0.5);
  vec2 coords0 = BC(refCoords, u_Strength * 0.05);
  vec2 coords1 = BC(refCoords, u_Strength * -0.02);
#endif

  vec4 sc = texture2D(g_Texture0, v_TexCoord.xy);
  vec4 s0 = texture2D(g_Texture0, coords0);
  vec4 s1 = texture2D(g_Texture0, coords1);

  vec4 albedo = sc;

#if VARIATION == 0
  albedo.r = s0.r;
  albedo.b = s1.b;
#endif

#if VARIATION == 1
  albedo.g = s1.g;
  albedo.b = s0.b;
#endif

#if VARIATION == 2
  albedo.g = s0.g;
  albedo.r = s1.r;
#endif

  gl_FragColor = albedo;
}
`;
}

// Lê o efeito real "chromatic aberration" anexado a um objeto (scene.json
// objects[].effects[].file terminando em "chromaticaberration/effect.json").
// Defaults vindos direto dos comentários `// {"material":...,"default":...}`
// do shader real, não inventados: mode=0 (expansão), variation=0
// (vermelho-azul), direction=90°, strength=1, centerFalloff=1, center=(.5,.5).
function extractChromaticAberrationConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('chromaticaberration/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    const csv = pass.constantshadervalues || {};
    const center = csvVec(csv.center, [0.5, 0.5]);
    return {
      mode: combos.MODE != null ? combos.MODE : 0,
      variation: combos.VARIATION != null ? combos.VARIATION : 0,
      direction: csvNum(csv.direction, 1.57079632679),
      strength: csvNum(csv.strength, 1),
      centerFalloff: csvNum(csv.centerfalloff, 1),
      center,
    };
  }
  return null;
}

// ---- Efeito real "VHS" via WebGL ----
// Porta shaders/effects/vhs.frag/.vert reais da instalação local da WE
// (effects/vhs/effect.json). Só suporta BLENDMODE==12 (Soft Light — o
// default real do shader) e MASK==0 (sem textura de opacidade) — mesmo
// padrão de "não adivinha combinação não validada" do lightshafts/foliagesway.
// GREYSCALE e INVERTARTIFACTS (ambos toggles simples) são suportados de
// verdade, lendo o valor real do scene.json quando presente.
const VHS_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
varying vec2 v_TexCoordGlitchBase;
varying vec4 v_TexCoordGlitch;
varying vec4 v_TexCoordNoise;
varying vec4 v_TexCoordVHSNoise;

uniform float g_Time;
uniform float g_NoiseScale;
uniform float g_Chromatic;
uniform float g_ArtifactsScale;
uniform float g_NoiseAlpha;
uniform float g_Aspect;

void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);

  float t = fract(g_Time);
  v_TexCoord = a_TexCoord.xyxy;
  v_TexCoordNoise.xy = (a_TexCoord.xy + t) * g_NoiseScale;
  v_TexCoordNoise.zw = (a_TexCoord.xy - t * 2.5) * g_NoiseScale * 0.52;
  v_TexCoordNoise *= vec4(g_Aspect, 1.0, g_Aspect, 1.0);

  v_TexCoordVHSNoise.xy = v_TexCoordNoise.xy * vec2(0.1, 10.0) * g_ArtifactsScale;
  v_TexCoordVHSNoise.zw = v_TexCoordNoise.zw * vec2(0.01, 2.0) * g_ArtifactsScale;

  v_TexCoordGlitch = v_TexCoord.xyxy;

  vec3 glitchOffset = g_Chromatic * smoothstep(0.0, 2.0, 1.0 + 0.5 * sin(g_Time * vec3(11.0, 7.0, 13.0) * 2.0)) * vec3(0.0019, 0.0021, 0.0017);
  v_TexCoordGlitch.y += 0.004 * g_Chromatic + glitchOffset.x;
  v_TexCoordGlitch.xz += glitchOffset.xy + vec2(0.005, -0.0005) * g_Chromatic;
  v_TexCoordGlitch.z -= glitchOffset.z + 0.006 * g_Chromatic;
  v_TexCoordGlitch.w -= 0.0045 * g_Chromatic;
  v_TexCoordGlitchBase.x = v_TexCoord.x + glitchOffset.z * min(1.0, g_NoiseAlpha);
  v_TexCoordGlitchBase.y = v_TexCoord.y - glitchOffset.z * min(1.0, g_NoiseAlpha);
}
`;

function buildVHSFragSource({ greyscale: useGreyscale, invertArtifacts }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
varying vec2 v_TexCoordGlitchBase;
varying vec4 v_TexCoordGlitch;
varying vec4 v_TexCoordNoise;
varying vec4 v_TexCoordVHSNoise;

uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;

uniform float g_Time;
uniform float g_NoiseScale;
uniform float g_NoiseAlpha;
uniform float g_DistortionStrength;
uniform float g_DistortionSpeed;
uniform float g_DistortionWidth;
uniform float g_ArtifactsScale;

#define GREYSCALE ${useGreyscale ? 1 : 0}
#define INVERTARTIFACTS ${invertArtifacts ? 1 : 0}

float greyscaleOf(vec3 color) { return dot(color, vec3(0.11, 0.59, 0.3)); }

float BlendSoftLightf(float base, float blend) {
  return (blend < 0.5)
    ? (2.0 * base * blend + base * base * (1.0 - 2.0 * blend))
    : (sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend));
}
vec3 BlendSoftLight(vec3 base, vec3 blend) {
  return vec3(BlendSoftLightf(base.r, blend.r), BlendSoftLightf(base.g, blend.g), BlendSoftLightf(base.b, blend.b));
}
vec3 BlendLinearDodge(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }

void main() {
  float dblend = sin(g_Time);
  dblend = sign(dblend) * pow(abs(max(0.00001, dblend)), 4.0);
  vec2 distortion = vec2(dblend *
      g_DistortionStrength * 0.02 *
      smoothstep(0.01 * g_DistortionWidth, 0.0, abs(fract(g_Time * g_DistortionSpeed) - v_TexCoord.y)),
    0.0);
  distortion *= g_NoiseAlpha;

  vec4 albedo;
  float vhsBlend = 1.0;

  vec4 orig = texture2D(g_Texture0, v_TexCoord.xy + distortion);
  albedo.ga = orig.ga;

  albedo.r = texture2D(g_Texture0, v_TexCoordGlitch.xy + distortion).r;
  albedo.b = texture2D(g_Texture0, v_TexCoordGlitch.zw + distortion).b;

  vec3 noise = texture2D(g_Texture1, v_TexCoordNoise.xy).rgb;
  vec3 noise2 = texture2D(g_Texture1, v_TexCoordNoise.zw).gbr;

#if GREYSCALE == 1
  noise = vec3(greyscaleOf(noise));
  noise2 = vec3(greyscaleOf(noise2));
#endif

  noise = clamp(noise * noise2, 0.0, 1.0);

  float blend = 0.1;
  albedo.rgb = mix(albedo.rgb, BlendSoftLight(albedo.rgb, noise), blend);
  albedo.rgb = mix(albedo.rgb, BlendLinearDodge(albedo.rgb, smoothstep(0.7, 1.0, noise)), blend);

  vec2 vhsNoise = texture2D(g_Texture1, v_TexCoordVHSNoise.xy).rg;
  vec2 vhsNoise2 = texture2D(g_Texture1, v_TexCoordVHSNoise.zw).rg;

  float artifactLimiter = pow(max(g_ArtifactsScale, 0.0001), 0.2);
  float artifactsAlpha = step(0.001, g_NoiseScale) * step(0.9, vhsNoise.x * artifactLimiter) * step(0.9, vhsNoise2.x * artifactLimiter) * vhsNoise.y * vhsNoise2.y;
#if INVERTARTIFACTS == 1
  albedo.rgb = mix(albedo.rgb, vec3(1.0) - albedo.rgb, artifactsAlpha);
#else
  albedo.rgb += vec3(artifactsAlpha);
#endif

  gl_FragColor = mix(orig, albedo, g_NoiseAlpha * vhsBlend);
}
`;
}

// Lê o efeito real "VHS" anexado a um objeto (scene.json objects[].effects[]
// .file terminando em "vhs/effect.json"). Defaults vindos direto dos
// comentários `// {"material":...,"default":...}` dos shaders reais.
function extractVHSConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('vhs/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    const csv = pass.constantshadervalues || {};
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 12;
    if (blendMode !== 12) return { unsupported: `BLENDMODE ${blendMode} (só Soft Light/12 suportado)` };
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    return {
      greyscale: !!combos.GREYSCALE,
      invertArtifacts: combos.INVERTARTIFACTS != null ? !!combos.INVERTARTIFACTS : true,
      noiseScale: csvNum(csv.scale, 0.3),
      noiseAlpha: csvNum(csv.strength, 1.0),
      distortionStrength: csvNum(csv.distortionstrength, 1.0),
      distortionSpeed: csvNum(csv.distortionspeed, 1.0),
      distortionWidth: csvNum(csv.distortionwidth, 1.0),
      artifactsScale: csvNum(csv.artifacts, 1.5),
      chromatic: csvNum(csv.chromatic, 0.1),
    };
  }
  return null;
}

// ---- Efeito real "motion blur" via WebGL (acumulação entre frames) ----
// Porta shaders/effects/motionblur_accumulation.frag + motionblur_combine.frag
// reais (effects/motionblur/effect.json: passe de acumulação com ping-pong
// de buffers + passe de combine, que no arquivo real é um passthrough puro).
// IMPORTANTE: isso é um blur temporal — só produz efeito visível em conteúdo
// que muda de frame a frame (vídeo, partícula em movimento). Anexado a um
// objeto "image" estático (único ponto de anexação disponível hoje), os
// dois buffers convergem pro mesmo conteúdo e ficam estáveis — não é bug,
// é a física correta do efeito sem movimento pra borrar. Implementado agora
// mesmo assim (pedido explícito do usuário, "vai que precisa futuramente")
// como infraestrutura real e pronta pra quando existir uma fonte que
// realmente muda quadro a quadro (vídeo/partícula) usando o mesmo mecanismo.
const MOTIONBLUR_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
  v_TexCoord = a_TexCoord;
  gl_Position = vec4(a_Position, 0.0, 1.0);
}
`;

function buildMotionBlurAccumulationFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_Amount;
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec4 pastAlbedo = texture2D(g_Texture1, v_TexCoord);
  gl_FragColor = mix(pastAlbedo, albedo, g_Amount);
}
`;
}

const MOTIONBLUR_COMBINE_FRAG = `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
void main() {
  gl_FragColor = texture2D(g_Texture0, v_TexCoord);
}
`;

// Lê o efeito real "motion blur" anexado a um objeto (scene.json
// objects[].effects[].file terminando em "motionblur/effect.json"). Default
// vindo direto do comentário `// {"material":"rate",...,"default":0.8}` do
// shader de acumulação real.
function extractMotionBlurConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('motionblur/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return { rate: csvNum(csv.rate, 0.8) };
  }
  return null;
}

// ---- Efeito real "film grain" via WebGL ----
// Porta shaders/effects/filmgrain.frag/.vert reais (effects/filmgrain/
// effect.json). Só suporta BLENDMODE==12 (Soft Light, default real) — mesmo
// padrão de sempre. Ruído animado com g_Time, então precisa de RAF loop.
const FILMGRAIN_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
varying vec4 v_TexCoordNoise;
uniform float g_Time;
uniform float g_NoiseScale;
uniform float g_Aspect;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  float t = fract(g_Time);
  v_TexCoord = a_TexCoord.xyxy;
  v_TexCoordNoise.xy = (a_TexCoord.xy + t) * g_NoiseScale;
  v_TexCoordNoise.zw = (a_TexCoord.xy - t * 2.5) * g_NoiseScale * 0.52;
  v_TexCoordNoise *= vec4(g_Aspect, 1.0, g_Aspect, 1.0);
}
`;

function buildFilmGrainFragSource({ greyscale: useGreyscale }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
varying vec4 v_TexCoordNoise;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_NoiseAlpha;
uniform float g_NoisePower;
#define GREYSCALE ${useGreyscale ? 1 : 0}

float greyscaleOf(vec3 c) { return dot(c, vec3(0.11, 0.59, 0.3)); }
float BlendSoftLightf(float base, float blend) {
  return (blend < 0.5)
    ? (2.0 * base * blend + base * base * (1.0 - 2.0 * blend))
    : (sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend));
}
vec3 BlendSoftLight(vec3 base, vec3 blend) {
  return vec3(BlendSoftLightf(base.r, blend.r), BlendSoftLightf(base.g, blend.g), BlendSoftLightf(base.b, blend.b));
}

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord.xy);

  vec3 noise = texture2D(g_Texture1, v_TexCoordNoise.xy).rgb;
  vec3 noise2 = texture2D(g_Texture1, v_TexCoordNoise.zw).gbr;

#if GREYSCALE == 1
  noise = vec3(greyscaleOf(noise));
  noise2 = vec3(greyscaleOf(noise2));
#endif

  noise = clamp(noise * noise2, 0.0, 1.0);
  noise = pow(noise, vec3(g_NoisePower));

  albedo.rgb = mix(albedo.rgb, BlendSoftLight(albedo.rgb, noise), g_NoiseAlpha);
  gl_FragColor = albedo;
}
`;
}

// Lê o efeito real "film grain" anexado a um objeto (scene.json
// objects[].effects[].file terminando em "filmgrain/effect.json"). Defaults
// vindos direto dos comentários do shader real.
function extractFilmGrainConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('filmgrain/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 12;
    if (blendMode !== 12) return { unsupported: `BLENDMODE ${blendMode} (só Soft Light/12 suportado)` };
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      greyscale: combos.GREYSCALE != null ? !!combos.GREYSCALE : true,
      noiseScale: csvNum(csv.scale, 10),
      noiseAlpha: csvNum(csv.strength, 2),
      noisePower: csvNum(csv.exponent, 0.5),
    };
  }
  return null;
}

// ---- Efeito real "edge detection" via WebGL ----
// Porta shaders/effects/edgedetection.frag/.vert reais (effects/
// edgedetection/effect.json) — kernel Sobel clássico de 3x3. Só suporta
// BLENDMODE==0 (Normal, o default real — vira um mix() simples, já que
// ApplyBlending sem nenhum #if bater cai no fallback BlendNormal=mix(A,B,op)).
// Estático (sem g_Time), renderiza uma vez só.
const EDGEDETECTION_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoordKernel[9];
uniform vec2 g_TexelSize;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  vec2 texelSize = g_TexelSize;
  v_TexCoordKernel[0] = a_TexCoord - texelSize;
  v_TexCoordKernel[1] = a_TexCoord - vec2(0.0, texelSize.y);
  v_TexCoordKernel[2] = a_TexCoord + vec2(texelSize.x, -texelSize.y);
  v_TexCoordKernel[3] = a_TexCoord - vec2(texelSize.x, 0.0);
  v_TexCoordKernel[4] = a_TexCoord;
  v_TexCoordKernel[5] = a_TexCoord + vec2(texelSize.x, 0.0);
  v_TexCoordKernel[6] = a_TexCoord + vec2(-texelSize.x, texelSize.y);
  v_TexCoordKernel[7] = a_TexCoord + vec2(0.0, texelSize.y);
  v_TexCoordKernel[8] = a_TexCoord + texelSize;
}
`;

function buildEdgeDetectionFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoordKernel[9];
uniform sampler2D g_Texture0;
uniform float g_BlendAlpha;
uniform float g_BlendBrightness;
uniform vec3 g_OutlineColor1;
uniform vec3 g_OutlineColor2;
uniform float g_DetectionThreshold;
uniform float g_DetectionMultiply;

float greyscaleOf(vec3 c) { return dot(c, vec3(0.11, 0.59, 0.3)); }

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoordKernel[4]);

  vec3 sample00 = texture2D(g_Texture0, v_TexCoordKernel[0]).rgb;
  vec3 sample10 = texture2D(g_Texture0, v_TexCoordKernel[1]).rgb;
  vec3 sample20 = texture2D(g_Texture0, v_TexCoordKernel[2]).rgb;
  vec3 sample01 = texture2D(g_Texture0, v_TexCoordKernel[3]).rgb;
  vec3 sample21 = texture2D(g_Texture0, v_TexCoordKernel[5]).rgb;
  vec3 sample02 = texture2D(g_Texture0, v_TexCoordKernel[6]).rgb;
  vec3 sample12 = texture2D(g_Texture0, v_TexCoordKernel[7]).rgb;
  vec3 sample22 = texture2D(g_Texture0, v_TexCoordKernel[8]).rgb;

  vec3 gx = sample20 - sample00 + (sample21 - sample01) * 2.0 + sample22 - sample02;
  vec3 gy = sample00 - sample02 + (sample10 - sample12) * 2.0 + sample20 - sample22;

  float g = abs(greyscaleOf(gx)) + abs(greyscaleOf(gy));

  vec3 combinedColor = mix(g_OutlineColor2, g_OutlineColor1,
    min(1.0, max(0.0, g - g_DetectionThreshold) * g_DetectionMultiply)) * g_BlendBrightness;

  gl_FragColor.a = albedo.a;
  gl_FragColor.rgb = mix(albedo.rgb, combinedColor, g_BlendAlpha);
}
`;
}

// Lê o efeito real "edge detection" anexado a um objeto (scene.json
// objects[].effects[].file terminando em "edgedetection/effect.json").
function extractEdgeDetectionConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('edgedetection/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 0;
    if (blendMode !== 0) return { unsupported: `BLENDMODE ${blendMode} (só Normal/0 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      detectionSize: csvNum(csv.size, 1),
      blendAlpha: csvNum(csv.alpha, 1),
      blendBrightness: csvNum(csv.brightness, 1),
      outlineColor1: csvVec(csv.outlinecolor, [0, 0, 0]),
      outlineColor2: csvVec(csv.outlinecolorbg, [1, 1, 1]),
      detectionThreshold: csvNum(csv.detectthreshold, 0.5),
      detectionMultiply: csvNum(csv.detectmultiply, 1),
    };
  }
  return null;
}

// ---- Efeito real "opacity" via WebGL ----
// Porta shaders/effects/opacity.frag real — só multiplica o alfa por uma
// constante. Estático, sem g_Time, renderiza uma vez só.
const SIMPLE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
  v_TexCoord = a_TexCoord;
  gl_Position = vec4(a_Position, 0.0, 1.0);
}
`;

function buildOpacityFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float g_UserAlpha;
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  albedo.a *= g_UserAlpha;
  gl_FragColor = albedo;
}
`;
}

// Muitos efeitos reais da Wallpaper Engine ligam um parâmetro numérico a um
// script JS, uma curva de animação por keyframes, ou uma General Property do
// usuário, em vez de um número literal — nesses casos o campo em
// constantshadervalues vem como um OBJETO (ex.: {"script":"...","value":1},
// {"animation":{...},"value":0}, {"user":"textopacity","value":1}), não um
// número. Number(objeto) vira NaN, quebrando o efeito silenciosamente
// (descoberto ao vivo 2026-07-18: "Music Visualizer" real trava o opacity com
// alpha=NaN). Não rodamos scripts/animações/property-bindings de verdade
// aqui, então a saída honesta é cair pro "value" estático que o próprio
// arquivo já guarda (o valor congelado que a WE mostraria no editor), do
// mesmo jeito que AUDIOPROCESSING já cai pro comportamento estático quando
// ligado — nunca finge rodar o script.
function csvNum(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') {
    const n = Number(raw.value);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Mesma classe de problema do csvNum, mas pra campos vetoriais (escala,
// posição, cor) que normalmente vêm como string "x y" / "r g b" e usam
// .split(' ').map(Number) — quando o campo real é objeto (script/animação/
// property binding), .split não existe nele. Cai pro .value string (o
// congelado) antes de desistir, mesma filosofia do csvNum.
function csvVec(raw, fallback) {
  if (raw == null) return fallback;
  const str = typeof raw === 'object' ? raw.value : raw;
  if (typeof str !== 'string') return fallback;
  const nums = str.split(' ').map(Number);
  return nums.some((n) => !Number.isFinite(n)) ? fallback : nums;
}

// ---- Motor real (parcial, honesto) de scripts embutidos da Wallpaper
// Engine ----
// Confirmado real 2026-07-18 ("Music Cat"'s objeto "Color", efeito tint):
// nem todo campo script-driven é áudio-reativo — esse aqui é um ciclo de
// cor arco-íris baseado em Date.now(), usando WEColor.hsv2rgb, sem nenhuma
// dependência de áudio. Até agora a gente só lia o `.value` congelado
// (csvNum/csvVec) e ignorava o `.script` de verdade.
//
// Vec2/Vec3/Vec4 e os módulos WEColor/WEMath/WEVector abaixo são portados
// direto do `lib.sceneScript.d.ts` REAL da própria instalação da WE (Monaco
// autocomplete do editor de scripts dela, achado em
// ui/dist/monaco/autocomplete/lib.sceneScript.d.ts) — mesma disciplina de
// sempre: implementar exatamente a API documentada real, nunca inventar
// método/assinatura. `engine.AUDIO_RESOLUTION_16/32/64`, `MediaPlaybackEvent`
// (com PLAYBACK_STOPPED/PLAYING/PAUSED) e `MediaThumbnailEvent` (com
// primaryColor/secondaryColor/tertiaryColor) também vêm de lá — os scripts
// reais já vistos ("BG Color"/"BG Color 2" da Music Visualizer) leem
// exatamente `event.secondaryColor`/`event.primaryColor`, bate certinho.
//
// NÃO implementado ainda: `engine.registerAudioBuffers` fica com um
// AudioBuffers real (`.left/.right/.average` como Float32Array) mas
// alimentado por captura de áudio real do desktop (ver WeAudioEngine
// abaixo) só quando pelo menos um script realmente pede áudio — e os
// eventos de media (mediaThumbnailChanged/mediaPlaybackChanged) nunca
// disparam de verdade ainda, porque não existe integração real de media
// player aqui — scripts que só reagem a eles ficam parados no valor
// inicial (honesto, não finge).
class Vec2 {
  constructor(x = 0, y) {
    if (x && typeof x === 'object') { this.x = x.x || 0; this.y = x.y || 0; return; }
    if (typeof x === 'string') { const [a, b] = x.split(' ').map(Number); this.x = a || 0; this.y = b || 0; return; }
    this.x = x; this.y = y != null ? y : x;
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  lengthSqr() { return this.x * this.x + this.y * this.y; }
  distance(o) { return this.subtract(o).length(); }
  distanceSqr(o) { return this.subtract(o).lengthSqr(); }
  normalize() { const l = this.length() || 1; return new Vec2(this.x / l, this.y / l); }
  copy() { return new Vec2(this.x, this.y); }
  equals(o, eps = 1e-5) { return Math.abs(this.x - o.x) < eps && Math.abs(this.y - o.y) < eps; }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y); }
  negate() { return new Vec2(-this.x, -this.y); }
  add(v) { return typeof v === 'number' ? new Vec2(this.x + v, this.y + v) : new Vec2(this.x + v.x, this.y + v.y); }
  subtract(v) { return typeof v === 'number' ? new Vec2(this.x - v, this.y - v) : new Vec2(this.x - v.x, this.y - v.y); }
  multiply(v) { return typeof v === 'number' ? new Vec2(this.x * v, this.y * v) : new Vec2(this.x * v.x, this.y * v.y); }
  divide(v) { return typeof v === 'number' ? new Vec2(this.x / v, this.y / v) : new Vec2(this.x / v.x, this.y / v.y); }
  dot(v) { return this.x * v.x + this.y * v.y; }
  reflect(n) { const d = 2 * this.dot(n); return new Vec2(this.x - d * n.x, this.y - d * n.y); }
  perpendicular() { return new Vec2(-this.y, this.x); }
  project(v) { const d = this.dot(v) / (v.dot(v) || 1e-9); return new Vec2(v.x * d, v.y * d); }
  angle() { return Math.atan2(this.y, this.x) * 180 / Math.PI; }
  angleBetween(v) { let d = this.angle() - v.angle(); d = ((d + 180) % 360 + 360) % 360 - 180; return d; }
  rotate(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return new Vec2(this.x * c - this.y * s, this.x * s + this.y * c); }
  mix(o, amt) { const ax = typeof amt === 'number' ? amt : amt.x, ay = typeof amt === 'number' ? amt : amt.y; return new Vec2(this.x + (o.x - this.x) * ax, this.y + (o.y - this.y) * ay); }
  min(v) { return new Vec2(Math.min(this.x, v.x), Math.min(this.y, v.y)); }
  max(v) { return new Vec2(Math.max(this.x, v.x), Math.max(this.y, v.y)); }
  clamp(mn, mx) {
    const mnx = typeof mn === 'number' ? mn : mn.x, mny = typeof mn === 'number' ? mn : mn.y;
    const mxx = typeof mx === 'number' ? mx : mx.x, mxy = typeof mx === 'number' ? mx : mx.y;
    return new Vec2(Math.min(Math.max(this.x, mnx), mxx), Math.min(Math.max(this.y, mny), mxy));
  }
  abs() { return new Vec2(Math.abs(this.x), Math.abs(this.y)); }
  sign() { return new Vec2(Math.sign(this.x), Math.sign(this.y)); }
  round() { return new Vec2(Math.round(this.x), Math.round(this.y)); }
  floor() { return new Vec2(Math.floor(this.x), Math.floor(this.y)); }
  ceil() { return new Vec2(Math.ceil(this.x), Math.ceil(this.y)); }
  fract() { return new Vec2(this.x - Math.floor(this.x), this.y - Math.floor(this.y)); }
  mod(v) { const vx = typeof v === 'number' ? v : v.x, vy = typeof v === 'number' ? v : v.y; return new Vec2(this.x - vx * Math.floor(this.x / vx), this.y - vy * Math.floor(this.y / vy)); }
  step(edge) { const ex = typeof edge === 'number' ? edge : edge.x, ey = typeof edge === 'number' ? edge : edge.y; return new Vec2(this.x < ex ? 0 : 1, this.y < ey ? 0 : 1); }
  smoothStep(mn, mx) {
    const f = (x, a, b) => { const t = Math.min(Math.max((x - a) / (b - a || 1e-9), 0), 1); return t * t * (3 - 2 * t); };
    const mnx = typeof mn === 'number' ? mn : mn.x, mny = typeof mn === 'number' ? mn : mn.y;
    const mxx = typeof mx === 'number' ? mx : mx.x, mxy = typeof mx === 'number' ? mx : mx.y;
    return new Vec2(f(this.x, mnx, mxx), f(this.y, mny, mxy));
  }
  toString() { return `${this.x} ${this.y}`; }
}

class Vec3 {
  constructor(x = 0, y, z) {
    if (x && typeof x === 'object') { this.x = x.x || 0; this.y = x.y || 0; this.z = x.z != null ? x.z : (y != null ? y : 0); return; }
    if (typeof x === 'string') { const [a, b, c] = x.split(' ').map(Number); this.x = a || 0; this.y = b || 0; this.z = c || 0; return; }
    this.x = x; this.y = y != null ? y : x; this.z = z != null ? z : x;
  }
  static fromSpherical(r, theta, phi) {
    const t = theta * Math.PI / 180, p = phi * Math.PI / 180;
    return new Vec3(r * Math.sin(t) * Math.cos(p), r * Math.cos(t), r * Math.sin(t) * Math.sin(p));
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  lengthSqr() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  distance(o) { return this.subtract(o).length(); }
  distanceSqr(o) { return this.subtract(o).lengthSqr(); }
  normalize() { const l = this.length() || 1; return new Vec3(this.x / l, this.y / l, this.z / l); }
  copy() { return new Vec3(this.x, this.y, this.z); }
  equals(o, eps = 1e-5) { return Math.abs(this.x - o.x) < eps && Math.abs(this.y - o.y) < eps && Math.abs(this.z - o.z) < eps; }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z); }
  negate() { return new Vec3(-this.x, -this.y, -this.z); }
  add(v) { return typeof v === 'number' ? new Vec3(this.x + v, this.y + v, this.z + v) : new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
  subtract(v) { return typeof v === 'number' ? new Vec3(this.x - v, this.y - v, this.z - v) : new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
  multiply(v) { return typeof v === 'number' ? new Vec3(this.x * v, this.y * v, this.z * v) : new Vec3(this.x * v.x, this.y * v.y, this.z * v.z); }
  divide(v) { return typeof v === 'number' ? new Vec3(this.x / v, this.y / v, this.z / v) : new Vec3(this.x / v.x, this.y / v.y, this.z / v.z); }
  cross(v) { return new Vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  reflect(n) { const d = 2 * this.dot(n); return new Vec3(this.x - d * n.x, this.y - d * n.y, this.z - d * n.z); }
  refract(n, eta) {
    const d = this.dot(n);
    const k = 1 - eta * eta * (1 - d * d);
    if (k < 0) return new Vec3(0, 0, 0);
    const s = eta * d + Math.sqrt(k);
    return new Vec3(eta * this.x - s * n.x, eta * this.y - s * n.y, eta * this.z - s * n.z);
  }
  project(v) { const d = this.dot(v) / (v.dot(v) || 1e-9); return new Vec3(v.x * d, v.y * d, v.z * d); }
  angleBetween(v) {
    const denom = (this.length() * v.length()) || 1e-9;
    return Math.acos(Math.min(1, Math.max(-1, this.dot(v) / denom))) * 180 / Math.PI;
  }
  toSpherical() {
    const r = this.length() || 1e-9;
    return new Vec3(r, Math.acos(Math.min(1, Math.max(-1, this.y / r))) * 180 / Math.PI, Math.atan2(this.z, this.x) * 180 / Math.PI);
  }
  mix(o, amt) {
    const ax = typeof amt === 'number' ? amt : amt.x, ay = typeof amt === 'number' ? amt : amt.y, az = typeof amt === 'number' ? amt : amt.z;
    return new Vec3(this.x + (o.x - this.x) * ax, this.y + (o.y - this.y) * ay, this.z + (o.z - this.z) * az);
  }
  min(v) { return new Vec3(Math.min(this.x, v.x), Math.min(this.y, v.y), Math.min(this.z, v.z)); }
  max(v) { return new Vec3(Math.max(this.x, v.x), Math.max(this.y, v.y), Math.max(this.z, v.z)); }
  clamp(mn, mx) {
    const c = (val, a, b) => Math.min(Math.max(val, typeof a === 'number' ? a : a.x), typeof b === 'number' ? b : b.x);
    const mnx = typeof mn === 'number' ? mn : mn.x, mny = typeof mn === 'number' ? mn : mn.y, mnz = typeof mn === 'number' ? mn : mn.z;
    const mxx = typeof mx === 'number' ? mx : mx.x, mxy = typeof mx === 'number' ? mx : mx.y, mxz = typeof mx === 'number' ? mx : mx.z;
    return new Vec3(Math.min(Math.max(this.x, mnx), mxx), Math.min(Math.max(this.y, mny), mxy), Math.min(Math.max(this.z, mnz), mxz));
  }
  abs() { return new Vec3(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z)); }
  sign() { return new Vec3(Math.sign(this.x), Math.sign(this.y), Math.sign(this.z)); }
  round() { return new Vec3(Math.round(this.x), Math.round(this.y), Math.round(this.z)); }
  floor() { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  ceil() { return new Vec3(Math.ceil(this.x), Math.ceil(this.y), Math.ceil(this.z)); }
  fract() { return new Vec3(this.x - Math.floor(this.x), this.y - Math.floor(this.y), this.z - Math.floor(this.z)); }
  mod(v) {
    const vx = typeof v === 'number' ? v : v.x, vy = typeof v === 'number' ? v : v.y, vz = typeof v === 'number' ? v : v.z;
    return new Vec3(this.x - vx * Math.floor(this.x / vx), this.y - vy * Math.floor(this.y / vy), this.z - vz * Math.floor(this.z / vz));
  }
  step(edge) {
    const ex = typeof edge === 'number' ? edge : edge.x, ey = typeof edge === 'number' ? edge : edge.y, ez = typeof edge === 'number' ? edge : edge.z;
    return new Vec3(this.x < ex ? 0 : 1, this.y < ey ? 0 : 1, this.z < ez ? 0 : 1);
  }
  smoothStep(mn, mx) {
    const f = (x, a, b) => { const t = Math.min(Math.max((x - a) / (b - a || 1e-9), 0), 1); return t * t * (3 - 2 * t); };
    const mnx = typeof mn === 'number' ? mn : mn.x, mny = typeof mn === 'number' ? mn : mn.y, mnz = typeof mn === 'number' ? mn : mn.z;
    const mxx = typeof mx === 'number' ? mx : mx.x, mxy = typeof mx === 'number' ? mx : mx.y, mxz = typeof mx === 'number' ? mx : mx.z;
    return new Vec3(f(this.x, mnx, mxx), f(this.y, mny, mxy), f(this.z, mnz, mxz));
  }
  toString() { return `${this.x} ${this.y} ${this.z}`; }
}

class Vec4 {
  constructor(x = 0, y, z, w) {
    if (x && typeof x === 'object') { this.x = x.x || 0; this.y = x.y || 0; this.z = x.z || 0; this.w = x.w != null ? x.w : (z != null ? z : 0); return; }
    if (typeof x === 'string') { const [a, b, c, d] = x.split(' ').map(Number); this.x = a || 0; this.y = b || 0; this.z = c || 0; this.w = d || 0; return; }
    this.x = x; this.y = y != null ? y : x; this.z = z != null ? z : x; this.w = w != null ? w : x;
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w); }
  lengthSqr() { return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w; }
  distance(o) { return this.subtract(o).length(); }
  distanceSqr(o) { return this.subtract(o).lengthSqr(); }
  normalize() { const l = this.length() || 1; return new Vec4(this.x / l, this.y / l, this.z / l, this.w / l); }
  copy() { return new Vec4(this.x, this.y, this.z, this.w); }
  equals(o, eps = 1e-5) { return Math.abs(this.x - o.x) < eps && Math.abs(this.y - o.y) < eps && Math.abs(this.z - o.z) < eps && Math.abs(this.w - o.w) < eps; }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z) && Number.isFinite(this.w); }
  negate() { return new Vec4(-this.x, -this.y, -this.z, -this.w); }
  add(v) { return typeof v === 'number' ? new Vec4(this.x + v, this.y + v, this.z + v, this.w + v) : new Vec4(this.x + v.x, this.y + v.y, this.z + v.z, this.w + v.w); }
  subtract(v) { return typeof v === 'number' ? new Vec4(this.x - v, this.y - v, this.z - v, this.w - v) : new Vec4(this.x - v.x, this.y - v.y, this.z - v.z, this.w - v.w); }
  multiply(v) { return typeof v === 'number' ? new Vec4(this.x * v, this.y * v, this.z * v, this.w * v) : new Vec4(this.x * v.x, this.y * v.y, this.z * v.z, this.w * v.w); }
  divide(v) { return typeof v === 'number' ? new Vec4(this.x / v, this.y / v, this.z / v, this.w / v) : new Vec4(this.x / v.x, this.y / v.y, this.z / v.z, this.w / v.w); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w; }
  reflect(n) { const d = 2 * this.dot(n); return new Vec4(this.x - d * n.x, this.y - d * n.y, this.z - d * n.z, this.w - d * n.w); }
  project(v) { const d = this.dot(v) / (v.dot(v) || 1e-9); return new Vec4(v.x * d, v.y * d, v.z * d, v.w * d); }
  mix(o, amt) {
    const a = (k) => typeof amt === 'number' ? amt : amt[k];
    return new Vec4(this.x + (o.x - this.x) * a('x'), this.y + (o.y - this.y) * a('y'), this.z + (o.z - this.z) * a('z'), this.w + (o.w - this.w) * a('w'));
  }
  min(v) { return new Vec4(Math.min(this.x, v.x), Math.min(this.y, v.y), Math.min(this.z, v.z), Math.min(this.w, v.w)); }
  max(v) { return new Vec4(Math.max(this.x, v.x), Math.max(this.y, v.y), Math.max(this.z, v.z), Math.max(this.w, v.w)); }
  clamp(mn, mx) {
    const g = (val, o, k) => typeof o === 'number' ? o : o[k];
    return new Vec4(
      Math.min(Math.max(this.x, g(mn, mn, 'x')), g(mx, mx, 'x')),
      Math.min(Math.max(this.y, g(mn, mn, 'y')), g(mx, mx, 'y')),
      Math.min(Math.max(this.z, g(mn, mn, 'z')), g(mx, mx, 'z')),
      Math.min(Math.max(this.w, g(mn, mn, 'w')), g(mx, mx, 'w')),
    );
  }
  abs() { return new Vec4(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z), Math.abs(this.w)); }
  sign() { return new Vec4(Math.sign(this.x), Math.sign(this.y), Math.sign(this.z), Math.sign(this.w)); }
  round() { return new Vec4(Math.round(this.x), Math.round(this.y), Math.round(this.z), Math.round(this.w)); }
  floor() { return new Vec4(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z), Math.floor(this.w)); }
  ceil() { return new Vec4(Math.ceil(this.x), Math.ceil(this.y), Math.ceil(this.z), Math.ceil(this.w)); }
  fract() { return new Vec4(this.x - Math.floor(this.x), this.y - Math.floor(this.y), this.z - Math.floor(this.z), this.w - Math.floor(this.w)); }
  mod(v) {
    const g = (k) => typeof v === 'number' ? v : v[k];
    return new Vec4(this.x - g('x') * Math.floor(this.x / g('x')), this.y - g('y') * Math.floor(this.y / g('y')), this.z - g('z') * Math.floor(this.z / g('z')), this.w - g('w') * Math.floor(this.w / g('w')));
  }
  step(edge) {
    const g = (k) => typeof edge === 'number' ? edge : edge[k];
    return new Vec4(this.x < g('x') ? 0 : 1, this.y < g('y') ? 0 : 1, this.z < g('z') ? 0 : 1, this.w < g('w') ? 0 : 1);
  }
  smoothStep(mn, mx) {
    const f = (x, a, b) => { const t = Math.min(Math.max((x - a) / (b - a || 1e-9), 0), 1); return t * t * (3 - 2 * t); };
    const g = (o, k) => typeof o === 'number' ? o : o[k];
    return new Vec4(f(this.x, g(mn, 'x'), g(mx, 'x')), f(this.y, g(mn, 'y'), g(mx, 'y')), f(this.z, g(mn, 'z'), g(mx, 'z')), f(this.w, g(mn, 'w'), g(mx, 'w')));
  }
  toString() { return `${this.x} ${this.y} ${this.z} ${this.w}`; }
}

// Módulos reais (import * as X from '<nome>') — mesma fonte real do .d.ts.
const WEColor = {
  rgb2hsv(rgb) {
    const r = rgb.x, g = rgb.y, b = rgb.z;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360 / 360;
    }
    const s = max === 0 ? 0 : d / max;
    return new Vec3(h, s, max);
  },
  hsv2rgb(hsv) {
    const h = ((hsv.x % 1) + 1) % 1, s = hsv.y, v = hsv.z;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return new Vec3(r, g, b);
  },
  normalizeColor(rgb) { return new Vec3(rgb.x / 255, rgb.y / 255, rgb.z / 255); },
  expandColor(rgb) { return new Vec3(rgb.x * 255, rgb.y * 255, rgb.z * 255); },
};

const WEMath = {
  smoothStep(min, max, value) { const t = Math.min(Math.max((value - min) / (max - min || 1e-9), 0), 1); return t * t * (3 - 2 * t); },
  mix(a, b, value) { return a + (b - a) * value; },
  deg2rad: Math.PI / 180,
  rad2deg: 180 / Math.PI,
};

const WEVector = {
  angleVector2(angle) { const r = angle * Math.PI / 180; return new Vec2(Math.cos(r), Math.sin(r)); },
  vectorAngle2(direction) { return Math.atan2(direction.y, direction.x) * 180 / Math.PI; },
};

// Eventos de media reais (mesmos nomes/campos do .d.ts) — nunca disparados
// de verdade ainda (sem integração real de media player), só existem pra um
// script poder referenciar `MediaPlaybackEvent.PLAYBACK_PLAYING` etc. sem
// dar ReferenceError caso o texto do script use a classe diretamente.
class MediaPlaybackEvent { static PLAYBACK_STOPPED = 0; static PLAYBACK_PAUSED = 2; static PLAYBACK_PLAYING = 1; }
class MediaThumbnailEvent {}
class MediaPropertiesEvent {}

// Compila o texto real do script (ES-module-like: `import`/`export` que
// `new Function` não entende) — remove as linhas de import (os nomes viram
// parâmetros injetados de verdade em vez de módulos, funciona pra
// 'WEColor'/'WEMath'/'WEVector', qualquer um deles) e o `export` na frente
// de cada função, depois devolve as funções conhecidas (init/update/eventos
// de mídia) por referência. Nunca finge suportar uma função que o script
// não define.
function compileWEScript(source) {
  // Mesma técnica já comprovada em compileWeTextScript (scripts de objetos
  // de texto, sessão anterior): tirar "export " de qualquer início de linha
  // cobre function/var/let/const/class de uma vez, sem precisar de um caso
  // por tipo de declaração. Achado real 2026-07-18: minha versão anterior só
  // tirava "export function", e vários scripts reais ("pausa"/"playing"/
  // "avanti"/"indietro"'s .scale, os objetos de fonte do relógio) usam
  // `export var scriptProperties = createScriptProperties()...` — dava
  // SyntaxError antes de sequer rodar.
  let body = source.replace(/^\s*import[^\n]*\n/gm, '');
  body = body.replace(/^\s*export\s+/gm, '');
  // Real (IComponent + eventos de cursor do .d.ts): update/init são só duas
  // das funções que um script pode exportar — cursorDown/cursorUp/
  // cursorClick/cursorMove/cursorEnter/cursorLeave (ver "solid":true nos
  // botões reais de play/pause/skip) e os de mídia também contam.
  const names = [
    'init', 'update', 'destroy', 'resizeScreen', 'applyUserProperties', 'applyGeneralSettings',
    'mediaThumbnailChanged', 'mediaPlaybackChanged', 'mediaPropertiesChanged',
    'cursorDown', 'cursorUp', 'cursorMove', 'cursorEnter', 'cursorLeave', 'cursorClick',
  ];
  const wrapped = `${body}\nreturn { ${names.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : null`).join(', ')} };`;
  const factory = new Function(
    'Vec2', 'Vec3', 'Vec4', 'WEColor', 'WEMath', 'WEVector',
    'MediaPlaybackEvent', 'MediaThumbnailEvent', 'MediaPropertiesEvent', 'createScriptProperties',
    'engine', 'thisLayer', 'thisScene', 'thisObject', 'thisEffect', 'thisMaterial', 'input', 'localStorage', wrapped,
  );
  // `thisLayer` é injetado por chamada (não é global compartilhado como
  // `engine`/`ENGINE_CLOCK`) — cada objeto tem o seu próprio LayerHandle,
  // real: `declare let thisLayer: ILayer` do .d.ts. `thisScene`/`thisObject`/
  // `thisEffect`/`thisMaterial` também são globais reais documentados, mas
  // não implementados de verdade ainda (thisScene.getLayer(x).play() pra
  // tocar som de clique, por exemplo) — descoberta real 2026-07-18: sem
  // ALGUM stub aqui, um script real ("pausa"'s cursorDown, que toca som
  // ANTES do resto da lógica) jogava ReferenceError e abortava a função
  // inteira no meio, perdendo até a parte que a gente conseguiria rodar.
  // NOOP_PROXY absorve qualquer chamada/propriedade nessas referências sem
  // quebrar nada — silenciosamente não faz nada (sem som, sem acesso real a
  // outros objetos da cena), deixando o resto do script continuar.
  return (layerHandle) => factory(
    Vec2, Vec3, Vec4, WEColor, WEMath, WEVector,
    MediaPlaybackEvent, MediaThumbnailEvent, MediaPropertiesEvent, createScriptProperties,
    ENGINE_CLOCK, layerHandle, NOOP_PROXY, NOOP_PROXY, NOOP_PROXY, NOOP_PROXY, WE_INPUT, WE_LOCAL_STORAGE,
  );
}

// Real (`declare let input: IInput`) — cursor de verdade em coordenadas de
// mundo/tela, atualizado pelo mesmo cursor-position/cursor-button real que
// já alimenta os efeitos interativos (xray/depthparallax) e o hit-test de
// clique (ver WeScene). Achado real 2026-07-18 lendo um script de
// arrastar-osso de puppet ("lituoliao_5_rw"): usa `input.cursorWorldPosition`
// direto em vez de receber a posição só via CursorEvent.
const WE_INPUT = {
  cursorWorldPosition: new Vec3(0, 0, 0),
  cursorScreenPosition: new Vec2(0, 0),
  cursorLeftDown: false,
};

// Real (`declare let localStorage: ILocalStorage`) — achado 2026-07-18 lendo
// o script real de arrastar Day/Date (mesmo padrão do "Clock" já documentado
// em _resolveOrigin): `init()` chama `localStorage.get(...)` SEM nenhum
// stub, o que jogava ReferenceError e descartava o script inteiro — mesmo
// as funções cursorDown/cursorUp/cursorMove que funcionariam perfeitamente
// nunca rodavam por causa disso. Implementação real (Map em memória, não
// persiste entre reinícios do app — honesto, mas suficiente pra um objeto
// lembrar de posição arrastada durante a mesma sessão).
const WE_LOCAL_STORAGE_DATA = new Map();
const WE_LOCAL_STORAGE = {
  LOCATION_GLOBAL: 'global',
  LOCATION_SCREEN: 'screen',
  set(key, value, location) { WE_LOCAL_STORAGE_DATA.set(`${location || 'screen'}:${key}`, value); },
  get(key, location) { const k = `${location || 'screen'}:${key}`; return WE_LOCAL_STORAGE_DATA.has(k) ? WE_LOCAL_STORAGE_DATA.get(k) : undefined; },
  delete(key, location) { return WE_LOCAL_STORAGE_DATA.delete(`${location || 'screen'}:${key}`); },
  clear(location) { const prefix = `${location || 'screen'}:`; for (const k of [...WE_LOCAL_STORAGE_DATA.keys()]) if (k.startsWith(prefix)) WE_LOCAL_STORAGE_DATA.delete(k); },
};

// "Buraco negro" seguro: qualquer propriedade lida vira ele mesmo, qualquer
// chamada devolve ele mesmo — `thisScene.getLayer(x).play()`,
// `thisObject.getAnimation().stop()`, etc. nunca lançam ReferenceError/
// TypeError, só silenciosamente não fazem nada de verdade. Único jeito
// honesto de deixar um script real continuar rodando o resto da sua lógica
// quando ele toca uma parte da API real (som, outros layers da cena) que
// esse motor ainda não implementa.
const NOOP_PROXY = new Proxy(function () {}, {
  get(_target, prop) { return prop === Symbol.toPrimitive || prop === 'then' ? undefined : NOOP_PROXY; },
  apply() { return NOOP_PROXY; },
});

// Subconjunto real e funcional de `ILayer` (ver .d.ts real): as propriedades
// que os scripts reais já vistos de fato leem/escrevem
// (thisLayer.visible/.origin/.angles/.scale/.alpha/.color/.name). Guarda o
// estado internamente; quem constrói o objeto (WeScene) decide como/quando
// aplicar essas mudanças no DOM de verdade (ver _applyLayerHandleToDom).
class LayerHandle {
  constructor(initial = {}) {
    this._s = {
      visible: true,
      origin: new Vec3(0, 0, 0),
      angles: new Vec3(0, 0, 0),
      scale: new Vec3(1, 1, 1),
      alpha: 1,
      color: new Vec3(1, 1, 1),
      name: '',
      ...initial,
    };
    this._dirty = true;
  }
  get visible() { return this._s.visible; }
  set visible(v) { this._s.visible = !!v; this._dirty = true; }
  get origin() { return this._s.origin; }
  set origin(v) { this._s.origin = v; this._dirty = true; }
  get angles() { return this._s.angles; }
  set angles(v) { this._s.angles = v; this._dirty = true; }
  get scale() { return this._s.scale; }
  set scale(v) { this._s.scale = v; this._dirty = true; }
  get alpha() { return this._s.alpha; }
  set alpha(v) { this._s.alpha = v; this._dirty = true; }
  get color() { return this._s.color; }
  set color(v) { this._s.color = v; this._dirty = true; }
  get name() { return this._s.name; }
  set name(v) { this._s.name = v; this._dirty = true; }
}

// Real (CursorEvent do .d.ts): worldPosition/localPosition como Vec3 (só X/Y
// usados de verdade), hitBox opcional. `button` sempre 0 (esquerdo) — mesma
// nota do .d.ts real ("Currently always 0 for left mouse button").
class CursorEvent {
  constructor(worldPosition, localPosition, hitBox) {
    this.worldPosition = worldPosition;
    this.localPosition = localPosition;
    this.hitBox = hitBox;
  }
}

// Mesmo stub já comprovado em compileWeTextScript: builder que ignora as
// definições de UI (sliders/checkboxes) e devolve os valores default de
// cada campo direto — os scripts de efeito (ao contrário dos de texto) não
// têm um "realProps" resolvido pra injetar aqui, então cada campo fica no
// próprio default declarado (`value:` de cada .addX({...})).
function createScriptProperties() {
  const obj = {};
  const chain = {
    addCheckbox: (o) => { if (o && o.name) obj[o.name] = o.value; return chain; },
    addText: (o) => { if (o && o.name) obj[o.name] = o.value; return chain; },
    addCombo: (o) => { if (o && o.name) obj[o.name] = o.value; return chain; },
    addSlider: (o) => { if (o && o.name) obj[o.name] = o.value; return chain; },
    addColor: (o) => { if (o && o.name) obj[o.name] = o.value; return chain; },
    addBool: (o) => { if (o && o.name) obj[o.name] = o.value; return chain; },
    finish: () => obj,
  };
  return chain;
}

// Relógio+contexto compartilhado — um só objeto `engine` por processo,
// atualizado uma vez por frame no loop de quem chamar .tick() (ver
// _applyTint e qualquer outro efeito animado que passe a usar
// LiveScriptValue), pra todo script ler o mesmo frametime/runtime reais.
// Nomes batem com o `engine` real do .d.ts (`frametime`, `runtime`, não
// "time" — corrigido depois de checar o arquivo real).
// ---- Captura de áudio REAL do desktop, sob demanda ----
// Só liga na primeira vez que algum script chama engine.registerAudioBuffers
// de verdade — mesma técnica de loopback via desktopCapturer já validada em
// wallpaper.js's initAudioVisualizer (pedir um vídeo de "desktop" junto do
// áudio destrava a captura do áudio de SAÍDA do sistema, não do microfone;
// Chromium exige o vídeo como condição, mas a track é parada na hora). Uma
// única fonte de áudio real (MediaStreamSource), um AnalyserNode por
// resolução pedida (16/32/64 — cada um precisa de fftSize diferente).
// Simplificação honesta: não separamos canais esquerdo/direito de verdade
// (exigiria um ChannelSplitterNode a mais) — left/right/average recebem o
// mesmo espectro mono real, em vez de inventar uma separação estéreo falsa.
const WeAudioEngine = {
  _starting: null,
  _source: null,
  _buffers: new Map(),
  _analysers: new Map(),
  _loopStarted: false,

  async _start() {
    if (this._starting) return this._starting;
    this._starting = (async () => {
      const { ipcRenderer } = require('electron');
      const sourceId = await ipcRenderer.invoke('get-desktop-audio-source');
      if (!sourceId) throw new Error('nenhuma fonte de áudio de desktop disponível');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      const actx = new AudioContext();
      this._source = actx.createMediaStreamSource(stream);
      for (const res of this._buffers.keys()) this._attachAnalyser(res);
      if (!this._loopStarted) { this._loopStarted = true; this._loop(); }
    })().catch((err) => {
      console.warn('[we-scene] captura de áudio real do desktop falhou, engine.registerAudioBuffers fica zerado:', err.message);
    });
    return this._starting;
  },

  registerBuffers(resolutionRaw) {
    const res = [16, 32, 64].includes(resolutionRaw) ? resolutionRaw : 16;
    if (!this._buffers.has(res)) {
      this._buffers.set(res, { left: new Float32Array(res), right: new Float32Array(res), average: new Float32Array(res) });
      if (this._source) this._attachAnalyser(res);
      else this._start();
    }
    return this._buffers.get(res);
  },

  _attachAnalyser(res) {
    if (!this._source || this._analysers.has(res)) return;
    const analyser = this._source.context.createAnalyser();
    analyser.fftSize = res * 2; // frequencyBinCount = fftSize/2 = res
    analyser.smoothingTimeConstant = 0.8;
    this._source.connect(analyser);
    this._analysers.set(res, { analyser, data: new Uint8Array(analyser.frequencyBinCount) });
  },

  _loop() {
    for (const [res, { analyser, data }] of this._analysers) {
      analyser.getByteFrequencyData(data);
      const buf = this._buffers.get(res);
      for (let i = 0; i < res; i++) {
        const v = (data[i] || 0) / 255;
        buf.average[i] = v; buf.left[i] = v; buf.right[i] = v;
      }
    }
    requestAnimationFrame(() => this._loop());
  },
};

const ENGINE_CLOCK = {
  frametime: 0,
  runtime: 0,
  timeOfDay: 0,
  screenResolution: new Vec2(1920, 1080),
  canvasSize: new Vec2(1920, 1080),
  userProperties: {},
  AUDIO_RESOLUTION_16: 16,
  AUDIO_RESOLUTION_32: 32,
  AUDIO_RESOLUTION_64: 64,
  isDesktopDevice() { return true; },
  isMobileDevice() { return false; },
  isWallpaper() { return true; },
  isScreensaver() { return false; },
  // Real: AudioBuffers real (.left/.right/.average como Float32Array),
  // alimentado de verdade só quando algum script pede — ver WeAudioEngine.
  registerAudioBuffers(resolution) { return WeAudioEngine.registerBuffers(resolution); },
};

// Representa um campo de constantshadervalues (ou obj.color) que PODE ser
// script-driven — se for, roda o script de verdade a cada frame (chamado
// externamente via .tick()); se não for, é só o valor estático de sempre
// (mesmo fallback do csvNum/csvVec). `isVector` decide se o valor interno é
// um número (opacity, etc.) ou um array [r,g,b]/[x,y] (color, scale, etc.).
// Real: quando uma propriedade vetorial devolve um NÚMERO puro do update(),
// a própria WE distribui esse número pros 3 componentes (confirmado no
// comentário do script real de "Nuvole": "Wallpaper Engine will create a
// Vec3 object for us if we just return a number here").
class LiveScriptValue {
  constructor(raw, staticFallback, isVector) {
    this.isVector = isVector;
    this.current = staticFallback;
    this.exports = null;
    // Um LayerHandle real por instância — scripts reais (ver cursorDown de
    // "pausa"/"playing"/etc.) mutam `thisLayer.visible` diretamente em vez
    // de (ou além de) devolver um valor de update(). Sempre existe, mesmo
    // quando o script não usa: custo desprezível, e outros consumidores
    // (ex.: dispatch de eventos de cursor) leem `.layer.visible` depois.
    this.layer = new LayerHandle({ alpha: isVector ? 1 : staticFallback, color: isVector ? new Vec3(...staticFallback) : new Vec3(1, 1, 1) });
    if (raw && typeof raw === 'object' && typeof raw.script === 'string') {
      try {
        const makeExports = compileWEScript(raw.script);
        const exports = makeExports(this.layer);
        // Guarda o script mesmo quando só exporta eventos discretos
        // (cursorDown/mediaPlaybackChanged, sem update() nenhum) — antes
        // isso descartava o script inteiro, mas ele ainda pode reagir a
        // clique real / evento real, só não tem nada pra rodar a cada frame.
        if (exports.update || exports.cursorDown || exports.cursorUp || exports.cursorClick
          || exports.cursorMove || exports.cursorEnter || exports.cursorLeave
          || exports.mediaPlaybackChanged || exports.mediaThumbnailChanged || exports.mediaPropertiesChanged) {
          this.exports = exports;
          if (exports.init) {
            const seed = this._toWEShape(staticFallback);
            const initResult = exports.init(seed);
            this.current = this._fromWEShape(initResult, staticFallback);
          }
        }
      } catch (err) {
        this.exports = null; // script real quebrado/não suportado — cai pro estático, nunca trava a cena
      }
    }
  }

  _toWEShape(val) {
    if (!this.isVector) return val;
    return new Vec3(val[0] || 0, val[1] || 0, val[2] || 0);
  }

  _fromWEShape(result, previous) {
    if (!this.isVector) {
      return typeof result === 'number' && Number.isFinite(result) ? result : previous;
    }
    if (typeof result === 'number' && Number.isFinite(result)) return [result, result, result];
    if (result && typeof result.x === 'number') {
      return [result.x, typeof result.y === 'number' ? result.y : result.x, typeof result.z === 'number' ? result.z : result.x];
    }
    return previous;
  }

  tick() {
    if (!this.exports || !this.exports.update) return this.current;
    try {
      const result = this.exports.update(this._toWEShape(this.current));
      this.current = this._fromWEShape(result, this.current);
    } catch (err) {
      this.exports = null; // erro em runtime — desiste de vez, mantém o último valor bom
    }
    return this.current;
  }

  // Despacha um evento de cursor real (cursorDown/cursorUp/cursorClick/
  // cursorMove/cursorEnter/cursorLeave) se o script exportar essa função —
  // real: recebe um CursorEvent de verdade, pode mutar thisLayer.* direto
  // (ex.: thisLayer.visible = false) em vez de (ou além de) update().
  dispatchCursorEvent(name, cursorEvent) {
    if (!this.exports || typeof this.exports[name] !== 'function') return;
    try {
      this.exports[name](cursorEvent);
    } catch (err) {
      this.exports = null;
    }
  }

  dispatchMediaEvent(name, mediaEvent) {
    if (!this.exports || typeof this.exports[name] !== 'function') return;
    try {
      this.exports[name](mediaEvent);
    } catch (err) {
      this.exports = null;
    }
  }
}

function extractOpacityConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('opacity/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    if ((pass.combos || {}).MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    // alphaRaw preserva o campo bruto pro motor de scripts (LiveScriptValue)
    // — confirmado real 2026-07-18: "Music Visualizer"'s "Nuvole" tem
    // exatamente um script áudio-reativo (engine.registerAudioBuffers) na
    // alpha do efeito opacity de um objeto, não na escala como o comentário
    // do próprio script sugeria (JSDoc genérico/copiado, não bate com onde
    // o script realmente estava amarrado nessa cena).
    return { alpha: csvNum(csv.alpha, 1.0), alphaRaw: csv.alpha };
  }
  return null;
}

// ---- Efeito real "scroll" via WebGL ----
// Porta shaders/effects/scroll.frag/.vert reais. UV rola com o tempo e
// repete (frac) — precisa de textura REPEAT (só funciona de verdade se a
// imagem for potência-de-2; ver uploadTextureWrapped).
const SCROLL_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec2 v_Scroll;
uniform float g_Time;
uniform float g_ScrollX;
uniform float g_ScrollY;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  vec2 scroll = vec2(g_ScrollX, g_ScrollY);
  scroll = sign(scroll) * pow(vec2(abs(g_ScrollX), abs(g_ScrollY)), vec2(2.0));
  v_Scroll = scroll * g_Time;
}
`;

function buildScrollFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec2 v_Scroll;
uniform sampler2D g_Texture0;
uniform vec2 g_Scale;
void main() {
  vec2 texCoord = fract((v_TexCoord + v_Scroll) * g_Scale);
  gl_FragColor = texture2D(g_Texture0, texCoord);
}
`;
}

function extractScrollConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('scroll/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const csv = pass.constantshadervalues || {};
    return {
      scrollX: csvNum(csv.speedx, 0.2),
      scrollY: csvNum(csv.speedy, 0.2),
      repeat: csvVec(csv.repeat, [1, 1]),
    };
  }
  return null;
}

// ---- Efeito real "spin" via WebGL ----
// Porta shaders/effects/spin.frag/.vert reais — gira uma região circular da
// imagem em torno de um centro, com máscara suave voltando pro conteúdo
// parado fora do raio. Só suporta ELLIPTICAL==1 e NOISE==0 (os defaults reais).
const SPIN_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
varying vec2 v_TexCoordSoftMask;
uniform float g_Time;
uniform float g_Aspect;
uniform float g_Speed;
uniform vec2 g_SpinCenter;
uniform float g_Ratio;
uniform float g_Axis;
uniform float g_Phase;

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xyzw = a_TexCoord.xyxy;

  v_TexCoord.xy -= g_SpinCenter;
  v_TexCoord.x *= g_Aspect;

  v_TexCoord.xy = rotateVec2(v_TexCoord.xy, g_Axis);
  v_TexCoord.x *= g_Ratio;
  v_TexCoordSoftMask.xy = v_TexCoord.xy;

  float offset = g_Phase * 6.28318530718;
  v_TexCoord.xy = rotateVec2(v_TexCoord.xy, g_Speed * g_Time + offset);

  v_TexCoord.x /= g_Ratio;
  v_TexCoord.xy = rotateVec2(v_TexCoord.xy, -g_Axis);
  v_TexCoordSoftMask.xy = rotateVec2(v_TexCoordSoftMask.xy, -g_Axis);

  v_TexCoord.x /= g_Aspect;
  v_TexCoord.xy += g_SpinCenter;
  v_TexCoordSoftMask.xy += g_SpinCenter;
}
`;

function buildSpinFragSource({ repeat }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
varying vec2 v_TexCoordSoftMask;
uniform sampler2D g_Texture0;
uniform vec2 g_SpinCenter;
uniform float g_Size;
uniform float g_Feather;
#define REPEAT ${repeat ? 1 : 0}
void main() {
  vec2 texCoord = v_TexCoord.xy;
#if REPEAT == 1
  texCoord = fract(texCoord);
#endif
  vec4 spun = texture2D(g_Texture0, texCoord);

  vec2 maskDelta = v_TexCoordSoftMask.xy - g_SpinCenter;
  float mask = smoothstep(g_Size + g_Feather + 0.00001, g_Size - g_Feather, length(maskDelta));

  gl_FragColor = mix(texture2D(g_Texture0, v_TexCoord.zw), spun, mask);
}
`;
}

function extractSpinConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('spin/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.ELLIPTICAL != null && !combos.ELLIPTICAL) return { unsupported: 'ELLIPTICAL desligado (só o default/ligado suportado)' };
    if (combos.NOISE) return { unsupported: 'NOISE (jitter de ruído não suportado)' };
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      center: csvVec(csv.center, [0.5, 0.5]),
      size: csvNum(csv.size, 0.1),
      feather: csvNum(csv.feather, 0.002),
      speed: csvNum(csv.speed, 1.0),
      ratio: csvNum(csv.ratio, 1.0),
      axis: csvNum(csv.angle, 0.0),
      phase: csvNum(csv.phase, 0.0),
      repeat: combos.REPEAT != null ? !!combos.REPEAT : true,
    };
  }
  return null;
}

// ---- Efeito real "swing" via WebGL ----
// Porta shaders/effects/swing.frag/.vert reais — distorção tipo "bandeira/
// página balançando" em torno de um eixo definido por 2 pontos. Só suporta
// NOISE==0 (default real); DOUBLESIDED lido de verdade do scene.json.
const SWING_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform float g_Time;
uniform float g_Aspect;
uniform float g_Amount;
uniform float g_Speed;
uniform float g_Phase;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  v_TexCoord.z = g_Aspect;
  v_TexCoord.w = sin(g_Time * g_Speed + g_Phase * 6.28318530718) * g_Amount;
}
`;

function buildSwingFragSource({ doubleSided }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
uniform vec2 g_Point0;
uniform vec2 g_Point1;
uniform float g_Size;
uniform float g_CenterPos;
uniform float g_Feather;
uniform float g_Amount;
#define DOUBLESIDED ${doubleSided ? 1 : 0}
void main() {
  vec2 texCoord = v_TexCoord.xy;
  float aspect = v_TexCoord.z;
  vec2 p0 = g_Point0; vec2 p1 = g_Point1;
  p0.x *= aspect; p1.x *= aspect; texCoord.x *= aspect;

  vec2 axis = normalize(p1 - p0);
  vec2 center = p0 + (p1 - p0) * g_CenterPos;
  vec2 axisOrtho = vec2(-axis.y, axis.x);
  vec2 uvDelta = texCoord - center;

  float distanceAlongAxis = dot(axis, uvDelta);
  float distanceOrtho = dot(axisOrtho, uvDelta);

  float anim = v_TexCoord.w;
  float distortAmt = anim;
  vec2 uvDistort = axis * distortAmt * distanceOrtho * distanceAlongAxis;
  uvDistort += axisOrtho * distortAmt * anim * distanceOrtho;
  texCoord += uvDistort;

  float mask = 1.0;
  float feather = max(g_Feather, 0.00001);
  vec2 deltaRight = texCoord - p1;
  vec2 deltaLeft = texCoord - p0;
  float distanceRight = dot(deltaRight, axis);
  float distanceLeft = dot(deltaLeft, axis);
  mask *= smoothstep(feather, 0.0, distanceRight);
  mask *= smoothstep(-feather, 0.0, distanceLeft);

  float sizeMod = g_Size * (1.0 - abs(anim) * g_Amount * 0.5);
  mask *= smoothstep(sizeMod + feather, sizeMod - feather, distanceOrtho);
#if DOUBLESIDED == 1
  mask *= smoothstep(sizeMod + feather, sizeMod - feather, -distanceOrtho);
#else
  mask *= step(0.0, distanceOrtho);
#endif

  texCoord.x /= aspect;
  texCoord = mix(v_TexCoord.xy, texCoord, mask);
  gl_FragColor = texture2D(g_Texture0, texCoord);
}
`;
}

function extractSwingConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('swing/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.NOISE) return { unsupported: 'NOISE (jitter de ruído não suportado)' };
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      point0: csvVec(csv.point0, [0.25, 0.5]),
      point1: csvVec(csv.point1, [0.75, 0.5]),
      size: csvNum(csv.size, 0.4),
      centerPos: csvNum(csv.center, 0.5),
      feather: csvNum(csv.feather, 0.01),
      amount: csvNum(csv.amount, 0.2),
      speed: csvNum(csv.speed, 2.0),
      phase: csvNum(csv.phase, 0.0),
      doubleSided: !!combos.DOUBLESIDED,
    };
  }
  return null;
}

// ---- Efeito real "skew" via WebGL ----
// Porta shaders/effects/skew.frag/.vert reais (modo UV, o default) — desloca
// os 4 cantos da UV por top/bottom/left/right. Estático, uma vez só.
const SKEW_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
uniform float g_Top;
uniform float g_Bottom;
uniform float g_Left;
uniform float g_Right;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  v_TexCoord.x -= step(a_TexCoord.y, 0.5) * g_Top + step(0.5, a_TexCoord.y) * g_Bottom;
  v_TexCoord.y += step(a_TexCoord.x, 0.5) * g_Left + step(0.5, a_TexCoord.x) * g_Right;
}
`;

function buildSkewFragSource({ repeat }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
#define REPEAT ${repeat ? 1 : 0}
void main() {
  vec2 texCoord = v_TexCoord;
#if REPEAT == 1
  texCoord = fract(texCoord);
#endif
  gl_FragColor = texture2D(g_Texture0, texCoord);
}
`;
}

function extractSkewConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('skew/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MODE) return { unsupported: 'MODE Vertex (só UV/0 suportado)' };
    const csv = pass.constantshadervalues || {};
    return {
      top: csvNum(csv.top, 0),
      bottom: csvNum(csv.bottom, 0),
      left: csvNum(csv.left, 0),
      right: csvNum(csv.right, 0),
      repeat: combos.REPEAT != null ? !!combos.REPEAT : true,
    };
  }
  return null;
}

// ---- Efeito real "transform" via WebGL ----
// Porta shaders/effects/transform.frag/.vert reais (modo UV, o default) —
// rotação/escala/deslocamento estáticos da UV.
const TRANSFORM_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
uniform vec2 g_Offset;
uniform vec2 g_Scale;
uniform float g_Direction;

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  vec2 v = a_TexCoord;
  v = rotateVec2(v - vec2(0.5), -g_Direction);
  v_TexCoord = (v + g_Offset) * g_Scale + vec2(0.5);
}
`;

function buildTransformFragSource({ repeat }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
#define CLAMPMODE ${repeat ? 1 : 0}
void main() {
  vec2 texCoord = v_TexCoord;
#if CLAMPMODE == 1
  texCoord = fract(texCoord);
#endif
  gl_FragColor = texture2D(g_Texture0, texCoord);
}
`;
}

function extractTransformConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('transform/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MODE) return { unsupported: 'MODE Vertex (só UV/0 suportado)' };
    const csv = pass.constantshadervalues || {};
    return {
      offset: csvVec(csv.offset, [0, 0]),
      scale: csvVec(csv.scale, [1, 1]),
      direction: csvNum(csv.angle, 0),
      // O nome real do combo é "CLAMP" mas o código dentro do #if faz
      // fract() (repetir), não clamp — apelido confuso no próprio shader da
      // WE, mantive o comportamento real, só documentei aqui.
      repeat: combos.CLAMP != null ? !!combos.CLAMP : true,
    };
  }
  return null;
}

// ---- Efeito real "shake" via WebGL ----
// Porta shaders/effects/shake.frag/.vert reais — jitter de posição pulsante
// usando o mapa de direção padrão da própria WE (materials/util/noflow.tex,
// neutro/sem-direção quando a cena não pinta um mapa customizado). Só
// suporta AUDIOPROCESSING==0 e NOISE==0 e TIMEOFFSET==0 (defaults reais;
// áudio-reativo não existe nesse projeto ainda).
const SHAKE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
varying vec2 v_Bounds;
uniform vec2 g_Bounds;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  v_TexCoord.zw = a_TexCoord;
  v_Bounds.x = g_Bounds.x;
  v_Bounds.y = 1.0 / (g_Bounds.y - g_Bounds.x);
}
`;

function buildShakeFragSource({ direction }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
varying vec2 v_Bounds;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_Time;
uniform float g_Speed;
uniform float g_Amp;
uniform vec2 g_Friction;
#define DIRECTION ${direction}
void main() {
  vec2 flowColors = texture2D(g_Texture1, v_TexCoord.zw).rg;
  vec2 flowMask = (flowColors.rg - vec2(0.498, 0.498)) * 2.0;

  float time = g_Speed * g_Time;
  float offset = sin(fract(time / 1.5707963268) * 1.5707963268);
  offset = offset * 0.498 + 0.5;
  float base = step(0.0, cos(time));
  offset = mix(1.0 - pow(1.0 - offset, g_Friction.x), pow(offset, g_Friction.y), base);
  offset = clamp((offset - v_Bounds.x) * v_Bounds.y, 0.0, 1.0);

#if DIRECTION == 0
  offset = offset * 2.0 - 1.0;
#endif
#if DIRECTION == 2
  offset = offset - 1.0;
#endif

  vec2 texCoordOffset = offset * g_Amp * g_Amp * flowMask;
  gl_FragColor = texture2D(g_Texture0, texCoordOffset + v_TexCoord.xy);
}
`;
}

function extractShakeConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('shake/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.AUDIOPROCESSING) return { unsupported: 'AUDIOPROCESSING (áudio-reativo não implementado neste projeto)' };
    if (combos.NOISE) return { unsupported: 'NOISE (jitter de ruído adicional não suportado)' };
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      speed: csvNum(csv.speed, 1),
      amp: csvNum(csv.strength, 0.1),
      friction: csvVec(csv.friction, [1, 1]),
      bounds: csvVec(csv.bounds, [0, 1]),
      direction: combos.DIRECTION != null ? combos.DIRECTION : 0,
    };
  }
  return null;
}

// ---- Efeito real "pulse" via WebGL ----
// Porta shaders/effects/pulse.frag/.vert reais — pulsa tint/brilho com o
// tempo (+ leve flicker de ruído), blend Add (default real, BLENDMODE=9).
// Só suporta AUDIOPROCESSING==0 (default real).
const PULSE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying float v_Pulse;
uniform float g_Time;
uniform vec2 g_PulseThresholds;
uniform float g_PulseSpeed;
uniform float g_PulsePhase;
uniform float g_PulseAmount;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  v_Pulse = smoothstep(g_PulseThresholds.x, g_PulseThresholds.y,
    sin(g_Time * g_PulseSpeed + (g_PulsePhase - 0.25) * 6.28318530718) * 0.5 + 0.5) * g_PulseAmount;
}
`;

function buildPulseFragSource({ pulseColor, pulseAlpha }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_Time;
uniform float g_PulseSpeed;
uniform float g_PulsePhase;
uniform float g_PulseAmount;
uniform vec2 g_PulseThresholds;
uniform float g_NoiseSpeed;
uniform float g_NoiseAmount;
uniform float g_Power;
uniform vec3 g_TintColor1;
uniform vec3 g_TintColor2;
#define PULSECOLOR ${pulseColor ? 1 : 0}
#define PULSEALPHA ${pulseAlpha ? 1 : 0}

vec3 BlendAdd(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);

  float pulse = smoothstep(g_PulseThresholds.x, g_PulseThresholds.y,
    sin(g_Time * g_PulseSpeed + (g_PulsePhase - 1.57079632679)) * 0.5 + 0.5) * g_PulseAmount;
  float noise = texture2D(g_Texture1, vec2(g_Time * 0.08333333, g_Time * 0.02777777) * g_NoiseSpeed).r * g_NoiseAmount;
  pulse += noise;
  pulse = pow(max(pulse, 0.0), g_Power);

#if PULSECOLOR == 1
  vec3 A = albedo.rgb * g_TintColor1;
  vec3 B = albedo.rgb * g_TintColor2;
  albedo.rgb = mix(A, BlendAdd(A, B), pulse);
#endif

#if PULSEALPHA == 1
  albedo.a *= pulse;
#endif

  gl_FragColor = vec4(max(albedo.rgb, vec3(0.0)), albedo.a);
}
`;
}

function extractPulseConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('pulse/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.AUDIOPROCESSING) return { unsupported: 'AUDIOPROCESSING (áudio-reativo não implementado neste projeto)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 9;
    if (blendMode !== 9) return { unsupported: `BLENDMODE ${blendMode} (só Add/9 suportado)` };
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      pulseThresholds: csvVec(csv.bounds, [0, 1]),
      pulseSpeed: csvNum(csv.speed, 3),
      pulsePhase: csvNum(csv.phase, 0),
      pulseAmount: csvNum(csv.amount, 1),
      noiseSpeed: csvNum(csv.noisespeed, 0.5),
      noiseAmount: csvNum(csv.noiseamount, 0),
      power: csvNum(csv.power, 1),
      tintColor1: csvVec(csv.tintlow, [1, 1, 1]),
      tintColor2: csvVec(csv.tinthigh, [1, 1, 1]),
      pulseColor: combos.PULSECOLOR != null ? !!combos.PULSECOLOR : true,
      pulseAlpha: !!combos.PULSEALPHA,
    };
  }
  return null;
}

// ---- Efeito real "fisheye" via WebGL ----
// Porta shaders/effects/fisheye.frag/.vert reais — projeção de lente (178°
// de abertura, mesma fórmula real). Estático, sem g_Time, uma vez só.
function buildFisheyeFragSource({ background }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float g_Size;
uniform float g_Scale;
uniform vec2 g_Center;
#define BACKGROUND ${background ? 1 : 0}
#define M_PI 3.14159265359

void main() {
  float aperture = 178.0;
  float apertureHalf = 0.5 * aperture * (M_PI / 180.0);
  float maxFactor = sin(apertureHalf);

  vec2 uv;
  vec2 xy = (v_TexCoord.xy - g_Center) * 2.0 / g_Size;
  float d = length(xy);
  float alpha = 1.0;
  if (d < (2.0 - maxFactor)) {
    d = length(xy * maxFactor);
    float z = sqrt(1.0 - d * d);
    float r = atan(d, z) / M_PI;
    float phi = atan(xy.y, xy.x);
    uv.x = r * cos(phi) * g_Size + g_Center.x;
    uv.y = r * sin(phi) * g_Size + g_Center.y;
  } else {
    uv = v_TexCoord.xy;
#if BACKGROUND == 0
    alpha = 0.0;
#endif
  }

  vec4 albedo = texture2D(g_Texture0, mix(v_TexCoord.xy, uv, g_Scale));
  albedo.a *= alpha;
  gl_FragColor = albedo;
}
`;
}

function extractFisheyeConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('fisheye/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const csv = pass.constantshadervalues || {};
    return {
      size: csvNum(csv.size, 1),
      scale: csvNum(csv.distortion, 1),
      center: csvVec(csv.center, [0.5, 0.5]),
      background: (pass.combos || {}).BACKGROUND != null ? !!(pass.combos || {}).BACKGROUND : true,
    };
  }
  return null;
}

// ---- Efeito real "twirl" via WebGL ----
// Porta shaders/effects/twirl.frag/.vert reais — rotação com intensidade
// crescente perto do centro (efeito "redemoinho"), animada. Só suporta
// ELLIPTICAL==1, NOISE==0, INNER==0 (defaults reais).
const TWIRL_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform float g_Time;
uniform float g_Aspect;
uniform float g_Amount;
uniform float g_Speed;
uniform float g_Phase;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  v_TexCoord.z = g_Aspect;
  v_TexCoord.w = sin(g_Time * g_Speed + g_Phase * 6.28318530718) * g_Amount;
}
`;

function buildTwirlFragSource({ repeat }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
uniform vec2 g_SpinCenter;
uniform float g_Size;
uniform float g_Feather;
uniform float g_Ratio;
uniform float g_Axis;
#define REPEAT ${repeat ? 1 : 0}

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main() {
  float aspect = v_TexCoord.z;
  vec2 texCoord = v_TexCoord.xy;

  texCoord -= g_SpinCenter;
  texCoord.x *= aspect;

  texCoord.xy = rotateVec2(texCoord.xy, g_Axis);
  texCoord.x *= g_Ratio;

  float feather = smoothstep(g_Size + g_Feather + 0.00001, g_Size - g_Feather, length(texCoord.xy));
  float dist = length(texCoord) / g_Size;
  float anim = v_TexCoord.w * dist;

  texCoord = rotateVec2(texCoord, anim);

  texCoord.x /= g_Ratio;
  texCoord.xy = rotateVec2(texCoord.xy, -g_Axis);

  texCoord.x /= aspect;
  texCoord += g_SpinCenter;

#if REPEAT == 1
  texCoord = fract(texCoord);
#endif

  texCoord = mix(v_TexCoord.xy, texCoord, feather);
  gl_FragColor = texture2D(g_Texture0, texCoord);
}
`;
}

function extractTwirlConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('twirl/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.ELLIPTICAL != null && !combos.ELLIPTICAL) return { unsupported: 'ELLIPTICAL desligado (só o default/ligado suportado)' };
    if (combos.NOISE) return { unsupported: 'NOISE (jitter de ruído não suportado)' };
    if (combos.INNER) return { unsupported: 'INNER (modo interno não suportado)' };
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      center: csvVec(csv.center, [0.5, 0.5]),
      size: csvNum(csv.size, 0.5),
      feather: csvNum(csv.feather, 0.002),
      ratio: csvNum(csv.ratio, 1.0),
      axis: csvNum(csv.angle, 0.0),
      amount: csvNum(csv.amount, 1.0),
      speed: csvNum(csv.speed, 1.0),
      phase: csvNum(csv.phase, 0.0),
      repeat: combos.REPEAT != null ? !!combos.REPEAT : true,
    };
  }
  return null;
}

// ---- Efeito real "perspective" via WebGL ----
// Porta shaders/effects/perspective.frag/.vert reais — reaproveita
// squareToQuadRows/invert3x3Rows (já usados pelo lightshafts) pro mesmo
// cálculo de homografia 4-pontos, mesma técnica, sem duplicar a matemática.
// Default real dos 4 pontos é a identidade (sem distorção nenhuma) — só
// distorce de verdade se a cena tiver customizado os pontos.
const PERSPECTIVE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec3 v_TexCoord;
uniform vec3 u_XformRow0;
uniform vec3 u_XformRow1;
uniform vec3 u_XformRow2;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord.x * u_XformRow0 + a_TexCoord.y * u_XformRow1 + u_XformRow2;
}
`;

function buildPerspectiveFragSource({ repeat }) {
  return `
precision mediump float;
varying vec3 v_TexCoord;
uniform sampler2D g_Texture0;
#define REPEAT ${repeat ? 1 : 0}
void main() {
  vec2 texCoord = v_TexCoord.xy / v_TexCoord.z;
  float mask = step(0.0, v_TexCoord.z);
#if REPEAT == 1
  texCoord = fract(texCoord);
#else
  mask *= step(abs(texCoord.x - 0.5), 0.5);
  mask *= step(abs(texCoord.y - 0.5), 0.5);
#endif
  gl_FragColor = texture2D(g_Texture0, texCoord);
  gl_FragColor.a *= mask;
}
`;
}

function extractPerspectiveConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('perspective/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    if ((pass.combos || {}).MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      point0: csvVec(csv.point0, [0, 0]),
      point1: csvVec(csv.point1, [1, 0]),
      point2: csvVec(csv.point2, [1, 1]),
      point3: csvVec(csv.point3, [0, 1]),
      repeat: !!(pass.combos || {}).REPEAT,
    };
  }
  return null;
}

// ---- Efeito real "tint" via WebGL ----
// Porta shaders/effects/tint.frag real — tinge a imagem com uma cor via o
// blend mode "Tint" (BlendTint = vec3(max(r,max(g,b))) * cor), que é o
// default real do efeito (BLENDMODE=30). Só suporta esse modo (o único
// confirmado contra o shader real) e não suporta MASK (textura de
// opacidade extra).
// Real (common_blending.h): RGBToHSL/HueToRGB/HSLToRGB portados fiéis, só
// aqui — os 3 blend modes reais confirmados em cenas de verdade
// ("Music Cat"'s "Color": HUE/B&W/Rainbow, todos efeitos "tint") precisam
// de conversão HSL de verdade, não só um multiply — BLENDMODE 26 (Hue: troca
// o matiz, preserva saturação/luminosidade do fundo) e 28 (Color: troca
// matiz+saturação, preserva só a luminosidade — é isso que faz um "B&W" de
// verdade quando a cor é branca) são tão comuns nesse efeito quanto o 30
// (Tint puro) que era o único suportado antes.
const HSL_GLSL = `
vec3 rgb2hsl(vec3 color) {
  float fmin = min(min(color.r, color.g), color.b);
  float fmax = max(max(color.r, color.g), color.b);
  float delta = fmax - fmin;
  vec3 hsl;
  hsl.z = (fmax + fmin) / 2.0;
  if (delta == 0.0) {
    hsl.x = 0.0;
    hsl.y = 0.0;
  } else {
    hsl.y = hsl.z < 0.5 ? delta / (fmax + fmin) : delta / (2.0 - fmax - fmin);
    float deltaR = (((fmax - color.r) / 6.0) + (delta / 2.0)) / delta;
    float deltaG = (((fmax - color.g) / 6.0) + (delta / 2.0)) / delta;
    float deltaB = (((fmax - color.b) / 6.0) + (delta / 2.0)) / delta;
    if (color.r == fmax) hsl.x = deltaB - deltaG;
    else if (color.g == fmax) hsl.x = (1.0 / 3.0) + deltaR - deltaB;
    else hsl.x = (2.0 / 3.0) + deltaG - deltaR;
    if (hsl.x < 0.0) hsl.x += 1.0;
    else if (hsl.x > 1.0) hsl.x -= 1.0;
  }
  return hsl;
}
float hue2rgb(float f1, float f2, float hue) {
  if (hue < 0.0) hue += 1.0;
  else if (hue > 1.0) hue -= 1.0;
  if ((6.0 * hue) < 1.0) return f1 + (f2 - f1) * 6.0 * hue;
  if ((2.0 * hue) < 1.0) return f2;
  if ((3.0 * hue) < 2.0) return f1 + (f2 - f1) * ((2.0 / 3.0) - hue) * 6.0;
  return f1;
}
vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y == 0.0) return vec3(hsl.z);
  float f2 = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : (hsl.z + hsl.y) - (hsl.y * hsl.z);
  float f1 = 2.0 * hsl.z - f2;
  return vec3(hue2rgb(f1, f2, hsl.x + 1.0 / 3.0), hue2rgb(f1, f2, hsl.x), hue2rgb(f1, f2, hsl.x - 1.0 / 3.0));
}
`;

function buildTintFragSource(blendMode) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float g_BlendAlpha;
uniform vec3 g_TintColor;
${HSL_GLSL}
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec3 base = albedo.rgb;
  vec3 blended;
#if ${blendMode} == 26
  vec3 baseHsl = rgb2hsl(base);
  blended = hsl2rgb(vec3(rgb2hsl(g_TintColor).x, baseHsl.y, baseHsl.z));
#elif ${blendMode} == 28
  vec3 blendHsl = rgb2hsl(g_TintColor);
  blended = hsl2rgb(vec3(blendHsl.x, blendHsl.y, rgb2hsl(base).z));
#else
  float luma = max(base.r, max(base.g, base.b));
  blended = vec3(luma) * g_TintColor;
#endif
  albedo.rgb = mix(base, blended, g_BlendAlpha);
  gl_FragColor = albedo;
}
`;
}

function extractTintConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('tint/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 30;
    // Real: Tint(30)/Hue(26)/Color(28) confirmados em cenas reais — os 3
    // usam a mesma estrutura de efeito (tint/effect.json), só muda a
    // fórmula de mistura. Qualquer outro modo continua não suportado.
    if (blendMode !== 30 && blendMode !== 26 && blendMode !== 28) {
      return { unsupported: `BLENDMODE ${blendMode} (só Tint/30, Hue/26 ou Color/28 suportados)` };
    }
    const csv = pass.constantshadervalues || {};
    // alphaRaw/colorRaw preservam o campo bruto (pode ser script real, ver
    // LiveScriptValue) — alpha/color continuam existindo como o valor
    // estático de sempre, pros chamadores que não têm loop de frame.
    return {
      blendMode,
      alpha: csvNum(csv.alpha, 1),
      color: csvVec(csv.color, [1, 0, 0]),
      alphaRaw: csv.alpha,
      colorRaw: csv.color,
    };
  }
  return null;
}

// ---- Efeito real "colorkey" via WebGL ----
// Porta shaders/effects/colorkey.frag real — chroma-key: mede a distância
// entre a cor do pixel e g_KeyColor e usa isso pra decidir alfa (mistura
// com g_KeyAlpha em vez de descartar por completo). INVERT e FLATTEN são
// combos reais totalmente suportados aqui (não dependem de textura extra).
function buildColorKeyFragSource({ invert, flatten }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float g_KeyAlpha;
uniform float g_KeyFuzz;
uniform float g_KeyTolerance;
uniform vec3 g_KeyColor;
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  float delta = dot(abs(g_KeyColor - albedo.rgb), vec3(1.0, 1.0, 1.0));
  float blend = smoothstep(0.001, 0.002 + g_KeyFuzz, delta - g_KeyTolerance);
  ${invert ? 'blend = 1.0 - blend;' : ''}
  albedo.a *= mix(g_KeyAlpha, 1.0, blend);
  ${flatten ? 'albedo.rgb *= albedo.a;' : ''}
  gl_FragColor = albedo;
}
`;
}

function extractColorKeyConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('colorkey/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    const csv = pass.constantshadervalues || {};
    return {
      invert: !!combos.INVERT,
      flatten: !!combos.FLATTEN,
      keyAlpha: csvNum(csv.alpha, 0),
      keyFuzz: csvNum(csv.fuzziness, 0),
      keyTolerance: csvNum(csv.tolerance, 0.1),
      keyColor: csvVec(csv.color, [1, 1, 1]),
    };
  }
  return null;
}

// ---- Efeito real "blend" via WebGL ----
// Porta shaders/effects/blend.frag/.vert reais — mistura uma textura extra
// por cima da imagem base com um blend mode (default real BLENDMODE=2,
// Multiply), UV escalado pela razão de tamanho entre a imagem base e a
// textura de blend (TRANSFORMUV=0, modo "clip": fora da área da textura de
// blend não aplica nada). Só suporta 1 textura de blend (NUMBLENDTEXTURES==1,
// de longe o caso mais comum) e sem WRITEALPHA/OPACITYMASK/TRANSFORMUV.
// Sem textura de blend real definida na cena (pass.textures[1] ausente), o
// default da WE é "util/white": com Multiply isso é matematicamente um
// no-op (base*branco=base) — então pulamos por completo em vez de desenhar
// um passe que não muda nada.
const BLEND_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform vec2 u_BlendTexScale;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  v_TexCoord.zw = a_TexCoord * u_BlendTexScale;
}
`;

function buildBlendFragSource() {
  return `
precision mediump float;
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_Multiply;

vec3 BlendMultiply(vec3 base, vec3 blend) { return base * blend; }

float GetUVBlend(vec2 uv) {
  return step(0.99, dot(step(vec2(0.0), uv) * step(uv, vec2(1.0)), vec2(0.5)));
}

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord.xy);
  vec2 blendUV = v_TexCoord.zw;
  vec4 blendColors = texture2D(g_Texture1, blendUV);
  float blendAlpha = GetUVBlend(blendUV) * g_Multiply * blendColors.a;
  albedo.rgb = mix(albedo.rgb, BlendMultiply(albedo.rgb, blendColors.rgb), blendAlpha);
  gl_FragColor = albedo;
}
`;
}

function extractBlendConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('blend/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    const numTex = combos.NUMBLENDTEXTURES != null ? combos.NUMBLENDTEXTURES : 1;
    if (numTex !== 1) return { unsupported: `NUMBLENDTEXTURES ${numTex} (só 1 textura de blend suportada)` };
    if (combos.TRANSFORMUV) return { unsupported: 'TRANSFORMUV (transformação de UV do blend não suportada)' };
    if (combos.WRITEALPHA) return { unsupported: 'WRITEALPHA (escrita de alfa customizada não suportada)' };
    if (combos.OPACITYMASK) return { unsupported: 'OPACITYMASK (máscara de opacidade não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 2;
    if (blendMode !== 2) return { unsupported: `BLENDMODE ${blendMode} (só Multiply/2 suportado)` };
    const texId = pass.textures && pass.textures[1];
    if (!texId) return null; // sem textura real de blend: default "util/white"+Multiply é no-op, nada a aplicar
    const csv = pass.constantshadervalues || {};
    return {
      texId,
      multiply: csvNum(csv.multiply, 1),
    };
  }
  return null;
}

// ---- Efeito real "blendgradient" via WebGL ----
// Porta shaders/effects/blendgradient.frag/.vert reais — usa uma textura em
// tons de cinza (default real: util/clouds_256, textura de nuvens/ruído da
// própria WE) como máscara de gradiente pra decidir ONDE aplicar uma cor de
// blend (default real: branco puro) via smoothstep sobre g_Multiply. Mesmo
// sem nenhuma customização isso já produz um efeito visível real (um "wash"
// no formato do ruído de nuvens) — diferente do "blend" simples, aqui o
// default NÃO é um no-op. BLENDMODE default real é 0 (Normal). TRANSFORMUV/
// WRITEALPHA/OPACITYMASK não suportados (não confirmados em cena real).
// EDGEGLOW é suportado por inteiro (não depende de textura extra).
// Nota: a textura de gradiente é amostrada com o MESMO UV escalado da
// textura de cor (é assim no shader real — parece não intencional, mas é
// fiel ao original). Quando não há textura de cor real na cena, sintetizamos
// um branco 1x1 (nosso decodificador de .tex não decodifica o "util/white"
// real da instalação — formato não suportado) e usamos escala 1:1 nesse
// caso (aproximação razoável pra não distorcer a amostragem do gradiente).
const BLENDGRADIENT_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform vec2 u_Tex1Scale;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  v_TexCoord.zw = a_TexCoord * u_Tex1Scale;
}
`;

function buildBlendGradientFragSource({ edgeGlow }) {
  return `
precision mediump float;
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform sampler2D g_Texture2;
uniform float g_Multiply;
uniform float g_GradientScale;
uniform float g_EdgeBrightness;
uniform vec3 g_EdgeColor;
#define EDGEGLOW ${edgeGlow ? 1 : 0}

float GetUVBlend(vec2 uv) {
  return step(0.99, dot(step(vec2(0.0), uv) * step(uv, vec2(1.0)), vec2(0.5)));
}

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord.xy);
  vec2 blendUV = v_TexCoord.zw;
  vec4 blendColors = texture2D(g_Texture1, blendUV);
  float gradient = texture2D(g_Texture2, blendUV).r;
  float blend = smoothstep(clamp(gradient - g_GradientScale, 0.0, 1.0), clamp(gradient + g_GradientScale, 0.0, 1.0), g_Multiply);
  float blendAlpha = GetUVBlend(blendUV) * blend * blendColors.a;
  albedo.rgb = mix(albedo.rgb, blendColors.rgb, blendAlpha);
#if EDGEGLOW == 1
  float burnWidth = g_GradientScale * 0.5;
  float burnAmount = step(gradient - burnWidth, g_Multiply) *
    step(g_Multiply, gradient + burnWidth) *
    step(0.01, g_Multiply) *
    step(g_Multiply, 0.999);
  albedo.rgb = max(vec3(0.0), mix(albedo.rgb, g_EdgeColor, burnAmount * g_EdgeBrightness));
#endif
  gl_FragColor = albedo;
}
`;
}

function extractBlendGradientConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('blendgradient/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.TRANSFORMUV) return { unsupported: 'TRANSFORMUV (transformação de UV do blend não suportada)' };
    if (combos.WRITEALPHA) return { unsupported: 'WRITEALPHA (escrita de alfa customizada não suportada)' };
    if (combos.OPACITYMASK) return { unsupported: 'OPACITYMASK (máscara de opacidade não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 0;
    if (blendMode !== 0) return { unsupported: `BLENDMODE ${blendMode} (só Normal/0 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      colorTexId: (pass.textures && pass.textures[1]) || null,
      gradientTexId: (pass.textures && pass.textures[2]) || null,
      multiply: csvNum(csv.multiply, 1),
      gradientScale: csvNum(csv.gradientscale, 0.05),
      edgeGlow: !!combos.EDGEGLOW,
      edgeBrightness: csvNum(csv.edgebrightness, 1),
      edgeColor: csvVec(csv.edgecolor, [1, 0.75, 0]),
    };
  }
  return null;
}

// ---- Efeito real "localcontrast" via WebGL (pipeline de 4 passes real) ----
// Porta os 4 shaders reais (localcontrast_downsample4, _gaussian x2 em
// horizontal/vertical, _combine) — downsample em caixa pra 1/4 da
// resolução (confirmado via effect.json real: fbos com "scale":4), blur
// gaussiano separável nessa resolução reduzida (13/7/3 taps conforme
// KERNEL) e um unsharp mask final (original + (original-borrado)*força)
// pra realçar contraste local sem borrar a imagem toda. Pipeline estático
// (1 render, sem tempo/animação), igual ao real. MASK não suportado.
// A ordem dos 4 passes é fixa (confirmada via localcontrast/effect.json:
// downsample4 -> gaussian_x -> gaussian_y -> combine), então lemos
// combos/csv de cada índice fixo em vez de procurar por nome de arquivo.
const GAUSSIAN_WEIGHTS = {
  0: [0.006299, 0.017298, 0.039533, 0.075189, 0.119007, 0.156756, 0.171834, 0.156756, 0.119007, 0.075189, 0.039533, 0.017298, 0.006299],
  1: [0.071303, 0.131514, 0.189879, 0.214607, 0.189879, 0.131514, 0.071303],
  2: [0.25, 0.5, 0.25],
};

const LOCALCONTRAST_DOWNSAMPLE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord0;
varying vec2 v_TexCoord1;
varying vec2 v_TexCoord2;
varying vec2 v_TexCoord3;
uniform vec2 u_TexelSize;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord0 = a_TexCoord - u_TexelSize;
  v_TexCoord1 = a_TexCoord + vec2(u_TexelSize.x, -u_TexelSize.y);
  v_TexCoord2 = a_TexCoord + vec2(-u_TexelSize.x, u_TexelSize.y);
  v_TexCoord3 = a_TexCoord + u_TexelSize;
}
`;
const LOCALCONTRAST_DOWNSAMPLE_FRAG = `
precision mediump float;
varying vec2 v_TexCoord0;
varying vec2 v_TexCoord1;
varying vec2 v_TexCoord2;
varying vec2 v_TexCoord3;
uniform sampler2D g_Texture0;
void main() {
  vec4 s0 = texture2D(g_Texture0, v_TexCoord0);
  vec4 s1 = texture2D(g_Texture0, v_TexCoord1);
  vec4 s2 = texture2D(g_Texture0, v_TexCoord2);
  vec4 s3 = texture2D(g_Texture0, v_TexCoord3);
  vec4 result = s0 * s0.a + s1 * s1.a + s2 * s2.a + s3 * s3.a;
  float weight = s0.a + s1.a + s2.a + s3.a;
  gl_FragColor.rgb = result.rgb / max(0.001, weight);
  gl_FragColor.a = result.a / 4.0;
}
`;

function buildLocalContrastGaussianVert(kernel) {
  const weights = GAUSSIAN_WEIGHTS[kernel];
  const n = weights.length;
  const half = (n - 1) / 2;
  const varyings = [];
  const assigns = [];
  for (let i = 0; i < n; i++) {
    varyings.push(`varying vec2 v_TexCoord${i};`);
    const k = i - half;
    assigns.push(`v_TexCoord${i} = vec2(a_TexCoord.x + u_Offset.x * ${k.toFixed(1)}, a_TexCoord.y + u_Offset.y * ${k.toFixed(1)});`);
  }
  return `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
${varyings.join('\n')}
uniform vec2 u_Offset;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  ${assigns.join('\n  ')}
}
`;
}

function buildLocalContrastGaussianFrag(kernel) {
  const weights = GAUSSIAN_WEIGHTS[kernel];
  const n = weights.length;
  const varyings = [];
  const terms = [];
  for (let i = 0; i < n; i++) {
    varyings.push(`varying vec2 v_TexCoord${i};`);
    terms.push(`texture2D(g_Texture0, v_TexCoord${i}) * ${weights[i]}`);
  }
  return `
precision mediump float;
${varyings.join('\n')}
uniform sampler2D g_Texture0;
void main() {
  gl_FragColor = ${terms.join(' +\n    ')};
}
`;
}

function buildLocalContrastCombineFragSource({ greyscale }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture2;
uniform float g_Amount;
void main() {
  vec4 blurred = texture2D(g_Texture0, v_TexCoord);
  vec4 albedo = texture2D(g_Texture2, v_TexCoord);
  vec3 delta = albedo.rgb - blurred.rgb;
  ${greyscale ? 'delta = vec3(dot(vec3(0.11, 0.59, 0.3), delta));' : ''}
  vec3 enhanced = albedo.rgb + delta * g_Amount;
  albedo.rgb = enhanced;
  gl_FragColor = albedo;
}
`;
}

function extractLocalContrastConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('localcontrast/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 4) continue;
    const gaussPass = passes[1];
    const combinePass = passes[3];
    const gCombos = (gaussPass && gaussPass.combos) || {};
    const cCombos = (combinePass && combinePass.combos) || {};
    if (cCombos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const kernel = gCombos.KERNEL != null ? gCombos.KERNEL : 0;
    const gCsv = (gaussPass && gaussPass.constantshadervalues) || {};
    const cCsv = (combinePass && combinePass.constantshadervalues) || {};
    return {
      kernel,
      scale: csvVec(gCsv.scale, [1, 1]),
      amount: cCsv.strength != null ? Number(cCsv.strength) : 1,
      greyscale: !!cCombos.GREYSCALE,
    };
  }
  return null;
}

// ---- Biblioteca comum de blur real (common_blur.h) ----
// Port direto das funções blur13a/blur7a/blur3a (variantes alfa-aware, com
// pesos de kernel gaussiano reais) usadas por vários efeitos da WE (shine,
// blur, blurprecise, blurradial). Escrito uma vez aqui e injetado (via
// template string) em qualquer frag que precise, em vez de duplicar os
// pesos em cada efeito.
const COMMON_BLUR_GLSL = `
vec4 blur13a(vec2 u, vec2 d) {
  vec2 o1 = vec2(1.4091998770852122) * d;
  vec2 o2 = vec2(3.2979348079914822) * d;
  vec2 o3 = vec2(5.2062900776825969) * d;
  return texture2D(g_Texture0, u) * 0.1976406528809576
    + texture2D(g_Texture0, u + o1) * 0.2959855056006557
    + texture2D(g_Texture0, u - o1) * 0.2959855056006557
    + texture2D(g_Texture0, u + o2) * 0.0935333619980593
    + texture2D(g_Texture0, u - o2) * 0.0935333619980593
    + texture2D(g_Texture0, u + o3) * 0.0116608059608062
    + texture2D(g_Texture0, u - o3) * 0.0116608059608062;
}
vec4 blur7a(vec2 u, vec2 d) {
  vec2 o1 = vec2(2.3515644035337887) * d;
  vec2 o2 = vec2(0.469433779698372) * d;
  vec2 o3 = vec2(1.4091998770852121) * d;
  vec2 o4 = vec2(3.0) * d;
  return texture2D(g_Texture0, u + o1) * 0.2028175528299753
    + texture2D(g_Texture0, u + o2) * 0.4044856614512112
    + texture2D(g_Texture0, u - o3) * 0.3213933537319605
    + texture2D(g_Texture0, u - o4) * 0.0713034319868530;
}
vec4 blur3a(vec2 u, vec2 d) {
  return texture2D(g_Texture0, u + d) * 0.25
    + texture2D(g_Texture0, u) * 0.5
    + texture2D(g_Texture0, u - d) * 0.25;
}
vec2 blurRotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}
vec4 blurRadial13a(vec2 u, vec2 center, float amt) {
  vec2 delta = u - center;
  amt = amt * 0.025;
  float o1 = 1.4091998770852122 * amt;
  float o2 = 3.2979348079914822 * amt;
  float o3 = 5.2062900776825969 * amt;
  vec2 r1 = blurRotateVec2(delta, o1) - delta;
  vec2 r2 = blurRotateVec2(delta, o2) - delta;
  vec2 r3 = blurRotateVec2(delta, o3) - delta;
  return texture2D(g_Texture0, u) * 0.1976406528809576
    + texture2D(g_Texture0, center + r1 + delta) * 0.2959855056006557
    + texture2D(g_Texture0, center - r1 + delta) * 0.2959855056006557
    + texture2D(g_Texture0, center + r2 + delta) * 0.0935333619980593
    + texture2D(g_Texture0, center - r2 + delta) * 0.0935333619980593
    + texture2D(g_Texture0, center + r3 + delta) * 0.0116608059608062
    + texture2D(g_Texture0, center - r3 + delta) * 0.0116608059608062;
}
vec4 blurRadial7a(vec2 u, vec2 center, float amt) {
  vec2 delta = u - center;
  amt = amt * 0.025;
  float o1 = 2.3515644035337887 * amt;
  float o2 = 0.469433779698372 * amt;
  float o3 = 1.4091998770852121 * amt;
  float o4 = 3.0 * amt;
  vec2 r1 = blurRotateVec2(delta, o1) - delta;
  vec2 r2 = blurRotateVec2(delta, o2) - delta;
  vec2 r3 = blurRotateVec2(delta, -o3) - delta;
  vec2 r4 = blurRotateVec2(delta, -o4) - delta;
  return texture2D(g_Texture0, center + r1 + delta) * 0.2028175528299753
    + texture2D(g_Texture0, center + r2 + delta) * 0.4044856614512112
    + texture2D(g_Texture0, center + r3 + delta) * 0.3213933537319605
    + texture2D(g_Texture0, center + r4 + delta) * 0.0713034319868530;
}
vec4 blurRadial3a(vec2 u, vec2 center, float amt) {
  vec2 delta = u - center;
  amt = amt * 0.025;
  float o1 = amt;
  vec2 r1 = blurRotateVec2(delta, o1) - delta;
  return texture2D(g_Texture0, center + delta) * 0.5
    + texture2D(g_Texture0, center + r1 + delta) * 0.25
    + texture2D(g_Texture0, center - r1 + delta) * 0.25;
}
`;

// ---- Efeito real "shine" via WebGL (pipeline de 5 passes real) ----
// Porta os 5 shaders reais (shine_downsample2, shine_cast, shine_gaussian
// x2, shine_combine) — corte de brilho (downsample pra metade da resolução
// + threshold de luminância, com ruído de "cintilação" opcional via
// util/clouds_256), depois "estica" esse corte em raios direcionais
// (GatherDirection: soma amostras ao longo de uma direção com peso
// crescente, formando um rastro tipo estrela de brilho), borra com
// blur13a/7a/3a reais (COMMON_BLUR_GLSL) e finalmente soma (Add, default
// real BLENDMODE=9) de volta na imagem original. Só suporta EDGES==4 (cruz
// de 4 raios, o default real e mais comum — os outros valores mudam a
// contagem/ângulo de raios e exigiriam variantes extras do vertex/fragment
// não confirmadas). COPYBG (capturar o framebuffer da cena toda) não
// suportado — mesma limitação arquitetural já documentada pra bloom.
const SHINE_CAST_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord01;
varying vec2 v_TexCoord23;
uniform vec4 g_Texture0Resolution;
uniform float g_Time;
uniform float g_Direction;
uniform float g_Speed;
vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord01.xy = a_TexCoord;
  vec2 baseDirection = rotateVec2(vec2(0.0, 0.5), g_Time * g_Speed);
  float ratio = g_Texture0Resolution.x / g_Texture0Resolution.y;
  v_TexCoord01.zw = rotateVec2(baseDirection, g_Direction);
  v_TexCoord23 = rotateVec2(vec2(-baseDirection.y, baseDirection.x), g_Direction);
  v_TexCoord01.w *= ratio;
  v_TexCoord23.y *= ratio;
}
`;

function buildShineDownsampleVert({ noise }) {
  return `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
${noise ? 'varying vec4 v_NoiseTexCoord;' : ''}
uniform float g_Time;
uniform float g_NoiseSpeed;
uniform float g_NoiseScale;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  ${noise ? `
  v_NoiseTexCoord.xy = a_TexCoord + g_Time * g_NoiseSpeed;
  v_NoiseTexCoord.wz = vec2(a_TexCoord.y, -a_TexCoord.x) * 0.633 + vec2(-g_Time, g_Time) * 0.5 * g_NoiseSpeed;
  v_NoiseTexCoord *= g_NoiseScale;
  ` : ''}
}
`;
}

function buildShineDownsampleFragSource({ noise }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
${noise ? 'varying vec4 v_NoiseTexCoord;' : ''}
uniform sampler2D g_Texture0;
${noise ? 'uniform sampler2D g_Texture2;\nuniform float g_NoiseAmount;' : ''}
uniform float g_Threshold;
void main() {
  vec4 s = texture2D(g_Texture0, v_TexCoord);
  s.rgb *= s.a;
  s.a = 1.0;
  float bright = step(g_Threshold, dot(vec3(0.11, 0.59, 0.3), s.rgb));
  gl_FragColor = s * bright;
  ${noise ? `
  float noiseSample = texture2D(g_Texture2, v_NoiseTexCoord.xy).r * texture2D(g_Texture2, v_NoiseTexCoord.zw).r;
  gl_FragColor.a = mix(gl_FragColor.a, gl_FragColor.a * noiseSample, g_NoiseAmount);
  ` : ''}
}
`;
}

function buildShineCastFragSource({ samples }) {
  const sampleCounts = { 0: 4, 1: 8, 2: 15, 3: 30 };
  const sampleCount = sampleCounts[samples] != null ? sampleCounts[samples] : 8;
  const sampleIntensity = 0.1 * (30 / sampleCount);
  return `
precision mediump float;
varying vec4 v_TexCoord01;
varying vec2 v_TexCoord23;
uniform sampler2D g_Texture0;
uniform float g_Length;
uniform float g_Intensity;
uniform vec3 g_ColorRays;

vec4 GatherDirection(vec2 texCoords, vec2 direction) {
  vec4 albedo = vec4(0.0);
  float dist = length(direction);
  direction /= dist;
  dist *= g_Length;
  texCoords += direction * dist;
  const float sampleDrop = ${(sampleCount - 1).toFixed(1)};
  direction = direction * dist / sampleDrop;
  for (int i = 0; i < ${sampleCount}; i++) {
    vec4 s = texture2D(g_Texture0, texCoords);
    texCoords -= direction;
    albedo += s * (float(i) / sampleDrop);
  }
  return albedo;
}

void main() {
  vec2 texCoords = v_TexCoord01.xy;
  vec4 albedo = vec4(0.0);
  albedo += GatherDirection(texCoords, v_TexCoord01.zw);
  albedo += GatherDirection(texCoords, -v_TexCoord01.zw);
  albedo += GatherDirection(texCoords, v_TexCoord23);
  albedo += GatherDirection(texCoords, -v_TexCoord23);
  albedo.rgb *= g_ColorRays;
  float sampleIntensity = ${sampleIntensity};
  gl_FragColor = vec4(g_Intensity * sampleIntensity * albedo.rgb, clamp(g_Intensity * sampleIntensity * albedo.a, 0.0, 1.0));
}
`;
}

function buildShineGaussianVert({ vertical }) {
  return `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform vec2 g_Scale;
uniform vec4 g_Texture0Resolution;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  ${vertical ? `
  v_TexCoord.z = 0.0;
  v_TexCoord.w = g_Scale.y / g_Texture0Resolution.w;
  ` : `
  v_TexCoord.z = g_Scale.x / g_Texture0Resolution.z;
  v_TexCoord.w = 0.0;
  `}
}
`;
}

function buildShineGaussianFragSource({ kernel }) {
  const fn = kernel === 1 ? 'blur7a' : kernel === 2 ? 'blur3a' : 'blur13a';
  return `
precision mediump float;
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
${COMMON_BLUR_GLSL}
void main() {
  gl_FragColor = ${fn}(v_TexCoord.xy, v_TexCoord.zw);
}
`;
}

function buildShineCombineFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;

vec3 BlendAdd(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }

void main() {
  vec4 rays = texture2D(g_Texture0, v_TexCoord);
  vec4 albedo = texture2D(g_Texture1, v_TexCoord);
  albedo.rgb = mix(albedo.rgb, BlendAdd(albedo.rgb, rays.rgb), rays.a);
  albedo.a = clamp(albedo.a + rays.a, 0.0, 1.0);
  gl_FragColor = albedo;
}
`;
}

function extractShineConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('shine/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 5) continue;
    const downPass = passes[0];
    const castPass = passes[1];
    const gaussPass = passes[2];
    const combinePass = passes[4];
    const dCombos = (downPass && downPass.combos) || {};
    const cCombos = (castPass && castPass.combos) || {};
    const gCombos = (gaussPass && gaussPass.combos) || {};
    const combCombos = (combinePass && combinePass.combos) || {};
    if (dCombos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const edges = cCombos.EDGES != null ? cCombos.EDGES : 4;
    if (edges !== 4) return { unsupported: `EDGES ${edges} (só o padrão real, 4 raios em cruz, suportado)` };
    if (combCombos.COPYBG) return { unsupported: 'COPYBG (captura de tela inteira não suportada nesse renderer)' };
    const blendMode = combCombos.BLENDMODE != null ? combCombos.BLENDMODE : 9;
    if (blendMode !== 9) return { unsupported: `BLENDMODE ${blendMode} (só Add/9 suportado)` };
    const dCsv = (downPass && downPass.constantshadervalues) || {};
    const cCsv = (castPass && castPass.constantshadervalues) || {};
    const gCsv = (gaussPass && gaussPass.constantshadervalues) || {};
    return {
      noise: dCombos.NOISE != null ? !!dCombos.NOISE : true,
      threshold: dCsv.raythreshold != null ? Number(dCsv.raythreshold) : 0.5,
      noiseSpeed: dCsv.noisespeed != null ? Number(dCsv.noisespeed) : 0.15,
      noiseScale: dCsv.noisescale != null ? Number(dCsv.noisescale) : 3,
      noiseAmount: dCsv.noiseamount != null ? Number(dCsv.noiseamount) : 0.4,
      samples: cCombos.SAMPLES != null ? cCombos.SAMPLES : 1,
      length: cCsv.raylength != null ? Number(cCsv.raylength) : 0.1,
      intensity: cCsv.rayintensity != null ? Number(cCsv.rayintensity) : 1,
      colorRays: csvVec(cCsv.color, [1, 1, 1]),
      direction: cCsv.direction != null ? Number(cCsv.direction) : 0,
      speed: cCsv.speed != null ? Number(cCsv.speed) : 0,
      kernel: gCombos.KERNEL != null ? gCombos.KERNEL : 0,
      scale: csvVec(gCsv.scale, [1, 1]),
    };
  }
  return null;
}

// ---- Efeito real "shimmer" via WebGL ----
// Porta shaders/effects/shimmer.frag/.vert reais — uma faixa de brilho que
// varre a imagem numa direção, colorida por uma textura de gradiente real
// (default: gradient/gradient_ferro_fluid, asset da própria WE). BLENDMODE
// default real é 32 (ApplyBlending(32,A,B,1.0) = A+A*B, já simplificado
// aqui já que o shader real sempre chama com opacidade fixa 1.0). MODE
// (linear/mirror) suportado por inteiro. MASK/OFFSET (textura de
// opacidade/atraso) não suportados.
function buildShimmerFragSource({ mode }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture3;
uniform float g_Time;
uniform float u_direction;
uniform float u_scale;
uniform float u_speed;
uniform float u_delay;
uniform float u_width;
uniform float u_amount;
uniform float u_offset;
uniform vec3 u_color;
#define MODE ${mode}

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec2 shimmerCoord = rotateVec2(v_TexCoord, -u_direction + 1.57079632679) * u_scale;
#if MODE == 1
  shimmerCoord.x += u_offset + u_width * sin(u_speed * g_Time);
#else
  shimmerCoord.x += u_offset + u_speed * g_Time;
#endif
  shimmerCoord.x = clamp(fract(shimmerCoord.x / (u_scale * u_delay)) * u_scale * u_delay, 0.0, 1.0);
  vec3 shimmerColor = texture2D(g_Texture3, fract(shimmerCoord)).rgb;
  vec3 effectAlbedo = shimmerColor * u_color;
  effectAlbedo = albedo.rgb + albedo.rgb * effectAlbedo;
  albedo.rgb = mix(albedo.rgb, effectAlbedo, shimmerColor * u_amount);
  gl_FragColor = albedo;
}
`;
}

function extractShimmerConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('shimmer/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    if (combos.OFFSET) return { unsupported: 'OFFSET (textura de atraso temporal não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 32;
    if (blendMode !== 32) return { unsupported: `BLENDMODE ${blendMode} (só o default/32 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      mode: combos.MODE != null ? combos.MODE : 0,
      direction: csvNum(csv.ui_editor_properties_direction, 1.57079632679),
      scale: csvNum(csv.granularity, 1),
      speed: csvNum(csv.speed, 1),
      delay: csvNum(csv.delay, 2),
      width: csvNum(csv.width, 1),
      amount: csvNum(csv.brightness, 1),
      offset: csvNum(csv.offset, 0),
      color: csvVec(csv.color, [1, 1, 1]),
      gradientTexId: (pass.textures && pass.textures[3]) || null,
    };
  }
  return null;
}

// ---- Efeito real "reflection" via WebGL ----
// Porta shaders/effects/reflection.frag/.vert reais — espelha a própria
// imagem abaixo de si (reflexo tipo "poça"/vidro), invertendo Y ao redor do
// centro com deslocamento e rotação configuráveis. Só suporta o modo
// PERSPECTIVE==0 (o default real, mais simples e comum — reflexo linear
// simétrico). BLENDMODE default real é 9 (Add). MASK não suportado.
function buildReflectionFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec2 v_ReflectedCoord;
uniform sampler2D g_Texture0;
uniform float g_ReflectionAlpha;

vec3 BlendAdd(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec4 reflected = texture2D(g_Texture0, v_ReflectedCoord);
  albedo.rgb = mix(albedo.rgb, BlendAdd(albedo.rgb, reflected.rgb), g_ReflectionAlpha);
  albedo.a = min(1.0, albedo.a + reflected.a * g_ReflectionAlpha);
  gl_FragColor = albedo;
}
`;
}
const REFLECTION_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec2 v_ReflectedCoord;
uniform float g_Direction;
uniform float g_ReflectionOffset;
vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  vec2 center = vec2(0.5, 0.5);
  vec2 delta = a_TexCoord - center;
  delta.y += g_ReflectionOffset;
  delta.y = -delta.y;
  delta = rotateVec2(delta, g_Direction);
  v_ReflectedCoord = center + delta;
}
`;

function extractReflectionConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('reflection/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    if (combos.PERSPECTIVE) return { unsupported: 'PERSPECTIVE (reflexo com perspectiva 4-pontos não suportado)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 9;
    if (blendMode !== 9) return { unsupported: `BLENDMODE ${blendMode} (só Add/9 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      alpha: csvNum(csv.alpha, 1),
      direction: csvNum(csv.direction, 0),
      offset: csvNum(csv.offset, 0),
    };
  }
  return null;
}

// ---- Efeito real "refraction" via WebGL ----
// Porta shaders/effects/refract.frag/.vert reais — distorce a UV da própria
// imagem usando um normal map REAL (sem default: se a cena não define um
// normal map de verdade, não há o que distorcer, então pulamos, mesmo
// padrão de "skip sem asset real" do blend/foliagesway). O desempacotamento
// do normal map (DecompressNormal, common_fragment.h) tem ramificações por
// formato de textura comprimida (ETC1/DXT1/BC7/RG88); como nosso
// decodificador sempre produz RGBA8888 puro, usamos a ramificação "else"
// (formato não-comprimido, não-RG88) do arquivo real, que lê os canais
// W,Y (alpha,verde) em vez de R,G — convenção "DXT5nm" comum em normal maps
// da própria WE. NÃO CONFIRMADO visualmente (mesma classe de risco já
// documentada pro lightshafts/foliagesway): só dá pra confirmar vendo o
// resultado renderizado de verdade contra uma cena real com esse efeito.
function buildRefractionFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec3 v_RefractTexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
void main() {
  vec4 normalSample = texture2D(g_Texture1, v_RefractTexCoord.xy);
  vec2 normal = normalSample.wy * 2.0 - 1.0;
  vec2 texCoord = v_TexCoord + normal * v_RefractTexCoord.z;
  gl_FragColor = texture2D(g_Texture0, texCoord);
}
`;
}
const REFRACTION_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec3 v_RefractTexCoord;
uniform vec2 g_Scale;
uniform float g_Strength;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  v_RefractTexCoord.xy = a_TexCoord * g_Scale;
  v_RefractTexCoord.z = sign(g_Strength) * g_Strength * g_Strength;
}
`;

function extractRefractionConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('refraction/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const texId = pass.textures && pass.textures[1];
    if (!texId) return null; // sem normal map real definido na cena, nada a distorcer
    const csv = pass.constantshadervalues || {};
    return {
      texId,
      scale: csvVec(csv.scale, [1, 1]),
      strength: csvNum(csv.strength, 0.1),
    };
  }
  return null;
}

// ---- Efeito real "nitro" via WebGL ----
// Porta shaders/effects/nitro.frag/.vert reais — padrão de "energia"/plasma
// fluindo (2 amostras de ruído se movendo em direções diferentes, cruzadas
// pra formar veios de cor), usando a textura padrão real (util/clouds_256).
// BLENDMODE default real é 22 (Glow: BlendReflect com os argumentos
// trocados). texSample2DLod (mip bias) não tem equivalente direto em
// WebGL1 sem extensão — aproximamos com texture2D normal (diferença visual
// mínima pra esse tipo de ruído suave). MASK não suportado.
function buildNitroFragSource({ writeAlpha }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordNitro;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_NitroAlpha;
uniform vec3 g_NitroColor0;
uniform vec3 g_NitroColor1;
uniform vec2 g_NitroRanges;

float BlendReflectf(float base, float blend) { return (blend >= 1.0) ? blend : min(base * base / max(0.0001, 1.0 - blend), 1.0); }
vec3 BlendReflect(vec3 base, vec3 blend) { return vec3(BlendReflectf(base.r, blend.r), BlendReflectf(base.g, blend.g), BlendReflectf(base.b, blend.b)); }
vec3 BlendGlow(vec3 base, vec3 blend) { return BlendReflect(blend, base); }

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  float nitro0 = texture2D(g_Texture1, v_TexCoordNitro.xy).r;
  float nitro1 = texture2D(g_Texture1, v_TexCoordNitro.zw).r;
  float remap = texture2D(g_Texture1, v_TexCoord).r;

  float coreNoise = smoothstep(nitro0, nitro1, 0.1 + remap * 0.8);
  float nitro = smoothstep(g_NitroRanges.y, g_NitroRanges.x, nitro0 * nitro1) * smoothstep(g_NitroRanges.x, g_NitroRanges.y, nitro0 * nitro1);
  nitro = coreNoise * nitro * 4.0;

  vec3 nitroColor = mix(g_NitroColor0, g_NitroColor1, nitro);
  float blend = nitro * g_NitroAlpha;

  albedo.rgb = mix(albedo.rgb, BlendGlow(albedo.rgb, nitroColor), blend);
  ${writeAlpha ? 'albedo.a = blend;' : ''}
  gl_FragColor = vec4(max(vec3(0.0), albedo.rgb), albedo.a);
}
`;
}
const NITRO_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordNitro;
uniform vec4 g_Texture0Resolution;
uniform float g_Time;
uniform vec4 g_NitroSpeeds;
uniform vec2 g_NitroScales;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  float aspect = g_Texture0Resolution.z / g_Texture0Resolution.w;
  v_TexCoordNitro.xy = a_TexCoord * g_NitroScales.x + g_Time * g_NitroSpeeds.xy;
  v_TexCoordNitro.zw = a_TexCoord * g_NitroScales.y + g_Time * g_NitroSpeeds.zw;
  v_TexCoordNitro.xz *= aspect;
  v_TexCoordNitro.zw = vec2(-v_TexCoordNitro.w, v_TexCoordNitro.z);
}
`;

function extractNitroConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('nitro/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 22;
    if (blendMode !== 22) return { unsupported: `BLENDMODE ${blendMode} (só Glow/22 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      writeAlpha: !!combos.WRITEALPHA,
      multiply: csvNum(csv.multiply, 1),
      colorStart: csvVec(csv.colorstart, [0, 0.5, 1]),
      colorEnd: csvVec(csv.colorend, [1, 1, 1]),
      bounds: csvVec(csv.bounds, [0.3, 0.25]),
      speeds: csvVec(csv.speed, [-0.1, 0.7, 0.1, -0.5]),
      scales: csvVec(csv.scale, [1, 2]),
    };
  }
  return null;
}

// ---- Efeito real "iris" via WebGL ----
// Porta shaders/effects/iris.frag/.vert reais — um jitter procedural sutil
// (tipo "globo ocular vivo"): sem MASK real (não suportado, mesmo padrão do
// resto do projeto), o efeito vira um pequeno deslocamento de UV que "anda"
// sozinho ao longo do tempo, usando os mesmos keyframes senoidais reais do
// shader original. Confirmado via .vert que é puramente g_Time (procedural)
// — NÃO é dirigido pelo cursor do mouse, então não precisa entrar no grupo
// adiado junto com depthparallax/cursorripple/xray.
function buildIrisFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec2 v_TexCoordIris;
uniform sampler2D g_Texture0;
void main() {
  gl_FragColor = texture2D(g_Texture0, v_TexCoord + v_TexCoordIris);
}
`;
}
const IRIS_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec2 v_TexCoordIris;
uniform float g_Time;
uniform vec2 g_Scale;
uniform float g_Speed;
uniform float g_Rough;
uniform float g_NoiseAmount;
uniform float g_PhaseOffset;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  float time = (g_Time * g_Speed) + g_PhaseOffset;
  float lowDt = floor(time);
  vec2 motion2 = sin(1.9 * (lowDt + vec2(0.0, 1.0)));
  vec4 motion4 = sin(2.5 * (lowDt + vec4(0.0, 0.0, 1.0, 1.0)) + vec4(1.0, 2.0, 1.0, 2.0));
  vec2 moveStart = motion2.xx + motion4.xy;
  vec2 moveEnd = motion2.yy + motion4.zw;
  vec2 da = mix(moveStart, moveEnd, smoothstep(1.0 - g_Rough, 1.0, cos(fract(time) * 3.14159265359) * -0.5 + 0.5));
  da.x += sin(time) * g_NoiseAmount;
  da.y += cos(time) * g_NoiseAmount;
  da *= g_Scale * 0.001;
  v_TexCoordIris = da;
}
`;

function extractIrisConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('iris/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade e fundo colorido não suportados)' };
    const csv = pass.constantshadervalues || {};
    return {
      scale: csvVec(csv.scale, [1, 1]),
      speed: csvNum(csv.speed, 1),
      rough: csvNum(csv.rough, 0.2),
      noiseAmount: csvNum(csv.noiseamount, 0.5),
      phaseOffset: csvNum(csv.phase, 0),
    };
  }
  return null;
}

// ---- Efeito real "glitter" via WebGL (2 passes) ----
// Porta shaders/effects/glitter_prepare.frag + glitter_combine.frag reais —
// gera um padrão de brilho piscante (baseado em ruído perlin real,
// util/perlin_256) num render target fixo de 256x256 com wrap REPEAT (POT,
// então REPEAT funciona nativo em WebGL1, sem fallback), depois tila esse
// padrão sobre a imagem via um blend mode (default real BLENDMODE=32,
// mesma fórmula A+A*B do shimmer). MASK não suportado.
const GLITTER_PREPARE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_NoiseCoord;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_NoiseCoord = a_TexCoord * 5.0;
}
`;
function buildGlitterPrepareFragSource() {
  return `
precision mediump float;
varying vec2 v_NoiseCoord;
uniform sampler2D g_Texture1;
uniform float g_Time;
uniform float g_Speed;
uniform float g_Density;
void main() {
  float density = g_Density * g_Density;
  float time = g_Time * g_Speed * density;
  vec4 noise0 = texture2D(g_Texture1, v_NoiseCoord);
  noise0.r = noise0.r * (1.0 - noise0.g);
  float timer0 = fract(noise0.r * 100.0 + time);
  float glitterDensity = density * 0.5;
  float glitter0 = smoothstep(0.5 - glitterDensity, 0.5, timer0) * smoothstep(0.5 + glitterDensity, 0.5, timer0);
  glitter0 = smoothstep(0.5, 1.0, glitter0);
  glitter0 *= glitter0;
  gl_FragColor = vec4(vec3(glitter0), 1.0);
}
`;
}
function buildGlitterCombineFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform vec2 g_AspectScale;
uniform float g_GlitterScale;
uniform float g_GlitterOpacity;
uniform vec3 g_GlitterColor;
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec2 glitterCoords = v_TexCoord * g_AspectScale * g_GlitterScale;
  float glitter = texture2D(g_Texture1, glitterCoords).r;
  vec3 glitterColor = g_GlitterColor * glitter;
  albedo.rgb = mix(albedo.rgb, albedo.rgb + albedo.rgb * glitterColor, g_GlitterOpacity);
  gl_FragColor = albedo;
}
`;
}

function extractGlitterConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('glitter/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 2) continue;
    const preparePass = passes[0];
    const combinePass = passes[1];
    const cCombos = (combinePass && combinePass.combos) || {};
    if (cCombos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const blendMode = cCombos.BLENDMODE != null ? cCombos.BLENDMODE : 32;
    if (blendMode !== 32) return { unsupported: `BLENDMODE ${blendMode} (só o default/32 suportado)` };
    const pCsv = (preparePass && preparePass.constantshadervalues) || {};
    const cCsv = (combinePass && combinePass.constantshadervalues) || {};
    return {
      speed: pCsv.speed != null ? Number(pCsv.speed) : 1,
      density: pCsv.density != null ? Number(pCsv.density) : 0.5,
      scale: cCsv.scale != null ? Number(cCsv.scale) : 1,
      opacity: cCsv.alpha != null ? Number(cCsv.alpha) : 1,
      color: csvVec(cCsv.color, [1, 1, 1]),
    };
  }
  return null;
}

// ---- Efeito real "blur" (gaussiano com downsample) via WebGL ----
// Porta os 4 shaders reais (blur_downsample4, blur_gaussian x2,
// blur_combine) — mesma estrutura downsample4->gaussian_x->gaussian_y já
// portada pro localcontrast (os shaders são byte-a-byte idênticos),
// reaproveitando LOCALCONTRAST_DOWNSAMPLE_VERT/FRAG e
// buildLocalContrastGaussianVert/Frag em vez de duplicar. Só o combine
// final muda: aqui é um composite simples (COMPOSITE==0, o default real:
// só devolve o resultado borrado, com cor/mono/alfa opcionais) em vez do
// unsharp mask do localcontrast. MASK e COMPOSITE!=0 não suportados.
function buildBlurCombineFragSource({ mono, blurAlpha }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture2;
uniform vec3 g_CompositeColor;
void main() {
  vec4 blurred = texture2D(g_Texture0, v_TexCoord);
  vec4 albedoOld = texture2D(g_Texture2, v_TexCoord);
  float div = mix(blurred.a, 1.0, step(blurred.a, 0.0));
  vec3 rgb = blurred.rgb / div;
  ${mono ? 'rgb = vec3(dot(vec3(0.299, 0.587, 0.114), rgb));' : ''}
  rgb *= g_CompositeColor;
  gl_FragColor = vec4(rgb, ${blurAlpha ? 'blurred.a' : 'albedoOld.a'});
}
`;
}

function extractBlurConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('blur/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 4) continue;
    const gaussPass = passes[1];
    const combinePass = passes[3];
    const gCombos = (gaussPass && gaussPass.combos) || {};
    const cCombos = (combinePass && combinePass.combos) || {};
    if (cCombos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const composite = cCombos.COMPOSITE != null ? cCombos.COMPOSITE : 0;
    if (composite !== 0) return { unsupported: `COMPOSITE ${composite} (só o default/Normal suportado)` };
    const kernel = gCombos.KERNEL != null ? gCombos.KERNEL : 0;
    const gCsv = (gaussPass && gaussPass.constantshadervalues) || {};
    const cCsv = (combinePass && combinePass.constantshadervalues) || {};
    return {
      kernel,
      scale: csvVec(gCsv.scale, [1, 1]),
      blurAlpha: cCombos.BLURALPHA != null ? !!cCombos.BLURALPHA : true,
      mono: !!cCombos.COMPOSITEMONO,
      compositeColor: csvVec(cCsv.compositecolor, [1, 1, 1]),
    };
  }
  return null;
}

// ---- Efeito real "blurprecise" via WebGL ----
// Porta shaders/effects/blur_precise_gaussian.frag/.vert reais — gaussiano
// separável (blur13a/7a/3a de COMMON_BLUR_GLSL) em resolução CHEIA (sem
// downsample, daí "precise" — mais caro, mais fiel que o "blur" normal).
// MASK não suportado.
function buildBlurPreciseFragSource({ kernel, blurAlpha }) {
  const fn = kernel === 1 ? 'blur7a' : kernel === 2 ? 'blur3a' : 'blur13a';
  return `
precision mediump float;
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
${blurAlpha ? '' : 'uniform sampler2D g_Texture1;'}
${COMMON_BLUR_GLSL}
void main() {
  vec4 albedo = ${fn}(v_TexCoord.xy, v_TexCoord.zw);
  ${blurAlpha ? '' : `
  vec4 prev = texture2D(g_Texture1, v_TexCoord.xy);
  albedo.a = prev.a;
  `}
  gl_FragColor = albedo;
}
`;
}
function buildBlurPreciseVert({ vertical }) {
  return `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform vec2 g_Scale;
uniform vec4 g_Texture0Resolution;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord.xy = a_TexCoord;
  ${vertical ? `
  v_TexCoord.z = 0.0;
  v_TexCoord.w = g_Scale.y / g_Texture0Resolution.w;
  ` : `
  v_TexCoord.z = g_Scale.x / g_Texture0Resolution.z;
  v_TexCoord.w = 0.0;
  `}
}
`;
}

function extractBlurPreciseConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('blurprecise/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 2) continue;
    const xPass = passes[0];
    const yPass = passes[1];
    const xCombos = (xPass && xPass.combos) || {};
    const yCombos = (yPass && yPass.combos) || {};
    if (xCombos.MASK || yCombos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const kernel = xCombos.KERNEL != null ? xCombos.KERNEL : 0;
    const xCsv = (xPass && xPass.constantshadervalues) || {};
    return {
      kernel,
      scale: csvVec(xCsv.scale, [1, 1]),
      blurAlpha: yCombos.BLURALPHA != null ? !!yCombos.BLURALPHA : true,
    };
  }
  return null;
}

// ---- Efeito real "blurradial" via WebGL ----
// Porta shaders/effects/blur_radial_gaussian.frag/.vert reais — blur radial
// ao redor de um centro (blurRadial13a/7a/3a de COMMON_BLUR_GLSL), 1 passe
// só, resolução cheia. MASK não suportado.
function buildBlurRadialFragSource({ kernel, blurAlpha }) {
  const fn = kernel === 1 ? 'blurRadial7a' : kernel === 2 ? 'blurRadial3a' : 'blurRadial13a';
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float u_Scale;
uniform vec2 u_Center;
${COMMON_BLUR_GLSL}
void main() {
  vec4 albedo = ${fn}(v_TexCoord, u_Center, u_Scale);
  ${blurAlpha ? '' : `
  vec4 prev = texture2D(g_Texture0, v_TexCoord);
  albedo.a = prev.a;
  `}
  gl_FragColor = albedo;
}
`;
}

function extractBlurRadialConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('blurradial/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      kernel: combos.KERNEL != null ? combos.KERNEL : 0,
      blurAlpha: combos.BLURALPHA != null ? !!combos.BLURALPHA : true,
      scale: csvNum(csv.scale, 1),
      center: csvVec(csv.center, [0.5, 0.5]),
    };
  }
  return null;
}

// ---- Efeito real "godrays" via WebGL (pipeline de 5 passes real) ----
// Efeito DISTINTO do "lightshafts" já portado (nomes parecidos, shaders e
// pastas reais diferentes — confirmado via listagem real de
// assets/effects/). Mesma estrutura de 5 passes do "shine" (downsample2 +
// cast + gaussian x/y + combine, shaders quase idênticos — reaproveita
// buildShineDownsampleVert/buildShineGaussianVert/Frag/buildShineCombineFragSource
// diretamente), mas o "cast" aqui é 1 raio só convergindo/divergindo de um
// centro (CASTER==0, Radial, o default real) ou numa direção fixa
// (CASTER==1, Directional) — bem diferente da cruz de 4 raios do shine.
// COPYBG não suportado (mesma limitação do shine/bloom).
const GODRAYS_CAST_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
}
`;

function buildGodraysDownsampleFragSource({ noise }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
${noise ? 'varying vec4 v_NoiseTexCoord;' : ''}
uniform sampler2D g_Texture0;
${noise ? 'uniform sampler2D g_Texture2;\nuniform float g_NoiseAmount;\nuniform float g_NoiseSmoothness;' : ''}
uniform float g_Threshold;
void main() {
  vec4 s = texture2D(g_Texture0, v_TexCoord);
  s.rgb *= s.a;
  s.a = 1.0;
  float bright = step(g_Threshold, dot(vec3(0.11, 0.59, 0.3), s.rgb));
  gl_FragColor = s * bright;
  ${noise ? `
  float noiseSample = texture2D(g_Texture2, v_NoiseTexCoord.xy).r * texture2D(g_Texture2, v_NoiseTexCoord.zw).r;
  gl_FragColor.a *= smoothstep(0.5 - g_NoiseSmoothness, 0.5 + g_NoiseSmoothness, noiseSample);
  ` : ''}
}
`;
}

function buildGodraysCastFragSource({ caster, samples }) {
  const sampleCounts = { 0: 30, 1: 50 };
  const sampleCount = sampleCounts[samples] != null ? sampleCounts[samples] : 30;
  const sampleIntensity = samples === 1 ? 0.1 * (30 / 50) : 0.1;
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float g_Length;
uniform float g_Intensity;
uniform vec3 g_ColorRays;
${caster === 0 ? 'uniform vec2 g_Center;' : 'uniform float g_Direction;'}

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main() {
  vec2 texCoords = v_TexCoord;
  vec4 albedo = vec4(0.0);
${caster === 0 ? `
  vec2 direction = g_Center - texCoords;
` : `
  vec2 direction = rotateVec2(vec2(0.0, -0.5), g_Direction - 3.14159265359);
`}
  float dist = length(direction);
  direction /= dist;
  dist *= g_Length;
  texCoords += direction * dist;
  const float sampleDrop = ${(sampleCount - 1).toFixed(1)};
  direction = direction * dist / sampleDrop;
  for (int i = 0; i < ${sampleCount}; i++) {
    vec4 s = texture2D(g_Texture0, texCoords);
    texCoords -= direction;
    albedo += s * (float(i) / sampleDrop);
  }
  albedo.rgb *= g_ColorRays;
  float sampleIntensity = ${sampleIntensity};
  gl_FragColor = vec4(g_Intensity * sampleIntensity * albedo.rgb, clamp(g_Intensity * sampleIntensity * albedo.a, 0.0, 1.0));
}
`;
}

function extractGodraysConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('godrays/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 5) continue;
    const downPass = passes[0];
    const castPass = passes[1];
    const gaussPass = passes[2];
    const combinePass = passes[4];
    const dCombos = (downPass && downPass.combos) || {};
    const cCombos = (castPass && castPass.combos) || {};
    const gCombos = (gaussPass && gaussPass.combos) || {};
    const combCombos = (combinePass && combinePass.combos) || {};
    if (dCombos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    if (combCombos.COPYBG) return { unsupported: 'COPYBG (captura de tela inteira não suportada nesse renderer)' };
    const blendMode = combCombos.BLENDMODE != null ? combCombos.BLENDMODE : 9;
    if (blendMode !== 9) return { unsupported: `BLENDMODE ${blendMode} (só Add/9 suportado)` };
    const dCsv = (downPass && downPass.constantshadervalues) || {};
    const cCsv = (castPass && castPass.constantshadervalues) || {};
    const gCsv = (gaussPass && gaussPass.constantshadervalues) || {};
    return {
      noise: dCombos.NOISE != null ? !!dCombos.NOISE : true,
      threshold: dCsv.raythreshold != null ? Number(dCsv.raythreshold) : 0.5,
      noiseSpeed: dCsv.noisespeed != null ? Number(dCsv.noisespeed) : 0.15,
      noiseScale: dCsv.noisescale != null ? Number(dCsv.noisescale) : 3,
      noiseAmount: dCsv.noiseamount != null ? Number(dCsv.noiseamount) : 0.4,
      noiseSmoothness: dCsv.noisesmoothness != null ? Number(dCsv.noisesmoothness) : 0.2,
      caster: cCombos.CASTER != null ? cCombos.CASTER : 0,
      samples: cCombos.SAMPLES != null ? cCombos.SAMPLES : 0,
      length: cCsv.raylength != null ? Number(cCsv.raylength) : 0.5,
      intensity: cCsv.rayintensity != null ? Number(cCsv.rayintensity) : 1,
      colorRays: csvVec(cCsv.color, [1, 1, 1]),
      center: csvVec(cCsv.center, [0.5, 0.5]),
      direction: cCsv.direction != null ? Number(cCsv.direction) : 3.14159265358,
      kernel: gCombos.KERNEL != null ? gCombos.KERNEL : 1,
      scale: csvVec(gCsv.blurscale, [1, 1]),
    };
  }
  return null;
}

// ---- Efeito real "watercaustics" via WebGL ----
// Porta shaders/effects/caustics.frag/.vert reais — o clássico padrão de
// luz reverberando na superfície da água, gerado 100% por texturas padrão
// da própria WE (pattern/voronoi_local, pattern/voronoi, util/uniform_256,
// util/perlin_256 — nenhuma depende de asset específico da cena, todas
// confirmadas decodificáveis). BLENDMODE default real é 32 (mesma fórmula
// A+A*B do shimmer/glitter). Só suporta PERSPECTIVE==0 (o default real).
// MASK não suportado.
function buildCausticsFragSource({ mode }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture2;
uniform sampler2D g_Texture5;
uniform sampler2D g_Texture3;
uniform sampler2D g_Texture4;
uniform float g_Time;
uniform vec4 g_Texture0Resolution;
uniform float u_brightness;
uniform float u_glow;
uniform float u_scale;
uniform float u_speed;
uniform float u_timeoffset;
uniform float u_distortion;
uniform float u_chromatic;
uniform float u_blur;
uniform vec3 u_color1;
uniform vec3 u_color2;
#define MODE ${mode}

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  float ratio = g_Texture0Resolution.z / g_Texture0Resolution.w;
  vec2 causticsCoords = v_TexCoord;
  causticsCoords.x *= ratio;
  causticsCoords *= u_scale;

  vec2 noiseCoords = causticsCoords * 0.02;
  vec2 noiseCoords2 = causticsCoords * 0.0333;
  vec2 blendCoords = causticsCoords * 0.01333;
  vec2 shiftCoords = causticsCoords * 0.05;

  float time = g_Time * u_speed + u_timeoffset;
  noiseCoords.x += time * 0.005;
  noiseCoords2.y += time * 0.004111;
  blendCoords += time * 0.003777;
  shiftCoords += time * 0.01;

  vec4 shiftColor = texture2D(g_Texture4, shiftCoords) * 2.0 - 1.0;
  vec4 noiseColor = texture2D(g_Texture3, noiseCoords) * 2.0 - 1.0;
  vec4 noiseColor2 = texture2D(g_Texture3, noiseCoords2) * 2.0 - 1.0;

  causticsCoords += noiseColor.xy * 0.025 * u_distortion;
  causticsCoords += noiseColor2.xy * 0.025 * u_distortion;
  causticsCoords += shiftColor.rg * u_distortion;

  vec2 causticsCoordsLeft = causticsCoords - vec2(0.01 * u_chromatic, 0.0);
  vec2 causticsCoordsRight = causticsCoords + vec2(0.01 * u_chromatic, 0.0);

  vec3 caustics = vec3(texture2D(g_Texture2, causticsCoordsLeft).r,
                        texture2D(g_Texture2, causticsCoords).r,
                        texture2D(g_Texture2, causticsCoordsRight).r);

  float glowSample = texture2D(g_Texture5, causticsCoords).r;
  vec4 blendColor = texture2D(g_Texture3, blendCoords);

  caustics = mix(caustics, vec3(glowSample), u_blur);

  float causticsSample;
  vec3 causticsColor;
#if MODE == 1
  float blendThreshold = max(0.3, blendColor.x - shiftColor.x);
  float particleNoise = texture2D(g_Texture3, shiftCoords).r;
  float particleSample = smoothstep(blendThreshold, blendThreshold - 0.001, caustics.y) * step(0.3, particleNoise * caustics.y);
  causticsSample = smoothstep(blendThreshold, blendThreshold + 0.001, caustics.y) + particleSample;
  causticsSample = clamp(causticsSample + glowSample * u_glow, 0.0, 1.0);
  causticsColor = u_brightness * mix(u_color1, u_color2, smoothstep(0.0, 0.5, blendColor.x));
#else
  causticsSample = dot(caustics, vec3(0.33333));
  causticsSample = smoothstep(blendColor.x * 0.8, 1.0 - blendColor.y * 0.2, causticsSample + glowSample * u_glow);
  causticsColor = u_brightness * mix(u_color1, u_color2, blendColor.x);
  causticsColor *= caustics;
#endif

  albedo.rgb = mix(albedo.rgb, albedo.rgb + albedo.rgb * causticsColor, causticsSample);
  gl_FragColor = albedo;
}
`;
}

function extractCausticsConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('watercaustics/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    if (combos.PERSPECTIVE) return { unsupported: 'PERSPECTIVE (distorção 4-pontos não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 32;
    if (blendMode !== 32) return { unsupported: `BLENDMODE ${blendMode} (só o default/32 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      mode: combos.MODE != null ? combos.MODE : 0,
      brightness: csvNum(csv.ui_editor_properties_brightness, 1),
      glow: csvNum(csv.ui_editor_properties_glow, 0.5),
      scale: csvNum(csv.ui_editor_properties_granularity, 2),
      speed: csvNum(csv.ui_editor_properties_speed, 1),
      timeoffset: csvNum(csv.ui_editor_properties_time_offset, 0),
      distortion: csvNum(csv.ui_editor_properties_distortion, 1),
      chromatic: csvNum(csv.ui_editor_properties_chromatic_aberration, 1),
      blur: csvNum(csv.ui_editor_properties_blur, 0),
      color1: csvVec(csv.ui_editor_properties_color_start, [0.7, 0.9, 1]),
      color2: csvVec(csv.ui_editor_properties_color_end, [0.4, 0.6, 1]),
    };
  }
  return null;
}

// ---- Efeito real "waterflow" via WebGL ----
// Porta shaders/effects/waterflow.frag/.vert reais — distorce a UV usando
// um mapa de fluxo (flow map, default real util/noflow — asset da própria
// WE, já usado pelo "shake") cruzado com uma textura de "offset temporal"
// REAL da cena (sem essa, a fase do ciclo de fluxo não tem como ser
// calculada corretamente — sem default documentado no shader original,
// então pulamos se a cena não define uma, mesmo padrão de "skip sem asset
// real" do blend/refraction).
function buildWaterFlowFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec4 v_Cycles;
varying vec2 v_Blend;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform sampler2D g_Texture2;
uniform float g_FlowAmp;
uniform float g_FlowPhaseScale;
void main() {
  float flowPhase = texture2D(g_Texture2, v_TexCoord * g_FlowPhaseScale).r;
  vec2 flowColors = texture2D(g_Texture1, v_TexCoord).rg;
  vec2 flowMask = (flowColors - vec2(0.498, 0.498)) * 2.0;
  float flowAmount = length(flowMask);

  vec4 flowUVOffset = vec4(flowMask.xyxy * g_FlowAmp * 0.1) * v_Cycles.xxyy;
  vec4 flowUVOffset2 = vec4(flowMask.xyxy * g_FlowAmp * 0.1) * v_Cycles.zzww;

  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec4 flowAlbedo = mix(texture2D(g_Texture0, v_TexCoord + flowUVOffset.xy),
                          texture2D(g_Texture0, v_TexCoord + flowUVOffset.zw),
                          v_Blend.x);
  vec4 flowAlbedo2 = mix(texture2D(g_Texture0, v_TexCoord + flowUVOffset2.xy),
                          texture2D(g_Texture0, v_TexCoord + flowUVOffset2.zw),
                          v_Blend.y);

  flowAlbedo = mix(flowAlbedo, flowAlbedo2, smoothstep(0.2, 0.8, flowPhase));
  gl_FragColor = mix(albedo, flowAlbedo, flowAmount);
}
`;
}
const WATERFLOW_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec4 v_Cycles;
varying vec2 v_Blend;
uniform float g_Time;
uniform float g_FlowSpeed;
uniform float g_PhaseFeather;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  vec4 cycles = vec4(fract(g_Time * g_FlowSpeed),
                      fract(g_Time * g_FlowSpeed + 0.5),
                      fract(0.25 + g_Time * g_FlowSpeed),
                      fract(0.25 + g_Time * g_FlowSpeed + 0.5));
  float blend = 2.0 * abs(cycles.x - 0.5);
  float blend2 = 2.0 * abs(cycles.z - 0.5);
  vec2 smoothParams = vec2(0.5 - g_PhaseFeather, 0.5 + g_PhaseFeather);
  blend = smoothstep(smoothParams.x, smoothParams.y, blend);
  blend2 = smoothstep(smoothParams.x, smoothParams.y, blend2);
  v_Cycles = cycles - vec4(0.5);
  v_Blend = vec2(blend, blend2);
}
`;

function extractWaterFlowConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('waterflow/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const timeOffsetTexId = pass.textures && pass.textures[2];
    if (!timeOffsetTexId) return null; // sem textura real de offset temporal, sem como calcular a fase do fluxo
    const csv = pass.constantshadervalues || {};
    return {
      flowTexId: (pass.textures && pass.textures[1]) || null,
      timeOffsetTexId,
      strength: csvNum(csv.strength, 1),
      phaseScale: csvNum(csv.phasescale, 2),
      speed: csvNum(csv.speed, 1),
      feather: csvNum(csv.feather, 0.4),
    };
  }
  return null;
}

// ---- Efeito real "waterripple" via WebGL ----
// Porta shaders/effects/waterripple.frag/.vert reais — distorce a UV usando
// um normal map de água REAL da cena (sem default documentado no shader —
// pulamos se ausente, mesmo padrão do refraction/waterflow). Só suporta
// PERSPECTIVE==0 (default real). SPECULAR suportado por inteiro (não
// depende de textura extra).
function buildWaterRippleFragSource({ specular }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordRipple;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture2;
uniform float g_Strength;
${specular ? `
uniform float g_SpecularPower;
uniform float g_SpecularStrength;
uniform vec3 g_SpecularColor;
` : ''}
void main() {
  vec2 texCoord = v_TexCoord;
  vec3 n1 = texture2D(g_Texture2, v_TexCoordRipple.xy).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(g_Texture2, v_TexCoordRipple.zw).xyz * 2.0 - 1.0;
  vec3 normal = normalize(vec3(n1.xy + n2.xy, n1.z));
  texCoord += normal.xy * g_Strength * g_Strength;
  gl_FragColor = texture2D(g_Texture0, texCoord);
${specular ? `
  vec2 direction = normalize(vec2(0.5, 0.0) - v_TexCoord);
  float spec = max(0.0, dot(normal.xy, direction)) * max(0.0, dot(direction, vec2(0.0, -1.0)));
  spec = pow(spec, g_SpecularPower) * g_SpecularStrength;
  gl_FragColor.rgb += spec * g_SpecularColor * gl_FragColor.a;
` : ''}
}
`;
}
const WATERRIPPLE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordRipple;
uniform vec4 g_Texture0Resolution;
uniform float g_Time;
uniform float g_AnimationSpeed;
uniform float g_Scale;
uniform float g_ScrollSpeed;
uniform float g_Direction;
uniform float g_Ratio;
vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  vec2 coordsRotated = a_TexCoord;
  vec2 coordsRotated2 = a_TexCoord * 1.333;
  vec2 scroll = rotateVec2(vec2(0.0, 1.0), g_Direction) * g_ScrollSpeed * g_ScrollSpeed * g_Time;
  v_TexCoordRipple.xy = coordsRotated + g_Time * g_AnimationSpeed * g_AnimationSpeed + scroll;
  v_TexCoordRipple.zw = coordsRotated2 - g_Time * g_AnimationSpeed * g_AnimationSpeed + scroll;
  v_TexCoordRipple *= g_Scale;
  float rippleTextureAdjustment = g_Texture0Resolution.z / g_Texture0Resolution.w;
  v_TexCoordRipple.xz *= rippleTextureAdjustment;
  v_TexCoordRipple.yw *= g_Ratio;
}
`;

function extractWaterRippleConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('waterripple/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    if (combos.PERSPECTIVE) return { unsupported: 'PERSPECTIVE (distorção 4-pontos não suportada)' };
    const normalTexId = pass.textures && pass.textures[2];
    if (!normalTexId) return null; // sem normal map de água real, nada a distorcer
    const csv = pass.constantshadervalues || {};
    return {
      normalTexId,
      specular: !!combos.SPECULAR,
      strength: csvNum(csv.ripplestrength, 0.1),
      specularPower: csvNum(csv.ripplespecularpower, 1),
      specularStrength: csvNum(csv.ripplespecularstrength, 1),
      specularColor: csvVec(csv.ripplespecularcolor, [1, 1, 1]),
      animationSpeed: csvNum(csv.animationspeed, 0.15),
      scale: csvNum(csv.scale, 1),
      scrollSpeed: csvNum(csv.scrollspeed, 0),
      direction: csvNum(csv.scrolldirection, 0),
      ratio: csvNum(csv.ratio, 1),
    };
  }
  return null;
}

// ---- Efeito real "waterwaves" via WebGL ----
// Porta shaders/effects/waterwaves.frag/.vert reais — ondas senoidais
// distorcendo a UV numa direção (2 ondas independentes se DUALWAVES==1).
// 100% autocontido (não depende de nenhuma textura de cena) no caminho
// default (TIMEOFFSET==0). Só suporta PERSPECTIVE==0 (default real).
// TIMEOFFSET (variação de fase via textura) não suportado.
function buildWaterWavesVert({ dualWaves }) {
  return `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec2 v_Direction;
${dualWaves ? 'varying vec2 v_Direction2;' : ''}
uniform float g_Direction;
${dualWaves ? 'uniform float g_Direction2;' : ''}
vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  v_Direction = rotateVec2(vec2(0.0, 1.0), g_Direction);
  ${dualWaves ? 'v_Direction2 = rotateVec2(vec2(0.0, 1.0), g_Direction2);' : ''}
}
`;
}
function buildWaterWavesFragSource({ dualWaves }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec2 v_Direction;
${dualWaves ? 'varying vec2 v_Direction2;' : ''}
uniform sampler2D g_Texture0;
uniform float g_Time;
uniform float g_Speed;
uniform float g_Scale;
uniform float g_Exponent;
uniform float g_Strength;
${dualWaves ? `
uniform float g_Speed2;
uniform float g_Scale2;
uniform float g_Offset2;
uniform float g_Exponent2;
` : ''}
void main() {
  vec2 texCoord = v_TexCoord;
  float distance = g_Time * g_Speed + dot(texCoord, v_Direction) * g_Scale;
  ${dualWaves ? 'float distance2 = (g_Time + g_Offset2) * g_Speed2 + dot(texCoord, v_Direction2) * g_Scale2;' : ''}
  float strength = g_Strength * g_Strength;
  vec2 offset = vec2(v_Direction.y, -v_Direction.x);
  float val1 = sin(distance);
  float s1 = sign(val1);
  val1 = pow(abs(val1), g_Exponent);
${dualWaves ? `
  vec2 offset2 = vec2(v_Direction2.y, -v_Direction2.x);
  float val2 = sin(distance2);
  float s2 = sign(val2);
  val2 = pow(abs(val2), g_Exponent2);
  texCoord += val1 * s1 * val2 * s2 * offset * strength;
` : `
  texCoord += val1 * s1 * offset * strength;
`}
  gl_FragColor = texture2D(g_Texture0, texCoord);
}
`;
}

function extractWaterWavesConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('waterwaves/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    if (combos.PERSPECTIVE) return { unsupported: 'PERSPECTIVE (distorção 4-pontos não suportada)' };
    if (combos.TIMEOFFSET) return { unsupported: 'TIMEOFFSET (variação de fase via textura não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      dualWaves: !!combos.DUALWAVES,
      direction: csvNum(csv.direction, 0),
      speed: csvNum(csv.speed, 5),
      scale: csvNum(csv.scale, 200),
      exponent: csvNum(csv.exponent, 1),
      strength: csvNum(csv.strength, 0.1),
      direction2: csvNum(csv.direction2, 0),
      speed2: csvNum(csv.speed2, 3),
      scale2: csvNum(csv.scale2, 66),
      offset2: csvNum(csv.offset2, 0),
      exponent2: csvNum(csv.exponent2, 1),
    };
  }
  return null;
}

// ---- Efeito real "clouds" via WebGL ----
// Porta shaders/effects/clouds.frag/.vert reais — 2 camadas da mesma
// textura de nuvens (default real: util/clouds_256) se movendo em
// velocidades/escalas diferentes, multiplicadas entre si pro padrão
// clássico de nuvens. O branch SHADING==1 do shader real está comentado
// (código morto) — nesse caso o comportamento é idêntico ao branch "else"
// (SHADING!=0), então só precisamos diferenciar SHADING==0 vs SHADING!=0
// pra ser fiel. Só suporta PERSPECTIVE==0 e BLENDMODE==0 (defaults reais).
// MASK não suportado. texSample2DLod aproximado com texture2D normal
// (mesma aproximação já usada no nitro/shine).
const CLOUDS_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordClouds;
uniform vec4 g_Texture0Resolution;
uniform float g_Time;
uniform vec2 g_CloudSpeeds;
uniform vec4 g_CloudScales;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  float aspect = g_Texture0Resolution.z / g_Texture0Resolution.w;
  v_TexCoordClouds.xy = (a_TexCoord + g_Time * g_CloudSpeeds.x) * g_CloudScales.xy;
  v_TexCoordClouds.zw = (a_TexCoord + g_Time * g_CloudSpeeds.y) * g_CloudScales.zw;
  v_TexCoordClouds.xz *= aspect;
  v_TexCoordClouds.zw = vec2(-v_TexCoordClouds.w, v_TexCoordClouds.z);
}
`;

function buildCloudsFragSource({ shading, writeAlpha }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordClouds;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_CloudsAlpha;
uniform float g_CloudThreshold;
uniform float g_CloudFeather;
uniform vec3 g_Color1;
uniform vec3 g_Color2;
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  float cloud0 = texture2D(g_Texture1, v_TexCoordClouds.xy).r;
  float cloud1 = texture2D(g_Texture1, v_TexCoordClouds.zw).r;
  float cloudBlend = cloud0 * cloud1;
  cloudBlend = smoothstep(g_CloudThreshold, g_CloudThreshold + g_CloudFeather, cloudBlend);
  float blend = cloudBlend * g_CloudsAlpha;
  vec3 cloudColor;
${shading === 0 ? `
  cloudColor = mix(g_Color2, g_Color1, blend);
` : `
  cloudColor = mix(g_Color2, g_Color1, blend) * cloud0 * cloud1;
`}
  albedo.rgb = mix(albedo.rgb, cloudColor, blend);
  ${writeAlpha ? 'albedo.a = blend;' : ''}
  gl_FragColor = albedo;
}
`;
}

function extractCloudsConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('clouds/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    if (combos.PERSPECTIVE) return { unsupported: 'PERSPECTIVE (distorção 4-pontos não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 0;
    if (blendMode !== 0) return { unsupported: `BLENDMODE ${blendMode} (só Normal/0 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      shading: combos.SHADING != null ? combos.SHADING : 7,
      writeAlpha: !!combos.WRITEALPHA,
      alpha: csvNum(csv.alpha, 1),
      threshold: csvNum(csv.threshold, 0),
      feather: csvNum(csv.feather, 0.5),
      color1: csvVec(csv.colorstart, [1, 1, 1]),
      color2: csvVec(csv.colorend, [1, 1, 1]),
      speeds: csvVec(csv.speed, [0.01, -0.02]),
      scales: csvVec(csv.scale, [1.3, 1.3, 0.5, 0.5]),
    };
  }
  return null;
}

// ---- Efeito real "cloudmotion" via WebGL ----
// Porta shaders/effects/cloudmotion.frag/.vert reais — desloca a UV
// horizontalmente usando ruído perlin real (util/perlin_256, já usado em
// outros efeitos), simulando um "vento" sutil sobre a imagem. MASK não
// suportado.
function buildCloudMotionFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec2 v_NoiseCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture2;
uniform float u_amount;
uniform float u_direction;

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main() {
  vec3 noise = texture2D(g_Texture2, v_NoiseCoord).rgb;
  vec2 offset = vec2((noise.x * 2.0 - 1.0) * u_amount, 0.0);
  offset = rotateVec2(offset, u_direction + 1.57079632679);
  vec2 uvs = v_TexCoord + offset;
  gl_FragColor = texture2D(g_Texture0, uvs);
}
`;
}
const CLOUDMOTION_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec2 v_NoiseCoord;
uniform vec4 g_Texture0Resolution;
uniform float g_Time;
uniform float u_speed;
uniform float u_scale;
uniform float u_scaleX;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
  v_NoiseCoord = a_TexCoord;
  v_NoiseCoord.x *= g_Texture0Resolution.z / g_Texture0Resolution.w;
  v_NoiseCoord *= u_scale;
  v_NoiseCoord.x *= u_scaleX;
  v_NoiseCoord.x += g_Time * u_speed;
}
`;

function extractCloudMotionConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('cloudmotion/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const csv = pass.constantshadervalues || {};
    return {
      speed: csvNum(csv.ui_editor_properties_speed, 0.02),
      scale: csvNum(csv.ui_editor_properties_granularity, 2),
      scaleX: csvNum(csv.ui_editor_properties_granularity_horizontal, 0.5),
      amount: csvNum(csv.ui_editor_properties_amount, 0.1),
      direction: csvNum(csv.ui_editor_properties_direction, 1.57079632679),
    };
  }
  return null;
}

// ---- Efeito real "fire" via WebGL ----
// Porta shaders/effects/fire.frag/.vert reais — padrão de fogo/lava
// procedural via mapa de fluxo (default real util/noflow) distorcendo uma
// textura de ruído (default real util/clouds_256), ambas assets padrão da
// própria WE (não depende de nenhum asset específico da cena). REFRACT
// suportado por inteiro. BLENDMODE default real é 0 (Normal). Esse shader
// não tem combo MASK.
function buildFireFragSource({ refract }) {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform sampler2D g_Texture2;
uniform float g_Time;
uniform float g_FlowSpeed;
uniform float g_CloudsAlpha;
uniform float g_CloudThreshold;
uniform float g_CloudFeather;
uniform float g_CloudScale;
uniform float g_Distortion;
uniform vec3 g_Color1;
uniform vec3 g_Color2;
#define REFRACT ${refract ? 1 : 0}

void main() {
  vec2 flowColors = texture2D(g_Texture1, v_TexCoord).rg;
  vec2 flowMask = (flowColors - vec2(0.498, 0.498)) * 2.0;

  float scaledTime = g_Time * g_FlowSpeed;
  vec2 cycles = vec2(fract(scaledTime), fract(scaledTime + 0.5));
  float blend = 2.0 * abs(cycles.x - 0.5);

  vec2 flowUVOffset1 = g_CloudScale * flowMask * 0.15 * (cycles.x - 0.5);
  vec2 flowUVOffset2 = g_CloudScale * flowMask * 0.15 * (cycles.y - 0.5);

  float cloudBackground = texture2D(g_Texture2, v_TexCoord * g_CloudScale + scaledTime * 0.1).r;
  float cloud0 = texture2D(g_Texture2, v_TexCoord * g_CloudScale + flowUVOffset1).r;
  float cloud1 = texture2D(g_Texture2, v_TexCoord * g_CloudScale + flowUVOffset2).r;
  float streamNoise = mix(cloud0, cloud1, blend);

  vec2 baseUV = v_TexCoord;
  float flowMaskLength = pow(length(flowMask), 2.0);
#if REFRACT == 1
  baseUV += mix(flowMask, -flowMask, streamNoise) * cloudBackground * 0.5 * streamNoise * flowMaskLength * g_Distortion;
#endif

  vec4 albedo = texture2D(g_Texture0, baseUV);

  streamNoise = fract(streamNoise + scaledTime * 0.2);
  float colorNoise = smoothstep(0.0, 0.5, streamNoise) * smoothstep(1.0, 0.5, streamNoise);
  vec3 cloudColor = mix(g_Color2, g_Color1, colorNoise);
  float blendNoise = mix(colorNoise * flowMaskLength, 1.0, pow(flowMaskLength, 4.0));
  blendNoise = smoothstep(g_CloudThreshold, g_CloudThreshold + g_CloudFeather, blendNoise);
  float streamBlend = g_CloudsAlpha * blendNoise;

  albedo.rgb = mix(albedo.rgb, cloudColor, streamBlend);
  gl_FragColor = albedo;
}
`;
}
const FIRE_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
  gl_Position = vec4(a_Position, 0.0, 1.0);
  v_TexCoord = a_TexCoord;
}
`;

function extractFireConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('fire/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 0;
    if (blendMode !== 0) return { unsupported: `BLENDMODE ${blendMode} (só Normal/0 suportado)` };
    const csv = pass.constantshadervalues || {};
    return {
      refract: combos.REFRACT != null ? !!combos.REFRACT : true,
      flowSpeed: csvNum(csv.speed, 1),
      alpha: csvNum(csv.alpha, 2),
      threshold: csvNum(csv.threshold, 0),
      feather: csvNum(csv.feather, 0.5),
      scale: csvNum(csv.scale, 2),
      distortion: csvNum(csv.distortion, 1),
      color1: csvVec(csv.colorstart, [1, 0.25, 0]),
      color2: csvVec(csv.colorend, [1, 0.8, 0]),
    };
  }
  return null;
}

// ---- Efeito real "depthparallax" via WebGL (interativo — cursor real) ----
// Porta shaders/effects/depthparallax.frag/.vert reais — desloca a UV
// baseado num mapa de profundidade (default real: util/black, ou seja
// "chapado"/sem relevo por padrão — só produz distorção visível quando a
// cena pinta um mapa de profundidade de verdade) e na posição REAL do
// cursor (g_ParallaxPosition no shader original — confirmado no .vert que
// é isso mesmo, não algo scriptado). Usa a infraestrutura de cursor
// (IPC 'cursor-position' + _getCursorStagePos) — sem ela esse efeito seria
// impossível de fazer de verdade, por isso ficou adiado até agora.
// A rotação via g_EffectTextureProjectionMatrixInverse (câmera 3D da WE,
// que não existe nesse renderer 2D) é aproximada como identidade — o
// próprio shader original deixa exatamente essa forma simplificada
// comentada como alternativa (`//v_ParallaxOffset = g_ParallaxPosition;`),
// então não é uma invenção nossa. Só suporta QUALITY==0 (básico, 1 amostra)
// — QUALITY 1/2 fazem parallax occlusion mapping com loop de 24/64
// amostras, não portado por ora (custo/risco alto pra pouco ganho visual
// runtime sem ter certeza de que a orientação do loop está correta). MASK
// não suportado.
function buildDepthParallaxFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform vec2 g_Scale;
uniform vec2 g_ParallaxOffset;
void main() {
  float depth = texture2D(g_Texture1, v_TexCoord).r;
  vec2 pointer = vec2(v_TexCoord.x, 1.0 - v_TexCoord.y);
  pointer = (pointer - g_ParallaxOffset) * vec2(2.0, -2.0) * g_Scale * -0.04;
  vec2 offset = (depth * 2.0 - 1.0) * pointer;
  gl_FragColor = texture2D(g_Texture0, v_TexCoord + offset);
}
`;
}

function extractDepthParallaxConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('depthparallax/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.MASK) return { unsupported: 'MASK (textura de opacidade não suportada)' };
    const quality = combos.QUALITY != null ? combos.QUALITY : 1;
    if (quality !== 0) return { unsupported: `QUALITY ${quality} (parallax occlusion mapping com loop de amostras não suportado, só o modo básico/0)` };
    const csv = pass.constantshadervalues || {};
    return {
      depthTexId: (pass.textures && pass.textures[1]) || null,
      scale: csvVec(csv.scale, [1, 1]),
    };
  }
  return null;
}

// ---- Efeito real "xray" via WebGL (interativo — cursor real) ----
// Porta shaders/effects/xray.frag/.vert reais — um "holofote" que revela
// uma textura de blend (default real: util/white — branco puro, então por
// padrão aparece como um círculo branco seguindo o cursor de verdade) por
// trás de um sprite de halo suave (default real: particle/halo_6, asset de
// partícula real da própria WE) posicionado/escalado no cursor. Mesma
// infraestrutura de cursor do depthparallax. A projeção via
// g_EffectTextureProjectionMatrixInverse (câmera 3D, que não temos) é
// aproximada como identidade — mesma classe de simplificação aceita no
// depthparallax. BLENDMODE default real é 0 (Normal). OPACITYMASK não
// suportado. Sem asset real de util/white decodificável (mesmo caso do
// blendgradient), sintetizamos um branco 1x1 quando a cena não define uma
// textura de blend própria.
function buildXrayFragSource() {
  return `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform sampler2D g_Texture2;
uniform float g_Multiply;
uniform vec2 g_CursorUV;
uniform float g_PointerScale;
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec4 mask = texture2D(g_Texture1, v_TexCoord);
  float blend = mask.a * g_Multiply;

  vec2 delta = v_TexCoord - g_CursorUV;
  vec2 spriteUV = delta * g_PointerScale + 0.5;
  vec2 blendSample = texture2D(g_Texture2, spriteUV).ra;
  blend *= blendSample.x * blendSample.y;

  albedo.rgb = mix(albedo.rgb, mask.rgb, blend);
  gl_FragColor = albedo;
}
`;
}

function extractXrayConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('xray/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.OPACITYMASK) return { unsupported: 'OPACITYMASK (máscara de opacidade extra não suportada)' };
    const blendMode = combos.BLENDMODE != null ? combos.BLENDMODE : 0;
    if (blendMode !== 0) return { unsupported: `BLENDMODE ${blendMode} (só Normal/0 suportado)` };
    const csv = pass.constantshadervalues || {};
    const size = csvNum(csv.size, 0.2);
    return {
      blendTexId: (pass.textures && pass.textures[1]) || null,
      spriteTexId: (pass.textures && pass.textures[2]) || null,
      multiply: csvNum(csv.multiply, 1),
      pointerScale: size < 0.001 ? 999 : 1 / size,
    };
  }
  return null;
}

// ---- Efeito real "cursorripple" via WebGL (interativo — cursor real, com
// estado persistente entre frames) ----
// Porta shaders/effects/cursorripple_apply_force/simulate_force/combine.frag
// reais. Confirmado no effect.json real que o buffer de força ("_rt_Eight
// Buffer1/2") é "rgba8888" — 8 bits, NÃO precisa de half-float — então isso
// NÃO é da mesma classe de complexidade do fluidsimulation (que usa rg1616f/
// r16f de verdade); é o mesmo padrão de ping-pong já usado no motion blur,
// só que os 2 buffers persistem de verdade entre frames (nunca são limpos
// depois do primeiro frame) porque É o próprio estado da simulação: cada
// canal RGBA acumula força numa direção (R=direita, G=cima, B=esquerda,
// W=baixo), decai ~1.5/255 por frame e reflete nas bordas (REFLECTION==1,
// default real). A matriz de projeção 3D (g_EffectTextureProjectionMatrix
// Inverse) é aproximada como identidade — com identidade, o unproject/
// reproject completo do .vert original se cancela algebricamente e a UV do
// cursor vira exatamente a posição normalizada sem transformação (verificado
// à mão termo a termo), mesma classe de simplificação já aceita em
// depthparallax/xray. SHADING (tingimento direcional) e MASK (máscara de
// colisão) não suportados — só os defaults reais (ambos off).
const CURSORRIPPLE_APPLYFORCE_VERT = `
precision mediump float;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec4 v_PointerUV;
varying vec4 v_PointerUVLast;
varying vec2 v_PointDelta;
uniform vec2 g_PointerPosition;
uniform vec2 g_PointerPositionLast;
uniform vec4 g_Texture0Resolution;
uniform float g_RippleScale;
void main() {
  gl_Position = vec4(a_Position, 1.0);
  v_TexCoord = a_TexCoord;
  v_PointerUV.xy = g_PointerPosition;
  v_PointerUVLast.xy = g_PointerPositionLast;
  v_PointerUV.z = 1.0;
  v_PointerUVLast.z = 1.0;
  v_PointDelta.x = length(g_PointerPosition - g_PointerPositionLast) * 100.0;
  v_PointDelta.y = 60.0 / max(0.0001, g_RippleScale);
  float aspectTerm = (g_Texture0Resolution.y / g_Texture0Resolution.x) * v_PointDelta.y;
  v_PointerUV.w = aspectTerm;
  v_PointerUVLast.w = aspectTerm;
}
`;

const CURSORRIPPLE_APPLYFORCE_FRAG = `
precision mediump float;
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float g_Frametime;
uniform vec4 g_PointerState;
varying vec4 v_PointerUV;
varying vec4 v_PointerUVLast;
varying vec2 v_PointDelta;
void main() {
  vec2 texSource = v_TexCoord.xy;
  vec4 albedo = texture2D(g_Texture0, texSource);

  vec2 unprojectedUVs = v_PointerUV.xy;
  vec2 unprojectedUVsLast = v_PointerUVLast.xy;

  vec2 lDelta = unprojectedUVs - unprojectedUVsLast;
  vec2 texDelta = texSource - unprojectedUVsLast;

  float distLDelta = length(lDelta) + 0.0001;
  lDelta /= distLDelta;
  float distOnLine = dot(lDelta, texDelta);

  float rayMask = max(step(0.0, distOnLine) * step(distOnLine, distLDelta), step(distLDelta, 0.1));

  distOnLine = clamp(distOnLine / distLDelta, 0.0, 1.0) * distLDelta;
  vec2 posOnLine = unprojectedUVsLast + lDelta * distOnLine;

  unprojectedUVs = (texSource - posOnLine) * vec2(v_PointDelta.y, v_PointerUV.w);

  float pointerDist = length(unprojectedUVs);
  pointerDist = clamp(1.0 - pointerDist, 0.0, 1.0);
  pointerDist *= rayMask;

  float timeAmt = min(1.0 / 30.0, g_Frametime) / 0.02;
  float pointerMoveAmt = v_PointDelta.x;
  float inputStrength = pointerDist * timeAmt * (pointerMoveAmt + g_PointerState.z * 5.0);
  vec2 impulseDir = max(vec2(-1.0, -1.0), min(vec2(1.0, 1.0), unprojectedUVs));

  vec4 colorAdd = vec4(
    step(0.0, impulseDir.x) * impulseDir.x * inputStrength,
    step(0.0, impulseDir.y) * impulseDir.y * inputStrength,
    step(impulseDir.x, 0.0) * -impulseDir.x * inputStrength,
    step(impulseDir.y, 0.0) * -impulseDir.y * inputStrength
  );

  gl_FragColor = albedo + colorAdd;
}
`;

const CURSORRIPPLE_SIMULATE_FRAG = `
precision mediump float;
uniform float g_Frametime;
uniform vec4 g_Texture0Resolution;
uniform sampler2D g_Texture0;
uniform float g_RippleSpeed;
uniform float g_RippleDecay;
varying vec2 v_TexCoord;

vec4 sampleF(vec4 a, vec4 b, vec4 c) { return max(a, max(b, c)); }

void main() {
  vec2 srcCoords = v_TexCoord.xy;
  vec2 simTexel = 1.0 / g_Texture0Resolution.xy;
  vec2 rippleOffset = simTexel * 100.0 * g_RippleSpeed * min(1.0 / 30.0, g_Frametime);

  vec2 insideRipple = rippleOffset * 1.61;
  vec2 outsideRipple = rippleOffset;

  float reflectUp = step(1.0 - simTexel.y, srcCoords.y);
  float reflectDown = step(srcCoords.y, simTexel.y);
  float reflectLeft = step(1.0 - simTexel.x, srcCoords.x);
  float reflectRight = step(srcCoords.x, simTexel.x);

  vec2 motionCoords = srcCoords;
  vec4 uc = texture2D(g_Texture0, motionCoords + vec2(0.0, -insideRipple.y));
  vec4 u00 = texture2D(g_Texture0, motionCoords + vec2(-outsideRipple.x, -outsideRipple.y));
  vec4 u10 = texture2D(g_Texture0, motionCoords + vec2(outsideRipple.x, -outsideRipple.y));

  vec4 dc = texture2D(g_Texture0, motionCoords + vec2(0.0, insideRipple.y));
  vec4 d01 = texture2D(g_Texture0, motionCoords + vec2(-outsideRipple.x, outsideRipple.y));
  vec4 d11 = texture2D(g_Texture0, motionCoords + vec2(outsideRipple.x, outsideRipple.y));

  vec4 lc = texture2D(g_Texture0, motionCoords + vec2(-insideRipple.x, 0.0));
  vec4 l00 = texture2D(g_Texture0, motionCoords + vec2(-outsideRipple.x, -outsideRipple.y));
  vec4 l01 = texture2D(g_Texture0, motionCoords + vec2(-outsideRipple.x, outsideRipple.y));

  vec4 rc = texture2D(g_Texture0, motionCoords + vec2(insideRipple.x, 0.0));
  vec4 r10 = texture2D(g_Texture0, motionCoords + vec2(outsideRipple.x, -outsideRipple.y));
  vec4 r11 = texture2D(g_Texture0, motionCoords + vec2(outsideRipple.x, outsideRipple.y));

  vec4 up = sampleF(uc, u00, u10);
  vec4 down = sampleF(dc, d01, d11);
  vec4 left = sampleF(lc, l00, l01);
  vec4 right = sampleF(rc, r10, r11);

  vec4 force = vec4(0.0, 0.0, 0.0, 0.0);
  float componentScale = 1.0 / 3.0;
  force.xzy += up.xzy;
  force.xzw += down.xzw;
  force.xyw += left.xyw;
  force.zyw += right.zyw;
  force *= componentScale;

  vec4 forceCopy = force;
  float reflectionScale = 1.0;
  force.y = mix(force.y, forceCopy.w * reflectionScale, reflectDown);
  force.w = mix(force.w, forceCopy.y * reflectionScale, reflectUp);
  force.x = mix(force.x, forceCopy.z * reflectionScale, reflectRight);
  force.z = mix(force.z, forceCopy.x * reflectionScale, reflectLeft);

  float decay = 1.5;
  float drop = max(1.001 / 255.0, decay / 255.0 * (g_Frametime / 0.02) * g_RippleDecay);
  force -= drop;

  gl_FragColor = force;
}
`;

const CURSORRIPPLE_COMBINE_FRAG = `
precision mediump float;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_RippleStrength;
varying vec2 v_TexCoord;
void main() {
  vec2 srcCoords = v_TexCoord.xy;
  vec4 albedo = texture2D(g_Texture0, srcCoords);
  albedo *= albedo;
  vec2 dir = vec2(albedo.x - albedo.z, albedo.y - albedo.w);
  vec2 offset = dir * (-0.1 * g_RippleStrength);
  gl_FragColor = texture2D(g_Texture1, srcCoords + offset);
}
`;

function extractCursorRippleConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('cursorripple/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 3) continue;
    const applyPass = passes[0];
    const simPass = passes[1];
    const combinePass = passes[2];
    const aCombos = (applyPass && applyPass.combos) || {};
    const sCombos = (simPass && simPass.combos) || {};
    const cCombos = (combinePass && combinePass.combos) || {};
    if (aCombos.PERSPECTIVE || cCombos.PERSPECTIVE) return { unsupported: 'PERSPECTIVE (gizmo de perspectiva não suportado)' };
    if (sCombos.MASK) return { unsupported: 'MASK (máscara de colisão não suportada)' };
    if (cCombos.SHADING) return { unsupported: 'SHADING (tingimento direcional não suportado)' };
    if (sCombos.REFLECTION != null && !sCombos.REFLECTION) return { unsupported: 'REFLECTION desligado (só o default real, ligado, suportado)' };
    const aCsv = (applyPass && applyPass.constantshadervalues) || {};
    const sCsv = (simPass && simPass.constantshadervalues) || {};
    const cCsv = (combinePass && combinePass.constantshadervalues) || {};
    return {
      rippleScale: aCsv.ripplescale != null ? Number(aCsv.ripplescale) : 1.0,
      rippleSpeed: sCsv.ripplespeed != null ? Number(sCsv.ripplespeed) : 1.0,
      rippleDecay: sCsv.rippledecay != null ? Number(sCsv.rippledecay) : 1.0,
      rippleStrength: cCsv.ripplestrength != null ? Number(cCsv.ripplestrength) : 1.0,
    };
  }
  return null;
}

// ---- Efeito real "fluidsimulation" via WebGL (solver de fluidos real,
// Navier-Stokes/stable-fluids — o mais complexo de todos os efeitos
// portados) ----
// Porta shaders/effects/fluidsimulation_{curl,vorticity,divergence,clear,
// pressure,gradientsubtract,advection,normal,combine}.frag/.vert reais.
// Confirmado no effect.json real (não suposição): 15 passes reais por frame
// (curl, vorticity, divergence, clear, 9 iterações de Jacobi de pressão,
// gradientsubtract, advecção de velocidade, advecção do dye/cor, combine) +
// 2 "swap" que só renomeiam os buffers de velocidade/dye pro próximo frame
// (aqui isso vira uma troca de referência JS, sem custo). Os buffers de
// velocidade/pressão/divergência/curl são "rg1616f"/"r16f" DE VERDADE no
// arquivo real — isso SIM precisa de textura de render target em ponto
// flutuante (extensão WebGL1 OES_texture_half_float), ao contrário do
// cursorripple (que é rgba8888, 8 bits, e por isso NÃO tem essa exigência).
// Se a extensão não existir nessa GPU/driver, o efeito não é aplicado (a
// imagem original é mantida) e isso é reportado — não dá pra fingir um
// solver de fluidos com 8 bits sem quebrar a física (a advecção
// semi-Lagrangiana e as 9 iterações de Jacobi acumulam erro rápido demais).
// A câmera 3D (g_EffectTextureProjectionMatrixInverse) é aproximada como
// identidade (mesma simplificação já aceita em depthparallax/xray/
// cursorripple — o cancelamento algébrico foi conferido termo a termo no
// .vert real). Só suporta os defaults reais confirmados nos .json:
// POINTEMITTER==1 (1 emissor central, pos "0.5 0.5"), LINEEMITTER==0,
// COLLISIONMASK==0, DYEEMITTER==0, LIGHTING==0, OPAQUE==0, PERSPECTIVE==0,
// RENDERING==0 (modo gradiente — usa gradient/gradient_fire real por
// padrão, textura stock confirmada decodificável) e BLENDMODE==31 (aditivo
// "A+B*opacity", igual godrays/shine). Resolução do buffer de simulação
// (velocidade/pressão/divergência/curl) limitada a 256px (fit:256 real);
// dye em metade da resolução da imagem (scale:2 real).
const FLUIDSIM_NEIGHBOR_VERT = `
precision mediump float;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordLeftTop;
varying vec4 v_TexCoordRightBottom;
uniform vec4 g_Texture0Resolution;
void main() {
  gl_Position = vec4(a_Position, 1.0);
  v_TexCoord = a_TexCoord.xy;
  vec2 texelSize = 1.0 / g_Texture0Resolution.xy;
  v_TexCoordLeftTop = v_TexCoord.xyxy;
  v_TexCoordRightBottom = v_TexCoord.xyxy;
  v_TexCoordLeftTop.x -= texelSize.x;
  v_TexCoordLeftTop.w += texelSize.y;
  v_TexCoordRightBottom.x += texelSize.x;
  v_TexCoordRightBottom.w -= texelSize.y;
}
`;

const FLUIDSIM_CURL_FRAG = `
precision mediump float;
uniform sampler2D g_Texture0;
varying vec4 v_TexCoordLeftTop;
varying vec4 v_TexCoordRightBottom;
void main() {
  vec2 vL = v_TexCoordLeftTop.xy;
  vec2 vR = v_TexCoordRightBottom.xy;
  vec2 vT = v_TexCoordLeftTop.zw;
  vec2 vB = v_TexCoordRightBottom.zw;
  float L = texture2D(g_Texture0, vL).y;
  float R = texture2D(g_Texture0, vR).y;
  float T = texture2D(g_Texture0, vT).x;
  float B = texture2D(g_Texture0, vB).x;
  float vorticity = R - L - T + B;
  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`;

const FLUIDSIM_VORTICITY_VERT = `
precision mediump float;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordLeftTop;
varying vec4 v_TexCoordRightBottom;
varying vec4 v_PointerUV;
varying vec4 v_PointerUVLast;
varying vec2 v_PointDelta;
uniform vec4 g_Texture0Resolution;
uniform vec2 g_PointerPosition;
uniform vec2 g_PointerPositionLast;
uniform float u_CursorInfluence;
void main() {
  gl_Position = vec4(a_Position, 1.0);
  v_TexCoord = a_TexCoord.xy;
  vec2 texelSize = 1.0 / g_Texture0Resolution.xy;
  v_TexCoordLeftTop = v_TexCoord.xyxy;
  v_TexCoordRightBottom = v_TexCoord.xyxy;
  v_TexCoordLeftTop.x -= texelSize.x;
  v_TexCoordLeftTop.w += texelSize.y;
  v_TexCoordRightBottom.x += texelSize.x;
  v_TexCoordRightBottom.w -= texelSize.y;

  v_PointerUV.xy = g_PointerPosition;
  v_PointerUVLast.xy = g_PointerPositionLast;
  v_PointerUV.z = 1.0;
  v_PointerUVLast.z = 1.0;

  float moveAmt = length(g_PointerPosition - g_PointerPositionLast);
  v_PointDelta.x = step(0.0, moveAmt) * 0.5 + moveAmt * 10.0 * u_CursorInfluence;
  v_PointDelta.y = 60.0 / max(0.0001, u_CursorInfluence);
  float aspectTerm = (g_Texture0Resolution.y / g_Texture0Resolution.x) * v_PointDelta.y;
  v_PointerUV.w = aspectTerm;
  v_PointerUVLast.w = aspectTerm;
}
`;

const FLUIDSIM_VORTICITY_FRAG = `
precision mediump float;
uniform float g_Frametime;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform vec4 g_Texture0Resolution;
uniform vec4 g_PointerState;
uniform float u_Curl;
uniform vec2 m_EmitterPos0;
uniform float m_EmitterAngle0;
uniform float m_EmitterSize0;
uniform float m_EmitterSpeed0;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordLeftTop;
varying vec4 v_TexCoordRightBottom;
varying vec4 v_PointerUV;
varying vec4 v_PointerUVLast;
varying vec2 v_PointDelta;

vec2 EmitterVelocity(vec2 texCoord, vec2 position, float angle, float size, float speed) {
  vec2 delta = position - texCoord;
  float amt = step(length(delta), size) * speed;
  return vec2(sin(angle), -cos(angle)) * amt;
}

void main() {
  float dt = min(1.0 / 20.0, g_Frametime);
  vec2 vUv = v_TexCoord;
  vec2 vL = v_TexCoordLeftTop.xy;
  vec2 vR = v_TexCoordRightBottom.xy;
  vec2 vT = v_TexCoordLeftTop.zw;
  vec2 vB = v_TexCoordRightBottom.zw;

  float L = texture2D(g_Texture1, vL).x;
  float R = texture2D(g_Texture1, vR).x;
  float T = texture2D(g_Texture1, vT).x;
  float B = texture2D(g_Texture1, vB).x;
  float C = texture2D(g_Texture1, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= u_Curl * C;
  force.y *= -1.0;
  vec2 velocity = texture2D(g_Texture0, v_TexCoord).xy;
  velocity += force * dt;
  velocity = min(max(velocity, -1000.0), 1000.0);

  velocity += EmitterVelocity(v_TexCoord, m_EmitterPos0, m_EmitterAngle0, m_EmitterSize0, g_Frametime * m_EmitterSpeed0);

  vec2 texSource = v_TexCoord.xy;
  vec2 unprojectedUVs = v_PointerUV.xy;
  vec2 unprojectedUVsLast = v_PointerUVLast.xy;

  vec2 lDelta = unprojectedUVs - unprojectedUVsLast;
  vec2 texDelta = texSource - unprojectedUVsLast;

  float distLDelta = length(lDelta) + 0.0001;
  lDelta /= distLDelta;
  float distOnLine = dot(lDelta, texDelta);
  float rayMask = max(step(0.0, distOnLine) * step(distOnLine, distLDelta), step(distLDelta, 0.1));
  distOnLine = clamp(distOnLine / distLDelta, 0.0, 1.0) * distLDelta;
  vec2 posOnLine = unprojectedUVsLast + lDelta * distOnLine;

  unprojectedUVs = (texSource - posOnLine) * vec2(v_PointDelta.y, v_PointerUV.w);
  float pointerDist = length(unprojectedUVs);
  pointerDist = clamp(1.0 - pointerDist, 0.0, 1.0);
  pointerDist *= rayMask;

  float pointerMoveAmt = v_PointDelta.x;
  float inputStrength = pointerDist * (pointerMoveAmt + g_PointerState.z);
  vec2 impulseDir = lDelta;
  velocity += vec2(impulseDir.x * inputStrength, impulseDir.y * inputStrength) * 300.0;

  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

const FLUIDSIM_DIVERGENCE_FRAG = `
precision mediump float;
uniform sampler2D g_Texture0;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordLeftTop;
varying vec4 v_TexCoordRightBottom;
void main() {
  vec2 vUv = v_TexCoord;
  vec2 vL = v_TexCoordLeftTop.xy;
  vec2 vR = v_TexCoordRightBottom.xy;
  vec2 vT = v_TexCoordLeftTop.zw;
  vec2 vB = v_TexCoordRightBottom.zw;
  float L = texture2D(g_Texture0, vL).x;
  float R = texture2D(g_Texture0, vR).x;
  float T = texture2D(g_Texture0, vT).y;
  float B = texture2D(g_Texture0, vB).y;
  vec2 C = texture2D(g_Texture0, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

const FLUIDSIM_CLEAR_VERT = `
precision mediump float;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
uniform float g_Frametime;
uniform float u_Pressure;
varying vec3 v_TexCoord;
void main() {
  gl_Position = vec4(a_Position, 1.0);
  v_TexCoord.xy = a_TexCoord.xy;
  v_TexCoord.z = pow(u_Pressure, 60.0 * g_Frametime);
}
`;

const FLUIDSIM_CLEAR_FRAG = `
precision mediump float;
uniform sampler2D g_Texture0;
varying vec3 v_TexCoord;
void main() {
  gl_FragColor = v_TexCoord.z * texture2D(g_Texture0, v_TexCoord.xy);
}
`;

const FLUIDSIM_PRESSURE_FRAG = `
precision mediump float;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordLeftTop;
varying vec4 v_TexCoordRightBottom;
void main() {
  vec2 vUv = v_TexCoord;
  vec2 vL = v_TexCoordLeftTop.xy;
  vec2 vR = v_TexCoordRightBottom.xy;
  vec2 vT = v_TexCoordLeftTop.zw;
  vec2 vB = v_TexCoordRightBottom.zw;
  float L = texture2D(g_Texture1, vL).x;
  float R = texture2D(g_Texture1, vR).x;
  float T = texture2D(g_Texture1, vT).x;
  float B = texture2D(g_Texture1, vB).x;
  float divergence = texture2D(g_Texture0, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const FLUIDSIM_GRADSUB_FRAG = `
precision mediump float;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
varying vec2 v_TexCoord;
varying vec4 v_TexCoordLeftTop;
varying vec4 v_TexCoordRightBottom;
void main() {
  vec2 vUv = v_TexCoord;
  vec2 vL = v_TexCoordLeftTop.xy;
  vec2 vR = v_TexCoordRightBottom.xy;
  vec2 vT = v_TexCoordLeftTop.zw;
  vec2 vB = v_TexCoordRightBottom.zw;
  float L = texture2D(g_Texture0, vL).x;
  float R = texture2D(g_Texture0, vR).x;
  float T = texture2D(g_Texture0, vT).x;
  float B = texture2D(g_Texture0, vB).x;
  vec2 velocity = texture2D(g_Texture1, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

function buildFluidAdvectionFragSource({ dye }) {
  return `
precision mediump float;
uniform float g_Frametime;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform vec4 g_Texture0Resolution;
uniform float u_Dissipation;
uniform float u_Viscosity;
uniform float m_Dissipation;
uniform float u_Lifetime;
varying vec2 v_TexCoord;
#define DYE ${dye ? 1 : 0}
#if DYE
uniform vec2 m_EmitterPos0;
uniform float m_EmitterSize0;
vec4 AddEmitterColor(float amt, vec4 currentColor) {
  return min(currentColor + vec4(amt, amt, amt, amt), vec4(1.0));
}
vec4 EmitterColor(vec2 texCoord, float aspect, vec4 currentColor, vec2 position, float size) {
  vec2 delta = position - texCoord;
  delta.y *= aspect;
  float amt = smoothstep(size, 0.0, length(delta));
  return AddEmitterColor(amt, currentColor);
}
#endif
void main() {
  vec2 vUv = v_TexCoord;
  vec2 texelSize = 1.0 / g_Texture0Resolution.xy;
  float dt = min(1.0 / 20.0, g_Frametime);
  vec2 coord = vUv - dt * texture2D(g_Texture0, vUv).xy * texelSize;
  vec4 result = texture2D(g_Texture1, coord);

#if DYE
  float decayFactor = u_Dissipation;
  float boundaryMask = step(0.0, coord.x) * step(coord.x, 1.0) * step(0.0, coord.y) * step(coord.y, 1.0);
#else
  float decayFactor = u_Viscosity;
#endif

  float decay = 1.0 + decayFactor * m_Dissipation * dt;
  float lowPass = step(length(result.rgb), u_Lifetime) * 0.5;

#if DYE
  result *= boundaryMask;
#endif

  gl_FragColor = result / (decay + lowPass);

#if DYE
  float aspect = g_Texture0Resolution.y / g_Texture0Resolution.x;
  gl_FragColor = EmitterColor(v_TexCoord, aspect, gl_FragColor, m_EmitterPos0, m_EmitterSize0);
#endif
}
`;
}

function buildFluidCombineFragSource() {
  return `
precision mediump float;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform sampler2D g_Texture3;
uniform float u_Brightness;
uniform float u_Alpha;
uniform float u_Feather;
uniform float u_HueShift;
varying vec2 v_TexCoord;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 RGB) {
  vec4 P = (RGB.g < RGB.b) ? vec4(RGB.bg, -1.0, 2.0 / 3.0) : vec4(RGB.gb, 0.0, -1.0 / 3.0);
  vec4 Q = (RGB.r < P.x) ? vec4(P.xyw, RGB.r) : vec4(RGB.r, P.yzx);
  float C = Q.x - min(Q.w, Q.y);
  float H = abs((Q.w - Q.y) / (6.0 * C + 1e-10) + Q.z);
  float S = C / (Q.x + 1e-10);
  return vec3(H, S, Q.x);
}

void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  vec4 gradientColor = texture2D(g_Texture3, vec2(albedo.r, 0.5));
  vec3 hsv = rgb2hsv(gradientColor.rgb);
  hsv.x += u_HueShift;
  albedo.rgb = hsv2rgb(hsv) * u_Brightness;
  albedo.a *= gradientColor.a;
  albedo.a = smoothstep(0.0, u_Feather, albedo.a);

  vec4 prev = texture2D(g_Texture1, v_TexCoord);
  albedo.rgb = prev.rgb + albedo.rgb * (albedo.a * u_Alpha);
  albedo.a = clamp(prev.a + albedo.a, 0.0, 1.0);

  gl_FragColor = albedo;
}
`;
}

function extractFluidSimulationConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('fluidsimulation/effect.json')) continue;
    const passes = eff.passes || [];
    if (passes.length < 18) continue;
    const vorticityPass = passes[1];
    const clearPass = passes[3];
    const advectPass = passes[14];
    const advectDyePass = passes[15];
    const combinePass = passes[17];
    const vCombos = (vorticityPass && vorticityPass.combos) || {};
    const aCombos = (advectPass && advectPass.combos) || {};
    const adCombos = (advectDyePass && advectDyePass.combos) || {};
    const cCombos = (combinePass && combinePass.combos) || {};

    const pointEmitter = vCombos.POINTEMITTER != null ? vCombos.POINTEMITTER : 1;
    if (pointEmitter !== 1) return { unsupported: `POINTEMITTER ${pointEmitter} (só 1 emissor central padrão suportado)` };
    if (vCombos.LINEEMITTER) return { unsupported: 'LINEEMITTER (emissores de linha não suportados)' };
    if (vCombos.PERSPECTIVE || cCombos.PERSPECTIVE) return { unsupported: 'PERSPECTIVE (gizmo de perspectiva não suportado)' };
    if (aCombos.COLLISIONMASK || adCombos.COLLISIONMASK) return { unsupported: 'COLLISIONMASK (máscara de colisão não suportada)' };
    if (adCombos.DYEEMITTER) return { unsupported: 'DYEEMITTER (textura de emissor de cor não suportada)' };
    if (cCombos.LIGHTING) return { unsupported: 'LIGHTING (normal mapping/iluminação não suportado)' };
    if (cCombos.OPAQUE) return { unsupported: 'OPAQUE (fundo opaco não suportado)' };
    const rendering = cCombos.RENDERING != null ? cCombos.RENDERING : 0;
    if (rendering !== 0) return { unsupported: `RENDERING ${rendering} (só o modo gradiente/0 suportado)` };
    const blendMode = cCombos.BLENDMODE != null ? cCombos.BLENDMODE : 31;
    if (blendMode !== 31) return { unsupported: `BLENDMODE ${blendMode} (só 31/aditivo suportado)` };

    const vCsv = (vorticityPass && vorticityPass.constantshadervalues) || {};
    const clearCsv = (clearPass && clearPass.constantshadervalues) || {};
    const aCsv = (advectPass && advectPass.constantshadervalues) || {};
    const adCsv = (advectDyePass && advectDyePass.constantshadervalues) || {};
    const cCsv = (combinePass && combinePass.constantshadervalues) || {};

    return {
      curl: vCsv.curl != null ? Number(vCsv.curl) : 30,
      cursorInfluence: vCsv.cursorinfluence != null ? Number(vCsv.cursorinfluence) : 1.0,
      emitterPos: csvVec(vCsv.emitterpos0, [0.5, 0.5]),
      emitterAngle: vCsv.emitterangle0 != null ? Number(vCsv.emitterangle0) : 0,
      emitterSize: vCsv.emittersize0 != null ? Number(vCsv.emittersize0) : 0.05,
      emitterSpeed: vCsv.emitterspeed0 != null ? Number(vCsv.emitterspeed0) : 100,
      pressureDecay: clearCsv.pressure != null ? Number(clearCsv.pressure) : 0.8,
      velViscosity: aCsv.viscosityfactor != null ? Number(aCsv.viscosityfactor) : 1.0,
      velDissipation: aCsv.dissipation != null ? Number(aCsv.dissipation) : 0.2,
      dyeDissipationFactor: adCsv.dissipationfactor != null ? Number(adCsv.dissipationfactor) : 1.0,
      dyeDissipation: adCsv.dissipation != null ? Number(adCsv.dissipation) : 0.4,
      lifetime: aCsv.lifetime != null ? Number(aCsv.lifetime) : 0.1,
      brightness: cCsv.brightness != null ? Number(cCsv.brightness) : 1.0,
      alpha: cCsv.opacity != null ? Number(cCsv.opacity) : 1.0,
      feather: cCsv.feather != null ? Number(cCsv.feather) : 1.0,
      hueShift: cCsv.hue != null ? Number(cCsv.hue) : 0,
      gradientTexId: (combinePass && combinePass.textures && combinePass.textures[3]) || null,
    };
  }
  return null;
}

// ---- Efeito real "lightshafts" (feixes de luz/godrays) via WebGL ----
// Objeto "shape":"quad" sem imagem, cujo único propósito é carregar esse
// efeito (confirmado real: 3763483939's "光束 - 角" — nenhum image/text/
// particle, só um efeito lightshafts). Porta line-by-line o
// shaders/effects/lightshafts.frag/.vert reais da instalação local da WE
// (common_perspective.h's squareToQuad + common_blending.h's
// ApplyBlending BLENDMODE==31), simplificado pro único caso real
// encontrado: combos.DIRECTDRAW=1 (desenha num canvas transparente do
// zero, não borra uma textura existente) — o que torna BLENDMODE sempre
// 31 (aditivo: "A+B*opacity" com A=0 já que DIRECTDRAW começa
// transparente), então já sai direto como "cor*intensidade*fx, alfa=fx"
// sem precisar portar a tabela inteira de blend modes.
//
// squareToQuad()+inverse(mat3) do shader original são calculados aqui em
// JS (não no shader) exatamente pra evitar a ambiguidade de convenção
// row-major/column-major entre HLSL e GLSL do "mul(v, M)" original — o
// resultado (3 "linhas" de uma matriz 3x3) é passado como 3 uniforms
// vec3, e o vertex shader só faz a combinação linear equivalente
// (a_TexCoord.x*row0 + a_TexCoord.y*row1 + row2), que é matematicamente
// idêntica a v*M nessa convenção independente de como o GLSL armazena
// mat3 internamente — construção e aplicação são feitas com a mesma
// convenção own, então não dependem de resolver essa ambiguidade.
//
// MAIOR RISCO NÃO VALIDADO (mesma classe de bug que já pegou o
// foliagesway e o puppet antes): qual canto do quad (0,0 vs 1,1 em
// a_TexCoord) corresponde a qual ponto/orientação do efeito original —
// só dá pra confirmar isso vendo o resultado renderizado de verdade.

// Inversão de matriz 3x3 padrão (adjugate/det) — mesma fórmula do
// `inverse(mat3)` real em common_perspective.h, só que operando em cima
// de 3 arrays-linha em vez de um mat3 GLSL, pra ficar explícito e testável.
function invert3x3Rows(r0, r1, r2) {
  const [a, b, c] = r0, [d, e, f] = r1, [g, h, i] = r2;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0) throw new Error('lightshafts: matriz de perspectiva não é invertível (4 pontos degenerados)');
  const D = c * h - b * i, E = a * i - c * g, F = b * g - a * h;
  const G = b * f - c * e, H = c * d - a * f, I = a * e - b * d;
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}

// Porta direta de squareToQuad() em common_perspective.h — nota a troca
// p2<->p3 do original (dx2/dy2 vêm de p3, dx3/dy3 vêm de p2), preservada
// aqui de propósito, não é erro de digitação.
function squareToQuadRows(p0, p1, p2, p3) {
  const [dx0, dy0] = p0, [dx1, dy1] = p1;
  const [dx2, dy2] = p3, [dx3, dy3] = p2;
  const diffx1 = dx1 - dx3, diffy1 = dy1 - dy3;
  const diffx2 = dx2 - dx3, diffy2 = dy2 - dy3;
  const det = diffx1 * diffy2 - diffx2 * diffy1;
  const sumx = dx0 - dx1 + dx3 - dx2, sumy = dy0 - dy1 + dy3 - dy2;
  if (det === 0 || (sumx === 0 && sumy === 0)) {
    return [
      [dx1 - dx0, dy1 - dy0, 0],
      [dx3 - dx1, dy3 - dy1, 0],
      [dx0, dy0, 1],
    ];
  }
  const ovdet = 1 / det;
  const g = (sumx * diffy2 - diffx2 * sumy) * ovdet;
  const h = (diffx1 * sumy - sumx * diffy1) * ovdet;
  return [
    [dx1 - dx0 + g * dx1, dy1 - dy0 + g * dy1, g],
    [dx2 - dx0 + h * dx2, dy2 - dy0 + h * dy2, h],
    [dx0, dy0, 1],
  ];
}

const LIGHTSHAFTS_VERT = `
attribute vec2 a_Position;
attribute vec2 a_TexCoord;
uniform vec3 u_XformRow0;
uniform vec3 u_XformRow1;
uniform vec3 u_XformRow2;
varying vec2 v_TexCoord;
varying vec3 v_TexCoordFx;
void main() {
  v_TexCoord = a_TexCoord;
  v_TexCoordFx = a_TexCoord.x * u_XformRow0 + a_TexCoord.y * u_XformRow1 + u_XformRow2;
  gl_Position = vec4(a_Position, 0.0, 1.0);
}
`;

// rayMode: 0=linear, 1=radial, 2=corner (só "corner" foi confirmado contra
// arquivo real). rayCorner: 0-3 (qual canto, só usado em rayMode==2).
// rendering: 0=mistura de 2 cores, 1=textura de gradiente.
function buildLightShaftsFragSource({ rayMode, rayCorner, rendering }) {
  const rayCornerFlip =
    rayCorner === 1 ? 'rayDelta.x = 1.0 - rayDelta.x;' :
    rayCorner === 2 ? 'rayDelta.y = 1.0 - rayDelta.y;' :
    rayCorner === 3 ? 'rayDelta.x = 1.0 - rayDelta.x;\n    rayDelta.y = 1.0 - rayDelta.y;' : '';

  const rayModeBlock = rayMode === 1 ? `
    vec2 rayCenter = vec2(0.5, 0.5);
    vec2 rayDelta = fxCoord - rayCenter;
    fxCoord.x = atan(rayDelta.y, rayDelta.x) / 6.283185 + 0.5;
    fxCoord.y = length(rayDelta) * 2.0;
    fxCoord.y = smoothstep(g_Radius, 1.0, fxCoord.y);
    fxCoordRef = fxCoord;
    shapeScale.x *= 4.0;
    mask *= smoothstep(-0.00001 + g_StartAngle, g_StartAngle + g_Feather.x, fxCoord.x);
    mask *= smoothstep(g_EndAngle + 0.00001, g_EndAngle - g_Feather.x, fxCoord.x);
    mask *= smoothstep(0.50001, 0.5 - g_Feather.y, abs(fxCoord.y - 0.5));
  ` : rayMode === 2 ? `
    vec2 rayCenter = vec2(0.0, 0.0);
    vec2 rayDelta = fxCoord - rayCenter;
    ${rayCornerFlip}
    fxCoord.x = atan(rayDelta.y, rayDelta.x) / 6.283185 * 4.0;
    fxCoord.y = max(rayDelta.x, rayDelta.y);
    fxCoord.y += texture2D(g_Texture1, vec2(fxCoord.x * 0.054111 * g_NoiseScale, 0.0)).r * g_NoiseAmount - (g_NoiseAmount * 0.5);
    fxCoord.y = smoothstep(g_Radius, 1.0, fxCoord.y);
    fxCoordRef = fxCoord;
    shapeScale.x *= 4.0;
    mask *= smoothstep(0.50001, 0.5 - g_Feather.x, abs(fxCoord.x - 0.5));
    mask *= smoothstep(0.50001, 0.5 - g_Feather.y, abs(fxCoord.y - 0.5));
  ` : `
    fxCoordRef = fxCoord;
    mask *= smoothstep(0.50001, 0.5 - g_Feather.x, abs(fxCoord.x - 0.5));
    mask *= smoothstep(0.50001, 0.5 - g_Feather.y, abs(fxCoord.y - 0.5));
  `;

  const renderingBlock = rendering === 1 ? `
    vec2 gradientUVs = vec2(fxCoordRef.y, 0.0);
    vec3 fxColor = texture2D(g_Texture2, gradientUVs).rgb;
  ` : `
    vec3 fxColor = mix(g_ColorRaysStart, g_ColorRaysEnd, fxCoordRef.y);
  `;

  return `
precision mediump float;
varying vec2 v_TexCoord;
varying vec3 v_TexCoordFx;
uniform sampler2D g_Texture1;
${rendering === 1 ? 'uniform sampler2D g_Texture2;' : ''}
uniform float g_Time;
uniform float g_Speed;
uniform vec2 g_Scale;
uniform float g_Smoothness;
uniform vec2 g_Feather;
uniform float g_Radius;
uniform float g_NoiseScale;
uniform float g_NoiseAmount;
uniform float g_Intensity;
uniform float g_Exponent;
uniform vec3 g_ColorRaysStart;
uniform vec3 g_ColorRaysEnd;
uniform float g_StartAngle;
uniform float g_EndAngle;

void main() {
  vec2 fxCoord = v_TexCoordFx.xy / v_TexCoordFx.z;
  float mask = step(0.0, v_TexCoordFx.z);
  vec2 shapeScale = g_Scale;
  vec2 fxCoordRef = fxCoord;

  ${rayModeBlock}

  float grad = 1.0 - fxCoord.y;
  mask *= grad;

  vec2 fxCoord2 = fxCoord;
  fxCoord.xy *= vec2(0.054111 * shapeScale.x, 0.003111 * shapeScale.y);
  fxCoord2.xy *= vec2(0.07333 * shapeScale.x, 0.005967111 * shapeScale.y);
  fxCoord.xy += g_Time * g_Speed * vec2(0.003, 0.000375111);
  fxCoord2.xy -= g_Time * g_Speed * vec2(0.0047111, 0.0007399);

  float fx0 = texture2D(g_Texture1, fxCoord).r;
  float fx1 = texture2D(g_Texture1, fxCoord2).r;
  float fx = fx0 * fx1;
  fx = pow(fx, g_Exponent);
  fx = smoothstep((1.0 - g_Smoothness) * 0.29999, 0.3 + g_Smoothness * 0.7, fx);

  ${renderingBlock}

  fx *= mask;
  vec3 finalColor = fxColor * g_Intensity * fx;
  gl_FragColor = vec4(finalColor, fx);
}
`;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`falha ao compilar shader: ${log}`);
  }
  return shader;
}

class FoliageSwayEffect {
  constructor(gl) {
    this.gl = gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, FOLIAGESWAY_VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FOLIAGESWAY_FRAG);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar programa: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    this.locations = {
      a_Position: gl.getAttribLocation(program, 'a_Position'),
      a_TexCoord: gl.getAttribLocation(program, 'a_TexCoord'),
      g_Texture0: gl.getUniformLocation(program, 'g_Texture0'),
      g_Texture1: gl.getUniformLocation(program, 'g_Texture1'),
      g_Texture2: gl.getUniformLocation(program, 'g_Texture2'),
      g_Texture0Resolution: gl.getUniformLocation(program, 'g_Texture0Resolution'),
      g_NoiseScale: gl.getUniformLocation(program, 'g_NoiseScale'),
      g_Ratio: gl.getUniformLocation(program, 'g_Ratio'),
      g_Direction: gl.getUniformLocation(program, 'g_Direction'),
      g_Strength: gl.getUniformLocation(program, 'g_Strength'),
      g_Speed: gl.getUniformLocation(program, 'g_Speed'),
      g_Power: gl.getUniformLocation(program, 'g_Power'),
      g_Phase: gl.getUniformLocation(program, 'g_Phase'),
      g_Time: gl.getUniformLocation(program, 'g_Time'),
    };

    // Quad de tela cheia: 2 triângulos via TRIANGLE_STRIP, posição em NDC
    // (-1..1) e UV (0..1) já alinhados pro topo-esquerda ficar em (0,0) —
    // ver UNPACK_FLIP_Y_WEBGL no upload de textura.
    const verts = new Float32Array([
      -1, 1, 0, 0,
      1, 1, 1, 0,
      -1, -1, 0, 1,
      1, -1, 1, 1,
    ]);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  }

  static uploadTexture(gl, source) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  // Variante com REPEAT — vários efeitos reais (scroll/spin/skew/transform)
  // usam frac(UV) esperando que a textura embrulhe nas bordas. WebGL1 só
  // permite REPEAT em textura com dimensões potência-de-2 (senão é
  // "incomplete" e vira preto); não dá pra fingir isso funcionando em
  // qualquer imagem arbitrária do usuário, então cai pra CLAMP_TO_EDGE
  // (imagem só "trava" na borda em vez de repetir) quando não for POT — o
  // chamador recebe `usedRepeat` pra avisar o usuário se quiser.
  static uploadTextureWrapped(gl, source, wantRepeat, w, h) {
    const isPOT = (n) => (n & (n - 1)) === 0 && n > 0;
    const canRepeat = !!wantRepeat && isPOT(w) && isPOT(h);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const wrap = canRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return { tex, usedRepeat: canRepeat };
  }

  // `type` opcional (ex.: ext.HALF_FLOAT_OES) — usado pelo fluidsimulation,
  // que precisa de render targets em ponto flutuante de verdade pra guardar
  // velocidade/pressão com sinal (8 bits não aguenta 9 iterações de Jacobi +
  // advecção sem estourar). Quando != UNSIGNED_BYTE, cai pra NEAREST porque
  // filtragem LINEAR em half-float exige uma 2ª extensão
  // (OES_texture_half_float_linear) que não checamos aqui — resultado fica
  // um pouco mais "em blocos", mas fisicamente correto.
  static createRenderTarget(gl, width, height, type) {
    const texType = type || gl.UNSIGNED_BYTE;
    const filter = texType === gl.UNSIGNED_BYTE ? gl.LINEAR : gl.NEAREST;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, texType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  // pass: { maskTex, scale, ratio, strength, scrolldirection, speeduv, power, phase }
  renderPass(inputTex, noiseTex, pass, baseWidth, baseHeight, time, targetFbo) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(this.locations.a_Position);
    gl.vertexAttribPointer(this.locations.a_Position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.locations.a_TexCoord);
    gl.vertexAttribPointer(this.locations.a_TexCoord, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, pass.maskTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(this.locations.g_Texture0, 0);
    gl.uniform1i(this.locations.g_Texture1, 1);
    gl.uniform1i(this.locations.g_Texture2, 2);

    gl.uniform4f(this.locations.g_Texture0Resolution, 1 / baseWidth, 1 / baseHeight, baseWidth, baseHeight);
    gl.uniform1f(this.locations.g_NoiseScale, pass.scale);
    gl.uniform1f(this.locations.g_Ratio, pass.ratio);
    gl.uniform1f(this.locations.g_Direction, pass.scrolldirection);
    gl.uniform1f(this.locations.g_Strength, pass.strength);
    gl.uniform1f(this.locations.g_Speed, pass.speeduv);
    gl.uniform1f(this.locations.g_Power, pass.power);
    gl.uniform1f(this.locations.g_Phase, pass.phase);
    gl.uniform1f(this.locations.g_Time, time);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// Lê os 3 uniforms/campos reais de cada passe "foliagesway" anexado a um
// objeto (scene.json objects[].effects[].file terminando em
// "foliagesway/effect.json") — valores default vindos direto dos
// comentários `// {"material":...,"default":...}` do shader real, usados só
// quando a cena não sobrescreve (constantshadervalues).
function extractFoliageSwayPasses(effects) {
  if (!effects) return [];
  const out = [];
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('foliagesway/effect.json')) continue;
    for (const pass of eff.passes || []) {
      const csv = pass.constantshadervalues || {};
      const maskRel = pass.textures && pass.textures[1];
      if (!maskRel) continue; // sem máscara (MASK=0) não temos como validar hoje — pula em vez de aplicar no quadro todo
      out.push({
        maskRel,
        scale: csv.scale != null ? csv.scale : 0.05,
        ratio: csv.ratio != null ? csv.ratio : 0.3,
        strength: csv.strength != null ? csv.strength : 0.4,
        scrolldirection: csv.scrolldirection != null ? csv.scrolldirection : 0,
        speeduv: csv.speeduv != null ? csv.speeduv : 5,
        power: csv.power != null ? csv.power : 1,
        phase: csv.phase != null ? csv.phase : 0.5,
      });
    }
  }
  return out;
}

// Lê o efeito real "lightshafts" anexado a um objeto shape (scene.json
// objects[].effects[].file terminando em "lightshafts/effect.json") —
// defaults vindos direto dos comentários `// {"material":...,"default":...}`
// do shader real (shaders/effects/lightshafts.frag/.vert). Só suporta o
// caso confirmado contra arquivo real (combos.DIRECTDRAW==1 — desenha
// direto num canvas transparente); qualquer outra combinação (efeito
// aplicado sobre uma textura existente) fica sem suporte por enquanto,
// mesmo padrão de "não adivinha o que não validou" do resto do projeto.
function extractLightShaftsConfig(effects) {
  if (!effects) return null;
  for (const eff of effects) {
    if (!eff.file || !eff.file.endsWith('lightshafts/effect.json')) continue;
    const pass = (eff.passes || [])[0];
    if (!pass) continue;
    const combos = pass.combos || {};
    if (combos.DIRECTDRAW !== 1) return { unsupported: 'DIRECTDRAW!=1 (efeito sobre textura existente, não suportado)' };
    const csv = pass.constantshadervalues || {};
    const vec2 = (s, fallback) => (s ? s.split(' ').map(Number) : fallback);
    const vec3 = (s, fallback) => (s ? s.split(' ').map(Number) : fallback);
    return {
      rayMode: combos.RAYMODE || 0,
      rayCorner: combos.RAYCORNER || 0,
      rendering: combos.RENDERING || 0,
      point0: vec2(csv.point0, [0.67728, 0.01297]),
      point1: vec2(csv.point1, [0.76007, 0.14043]),
      point2: vec2(csv.point2, [0.46654, 1.09592]),
      point3: vec2(csv.point3, [0.16363, 0.44881]),
      speed: csv.rayspeed != null ? csv.rayspeed : 0.2,
      scale: vec2(csv.rayscale, [0.5, 0.1]),
      smoothness: csv.raysmoothness != null ? csv.raysmoothness : 0.75,
      feather: vec2(csv.rayfeather, [0.05, 0.2]),
      radius: csv.rayradius != null ? csv.rayradius : 0.2,
      noiseScale: csv.noisescale != null ? csv.noisescale : 1.0,
      noiseAmount: csv.noiseamount != null ? csv.noiseamount : 0.33,
      intensity: csv.colorwintensity != null ? csv.colorwintensity : 1,
      exponent: csv.colorwexponent != null ? csv.colorwexponent : 1,
      colorStart: vec3(csv.colorastart, [1, 1, 1]),
      colorEnd: vec3(csv.colorend, [0.5, 0.8, 1]),
      startAngle: csv.rayzstartangle != null ? csv.rayzstartangle : 0,
      endAngle: csv.rayzzendangle != null ? csv.rayzzendangle : 1,
    };
  }
  return null;
}

// A single WE particle emitter+system. Reverse-engineered from real
// Workshop particle JSON files (plain human-readable JSON, not a
// proprietary binary format) — every field name/shape below was grounded
// against the user's own real particle files (rain, snow, fire, embers,
// magic, lightning — 55 real definitions across their Workshop cache), not
// guessed from the WE teardown's name list alone.
// Só esses nomes têm implementação de verdade abaixo (ver _spawn/update) —
// qualquer outro valor cai num comportamento genérico aproximado, então vale
// saber exatamente quando isso acontece em vez de só ver o efeito "errado".
const SUPPORTED_PARTICLE_FEATURES = {
  emitter: new Set(['sphererandom', 'boxrandom']),
  initializer: new Set([
    'lifetimerandom', 'sizerandom', 'velocityrandom', 'colorrandom', 'alpharandom',
    'rotationrandom', 'angularvelocityrandom', 'positionoffsetrandom',
  ]),
  operator: new Set([
    'movement', 'alphafade', 'sizechange', 'alphachange', 'colorchange',
    'oscillatealpha', 'oscillateposition', 'oscillatesize', 'angularmovement',
    'capvelocity', 'turbulence',
  ]),
  renderer: new Set(['sprite', 'spritetrail']),
};
function unsupportedParticleFeatures(def) {
  const missing = [];
  for (const [kind, supported] of Object.entries(SUPPORTED_PARTICLE_FEATURES)) {
    for (const entry of def[kind] || []) {
      if (entry.name && !supported.has(entry.name)) missing.push(`${kind}:${entry.name}`);
    }
  }
  return missing;
}

const MAX_TINT_CACHE = 256; // hard cap on cached tinted-sprite canvases per particle system — see _getTintedSprite

class ParticleSystem {
  // colorOverride: [r,g,b] 0-255, from the scene *object's* own
  // instanceoverride.colorn (0-1 normalized in scene.json) — confirmed real
  // on Akame's "Fireflies": the shared particle definition file defaults to
  // green, but each scene that reuses it can retint it per-instance without
  // forking the file. Takes priority over the definition's own colorrandom.
  constructor(sceneDir, def, originX, originY, reportIssue, colorOverride) {
    this.sceneDir = sceneDir;
    this.def = def;
    this.originX = originX;
    this.originY = originY;
    this.reportIssue = reportIssue || (() => {});
    this.colorOverride = colorOverride || null;
    this.particles = [];
    this.spawnAccum = 0;
    this.texture = null; // { img, additive }
    this._tintCanvas = document.createElement('canvas');
    this._tintCache = new Map(); // "r,g,b" -> tinted canvas
  }

  async load() {
    const missing = unsupportedParticleFeatures(this.def);
    if (missing.length) this.reportIssue(`sistema de partículas usa recursos ainda não suportados: ${missing.join(', ')} — aproximado com o comportamento genérico`);
    if (!this.def.material) return;
    this.texture = await loadParticleTexture(this.sceneDir, this.def.material);

    // Real: campo nativo do emissor (não é script) confirmado em
    // "Music Cat"'s Note2 (particles/2_copy1.json) — "audioprocessingbounds/
    // exponent/frequencyend/mode" faz o WE modular a taxa de emissão com o
    // áudio de verdade tocando no sistema. O motor de C++ real não é
    // acessível pra confirmar a semântica exata do "mode" (0-3), então isso é
    // uma aproximação honesta: média das primeiras N bandas do espectro real
    // (N = frequencyend), elevada ao "exponent" e remapeada pro intervalo
    // "bounds" — mesma forma de uso (bounds costuma ficar perto de 1, ex
    // "0.8 1") que resultaria numa modulação sutil de intensidade, não um
    // liga/desliga brusco. Reaproveita o WeAudioEngine já usado pelos scripts
    // (mesma captura real de loopback do desktop), sem duplicar áudio.
    const emitter = (this.def.emitter || [])[0];
    if (emitter && emitter.audioprocessingmode != null) {
      this._audioBuffers = WeAudioEngine.registerBuffers(32);
      this._audioFreqEnd = emitter.audioprocessingfrequencyend != null ? emitter.audioprocessingfrequencyend : this._audioBuffers.average.length;
      this._audioExponent = emitter.audioprocessingexponent != null ? emitter.audioprocessingexponent : 1;
      this._audioBounds = this._vec(emitter.audioprocessingbounds, [0, 1]);
    }
  }

  _audioRateMultiplier() {
    if (!this._audioBuffers) return 1;
    const bins = Math.max(1, Math.min(this._audioBuffers.average.length, Math.round(this._audioFreqEnd)));
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += this._audioBuffers.average[i];
    let level = Math.pow(sum / bins, this._audioExponent);
    return this._audioBounds[0] + level * (this._audioBounds[1] - this._audioBounds[0]);
  }

  _initializer(name) {
    return (this.def.initializer || []).find(i => i.name === name) || null;
  }

  // Alguns operadores (sizechange, colorchange) aparecem MAIS de uma vez no
  // mesmo sistema real (ex: torch.json tem 2 sizechange — um cresce de 0→1
  // nos primeiros 20% da vida, outro encolhe de 1→0.5 depois) — cada
  // instância é um segmento [starttime,endtime] independente.
  _operators(name) {
    return (this.def.operator || []).filter(o => o.name === name);
  }

  _randRange(min, max) {
    if (typeof min === 'string') {
      const a = min.split(' ').map(Number);
      const b = max.split(' ').map(Number);
      return a.map((v, i) => v + Math.random() * ((b[i] !== undefined ? b[i] : v) - v));
    }
    return min + Math.random() * (max - min);
  }

  _vec(v, fallback) {
    if (v == null) return fallback;
    if (Array.isArray(v)) return v;
    return typeof v === 'string' ? v.split(' ').map(Number) : [v, v, v];
  }

  _spawn() {
    const emitter = (this.def.emitter || [])[0];
    let x = this.originX, y = this.originY;
    if (emitter && emitter.name === 'boxrandom') {
      // Confirmado real (rain_screen_4k.json): "distancemax" é a caixa
      // inteira (largura/altura), centrada no "origin" do emissor — sem
      // "distancemin" nesses arquivos reais, então assume caixa cheia.
      const box = this._vec(emitter.distancemax, [400, 400, 0]);
      const off = this._vec(emitter.origin, [0, 0, 0]);
      x += off[0] + (Math.random() - 0.5) * box[0];
      y += off[1] + (Math.random() - 0.5) * box[1];
    } else if (emitter && emitter.name === 'sphererandom') {
      const dmin = emitter.distancemin || 0;
      const dmax = emitter.distancemax != null ? emitter.distancemax : dmin + 100;
      const dist = dmin + Math.random() * (dmax - dmin);
      const angle = Math.random() * Math.PI * 2;
      // "directions" (confirmado em snowperspective.json) escala o raio por
      // eixo antes da distância — ex: "1 0.03 1" achata quase tudo pro plano
      // horizontal (neve caindo de uma faixa, não de uma esfera cheia).
      const dir = this._vec(emitter.directions, [1, 1, 1]);
      const off = this._vec(emitter.origin, [0, 0, 0]);
      x += off[0] + Math.cos(angle) * dir[0] * dist;
      y += off[1] + Math.sin(angle) * dir[1] * dist;
    } else {
      // Emitter type we don't specifically model yet — spread particles
      // around the origin rather than stacking them all on one point.
      x += (Math.random() - 0.5) * 400;
      y += (Math.random() - 0.5) * 400;
    }

    const life  = this._initializer('lifetimerandom');
    const size  = this._initializer('sizerandom');
    const vel   = this._initializer('velocityrandom');
    const color = this._initializer('colorrandom');
    const alpha = this._initializer('alpharandom');
    const rot   = this._initializer('rotationrandom');
    const angVel = this._initializer('angularvelocityrandom');
    const posOff = this._initializer('positionoffsetrandom');

    const lifeVal  = life  ? this._randRange(life.min, life.max)  : 3;
    const sizeVal  = size  ? this._randRange(size.min, size.max)  : 32;
    const velVal   = vel   ? this._randRange(vel.min, vel.max)    : [0, 0, 0];
    const colorVal = this.colorOverride || (color ? this._randRange(color.min, color.max) : [255, 255, 255]);
    const alphaVal = alpha ? this._randRange(alpha.min, alpha.max) : 1;
    const rotVal   = rot   ? this._randRange(rot.min, rot.max) : 0;
    const angVelVal = angVel ? this._randRange(angVel.min, angVel.max) : 0;

    if (posOff) {
      const offVal = this._randRange(posOff.min, posOff.max);
      x += offVal[0] || 0;
      y -= offVal[1] || 0; // mesma inversão de eixo Y que o resto da cena
    }

    this.particles.push({
      x, y,
      // WE's coordinate space has Y increasing upward (see WeScene's own
      // note on _screenTop) — flip vertical velocity for screen space.
      vx: velVal[0], vy: -velVal[1],
      size: sizeVal, baseSize: sizeVal, life: lifeVal, age: 0,
      color: colorVal, baseColor: colorVal, baseAlpha: Math.max(0, Math.min(1, alphaVal)),
      alpha: 1,
      rotation: (rotVal * Math.PI) / 180,
      angularVelocity: (angVelVal * Math.PI) / 180,
      turbulencePhase: Math.random() * Math.PI * 2,
    });
  }

  // Aplica um segmento de troca linear ao longo da vida (sizechange,
  // colorchange, alphachange) — todos os 3 compartilham a mesma forma real:
  // {starttime, startvalue, endtime, endvalue}, tempos em fração 0-1 da
  // vida, valores default sensatos quando ausentes (visto em torch.json,
  // wildfire.json, thunderbolt.json).
  _applyChangeOps(ops, progress, base, defaultStart, defaultEnd) {
    let result = base;
    for (const op of ops) {
      const t0 = op.starttime != null ? op.starttime : 0;
      const t1 = op.endtime != null ? op.endtime : 1;
      const v0 = op.startvalue != null ? op.startvalue : defaultStart;
      const v1 = op.endvalue != null ? op.endvalue : defaultEnd;
      if (progress < t0) continue;
      const frac = t1 > t0 ? Math.min(1, (progress - t0) / (t1 - t0)) : 1;
      if (Array.isArray(v0)) {
        const a = this._vec(v0), b = this._vec(v1);
        result = a.map((v, i) => v + (b[i] - v) * frac);
      } else {
        result = v0 + (v1 - v0) * frac;
      }
    }
    return result;
  }

  update(dt) {
    const emitter = (this.def.emitter || [])[0];
    const rate = (emitter && emitter.rate ? emitter.rate : 5) * this._audioRateMultiplier();
    const maxCount = this.def.maxcount || 20;

    this.spawnAccum += rate * dt;
    while (this.spawnAccum >= 1 && this.particles.length < maxCount) {
      this._spawn();
      this.spawnAccum -= 1;
    }

    const fadeOp = (this.def.operator || []).find(o => o.name === 'alphafade');
    const fadeOutTime = fadeOp && fadeOp.fadeouttime ? fadeOp.fadeouttime : 0.5;
    const fadeInTime  = fadeOp && fadeOp.fadeintime  ? fadeOp.fadeintime  : 0;
    const sizeOps  = this._operators('sizechange');
    const colorOps = this._operators('colorchange');
    const alphaOps = this._operators('alphachange');
    const oscAlpha = this._operators('oscillatealpha')[0];
    const oscPos   = this._operators('oscillateposition')[0];
    const oscSize  = this._operators('oscillatesize')[0];
    const turbulence = this._operators('turbulence')[0];
    const capVel = this._operators('capvelocity')[0];

    this._time = (this._time || 0) + dt;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) { this.particles.splice(i, 1); continue; }

      // Aproximação: sem ruído simplex/fbm de verdade (o real WE usa esses
      // pra "turbulence"/"remapvalue"), então isso é um passeio pseudo-
      // aleatório suave em vez do ruído coerente original — visualmente
      // parecido (faísca/chama tremendo), não pixel-a-pixel idêntico.
      if (turbulence) {
        const mask = this._vec(turbulence.mask, [1, 1, 0]);
        const speed = turbulence.speedmin != null
          ? turbulence.speedmin + Math.random() * ((turbulence.speedmax || turbulence.speedmin) - turbulence.speedmin)
          : 50;
        const scale = turbulence.scale != null ? turbulence.scale : 0.05;
        p.turbulencePhase += dt * speed * scale;
        p.vx += Math.sin(p.turbulencePhase) * speed * scale * mask[0] * dt;
        p.vy += Math.cos(p.turbulencePhase * 1.3) * speed * scale * mask[1] * dt;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.angularVelocity * dt;

      if (capVel) {
        const max = capVel.max != null ? capVel.max : capVel.velocity;
        if (max != null) {
          const speed = Math.hypot(p.vx, p.vy);
          if (speed > max) { p.vx = (p.vx / speed) * max; p.vy = (p.vy / speed) * max; }
        }
      }

      const progress = p.age / p.life;
      // sizechange's start/endvalue são multiplicadores do tamanho base (0 a
      // 1ish — visto em torch.json: 0→1 nos primeiros 20% da vida, depois
      // 1→0.5), não pixels absolutos — default é 1 (tamanho original) até 0
      // (encolhe até sumir) quando o operador não especifica valores.
      const sizeMul = sizeOps.length ? this._applyChangeOps(sizeOps, progress, 1, 1, 0) : 1;
      p.size = p.baseSize * sizeMul;
      // colorchange's start/endvalue são normalizados 0-1 (visto em
      // torch.json: "1 0 0"), diferente de colorrandom que já usa 0-255 —
      // escala pra manter a mesma convenção interna antes de interpolar.
      if (colorOps.length) {
        const scaledOps = colorOps.map(op => ({
          ...op,
          startvalue: op.startvalue != null ? this._vec(op.startvalue).map(v => v * 255) : undefined,
          endvalue: op.endvalue != null ? this._vec(op.endvalue).map(v => v * 255) : undefined,
        }));
        p.color = this._applyChangeOps(scaledOps, progress, p.baseColor, p.baseColor, p.baseColor);
      }

      let alphaMul = 1;
      if (alphaOps.length) alphaMul = this._applyChangeOps(alphaOps, progress, 1, 1, 0);
      const remainOut = p.life - p.age;
      if (remainOut < fadeOutTime) alphaMul *= Math.max(0, remainOut / fadeOutTime);
      if (fadeInTime > 0 && p.age < fadeInTime) alphaMul *= Math.max(0, p.age / fadeInTime);

      if (oscAlpha) {
        const freq = oscAlpha.frequencymin != null ? oscAlpha.frequencymin : 1;
        const scale = oscAlpha.scalemin != null ? oscAlpha.scalemin : 0.3;
        alphaMul *= 1 - Math.abs(Math.sin(this._time * freq + p.turbulencePhase)) * scale;
      }
      p.alpha = p.baseAlpha * Math.max(0, Math.min(1, alphaMul));

      if (oscSize) {
        const freq = oscSize.frequencymin != null ? oscSize.frequencymin : 1;
        const scaleMin = oscSize.scalemin != null ? oscSize.scalemin : 0;
        const scaleMax = oscSize.scalemax != null ? oscSize.scalemax : scaleMin + 10;
        p.size += (scaleMin + (Math.sin(this._time * freq + p.turbulencePhase) * 0.5 + 0.5) * (scaleMax - scaleMin));
      }

      if (oscPos) {
        const mask = this._vec(oscPos.mask, [1, 1, 0]);
        const freq = oscPos.frequencymin != null ? oscPos.frequencymin : 1;
        const scaleMin = oscPos.scalemin != null ? oscPos.scalemin : 0;
        const scaleMax = oscPos.scalemax != null ? oscPos.scalemax : scaleMin;
        const amp = scaleMin + Math.random() * 0; // sem ruído de fase real por partícula — usa scalemin como amplitude base
        const wobble = Math.sin(this._time * freq + p.turbulencePhase) * ((scaleMax + scaleMin) / 2 || amp);
        p.oscX = wobble * mask[0];
        p.oscY = wobble * mask[1];
      }
    }
  }

  // WE particle textures are typically a white/grayscale glow shape carrying
  // the alpha, tinted per-particle by `colorrandom` — replicate that with a
  // `source-atop` composite (colors every already-opaque pixel, keeps alpha).
  //
  // Colors are quantized in steps of 8 (not 1) before caching: effects that
  // use `colorchange` (fire, torches, embers...) recompute p.color every
  // single frame as it interpolates smoothly across the particle's life, so
  // a per-integer-value cache key kept minting a brand-new canvas almost
  // every frame, forever, for as long as the wallpaper stayed on — an
  // unbounded leak that took hours to visibly balloon RAM (real incident:
  // froze the whole PC despite 28GB). Coarser steps collapse that into a
  // small, stable set of buckets; MAX_TINT_CACHE is a hard backstop in case
  // some scene still produces more distinct buckets than expected.
  _getTintedSprite(color) {
    const q = 8;
    const key = `${Math.round(color[0] / q) * q},${Math.round(color[1] / q) * q},${Math.round(color[2] / q) * q}`;
    let cached = this._tintCache.get(key);
    if (cached) return cached;
    const img = this.texture.img;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const cctx = c.getContext('2d');
    cctx.drawImage(img, 0, 0);
    cctx.globalCompositeOperation = 'source-atop';
    cctx.fillStyle = `rgb(${key})`;
    cctx.fillRect(0, 0, c.width, c.height);
    if (this._tintCache.size >= MAX_TINT_CACHE) {
      this._tintCache.delete(this._tintCache.keys().next().value); // FIFO: descarta o mais antigo
    }
    this._tintCache.set(key, c);
    return c;
  }

  render(ctx) {
    if (!this.texture || !this.particles.length) return;
    const renderer = (this.def.renderer || [])[0];
    const isTrail = renderer && renderer.name === 'spritetrail';
    const grid = this.texture.grid;
    ctx.globalCompositeOperation = this.texture.additive ? 'lighter' : 'source-over';
    for (const p of this.particles) {
      const sprite = this._getTintedSprite(p.color);
      ctx.globalAlpha = p.alpha;
      const px = p.x + (p.oscX || 0), py = p.y + (p.oscY || 0);

      // Sprites que são grades de animação (fogo, faísca, fumaça...)
      // escolhem 1 quadro com base em quanto da vida da partícula já
      // passou — mesma lógica do ComputeSpriteFrame() real (currentFrame =
      // floor(progress * numFrames), ver detectSpriteGrid), só sem o
      // blend entre 2 quadros consecutivos que o shader real faz.
      let sx = 0, sy = 0, sw = sprite.width, sh = sprite.height;
      if (grid) {
        const progress = Math.min(0.999, p.age / p.life);
        const frameIdx = Math.min(grid.totalFrames - 1, Math.floor(progress * grid.totalFrames));
        sw = sprite.width / grid.cols;
        sh = sprite.height / grid.rows;
        sx = (frameIdx % grid.cols) * sw;
        sy = Math.floor(frameIdx / grid.cols) * sh;
      }

      if (isTrail) {
        // Alonga o sprite na direção do movimento — aproximação comum pra
        // chuva/faísca (o renderer real usa um comprimento de rastro
        // baseado em "length"/velocidade; aqui usamos a velocidade atual
        // escalada, sem os campos min/maxlength exatos do WE).
        const speed = Math.hypot(p.vx, p.vy);
        const stretch = 1 + Math.min(3, speed * (renderer.length || 0.01));
        const angle = Math.atan2(-p.vy, p.vx); // -vy: espaço de tela é Y-down
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(angle);
        ctx.drawImage(sprite, sx, sy, sw, sh, -p.size / 2, -(p.size * stretch) / 2, p.size, p.size * stretch);
        ctx.restore();
      } else if (p.rotation) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(p.rotation);
        ctx.drawImage(sprite, sx, sy, sw, sh, -p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        ctx.drawImage(sprite, sx, sy, sw, sh, px - p.size / 2, py - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

class WeScene {
  constructor(container, sceneDir, overrides, propValues, label) {
    this.container = container;
    this.sceneDir = sceneDir;
    this.label = label || path.basename(sceneDir);
    this.overrides = overrides || {};     // user-adjusted { [objName]: { origin, fontSize } }
    this.propValues = propValues || {};   // effective General Properties values (options over defaults)
    this.timer = null;
    this.fontFamilies = new Map(); // relative font path -> CSS family name
    this.textEntries = [];         // { el, objName, w, h, fontSize, updateFn, value }
    this.particleSystems = [];
    this._particleRafId = null;
    this._foliageRafHolders = [];
    this._lastFrameTime = null;
    this._resizeHandler = null;
    this._currentScale = 1;
    this.editing = false;

    // Posição real do cursor (ver setInterval de 'cursor-position' em
    // main.js) — normalizada 0-1 relativa à janela inteira, não ao stage.
    // Usada pelos efeitos interativos reais (xray, depthparallax).
    this._cursor = { x: 0.5, y: 0.5, inBounds: false };
    ipcRenderer.on('cursor-position', (_e, data) => {
      this._cursor = data;
      // Real `input.cursorWorldPosition`/`cursorScreenPosition` — mesmo
      // dado, só convertido pro espaço de design da cena.
      WE_INPUT.cursorScreenPosition.x = data.x * window.innerWidth;
      WE_INPUT.cursorScreenPosition.y = data.y * window.innerHeight;
      const stagePos = this._normalizedToStagePos(data.x, data.y);
      if (stagePos) { WE_INPUT.cursorWorldPosition.x = stagePos.x; WE_INPUT.cursorWorldPosition.y = stagePos.y; }
    });
    ipcRenderer.on('cursor-button', (_e, data) => { WE_INPUT.cursorLeftDown = !!data.down; });

    // Cliques reais no wallpaper (ver broadcast de 'cursor-click' em
    // main.js, via uiohook — a janela é sempre click-through, então isso é
    // a única forma de saber que houve um clique de verdade). Cada entrada
    // registrada por _wireObjectInteractivity vira um alvo de hit-test.
    this._clickTargets = [];
    ipcRenderer.on('cursor-click', (_e, data) => this._handleCursorClick(data));

    // Integração real de media (ver scripts/media-session-poll.ps1 +
    // main.js) — confirmado ao vivo 2026-07-18 contra o YouTube de verdade
    // rodando no Chrome do usuário (título/artista/status de reprodução
    // reais). Dispara mediaPropertiesChanged/mediaPlaybackChanged de
    // verdade pra todo script registrado, e reaplica visibilidade no DOM
    // (mesmo mecanismo já usado pelos cliques).
    this._mediaState = { hasSession: false, playbackStatus: 0 };
    ipcRenderer.on('media-session-update', (_e, data) => this._handleMediaSessionUpdate(data));
  }

  _handleMediaSessionUpdate(data) {
    const prevStatus = this._mediaState.playbackStatus;
    const prevTitle = this._mediaState.title;
    this._mediaState = data;

    if (data.hasSession && data.title !== prevTitle) {
      const propsEvent = { title: data.title || '', artist: data.artist || '', subTitle: '', albumTitle: data.albumTitle || '', albumArtist: '', genres: '', contentType: '' };
      for (const target of this._clickTargets) {
        for (const s of target.scripts) s.dispatchCursorEvent('mediaPropertiesChanged', propsEvent);
      }
    }
    if (data.hasSession && data.playbackStatus !== prevStatus) {
      const playEvent = { state: data.playbackStatus };
      for (const target of this._clickTargets) {
        for (const s of target.scripts) s.dispatchCursorEvent('mediaPlaybackChanged', playEvent);
      }
    }
    for (const target of this._clickTargets) target.applyLayerToDom();
  }

  // Mesma conversão de _getCursorStagePos, mas pra uma posição normalizada
  // qualquer (0-1 relativa à janela) em vez de sempre ler this._cursor —
  // reaproveitado tanto pelo polling de posição quanto pelo clique real.
  _normalizedToStagePos(nx, ny) {
    if (!this.stage) return null;
    const stageRect = this.stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return null;
    const winX = nx * window.innerWidth;
    const winY = ny * window.innerHeight;
    return {
      x: (winX - stageRect.left) / stageRect.width * this.designWidth,
      y: (winY - stageRect.top) / stageRect.height * this.designHeight,
    };
  }

  // Testa o clique real contra cada objeto registrado com script de cursor
  // (ver _wireObjectInteractivity) e despacha cursorDown+cursorClick real
  // pro(s) script(s) daquele objeto — real: um clique nosso mapeia pros dois
  // de uma vez, já que não distinguimos press/release/drag ainda (limitação
  // honesta, não simulamos cursorUp separado).
  _handleCursorClick(data) {
    const pos = this._normalizedToStagePos(data.x, data.y);
    if (!pos) return;
    for (const target of this._clickTargets) {
      const localX = pos.x - target.left, localY = pos.y - target.top;
      if (localX < 0 || localX > target.w || localY < 0 || localY > target.h) continue;
      const worldPosition = new Vec3(pos.x, pos.y, 0);
      const localPosition = new Vec3(localX - target.w / 2, localY - target.h / 2, 0);
      const cursorEvent = new CursorEvent(worldPosition, localPosition);
      for (const scriptEntry of target.scripts) {
        scriptEntry.dispatchCursorEvent('cursorDown', cursorEvent);
        scriptEntry.dispatchCursorEvent('cursorClick', cursorEvent);
      }
      target.applyLayerToDom();
    }
  }

  // Compila qualquer script real anexado a um campo do OBJETO (não de um
  // efeito) que exporte handler de cursor/mídia (visible/origin/angles/
  // scale/alpha/color — confirmado real: "pausa"/"playing"/"avanti"/
  // "indietro", os botões do media player, têm cursorDown numa dessas).
  // Todos os scripts do MESMO objeto compartilham um único LayerHandle —
  // real: `thisLayer` é o objeto inteiro, não uma cópia por propriedade, um
  // handler mexendo em thisLayer.visible precisa valer pros outros também.
  _wireObjectInteractivity(obj, el, w, h, left, top) {
    const fields = ['visible', 'origin', 'angles', 'scale', 'alpha', 'color'];
    let sharedLayer = null;
    const exportsList = [];
    for (const field of fields) {
      const raw = obj[field];
      if (!(raw && typeof raw === 'object' && typeof raw.script === 'string')) continue;
      if (!sharedLayer) sharedLayer = new LayerHandle({ visible: this._isVisible(obj) });
      try {
        const exports = compileWEScript(raw.script)(sharedLayer);
        const isInteractive = exports.cursorDown || exports.cursorUp || exports.cursorClick
          || exports.cursorMove || exports.cursorEnter || exports.cursorLeave
          || exports.mediaPlaybackChanged || exports.mediaThumbnailChanged || exports.mediaPropertiesChanged;
        if (isInteractive) exportsList.push(exports);
      } catch (err) {
        // script real quebrado/não suportado nesse campo — ignora só ele, resto do objeto continua normal
      }
    }
    if (!exportsList.length) return;

    const applyLayerToDom = () => { el.style.display = sharedLayer.visible ? '' : 'none'; };
    applyLayerToDom();
    this._clickTargets.push({
      left, top, w, h, applyLayerToDom,
      scripts: exportsList.map((exports) => ({
        dispatchCursorEvent: (name, ev) => {
          if (typeof exports[name] !== 'function') return;
          try { exports[name](ev); } catch (err) { /* desiste desse handler específico, não da cena */ }
        },
      })),
    });
  }

  _reportIssue(message) {
    reportSceneIssue(this.label, message);
  }

  // Converte a posição normalizada do cursor (relativa à janela inteira)
  // pra coordenada no espaço do stage (mesma unidade de design usada pelos
  // "left"/"top" dos objetos, ex.: obj = ox - w/2) — usa
  // getBoundingClientRect() do próprio stage em vez de tentar recalcular a
  // transformação CSS na mão, então funciona certo com qualquer
  // escala/letterbox que _layout() já aplicou.
  _getCursorStagePos() {
    if (!this._cursor || !this.stage) return null;
    const stageRect = this.stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return null;
    const winX = this._cursor.x * window.innerWidth;
    const winY = this._cursor.y * window.innerHeight;
    return {
      x: (winX - stageRect.left) / stageRect.width * this.designWidth,
      y: (winY - stageRect.top) / stageRect.height * this.designHeight,
    };
  }

  start() {
    const scenePath = path.join(this.sceneDir, 'scene.json');
    const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));

    const proj = (scene.general && scene.general.orthogonalprojection) || {};
    this.designWidth  = proj.width  || 1920;
    this.designHeight = proj.height || 1080;

    // Confirmado real (3763428294 e 3763483939's scene.json): objetos com
    // "parent": <id> têm "origin" RELATIVO ao pai, não absoluto — os filhos
    // reais encontrados são exatamente Clock/Day/Date (offsets tipo "1.7
    // -17.6", que só fazem sentido somados à posição do pai). Sem isso, esse
    // texto renderiza na posição errada. Ver _resolveOrigin.
    this.objectsById = new Map();
    for (const obj of scene.objects || []) {
      if (obj.id != null) this.objectsById.set(obj.id, obj);
    }

    this.stage = document.createElement('div');
    this.stage.style.cssText = `position:absolute; top:0; left:0; width:${this.designWidth}px; height:${this.designHeight}px; transform-origin: 0 0; overflow:hidden; background:#000;`;
    this.container.innerHTML = '';
    this.container.appendChild(this.stage);

    // O primeiro objeto de imagem da lista é, por convenção do formato, o
    // fundo (cobre a tela toda). As demais camadas de imagem são desenhadas
    // também, na ordem do array (cada uma por cima da anterior) — cenas com
    // várias camadas do mesmo tamanho/posição do fundo costumam ser recortes
    // com transparência de verdade que formam a arte completa junto com o
    // fundo, não elementos soltos posicionados por conta própria.
    const imageObjects = (scene.objects || []).filter(o => o.image);
    const backgroundObj = imageObjects[0] || null;
    // true a menos que o fundo exista, esteja visível agora e falhe ao renderizar
    let backgroundRendered = true;
    for (const obj of scene.objects || []) {
      const isBackground = obj === backgroundObj;
      // Visibilidade script-driven (thisLayer.visible mudado por
      // cursorDown/mediaPlaybackChanged real — ver _wireObjectInteractivity)
      // não pode ser decidida uma vez só aqui: o objeto precisa existir no
      // DOM pra poder aparecer/sumir depois de um clique real.
      const visibleIsScripted = obj.visible && typeof obj.visible === 'object' && typeof obj.visible.script === 'string';
      if (!visibleIsScripted && !this._isVisible(obj)) {
        continue; // escondido de propósito (ex: alternância dia/noite) — não conta como falha
      }
      try {
        if (obj.image) {
          const rendered = this._buildImageObject(obj);
          if (isBackground) backgroundRendered = rendered;
          else if (!rendered) this._reportIssue(`camada "${obj.name}" não pôde ser desenhada (textura não resolvida)`);
        } else if (obj.text) this._buildTextObject(obj);
        else if (obj.shape) this._buildShapeObject(obj);
      } catch (err) {
        if (isBackground) backgroundRendered = false;
        this._reportIssue(`objeto "${obj.name}" pulado: ${err.message}`);
      }
    }

    // Nem sempre um .tex embute um formato de imagem que já sabemos decodificar
    // (ex: sequências de frames comprimidas de outro jeito) — isso já causou
    // tela preta (fundo ausente) e cenas pela metade (fundo ausente mas
    // camadas menores presentes). Se especificamente o fundo não carregou,
    // trata como falha real — quem chama volta pro preview estático.
    if (!backgroundRendered) {
      throw new Error(`Textura de fundo "${backgroundObj.name}" não pôde ser decodificada (formato de .tex não suportado).`);
    }

    this._setupParticles(scene);

    this._applyScale();
    this._resizeHandler = () => this._applyScale();
    window.addEventListener('resize', this._resizeHandler);

    this._tick();
    this.timer = setInterval(() => this._tick(), 1000);
  }

  _setupParticles(scene) {
    const particleObjs = (scene.objects || []).filter(o => o.particle && this._isVisible(o));
    if (!particleObjs.length) return;

    this.particleCanvas = document.createElement('canvas');
    this.particleCanvas.width = this.designWidth;
    this.particleCanvas.height = this.designHeight;
    this.particleCanvas.style.cssText = `position:absolute; top:0; left:0; width:${this.designWidth}px; height:${this.designHeight}px; pointer-events:none;`;
    this.stage.appendChild(this.particleCanvas);
    this.particleCtx = this.particleCanvas.getContext('2d');

    for (const obj of particleObjs) {
      const [ox, oy] = this._resolveOrigin(obj);
      // Partículas usam o mesmo espaço de coordenadas dos outros objetos —
      // mesma inversão de eixo Y (ver _screenTop).
      const screenX = ox;
      const screenY = this.designHeight - oy;
      try {
        const particlePath = path.join(this.sceneDir, obj.particle);
        if (!fs.existsSync(particlePath)) continue;
        const def = JSON.parse(fs.readFileSync(particlePath, 'utf8'));
        // scene.json pode reusar o mesmo arquivo de partícula em vários
        // objetos e sobrescrever a cor por instância (0-1 normalizado, ao
        // contrário do 0-255 usado dentro do próprio arquivo de partícula).
        const overrideColorn = obj.instanceoverride && obj.instanceoverride.colorn;
        const colorOverride = overrideColorn ? overrideColorn.split(' ').map(v => Number(v) * 255) : null;
        const system = new ParticleSystem(this.sceneDir, def, screenX, screenY, (msg) => this._reportIssue(`partículas "${obj.name}": ${msg}`), colorOverride);
        system.load(); // async, fire-and-forget — starts rendering once the sprite is ready
        this.particleSystems.push(system);
      } catch (err) {
        this._reportIssue(`sistema de partículas "${obj.name}" falhou ao carregar: ${err.message}`);
      }
    }

    if (this.particleSystems.length) {
      this._lastFrameTime = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.1, (now - this._lastFrameTime) / 1000);
        this._lastFrameTime = now;
        this.particleCtx.clearRect(0, 0, this.designWidth, this.designHeight);
        for (const system of this.particleSystems) {
          system.update(dt);
          system.render(this.particleCtx);
        }
        this._particleRafId = requestAnimationFrame(loop);
      };
      this._particleRafId = requestAnimationFrame(loop);
    }
  }

  // WE binds an object's visibility to a General Property in scene.json as:
  //   { user: "propName", value: true }                          — visible when that (boolean) property is truthy
  //   { user: { name: "propName", condition: "2" }, value: ... }  — visible when that (combo) property equals "2"
  // This is the common mechanism behind day/night switches, background-type
  // toggles, and show/hide sections in Workshop scenes — reverse-engineered
  // from real files, no official spec. A `visible` that's a script (rare,
  // seen obfuscated on at least one real object) can't be safely evaluated
  // generically yet, so those objects default to visible rather than risk
  // hiding something needed.
  _isVisible(obj) {
    const v = obj.visible;
    if (v === undefined || v === true) return true;
    if (v === false) return false;
    if (typeof v === 'object') {
      if (v.script) return true;
      // Descoberta real 2026-07-18 ("Music Cat"'s "Color", com 3 efeitos
      // tint HUE/B&W/Rainbow, cada um gated por uma property "mode"/"blend"
      // que NÃO aparece em nenhum lugar — nem scene.general.properties, nem
      // project.json — provavelmente escopada localmente ao efeito, algo
      // que ainda não sabemos ler. Sem isso em `this.propValues`, a
      // comparação virava sempre falso (undefined !== qualquer condição),
      // escondendo os 3 de uma vez. Cai pro `.value` CONGELADO (o estado
      // resolvido que a própria WE salvou) quando a property referenciada
      // nem existe em propValues — mesma filosofia de honestidade de
      // sempre, em vez de assumir "escondido" por padrão.
      if (typeof v.user === 'string') {
        return v.user in this.propValues ? !!this.propValues[v.user] : (v.value !== false);
      }
      if (v.user && typeof v.user === 'object' && v.user.name) {
        if (v.user.name in this.propValues) {
          return String(this.propValues[v.user.name]) === String(v.user.condition);
        }
        return v.value !== false;
      }
    }
    return true;
  }

  _applyScale() {
    const scale = Math.max(window.innerWidth / this.designWidth, window.innerHeight / this.designHeight);
    this._currentScale = scale;
    const offsetX = (window.innerWidth  - this.designWidth  * scale) / 2;
    const offsetY = (window.innerHeight - this.designHeight * scale) / 2;
    this.stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  }

  // object.image -> "models/<id>.json" -> .material -> "materials/<id>.json"
  // -> .passes[0].textures[0] -> texture id -> materials/<id>.tex.png
  _resolveObjectTexturePng(obj) {
    const modelPath = path.join(this.sceneDir, obj.image);
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    return this._resolveMaterialTexturePng(model);
  }

  // Retorna `{ src }` pronto pra jogar direto num `<img>.src` (ou `null` se
  // não deu pra resolver de jeito nenhum) — nunca mais uma string de path
  // pura, porque o fallback pro stock global (abaixo) devolve um data URL,
  // não um arquivo.
  _resolveMaterialTexturePng(model) {
    // O PRÓPRIO arquivo de material (não só a textura que ele referencia)
    // pode ser um asset de estoque da WE não empacotado nessa cena — real,
    // confirmado 2026-07-18: "Music Visualizer" referencia
    // materials/util/solidlayer_instance_4.json (uma de várias variantes
    // "solid layer" prontas que a própria instalação da WE fornece pra
    // qualquer cena usar sem reempacotar sua própria cópia). Sem esse
    // fallback, ler `model.material` local dava ENOENT antes até de chegar
    // no fallback de textura já existente logo abaixo.
    let materialPath = path.join(this.sceneDir, model.material);
    if (!fs.existsSync(materialPath)) {
      const weAssets = getWEAssetsRoot();
      if (!weAssets) return null;
      const globalMaterialPath = path.join(weAssets, model.material);
      if (!fs.existsSync(globalMaterialPath)) return null;
      materialPath = globalMaterialPath;
    }
    const material = JSON.parse(fs.readFileSync(materialPath, 'utf8'));
    const pass0 = material.passes && material.passes[0];
    const texId = pass0 && pass0.textures && pass0.textures[0];
    // Real "SPRITESHEET" combo (confirmado 2026-07-19, "Music Cat"'s "Base" —
    // gato animado, textura "ezgif.com-gif-maker.tex", combo real
    // `"spritesheet":1` no material.json + `#if SPRITESHEET` real no
    // genericimage2.vert local da instalação da WE, usando g_Texture0Translation/
    // g_Texture0Rotation pra escolher o quadro). Repassado pro chamador junto
    // do resultado — quem monta o objeto decide como recortar/animar.
    const spritesheet = !!(pass0 && pass0.combos && pass0.combos.spritesheet);
    // "_rt_*" é um render target interno da WE (ex.: "_rt_FullFrameBuffer" —
    // "tudo que já foi desenhado até agora"), nunca um arquivo de verdade —
    // confirmado real 2026-07-18 ("Music Cat"'s objeto "Color", que só serve
    // pra recompor a tela com um efeito tint arco-íris por cima). Sem uma
    // superfície WebGL única pra tela inteira (o renderer é DOM), não dá pra
    // capturar "tudo desenhado até agora" de verdade — mesma limitação já
    // documentada no Bloom. Marcado à parte pra quem chama tentar uma
    // aproximação (ver _buildFullFrameBufferObject) em vez de só falhar.
    if (typeof texId === 'string' && texId.startsWith('_rt_')) {
      return { fullFrameBuffer: true };
    }
    if (!texId) {
      // Descoberta real (2026-07-18, "Music Visualizer"'s "BG Color 2
      // (Primary)"): nem todo material tem textura NENHUMA — o shader
      // "flat" (materials/util/solidlayer.json real) não declara
      // "textures" de jeito nenhum, porque a cor inteira vem de obj.color.
      // Isso NÃO é falha de resolução — é um objeto legitimamente sem
      // imagem, só cor sólida. `flat:true` avisa o chamador pra desenhar
      // um retângulo de cor em vez de tentar carregar uma <img>.
      return { flat: true };
    }

    const localPngPath = path.join(this.sceneDir, 'materials', texId + '.tex.png');
    if (fs.existsSync(localPngPath)) {
      return { src: 'file:///' + localPngPath.replace(/\\/g, '/'), spritesheet };
    }

    // Descoberta real (2026-07-18, "Music Visualizer"): nem todo texId
    // referenciado por um objeto da cena vem empacotado dentro do próprio
    // scene.pkg — texturas de estoque da própria instalação da WE (ex.:
    // "util/white", usado como "tela em branco" pra pintar via a cor do
    // objeto) ficam de fora do pacote e só existem na pasta global
    // materials/ da instalação. Sem esse fallback, QUALQUER objeto que use
    // uma textura de estoque falha silenciosamente (e se for o objeto
    // escolhido como "fundo", derruba a cena inteira pro preview estático —
    // foi exatamente o que aconteceu aqui).
    const weAssets = getWEAssetsRoot();
    if (!weAssets) return null;
    const stockTexPath = path.join(weAssets, 'materials', texId + '.tex');
    if (!fs.existsSync(stockTexPath)) return null;
    const png = decodeTexToPng(fs.readFileSync(stockTexPath));
    if (png) return { src: 'data:image/png;base64,' + png.toString('base64'), spritesheet };

    // "util/white" especificamente já é um caso conhecido (ver
    // _createSolidWhiteTexture): nosso decodificador de .tex não entende o
    // formato real desse arquivo específico, mas ele é sempre e
    // exclusivamente branco sólido — sintetizar isso é seguro (mesmo
    // precedente já usado em blendgradient/xray). Pra qualquer outra
    // textura de estoque que falhe, não inventamos cor nenhuma.
    if (texId.toLowerCase() === 'util/white') {
      // 1x1 branco RGBA opaco de verdade — gerado e reconferido byte-exato
      // (decodificado de volta, confirma filter=0 + R,G,B,A = 255,255,255,255)
      // antes de colar aqui, não um base64 de memória.
      return { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==' };
    }
    return null;
  }

  // Anima um <img> real SPRITESHEET (ver nota em _resolveMaterialTexturePng)
  // recortando um quadro por vez via left/top negativos dentro de um
  // wrapper overflow:hidden do tamanho de exibição do objeto (w x h).
  // Tamanho da célula = w/h do PRÓPRIO objeto (obj.size) — confirmado
  // byte-exato contra "Music Cat"'s Base (textura 4096x2048, obj.size
  // "800 600": análise de blobs de conteúdo real na imagem decodificada deu
  // pitch de coluna ~796px e de linha exatamente 600px, batendo com 800x600,
  // não um valor inventado). Isso funciona quando o autor exportou a
  // spritesheet 1:1 com o tamanho de exibição (o caso confirmado) — pode não
  // valer pra uma cena que reescale o objeto de um jeito diferente do
  // tamanho nativo da textura, mas não há NENHUM metadado real de
  // linhas/colunas/fps em lugar acessível (scene.json/material.json/
  // model.json/header do .tex — todos checados) pra fazer melhor que isso.
  // FPS também não é recuperável (não fica salvo em lugar nenhum acessível)
  // — 10fps é uma aproximação honesta pra um loop de animação simples, não
  // um valor lido de arquivo.
  _startSpriteSheetAnimation(img, w, h) {
    const cols = Math.max(1, Math.round(img.naturalWidth / w));
    const rows = Math.max(1, Math.round(img.naturalHeight / h));
    img.style.width = `${cols * w}px`;
    img.style.height = `${rows * h}px`;
    const totalFrames = cols * rows;
    if (totalFrames <= 1) return; // grade não detectada — mantém o quadro único parado
    const FRAME_DURATION = 1 / 10;
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    let acc = 0, frame = 0, lastTime = performance.now();
    const loop = () => {
      const now = performance.now();
      acc += Math.min(0.25, (now - lastTime) / 1000);
      lastTime = now;
      while (acc >= FRAME_DURATION) { acc -= FRAME_DURATION; frame = (frame + 1) % totalFrames; }
      img.style.left = `${-(frame % cols) * w}px`;
      img.style.top = `${-Math.floor(frame / cols) * h}px`;
      rafHolder.id = requestAnimationFrame(loop);
    };
    rafHolder.id = requestAnimationFrame(loop);
  }

  // Wallpaper Engine's scene coordinate space has Y increasing upward (same
  // convention as its 3D camera — see scene.json's camera.up = "0 1 0"), but
  // CSS `top` increases downward. Flip it once here for every object.
  _screenTop(oy, h) {
    return (this.designHeight - oy) - h / 2;
  }

  // Aproximação honesta pro caso "_rt_FullFrameBuffer" (ver
  // _resolveMaterialTexturePng): não dá pra recompor a tela inteira de
  // verdade, mas se o objeto tem um efeito "tint" real anexado (confirmado:
  // "Music Cat"'s "Color", ciclo arco-íris via script), aplica esse tint
  // como uma camada cobrindo o stage inteiro, ao vivo. A fórmula real do
  // Tint (`max(fundo.rgb) * cor`) depende do brilho do que está por baixo —
  // sem capturar a tela real não dá pra replicar exato, então usa
  // `mix-blend-mode:color` (troca o matiz preservando a luminosidade de
  // baixo) como aproximação conceitual mais próxima: um "tingimento" visível
  // que ainda reage ao que está por baixo, só não pixel-a-pixel idêntico ao
  // shader real.
  _buildFullFrameBufferObject(obj, visibleEffects) {
    const tintConfig = extractTintConfig(visibleEffects);
    if (!tintConfig || tintConfig.unsupported) return false;

    // BLENDMODE real bate exato com um mix-blend-mode do CSS pros modos
    // Hue(26)/Color(28) — não precisa aproximar, é literalmente a mesma
    // operação (troca de matiz preservando saturação/luminosidade do que
    // está por baixo, ou vice-versa). Só o Tint puro (30) não tem
    // equivalente direto em CSS (depende do brilho do fundo de um jeito
    // que nenhum mix-blend-mode nativo replica) — cai pra "normal" nesse
    // caso, uma aproximação sabidamente mais fraca.
    const cssBlendMode = tintConfig.blendMode === 26 ? 'hue' : tintConfig.blendMode === 28 ? 'color' : 'normal';
    const div = document.createElement('div');
    div.style.cssText = `position:absolute; left:0; top:0; width:${this.designWidth}px; height:${this.designHeight}px; mix-blend-mode:${cssBlendMode}; pointer-events:none;`;
    this.stage.appendChild(div);

    const alphaLive = new LiveScriptValue(tintConfig.alphaRaw, tintConfig.alpha, false);
    const colorLive = new LiveScriptValue(tintConfig.colorRaw, tintConfig.color, true);
    const toRgbCss = (c) => `rgb(${Math.round(Math.max(0, Math.min(1, c[0])) * 255)},${Math.round(Math.max(0, Math.min(1, c[1])) * 255)},${Math.round(Math.max(0, Math.min(1, c[2])) * 255)})`;
    const draw = () => {
      div.style.background = toRgbCss(colorLive.current);
      div.style.opacity = String(Math.max(0, Math.min(1, alphaLive.current)));
    };
    draw();

    if (alphaLive.exports || colorLive.exports) {
      const rafHolder = { id: null };
      this._foliageRafHolders.push(rafHolder);
      let lastTime = performance.now();
      const loop = () => {
        const now = performance.now();
        ENGINE_CLOCK.frametime = Math.min(0.1, (now - lastTime) / 1000);
        ENGINE_CLOCK.runtime += ENGINE_CLOCK.frametime;
        lastTime = now;
        alphaLive.tick();
        colorLive.tick();
        draw();
        rafHolder.id = requestAnimationFrame(loop);
      };
      rafHolder.id = requestAnimationFrame(loop);
      this._reportIssue(`objeto "${obj.name}": _rt_FullFrameBuffer aproximado (não recompõe a tela real) — tint em cima de tudo com script real rodando`);
    } else {
      this._reportIssue(`objeto "${obj.name}": _rt_FullFrameBuffer aproximado (não recompõe a tela real) — tint estático em cima de tudo`);
    }
    return true;
  }

  // Walks the parent chain (obj.parent -> id -> parent.parent -> ...) and
  // returns the effective ABSOLUTE [x,y] origin, summing each level's own
  // relative origin. "origin" isn't always a plain "x y z" string — real
  // files show two other shapes, both confirmed against 3763428294's and
  // 3762437755's scene.json: a draggable-layer script (real Clock/Day/Date
  // parents: `{script, scriptproperties, value}`, the cursor-drag JS reads
  // localStorage for a saved position but always keeps `value` as the
  // resting one) and a keyframe animation (`{animation, value}`). Neither
  // interactive dragging nor keyframe playback is run here, but both
  // shapes carry that same `value` fallback string, which is what actually
  // matters for a static render — using it beats treating the whole parent
  // as position (0,0), which silently discarded the parent's real position
  // entirely for every real Clock/Day/Date case found.
  _resolveOrigin(obj) {
    let x = 0, y = 0;
    let current = obj;
    const seen = new Set();
    while (current) {
      const raw = current.origin;
      let str = null;
      if (typeof raw === 'string') str = raw;
      else if (raw && typeof raw.value === 'string') str = raw.value;
      if (str) {
        const [ox, oy] = str.split(' ').map(Number);
        x += ox || 0; y += oy || 0;
      } else if (raw != null) {
        this._reportIssue(`objeto "${current.name}" tem origin num formato não reconhecido — tratado como parado na posição (0,0)`);
      }
      if (current.parent == null || seen.has(current.parent)) break;
      seen.add(current.parent);
      current = this.objectsById.get(current.parent);
    }
    return [x, y];
  }

  // Lê um .json relativo à cena, caindo pra instalação global da WE quando
  // não vem empacotado localmente — mesmo padrão já confirmado necessário
  // pro material.json e pra textura em si (ver _resolveMaterialTexturePng),
  // um nível acima: o PRÓPRIO model.json (obj.image) também pode ser um
  // asset de estoque não reempacotado por cena (confirmado 2026-07-18,
  // "Music Visualizer"'s "BG Color 2 (Primary)": models/util/solidlayer.json
  // só existe na instalação real, nunca dentro do scene.pkg).
  _readSceneOrStockJson(relPath) {
    const localPath = path.join(this.sceneDir, relPath);
    if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const weAssets = getWEAssetsRoot();
    if (!weAssets) return null;
    const globalPath = path.join(weAssets, relPath);
    if (!fs.existsSync(globalPath)) return null;
    return JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  }

  _buildImageObject(obj) {
    let model;
    try { model = this._readSceneOrStockJson(obj.image); } catch { return false; }
    if (!model) return false;

    if (model.puppet) return this._buildPuppetObject(obj, model);

    // Um objeto pode ter VÁRIOS efeitos do MESMO tipo, cada um só ativo sob
    // uma condição (ex.: um seletor "mode" na UI da WE) — descoberto real
    // 2026-07-18, "Music Cat"'s "Color": 3 efeitos "tint" (HUE/B&W/Rainbow),
    // cada um com seu próprio `.visible` gated por uma General Property,
    // só um ativo por vez no estado congelado da cena. As funções
    // extract*Config sempre pegavam o PRIMEIRO efeito daquele tipo na
    // lista, ignorando completamente qual estava de fato visível — filtra
    // aqui, uma vez, com a mesma lógica de _isVisible já usada pros
    // objetos (o formato de `.visible` é idêntico em efeitos e objetos).
    const visibleEffects = (obj.effects || []).filter((eff) => this._isVisible(eff));

    const texResult = this._resolveMaterialTexturePng(model);
    if (!texResult) return false;
    if (texResult.fullFrameBuffer) return this._buildFullFrameBufferObject(obj, visibleEffects);

    const [w, h]   = (obj.size   || `${this.designWidth} ${this.designHeight}`).split(' ').map(Number);
    const [ox, oy] = this._resolveOrigin(obj);

    // "color" multiplica a textura (real: shader genericimage4 faz
    // albedo.rgb *= objectColor) — normalmente 1 1 1 (sem efeito), mas
    // objetos "solid layer" (textura util/white lisa) dependem 100% disso
    // pra virar a cor de verdade; sem aplicar, todo painel de cor sólida
    // aparecia branco puro em vez da cor real (confirmado ao vivo
    // 2026-07-18, "Music Visualizer": fundo devia ser preto por padrão —
    // script da própria cena começa em Vec3(0,0,0) — e aparecia branco).
    // csvVec já sabe extrair o ".value" congelado de script/animação.
    const [tr, tg, tb] = csvVec(obj.color, [1, 1, 1]);
    // Precisa considerar script-driven mesmo quando o valor CONGELADO calha
    // de ser branco puro (confirmado real: "BG Color"/"BG Color 2" da Music
    // Visualizer têm color.value = "1 1 1" mas um script real por trás) —
    // senão a gente nem monta o overlay de tingimento, e o script nunca
    // roda de verdade.
    const colorIsScripted = !!(obj.color && typeof obj.color === 'object' && typeof obj.color.script === 'string');
    const isTinted = colorIsScripted || tr !== 1 || tg !== 1 || tb !== 1;
    const colorLive = isTinted ? new LiveScriptValue(obj.color, [tr, tg, tb], true) : null;
    const toRgbCss = (c) => `rgb(${Math.round(Math.max(0, Math.min(1, c[0])) * 255)},${Math.round(Math.max(0, Math.min(1, c[1])) * 255)},${Math.round(Math.max(0, Math.min(1, c[2])) * 255)})`;

    const left = ox - w / 2;
    const top = this._screenTop(oy, h);

    // Roda um loop de frame que só atualiza a cor de fundo do elemento —
    // usado tanto pelo caso "flat" (sem textura) quanto pelo overlay de
    // tingimento abaixo, sempre que colorLive tiver um script de verdade
    // compilado.
    const startColorLoop = (el) => {
      if (!colorLive || !colorLive.exports) return;
      const rafHolder = { id: null };
      this._foliageRafHolders.push(rafHolder);
      let lastTime = performance.now();
      const loop = () => {
        const now = performance.now();
        ENGINE_CLOCK.frametime = Math.min(0.1, (now - lastTime) / 1000);
        ENGINE_CLOCK.runtime += ENGINE_CLOCK.frametime;
        lastTime = now;
        colorLive.tick();
        el.style.background = toRgbCss(colorLive.current);
        rafHolder.id = requestAnimationFrame(loop);
      };
      rafHolder.id = requestAnimationFrame(loop);
    };

    if (texResult.flat) {
      // Shader "flat" (sem textura) — a cor É o conteúdo inteiro, não uma
      // multiplicação sobre uma imagem. Sem alpha explícito no objeto,
      // "translucent" nesse shader ainda é opaco na prática (a WE só usa
      // isso pra permitir blend com o que já foi desenhado, não pra
      // transparência automática) — desenha opaco, sem efeitos de imagem
      // (não há <img> pra anexar WebGL nenhum aqui).
      const div = document.createElement('div');
      div.style.cssText = `position:absolute; left:${left}px; top:${top}px; width:${w}px; height:${h}px; background:${toRgbCss([tr, tg, tb])};`;
      this.stage.appendChild(div);
      startColorLoop(div);
      this._wireObjectInteractivity(obj, div, w, h, left, top);
      return true;
    }

    const img = document.createElement('img');
    img.src = texResult.src;

    let tintWrap = null;
    if (texResult.spritesheet) {
      // Recorte real de spritesheet (confirmado 2026-07-19, "Music Cat"'s
      // "Base" — gato com fone de ouvido, real combo SPRITESHEET do
      // genericimage2.vert local da WE, ver nota em _resolveMaterialTexturePng).
      // Sem isso, a textura inteira (todos os quadros lado a lado) era
      // espremida na caixa do objeto via object-fit:cover — aparecia como
      // uma grade estática de gatinhos em vez de UM gato animado.
      // "overflow:hidden" sempre precisa de um wrapper (mesmo sem
      // tingimento), por isso não reaproveita o branch `else` de baixo.
      tintWrap = document.createElement('div');
      tintWrap.style.cssText = `position:absolute; left:${left}px; top:${top}px; width:${w}px; height:${h}px; overflow:hidden; isolation:isolate;`;
      img.style.cssText = `position:absolute; left:0; top:0;`;
      tintWrap.appendChild(img);
      if (isTinted) {
        const tintOverlay = document.createElement('div');
        tintOverlay.style.cssText = `position:absolute; left:0; top:0; width:100%; height:100%; background:${toRgbCss([tr, tg, tb])}; mix-blend-mode:multiply; pointer-events:none;`;
        tintWrap.appendChild(tintOverlay);
        startColorLoop(tintOverlay);
      }
      this.stage.appendChild(tintWrap);
      img.onload = () => this._startSpriteSheetAnimation(img, w, h);
    } else if (isTinted) {
      // mix-blend-mode:multiply sozinho tingiria contra QUALQUER coisa
      // pintada atrás dele no stage inteiro (inclusive o fundo preto padrão
      // do próprio stage) — "isolation:isolate" cria um novo contexto de
      // empilhamento só pra esse par img+overlay, então o multiply só
      // enxerga a própria imagem, não o resto da cena.
      tintWrap = document.createElement('div');
      tintWrap.style.cssText = `position:absolute; left:${left}px; top:${top}px; width:${w}px; height:${h}px; isolation:isolate;`;
      img.style.cssText = `position:absolute; left:0; top:0; width:100%; height:100%; object-fit:cover;`;
      const tintOverlay = document.createElement('div');
      tintOverlay.style.cssText = `position:absolute; left:0; top:0; width:100%; height:100%; background:${toRgbCss([tr, tg, tb])}; mix-blend-mode:multiply; pointer-events:none;`;
      tintWrap.appendChild(img);
      tintWrap.appendChild(tintOverlay);
      this.stage.appendChild(tintWrap);
      startColorLoop(tintOverlay);
    } else {
      img.style.cssText = `position:absolute; left:${left}px; top:${top}px; width:${w}px; height:${h}px; object-fit:cover;`;
      this.stage.appendChild(img);
    }
    this._wireObjectInteractivity(obj, tintWrap || img, w, h, left, top);

    const foliagePasses = extractFoliageSwayPasses(visibleEffects);
    if (foliagePasses.length) {
      img.onload = () => {
        this._applyFoliageSway(img, foliagePasses, w, h).catch((err) => {
          this._reportIssue(`efeito foliagesway em "${obj.name}" falhou, mantendo imagem parada: ${err.message}`);
        });
      };
    }

    const chromaticConfig = extractChromaticAberrationConfig(visibleEffects);
    if (chromaticConfig) {
      img.onload = () => {
        try {
          this._applyChromaticAberration(img, chromaticConfig, w, h);
        } catch (err) {
          this._reportIssue(`efeito chromatic aberration em "${obj.name}" falhou, mantendo imagem original: ${err.message}`);
        }
      };
    }

    const vhsConfig = extractVHSConfig(visibleEffects);
    if (vhsConfig) {
      if (vhsConfig.unsupported) {
        this._reportIssue(`objeto "${obj.name}" usa VHS em modo não suportado: ${vhsConfig.unsupported}`);
      } else {
        img.onload = () => {
          this._applyVHS(img, vhsConfig, w, h).catch((err) => {
            this._reportIssue(`efeito VHS em "${obj.name}" falhou, mantendo imagem parada: ${err.message}`);
          });
        };
      }
    }

    const motionBlurConfig = extractMotionBlurConfig(visibleEffects);
    if (motionBlurConfig) {
      if (motionBlurConfig.unsupported) {
        this._reportIssue(`objeto "${obj.name}" usa motion blur em modo não suportado: ${motionBlurConfig.unsupported}`);
      } else {
        img.onload = () => {
          try {
            this._applyMotionBlur(img, motionBlurConfig, w, h);
          } catch (err) {
            this._reportIssue(`efeito motion blur em "${obj.name}" falhou, mantendo imagem parada: ${err.message}`);
          }
        };
      }
    }

    const filmGrainConfig = extractFilmGrainConfig(visibleEffects);
    if (filmGrainConfig) {
      if (filmGrainConfig.unsupported) {
        this._reportIssue(`objeto "${obj.name}" usa film grain em modo não suportado: ${filmGrainConfig.unsupported}`);
      } else {
        img.onload = () => {
          this._applyFilmGrain(img, filmGrainConfig, w, h).catch((err) => {
            this._reportIssue(`efeito film grain em "${obj.name}" falhou, mantendo imagem parada: ${err.message}`);
          });
        };
      }
    }

    const edgeDetectionConfig = extractEdgeDetectionConfig(visibleEffects);
    if (edgeDetectionConfig) {
      if (edgeDetectionConfig.unsupported) {
        this._reportIssue(`objeto "${obj.name}" usa edge detection em modo não suportado: ${edgeDetectionConfig.unsupported}`);
      } else {
        img.onload = () => {
          try {
            this._applyEdgeDetection(img, edgeDetectionConfig, w, h);
          } catch (err) {
            this._reportIssue(`efeito edge detection em "${obj.name}" falhou, mantendo imagem original: ${err.message}`);
          }
        };
      }
    }

    // Leva de efeitos simples (estáticos: aplicam uma vez / animados: têm seu
    // próprio RAF loop dentro do método _apply*) — todos seguem o mesmo
    // padrão extract->unsupported?->apply já usado acima.
    const STATIC_EFFECTS = [
      ['opacity', extractOpacityConfig, '_applyOpacity'],
      ['skew', extractSkewConfig, '_applySkew'],
      ['transform', extractTransformConfig, '_applyTransform'],
      ['fisheye', extractFisheyeConfig, '_applyFisheye'],
      ['perspective', extractPerspectiveConfig, '_applyPerspective'],
      ['tint', extractTintConfig, '_applyTint'],
      ['colorkey', extractColorKeyConfig, '_applyColorKey'],
      ['localcontrast', extractLocalContrastConfig, '_applyLocalContrast'],
      ['reflection', extractReflectionConfig, '_applyReflection'],
      ['blur', extractBlurConfig, '_applyBlur'],
      ['blurprecise', extractBlurPreciseConfig, '_applyBlurPrecise'],
      ['blurradial', extractBlurRadialConfig, '_applyBlurRadial'],
    ];
    // ANIMATED_EFFECTS: nem todos aqui têm RAF loop de verdade — blend/
    // blendgradient são assíncronos só porque carregam textura extra do
    // disco (1 render só, sem tempo), mas precisam do mesmo tratamento de
    // Promise+.catch() em vez do try/catch síncrono do loop STATIC_EFFECTS.
    const ANIMATED_EFFECTS = [
      ['scroll', extractScrollConfig, '_applyScroll'],
      ['spin', extractSpinConfig, '_applySpin'],
      ['swing', extractSwingConfig, '_applySwing'],
      ['shake', extractShakeConfig, '_applyShake'],
      ['pulse', extractPulseConfig, '_applyPulse'],
      ['twirl', extractTwirlConfig, '_applyTwirl'],
      ['blend', extractBlendConfig, '_applyBlend'],
      ['blendgradient', extractBlendGradientConfig, '_applyBlendGradient'],
      ['shine', extractShineConfig, '_applyShine'],
      ['shimmer', extractShimmerConfig, '_applyShimmer'],
      ['refraction', extractRefractionConfig, '_applyRefraction'],
      ['nitro', extractNitroConfig, '_applyNitro'],
      ['iris', extractIrisConfig, '_applyIris'],
      ['glitter', extractGlitterConfig, '_applyGlitter'],
      ['godrays', extractGodraysConfig, '_applyGodrays'],
      ['watercaustics', extractCausticsConfig, '_applyCaustics'],
      ['waterflow', extractWaterFlowConfig, '_applyWaterFlow'],
      ['waterripple', extractWaterRippleConfig, '_applyWaterRipple'],
      ['waterwaves', extractWaterWavesConfig, '_applyWaterWaves'],
      ['clouds', extractCloudsConfig, '_applyClouds'],
      ['cloudmotion', extractCloudMotionConfig, '_applyCloudMotion'],
      ['fire', extractFireConfig, '_applyFire'],
      ['depthparallax', extractDepthParallaxConfig, '_applyDepthParallax'],
      ['xray', extractXrayConfig, '_applyXray'],
      ['cursorripple', extractCursorRippleConfig, '_applyCursorRipple'],
      ['fluidsimulation', extractFluidSimulationConfig, '_applyFluidSimulation'],
    ];
    for (const [label, extractFn, methodName] of STATIC_EFFECTS) {
      if (!methodName) continue;
      const config = extractFn(visibleEffects);
      if (!config) continue;
      if (config.unsupported) { this._reportIssue(`objeto "${obj.name}" usa ${label} em modo não suportado: ${config.unsupported}`); continue; }
      img.onload = () => {
        try { this[methodName](img, config, w, h); } catch (err) {
          this._reportIssue(`efeito ${label} em "${obj.name}" falhou, mantendo imagem original: ${err.message}`);
        }
      };
    }
    for (const [label, extractFn, methodName] of ANIMATED_EFFECTS) {
      const config = extractFn(visibleEffects);
      if (!config) continue;
      if (config.unsupported) { this._reportIssue(`objeto "${obj.name}" usa ${label} em modo não suportado: ${config.unsupported}`); continue; }
      img.onload = () => {
        this[methodName](img, config, w, h).catch((err) => {
          this._reportIssue(`efeito ${label} em "${obj.name}" falhou, mantendo imagem parada: ${err.message}`);
        });
      };
    }

    // Fallback genérico: qualquer efeito que não bateu com nenhuma das
    // checagens acima (os efeitos oficiais já portados à mão) é
    // provavelmente um shader PRÓPRIO de um item da Workshop — tenta
    // compilar o .frag/.vert real dele na hora (ver we-shader-compiler.js)
    // em vez de simplesmente ignorar. Nunca substitui o caminho hardcoded
    // acima, só cobre o que sobrou (zero risco de regressão nos ~48 já
    // validados).
    const KNOWN_EFFECT_NAMES = [
      'foliagesway', 'chromaticaberration', 'vhs', 'motionblur', 'filmgrain', 'edgedetection',
      ...STATIC_EFFECTS.map(([label]) => label),
      ...ANIMATED_EFFECTS.map(([label]) => label),
    ];
    const weAssetsRootForGeneric = getWEAssetsRoot();
    for (const eff of visibleEffects) {
      if (!eff.file) continue;
      if (KNOWN_EFFECT_NAMES.some((name) => eff.file.endsWith(`${name}/effect.json`))) continue;
      const pass = (eff.passes || [])[0];
      if (!pass) continue;
      img.onload = () => {
        let source;
        try {
          source = compileGenericEffectSource(this.sceneDir, weAssetsRootForGeneric, eff.file, pass.combos || {});
        } catch (err) {
          this._reportIssue(`efeito custom "${eff.file}" em "${obj.name}" falhou: ${err.message}`);
          return;
        }
        if (!source) return; // sem shader em lugar nenhum (nem cache da cena, nem instalação real) — nada a fazer
        this._applyGenericShaderEffect(img, {
          ...source,
          textures: pass.textures || [],
          constantShaderValues: pass.constantshadervalues || {},
          objName: obj.name,
        }, w, h).catch((err) => {
          this._reportIssue(`efeito custom "${eff.file}" em "${obj.name}" falhou: ${err.message}`);
        });
      };
    }
    return true;
  }

  // Aplica um efeito custom compilado genericamente (ver
  // we-shader-compiler.js) — reaproveita _setupSimplePass (mesma base usada
  // por TODOS os ~48 efeitos hardcoded) pra canvas/programa/textura-base, só
  // muda a origem do GLSL (lido+resolvido na hora em vez de escrito à mão) e
  // o bind de uniforms/texturas extras, que aqui é genérico em vez de
  // hardcoded por efeito.
  async _applyGenericShaderEffect(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, config.vertSrc, config.fragSrc, w, h, false);

    // Texturas extras (g_Texture1, g_Texture2...) — o índice vem do próprio
    // nome do uniform (convenção real da WE), não da ordem de declaração,
    // pra casar direto com pass.textures[N] sem ambiguidade.
    for (const def of config.uniformDefs) {
      if (def.glslType !== 'sampler2D') continue;
      const m = /^g_Texture(\d+)$/.exec(def.name);
      if (!m) continue;
      const texUnit = Number(m[1]);
      if (texUnit === 0) continue; // g_Texture0 já é a própria imagem do objeto, feito em _setupSimplePass
      const texId = config.textures[texUnit];
      let texImg = null;
      try {
        if (texId) texImg = await this._loadSceneTexAsImage(texId);
        else if (typeof def.annotation.default === 'string') texImg = await this._loadStockTexAsImage(def.annotation.default);
      } catch (err) {
        this._reportIssue(`efeito custom "${config.shaderName}": textura "${def.name}" não carregou (${err.message}), usando branco sólido`);
      }
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, texImg ? FoliageSwayEffect.uploadTexture(gl, texImg) : this._createSolidWhiteTexture(gl));
      const loc = gl.getUniformLocation(program, def.name);
      if (loc) gl.uniform1i(loc, texUnit);
    }

    // Parâmetros numéricos/vetoriais reais (constantshadervalues do
    // objeto), coeridos do mesmo jeito que csvNum/csvVec já fazem pros
    // efeitos hardcoded (ver coerceUniformValue em we-shader-compiler.js).
    for (const def of config.uniformDefs) {
      if (def.glslType === 'sampler2D' || !def.annotation.material) continue;
      const raw = config.constantShaderValues[def.annotation.material];
      const value = coerceUniformValue(raw, def.glslType, def.annotation.default);
      if (value == null) continue;
      const loc = gl.getUniformLocation(program, def.name);
      if (!loc) continue;
      if (def.glslType === 'float') gl.uniform1f(loc, value);
      else if (def.glslType === 'vec2') gl.uniform2fv(loc, value);
      else if (def.glslType === 'vec3') gl.uniform3fv(loc, value);
      else if (def.glslType === 'vec4') gl.uniform4fv(loc, value);
    }

    const resLoc = gl.getUniformLocation(program, 'g_Texture0Resolution');
    if (resLoc) gl.uniform4f(resLoc, 1 / w, 1 / h, w, h);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      if (timeLoc) gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`efeito custom "${config.shaderName}" compilado e aplicado em "${config.objName}" (compilador genérico)`);
  }

  // Substitui a <img> plana por um canvas WebGL rodando o shader real de
  // chromatic aberration (ver buildChromaticAberrationFragSource). Renderiza
  // uma vez só (efeito estático, sem g_Time no shader original) — sem RAF
  // loop, sem custo contínuo de GPU.
  _applyChromaticAberration(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;

    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const vs = compileShader(gl, gl.VERTEX_SHADER, CHROMATIC_ABERRATION_VERT);
    const fs_ = compileShader(gl, gl.FRAGMENT_SHADER, buildChromaticAberrationFragSource(config));
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs_);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar programa chromatic aberration: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_Position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    const tex = FoliageSwayEffect.uploadTexture(gl, img);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture0'), 0);

    gl.uniform1f(gl.getUniformLocation(program, 'u_Direction'), config.direction);
    gl.uniform1f(gl.getUniformLocation(program, 'u_Strength'), config.strength);
    gl.uniform1f(gl.getUniformLocation(program, 'u_CenterFalloff'), config.centerFalloff);
    gl.uniform2fv(gl.getUniformLocation(program, 'u_Center'), config.center);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`chromatic aberration aplicado em imagem (modo ${config.mode}, variação ${config.variation})`);
  }

  // Substitui a <img> plana por um canvas WebGL rodando o shader real de VHS
  // (ver buildVHSFragSource). Diferente do chromatic aberration, esse efeito
  // usa g_Time (distorção/glitch animados), então precisa de um loop de RAF
  // de verdade — mesmo padrão de _applyFoliageSway (textura de ruído padrão
  // da própria WE, materials/util/noise.tex).
  async _applyVHS(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const weAssets = getWEAssetsRoot();
    if (!weAssets) throw new Error('instalação da Wallpaper Engine não encontrada (necessária pro ruído padrão)');
    const noisePath = path.join(weAssets, 'materials', 'util', 'noise.tex');
    const noisePng = decodeTexToPng(fs.readFileSync(noisePath));
    if (!noisePng) throw new Error('textura de ruído padrão não decodificou');

    const noiseImg = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('falha ao decodificar PNG intermediário do ruído'));
      im.src = 'data:image/png;base64,' + noisePng.toString('base64');
    });

    const vs = compileShader(gl, gl.VERTEX_SHADER, VHS_VERT);
    const fs_ = compileShader(gl, gl.FRAGMENT_SHADER, buildVHSFragSource(config));
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs_);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar programa VHS: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_Position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    const baseTex = FoliageSwayEffect.uploadTexture(gl, img);
    const noiseTex = FoliageSwayEffect.uploadTexture(gl, noiseImg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture0'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);

    gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseScale'), config.noiseScale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseAlpha'), config.noiseAlpha);
    gl.uniform1f(gl.getUniformLocation(program, 'g_DistortionStrength'), config.distortionStrength);
    gl.uniform1f(gl.getUniformLocation(program, 'g_DistortionSpeed'), config.distortionSpeed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_DistortionWidth'), config.distortionWidth);
    gl.uniform1f(gl.getUniformLocation(program, 'g_ArtifactsScale'), config.artifactsScale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Chromatic'), config.chromatic);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Aspect'), w / h);

    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();

    this._reportIssue(`VHS aplicado em imagem (glitch/distorção animados)`);
  }

  // Motion blur real: acumulação frame-a-frame via ping-pong de 2 render
  // targets (ver comentário grande acima de MOTIONBLUR_VERT sobre por que
  // isso não produz efeito visível em conteúdo estático — a matemática é
  // real, só não tem "movimento" pra borrar ainda).
  _applyMotionBlur(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const accProgram = gl.createProgram();
    gl.attachShader(accProgram, compileShader(gl, gl.VERTEX_SHADER, MOTIONBLUR_VERT));
    gl.attachShader(accProgram, compileShader(gl, gl.FRAGMENT_SHADER, buildMotionBlurAccumulationFragSource()));
    gl.linkProgram(accProgram);
    if (!gl.getProgramParameter(accProgram, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar acumulação motion blur: ${gl.getProgramInfoLog(accProgram)}`);
    }

    const combProgram = gl.createProgram();
    gl.attachShader(combProgram, compileShader(gl, gl.VERTEX_SHADER, MOTIONBLUR_VERT));
    gl.attachShader(combProgram, compileShader(gl, gl.FRAGMENT_SHADER, MOTIONBLUR_COMBINE_FRAG));
    gl.linkProgram(combProgram);
    if (!gl.getProgramParameter(combProgram, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar combine motion blur: ${gl.getProgramInfoLog(combProgram)}`);
    }

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);

    // Os dois buffers do ping-pong já nascem com a imagem real (não preto) —
    // sem isso a tela abriria com um flash preto antes de convergir, o que
    // não é o comportamento esperado num wallpaper.
    const accumTargets = [
      FoliageSwayEffect.createRenderTarget(gl, w, h),
      FoliageSwayEffect.createRenderTarget(gl, w, h),
    ];
    for (const target of accumTargets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(combProgram);
      bindQuad(combProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(combProgram, 'g_Texture0'), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    let prevIdx = 0;
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const loop = () => {
      const nextIdx = 1 - prevIdx;

      // Passe 1 (acumulação): previous (buffer[prevIdx]) + current (a
      // própria imagem fonte) -> escreve no buffer[nextIdx].
      gl.bindFramebuffer(gl.FRAMEBUFFER, accumTargets[nextIdx].fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(accProgram);
      bindQuad(accProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(accProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, accumTargets[prevIdx].tex);
      gl.uniform1i(gl.getUniformLocation(accProgram, 'g_Texture1'), 1);
      gl.uniform1f(gl.getUniformLocation(accProgram, 'g_Amount'), config.rate);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Passe 2 (combine, passthrough no shader real): desenha o resultado
      // acumulado no canvas visível.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(combProgram);
      bindQuad(combProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, accumTargets[nextIdx].tex);
      gl.uniform1i(gl.getUniformLocation(combProgram, 'g_Texture0'), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      prevIdx = nextIdx;
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();

    this._reportIssue(`motion blur aplicado em imagem (acumulação real, rate=${config.rate}) — sem efeito visível em conteúdo estático até existir uma fonte que mude quadro a quadro (vídeo/partícula) usando esse mesmo mecanismo`);
  }

  // Substitui a <img> plana por um canvas WebGL rodando o shader real de
  // film grain (ver buildFilmGrainFragSource). Animado (ruído rola com
  // g_Time), precisa de RAF loop — mesma textura padrão de ruído da lightshafts/VHS.
  async _applyFilmGrain(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const weAssets = getWEAssetsRoot();
    if (!weAssets) throw new Error('instalação da Wallpaper Engine não encontrada (necessária pro ruído padrão)');
    const noisePath = path.join(weAssets, 'materials', 'util', 'noise.tex');
    const noisePng = decodeTexToPng(fs.readFileSync(noisePath));
    if (!noisePng) throw new Error('textura de ruído padrão não decodificou');

    const noiseImg = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('falha ao decodificar PNG intermediário do ruído'));
      im.src = 'data:image/png;base64,' + noisePng.toString('base64');
    });

    const vs = compileShader(gl, gl.VERTEX_SHADER, FILMGRAIN_VERT);
    const fs_ = compileShader(gl, gl.FRAGMENT_SHADER, buildFilmGrainFragSource(config));
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs_);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar programa film grain: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_Position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    const baseTex = FoliageSwayEffect.uploadTexture(gl, img);
    const noiseTex = FoliageSwayEffect.uploadTexture(gl, noiseImg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture0'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);

    gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseScale'), config.noiseScale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseAlpha'), config.noiseAlpha);
    gl.uniform1f(gl.getUniformLocation(program, 'g_NoisePower'), config.noisePower);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Aspect'), w / h);

    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();

    this._reportIssue(`film grain aplicado em imagem (ruído animado)`);
  }

  // Substitui a <img> plana por um canvas WebGL rodando o shader real de
  // edge detection (kernel Sobel). Estático (sem g_Time), renderiza uma vez só.
  _applyEdgeDetection(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const vs = compileShader(gl, gl.VERTEX_SHADER, EDGEDETECTION_VERT);
    const fs_ = compileShader(gl, gl.FRAGMENT_SHADER, buildEdgeDetectionFragSource());
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs_);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar programa edge detection: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_Position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    const tex = FoliageSwayEffect.uploadTexture(gl, img);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture0'), 0);

    gl.uniform2f(gl.getUniformLocation(program, 'g_TexelSize'), config.detectionSize / w, config.detectionSize / h);
    gl.uniform1f(gl.getUniformLocation(program, 'g_BlendAlpha'), config.blendAlpha);
    gl.uniform1f(gl.getUniformLocation(program, 'g_BlendBrightness'), config.blendBrightness);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_OutlineColor1'), config.outlineColor1);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_OutlineColor2'), config.outlineColor2);
    gl.uniform1f(gl.getUniformLocation(program, 'g_DetectionThreshold'), config.detectionThreshold);
    gl.uniform1f(gl.getUniformLocation(program, 'g_DetectionMultiply'), config.detectionMultiply);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`edge detection aplicado em imagem`);
  }

  // Helper compartilhado pelos efeitos simples de passe único abaixo — monta
  // programa+quad+textura da própria imagem e devolve tudo pronto pra só
  // setar os uniforms específicos e desenhar.
  _setupSimplePass(img, vertSrc, fragSrc, w, h, wantRepeat) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`falha ao linkar programa: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_Position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    const { tex, usedRepeat } = FoliageSwayEffect.uploadTextureWrapped(gl, img, wantRepeat, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture0'), 0);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    return { canvas, gl, program, usedRepeat };
  }

  // Carrega um arquivo .tex REAL referenciado pela própria cena (scene.json
  // objects[].effects[].passes[].textures[N], caminho relativo a
  // <sceneDir>/materials/<id>.tex) como uma <img> decodificada — mesmo
  // mecanismo já usado pelas máscaras do foliagesway (ver _applyFoliageSway).
  async _loadSceneTexAsImage(texId) {
    const texPath = path.join(this.sceneDir, 'materials', texId + '.tex');
    const png = decodeTexToPng(fs.readFileSync(texPath));
    if (!png) throw new Error(`textura "${texId}" não decodificou`);
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`falha ao decodificar PNG intermediário de "${texId}"`));
      im.src = 'data:image/png;base64,' + png.toString('base64');
    });
  }

  // Mesma ideia, mas pra um asset padrão (stock) da própria instalação da WE
  // (materials/util/*.tex), igual ao que já fazemos pra noise.tex/noflow.tex.
  async _loadStockTexAsImage(relNoExt) {
    const weAssets = getWEAssetsRoot();
    if (!weAssets) throw new Error('instalação da Wallpaper Engine não encontrada (necessária pra textura padrão)');
    const texPath = path.join(weAssets, 'materials', relNoExt + '.tex');
    const png = decodeTexToPng(fs.readFileSync(texPath));
    if (!png) throw new Error(`textura padrão "${relNoExt}" não decodificou`);
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`falha ao decodificar PNG intermediário de "${relNoExt}"`));
      im.src = 'data:image/png;base64,' + png.toString('base64');
    });
  }

  // Textura sintética 1x1 branca — usada quando um efeito espera uma textura
  // opcional que a WE por padrão preenche com "util/white", mas nosso
  // decodificador de .tex não entende o formato real desse arquivo
  // específico (ver comentário grande do blendgradient). Funcionalmente
  // idêntica em cor (branco sólido), só não carrega do disco.
  _createSolidWhiteTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  _applyOpacity(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildOpacityFragSource(), w, h, false);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const alphaLive = new LiveScriptValue(config.alphaRaw, config.alpha, false);
    const alphaLoc = gl.getUniformLocation(program, 'g_UserAlpha');
    const draw = () => {
      gl.useProgram(program);
      gl.uniform1f(alphaLoc, alphaLive.current);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    draw();

    if (alphaLive.exports) {
      const rafHolder = { id: null };
      this._foliageRafHolders.push(rafHolder);
      let lastTime = performance.now();
      const loop = () => {
        const now = performance.now();
        ENGINE_CLOCK.frametime = Math.min(0.1, (now - lastTime) / 1000);
        ENGINE_CLOCK.runtime += ENGINE_CLOCK.frametime;
        lastTime = now;
        alphaLive.tick();
        draw();
        rafHolder.id = requestAnimationFrame(loop);
      };
      rafHolder.id = requestAnimationFrame(loop);
      this._reportIssue(`opacity aplicado em imagem (script real rodando: alpha dinâmica)`);
    } else {
      this._reportIssue(`opacity aplicado em imagem (alpha=${config.alpha})`);
    }
  }

  _applySkew(img, config, w, h) {
    const { canvas, gl, program, usedRepeat } = this._setupSimplePass(img, SKEW_VERT, buildSkewFragSource({ repeat: config.repeat }), w, h, config.repeat);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Top'), config.top);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Bottom'), config.bottom);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Left'), config.left);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Right'), config.right);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    if (config.repeat && !usedRepeat) this._reportIssue(`skew: imagem não é potência-de-2, repetição de borda desativada (WebGL1 exige POT pra REPEAT)`);
    this._reportIssue(`skew aplicado em imagem`);
  }

  _applyTransform(img, config, w, h) {
    const { canvas, gl, program, usedRepeat } = this._setupSimplePass(img, TRANSFORM_VERT, buildTransformFragSource({ repeat: config.repeat }), w, h, config.repeat);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Offset'), config.offset);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Direction'), config.direction);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    if (config.repeat && !usedRepeat) this._reportIssue(`transform: imagem não é potência-de-2, repetição de borda desativada (WebGL1 exige POT pra REPEAT)`);
    this._reportIssue(`transform aplicado em imagem`);
  }

  async _applyScroll(img, config, w, h) {
    const { canvas, gl, program, usedRepeat } = this._setupSimplePass(img, SCROLL_VERT, buildScrollFragSource(), w, h, true);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.uniform1f(gl.getUniformLocation(program, 'g_ScrollX'), config.scrollX);
    gl.uniform1f(gl.getUniformLocation(program, 'g_ScrollY'), config.scrollY);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Scale'), config.repeat);
    if (!usedRepeat) this._reportIssue(`scroll: imagem não é potência-de-2, ladrilhamento desativado (WebGL1 exige POT pra REPEAT) — a rolagem em si continua`);
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`scroll aplicado em imagem`);
  }

  async _applySpin(img, config, w, h) {
    const { canvas, gl, program, usedRepeat } = this._setupSimplePass(img, SPIN_VERT, buildSpinFragSource({ repeat: config.repeat }), w, h, config.repeat);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.uniform1f(gl.getUniformLocation(program, 'g_Aspect'), w / h);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Speed'), config.speed);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_SpinCenter'), config.center);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Ratio'), config.ratio);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Axis'), config.axis);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Phase'), config.phase);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Size'), config.size);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Feather'), config.feather);
    if (config.repeat && !usedRepeat) this._reportIssue(`spin: imagem não é potência-de-2, giro pode mostrar borda em vez de repetir (WebGL1 exige POT pra REPEAT)`);
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`spin aplicado em imagem`);
  }

  async _applySwing(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, SWING_VERT, buildSwingFragSource({ doubleSided: config.doubleSided }), w, h, false);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.uniform1f(gl.getUniformLocation(program, 'g_Aspect'), w / h);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Amount'), config.amount);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Phase'), config.phase);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Point0'), config.point0);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Point1'), config.point1);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Size'), config.size);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CenterPos'), config.centerPos);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Feather'), config.feather);
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`swing aplicado em imagem`);
  }

  async _applyShake(img, config, w, h) {
    const weAssets = getWEAssetsRoot();
    if (!weAssets) throw new Error('instalação da Wallpaper Engine não encontrada (necessária pro mapa de direção padrão)');
    const noflowPath = path.join(weAssets, 'materials', 'util', 'noflow.tex');
    const noflowPng = decodeTexToPng(fs.readFileSync(noflowPath));
    if (!noflowPng) throw new Error('mapa de direção padrão (noflow.tex) não decodificou');
    const noflowImg = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('falha ao decodificar PNG intermediário do mapa de direção'));
      im.src = 'data:image/png;base64,' + noflowPng.toString('base64');
    });

    const { canvas, gl, program } = this._setupSimplePass(img, SHAKE_VERT, buildShakeFragSource({ direction: config.direction }), w, h, false);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const noflowTex = FoliageSwayEffect.uploadTexture(gl, noflowImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noflowTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);

    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Bounds'), config.bounds);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Amp'), config.amp);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Friction'), config.friction);

    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`shake aplicado em imagem`);
  }

  async _applyPulse(img, config, w, h) {
    const weAssets = getWEAssetsRoot();
    if (!weAssets) throw new Error('instalação da Wallpaper Engine não encontrada (necessária pro ruído padrão)');
    const noisePath = path.join(weAssets, 'materials', 'util', 'noise.tex');
    const noisePng = decodeTexToPng(fs.readFileSync(noisePath));
    if (!noisePng) throw new Error('textura de ruído padrão não decodificou');
    const noiseImg = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('falha ao decodificar PNG intermediário do ruído'));
      im.src = 'data:image/png;base64,' + noisePng.toString('base64');
    });

    const { canvas, gl, program } = this._setupSimplePass(img, PULSE_VERT, buildPulseFragSource({ pulseColor: config.pulseColor, pulseAlpha: config.pulseAlpha }), w, h, false);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const noiseTex = FoliageSwayEffect.uploadTexture(gl, noiseImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);

    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.uniform2fv(gl.getUniformLocation(program, 'g_PulseThresholds'), config.pulseThresholds);
    gl.uniform1f(gl.getUniformLocation(program, 'g_PulseSpeed'), config.pulseSpeed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_PulsePhase'), config.pulsePhase);
    gl.uniform1f(gl.getUniformLocation(program, 'g_PulseAmount'), config.pulseAmount);
    gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseSpeed'), config.noiseSpeed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseAmount'), config.noiseAmount);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Power'), config.power);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_TintColor1'), config.tintColor1);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_TintColor2'), config.tintColor2);

    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`pulse aplicado em imagem`);
  }

  _applyFisheye(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildFisheyeFragSource({ background: config.background }), w, h, false);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Size'), config.size);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Scale'), config.scale);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Center'), config.center);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`fisheye aplicado em imagem`);
  }

  _applyPerspective(img, config, w, h) {
    const { canvas, gl, program, usedRepeat } = this._setupSimplePass(img, PERSPECTIVE_VERT, buildPerspectiveFragSource({ repeat: config.repeat }), w, h, config.repeat);
    const xformRows = invert3x3Rows(...squareToQuadRows(config.point0, config.point1, config.point2, config.point3));
    gl.uniform3fv(gl.getUniformLocation(program, 'u_XformRow0'), xformRows[0]);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_XformRow1'), xformRows[1]);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_XformRow2'), xformRows[2]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    if (config.repeat && !usedRepeat) this._reportIssue(`perspective: imagem não é potência-de-2, repetição de borda desativada (WebGL1 exige POT pra REPEAT)`);
    this._reportIssue(`perspective aplicado em imagem`);
  }

  async _applyTwirl(img, config, w, h) {
    const { canvas, gl, program, usedRepeat } = this._setupSimplePass(img, TWIRL_VERT, buildTwirlFragSource({ repeat: config.repeat }), w, h, config.repeat);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    gl.uniform1f(gl.getUniformLocation(program, 'g_Aspect'), w / h);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Amount'), config.amount);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Phase'), config.phase);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_SpinCenter'), config.center);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Size'), config.size);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Feather'), config.feather);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Ratio'), config.ratio);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Axis'), config.axis);
    if (config.repeat && !usedRepeat) this._reportIssue(`twirl: imagem não é potência-de-2, redemoinho pode mostrar borda em vez de repetir (WebGL1 exige POT pra REPEAT)`);
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`twirl aplicado em imagem`);
  }

  // Suporta alpha/color estáticos (de sempre) OU script real rodando de
  // verdade a cada frame (LiveScriptValue) — confirmado real 2026-07-18,
  // "Music Cat"'s "Color": um ciclo de cor arco-íris via WEColor.hsv2rgb
  // baseado em Date.now(), sem depender de áudio nenhum. Roda o loop de
  // frame sempre (custo desprezível, um draw call), só reporta como "script
  // real rodando" quando alguma das duas propriedades de fato compilou.
  _applyTint(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildTintFragSource(config.blendMode), w, h, false);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const alphaLive = new LiveScriptValue(config.alphaRaw, config.alpha, false);
    const colorLive = new LiveScriptValue(config.colorRaw, config.color, true);
    const scripted = !!(alphaLive.exports || colorLive.exports);

    const alphaLoc = gl.getUniformLocation(program, 'g_BlendAlpha');
    const colorLoc = gl.getUniformLocation(program, 'g_TintColor');
    const draw = () => {
      gl.useProgram(program);
      gl.uniform1f(alphaLoc, alphaLive.current);
      gl.uniform3fv(colorLoc, colorLive.current);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    draw();

    if (scripted) {
      const rafHolder = { id: null };
      this._foliageRafHolders.push(rafHolder);
      let lastTime = performance.now();
      const loop = () => {
        const now = performance.now();
        ENGINE_CLOCK.frametime = Math.min(0.1, (now - lastTime) / 1000);
        ENGINE_CLOCK.runtime += ENGINE_CLOCK.frametime;
        lastTime = now;
        alphaLive.tick();
        colorLive.tick();
        draw();
        rafHolder.id = requestAnimationFrame(loop);
      };
      rafHolder.id = requestAnimationFrame(loop);
      this._reportIssue(`tint aplicado em imagem (script real rodando: cor/opacidade dinâmica)`);
    } else {
      this._reportIssue(`tint aplicado em imagem`);
    }
  }

  _applyColorKey(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildColorKeyFragSource({ invert: config.invert, flatten: config.flatten }), w, h, false);
    gl.uniform1f(gl.getUniformLocation(program, 'g_KeyAlpha'), config.keyAlpha);
    gl.uniform1f(gl.getUniformLocation(program, 'g_KeyFuzz'), config.keyFuzz);
    gl.uniform1f(gl.getUniformLocation(program, 'g_KeyTolerance'), config.keyTolerance);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_KeyColor'), config.keyColor);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`colorkey aplicado em imagem`);
  }

  async _applyBlend(img, config, w, h) {
    const blendImg = await this._loadSceneTexAsImage(config.texId);
    const { canvas, gl, program } = this._setupSimplePass(img, BLEND_VERT, buildBlendFragSource(), w, h, false);
    const blendTex = FoliageSwayEffect.uploadTexture(gl, blendImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blendTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    gl.uniform2f(gl.getUniformLocation(program, 'u_BlendTexScale'), w / blendImg.naturalWidth, h / blendImg.naturalHeight);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Multiply'), config.multiply);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`blend aplicado em imagem`);
  }

  async _applyBlendGradient(img, config, w, h) {
    const gradientImg = config.gradientTexId
      ? await this._loadSceneTexAsImage(config.gradientTexId)
      : await this._loadStockTexAsImage('util/clouds_256');
    const colorImg = config.colorTexId ? await this._loadSceneTexAsImage(config.colorTexId) : null;

    const { canvas, gl, program } = this._setupSimplePass(img, BLENDGRADIENT_VERT, buildBlendGradientFragSource({ edgeGlow: config.edgeGlow }), w, h, false);

    let colorTex, colorScaleW, colorScaleH;
    if (colorImg) {
      colorTex = FoliageSwayEffect.uploadTexture(gl, colorImg);
      colorScaleW = w / colorImg.naturalWidth;
      colorScaleH = h / colorImg.naturalHeight;
    } else {
      colorTex = this._createSolidWhiteTexture(gl);
      colorScaleW = 1;
      colorScaleH = 1;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);

    const gradientTex = FoliageSwayEffect.uploadTexture(gl, gradientImg);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, gradientTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture2'), 2);

    gl.uniform2f(gl.getUniformLocation(program, 'u_Tex1Scale'), colorScaleW, colorScaleH);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Multiply'), config.multiply);
    gl.uniform1f(gl.getUniformLocation(program, 'g_GradientScale'), config.gradientScale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_EdgeBrightness'), config.edgeBrightness);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_EdgeColor'), config.edgeColor);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`blendgradient aplicado em imagem`);
  }

  // Pipeline real de 4 passes (ver comentário grande em extractLocalContrastConfig)
  // — estático (1 render só), monta seus próprios programas/framebuffers em
  // vez de usar _setupSimplePass porque precisa de 2 render targets em 1/4
  // da resolução entre os passes intermediários.
  _applyLocalContrast(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa localcontrast: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const bufferA = FoliageSwayEffect.createRenderTarget(gl, qw, qh);
    const bufferB = FoliageSwayEffect.createRenderTarget(gl, qw, qh);

    // Passe 1: downsample4 (box filter, resolução cheia -> 1/4)
    const downProgram = linkProgram(LOCALCONTRAST_DOWNSAMPLE_VERT, LOCALCONTRAST_DOWNSAMPLE_FRAG);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
    gl.viewport(0, 0, qw, qh);
    gl.useProgram(downProgram);
    bindQuad(downProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(gl.getUniformLocation(downProgram, 'g_Texture0'), 0);
    gl.uniform2f(gl.getUniformLocation(downProgram, 'u_TexelSize'), 1 / w, 1 / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Passe 2: blur gaussiano horizontal (1/4 resolução, A -> B)
    const gaussProgram = linkProgram(buildLocalContrastGaussianVert(config.kernel), buildLocalContrastGaussianFrag(config.kernel));
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.fbo);
    gl.viewport(0, 0, qw, qh);
    gl.useProgram(gaussProgram);
    bindQuad(gaussProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
    gl.uniform1i(gl.getUniformLocation(gaussProgram, 'g_Texture0'), 0);
    gl.uniform2f(gl.getUniformLocation(gaussProgram, 'u_Offset'), config.scale[0] / qw, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Passe 3: blur gaussiano vertical (1/4 resolução, B -> A)
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
    gl.viewport(0, 0, qw, qh);
    gl.useProgram(gaussProgram);
    bindQuad(gaussProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
    gl.uniform1i(gl.getUniformLocation(gaussProgram, 'g_Texture0'), 0);
    gl.uniform2f(gl.getUniformLocation(gaussProgram, 'u_Offset'), 0, config.scale[1] / qh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Passe 4: combine (unsharp mask), resolução cheia, direto no canvas visível
    const combineProgram = linkProgram(SIMPLE_VERT, buildLocalContrastCombineFragSource({ greyscale: config.greyscale }));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(combineProgram);
    bindQuad(combineProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
    gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture0'), 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture2'), 2);
    gl.uniform1f(gl.getUniformLocation(combineProgram, 'g_Amount'), config.amount);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`localcontrast aplicado em imagem (pipeline real de 4 passes: downsample 1/4 + blur gaussiano separável + unsharp mask)`);
  }

  // Pipeline real de 5 passes (ver comentário grande em extractShineConfig)
  // — animado (o raio gira se g_Speed!=0; roda o RAF de qualquer forma já
  // que o próprio ruído de cintilação padrão também usa g_Time).
  async _applyShine(img, config, w, h) {
    const noiseImg = config.noise ? await this._loadStockTexAsImage('util/clouds_256') : null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa shine: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    const hw = Math.max(1, Math.round(w / 2));
    const hh = Math.max(1, Math.round(h / 2));

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const noiseTex = noiseImg ? FoliageSwayEffect.uploadTexture(gl, noiseImg) : null;
    const bufferA = FoliageSwayEffect.createRenderTarget(gl, hw, hh);
    const bufferB = FoliageSwayEffect.createRenderTarget(gl, hw, hh);

    const downProgram = linkProgram(buildShineDownsampleVert({ noise: config.noise }), buildShineDownsampleFragSource({ noise: config.noise }));
    const castProgram = linkProgram(SHINE_CAST_VERT, buildShineCastFragSource({ samples: config.samples }));
    const gaussXProgram = linkProgram(buildShineGaussianVert({ vertical: false }), buildShineGaussianFragSource({ kernel: config.kernel }));
    const gaussYProgram = linkProgram(buildShineGaussianVert({ vertical: true }), buildShineGaussianFragSource({ kernel: config.kernel }));
    const combineProgram = linkProgram(SIMPLE_VERT, buildShineCombineFragSource());

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const timeLocDown = gl.getUniformLocation(downProgram, 'g_Time');
    const timeLocCast = gl.getUniformLocation(castProgram, 'g_Time');

    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const render = () => {
      const time = (performance.now() - startTime) / 1000;

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(downProgram);
      bindQuad(downProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(downProgram, 'g_Texture0'), 0);
      gl.uniform1f(gl.getUniformLocation(downProgram, 'g_Threshold'), config.threshold);
      if (config.noise) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, noiseTex);
        gl.uniform1i(gl.getUniformLocation(downProgram, 'g_Texture2'), 2);
        gl.uniform1f(gl.getUniformLocation(downProgram, 'g_NoiseAmount'), config.noiseAmount);
        gl.uniform1f(gl.getUniformLocation(downProgram, 'g_NoiseSpeed'), config.noiseSpeed);
        gl.uniform1f(gl.getUniformLocation(downProgram, 'g_NoiseScale'), config.noiseScale);
        gl.uniform1f(timeLocDown, time);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(castProgram);
      bindQuad(castProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
      gl.uniform1i(gl.getUniformLocation(castProgram, 'g_Texture0'), 0);
      gl.uniform4f(gl.getUniformLocation(castProgram, 'g_Texture0Resolution'), 1 / hw, 1 / hh, hw, hh);
      gl.uniform1f(timeLocCast, time);
      gl.uniform1f(gl.getUniformLocation(castProgram, 'g_Direction'), config.direction);
      gl.uniform1f(gl.getUniformLocation(castProgram, 'g_Speed'), config.speed);
      gl.uniform1f(gl.getUniformLocation(castProgram, 'g_Length'), config.length);
      gl.uniform1f(gl.getUniformLocation(castProgram, 'g_Intensity'), config.intensity);
      gl.uniform3fv(gl.getUniformLocation(castProgram, 'g_ColorRays'), config.colorRays);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(gaussXProgram);
      bindQuad(gaussXProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
      gl.uniform1i(gl.getUniformLocation(gaussXProgram, 'g_Texture0'), 0);
      gl.uniform4f(gl.getUniformLocation(gaussXProgram, 'g_Texture0Resolution'), 1 / hw, 1 / hh, hw, hh);
      gl.uniform2fv(gl.getUniformLocation(gaussXProgram, 'g_Scale'), config.scale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(gaussYProgram);
      bindQuad(gaussYProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
      gl.uniform1i(gl.getUniformLocation(gaussYProgram, 'g_Texture0'), 0);
      gl.uniform4f(gl.getUniformLocation(gaussYProgram, 'g_Texture0Resolution'), 1 / hw, 1 / hh, hw, hh);
      gl.uniform2fv(gl.getUniformLocation(gaussYProgram, 'g_Scale'), config.scale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(combineProgram);
      bindQuad(combineProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture1'), 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const rafLoop = () => { render(); rafHolder.id = requestAnimationFrame(rafLoop); };
    rafLoop();
    this._reportIssue(`shine aplicado em imagem (pipeline real de 5 passes: corte de brilho + raios direcionais + blur gaussiano + combine aditivo)`);
  }

  async _applyShimmer(img, config, w, h) {
    const gradientImg = config.gradientTexId
      ? await this._loadSceneTexAsImage(config.gradientTexId)
      : await this._loadStockTexAsImage('gradient/gradient_ferro_fluid');
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildShimmerFragSource({ mode: config.mode }), w, h, false);
    const gradTex = FoliageSwayEffect.uploadTexture(gl, gradientImg);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, gradTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture3'), 3);
    gl.uniform1f(gl.getUniformLocation(program, 'u_direction'), config.direction);
    gl.uniform1f(gl.getUniformLocation(program, 'u_scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'u_speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'u_delay'), config.delay);
    gl.uniform1f(gl.getUniformLocation(program, 'u_width'), config.width);
    gl.uniform1f(gl.getUniformLocation(program, 'u_amount'), config.amount);
    gl.uniform1f(gl.getUniformLocation(program, 'u_offset'), config.offset);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_color'), config.color);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`shimmer aplicado em imagem`);
  }

  _applyReflection(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, REFLECTION_VERT, buildReflectionFragSource(), w, h, false);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Direction'), config.direction);
    gl.uniform1f(gl.getUniformLocation(program, 'g_ReflectionOffset'), config.offset);
    gl.uniform1f(gl.getUniformLocation(program, 'g_ReflectionAlpha'), config.alpha);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`reflection aplicado em imagem`);
  }

  async _applyRefraction(img, config, w, h) {
    const normalImg = await this._loadSceneTexAsImage(config.texId);
    const { canvas, gl, program } = this._setupSimplePass(img, REFRACTION_VERT, buildRefractionFragSource(), w, h, false);
    const normalTex = FoliageSwayEffect.uploadTexture(gl, normalImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, normalTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Strength'), config.strength);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`refraction aplicado em imagem`);
  }

  async _applyNitro(img, config, w, h) {
    const noiseImg = await this._loadStockTexAsImage('util/clouds_256');
    const { canvas, gl, program } = this._setupSimplePass(img, NITRO_VERT, buildNitroFragSource({ writeAlpha: config.writeAlpha }), w, h, false);
    const noiseTex = FoliageSwayEffect.uploadTexture(gl, noiseImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    gl.uniform4f(gl.getUniformLocation(program, 'g_Texture0Resolution'), 1 / w, 1 / h, w, h);
    gl.uniform4fv(gl.getUniformLocation(program, 'g_NitroSpeeds'), config.speeds);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_NitroScales'), config.scales);
    gl.uniform1f(gl.getUniformLocation(program, 'g_NitroAlpha'), config.multiply);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_NitroColor0'), config.colorStart);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_NitroColor1'), config.colorEnd);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_NitroRanges'), config.bounds);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`nitro aplicado em imagem`);
  }

  async _applyIris(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, IRIS_VERT, buildIrisFragSource(), w, h, false);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Rough'), config.rough);
    gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseAmount'), config.noiseAmount);
    gl.uniform1f(gl.getUniformLocation(program, 'g_PhaseOffset'), config.phaseOffset);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`iris aplicado em imagem (jitter procedural, sem globo ocular real)`);
  }

  async _applyGlitter(img, config, w, h) {
    const perlinImg = await this._loadStockTexAsImage('util/perlin_256');

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa glitter: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const perlinTex = FoliageSwayEffect.uploadTexture(gl, perlinImg);

    // Render target 256x256 com REPEAT (POT, funciona nativo em WebGL1) —
    // igual à cena real (fbos: "uvs":"repeat").
    const tileTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tileTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const tileFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tileFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tileTex, 0);

    const prepareProgram = linkProgram(GLITTER_PREPARE_VERT, buildGlitterPrepareFragSource());
    const combineProgram = linkProgram(SIMPLE_VERT, buildGlitterCombineFragSource());

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const timeLoc = gl.getUniformLocation(prepareProgram, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      const time = (performance.now() - startTime) / 1000;

      gl.bindFramebuffer(gl.FRAMEBUFFER, tileFbo);
      gl.viewport(0, 0, 256, 256);
      gl.useProgram(prepareProgram);
      bindQuad(prepareProgram);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, perlinTex);
      gl.uniform1i(gl.getUniformLocation(prepareProgram, 'g_Texture1'), 1);
      gl.uniform1f(timeLoc, time);
      gl.uniform1f(gl.getUniformLocation(prepareProgram, 'g_Speed'), config.speed);
      gl.uniform1f(gl.getUniformLocation(prepareProgram, 'g_Density'), config.density);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(combineProgram);
      bindQuad(combineProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture1'), 1);
      gl.uniform2f(gl.getUniformLocation(combineProgram, 'g_AspectScale'), w / h, 1);
      gl.uniform1f(gl.getUniformLocation(combineProgram, 'g_GlitterScale'), config.scale);
      gl.uniform1f(gl.getUniformLocation(combineProgram, 'g_GlitterOpacity'), config.opacity);
      gl.uniform3fv(gl.getUniformLocation(combineProgram, 'g_GlitterColor'), config.color);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`glitter aplicado em imagem (pipeline real de 2 passes: ruído perlin tileável + combine)`);
  }

  // Pipeline de 4 passes idêntico ao _applyLocalContrast (reaproveita os
  // mesmos programas de downsample/gaussiano), só o combine final muda.
  _applyBlur(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa blur: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const bufferA = FoliageSwayEffect.createRenderTarget(gl, qw, qh);
    const bufferB = FoliageSwayEffect.createRenderTarget(gl, qw, qh);

    const downProgram = linkProgram(LOCALCONTRAST_DOWNSAMPLE_VERT, LOCALCONTRAST_DOWNSAMPLE_FRAG);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
    gl.viewport(0, 0, qw, qh);
    gl.useProgram(downProgram);
    bindQuad(downProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(gl.getUniformLocation(downProgram, 'g_Texture0'), 0);
    gl.uniform2f(gl.getUniformLocation(downProgram, 'u_TexelSize'), 1 / w, 1 / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const gaussProgram = linkProgram(buildLocalContrastGaussianVert(config.kernel), buildLocalContrastGaussianFrag(config.kernel));
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.fbo);
    gl.viewport(0, 0, qw, qh);
    gl.useProgram(gaussProgram);
    bindQuad(gaussProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
    gl.uniform1i(gl.getUniformLocation(gaussProgram, 'g_Texture0'), 0);
    gl.uniform2f(gl.getUniformLocation(gaussProgram, 'u_Offset'), config.scale[0] / qw, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
    gl.viewport(0, 0, qw, qh);
    gl.useProgram(gaussProgram);
    bindQuad(gaussProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
    gl.uniform1i(gl.getUniformLocation(gaussProgram, 'g_Texture0'), 0);
    gl.uniform2f(gl.getUniformLocation(gaussProgram, 'u_Offset'), 0, config.scale[1] / qh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const combineProgram = linkProgram(SIMPLE_VERT, buildBlurCombineFragSource({ mono: config.mono, blurAlpha: config.blurAlpha }));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(combineProgram);
    bindQuad(combineProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
    gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture0'), 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture2'), 2);
    gl.uniform3fv(gl.getUniformLocation(combineProgram, 'g_CompositeColor'), config.compositeColor);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`blur aplicado em imagem (pipeline real de 4 passes: downsample 1/4 + blur gaussiano separável)`);
  }

  // 2 passes em resolução cheia (sem downsample) — mais caro, mais fiel.
  _applyBlurPrecise(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa blurprecise: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const bufferA = FoliageSwayEffect.createRenderTarget(gl, w, h);

    const xProgram = linkProgram(buildBlurPreciseVert({ vertical: false }), buildBlurPreciseFragSource({ kernel: config.kernel, blurAlpha: true }));
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(xProgram);
    bindQuad(xProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(gl.getUniformLocation(xProgram, 'g_Texture0'), 0);
    gl.uniform4f(gl.getUniformLocation(xProgram, 'g_Texture0Resolution'), 1 / w, 1 / h, w, h);
    gl.uniform2fv(gl.getUniformLocation(xProgram, 'g_Scale'), config.scale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const yProgram = linkProgram(buildBlurPreciseVert({ vertical: true }), buildBlurPreciseFragSource({ kernel: config.kernel, blurAlpha: config.blurAlpha }));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(yProgram);
    bindQuad(yProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
    gl.uniform1i(gl.getUniformLocation(yProgram, 'g_Texture0'), 0);
    gl.uniform4f(gl.getUniformLocation(yProgram, 'g_Texture0Resolution'), 1 / w, 1 / h, w, h);
    gl.uniform2fv(gl.getUniformLocation(yProgram, 'g_Scale'), config.scale);
    if (!config.blurAlpha) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(yProgram, 'g_Texture1'), 1);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`blurprecise aplicado em imagem (gaussiano separável em resolução cheia, 2 passes)`);
  }

  // Pipeline de 5 passes igual ao _applyShine, mas com o passe "cast"
  // trocado (raio radial/direcional único em vez da cruz de 4 raios) — ver
  // comentário grande em extractGodraysConfig.
  async _applyGodrays(img, config, w, h) {
    const noiseImg = config.noise ? await this._loadStockTexAsImage('util/clouds_256') : null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa godrays: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    const hw = Math.max(1, Math.round(w / 2));
    const hh = Math.max(1, Math.round(h / 2));

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const noiseTex = noiseImg ? FoliageSwayEffect.uploadTexture(gl, noiseImg) : null;
    const bufferA = FoliageSwayEffect.createRenderTarget(gl, hw, hh);
    const bufferB = FoliageSwayEffect.createRenderTarget(gl, hw, hh);

    const downProgram = linkProgram(buildShineDownsampleVert({ noise: config.noise }), buildGodraysDownsampleFragSource({ noise: config.noise }));
    const castProgram = linkProgram(GODRAYS_CAST_VERT, buildGodraysCastFragSource({ caster: config.caster, samples: config.samples }));
    const gaussXProgram = linkProgram(buildShineGaussianVert({ vertical: false }), buildShineGaussianFragSource({ kernel: config.kernel }));
    const gaussYProgram = linkProgram(buildShineGaussianVert({ vertical: true }), buildShineGaussianFragSource({ kernel: config.kernel }));
    const combineProgram = linkProgram(SIMPLE_VERT, buildShineCombineFragSource());

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const timeLocDown = gl.getUniformLocation(downProgram, 'g_Time');

    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const render = () => {
      const time = (performance.now() - startTime) / 1000;

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(downProgram);
      bindQuad(downProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(downProgram, 'g_Texture0'), 0);
      gl.uniform1f(gl.getUniformLocation(downProgram, 'g_Threshold'), config.threshold);
      if (config.noise) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, noiseTex);
        gl.uniform1i(gl.getUniformLocation(downProgram, 'g_Texture2'), 2);
        gl.uniform1f(gl.getUniformLocation(downProgram, 'g_NoiseAmount'), config.noiseAmount);
        gl.uniform1f(gl.getUniformLocation(downProgram, 'g_NoiseSmoothness'), config.noiseSmoothness);
        gl.uniform1f(gl.getUniformLocation(downProgram, 'g_NoiseSpeed'), config.noiseSpeed);
        gl.uniform1f(gl.getUniformLocation(downProgram, 'g_NoiseScale'), config.noiseScale);
        gl.uniform1f(timeLocDown, time);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(castProgram);
      bindQuad(castProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
      gl.uniform1i(gl.getUniformLocation(castProgram, 'g_Texture0'), 0);
      gl.uniform1f(gl.getUniformLocation(castProgram, 'g_Length'), config.length);
      gl.uniform1f(gl.getUniformLocation(castProgram, 'g_Intensity'), config.intensity);
      gl.uniform3fv(gl.getUniformLocation(castProgram, 'g_ColorRays'), config.colorRays);
      if (config.caster === 0) {
        gl.uniform2fv(gl.getUniformLocation(castProgram, 'g_Center'), config.center);
      } else {
        gl.uniform1f(gl.getUniformLocation(castProgram, 'g_Direction'), config.direction);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(gaussXProgram);
      bindQuad(gaussXProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
      gl.uniform1i(gl.getUniformLocation(gaussXProgram, 'g_Texture0'), 0);
      gl.uniform4f(gl.getUniformLocation(gaussXProgram, 'g_Texture0Resolution'), 1 / hw, 1 / hh, hw, hh);
      gl.uniform2fv(gl.getUniformLocation(gaussXProgram, 'g_Scale'), config.scale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.fbo);
      gl.viewport(0, 0, hw, hh);
      gl.useProgram(gaussYProgram);
      bindQuad(gaussYProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
      gl.uniform1i(gl.getUniformLocation(gaussYProgram, 'g_Texture0'), 0);
      gl.uniform4f(gl.getUniformLocation(gaussYProgram, 'g_Texture0Resolution'), 1 / hw, 1 / hh, hw, hh);
      gl.uniform2fv(gl.getUniformLocation(gaussYProgram, 'g_Scale'), config.scale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(combineProgram);
      bindQuad(combineProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture1'), 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    if (config.noise) {
      const rafLoop = () => { render(); rafHolder.id = requestAnimationFrame(rafLoop); };
      rafLoop();
    } else {
      render();
    }
    this._reportIssue(`godrays aplicado em imagem (pipeline real de 5 passes: corte de brilho + raio ${config.caster === 0 ? 'radial' : 'direcional'} + blur gaussiano + combine aditivo)`);
  }

  async _applyCaustics(img, config, w, h) {
    const [voronoiLocalImg, voronoiImg, uniformImg, perlinImg] = await Promise.all([
      this._loadStockTexAsImage('pattern/voronoi_local'),
      this._loadStockTexAsImage('pattern/voronoi'),
      this._loadStockTexAsImage('util/uniform_256'),
      this._loadStockTexAsImage('util/perlin_256'),
    ]);
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildCausticsFragSource({ mode: config.mode }), w, h, false);
    const bindTex = (unit, image, uniformName) => {
      const tex = FoliageSwayEffect.uploadTexture(gl, image);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(program, uniformName), unit);
    };
    bindTex(2, voronoiLocalImg, 'g_Texture2');
    bindTex(5, voronoiImg, 'g_Texture5');
    bindTex(3, uniformImg, 'g_Texture3');
    bindTex(4, perlinImg, 'g_Texture4');
    gl.uniform4f(gl.getUniformLocation(program, 'g_Texture0Resolution'), 1 / w, 1 / h, w, h);
    gl.uniform1f(gl.getUniformLocation(program, 'u_brightness'), config.brightness);
    gl.uniform1f(gl.getUniformLocation(program, 'u_glow'), config.glow);
    gl.uniform1f(gl.getUniformLocation(program, 'u_scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'u_speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'u_timeoffset'), config.timeoffset);
    gl.uniform1f(gl.getUniformLocation(program, 'u_distortion'), config.distortion);
    gl.uniform1f(gl.getUniformLocation(program, 'u_chromatic'), config.chromatic);
    gl.uniform1f(gl.getUniformLocation(program, 'u_blur'), config.blur);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_color1'), config.color1);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_color2'), config.color2);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`watercaustics aplicado em imagem`);
  }

  async _applyWaterFlow(img, config, w, h) {
    const flowImg = config.flowTexId ? await this._loadSceneTexAsImage(config.flowTexId) : await this._loadStockTexAsImage('util/noflow');
    const timeOffsetImg = await this._loadSceneTexAsImage(config.timeOffsetTexId);
    const { canvas, gl, program } = this._setupSimplePass(img, WATERFLOW_VERT, buildWaterFlowFragSource(), w, h, false);
    const flowTex = FoliageSwayEffect.uploadTexture(gl, flowImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, flowTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    const timeOffsetTex = FoliageSwayEffect.uploadTexture(gl, timeOffsetImg);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, timeOffsetTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture2'), 2);
    gl.uniform1f(gl.getUniformLocation(program, 'g_FlowAmp'), config.strength);
    gl.uniform1f(gl.getUniformLocation(program, 'g_FlowPhaseScale'), config.phaseScale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_FlowSpeed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_PhaseFeather'), config.feather);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`waterflow aplicado em imagem`);
  }

  async _applyWaterRipple(img, config, w, h) {
    const normalImg = await this._loadSceneTexAsImage(config.normalTexId);
    const { canvas, gl, program } = this._setupSimplePass(img, WATERRIPPLE_VERT, buildWaterRippleFragSource({ specular: config.specular }), w, h, false);
    const normalTex = FoliageSwayEffect.uploadTexture(gl, normalImg);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, normalTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture2'), 2);
    gl.uniform4f(gl.getUniformLocation(program, 'g_Texture0Resolution'), 1 / w, 1 / h, w, h);
    gl.uniform1f(gl.getUniformLocation(program, 'g_AnimationSpeed'), config.animationSpeed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_ScrollSpeed'), config.scrollSpeed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Direction'), config.direction);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Ratio'), config.ratio);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Strength'), config.strength);
    if (config.specular) {
      gl.uniform1f(gl.getUniformLocation(program, 'g_SpecularPower'), config.specularPower);
      gl.uniform1f(gl.getUniformLocation(program, 'g_SpecularStrength'), config.specularStrength);
      gl.uniform3fv(gl.getUniformLocation(program, 'g_SpecularColor'), config.specularColor);
    }
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`waterripple aplicado em imagem`);
  }

  _applyWaterWaves(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, buildWaterWavesVert({ dualWaves: config.dualWaves }), buildWaterWavesFragSource({ dualWaves: config.dualWaves }), w, h, false);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Direction'), config.direction);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Exponent'), config.exponent);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Strength'), config.strength);
    if (config.dualWaves) {
      gl.uniform1f(gl.getUniformLocation(program, 'g_Direction2'), config.direction2);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Speed2'), config.speed2);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Scale2'), config.scale2);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Offset2'), config.offset2);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Exponent2'), config.exponent2);
    }
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`waterwaves aplicado em imagem`);
  }

  async _applyClouds(img, config, w, h) {
    const cloudsImg = await this._loadStockTexAsImage('util/clouds_256');
    const { canvas, gl, program } = this._setupSimplePass(img, CLOUDS_VERT, buildCloudsFragSource({ shading: config.shading, writeAlpha: config.writeAlpha }), w, h, false);
    const cloudsTex = FoliageSwayEffect.uploadTexture(gl, cloudsImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, cloudsTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    gl.uniform4f(gl.getUniformLocation(program, 'g_Texture0Resolution'), 1 / w, 1 / h, w, h);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_CloudSpeeds'), config.speeds);
    gl.uniform4fv(gl.getUniformLocation(program, 'g_CloudScales'), config.scales);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CloudsAlpha'), config.alpha);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CloudThreshold'), config.threshold);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CloudFeather'), config.feather);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_Color1'), config.color1);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_Color2'), config.color2);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`clouds aplicado em imagem`);
  }

  async _applyCloudMotion(img, config, w, h) {
    const perlinImg = await this._loadStockTexAsImage('util/perlin_256');
    const { canvas, gl, program } = this._setupSimplePass(img, CLOUDMOTION_VERT, buildCloudMotionFragSource(), w, h, false);
    const perlinTex = FoliageSwayEffect.uploadTexture(gl, perlinImg);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, perlinTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture2'), 2);
    gl.uniform4f(gl.getUniformLocation(program, 'g_Texture0Resolution'), 1 / w, 1 / h, w, h);
    gl.uniform1f(gl.getUniformLocation(program, 'u_speed'), config.speed);
    gl.uniform1f(gl.getUniformLocation(program, 'u_scale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'u_scaleX'), config.scaleX);
    gl.uniform1f(gl.getUniformLocation(program, 'u_amount'), config.amount);
    gl.uniform1f(gl.getUniformLocation(program, 'u_direction'), config.direction);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`cloudmotion aplicado em imagem`);
  }

  async _applyFire(img, config, w, h) {
    const [flowImg, cloudsImg] = await Promise.all([
      this._loadStockTexAsImage('util/noflow'),
      this._loadStockTexAsImage('util/clouds_256'),
    ]);
    const { canvas, gl, program } = this._setupSimplePass(img, FIRE_VERT, buildFireFragSource({ refract: config.refract }), w, h, false);
    const flowTex = FoliageSwayEffect.uploadTexture(gl, flowImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, flowTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    const cloudsTex = FoliageSwayEffect.uploadTexture(gl, cloudsImg);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, cloudsTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture2'), 2);
    gl.uniform1f(gl.getUniformLocation(program, 'g_FlowSpeed'), config.flowSpeed);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CloudsAlpha'), config.alpha);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CloudThreshold'), config.threshold);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CloudFeather'), config.feather);
    gl.uniform1f(gl.getUniformLocation(program, 'g_CloudScale'), config.scale);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Distortion'), config.distortion);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_Color1'), config.color1);
    gl.uniform3fv(gl.getUniformLocation(program, 'g_Color2'), config.color2);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    const timeLoc = gl.getUniformLocation(program, 'g_Time');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`fire aplicado em imagem`);
  }

  async _applyDepthParallax(img, config, w, h) {
    const depthImg = config.depthTexId ? await this._loadSceneTexAsImage(config.depthTexId) : await this._loadStockTexAsImage('util/black');
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildDepthParallaxFragSource(), w, h, false);
    const depthTex = FoliageSwayEffect.uploadTexture(gl, depthImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    gl.uniform2fv(gl.getUniformLocation(program, 'g_Scale'), config.scale);

    const left = parseFloat(img.style.left) || 0;
    const top = parseFloat(img.style.top) || 0;
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const offsetLoc = gl.getUniformLocation(program, 'g_ParallaxOffset');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const loop = () => {
      const stagePos = this._getCursorStagePos();
      if (stagePos) {
        gl.uniform2f(offsetLoc, (stagePos.x - left) / w, (stagePos.y - top) / h);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`depthparallax aplicado em imagem (modo básico; occlusion mapping de QUALITY 1/2 não suportado)`);
  }

  async _applyXray(img, config, w, h) {
    const [blendImg, spriteImg] = await Promise.all([
      config.blendTexId ? this._loadSceneTexAsImage(config.blendTexId) : Promise.resolve(null),
      config.spriteTexId ? this._loadSceneTexAsImage(config.spriteTexId) : this._loadStockTexAsImage('particle/halo_6'),
    ]);
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildXrayFragSource(), w, h, false);
    const blendTex = blendImg ? FoliageSwayEffect.uploadTexture(gl, blendImg) : this._createSolidWhiteTexture(gl);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blendTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);
    const spriteTex = FoliageSwayEffect.uploadTexture(gl, spriteImg);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, spriteTex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture2'), 2);
    gl.uniform1f(gl.getUniformLocation(program, 'g_Multiply'), config.multiply);
    gl.uniform1f(gl.getUniformLocation(program, 'g_PointerScale'), config.pointerScale);

    const left = parseFloat(img.style.left) || 0;
    const top = parseFloat(img.style.top) || 0;
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    const cursorLoc = gl.getUniformLocation(program, 'g_CursorUV');
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const loop = () => {
      const stagePos = this._getCursorStagePos();
      if (stagePos) {
        gl.uniform2f(cursorLoc, (stagePos.x - left) / w, (stagePos.y - top) / h);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`xray aplicado em imagem (projeção da câmera 3D aproximada como identidade)`);
  }

  async _applyCursorRipple(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa cursorripple: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    // fit:512 real (maior lado limitado a 512px) — o buffer de força é uma
    // simulação de baixa resolução, não precisa do tamanho real da imagem.
    const simW = Math.min(512, w);
    const simH = Math.max(1, Math.round(simW * h / w));

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const bufferA = FoliageSwayEffect.createRenderTarget(gl, simW, simH);
    const bufferB = FoliageSwayEffect.createRenderTarget(gl, simW, simH);

    // Seed dos 2 buffers como força zero (transparente) — textura WebGL
    // recém-criada não vem zerada garantidamente em todo driver.
    for (const buf of [bufferA, bufferB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buf.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    const applyProgram = linkProgram(CURSORRIPPLE_APPLYFORCE_VERT, CURSORRIPPLE_APPLYFORCE_FRAG);
    const simProgram = linkProgram(SIMPLE_VERT, CURSORRIPPLE_SIMULATE_FRAG);
    const combineProgram = linkProgram(SIMPLE_VERT, CURSORRIPPLE_COMBINE_FRAG);

    const left = parseFloat(img.style.left) || 0;
    const top = parseFloat(img.style.top) || 0;
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    let lastPointer = { x: 0.5, y: 0.5 };
    let lastTime = performance.now();
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);

    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      const stagePos = this._getCursorStagePos();
      const pointer = stagePos ? { x: (stagePos.x - left) / w, y: (stagePos.y - top) / h } : lastPointer;

      // apply_force: injeta impulso do movimento do cursor no buffer anterior
      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferA.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(applyProgram);
      bindQuad(applyProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
      gl.uniform1i(gl.getUniformLocation(applyProgram, 'g_Texture0'), 0);
      gl.uniform1f(gl.getUniformLocation(applyProgram, 'g_Frametime'), dt);
      gl.uniform4f(gl.getUniformLocation(applyProgram, 'g_PointerState'), 0, 0, 0, 0);
      gl.uniform2f(gl.getUniformLocation(applyProgram, 'g_PointerPosition'), pointer.x, pointer.y);
      gl.uniform2f(gl.getUniformLocation(applyProgram, 'g_PointerPositionLast'), lastPointer.x, lastPointer.y);
      gl.uniform4f(gl.getUniformLocation(applyProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
      gl.uniform1f(gl.getUniformLocation(applyProgram, 'g_RippleScale'), config.rippleScale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // simulate_force: decai/difunde/reflete o campo de força nas bordas
      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(simProgram);
      bindQuad(simProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferA.tex);
      gl.uniform1i(gl.getUniformLocation(simProgram, 'g_Texture0'), 0);
      gl.uniform1f(gl.getUniformLocation(simProgram, 'g_Frametime'), dt);
      gl.uniform4f(gl.getUniformLocation(simProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
      gl.uniform1f(gl.getUniformLocation(simProgram, 'g_RippleSpeed'), config.rippleSpeed);
      gl.uniform1f(gl.getUniformLocation(simProgram, 'g_RippleDecay'), config.rippleDecay);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // combine: desloca a própria imagem usando o campo de força como mapa de deslocamento
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(combineProgram);
      bindQuad(combineProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferB.tex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture1'), 1);
      gl.uniform1f(gl.getUniformLocation(combineProgram, 'g_RippleStrength'), config.rippleStrength);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      lastPointer = pointer;
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`cursorripple aplicado em imagem (buffer de força persistente 512px, projeção da câmera 3D aproximada como identidade)`);
  }

  async _applyFluidSimulation(img, config, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    // Diferente do cursorripple (rgba8888/8-bit), esse solver PRECISA de
    // render target em ponto flutuante de verdade (velocidade/pressão têm
    // sinal e passam por 9 iterações de Jacobi + advecção semi-Lagrangiana —
    // 8 bits acumula erro visível rapidamente). Sem a extensão, não dá pra
    // fingir: reportamos e deixamos a imagem original intacta.
    const ext = gl.getExtension('OES_texture_half_float');
    if (!ext) {
      this._reportIssue('fluidsimulation: GPU/driver sem suporte a OES_texture_half_float — efeito não aplicado (solver de fluidos real precisa de textura em ponto flutuante).');
      return;
    }
    const HALF_FLOAT = ext.HALF_FLOAT_OES;

    const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const bindQuad = (program) => {
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    };
    const linkProgram = (vert, frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`falha ao linkar programa fluidsimulation: ${gl.getProgramInfoLog(p)}`);
      return p;
    };

    // fit:256 real (buffers de velocidade/pressão/divergência/curl) e
    // scale:2 real (buffer de dye/cor, metade da resolução da imagem).
    const simW = Math.min(256, w);
    const simH = Math.max(1, Math.round(simW * h / w));
    const dyeW = Math.max(1, Math.round(w / 2));
    const dyeH = Math.max(1, Math.round(h / 2));

    const gradientImg = config.gradientTexId
      ? await this._loadSceneTexAsImage(config.gradientTexId)
      : await this._loadStockTexAsImage('gradient/gradient_fire');

    const sourceTex = FoliageSwayEffect.uploadTexture(gl, img);
    const gradientTex = FoliageSwayEffect.uploadTexture(gl, gradientImg);

    const curlRT = FoliageSwayEffect.createRenderTarget(gl, simW, simH, HALF_FLOAT);
    const divergenceRT = FoliageSwayEffect.createRenderTarget(gl, simW, simH, HALF_FLOAT);
    let velocity1 = FoliageSwayEffect.createRenderTarget(gl, simW, simH, HALF_FLOAT);
    let velocity2 = FoliageSwayEffect.createRenderTarget(gl, simW, simH, HALF_FLOAT);
    let pressure1 = FoliageSwayEffect.createRenderTarget(gl, simW, simH, HALF_FLOAT);
    let pressure2 = FoliageSwayEffect.createRenderTarget(gl, simW, simH, HALF_FLOAT);
    let dye1 = FoliageSwayEffect.createRenderTarget(gl, dyeW, dyeH, HALF_FLOAT);
    let dye2 = FoliageSwayEffect.createRenderTarget(gl, dyeW, dyeH, HALF_FLOAT);

    // Verificação real de que o driver aceita half-float COMO render target
    // (algumas GPUs suportam a textura mas não como anexo de framebuffer) —
    // sem isso, não temos certeza de que o resto do pipeline vai funcionar.
    gl.bindFramebuffer(gl.FRAMEBUFFER, velocity1.fbo);
    const fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (fboStatus !== gl.FRAMEBUFFER_COMPLETE) {
      this._reportIssue('fluidsimulation: render target em half-float incompleto nessa GPU/driver — efeito não aplicado.');
      return;
    }

    for (const buf of [curlRT, divergenceRT, velocity1, velocity2, pressure1, pressure2, dye1, dye2]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buf.fbo);
      gl.viewport(0, 0, buf === dye1 || buf === dye2 ? dyeW : simW, buf === dye1 || buf === dye2 ? dyeH : simH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    const curlProgram = linkProgram(FLUIDSIM_NEIGHBOR_VERT, FLUIDSIM_CURL_FRAG);
    const vorticityProgram = linkProgram(FLUIDSIM_VORTICITY_VERT, FLUIDSIM_VORTICITY_FRAG);
    const divergenceProgram = linkProgram(FLUIDSIM_NEIGHBOR_VERT, FLUIDSIM_DIVERGENCE_FRAG);
    const clearProgram = linkProgram(FLUIDSIM_CLEAR_VERT, FLUIDSIM_CLEAR_FRAG);
    const pressureProgram = linkProgram(FLUIDSIM_NEIGHBOR_VERT, FLUIDSIM_PRESSURE_FRAG);
    const gradSubProgram = linkProgram(FLUIDSIM_NEIGHBOR_VERT, FLUIDSIM_GRADSUB_FRAG);
    const advectVelProgram = linkProgram(SIMPLE_VERT, buildFluidAdvectionFragSource({ dye: false }));
    const advectDyeProgram = linkProgram(SIMPLE_VERT, buildFluidAdvectionFragSource({ dye: true }));
    const combineProgram = linkProgram(SIMPLE_VERT, buildFluidCombineFragSource());

    const left = parseFloat(img.style.left) || 0;
    const top = parseFloat(img.style.top) || 0;
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    let lastPointer = { x: 0.5, y: 0.5 };
    let lastTime = performance.now();
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);

    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      const stagePos = this._getCursorStagePos();
      const pointer = stagePos ? { x: (stagePos.x - left) / w, y: (stagePos.y - top) / h } : lastPointer;

      // 1) curl: escalar de vorticidade a partir da velocidade atual
      gl.bindFramebuffer(gl.FRAMEBUFFER, curlRT.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(curlProgram);
      bindQuad(curlProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velocity1.tex);
      gl.uniform1i(gl.getUniformLocation(curlProgram, 'g_Texture0'), 0);
      gl.uniform4f(gl.getUniformLocation(curlProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 2) vorticity confinement + emissor central + cursor -> nova velocidade
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity2.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(vorticityProgram);
      bindQuad(vorticityProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velocity1.tex);
      gl.uniform1i(gl.getUniformLocation(vorticityProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, curlRT.tex);
      gl.uniform1i(gl.getUniformLocation(vorticityProgram, 'g_Texture1'), 1);
      gl.uniform4f(gl.getUniformLocation(vorticityProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
      gl.uniform1f(gl.getUniformLocation(vorticityProgram, 'g_Frametime'), dt);
      gl.uniform4f(gl.getUniformLocation(vorticityProgram, 'g_PointerState'), 0, 0, 0, 0);
      gl.uniform1f(gl.getUniformLocation(vorticityProgram, 'u_Curl'), config.curl);
      gl.uniform2f(gl.getUniformLocation(vorticityProgram, 'g_PointerPosition'), pointer.x, pointer.y);
      gl.uniform2f(gl.getUniformLocation(vorticityProgram, 'g_PointerPositionLast'), lastPointer.x, lastPointer.y);
      gl.uniform1f(gl.getUniformLocation(vorticityProgram, 'u_CursorInfluence'), config.cursorInfluence);
      gl.uniform2fv(gl.getUniformLocation(vorticityProgram, 'm_EmitterPos0'), config.emitterPos);
      gl.uniform1f(gl.getUniformLocation(vorticityProgram, 'm_EmitterAngle0'), config.emitterAngle);
      gl.uniform1f(gl.getUniformLocation(vorticityProgram, 'm_EmitterSize0'), config.emitterSize);
      gl.uniform1f(gl.getUniformLocation(vorticityProgram, 'm_EmitterSpeed0'), config.emitterSpeed);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 3) divergence da velocidade
      gl.bindFramebuffer(gl.FRAMEBUFFER, divergenceRT.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(divergenceProgram);
      bindQuad(divergenceProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velocity2.tex);
      gl.uniform1i(gl.getUniformLocation(divergenceProgram, 'g_Texture0'), 0);
      gl.uniform4f(gl.getUniformLocation(divergenceProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 4) clear: decai a pressão do frame anterior
      gl.bindFramebuffer(gl.FRAMEBUFFER, pressure2.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(clearProgram);
      bindQuad(clearProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pressure1.tex);
      gl.uniform1i(gl.getUniformLocation(clearProgram, 'g_Texture0'), 0);
      gl.uniform1f(gl.getUniformLocation(clearProgram, 'g_Frametime'), dt);
      gl.uniform1f(gl.getUniformLocation(clearProgram, 'u_Pressure'), config.pressureDecay);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 5) 9 iterações de Jacobi (real, confirmado no effect.json) resolvendo a pressão
      for (let i = 0; i < 9; i++) {
        const target = i % 2 === 0 ? pressure1 : pressure2;
        const source = i % 2 === 0 ? pressure2 : pressure1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, simW, simH);
        gl.useProgram(pressureProgram);
        bindQuad(pressureProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, divergenceRT.tex);
        gl.uniform1i(gl.getUniformLocation(pressureProgram, 'g_Texture0'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, source.tex);
        gl.uniform1i(gl.getUniformLocation(pressureProgram, 'g_Texture1'), 1);
        gl.uniform4f(gl.getUniformLocation(pressureProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      // 9 iterações (ímpar) terminam com o resultado mais recente em pressure1

      // 6) gradientsubtract: projeta a velocidade (torna livre de divergência)
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity1.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(gradSubProgram);
      bindQuad(gradSubProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pressure1.tex);
      gl.uniform1i(gl.getUniformLocation(gradSubProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, velocity2.tex);
      gl.uniform1i(gl.getUniformLocation(gradSubProgram, 'g_Texture1'), 1);
      gl.uniform4f(gl.getUniformLocation(gradSubProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 7) advecção da própria velocidade (self-advection, DYE=0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity2.fbo);
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(advectVelProgram);
      bindQuad(advectVelProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velocity1.tex);
      gl.uniform1i(gl.getUniformLocation(advectVelProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, velocity1.tex);
      gl.uniform1i(gl.getUniformLocation(advectVelProgram, 'g_Texture1'), 1);
      gl.uniform4f(gl.getUniformLocation(advectVelProgram, 'g_Texture0Resolution'), 1 / simW, 1 / simH, simW, simH);
      gl.uniform1f(gl.getUniformLocation(advectVelProgram, 'g_Frametime'), dt);
      gl.uniform1f(gl.getUniformLocation(advectVelProgram, 'u_Viscosity'), config.velViscosity);
      gl.uniform1f(gl.getUniformLocation(advectVelProgram, 'm_Dissipation'), config.velDissipation);
      gl.uniform1f(gl.getUniformLocation(advectVelProgram, 'u_Lifetime'), config.lifetime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 8) advecção do dye/cor (DYE=1), com o emissor central injetando cor
      gl.bindFramebuffer(gl.FRAMEBUFFER, dye2.fbo);
      gl.viewport(0, 0, dyeW, dyeH);
      gl.useProgram(advectDyeProgram);
      bindQuad(advectDyeProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velocity2.tex);
      gl.uniform1i(gl.getUniformLocation(advectDyeProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dye1.tex);
      gl.uniform1i(gl.getUniformLocation(advectDyeProgram, 'g_Texture1'), 1);
      gl.uniform4f(gl.getUniformLocation(advectDyeProgram, 'g_Texture0Resolution'), 1 / dyeW, 1 / dyeH, dyeW, dyeH);
      gl.uniform1f(gl.getUniformLocation(advectDyeProgram, 'g_Frametime'), dt);
      gl.uniform1f(gl.getUniformLocation(advectDyeProgram, 'u_Dissipation'), config.dyeDissipationFactor);
      gl.uniform1f(gl.getUniformLocation(advectDyeProgram, 'm_Dissipation'), config.dyeDissipation);
      gl.uniform1f(gl.getUniformLocation(advectDyeProgram, 'u_Lifetime'), config.lifetime);
      gl.uniform2fv(gl.getUniformLocation(advectDyeProgram, 'm_EmitterPos0'), config.emitterPos);
      gl.uniform1f(gl.getUniformLocation(advectDyeProgram, 'm_EmitterSize0'), config.emitterSize);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 9) combine: dye -> cor via gradient map, aditivo sobre a própria imagem
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(combineProgram);
      bindQuad(combineProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dye2.tex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture0'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture1'), 1);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, gradientTex);
      gl.uniform1i(gl.getUniformLocation(combineProgram, 'g_Texture3'), 3);
      gl.uniform1f(gl.getUniformLocation(combineProgram, 'u_Brightness'), config.brightness);
      gl.uniform1f(gl.getUniformLocation(combineProgram, 'u_Alpha'), config.alpha);
      gl.uniform1f(gl.getUniformLocation(combineProgram, 'u_Feather'), config.feather);
      gl.uniform1f(gl.getUniformLocation(combineProgram, 'u_HueShift'), config.hueShift);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // "swap" reais do effect.json: o buffer final de velocidade/dye vira o
      // "atual" do próximo frame — aqui é só trocar as referências JS.
      [velocity1, velocity2] = [velocity2, velocity1];
      [dye1, dye2] = [dye2, dye1];

      lastPointer = pointer;
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
    this._reportIssue(`fluidsimulation aplicado em imagem (solver real de fluidos, 15 passes/frame, buffers half-float ${simW}x${simH} + dye ${dyeW}x${dyeH}, projeção da câmera 3D aproximada como identidade)`);
  }

  _applyBlurRadial(img, config, w, h) {
    const { canvas, gl, program } = this._setupSimplePass(img, SIMPLE_VERT, buildBlurRadialFragSource({ kernel: config.kernel, blurAlpha: config.blurAlpha }), w, h, false);
    gl.uniform1f(gl.getUniformLocation(program, 'u_Scale'), config.scale);
    gl.uniform2fv(gl.getUniformLocation(program, 'u_Center'), config.center);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (img.parentNode) img.parentNode.replaceChild(canvas, img);
    this._reportIssue(`blurradial aplicado em imagem`);
  }

  // Desenha a malha do puppet (bind pose, sem física/IK — ver decodePuppetMdl)
  // via WebGL: cada vértice já traz x/y no espaço de pixel da própria textura
  // do material (validado byte-exato contra 3 arquivos reais), então
  // derivamos nosso próprio UV a partir disso em vez de confiar no campo uv
  // do arquivo (que parece referenciar um atlas separado que não temos).
  // Posiciona a malha inteira na mesma caixa origin/size já usada pra imagem
  // plana. AINDA NÃO VALIDADO VISUALMENTE — primeira tentativa real de
  // desenhar esse formato; a orientação (cima/baixo, espelhado) é a suspeita
  // mais provável de bug, pelo mesmo motivo que já pegou o foliagesway antes.
  _buildPuppetObject(obj, model) {
    const texResult = this._resolveMaterialTexturePng(model);
    if (!texResult || texResult.flat) return false; // puppet sem atlas de textura não tem como desenhar

    const mdlPath = path.join(this.sceneDir, model.puppet);
    if (!fs.existsSync(mdlPath)) return false;

    let mesh;
    try {
      mesh = decodePuppetMdl(fs.readFileSync(mdlPath));
    } catch (err) {
      this._reportIssue(`puppet "${obj.name}" (${model.puppet}) não decodificou: ${err.message}`);
      return false;
    }

    const [w, h]   = (obj.size   || `${this.designWidth} ${this.designHeight}`).split(' ').map(Number);
    const [ox, oy] = this._resolveOrigin(obj);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = `position:absolute; left:${ox - w / 2}px; top:${this._screenTop(oy, h)}px; width:${w}px; height:${h}px;`;
    this.stage.appendChild(canvas);

    const gl = canvas.getContext('webgl');
    if (!gl) {
      this._reportIssue(`puppet "${obj.name}": WebGL indisponível nesta janela, camada não desenhada`);
      return false;
    }

    const img = new Image();
    img.onload = () => {
      try {
        this._drawPuppetMesh(gl, img, mesh, w, h);
        this._reportIssue(`puppet "${obj.name}" (${model.puppet}) desenhado em pose de repouso, sem articulação/física — ${mesh.vertices.length} vértices, ${Math.round(mesh.indices.length / 3)} triângulos`);
      } catch (err) {
        this._reportIssue(`puppet "${obj.name}": falha ao desenhar malha: ${err.message}`);
      }
    };
    img.onerror = () => this._reportIssue(`puppet "${obj.name}": textura base não carregou`);
    img.src = texResult.src;
    return true;
  }

  _drawPuppetMesh(gl, img, mesh, boxW, boxH) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, PUPPET_VERT);
    const fsShader = compileShader(gl, gl.FRAGMENT_SHADER, PUPPET_FRAG);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fsShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    // texPixelW/H: a textura decodificada é o próprio espaço em que os
    // vértices já estão (ver decodePuppetMdl) — usa as dimensões reais da
    // imagem carregada, não a caixa de destino (obj.size), pra derivar UV.
    const texPixelW = img.naturalWidth  || boxW;
    const texPixelH = img.naturalHeight || boxH;

    // Confirmado visualmente (decodificamos a textura real e comparamos
    // contra o bbox dos vértices): a origem NÃO é o canto superior esquerdo
    // da textura, é o CENTRO — x/y variam pra ambos os lados de 0 (ex: a
    // malha do corpo inteiro vai de x∈[-719,724] y∈[-1038,1035] numa
    // textura de 1415×2047, quase perfeitamente simétrica). y positivo é
    // "pra cima" (cabeça), y negativo é "pra baixo" (pés) — por isso a
    // malha aparecia cortada/pendurada do topo: a primeira versão assumia
    // x/y∈[0,tex] e jogava metade dos vértices pra fora da tela.
    const n = mesh.vertices.length;
    const positions = new Float32Array(n * 2);
    const uvs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = mesh.vertices[i];
      positions[i * 2]     = v.x / (texPixelW / 2);
      positions[i * 2 + 1] = v.y / (texPixelH / 2);
      // +0.5 recentraliza pro padrão UV [0,1]; sem inverter o eixo Y aqui
      // porque o upload da textura (uploadTexture, UNPACK_FLIP_Y_WEBGL) já
      // faz esse flip por conta própria — os dois juntos que dão a
      // orientação certa.
      uvs[i * 2]     = 0.5 + v.x / texPixelW;
      uvs[i * 2 + 1] = 0.5 + v.y / texPixelH;
    }

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_Position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    const tex = FoliageSwayEffect.uploadTexture(gl, img);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(program, 'g_Texture0'), 0);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
  }

  // Objeto "shape":"quad" sem image/text/particle — hoje o único conteúdo
  // real encontrado nesses objetos é o efeito "lightshafts" (feixe de
  // luz/godrays), então isso é o que sabemos desenhar; qualquer outro
  // efeito (ou nenhum) faz o objeto continuar invisível, mas agora com um
  // aviso no Log em vez de sumir sem explicação nenhuma.
  _buildShapeObject(obj) {
    if (obj.shape !== 'quad') {
      this._reportIssue(`objeto "${obj.name}" é shape "${obj.shape}" (não "quad") — não suportado`);
      return;
    }
    const visibleEffects = (obj.effects || []).filter((eff) => this._isVisible(eff));
    const config = extractLightShaftsConfig(visibleEffects);
    if (!config) {
      this._reportIssue(`objeto "${obj.name}" é uma camada shape sem efeito reconhecido — nada pra desenhar`);
      return;
    }
    if (config.unsupported) {
      this._reportIssue(`objeto "${obj.name}" usa lightshafts em modo não suportado: ${config.unsupported}`);
      return;
    }

    const [w, h] = (obj.size || `${this.designWidth} ${this.designHeight}`).split(' ').map(Number);
    const [ox, oy] = this._resolveOrigin(obj);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = `position:absolute; left:${ox - w / 2}px; top:${this._screenTop(oy, h)}px; width:${w}px; height:${h}px; pointer-events:none;`;
    this.stage.appendChild(canvas);

    const gl = canvas.getContext('webgl');
    if (!gl) {
      this._reportIssue(`objeto "${obj.name}" (lightshafts): WebGL indisponível nesta janela`);
      return;
    }

    const weAssets = getWEAssetsRoot();
    if (!weAssets) {
      this._reportIssue(`objeto "${obj.name}" (lightshafts): instalação da Wallpaper Engine não encontrada (necessária pro ruído/gradiente padrão)`);
      return;
    }

    Promise.resolve().then(async () => {
      const loadStockTex = async (relPath) => {
        const png = decodeTexToPng(fs.readFileSync(path.join(weAssets, 'materials', relPath)));
        if (!png) throw new Error(`textura padrão "${relPath}" não decodificou`);
        return new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error(`falha ao decodificar PNG intermediário de "${relPath}"`));
          im.src = 'data:image/png;base64,' + png.toString('base64');
        });
      };

      const noiseImg = await loadStockTex('util/noise.tex');
      const gradientImg = config.rendering === 1 ? await loadStockTex('gradient/gradient_iridescent.tex') : null;

      const frag = buildLightShaftsFragSource(config);
      const vs = compileShader(gl, gl.VERTEX_SHADER, LIGHTSHAFTS_VERT);
      const fs_ = compileShader(gl, gl.FRAGMENT_SHADER, frag);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs_);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`falha ao linkar programa lightshafts: ${gl.getProgramInfoLog(program)}`);
      }
      gl.useProgram(program);

      const verts = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      const posLoc = gl.getAttribLocation(program, 'a_Position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      const uvLoc = gl.getAttribLocation(program, 'a_TexCoord');
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

      const xformRows = invert3x3Rows(...squareToQuadRows(config.point0, config.point1, config.point2, config.point3));
      gl.uniform3fv(gl.getUniformLocation(program, 'u_XformRow0'), xformRows[0]);
      gl.uniform3fv(gl.getUniformLocation(program, 'u_XformRow1'), xformRows[1]);
      gl.uniform3fv(gl.getUniformLocation(program, 'u_XformRow2'), xformRows[2]);

      const noiseTex = FoliageSwayEffect.uploadTexture(gl, noiseImg);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.uniform1i(gl.getUniformLocation(program, 'g_Texture1'), 1);

      if (gradientImg) {
        const gradientTex = FoliageSwayEffect.uploadTexture(gl, gradientImg);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, gradientTex);
        gl.uniform1i(gl.getUniformLocation(program, 'g_Texture2'), 2);
      }

      gl.uniform1f(gl.getUniformLocation(program, 'g_Speed'), config.speed);
      gl.uniform2fv(gl.getUniformLocation(program, 'g_Scale'), config.scale);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Smoothness'), config.smoothness);
      gl.uniform2fv(gl.getUniformLocation(program, 'g_Feather'), config.feather);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Radius'), config.radius);
      gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseScale'), config.noiseScale);
      gl.uniform1f(gl.getUniformLocation(program, 'g_NoiseAmount'), config.noiseAmount);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Intensity'), config.intensity);
      gl.uniform1f(gl.getUniformLocation(program, 'g_Exponent'), config.exponent);
      gl.uniform3fv(gl.getUniformLocation(program, 'g_ColorRaysStart'), config.colorStart);
      gl.uniform3fv(gl.getUniformLocation(program, 'g_ColorRaysEnd'), config.colorEnd);
      gl.uniform1f(gl.getUniformLocation(program, 'g_StartAngle'), config.startAngle);
      gl.uniform1f(gl.getUniformLocation(program, 'g_EndAngle'), config.endAngle);

      const timeLoc = gl.getUniformLocation(program, 'g_Time');
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // alfa já pré-multiplicado (fx aplicado em finalColor e no alfa juntos)

      const rafHolder = { id: null };
      this._foliageRafHolders.push(rafHolder);
      const startTime = performance.now();
      const loop = () => {
        gl.uniform1f(timeLoc, (performance.now() - startTime) / 1000);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        rafHolder.id = requestAnimationFrame(loop);
      };
      loop();

      this._reportIssue(`lightshafts "${obj.name}" desenhando (modo ${config.rayMode}, canto ${config.rayCorner}) — orientação/posição ainda não confirmada visualmente`);
    }).catch((err) => {
      this._reportIssue(`objeto "${obj.name}" (lightshafts) falhou: ${err.message}`);
    });
  }

  // Substitui a <img> parada por um <canvas> WebGL rodando o shader real de
  // "foliagesway" (ver FoliageSwayEffect acima) — prova de conceito de que
  // dá pra rodar o efeito de verdade em vez de aproximar com CSS. Se
  // qualquer etapa falhar (sem WebGL, textura de máscara/ruído não decodifica,
  // shader não compila), mantém a <img> parada como já era antes — nunca
  // piora o que já funcionava.
  async _applyFoliageSway(img, passes, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = img.style.cssText;
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL indisponível nesta janela');

    const effect = new FoliageSwayEffect(gl);

    // Máscara de cada passe: sempre dentro do pacote da própria cena (não é
    // um asset padrão da WE, é pintada especificamente pra essa cena).
    const maskTextures = passes.map((pass) => {
      const maskPath = path.join(this.sceneDir, 'materials', pass.maskRel + '.tex');
      const png = decodeTexToPng(fs.readFileSync(maskPath));
      if (!png) throw new Error(`máscara "${pass.maskRel}" não decodificou`);
      return png;
    });

    // Ruído: asset padrão da própria WE (materials/util/noise.tex), igual ao
    // que já fazemos pra texturas de partícula em loadParticleTexture.
    const weAssets = getWEAssetsRoot();
    if (!weAssets) throw new Error('instalação da Wallpaper Engine não encontrada (necessária pro ruído padrão)');
    const noisePath = path.join(weAssets, 'materials', 'util', 'noise.tex');
    const noisePng = decodeTexToPng(fs.readFileSync(noisePath));
    if (!noisePng) throw new Error('textura de ruído padrão não decodificou');

    const loadImg = (buf) => new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('falha ao decodificar PNG intermediário'));
      im.src = 'data:image/png;base64,' + buf.toString('base64');
    });

    const [noiseImg, ...maskImgs] = await Promise.all([
      loadImg(noisePng),
      ...maskTextures.map(loadImg),
    ]);

    const baseTex = FoliageSwayEffect.uploadTexture(gl, img); // usa o <img> já carregado (onload já disparou), sem redecodificar
    const noiseTex = FoliageSwayEffect.uploadTexture(gl, noiseImg);
    const passesGl = passes.map((pass, i) => ({ ...pass, maskTex: FoliageSwayEffect.uploadTexture(gl, maskImgs[i]) }));

    // Cadeia de passes: cada instância real (Akame tem 3) lê a saída da
    // anterior e escreve na próxima — a última desenha direto no canvas
    // visível. Precisa de 2 texturas intermediárias (ping-pong) só quando
    // há mais de 1 passe.
    const targets = passesGl.length > 1
      ? [FoliageSwayEffect.createRenderTarget(gl, w, h), FoliageSwayEffect.createRenderTarget(gl, w, h)]
      : [];

    if (img.parentNode) img.parentNode.replaceChild(canvas, img);

    // Um "holder" mutável em vez de empilhar ids: cada frame só substitui o
    // id anterior, e destroy() cancela o que estiver lá na hora — sem isso o
    // array cresceria sem limite (um id novo por frame, pra sempre).
    const rafHolder = { id: null };
    this._foliageRafHolders.push(rafHolder);
    const startTime = performance.now();
    const loop = () => {
      const time = (performance.now() - startTime) / 1000;
      let currentInput = baseTex;
      for (let i = 0; i < passesGl.length; i++) {
        const isLast = i === passesGl.length - 1;
        const targetFbo = isLast ? null : targets[i % 2].fbo;
        effect.renderPass(currentInput, noiseTex, passesGl[i], w, h, time, targetFbo);
        if (!isLast) currentInput = targets[i % 2].tex;
      }
      rafHolder.id = requestAnimationFrame(loop);
    };
    loop();
  }

  _loadFont(fontRelPath) {
    if (this.fontFamilies.has(fontRelPath)) return this.fontFamilies.get(fontRelPath);
    const family = 'we-font-' + this.fontFamilies.size;
    const fullPath = path.join(this.sceneDir, fontRelPath);
    const style = document.createElement('style');
    style.textContent = `@font-face { font-family: '${family}'; src: url('file:///${fullPath.replace(/\\/g, '/')}'); }`;
    document.head.appendChild(style);
    this.fontFamilies.set(fontRelPath, family);
    return family;
  }

  _buildTextObject(obj) {
    const [w, h] = (obj.size || '400 200').split(' ').map(Number);
    const override = this.overrides[obj.name];

    let ox, oy, fontSize;
    if (override) {
      [ox, oy] = override.origin.split(' ').map(Number);
      fontSize = override.fontSize;
    } else {
      const [sx] = csvVec(obj.scale, [1, 1, 1]);
      [ox, oy] = this._resolveOrigin(obj);
      fontSize = (obj.pointsize || 32) * (sx || 1);
    }

    const family = obj.font ? this._loadFont(obj.font) : null;
    const baseStyle = `position:absolute; left:${ox - w / 2}px; top:${this._screenTop(oy, h)}px; width:${w}px; height:${h}px;
      display:flex; align-items:${obj.verticalalign === 'center' ? 'center' : 'flex-start'};
      justify-content:${obj.horizontalalign === 'center' ? 'center' : 'flex-start'};
      font-family:${family ? `'${family}'` : 'sans-serif'}; font-size:${fontSize}px;
      color:#fff; white-space:pre; text-align:${obj.horizontalalign || 'left'};`;

    // WE's text objects reference a real two-pass Gaussian blur post-effect
    // (see scene.json's "effects" block) that gives the text a soft glow so
    // it reads over busy backgrounds. We don't have their exact per-object
    // render-target texel size, but the kernel itself is a real, standard
    // Gaussian (confirmed from the actual common_blur.h in the Wallpaper
    // Engine install — blur13a, sigma≈1.96 texels), so a blurred duplicate
    // layer using the browser's native (also Gaussian) `filter: blur()` is a
    // faithful reproduction of the *technique*, calibrated off the effect's
    // real `scale` value rather than a guess.
    const blurScale = this._getBlurScale(obj);
    let glowEl = null;
    if (blurScale > 0) {
      glowEl = document.createElement('div');
      glowEl.style.cssText = baseStyle + `filter: blur(${(blurScale * 6).toFixed(1)}px); pointer-events: none;`;
      this.stage.appendChild(glowEl);
    }

    const el = document.createElement('div');
    el.style.cssText = baseStyle + `text-shadow: 0 1px 3px rgba(0,0,0,0.7);`;
    this.stage.appendChild(el);

    let updateFn = null;
    try {
      if (obj.text.script) updateFn = compileWeTextScript(obj.text.script, obj.text.scriptproperties || {});
    } catch (err) {
      console.warn('[we-scene] failed to compile text script for', obj.name, err.message);
    }

    const initialValue = obj.text.value || '';
    this.textEntries.push({ el, glowEl, objName: obj.name, w, h, fontSize, updateFn, value: initialValue });
    el.textContent = initialValue;
    if (glowEl) glowEl.textContent = initialValue;
  }

  // Real per-object blur intensity, read from scene.json's own effect config
  // (effects[].passes[0].constantshadervalues.scale) — not a guess.
  _getBlurScale(obj) {
    const effect = (obj.effects || []).filter((e) => this._isVisible(e)).find(e => e.file && e.file.toLowerCase().includes('blur'));
    const scaleRaw = effect && effect.passes && effect.passes[0] &&
      effect.passes[0].constantshadervalues && effect.passes[0].constantshadervalues.scale;
    if (!scaleRaw) return 0;
    const [sx] = csvVec(scaleRaw, [0, 0]);
    return sx || 0;
  }

  // ---- Manual layout editing (drag to move, wheel to resize) ----
  // Reverse-engineering WE's exact pixel formula for every field is a moving
  // target with no documentation; letting the user drag/scroll to the look
  // they want sidesteps that entirely and is saved per-wallpaper.
  // `onSaveRequest` is called (no args) when the user clicks the on-screen
  // "Salvar e sair" button. We can't use a keyboard shortcut here — wallpaper
  // windows are created with `focusable: false` on purpose (so they never
  // steal focus from normal desktop use), which means they never receive
  // keydown events at all, no matter what's pressed.
  enterEditMode(onSaveRequest) {
    this.editing = true;
    for (const entry of this.textEntries) {
      entry.el.style.pointerEvents = 'auto';
      entry.el.style.cursor = 'move';
      entry.el.style.outline = '1px dashed rgba(255,255,255,0.6)';
      if (!entry._dragBound) {
        this._bindDragAndResize(entry);
        entry._dragBound = true;
      }
    }

    this._banner = document.createElement('div');
    this._banner.style.cssText = `position:fixed; top:16px; left:50%; transform:translateX(-50%); z-index:1000;
      background:rgba(0,0,0,0.75); color:#fff; font-family:sans-serif; font-size:14px; padding:10px 18px;
      border-radius:8px; pointer-events:none; text-align:center; line-height:1.5;
      display:flex; align-items:center; gap:14px;`;

    const label = document.createElement('span');
    label.textContent = 'Arraste os textos para reposicionar · Roda do mouse para aumentar/diminuir';
    this._banner.appendChild(label);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 Salvar e sair';
    saveBtn.style.cssText = `pointer-events:auto; cursor:pointer; background:#5a54f9; color:#fff; border:none; padding:6px 14px; border-radius:6px; font-size:13px; font-weight:600;`;
    saveBtn.addEventListener('click', () => { if (onSaveRequest) onSaveRequest(); });
    this._banner.appendChild(saveBtn);

    this.container.appendChild(this._banner);
  }

  exitEditMode() {
    this.editing = false;
    const overrides = {};
    for (const entry of this.textEntries) {
      entry.el.style.pointerEvents = '';
      entry.el.style.cursor = '';
      entry.el.style.outline = '';

      const left = parseFloat(entry.el.style.left);
      const top  = parseFloat(entry.el.style.top);
      const ox = left + entry.w / 2;
      const oy = this.designHeight - (top + entry.h / 2);
      overrides[entry.objName] = {
        origin: `${ox.toFixed(2)} ${oy.toFixed(2)} 0.00000`,
        fontSize: entry.fontSize,
      };
    }
    if (this._banner) { this._banner.remove(); this._banner = null; }
    return overrides;
  }

  _bindDragAndResize(entry) {
    const el = entry.el;

    el.addEventListener('mousedown', (e) => {
      if (!this.editing) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = parseFloat(el.style.left);
      const startTop  = parseFloat(el.style.top);

      const onMove = (me) => {
        const dx = (me.clientX - startX) / this._currentScale;
        const dy = (me.clientY - startY) / this._currentScale;
        el.style.left = (startLeft + dx) + 'px';
        el.style.top  = (startTop + dy) + 'px';
        if (entry.glowEl) { entry.glowEl.style.left = el.style.left; entry.glowEl.style.top = el.style.top; }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    el.addEventListener('wheel', (e) => {
      if (!this.editing) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.5 : -1.5;
      entry.fontSize = Math.max(4, entry.fontSize + delta);
      el.style.fontSize = entry.fontSize + 'px';
      if (entry.glowEl) entry.glowEl.style.fontSize = entry.fontSize + 'px';
    }, { passive: false });
  }

  _tick() {
    for (const entry of this.textEntries) {
      if (!entry.updateFn) continue;
      try {
        entry.value = entry.updateFn(entry.value);
        entry.el.textContent = entry.value;
        if (entry.glowEl) entry.glowEl.textContent = entry.value;
      } catch (err) {
        console.warn('[we-scene] text update failed:', err.message);
      }
    }
  }

  resize() {
    if (this.stage) this._applyScale();
  }

  destroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._particleRafId) { cancelAnimationFrame(this._particleRafId); this._particleRafId = null; }
    for (const holder of this._foliageRafHolders) { if (holder.id) cancelAnimationFrame(holder.id); }
    this._foliageRafHolders = [];
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    this.container.innerHTML = '';
    this.textEntries = [];
    this.particleSystems = [];
  }
}

module.exports = { WeScene, compileWeTextScript };
