# Engine Wallpaper — Índice da Memória

Documentação completa do projeto gerada automaticamente em 2026-07-16.

## Arquivos desta pasta

| Arquivo | Conteúdo |
|---------|---------|
| [visao-geral.md](visao-geral.md) | O que é o app, objetivo, plataforma, versão |
| [arquitetura.md](arquitetura.md) | Processos Electron, IPC, modelo multi-display |
| [estrutura-de-pastas.md](estrutura-de-pastas.md) | Árvore de diretórios e finalidade de cada arquivo |
| [dependencias.md](dependencias.md) | Todas as libs (produção e dev), versões e para que servem |
| [scripts-e-build.md](scripts-e-build.md) | npm scripts, fluxo de dev, geração de dist |
| [modulos-backend.md](modulos-backend.md) | store.js, playlist.js, workerw.js, fullscreen.js |
| [modulo-wallpaper.md](modulo-wallpaper.md) | wallpaper.js, camadas de renderização, áudio |
| [cenas-builtin.md](cenas-builtin.md) | 5 cenas nativas (particles, waves, matrix, aurora, visualizer) |
| [integracao-steam.md](integracao-steam.md) | Workshop scraping, autenticação, download de wallpapers |
| [automacao-e-regras.md](automacao-e-regras.md) | Playlist, detecção de fullscreen, regras de app, horários |
| [ui-painel-controle.md](ui-painel-controle.md) | app.js, seções do painel, tray, settings |
| [win32-integracao.md](win32-integracao.md) | WorkerW embedding, koffi FFI, APIs do Windows |
| [configuracao-do-app.md](configuracao-do-app.md) | Onde config é salva, formato do config.json |
| [fluxo-de-inicializacao.md](fluxo-de-inicializacao.md) | main.js passo a passo desde o boot até render |
| [compilador-shaders-genericos.md](compilador-shaders-genericos.md) | *(2026-07-20)* Compila shaders custom da Workshop em runtime — dialeto real, corpus, layout de pastas, validação |
| [encadeamento-de-efeitos.md](encadeamento-de-efeitos.md) | *(2026-07-20)* Corrige bug real: objetos com vários efeitos empilhados só rodavam o último (img.onload se sobrescrevendo) — agora encadeia em sequência |
| [puppet-esqueleto-e-uv.md](puppet-esqueleto-e-uv.md) | *(2026-07-20)* Decodifica o esqueleto real do puppet (29 ossos) e corrige o bug real dos "pedaços espalhados" — era mapeamento de UV, não skinning |
| [auto-atualizacao-e-build-usuario.md](auto-atualizacao-e-build-usuario.md) | *(2026-07-20)* Verificação/auto-instalação de update via GitHub Releases + filtro vídeo-só na build final |
| [correcoes-update-e-ui.md](correcoes-update-e-ui.md) | *(2026-07-20)* Crash do ASAR no update, versão na sidebar, modal de confirmação estilizado + blur no fundo dos modais |
| [steamcmd-pc-secundario.md](steamcmd-pc-secundario.md) | *(2026-07-20)* Caminho adicional (opt-in) pra baixar Workshop sem o Wallpaper Engine instalado — SteamCMD, uso pessoal entre 2 PCs |
| [updater-travado-corrigido.md](updater-travado-corrigido.md) | *(2026-07-20)* Auto-updater travava pra sempre num PC real — corrigido e testado empiricamente contra processos reais (não só lendo código); log persistente do processo adicionado |
| [video-congelado-workerw-repaint.md](video-congelado-workerw-repaint.md) | *(2026-07-20)* Vídeo congela num frame só sob WorkerW — bug antigo já tentado 2x sem sucesso; nova tentativa via flags `disable-backgrounding-occluded-windows`/`disable-renderer-backgrounding`, ainda não confirmada |
| [crash-wsstatus-null.md](crash-wsstatus-null.md) | *(2026-07-20)* Crash real confirmado via log do usuário: `wsStatus` (elemento removido numa reforma antiga) acessado sem checar null em 7 lugares — corrigido com helper seguro; bônus: mensagem "formato não reconhecido" do SteamCMD agora diz o motivo real (ex: tipo scene filtrado) |
| [aba-log-orfa-corrigida.md](aba-log-orfa-corrigida.md) | *(2026-07-20)* Painel de Log existia e funcionava por trás, mas não tinha NENHUM botão pra abrir — bug pré-existente, só nunca percebido. Adicionado ícone no cabeçalho |
| [icone-real-do-app.md](icone-real-do-app.md) | *(2026-07-20)* `scripts/gen-icon.js` desenhava um ícone falso (play button genérico) por código — trocado pra usar o logo real (`ui/logo-tray.png`) redimensionado via System.Drawing, confirmado embutido certo no .exe |
| [dependencia-uiohook-corrigida.md](dependencia-uiohook-corrigida.md) | *(2026-07-20)* `uiohook-napi` estava referenciado no código como "já é dependência" mas nunca tinha sido instalado de fato — corrigido, binário nativo N-API confirmado empacotado certo; carregamento em runtime não confirmado ao vivo ainda |
| [instalador-com-interface.md](instalador-com-interface.md) | *(2026-07-20)* Setup.exe autoextraível — testado ao vivo e BLOQUEADO pelo Smart App Control (auto-run silencioso = padrão de dropper). Abordagem descartada, voltou pro .zip simples; código do instalador fica dormente pra um futuro com certificado de assinatura |
