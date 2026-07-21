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

## Status

**NÃO confirmado ao vivo ainda.** Terceira tentativa de resolver esse bug (as duas anteriores, de sessões passadas, falharam). `node --check` limpo, rebuild completo rodou sem erro. Precisa do usuário testar no PC secundário e confirmar se o vídeo passa a animar de verdade.
