# Arquitetura — Engine Wallpaper

## Modelo de processos Electron

```
┌─────────────────────────────────────────────────────┐
│                   MAIN PROCESS                      │
│                    main.js                          │
│                                                     │
│  • Lifecycle (app ready/quit)                       │
│  • Tray icon                                        │
│  • IPC handlers                                     │
│  • Store (config.json)                              │
│  • Playlist engine                                  │
│  • Steam Workshop integration                       │
│  • Win32 WorkerW embedding                          │
│  • Fullscreen / App rule detection                  │
│  • Time-based rule scheduler                        │
└──────────┬────────────────────────┬─────────────────┘
           │ IPC                    │ IPC
           ▼                        ▼
┌──────────────────┐    ┌─────────────────────────────┐
│  RENDERER: UI    │    │  RENDERER: Wallpaper         │
│  ui/index.html   │    │  wallpaper/index.html        │
│  ui/app.js       │    │  wallpaper/wallpaper.js      │
│                  │    │  (1 por monitor)             │
│  • Biblioteca    │    │                              │
│  • Workshop      │    │  Camadas (z-index):          │
│  • Playlist cfg  │    │   #video-layer (video)       │
│  • Settings      │    │   #image-layer (img)         │
│  • Time rules    │    │   #web-layer (webview)       │
│  • Display cfg   │    │   #scene-layer (canvas)      │
└──────────────────┘    └─────────────────────────────┘
```

## Comunicação IPC (Main ↔ Renderer)

### Main → UI (`controlWin.webContents.send`)
| Canal | Dados | Descrição |
|-------|-------|-----------|
| `app-log` | `{ts, msg, level}` | Logs do processo principal |
| `workshop-progress` | string | Progresso de download |

### UI → Main (`ipcRenderer.invoke`)
| Canal | Retorno | Descrição |
|-------|---------|-----------|
| `get-library` | array | Lista de wallpapers salvos |
| `add-to-library` | wallpaper | Adiciona item à biblioteca |
| `remove-from-library` | - | Remove item pelo id |
| `set-wallpaper` | - | Define wallpaper ativo |
| `get-displays` | array | Lista de monitores conectados |
| `get-settings` | object | Configurações atuais |
| `set-settings` | - | Salva configurações |
| `get-playlist-config` | object | Config da playlist |
| `set-playlist-config` | - | Atualiza config da playlist |
| `get-time-rules` | array | Regras de horário |
| `set-time-rules` | - | Salva regras de horário |
| `get-app-rules` | array | Regras por .exe |
| `set-app-rules` | - | Salva regras por .exe |
| `workshop-search` | array | Pesquisa no Workshop |
| `workshop-download` | - | Baixa item do Workshop |
| `open-file-dialog` | string | Abre seletor de arquivo |
| `get-desktop-audio-source` | string | Source ID do áudio desktop |

### Main → Wallpaper (`wallpaperWindows[id].webContents.send`)
| Canal | Dados | Descrição |
|-------|-------|-----------|
| `set-wallpaper` | wallpaper object | Carrega novo wallpaper |
| `pause-wallpaper` | - | Pausa reprodução |
| `resume-wallpaper` | - | Retoma reprodução |
| `mute-wallpaper` | bool | Mutar/desmutar |
| `set-volume` | 0-1 | Ajusta volume |

## Multi-display

- `screen.getAllDisplays()` retorna todos os monitores na inicialização
- Uma `BrowserWindow` de wallpaper é criada para cada display
- Eventos `display-added` e `display-removed` gerenciam janelas dinamicamente
- Cada janela é mapeada por `displayId` no `Map<id, BrowserWindow>`
- Wallpaper pode ser global (todos os monitores) ou por display específico
