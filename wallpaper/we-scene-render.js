// Renders an unpacked Wallpaper Engine scene folder (background image +
// live text objects + particle effects) using plain DOM/CSS/Canvas instead
// of their proprietary engine. Custom shader effects and 3D models are still
// silently skipped — those would need real GPU shader emulation, not
// attempted here.
const fs   = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { decodeTexToPng, decodePuppetMdl } = require('../src/we-scene.js');

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

  static createRenderTarget(gl, width, height) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    const rate = emitter && emitter.rate ? emitter.rate : 5;
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
  _getTintedSprite(color) {
    const key = `${color[0] | 0},${color[1] | 0},${color[2] | 0}`;
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
  }

  _reportIssue(message) {
    reportSceneIssue(this.label, message);
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
      if (!this._isVisible(obj)) {
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
      if (typeof v.user === 'string') return !!this.propValues[v.user];
      if (v.user && typeof v.user === 'object' && v.user.name) {
        return String(this.propValues[v.user.name]) === String(v.user.condition);
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

  _resolveMaterialTexturePng(model) {
    const materialPath = path.join(this.sceneDir, model.material);
    const material = JSON.parse(fs.readFileSync(materialPath, 'utf8'));
    const texId = material.passes && material.passes[0] && material.passes[0].textures && material.passes[0].textures[0];
    if (!texId) return null;
    const pngPath = path.join(this.sceneDir, 'materials', texId + '.tex.png');
    return fs.existsSync(pngPath) ? pngPath : null;
  }

  // Wallpaper Engine's scene coordinate space has Y increasing upward (same
  // convention as its 3D camera — see scene.json's camera.up = "0 1 0"), but
  // CSS `top` increases downward. Flip it once here for every object.
  _screenTop(oy, h) {
    return (this.designHeight - oy) - h / 2;
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

  _buildImageObject(obj) {
    const modelPath = path.join(this.sceneDir, obj.image);
    let model;
    try { model = JSON.parse(fs.readFileSync(modelPath, 'utf8')); } catch { return false; }

    if (model.puppet) return this._buildPuppetObject(obj, model);

    const pngPath = this._resolveMaterialTexturePng(model);
    if (!pngPath) return false;

    const [w, h]   = (obj.size   || `${this.designWidth} ${this.designHeight}`).split(' ').map(Number);
    const [ox, oy] = this._resolveOrigin(obj);

    const img = document.createElement('img');
    img.src = 'file:///' + pngPath.replace(/\\/g, '/');
    img.style.cssText = `position:absolute; left:${ox - w / 2}px; top:${this._screenTop(oy, h)}px; width:${w}px; height:${h}px; object-fit:cover;`;
    this.stage.appendChild(img);

    const foliagePasses = extractFoliageSwayPasses(obj.effects);
    if (foliagePasses.length) {
      img.onload = () => {
        this._applyFoliageSway(img, foliagePasses, w, h).catch((err) => {
          this._reportIssue(`efeito foliagesway em "${obj.name}" falhou, mantendo imagem parada: ${err.message}`);
        });
      };
    }
    return true;
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
    const pngPath = this._resolveMaterialTexturePng(model);
    if (!pngPath) return false;

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
    img.src = 'file:///' + pngPath.replace(/\\/g, '/');
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
    const config = extractLightShaftsConfig(obj.effects);
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
      const [sx] = (obj.scale || '1 1 1').split(' ').map(Number);
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
    const effect = (obj.effects || []).find(e => e.file && e.file.toLowerCase().includes('blur'));
    const scaleStr = effect && effect.passes && effect.passes[0] &&
      effect.passes[0].constantshadervalues && effect.passes[0].constantshadervalues.scale;
    if (!scaleStr) return 0;
    const [sx] = scaleStr.split(' ').map(Number);
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
