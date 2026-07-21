# Crash real: wsStatus null (elemento removido numa reforma antiga) — 2026-07-20

## O bug

Log real do usuário: `[ERRO] [UI] Uncaught TypeError: Cannot read properties of null (reading 'style') (app.js?v=3:1513)`. `#ws-status-bar` não existe mais em `ui/index.html` (removido numa reforma anterior da UI — comentário já existente no código confirma: "não tem mais um painel próprio, a Oficina virou o editor visual"). `setWsStatus()` já se protegia com `if (!wsStatus) return;`, mas **7 outros pontos** espalhados pelo arquivo faziam `wsStatus.style.display = 'none'` direto, sem essa checagem — alguns pré-existentes, outros adicionados nesta própria sessão (fluxo do SteamCMD). Todos quebravam igual, sempre que tentavam esconder a barra depois de alguns segundos.

## Fix

Novo helper `hideWsStatus()` (`if (wsStatus) wsStatus.style.display = 'none';`), todos os 7 pontos trocados pra chamar ele em vez do acesso direto. **Cuidado ao aplicar via `replace_all`**: o primeiro replace acabou reescrevendo a própria definição do helper (que contém o mesmo texto que estava sendo substituído), virando uma função que se auto-chama sem fazer nada — pego e corrigido na sequência, confirmado via grep que sobrou só 1 ocorrência do texto original (dentro da definição corrigida do helper) e 7 chamadas de `hideWsStatus()`.

## Bônus: mensagem de erro do SteamCMD melhorada

No mesmo log, apareceu "SteamCMD baixou os arquivos, mas o formato não foi reconhecido" pro item `2636669941` — mensagem enganosa, porque o motivo mais provável nem é formato desconhecido de verdade, é o item ser do tipo `scene`/`web`, filtrado de propósito em builds de usuário final (`_isEndUserBuild`, ver `project_enduser_video_filter`). Nova função `describeUnrecognizedDownload()` lê o `project.json` de verdade (mesma lógica de fallback pra subpasta que `importFromContentDir` já usa) e devolve o motivo real: `'é do tipo "scene" — esta versão só aceita vídeo...'` quando for esse o caso, em vez do genérico.

## Validado

`node --check` limpo nos dois arquivos. Confirmado por grep que não sobrou nenhum acesso `wsStatus.style` sem guarda fora do helper. Rebuild completo (`npm run dist`) rodou limpo. Não confirmado ao vivo ainda (precisa do usuário testar de novo e ver se o erro no console sumiu, e se a mensagem nova aparece pro item que tinha dado "formato não reconhecido").
