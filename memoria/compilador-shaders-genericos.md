# Compilador genérico de shaders custom da Workshop — 2026-07-20

## Motivação

Usuário relatou que só o wallpaper de vídeo funciona bem no app — "o resto é uma bosta". Investigação encontrou a causa real.

`wallpaper/we-scene-render.js` já tinha (antes desta mudança) um pipeline **WebGL1 real e funcional** para ~48 efeitos de pós-processamento oficiais da Wallpaper Engine (blur, godrays, fluid simulation com solver Navier-Stokes real, cursor-ripple, foliage sway, chromatic aberration etc.) — cada um portado à mão: alguém leu o `.frag`/`.vert` real da instalação da WE uma vez e reescreveu manualmente em GLSL ES 1.00, compilado de verdade via `gl.compileShader`. Não é CSS/DOM fingindo ser shader — é WebGL de verdade, só que **hardcoded por efeito**.

O problema: o despacho pra esses 48 efeitos é 100% baseado em comparar o nome do arquivo (`eff.file.endsWith('waterripple/effect.json')`, ~40 checagens espalhadas pelo arquivo, ver `_buildImageObject`). Qualquer item da Steam Workshop que usa um shader **próprio/customizado** (não um dos 48 conhecidos) simplesmente não renderiza nada — dado que existem ~2,7 milhões de itens na Workshop, essa é provavelmente a causa real do "resto é uma bosta".

## Comparação com `Almamu/linux-wallpaperengine`

Esse projeto (GPLv3, 4400+ estrelas, referência do gênero) resolve o mesmo problema compilando o shader real da WE genericamente via **glslang + SPIRV-Cross** (WE shader → SPIR-V → GLSL). Decisão tomada aqui: **não replicar esse toolchain em C++**. Motivos:

- Não existe nenhum precedente de dependência nativa com build toolchain neste projeto — `koffi` (única dependência nativa hoje) só usa binários `.node` pré-compilados, nunca precisou de `node-gyp`/Visual Studio Build Tools.
- Bundlar glslang+SPIRV-Cross seria a primeira dependência desse tipo, contra a prioridade de leveza do projeto.
- Os blocos `#if COMBO == N` reais do dialeto da WE já são resolvidos de graça pelo próprio compilador GLSL-ES do ANGLE (o motor por trás do WebGL no Chromium/Electron) no momento do `gl.compileShader` — não precisamos reimplementar um avaliador de pré-processador, só gerar o `#define` certo antes.

Por isso, em vez de um compilador C++ genérico, foi construído um **pré-processador JS pequeno e específico pro dialeto da WE**.

## Corpus real de referência (nunca vendorizado no repositório)

Dois lugares onde o `.frag`/`.vert` real pode ser encontrado, sempre lidos em runtime (nunca copiados pro repo — são assets proprietários da Valve/Kristjan Skutta):

1. **Instalação real da Wallpaper Engine**, se o usuário tiver: `C:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\assets\` — 118 arquivos `.vert`/`.frag`/`.geom` + 12 includes `common*.h` (`common.h`, `common_blending.h`, `common_blur.h`, `common_composite.h`, `common_fog.h`, `common_foliage.h`, `common_fragment.h`, `common_particles.h`, `common_pbr.h`, `common_pbr_2.h`, `common_perspective.h`, `common_vertex.h`).
2. **Cache local de cenas já baixadas**: `%APPDATA%\engine-wallpaper\we-scene-cache\<workshopid>\shaders\effects\*.{vert,frag}` — muitos itens da Workshop já trazem cópia do próprio shader custom junto com a cena, mesmo sem a instalação completa da WE (mas nunca trazem os `common*.h` — esses só existem na instalação completa).

## Duas convenções de layout diferentes (bug real encontrado e corrigido)

- **Cache de cena** (achatado): `effect.json` fica em `sceneDir/effects/<nome>/effect.json`, mas o `material.json` que ele referencia e o shader ficam soltos na raiz — `sceneDir/materials/effects/<nome>.json`, `sceneDir/shaders/effects/<nome>.frag`.
- **Instalação real da WE** (autocontido): cada efeito de estoque vive isolado na própria pasta — `assets/effects/<nome>/materials/effects/<nome>.json`, `assets/effects/<nome>/shaders/effects/<nome>.frag`.

A primeira versão do resolvedor só tentava a convenção achatada e retornava `null` pra qualquer coisa resolvida via instalação real. Corrigido tentando as duas bases (`readTextMultiBase`/`readJsonMultiBase` em `we-shader-compiler.js`) antes de desistir.

## Dialeto real confirmado (lido direto de `tint.frag/vert`, `waterripple.frag`, `common_blending.h`)

GLSL ES com uma camada de macros ao estilo HLSL por cima, mais anotações em comentário que servem de schema:

```glsl
// [COMBO] {"material":"...", "combo":"BLENDMODE", "type":"imageblending", "default":30}
#include "common_blending.h"
uniform sampler2D g_Texture1; // {"material":"mask", "mode":"opacitymask", "default":"util/white", "combo":"MASK"}
uniform vec3 g_TintColor;     // {"material":"color", "type":"color", "default":"1 0 0"}
...
gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
albedo.rgb = ApplyBlending(BLENDMODE, albedo.rgb, g_TintColor, mask);
```

Macros que aparecem em todo shader real mas nunca são definidas em nenhum `.h` (a própria WE injeta antes de compilar — precisam ser fornecidas por nós):

| Macro real | Vira |
|---|---|
| `mul(a, b)` | `(b) * (a)` (convenção HLSL de vetor-linha) |
| `texSample2D` / `texSample2DLod` | `texture2D` (o `Lod` vira sample normal, sem bias de mip) |
| `frac` | `fract` |
| `saturate(x)` | `clamp((x), 0.0, 1.0)` |
| `CAST2/3/3X3/4/4X4/U(x)` | `vec2/vec3/mat3/vec4/mat4(x)` (`CASTU` sem tipo uint em GLSL ES 1.0, passthrough) |

As anotações `// [COMBO...] {...}` (linha isolada) e `// {"combo":"X",...}` (colada num `uniform`) **são o próprio schema de combo/parâmetro** — não precisa adivinhar defaults, eles já estão documentados no próprio arquivo.

## Implementação

### `wallpaper/we-shader-compiler.js` (novo arquivo)

Módulo puro (sem dependência de DOM/WebGL, testável isoladamente em Node):

- `resolveShaderName(sceneDir, weAssetsRoot, effectFile)` — segue a cadeia real `effect.json → passes[0].material → material.json → passes[0].shader`.
- `compileGenericEffectSource(sceneDir, weAssetsRoot, effectFile, realCombos)` — resolve `#include` (recursivo, deduplicado, só contra a instalação real — `common*.h` nunca existe no cache por-cena), monta o prelúdio de macros + `#define` por combo, retorna `{ shaderName, vertSrc, fragSrc, uniformDefs }`. Lança erro tratável (não retorna GLSL quebrado) quando falta `#include` sem instalação real disponível.
- `parseComboDefaults`/`parseUniformDefs` — regex sobre as anotações reais em comentário.
- `coerceUniformValue` — mesma lógica de `csvNum`/`csvVec` já existentes em `we-scene-render.js` (campos podem vir como `{script:...,value:...}` em vez de número/string cru), reimplementada aqui pra não criar dependência circular com o monólito.

### Integração em `we-scene-render.js`

Novo método `_applyGenericShaderEffect(img, config, w, h)`, chamado **só como fallback**, depois de todas as ~40 checagens hardcoded dos 48 efeitos existentes (zero risco de regressão nos que já funcionam). Reaproveita `_setupSimplePass` — a MESMA função que todos os 48 efeitos hardcoded já usam pra criar canvas/contexto WebGL/programa/textura-base — só muda a origem do GLSL (resolvido na hora em vez de escrito à mão). Texturas extras (`g_Texture1`, `g_Texture2`...) são bindadas usando o índice extraído do próprio nome do uniform (não da ordem de declaração, mais robusto), reaproveitando `_loadSceneTexAsImage`/`_loadStockTexAsImage`/`_createSolidWhiteTexture` que já existiam.

## Validação feita

Testado **standalone em Node** (sem WebGL, já que Node não tem) contra dois shaders reais e diferentes:

- `tint` (via cache de cena): combos parte anotados/parte inferidos de `#if`, uniforms sampler+float+vec3, `#include "common_blending.h"` real trazendo ~200 linhas de funções de blend reais. Combo real do `scene.json` (`BLENDMODE:26`) selecionou corretamente o branch `BlendHue` no GLSL final.
- `waterripple` (via instalação real da WE): coerção de combo booleano, textura extra `g_Texture2` (normal map).

**Não validado ainda** (no momento em que este documento foi escrito): compilação/link reais via `gl.compileShader`/`gl.linkProgram` num contexto WebGL de verdade (esse ambiente de dev não consegue abrir uma janela Electron visível) — a validação abaixo já cobre isso, feita pelo usuário rodando o app de verdade.

## Bugs reais encontrados testando ao vivo (mesmo dia)

Usuário testou contra cenas reais da Workshop via `npm run dev` (repacka e relança sozinho a cada salvamento). Três rodadas de erro, todas da MESMA categoria: shaders reais da WE usam `#if IDENTIFICADOR` pra testar **flags de alvo de compilação** (nunca combos de material — a própria WE sempre define isso antes de compilar) — e o pré-processador GLSL-ES do ANGLE (motor do WebGL no Chromium) dá **erro de sintaxe** pra qualquer identificador desse tipo nunca definido, diferente do C tradicional que trataria como 0 em silêncio.

1. **`HLSL` (dentro de `common_perspective.h`, um #include)** — primeira tentativa de correção piorou: a varredura ingênua de `#if`/`#ifdef` nem conseguia ver essa linha (só rodava no texto ANTES de resolver includes), e mesmo se visse, tratar flag de alvo como combo é conceitualmente errado. Removida a varredura cega.
2. Só remover não bastou — `HLSL` continuava nunca definido, e `#if HLSL` indefinido é erro de sintaxe pro ANGLE, não "falso". Corrigido definindo permanentemente `GLSL=1, HLSL=0, HLSL_SM30=0, PLATFORM_ANDROID=0` no prelúdio de macros.
3. Reteste da mesma cena revelou MAIS da mesma família, um de cada vez (`TEX0FORMAT`/`TEX1FORMAT` de `common_fragment.h`, `DIRECTDRAW` do próprio `lightshafts.frag` — só exposto via `"require":{"DIRECTDRAW":0}`, uma chave que a regex de combo não olhava). Em vez de continuar corrigindo um por vez a cada teste do usuário, foi feita uma **varredura completa**: os 478 arquivos `.frag/.vert/.h` reais da instalação foram escaneados atrás de todo identificador usado em `#if`/`#elif`, comparado contra todo nome já visto anotado como combo de verdade — 80 "não explicados" voltaram. Só os inequivocamente identificáveis como flag de engine (pelo contexto de uso, ex: comparação com constantes tipo `FORMAT_*`) foram definidos: `DIRECTDRAW=0`, `SHADERVERSION=9999` (trava de compatibilidade antiga, `#if SHADERVERSION < 62` — alto o bastante pra sempre pegar o caminho moderno), `TEX0/1/2/3/4FORMAT=0` + 12 constantes `FORMAT_*` distintas e diferentes de zero (reflete a realidade real: `decodeTexToPng` sempre decodifica pra RGBA8888 comum, nunca formato comprimido). Os outros ~65 "não explicados" (`BLOOM`, `TINT`, `SPIN` etc.) foram deixados de fora de propósito — são nomes plausíveis de combo de verdade que a regex pode não ter pego no arquivo amostrado; definir errado arriscaria visual silenciosamente errado, pior que um erro limpo.

Validação final (offline, contra o `lightshafts.frag/vert` real): confirmado que **zero** identificadores usados em `#if`/`#elif` no texto final ficam sem `#define` correspondente.

**Achado à parte, não é bug deste compilador**: o efeito custom "Simple_Audio_Bars" (item 2084198056) falha com `'[]' : Index expression must be constant` — uma restrição real da linguagem GLSL ES 1.00/WebGL1 (sem indexação dinâmica de array nesse contexto, diferente de GLSL mais novo/WebGL2), não corrigível via substituição de macro. Aceito como limitação — degrada de forma limpa, mesmo caminho de "não suportado" de sempre.

## Fora de escopo (adiado, não esquecido)

- Framebuffer único compartilhado pra efeitos que dependem da tela inteira composta (bloom de verdade, variantes COPYBG) — `g_Texture0` com anotação `"material":"framebuffer"` hoje é tratado como "a própria textura do objeto", não uma composição real de múltiplas camadas.
- Shaders de modelo 3D/PBR (skinning, morph targets) e puppet/mesh warp real — vertical maior, não é o que motivou este trabalho.
