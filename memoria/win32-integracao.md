# Integração Win32 — Engine Wallpaper

O app usa a API do Windows diretamente via `koffi` (FFI) para funcionalidades que o Electron não expõe nativamente.

---

## Biblioteca: koffi

`koffi` é um FFI (Foreign Function Interface) para Node.js que permite chamar funções de DLLs do Windows sem precisar compilar um addon nativo em C++.

```javascript
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
```

**Por que precisa ser desempacotado do ASAR:**
- `.node` não pode ser carregado de dentro de um arquivo ASAR
- O script `pack.js` usa `--unpack "**/*.node"` para extraí-lo automaticamente

---

## Funções Win32 usadas

### `src/workerw.js` — Embedding no desktop

| Função | DLL | Assinatura | Uso |
|--------|-----|-----------|-----|
| `FindWindowA` | user32 | `(className, windowName) → HWND` | Encontrar Progman / WorkerW |
| `FindWindowExA` | user32 | `(parent, childAfter, class, name) → HWND` | Enumerar filhos de janela |
| `SendMessageTimeoutA` | user32 | `(hwnd, msg, wParam, lParam, flags, timeout, *result) → intptr_t` | Enviar 0x052C ao Progman |
| `SetParent` | user32 | `(child, newParent) → HWND` | Reparentar nossa janela |
| `EnumWindows` | user32 | `(callback, lParam) → bool` | Iterar janelas de nível superior |

**Callback de enumeração:**
```javascript
const EnumWindowsCb = koffi.proto('bool __stdcall EnumWindowsCb(void* hWnd, intptr_t lParam)');
const callback = koffi.register((hwnd, _lParam) => {
  // lógica...
  return true; // continuar enumeração
}, koffi.pointer(EnumWindowsCb));
koffi.unregister(callback); // sempre desregistrar após uso
```

### `src/fullscreen.js` — Detecção de tela cheia

| Função | DLL | Assinatura | Uso |
|--------|-----|-----------|-----|
| `GetForegroundWindow` | user32 | `() → HWND` | Janela atualmente em foco |
| `GetWindowRect` | user32 | `(hwnd, *RECT) → bool` | Dimensões da janela |
| `IsIconic` | user32 | `(hwnd) → bool` | Se a janela está minimizada |

**Struct customizada:**
```javascript
koffi.struct('RECT_FS', {
  left:   'int',
  top:    'int',
  right:  'int',
  bottom: 'int'
});
```

---

## Mensagem especial do WorkerW: `0x052C`

Esta é a mensagem "secreta" para criar o WorkerW entre o desktop e os ícones:

```javascript
SendMessageTimeoutA(progman, 0x052C, 0, 0, 0, 1000, smResult);
```

- Não está documentada oficialmente pela Microsoft
- É usada por Wallpaper Engine, Lively Wallpaper e outros apps de wallpaper animado
- Funciona desde Windows 7; comportamento testado até Windows 11

---

## Registro do Windows

O app consulta o registro para:
1. **Caminho do Steam:** `HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam > InstallPath`
2. **Autostart:** `app.setLoginItemSettings()` do Electron (via `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`)

---

## Detecção de processos

Para as App Rules, o app verifica processos rodando:

```javascript
const output = execSync('tasklist /fo csv /nh', { encoding: 'utf-8' });
// Retorna linhas CSV:
// "game.exe","1234","Console","1","50,000 K"
// Faz match case-insensitive com exe da regra
```

---

## Captura de áudio desktop

Usa a API do Chromium (Electron) para capturar o áudio do sistema:

```javascript
// main.js — handler IPC
ipcMain.handle('get-desktop-audio-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources[0]?.id; // ID do primeiro display
});

// wallpaper.js — usa o ID para criar stream
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: 'desktop' } },
  video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
});
```

**Nota:** `SharedArrayBuffer` precisa estar habilitado (`enable-features SharedArrayBuffer`) para que a captura de áudio funcione em alguns contextos.

---

## Flags de segurança desabilitadas

Para algumas funcionalidades Win32/web funcionarem:

```javascript
app.commandLine.appendSwitch('disable-web-security');
// Necessário para: webview acessar recursos locais, CORS em wallpapers web
```

```javascript
// BrowserWindow de wallpaper:
webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
  webviewTag: true,
  webSecurity: false
}
```
