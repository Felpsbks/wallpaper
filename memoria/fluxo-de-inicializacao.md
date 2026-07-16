# Fluxo de Inicialização — Engine Wallpaper

Documenta o que acontece desde a execução do `electron.exe` até o wallpaper estar renderizando na área de trabalho.

---

## Passo a passo — `main.js`

```
┌─ 1. CHROMIUM FLAGS ────────────────────────────────────────────────┐
│   Aplicados ANTES de qualquer require — economiza RAM              │
│   disable-print-preview, disable-spell-checking, etc.              │
│   js-flags: --max-old-space-size=256                               │
└────────────────────────────────────────────────────────────────────┘
         ↓
┌─ 2. ARGS DA LINHA DE COMANDO ──────────────────────────────────────┐
│   /s → screensaver mode                                            │
│   /c → config mode (só UI)                                         │
│   /p → preview mode → app.exit(0) imediatamente                   │
└────────────────────────────────────────────────────────────────────┘
         ↓
┌─ 3. ELECTRON-RELOAD ───────────────────────────────────────────────┐
│   try { require('electron-reload')(__dirname) } catch (_) {}       │
│   Hot-reload em dev; silencioso em produção                        │
└────────────────────────────────────────────────────────────────────┘
         ↓
┌─ 4. INICIALIZAÇÃO DE MÓDULOS ──────────────────────────────────────┐
│   const store    = new Store()      → carrega config.json          │
│   const playlist = new Playlist(store)  → lê playlistConfig       │
└────────────────────────────────────────────────────────────────────┘
         ↓
┌─ 5. app.on('ready') ───────────────────────────────────────────────┐
│                                                                     │
│   5a. createWallpaperWindows()                                     │
│       • screen.getAllDisplays()                                     │
│       • Para cada display: spawnWallpaperWindow(display)           │
│         - BrowserWindow sem frame, transparent, não focusável      │
│         - webPreferences: nodeIntegration, webviewTag              │
│         - Carrega wallpaper/index.html                             │
│         - Após 'did-finish-load': embedBehindDesktop(hwnd)         │
│           (posiciona atrás dos ícones via WorkerW)                 │
│       • Registra listeners display-added / display-removed         │
│                                                                     │
│   5b. createControlWindow()   [se não for screensaver]             │
│       • BrowserWindow normal (frame, focusable)                    │
│       • Carrega ui/index.html                                      │
│       • Esconde ao fechar (permanece no tray)                      │
│                                                                     │
│   5c. createTray()                                                 │
│       • Ícone: assets/tray.png                                     │
│       • Menu: Abrir, Pausar/Retomar, Sair                          │
│       • Duplo clique: mostra painel                                │
│                                                                     │
│   5d. Registra IPC handlers (ipcMain.handle)                       │
│       • get/set library, wallpaper, settings, rules, etc.          │
│       • workshop-search, workshop-download                         │
│       • open-file-dialog, get-desktop-audio-source                 │
│                                                                     │
│   5e. Aplica wallpaper ativo                                       │
│       • store.get('activeWallpaper') → envia para janelas          │
│                                                                     │
│   5f. Inicia sistemas de automação                                 │
│       • playlist.start() se config.enabled                         │
│       • setInterval para fullscreen check (~2s)                    │
│       • setInterval para app rules check (~2s)                     │
│       • setInterval para time rules check (~30s)                   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
         ↓
┌─ 6. JANELAS DE WALLPAPER (renderer) ───────────────────────────────┐
│   wallpaper/index.html carregado em cada monitor                   │
│   wallpaper/wallpaper.js inicializado:                             │
│   • Referências às 4 camadas (video, image, web, canvas)           │
│   • initAudioVisualizer() se audioReactive = true                  │
│   • ipcRenderer.on('set-wallpaper', ...)                           │
└────────────────────────────────────────────────────────────────────┘
         ↓
┌─ 7. EMBEDDING NO DESKTOP ──────────────────────────────────────────┐
│   src/workerw.js — embedBehindDesktop(hwnd)                        │
│   1. FindWindowA('Progman') → handle do shell                      │
│   2. SendMessageTimeoutA(0x052C) → cria WorkerW                    │
│   3. EnumWindows → encontra o WorkerW correto                      │
│   4. SetParent(browserWindowHwnd, workerW)                         │
│   → Wallpaper aparece ATRÁS dos ícones do desktop                  │
└────────────────────────────────────────────────────────────────────┘
         ↓
┌─ 8. WALLPAPER RENDERIZANDO ────────────────────────────────────────┐
│   main.js envia 'set-wallpaper' com o activeWallpaper              │
│   wallpaper.js recebe e ativa a camada correta:                    │
│   • video → videoEl.src + play()                                   │
│   • image → imageEl.src                                            │
│   • url   → webEl.src                                              │
│   • scene → instancia classe da cena + start()                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## Modo screensaver vs normal

| Aspecto | Normal | Screensaver (`/s`) |
|---------|--------|---------------------|
| Janela do wallpaper | `focusable: false`, `skipTaskbar: true` | `focusable: true`, `alwaysOnTop: true`, `fullscreen: true` |
| WorkerW embedding | Sim | Não (janela fica na frente) |
| Painel de controle | Aberto | Não aberto |
| Fechar com tecla | Não | Sim (ESC fecha) |

---

## Ciclo de vida — eventos importantes

```javascript
app.on('ready', ...)                  // inicialização completa
app.on('window-all-closed', ...)      // não fecha o app (permanece no tray)
app.on('before-quit', ...)            // limpeza antes de sair
screen.on('display-added', ...)       // novo monitor conectado
screen.on('display-removed', ...)     // monitor desconectado
playlist.on('change', wallpaper => ...)  // próximo wallpaper da playlist
```
