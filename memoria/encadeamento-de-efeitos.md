# Encadeamento de múltiplos efeitos no mesmo objeto — 2026-07-20

## Motivação

Testando o compilador genérico de shaders (ver `compilador-shaders-genericos.md`) contra um wallpaper real da Hatsune Miku (Workshop id `3766827414`), o resultado visual ficou ruim. Investigando o `scene.json` real, o objeto principal da imagem empilha **6 efeitos diferentes ao mesmo tempo**: bloom custom (via Workshop), waterwaves (×5 instâncias), pulse (×2), shake (×4), foliagesway, shimmer — todos `visible:true` simultaneamente.

## Causa raiz (bug real, pré-existente)

Em `_buildImageObject` (`wallpaper/we-scene-render.js`), cada efeito aplicado fazia `img.onload = () => {...}` de forma independente — 9 blocos diferentes de código faziam isso em sequência (6 efeitos especial-cased antes das tabelas, o loop de `STATIC_EFFECTS`, o loop de `ANIMATED_EFFECTS`, e o fallback genérico). Atribuir `img.onload` de novo **substitui** a atribuição anterior, não soma. Resultado: só o **último** efeito atribuído de fato rodava quando a imagem terminava de carregar; todos os outros eram descartados em silêncio.

Esse bug já existia antes do compilador genérico (não foi introduzido por ele), mas como o fallback genérico roda por último no código, ele sempre "vencia" — então qualquer objeto com efeito custom + efeitos já conhecidos passou a perder os efeitos conhecidos que antes pelo menos ainda funcionavam (regressão em cima de um bug pré-existente).

## Correção

`_buildImageObject` agora monta **uma lista ordenada** de estágios (respeitando a posição real de cada efeito no `scene.json`, via `visibleEffects.findIndex(...)`) cobrindo as 4 categorias de despacho de forma uniforme (especial-cased, `STATIC_EFFECTS`, `ANIMATED_EFFECTS`, fallback genérico), e executa um **único** `img.onload = async () => {...}` que roda todos os estágios em sequência, passando a saída (canvas) de cada um como entrada do próximo.

**Descoberta que tornou isso barato**: `_setupSimplePass` (helper compartilhado por ~34 dos 45 métodos de efeito) faz upload da textura via `texImage2D`, que aceita qualquer `TexImageSource` — inclusive um `<canvas>`, não só `<img>`. E todo `_apply*` já fazia `if (img.parentNode) img.parentNode.replaceChild(canvas, img)` usando o que quer que tenha recebido como parâmetro. Ou seja: encadear o canvas de saída de um estágio como entrada do próximo **já funciona sozinho**, sem mudar nada da lógica interna de DOM/WebGL de nenhum dos 45 métodos — o canvas do estágio anterior já está no DOM (foi inserido por ele mesmo), então já é uma âncora válida pro `replaceChild` do próximo.

**Única mudança mecânica necessária**: nenhum dos 45 métodos retornava algo útil antes (`undefined` implícito). Adicionado `return canvas;` ao final de cada um (a variável `canvas` já existe em escopo em todos, confirmado por catálogo completo antes de mexer — tanto os que usam `_setupSimplePass` quanto os ~11 com pipeline multi-pass próprio como `_applyGodrays`/`_applyFluidSimulation`/`_applyCursorRipple`/`_applyFoliageSway`). Feito via script Node com rastreamento de profundidade de chaves (removendo strings/comentários antes de contar, pra não se confundir com `{`/`}` dentro de texto) — achou exatamente 45/45 métodos-alvo, zero avisos.

**Bug latente real encontrado de brinde**: `_applyWaterWaves` não tinha `async` (função síncrona sem `return`, mas despachada via `.catch()` — chamar `.catch()` em `undefined` lança `TypeError`). Estava mascarado pelo próprio bug do `onload` (raramente era o último atribuído); com o encadeamento passando a exercitar esse método de verdade, precisava do `async`. Corrigido.

**Risco de corretude encontrado e evitado no planejamento**: cogitou-se cancelar automaticamente o loop de RAF dos estágios intermediários (já superados) usando snapshot de tamanho de `this._foliageRafHolders` antes/depois de cada chamada. Descartado ao perceber que esse array é **compartilhado pela cena inteira**, não por objeto — como objetos diferentes podem ter seus `img.onload` disparando de forma entrelaçada (cada imagem decodifica independentemente), esse snapshot por índice poderia acidentalmente cancelar a animação de um objeto **diferente e não relacionado**. Preferiu-se aceitar um custo pequeno e limitado (loops de estágios intermediários continuam rodando escondidos, mas sem crescer sem limite, e ainda cancelados normalmente no `destroy()` da cena) a arriscar um bug cruzado entre objetos.

## Limitação aceita e documentada

Como cada efeito ainda faz upload da textura de entrada **uma vez** (não a cada frame), só o **último estágio da cadeia** anima de verdade em tempo real — os anteriores contribuem com o que já tinham renderizado até serem sucedidos pelo próximo. Fazer todo mundo reamostrar em tempo real exigiria reescrever o interior dos 45 métodos (upload de textura dentro do loop, não fora) — escopo e risco bem maiores do que esse bug justificava agora. Para o caso real da Miku, isso significa que `shimmer` (último na ordem real do `scene.json` desse objeto) é quem continua animando de verdade; os outros 5 passam a contribuir visualmente (corrigindo o bug de "5 de 6 efeitos invisíveis"), só sem continuar se movendo depois de serem sucedidos.

## Validação feita

1. **Ordem da cadeia** testada contra o `scene.json` real da Miku (14 efeitos visíveis no objeto principal) — confirmado bater exatamente com o esperado: `bloom(0) → waterwaves(1) → pulse(6) → shake(8) → foliagesway(10) → shimmer(13)`.
2. **Fluxo de execução** (await sequencial, try/catch por estágio, encadeamento correto do `current` inclusive pelo ramo genérico, um estágio que falha não aborta os seguintes) testado via reprodução fiel do mesmo código com métodos falsos — todas as verificações passaram.

**Não validado ainda**: comportamento real de `gl.compileShader`/encadeamento de canvas numa janela Electron/WebGL de verdade — precisa o usuário retestar o mesmo wallpaper da Miku e conferir o resultado visual + a aba Log.
