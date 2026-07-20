# Puppet: esqueleto decodificado + correção de UV — 2026-07-20

## Motivação

Usuário pediu pra chegar o mais perto possível de 100% de compatibilidade com wallpapers reais da Steam, priorizando o maior gap visual conhecido: puppets (personagens articulados) renderizando com pedaços do corpo espalhados/desconexos (achado testando o wallpaper real "Hatsune Miku | Vocaloid", Workshop id `3005028837`).

## O plano original (aprovado) estava errado — corrigido durante a implementação, com evidência

Hipótese inicial: faltava aplicar a matriz de transformação do osso em cada vértice (skinning). Implementei e testei essa hipótese primeiro — o resultado piorou (a caixa delimitadora da malha ficou ~2x maior que o esperado, não mais coerente). Em vez de forçar a entrega de um palpite, investiguei por quê:

1. Agrupando os vértices reais pelo osso dominante e olhando o bbox cru (sem nenhuma transformação) de cada grupo: ossos pequenos (dedos, confirmado pela hierarquia) formam clusters pequenos e localizados; ossos grandes (tronco, cabelo) formam clusters do tamanho esperado. Isso é inconsistente com "cada vértice armazenado no espaço local do próprio osso" — é consistente com vértices já no espaço compartilhado/montado do modelo. Bate matematicamente com a fórmula padrão de skinning (`osso_atual × inversa_da_bind`, que se reduz à identidade exatamente na pose de bind) — aplicar a matriz de bind por cima de algo que já está correto é transformar duas vezes, exatamente o bug observado.
2. O campo `u`,`v` real do vértice (extraído pelo decoder mas nunca usado — o código existente fabrica UV a partir da posição x/y) estava perfeitamente dentro de `[0,1]` pra esse puppet, com clusters por osso no mesmo padrão de tamanho da posição. É exatamente a cara de um mapeamento de UV válido pro atlas real.
3. Comparando com os 3 puppets pequenos já confirmados funcionando antes (sobrancelha/olho/cílio, cada um com textura própria pequena): o UV real DELES fica confinado numa fatia pequena (ex: `u∈[0.61,0.72]`), longe de `[0,1]` — confirmando que, pra esses arquivos especificamente, o comentário antigo estava certo (o UV real endereça um atlas maior que esses arquivos não têm acesso), e o UV aproximado por posição continua sendo a escolha certa ali.

**Causa real do bug**: não era posição, era mapeamento de textura. O código tratava "UV aproximado por posição" como regra geral pra todo puppet, quando na verdade só é necessário pros puppets com textura pequena por-peça — puppets com atlas único e grande (como este da Miku) têm UV real válido que estava sendo descartado.

## Correção

`_drawPuppetMesh` (`wallpaper/we-scene-render.js`) agora mede a faixa do campo UV real (`v.u`, `v.v`) de todos os vértices da malha; se cobrir mais da metade do intervalo `[0,1]` nos dois eixos, usa o UV real direto. Senão, mantém exatamente o comportamento antigo (aproximar por posição). **Nenhuma transformação de matriz de osso é aplicada à posição** — confirmado desnecessário (e prejudicial) pra renderizar a pose de bind especificamente.

Validado contra os 5 arquivos `.mdl` de puppet reais disponíveis localmente: os 3 já confirmados funcionando continuam exatamente como estavam (zero regressão), e os 2 puppets de atlas único (incluindo o da Miku) passam a usar o mapeamento correto.

## Descoberta nova e real: o bloco de esqueleto foi decodificado

Mesmo sem ser necessário pra essa correção específica, o bloco `"MDLS0002"` (esqueleto) do `.mdl` — antes completamente não decodificado — foi mapeado por completo e validado byte-a-byte contra o arquivo real: **29 ossos de verdade**, hierarquia de pais (sem ciclos, cadeia confirmada), matriz 4×4 local de bind por osso. Isso é mais longe do que o próprio `linux-wallpaperengine` (projeto de referência mais maduro do gênero) já chegou — ele também só desenha a malha estática, pulando os mesmos bytes sem nunca interpretar.

Um terceiro bloco, `"MDLA0003"`, contém um clipe de animação de verdade nomeado "Animation 1" (batendo exatamente com o nome esperado no `scene.json` do objeto) — mas o layout dos keyframes ainda não foi decodificado. Isso significa: **o puppet agora renderiza uma pose estática corretamente montada e texturizada, mas ainda sem animação de verdade.**

`decodePuppetSkeleton` (`src/we-scene.js`) fica pronto e guardado no modelo, pra quando a decodificação do `MDLA0003` acontecer — não é código morto, só ainda não conectado à renderização.

## Bug real encontrado durante a validação: boneIndices são inteiros, não floats

O comentário original do formato dizia "stride 52 = 13x float32" — mas os 4 floats de `boneIndices` são na verdade **inteiros de 32 bits** armazenados no mesmo slot de 4 bytes. Lendo como float dava valores desnormalizados praticamente zero (ex: `5.6e-45`, que é exatamente o padrão de bits do inteiro 4); lendo como `uint32` bate com índices de osso válidos (0-28) em 100% dos 7631 vértices reais testados.

## Não feito ainda (escopo honesto)

- Decodificar `MDLA0003` (layout real dos keyframes) e tocar a animação de verdade.
- Física secundária (cabelo/roupa reagindo a movimento).

Precisa o usuário testar ao vivo o wallpaper real da Miku pra confirmar visualmente — esse ambiente de dev não consegue renderizar WebGL pra checar, só a decodificação/matemática foram validadas byte-a-byte.
