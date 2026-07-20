// Compilador genérico de shaders de efeitos CUSTOM da Wallpaper Engine.
//
// Os ~48 efeitos oficiais (blur, godrays, fluid simulation, cursor-ripple
// etc., em we-scene-render.js) já são portados à mão: alguém leu o
// .frag/.vert real uma vez e reescreveu o GLSL manualmente. Isso não escala
// pros efeitos PRÓPRIOS de itens da Steam Workshop (a esmagadora maioria das
// ~2.7 milhões de cenas) — hoje esses simplesmente não renderizam nada.
//
// Este módulo lê o .frag/.vert REAL (do cache da própria cena, ou da
// instalação local da Wallpaper Engine) e resolve #include/combos/macros na
// hora, sem reescrever nada à mão. Nunca vendoriza arquivos da WE no
// repositório — só lê em runtime, do mesmo jeito que getWEAssetsRoot() já
// faz pra texturas/materiais em we-scene-render.js.
//
// O dialeto real (confirmado lendo waterripple.frag, tint.frag/.vert,
// genericimage4.*, common_blending.h da instalação local) é GLSL ES com uma
// camada de macros ao estilo HLSL por cima (mul, texSample2D, CAST*, frac,
// saturate) e anotações `// [COMBO] {...}` / `// {"material":...}` que
// documentam o próprio schema de combo/parâmetro — não precisa adivinhar
// defaults. Os `#if COMBO == N` reais são deixados como diretivas de
// pré-processador de verdade e resolvidos pelo compilador GLSL-ES do
// próprio WebGL — só precisamos gerar o `#define` certo antes.
const fs = require('fs');
const path = require('path');

function readTextRelPath(sceneDir, weAssetsRoot, relPath) {
  const localPath = path.join(sceneDir, relPath);
  if (fs.existsSync(localPath)) return fs.readFileSync(localPath, 'utf8');
  if (weAssetsRoot) {
    const globalPath = path.join(weAssetsRoot, relPath);
    if (fs.existsSync(globalPath)) return fs.readFileSync(globalPath, 'utf8');
  }
  return null;
}

function readJsonRelPath(sceneDir, weAssetsRoot, relPath) {
  const raw = readTextRelPath(sceneDir, weAssetsRoot, relPath);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Duas convenções de layout diferentes, confirmadas lendo os dois casos
// reais: o cache de uma cena baixada guarda tudo "achatado" na raiz
// (sceneDir/materials/effects/tint.json, sceneDir/shaders/effects/tint.frag
// — mesmo effect.json estando em sceneDir/effects/tint/effect.json), mas a
// instalação real da própria Wallpaper Engine guarda cada efeito de estoque
// autocontido na SUA PRÓPRIA pasta (assets/effects/waterripple/materials/
// effects/waterripple.json, assets/effects/waterripple/shaders/effects/
// waterripple.frag). Tenta as duas bases, nessa ordem, antes de desistir.
function readTextMultiBase(sceneDir, weAssetsRoot, effectDir, relPath) {
  const flat = readTextRelPath(sceneDir, weAssetsRoot, relPath);
  if (flat != null) return flat;
  if (weAssetsRoot && effectDir) {
    const nestedPath = path.join(weAssetsRoot, effectDir, relPath);
    if (fs.existsSync(nestedPath)) return fs.readFileSync(nestedPath, 'utf8');
  }
  return null;
}

function readJsonMultiBase(sceneDir, weAssetsRoot, effectDir, relPath) {
  const raw = readTextMultiBase(sceneDir, weAssetsRoot, effectDir, relPath);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Dado o "file" de um efeito (scene.json objects[].effects[].file, ex:
// "effects/customfoo/effect.json"), resolve o nome real do shader (ex:
// "effects/customfoo") seguindo a mesma cadeia que o editor da WE usa:
// effect.json -> passes[0].material -> material.json -> passes[0].shader.
// Confirmado real (cache de cena): effects/tint/effect.json ->
// materials/effects/tint.json -> {"passes":[{"shader":"effects/tint",...}]}.
// Confirmado real (instalação da WE): mesma cadeia, mas material.json e
// shader ficam dentro de effects/waterripple/ (ver readTextMultiBase acima).
function resolveShaderName(sceneDir, weAssetsRoot, effectFile) {
  const effectDir = path.posix.dirname(effectFile.replace(/\\/g, '/'));
  const effectDef = readJsonMultiBase(sceneDir, weAssetsRoot, null, effectFile);
  const materialRel = effectDef && effectDef.passes && effectDef.passes[0] && effectDef.passes[0].material;
  if (!materialRel) return null;
  const materialDef = readJsonMultiBase(sceneDir, weAssetsRoot, effectDir, materialRel);
  const shaderName = materialDef && materialDef.passes && materialDef.passes[0] && materialDef.passes[0].shader;
  return shaderName || null;
}

// Prelúdio fixo de macros HLSL-like que a própria WE injeta antes de
// compilar — nunca aparecem definidas em nenhum .h real, então precisam ser
// fornecidas por nós. Mesma tradução mecânica já usada nos 48 efeitos
// portados à mão (mul, texSample2D, CAST*, frac, saturate), só que aplicada
// via #define em vez de reescrita manual do corpo do shader.
const MACRO_PRELUDE = `precision highp float;
#define texSample2D texture2D
#define texSample2DLod(tex, uv, lod) texture2D(tex, uv)
#define frac fract
#define saturate(x) clamp((x), 0.0, 1.0)
#define CAST2(x) vec2(x)
#define CAST3(x) vec3(x)
#define CAST4(x) vec4(x)
#define CAST3X3(x) mat3(x)
#define CAST4X4(x) mat4(x)
#define CASTU(x) (x)
#define mul(a, b) ((b) * (a))
`;

const MAX_INCLUDES = 16;

// Resolve "#include \"nome.h\"" recursivamente, só contra a instalação real
// da WE (os common*.h nunca existem no cache por-cena). `seen` deduplica
// por nome de arquivo (ex: common_composite.h reinclui common.h) — sem
// isso, símbolos como Desaturate()/ApplyBlending() apareceriam duas vezes e
// quebrariam a compilação.
function resolveIncludes(source, weAssetsRoot, seen) {
  return source.replace(/^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm, (_line, includeName) => {
    if (seen.has(includeName)) return '';
    if (seen.size >= MAX_INCLUDES) throw new Error('profundidade de #include excedida');
    if (!weAssetsRoot) throw new Error(`inclui "${includeName}" mas a instalação real da Wallpaper Engine não foi encontrada`);
    const includePath = path.join(weAssetsRoot, 'shaders', includeName);
    if (!fs.existsSync(includePath)) throw new Error(`include "${includeName}" não encontrado na instalação da WE`);
    seen.add(includeName);
    const included = fs.readFileSync(includePath, 'utf8');
    return resolveIncludes(included, weAssetsRoot, seen);
  });
}

// Acha todo combo referenciado no shader e seu default — tanto pela
// anotação isolada `// [COMBO...] {...}` quanto pela anotação colada num
// uniform (`"combo":"MASK"`, confirmado real em tint.frag pro g_Texture1,
// que não tem [COMBO] próprio) — e também qualquer nome usado direto num
// `#if`/`#ifdef` que nunca foi anotado (default 0, mesmo comportamento da
// própria WE pra combo desabilitado).
function parseComboDefaults(source) {
  const defaults = {};
  const standaloneRe = /\/\/\s*\[COMBO(?:_OFF)?\]\s*(\{[^\n]*\})/g;
  let m;
  while ((m = standaloneRe.exec(source))) {
    try {
      const json = JSON.parse(m[1]);
      if (json.combo) defaults[json.combo] = json.default != null ? json.default : 0;
    } catch { /* comentário mal formado, ignora */ }
  }
  const uniformRe = /uniform\s+\w+\s+\w+\s*;\s*\/\/\s*(\{[^\n]*\})/g;
  while ((m = uniformRe.exec(source))) {
    try {
      const json = JSON.parse(m[1]);
      if (json.combo && !(json.combo in defaults)) defaults[json.combo] = 0;
    } catch { /* ignora */ }
  }
  const conditionalRe = /#(?:if|ifdef)\s+(\w+)/g;
  while ((m = conditionalRe.exec(source))) {
    if (!(m[1] in defaults)) defaults[m[1]] = 0;
  }
  return defaults;
}

// Gera as linhas "#define NOME valor" a partir dos defaults descobertos +
// os valores reais (scene.json objects[].effects[].passes[].combos, já lido
// genericamente hoje pelo resto do arquivo).
function buildComboDefines(comboDefaults, realCombos) {
  let out = '';
  for (const name of Object.keys(comboDefaults)) {
    let value = realCombos && realCombos[name] != null ? realCombos[name] : comboDefaults[name];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    out += `#define ${name} ${value}\n`;
  }
  return out;
}

// Todo `uniform TIPO nome; // {...}` é um parâmetro exposto pelo editor da
// WE — guarda a anotação JSON inteira (não só o que achamos que vamos
// precisar) pra quem chamar decidir o que fazer (parâmetro numérico via
// "material", textura via sampler2D + índice posicional, etc.).
function parseUniformDefs(source) {
  const defs = [];
  const re = /uniform\s+(\w+)\s+(\w+)\s*;\s*\/\/\s*(\{[^\n]*\})/g;
  let m;
  while ((m = re.exec(source))) {
    const [, glslType, name, jsonStr] = m;
    let annotation;
    try { annotation = JSON.parse(jsonStr); } catch { continue; }
    defs.push({ glslType, name, annotation });
  }
  return defs;
}

// Mesma classe de problema do csvNum/csvVec já existentes em
// we-scene-render.js (campos podem vir como {script:...,value:...} em vez
// de número/string cru) — reimplementado aqui pra manter este módulo sem
// depender de volta do monólito (evita ciclo de require).
function coerceUniformValue(raw, glslType, fallbackDefault) {
  const value = raw != null && typeof raw === 'object' ? raw.value : raw;
  const source = value != null ? value : fallbackDefault;
  if (glslType === 'float' || glslType === 'int' || glslType === 'bool') {
    const n = Number(typeof source === 'object' ? source.value : source);
    return Number.isFinite(n) ? n : 0;
  }
  const str = typeof source === 'object' ? source.value : source;
  if (typeof str !== 'string') return null;
  const nums = str.split(' ').map(Number);
  return nums.some((n) => !Number.isFinite(n)) ? null : nums;
}

// Monta o par de fontes (vert+frag) totalmente resolvido pra um efeito
// custom: shader real + includes reais + prelúdio de macros + #defines de
// combo. Retorna null se não houver como resolver o shader (nenhuma cópia
// local nem instalação real) — quem chama trata como qualquer outro efeito
// "não suportado" hoje (pula, mantém imagem estática). Pode lançar exceção
// (ex: #include sem instalação real disponível) — quem chama já envolve
// isso em try/catch, igual a todo outro _apply* existente.
function compileGenericEffectSource(sceneDir, weAssetsRoot, effectFile, realCombos) {
  const effectDir = path.posix.dirname(effectFile.replace(/\\/g, '/'));
  const shaderName = resolveShaderName(sceneDir, weAssetsRoot, effectFile);
  if (!shaderName) return null;

  const vertRaw = readTextMultiBase(sceneDir, weAssetsRoot, effectDir, `shaders/${shaderName}.vert`);
  const fragRaw = readTextMultiBase(sceneDir, weAssetsRoot, effectDir, `shaders/${shaderName}.frag`);
  if (!vertRaw || !fragRaw) return null;

  const comboDefaults = { ...parseComboDefaults(vertRaw), ...parseComboDefaults(fragRaw) };
  const defines = buildComboDefines(comboDefaults, realCombos);

  const vertIncluded = resolveIncludes(vertRaw, weAssetsRoot, new Set());
  const fragIncluded = resolveIncludes(fragRaw, weAssetsRoot, new Set());

  return {
    shaderName,
    vertSrc: MACRO_PRELUDE + defines + vertIncluded,
    fragSrc: MACRO_PRELUDE + defines + fragIncluded,
    uniformDefs: parseUniformDefs(fragRaw + '\n' + vertRaw),
  };
}

module.exports = {
  compileGenericEffectSource,
  coerceUniformValue,
  // exportados à parte pra teste/validação standalone
  resolveShaderName,
  parseComboDefaults,
  parseUniformDefs,
  resolveIncludes,
  buildComboDefines,
  MACRO_PRELUDE,
};
