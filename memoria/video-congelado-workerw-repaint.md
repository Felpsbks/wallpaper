# Vídeo congela num frame só (repaint sob WorkerW) — investigação 2026-07-20

## Sintoma real (PC secundário, GPU AMD, drivers em dia)

Todo wallpaper de vídeo, sempre: o `<video>` interno reporta tocando normal (`readyState=4`, `paused=false`, `currentTime` avançando, `dims` corretos) — mas visualmente a área de trabalho fica travada num frame só, nunca anima. Trocar de wallpaper na Biblioteca também não atualiza visualmente (o painel de controle em si responde normal — é só a janela do wallpaper, embutida atrás dos ícones via WorkerW, que não repinta).

## Não é bug novo

Achado no próprio código um comentário confirmando que isso já tinha sido investigado antes desta sessão: duas tentativas de "forçar redesenho" (resize de 1px, esconder+mostrar) foram feitas e **nenhuma funcionou** — uma até piorou (pisca-pisca). Ficou marcado como "pendente de solução real", teoria: o Chromium pode não tolerar bem ser encaixado como janela-filha de outro processo do jeito que fazemos (diferente de uma janela nativa hospedando um WebView2, que é como Lively Wallpaper faz de verdade).

## O que já existia (mitigação parcial, insuficiente sozinha)

`app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')` — desliga o cálculo de oclusão nativa do Chromium (que despriorizaria/suspenderia trabalho, incluindo decodificação de vídeo, pra janelas que ele acha que estão escondidas — nosso caso, sempre, por design). Documentado como suspeito de afetar principalmente vídeos pesados (4K60 50Mbps+), mas o usuário reportou acontecer com TODO vídeo nesse PC, sem exceção — sugerindo que nessa GPU/config específica, mesmo vídeos leves batem no mesmo problema.

## Tentativa nova (2026-07-20, ainda não confirmada)

Duas flags companheiras, mecanismo relacionado mas diferente (não é "forçar redesenho", é desligar a desaceleração de prioridade do processo de renderização que o Chromium aplica quando ainda assim julga a janela em segundo plano, por outro caminho que não passa pela feature de oclusão):

```js
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
```

Flags padrão e bem documentadas do Chromium, comumente recomendadas pra apps Electron com gerenciamento de janela fora do comum (kiosk, menubar, background) que sofrem exatamente essa classe de problema.

## Status da tentativa de GPU/DirectComposition

**NÃO confirmado ao vivo.** Testado no PC secundário depois de publicado (v1.0.2) e o vídeo continuou congelado — as flags de GPU/backgrounding sozinhas não resolveram.

## Pista real encontrada (2026-07-20, mesma sessão) — reset desnecessário de `<webview>`

O usuário reparou que o erro `Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': {"errno":-3,"code":"ERR_ABORTED","url":"about:blank"}` aparecia em **toda** troca de wallpaper nos logs, e perguntou se tinha a ver com "view". Rastreei até `wallpaper/wallpaper.js` — a função `hideAll()` (chamada em toda troca, não importa o tipo do wallpaper novo) fazia `webEl.src = 'about:blank'` incondicionalmente, resetando a `<webview>` interna (usada só pelos wallpapers tipo "web") mesmo quando nem o wallpaper antigo nem o novo eram desse tipo. Isso bate exatamente com a URL do erro (`about:blank`) e a consistência (toda vez, sem exceção).

**Fix**: só reseta a webview se ela estava mesmo visível/em uso (`if (webEl.style.display !== 'none') webEl.src = 'about:blank';`). Hipótese: o erro repetido de guest-view pode estar corrompendo a composição da janela inteira nalgumas GPUs — o `<video>` sendo um elemento irmão na mesma página, se o processo de composição da página trava por causa da guest-view quebrada, o vídeo nunca chega a ser apresentado na tela mesmo continuando a decodificar por dentro.

Publicado em v1.0.3, junto com a correção do updater travado. **Ainda não confirmado ao vivo** — essa é a hipótese mais forte até agora (bem mais específica que a teoria de GPU/DirectComposition), mas precisa do usuário testar de novo depois de atualizar.
