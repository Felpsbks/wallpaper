# Auto-atualização e build para usuário final — 2026-07-20

Duas features novas, adicionadas na mesma sessão, cobrindo o ciclo "publicar uma versão nova" e "diferenciar o que o usuário final vê do que o dev vê".

---

## Verificação de atualização + auto-instalação

### Por que assim, não um instalador tradicional

O app não usa `electron-builder`/instalador nenhum — sempre roda a partir de um único `bin/resources/app.asar` ao lado do `.exe` (nunca "solto"/unpacked, ver `fluxo-de-inicializacao.md`/`scripts-e-build.md`). Dado isso, "instalar uma atualização" é só trocar esse arquivo — sem precisar de assinatura de código, Squirrel/NSIS, nem `electron-updater`.

### Verificação (`main.js`)

- `checkForUpdates()` consulta `https://api.github.com/repos/Felpsbks/fynix-connect/releases/latest` (repo público) via `httpGet` (já existente, reaproveitado). Roda ~8s depois do boot e a cada 6h.
- Compara `tag_name` (sem o `v` inicial) contra `require('./package.json').version` via `isNewerVersion()` — comparação numérica simples de 3 partes, sem semver completo (pre-release/build metadata não são necessários aqui).
- Se a release tiver um asset chamado literalmente `app.asar` anexado, guarda a URL de download (`_pendingUpdateInfo.assetUrl`) — habilita o botão "Atualizar agora" no lugar de só "Baixar".

### Aplicação (`apply-update` IPC handler)

1. Baixa o `app.asar` novo pra `%TEMP%\engine-wallpaper-update\app.asar` via `httpDownload` (nova função, irmã binária do `httpGet` existente — grava em disco em vez de decodificar como texto).
2. Confere que o tamanho baixado bate com o `size` reportado pela API.
3. Gera um `.bat` descartável que: espera (`tasklist /FI "PID eq <pid>" /NH | findstr`) o processo atual encerrar → `copy /Y` o novo `app.asar` por cima do antigo (`process.resourcesPath\app.asar`) → reabre o `.exe` (`process.execPath`) → se autodeleta.
4. Roda esse `.bat` detached (`spawn('cmd.exe', ['/c', batPath], {detached:true, ...}).unref()`) e chama `app.quit()`.

### Publicar uma versão nova (processo manual, por enquanto)

Não precisa apagar releases antigas — `/releases/latest` sempre segue a mais recente automaticamente.

1. Subir a versão em `package.json`.
2. `npm run pack` (com o app fechado, senão dá `EBUSY`).
3. Criar uma **release nova** no GitHub com uma **tag nova** (ex: `v1.0.2`) — nunca reaproveitar uma release antiga.
4. Arrastar o `bin\resources\app.asar` recém-gerado como asset dessa release nova, mantendo o nome literal `app.asar`.

Automatizar os passos 3-4 via API do GitHub (criar release + subir asset) ficou combinado como próximo passo, mas depende do usuário gerar um Personal Access Token — não há `gh` CLI nem token neste ambiente de dev.

---

## Filtro de vídeo-só pra build de usuário final

O scanner do Steam Workshop (`scan-steam-workshop`/`scan-custom-workshop` em `main.js`, ver `integracao-steam.md`) hoje também consegue importar wallpapers do tipo `scene`/`web`, além de `video` — mas esses dois primeiros tipos dependem do renderer reverse-engineered (`we-scene-render.js`), que tem gaps conhecidos e ainda não confirmados ao vivo em muitos pontos. Pra quem recebe o `.exe` já pronto (não o dev), a decisão foi **só mostrar wallpapers de vídeo** — o caminho mais confiável hoje.

### Como o sinal é detectado, sem flag manual

`_isEndUserBuild = path.basename(process.execPath).toLowerCase() !== 'electron.exe'` — reaproveita algo que já existia: o dev sempre roda a partir de `bin/electron.exe` (nome original), e só `scripts/build-dist.js` (a build final pra distribuir) renomeia o executável pra `Engine Wallpaper.exe`. Não existe nenhum toggle novo pra lembrar de ligar/desligar antes de gerar a build final — é automático.

Aplicado em `parseSingleWorkshopItem()`: se `_isEndUserBuild` e o tipo do item não for `video`, o item é descartado (`return null`) — mesmo comportamento de "meio incompatível" que outros filtros já usam, só que condicionado à build.
