# Instalador com interface própria — 2026-07-20

## Por quê

Instalação era manual: baixar um `.zip`, extrair, rodar o exe de dentro da pasta extraída. O usuário pediu uma experiência de instalação de verdade — um arquivo só, duplo-clique, tela de progresso com a mesma cara do app (não uma janela genérica do Windows/instalador nativo). Decisão explícita: usar a tela estilizada do próprio app (Electron/HTML/CSS) em vez de NSIS, aceitando o trade-off de o instalador em si ser pesado (~100MB+, é o runtime do Electron — inevitável nessa escolha).

## Arquitetura

Divide o trabalho em duas partes bem separadas — a extração bruta fica com uma ferramenta nativa mínima e silenciosa, tudo que é **visível** é código Electron normal reaproveitando o que já existia:

```
Engine Wallpaper Setup.exe  (7-Zip SFX)
  └─ extrai silenciosamente pra %TEMP%\7zSxxxxx\
     └─ roda "Engine Wallpaper.exe" de lá
        └─ main.js detecta _isFirstRunInstall (execPath dentro de os.tmpdir())
           └─ runFirstRunInstall(): mostra ui/installer.html, copia
              pra %LOCALAPPDATA%\Engine Wallpaper\, cria atalho no
              Menu Iniciar, abre o app de lá, fecha a instância temp
```

### Por que não baixa nada pela rede durante a instalação

Tudo já vem dentro do `.exe` baixado (é literalmente a mesma `dist/Engine Wallpaper/` que `npm run dist` já gerava, só empacotada num único arquivo autoextraível). Mais simples e mais rápido que baixar de novo — a única "instalação" real que acontece é copiar arquivos que já estão no disco local pra outro lugar.

### `scripts/build-installer.js` (novo)

Empacota `dist/Engine Wallpaper/*` num `.7z`, monta um config de SFX (`;!@Install@!UTF-8! ... RunProgram="Engine Wallpaper.exe" ... ;!@InstallEnd@!`) e concatena `7z.sfx + config + arquivo.7z` num `Engine Wallpaper Setup.exe` — é assim que SFX do 7-Zip funciona (concatenação binária simples).

**Precisa de 7-Zip instalado** (`7z.exe`/`7z.sfx` em `bin/`) — não vem com o Node, não dá pra bundlar automaticamente aqui. Mesmo padrão de degradação graciosa que o `rcedit.exe` já usa em `pack.js`/`build-dist.js`: se não encontrar, avisa com instruções claras (baixar de 7-zip.org, copiar os dois arquivos pra `bin/`) e sai com código 0, sem quebrar nada. **Testado**: esse caminho de aviso+skip funciona (rodei sem 7-Zip instalado nesta máquina, saiu limpo). **NÃO testado**: a config do SFX em si — não tenho 7-Zip disponível neste ambiente pra gerar e rodar o `.exe` de verdade. Primeira vez que alguém gerar isso com 7-Zip instalado, confirmar que extrai silencioso (sem diálogo nativo aparecendo) antes de assumir que está pronto.

### `main.js` — `_isFirstRunInstall` + `runFirstRunInstall()`

- `_isFirstRunInstall`: `process.execPath` está dentro de `os.tmpdir()`? Validado com teste standalone contra os 3 cenários reais (instalação normal em `%LOCALAPPDATA%`, dev `bin/electron.exe`, extração do SFX em `%TEMP%\7zSxxx\`) — só o terceiro dá `true`.
- `runFirstRunInstall()`: entra ANTES de qualquer outra coisa no boot (license check, wallpaper windows, etc — tudo pulado, `return` logo depois). Lista todos os arquivos da pasta de origem primeiro (só nomes, rápido) pra ter uma % real baseada em contagem de arquivos — não um número inventado. Copia um por um com `fs.copyFileSync`, manda uma linha de log por arquivo via IPC (`install-log-line`) e atualiza a barra via `install-progress` — mesmo padrão de log-ao-vivo já construído hoje pro SteamCMD.
- Atalho do Menu Iniciar reaproveita `createShortcut()`, extraída de dentro de `setAutostart()` (que antes só tinha esse código embutido, sem reuso) — mesmo truque de sempre, PowerShell + `WScript.Shell` COM object.
- Ao terminar: `spawn` no exe já instalado no destino definitivo, `app.quit()` na instância temporária depois de ~800ms (dá tempo da tela mostrar "Concluído!").

### `ui/installer.html` + `ui/installer.js` (novos)

Página standalone que só referencia o `styles.css` já existente — reusa `.dl-loading-content`/`.dl-loading-logo`/`.dl-progress-bar`/`.dl-progress-fill` (mesma paleta roxa, mesmo logo `logo-loading.png`, mesma animação de pulso) sem duplicar nenhum CSS. Só adiciona uma caixinha de log (mesmo estilo monoespaçado da caixa de log do SteamCMD) num `<style>` local pequeno.

## Fora de escopo (v1)

- Atalho na Área de Trabalho (só Menu Iniciar por enquanto).
- Desinstalador registrado em "Programas e Recursos" do Windows.
- Limpeza da pasta temp do SFX depois de instalar (o processo já fecha antes de qualquer limpeza assíncrona rodar — não crítico, o Windows limpa temp velho sozinho).

## Validado

`node --check` limpo em todos os arquivos alterados/criados. Detecção de `_isFirstRunInstall` validada contra os 3 cenários reais de caminho. Degradação graciosa do `build-installer.js` sem 7-Zip testada e funcionando.

## Descoberta real: Smart App Control bloqueia o Setup.exe — abordagem descartada (2026-07-20)

Instalei o 7-Zip de verdade (`winget install 7zip.7zip`) e gerei o `Engine Wallpaper Setup.exe` real pela primeira vez. Ao tentar rodar, o Windows bloqueou na hora: **"Uma política de Controle de Aplicativo bloqueou este arquivo."** — confirmado via registro que é o **Smart App Control** (`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState = 1`, totalmente ativo, não é modo de avaliação). É o padrão em instalações novas do Windows 11 e, uma vez ligado, **não dá pra desligar** sem reinstalar o Windows.

**Isolei a causa comparando 3 variantes lado a lado:**
1. `Engine Wallpaper.exe` puro (Electron renomeado, sem SFX) → roda liso, sem bloqueio.
2. SFX feito com `7z.exe a -sfx` (só extrai, sem rodar nada sozinho) → também roda liso.
3. SFX com o bloco de config `;!@Install@!...RunProgram="Engine Wallpaper.exe"...;!@InstallEnd@!` (extrai E roda outro programa sozinho, sem perguntar) → **bloqueado**.

Ou seja, não é o SFX em si, é especificamente um executável não assinado que **extrai e roda outro programa automaticamente sem confirmação do usuário** — que é literalmente o padrão clássico de "dropper" de malware. Decisão consciente: não vou ajustar a config pra tentar escapar dessa detecção — não é um bug de configuração pra contornar, é o comportamento que esses sistemas são desenhados pra pegar, e mesmo que funcionasse hoje nesta máquina, é o tipo de coisa que antivírus/Windows atualizam constantemente pra continuar detectando.

**Decisão do usuário (perguntado diretamente): voltar pro `.zip` simples** (`EngineWallpaper-vX.Y.Z-full.zip`, extrai manualmente e roda o exe — confirmado que isso NÃO é bloqueado) em vez do instalador autoexecutável.

**O que fica e o que sai:**
- `ui/installer.html`/`installer.js`, `_isFirstRunInstall`/`runFirstRunInstall()`/`createShortcut()` em `main.js` **continuam no código, dormentes** — não fazem nada com a distribuição em zip (só disparam se o exe rodar de dentro de uma pasta temp, o que não acontece manualmente). Ficam prontos caso um certificado de assinatura de código seja obtido no futuro (única forma correta e definitiva de resolver o bloqueio de qualquer instalador autoexecutável, custa dinheiro e exige verificação de identidade).
- `scripts/build-installer.js` continua existindo (útil se retomar com um certificado), mas **não é mais o caminho recomendado**.
- `bin/7z.exe`/`7z.sfx`/`7z.dll` ficam em `bin/` (ferramentas de build), mas `scripts/build-dist.js` foi corrigido pra **nunca** copiá-los pro pacote final do usuário (bug real que eu mesmo introduzi ao adicioná-los — sem essa exclusão, o pacote shipado ficaria com ~2.7MB de ferramentas de build inúteis pro usuário).
