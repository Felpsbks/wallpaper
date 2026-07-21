# Dependência uiohook-napi faltando de verdade — 2026-07-20

## O bug

`main.js` sempre logava `[main] uiohook indisponível — cursorDown/cursorClick dos scripts reais da WE não vão funcionar: Cannot find module 'uiohook-napi'` no boot. Um comentário no próprio código (linha ~333) dizia "uiohook-napi já é dependência do projeto" — mas isso era falso: nunca esteve em `package.json` nem em `node_modules/`. O `try/catch` em `ensureClickBroadcast()` (main.js ~340-371) mascarava isso graciosamente, então o app sempre funcionou, só sem esse recurso específico (cliques reais em botões play/pause/skip de scripts da Workshop que dependem de `cursorDown`/`cursorClick`).

## Fix

`npm install uiohook-napi --save` — adicionado de verdade a `package.json` (`^1.5.5`). O pacote já vem com binários N-API pré-compilados pra várias plataformas (`prebuilds/win32-x64/uiohook-napi.node` entre outras) — N-API é estável entre versões de Node/Electron, não devia precisar de rebuild específico pro Electron.

Confirmado que `scripts/pack.js` já lida com isso sem nenhuma mudança: o `--unpack "**/*.node"` (mesmo mecanismo já usado pro `koffi`) pega esse `.node` novo automaticamente e ele aparece certinho em `bin/resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node` depois do pack — confirmado por arquivo real, não só suposição.

## Validado

- `npm install` rodou limpo, pacote presente em `node_modules/`.
- `npm run pack`/`npm run dist` rodaram limpos, binário nativo confirmado no lugar certo depois do empacotamento.
- **NÃO confirmado ao vivo**: tentei rodar o app e capturar a saída do console pra confirmar que o aviso "uiohook indisponível" sumiu, mas esse ambiente não consegue capturar stdout/stderr de um app Electron GUI lançado (mesma limitação já registrada em `project_gui_testing_limitation` — o processo abre de verdade, mas a saída de console não chega até aqui). Precisa que o usuário rode `npm run dev` e confirme se aquele aviso específico ainda aparece ou não.
