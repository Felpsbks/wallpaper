# Dependências — Engine Wallpaper

## Dependências de produção

### koffi `^2.8.0`
- **Para que serve:** FFI (Foreign Function Interface) para chamar funções de DLLs do Windows diretamente do Node.js
- **Usado em:** `src/workerw.js` (user32.dll para WorkerW) e `src/fullscreen.js` (GetForegroundWindow, GetWindowRect)
- **Atenção:** É uma dependência nativa (`.node`) — precisa ser desempacotada do ASAR (`--unpack "**/*.node"`)

### adm-zip `^0.6.0`
- **Para que serve:** Extração de arquivos ZIP
- **Usado em:** `main.js` — para extrair os ZIPs de itens baixados do Steam Workshop

### qrcode `^1.5.4`
- **Para que serve:** Gerar imagens de QR Code
- **Usado em:** Autenticação no Steam via QR code scan

### three `0.148.0`
- **Para que serve:** Biblioteca de gráficos 3D WebGL
- **Usado em:** Cenas nativas do wallpaper (`wallpaper/scenes/particles.js`, `wallpaper/scenes/waves.js`)
- **Versão fixada:** `0.148.0` (não usa `^` — sem upgrades automáticos)
- **Import:** `require('three/build/three.cjs')` (versão CommonJS)

## Dependências de desenvolvimento

### electron-reload `^2.0.0-alpha.1`
- **Para que serve:** Hot-reload do Electron durante desenvolvimento
- **Usado em:** `main.js` linha 19 — `require('electron-reload')(__dirname)` (dentro de try/catch)
- **Inclui:** `chokidar` (usado por `scripts/dev.js` para watch de arquivos)

## Ferramentas de build (não são dependências npm)

| Ferramenta | Local | Para que serve |
|-----------|-------|----------------|
| `@electron/asar` | via `npx` | Empacotar o app em `.asar` |
| `xcopy` | Windows nativo | Copiar diretórios no Windows |
| `rcedit.exe` | `bin/rcedit.exe` | Embutir ícone/metadados no .exe |

## Electron

O Electron **não está** no `package.json` como dependência — o binário fica em `bin/electron.exe` e é chamado diretamente pelo script `npm start`.

Versão aproximada: Electron 28+ (baseado nas DLLs e snapshot V8 presentes em `bin/`).
