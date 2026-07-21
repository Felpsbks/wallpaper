# SteamCMD — baixar Workshop sem o Wallpaper Engine instalado — 2026-07-20

## Por quê

O fluxo padrão de download (`download-workshop-item`, ver `integracao-steam.md`) inscreve a conta via HTTP e depois espera o **cliente Steam local** sincronizar o arquivo em disco. Confirmado ao vivo: sem o Wallpaper Engine instalado nesse PC, a Steam nunca baixa — dá timeout em 4min, mesmo com a conta possuindo o jogo. Confirmado também via API real (`GetPublishedFileDetails`) que não existe link HTTP direto pra esse conteúdo (é depot/SteamPipe, `file_url` sempre vazio pra esses itens).

Caso de uso real: o próprio usuário levando conteúdo do PC onde tem o Wallpaper Engine instalado pro outro PC dele que não tem — não é distribuição pública. SteamCMD fala o protocolo de depot e resolve isso, mas tinha sido banido do projeto antes (ver `feedback-no-steamcmd` na memória) por um incidente numa sessão anterior. Reintroduzido nesta sessão com autorização explícita do usuário, dado o contexto novo, **como caminho adicional opt-in** — o fluxo padrão continua 100% intacto.

## Implementação

### `main.js`

- `ensureSteamCmd()`: baixa `steamcmd.zip` oficial da Valve (`steamcdn-a.akamaihd.net/client/installer/steamcmd.zip`) via `httpDownload` (já existente, reusado) pra `userData/steamcmd/` na primeira vez, extrai com `adm-zip` (já era dependência do projeto, nenhuma lib nova). Chamadas seguintes só checam se `steamcmd.exe` já existe.
- `ipcMain.handle('steamcmd-download-item', ...)`: um processo SteamCMD único faz login + download:
  ```
  steamcmd.exe +login <username> +workshop_download_item 431960 <id> validate +quit
  ```
  `spawn` com `stdio: ['pipe','pipe','pipe']` (mesmo padrão já usado em `ensureMediaSessionPoll` pro PowerShell da media session) — parser de stdout linha-a-linha, mais um cheque no buffer parcial sem quebra de linha (é assim que o SteamCMD escreve os prompts `password:`/`Steam Guard code:`, sem `\n` no final).
  - Detecta `password:` → manda `steamcmd-need-password` pro renderer.
  - Detecta `Steam Guard code:` → manda `steamcmd-need-guard-code`.
  - Qualquer outra linha → `appLog(...)` (aba Log já existente, sem UI nova pra isso).
  - No `exit`, confere `userData/steamcmd/steamapps/workshop/content/431960/<id>/` e reusa `importFromContentDir` — a mesma função que o fluxo padrão já usa pro sucesso, sem nenhuma duplicação de lógica de parsing.
- `steamcmd-provide-password`/`steamcmd-provide-guard-code`: escrevem a resposta no stdin do processo em andamento (guardado em `_steamCmdProc`, module-level, só um download por vez).
- `steamcmd-validate-login`: pedido do usuário — confirmar usuário/senha (e Steam Guard, se pedir) **antes** de tentar baixar algo, em vez de só descobrir que a senha está errada no meio do download. Roda `+login <username> +quit` (sem download nenhum) através do mesmo `runSteamCmd()` reusado pelo download — a lógica de spawn/parsing/prompts foi extraída pra essa função compartilhada em vez de duplicada. Sucesso é detectado pela linha real que o SteamCMD imprime (`Logging in user 'X' to Steam Public...OK`) e ausência de qualquer linha com `FAILED`/`ERROR!`. Validar com sucesso já deixa a sessão cacheada, então o download logo em seguida normalmente não pede senha/código de novo.
- **Senha nunca é persistida** — só o username (`store.set('steamCmdUsername', ...)`, conveniência de prefill). Senha sempre digitada e escrita direto no stdin do processo.
- **Sessão persistente**: o próprio SteamCMD guarda o login token em `userData/steamcmd/config/config.vdf`. Enquanto essa pasta não for apagada e a sessão não expirar do lado da Steam, `+login <username>` (mesmo usuário) não pede senha/código de novo em execuções futuras — resolve o "não pedir toda hora" sem nenhuma lógica extra nossa.

### UI (`ui/index.html` / `ui/app.js`)

Nova linha em **Configurações → Conta Steam**: "Baixar sem o Wallpaper Engine instalado" → abre `#modal-steamcmd` (campo de usuário Steam com prefill, campo de ID/link do item, botão Baixar). Quando o main process pede senha ou código (eventos IPC), o modal troca a área de status por um campo de input + "Confirmar", que manda a resposta de volta. Progresso detalhado fica na aba Log existente — o modal só mostra o estado atual numa linha, sem duplicar um console.

## Fora de escopo (por decisão, não esquecido)

- Nunca roda automático — sempre disparado manualmente pelo usuário em Configurações.
- Não mexe em nada do fluxo padrão (`download-workshop-item`, `scan-steam-workshop`, filtro `_isEndUserBuild`).
- Um download por vez (sem fila) — suficiente pro caso de uso pessoal.

## Bug real encontrado e corrigido: prompts nunca chegavam via pipe

Testado ao vivo (2026-07-20): depois do banner do SteamCMD, nada mais aparecia — nem "password:" — mesmo esperando bastante. Duas hipóteses levantadas (rede lenta vs bug de buffering); resolvidas comparando com um teste manual do usuário rodando o mesmo `steamcmd.exe +login <user>` direto no PowerShell: lá os prompts apareciam normalmente.

**Causa confirmada:** quando a saída do SteamCMD vai pra um pipe (`stdio:'pipe'`, o que `runSteamCmd` faz) em vez de uma console real, o processo engasga a saída no buffer interno dele — linhas curtas como `password:` nunca são liberadas pro nosso lado, só o banner inicial (que ele parece flushar explicitamente). É um comportamento conhecido de apps de console no Windows sem uma console de verdade anexada, não é bug do nosso parsing.

**Fix:** nova função `runSteamCmdInteractive()` — roda o `+login` numa janela de console REAL e visível. Primeira tentativa (`stdio:'ignore'`, `windowsHide:false` direto no `spawn(exePath,...)`) não bastou: em `npm run dev` o Electron herda a console do terminal onde foi lançado, então o processo filho reaproveitava essa mesma console sem handles de entrada/saída de verdade — ficava cego e mudo, nenhuma janela aparecia. Corrigido forçando uma console NOVA sempre, via `cmd.exe /c start "SteamCMD Login" /wait <exe> <args>` — `start` sempre abre uma janela nova independente do que o processo pai tem, `/wait` garante que o `cmd.exe` só sai quando o SteamCMD dentro da janela nova terminar. Se a sessão já estiver em cache, essa janela fecha quase instantânea, sem pedir nada; se não, o usuário digita senha/código direto nela — exatamente o ambiente onde já provou funcionar. Só depois desse passo é que roda a operação de verdade (`validate-login` ou `download-item`) via o `runSteamCmd` já existente (piped, escondido) — que a essa altura não deveria mais bater em nenhum prompt interativo, então o problema de buffering deixa de importar pra ela.

A detecção de prompt via pipe (`steamcmd-need-password`/`steamcmd-need-guard-code`) foi **mantida** como caminho defensivo secundário (caso a sessão expire entre os dois passos), mas na prática o caminho principal agora é a janela visível.

## SteamCMD virou o método padrão do "Aplicar Wallpaper"

Pedido do usuário: já que o SteamCMD funciona em qualquer PC (com ou sem Wallpaper Engine instalado) e o método padrão antigo (web-subscribe+poll) só funciona quando o WE está instalado, não fazia sentido manter os dois como escolha manual (chegou a existir um menu com as duas opções por uma versão curta). Agora `applyBtn.onclick` no modal de detalhes chama `startSteamCmdDirect(item.workshopId)` direto, sem menu: usa o usuário Steam já salvo (se existir) e baixa+aplica num clique só; só abre o modal do SteamCMD (pra digitar o usuário) na primeiríssima vez, sem nada salvo ainda. `startWorkshopDownload` (o método antigo) continua existindo no código — só não está mais ligado a nenhum botão da UI no momento.

O status de cada etapa (`steamcmd-status`) agora também aparece na barra flutuante de sempre (`setWsStatus`) e na tela cheia clássica de download (`dl-loading-screen` — a mesma usada pelo método padrão), não só dentro do modal do SteamCMD — importante porque nesse fluxo de clique direto o modal nem chega a abrir. Como o SteamCMD só dá estados discretos (sem porcentagem real de bytes), a barra de progresso avança em degraus fixos por etapa (20%/45%/70%/100%) — mesmo princípio do "progress" falso que o próprio método padrão já usava pra Steam sincronizar.

## Ajustes pós-validação (mesma sessão, 2026-07-20)

- **Não mostrar a janela de login toda vez**: `hasCachedSteamCmdSession()` confere se `steamCmdDir/config/config.vdf` já existe — se sim, pula direto `runSteamCmdInteractive()` (só usado na primeira vez de verdade nessa pasta/PC). Pedido do usuário: a janela aparecendo (mesmo fechando sozinha, instantânea) toda vez que baixava algo parecia estar pedindo login de novo.
- **Auto-aplicar + confirmação clara**: o fluxo padrão (`download-progress`) já aplicava o wallpaper sozinho ao terminar e mostrava um aviso flutuante (`setWsStatus`); o fluxo do SteamCMD só atualizava a biblioteca, sem aplicar nem avisar fora do modal — ficava sem sinal claro de que tinha terminado. Agora `steamcmd-status` 'completed' também chama `setWallpaper(wp)` e mostra o mesmo aviso flutuante usado no resto do app, visível mesmo com o modal já fechado.

## Bug real #2: cache existe mas está inválido — mesmo travamento de antes, caminho diferente (2026-07-20)

Depois de confirmado funcionando, o usuário travou de novo na mesma tela — dessa vez com o log visível (adicionado direto na tela cheia de download, não só no modal, porque o clique direto em "Aplicar Wallpaper" nunca abre o modal do SteamCMD) mostrando só o banner do SteamCMD, nada depois. Causa: `hasCachedSteamCmdSession()` só confere se `config.vdf` **existe**, não se a sessão dentro dele ainda é **válida** — se a Steam invalidou a sessão salva (expirou, deslogou em outro lugar, etc.), o app pulava a janela de login visível (achando que não precisava) e caía direto no download escondido, que trava esperando um prompt que o pipe não deixa a gente ver — o mesmo bug de buffering de antes, só que por um caminho que a gente achava já estar coberto.

**Fix**: `runSteamCmd()` ganhou um `timeoutMs` opcional — se não progredir (sem `sawLoginOk`/`sawError`/saída do processo) dentro do prazo, mata o processo e sinaliza `timedOut`. Novo helper `runSteamCmdWithFallback()` junta as duas peças: tenta o caminho rápido escondido primeiro (só quando já tem cache), mas se travar (timeout de 15s — folga confortável sobre os ~5s que uma sessão válida leva de verdade), refaz sozinho via janela visível e tenta de novo. Cobre os 3 cenários: sem cache (janela sempre), cache válido (rápido, sem janela), cache inválido (detecta e recupera sozinho, só nesse caso mostra a janela).

**Bug real #3, mesma sessão de teste**: mesmo depois da janela visível (usuário digitou a senha, janela fechou), a tentativa final ficou travada de novo — confirmado com dado real via `Get-Process -Name steamcmd`, achando um processo escondido rodando havia minutos sem nenhuma janela. Ou seja, a janela visível sozinha não é garantia de que a próxima chamada escondida vai completar. Fix: a chamada final (depois da janela) também ganhou timeout (20s) — se travar de novo, devolve um erro claro pro usuário em vez de travar a tela pra sempre uma segunda vez. Causa raiz de por que a re-tentativa trava mesmo após login aparentemente bem-sucedido **ainda não identificada** — hipótese em aberto: conta com Steam Guard pedindo um segundo prompt (código) que o usuário não viu/não respondeu antes da janela fechar.

## Validado

`node --check` limpo nos 3 arquivos alterados. **Confirmado ao vivo (2026-07-20)**: login validado com sucesso via SteamCMD (sessão em cache, `Logging in using cached credentials.`), download completo de um item real (`3766267988`, 86.9MB) e importado na biblioteca — fluxo ponta a ponta funcionando, incluindo a janela de console real forçada via `cmd.exe /c start`.
