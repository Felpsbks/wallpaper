# Aba Log estava órfã (sem nenhum jeito de abrir) — 2026-07-20

## O bug

Usuário disse "não tem log no PC" ao tentar checar a aba Log (pedida várias vezes durante debugging do SteamCMD nesta mesma sessão). Investigando: `#panel-logs` existe de verdade em `ui/index.html`, populado corretamente via `ipcRenderer.on('app-log', ...)` → `appendLogLine()` (mesmo `appLog()` do main.js já usado o tempo todo) — mas **nenhum elemento da UI tinha `data-panel="logs"`** pra acionar ele. O mecanismo genérico de troca de painel (`ui/app.js` ~linha 71-76) só ativa `#panel-X` quando um `.nav-item[data-panel="X"]` é clicado — sem esse item, o painel fica inacessível, mesmo funcionando perfeitamente por trás.

Bug pré-existente, não introduzido nesta sessão — só nunca tinha sido percebido porque o debugging desta sessão sempre usou o console bruto (`npm run dev` no terminal) em vez da aba dentro do app.

## Fix

Mesmo padrão já usado pra Configurações (`#btn-header-settings` + `.nav-item[data-panel="settings"]` escondido): novo botão `#btn-header-logs` no cabeçalho (ícone de terminal, ao lado da engrenagem) + novo `.nav-item[data-panel="logs"]` escondido no sidebar, e o wiring em `app.js` que faz o clique no botão do cabeçalho disparar o clique no nav-item escondido.

## Validado

`node --check` limpo em `ui/app.js`. Confirmado por leitura de código que `appendLogLine`/`ipcRenderer.on('app-log', ...)` já alimentavam o painel corretamente — só faltava o caminho de UI pra abrir. Não testado visualmente ao vivo (ambiente sem GUI), precisa confirmação do usuário que o ícone novo abre o painel e mostra linhas reais.
