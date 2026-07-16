# Estrutura de Pastas — Engine Wallpaper

```
EngineWallpaper/
│
├── main.js                     # Processo principal do Electron (34 KB)
├── package.json                # Dependências e scripts npm
├── package-lock.json           # Lock de dependências
├── .gitignore                  # Arquivos ignorados pelo git
├── _asar_main.js               # Arquivo de entrada do ASAR empacotado
├── test_validation.js          # Testes de validação
├── dev_out.txt                 # Log de saída de desenvolvimento
│
├── src/                        # Módulos do processo principal
│   ├── store.js                # Persistência de configuração (JSON)
│   ├── playlist.js             # Rotação de wallpapers (playlist)
│   ├── workerw.js              # Integração Win32 WorkerW (embutir na área de trabalho)
│   └── fullscreen.js           # Detecção de app em tela cheia
│
├── ui/                         # Interface de controle (renderer process)
│   ├── index.html              # Layout do painel de controle
│   ├── app.js                  # Lógica da UI (49 KB)
│   └── styles.css              # Estilos (dark theme, accent #5a54f9)
│
├── wallpaper/                  # Engine de renderização do wallpaper
│   ├── index.html              # Canvas de wallpaper (4 camadas)
│   ├── wallpaper.js            # Lógica do wallpaper (carregamento, áudio, cenas)
│   └── scenes/                 # Cenas 3D/2D nativas
│       ├── particles.js        # Campo de partículas (Three.js)
│       ├── waves.js            # Plano de ondas wireframe (Three.js)
│       ├── matrix.js           # Matrix digital rain (Canvas 2D)
│       ├── aurora.js           # Aurora Boreal (Canvas 2D)
│       └── visualizer.js       # Visualizador de áudio reativo (Canvas 2D)
│
├── scripts/                    # Automação de build e dev
│   ├── dev.js                  # Watcher de desenvolvimento (pack + restart)
│   ├── pack.js                 # Empacotador ASAR
│   ├── build-dist.js           # Build de distribuição (cria pasta dist/)
│   └── gen-icon.js             # Gerador de ícones
│
├── assets/                     # Recursos estáticos
│   ├── icon.ico                # Ícone do executável Windows
│   ├── icon.png                # Ícone do app
│   └── tray.png                # Ícone do system tray
│
├── bin/                        # Runtime do Electron + executável
│   ├── electron.exe            # Binário do Electron
│   ├── rcedit.exe              # Ferramenta para embutir ícone no .exe
│   ├── resources/
│   │   ├── app.asar            # App empacotado (gerado pelo pack.js)
│   │   └── default_app.asar    # App padrão do Electron
│   ├── locales/                # Pacotes de idioma (50+)
│   ├── libEGL.dll              # Driver GPU
│   ├── libGLESv2.dll           # Driver GPU OpenGL ES
│   ├── d3dcompiler_47.dll      # Compilador DirectX
│   ├── ffmpeg.dll              # Codec de vídeo
│   └── vk_swiftshader.dll      # Fallback Vulkan
│
├── dist/                       # Saída da build de distribuição
│   └── Engine Wallpaper/
│       ├── Engine Wallpaper.exe  # Executável final (renomeado)
│       └── [runtime Electron completo]
│
├── memoria/                    # Esta pasta: documentação do projeto
│
└── node_modules/               # Dependências npm
```

## Arquivos críticos para editar

| Você quer mudar... | Edite |
|-------------------|-------|
| Comportamento do app, IPC, Steam | `main.js` |
| Aparência/lógica do painel | `ui/app.js` + `ui/styles.css` |
| Como o wallpaper renderiza | `wallpaper/wallpaper.js` |
| Uma cena específica | `wallpaper/scenes/<nome>.js` |
| Persistência de dados | `src/store.js` |
| Lógica da playlist | `src/playlist.js` |
| Embedding no desktop | `src/workerw.js` |
| Detecção de fullscreen | `src/fullscreen.js` |
| Build/empacotamento | `scripts/pack.js` ou `scripts/build-dist.js` |
