# Módulos Backend — Engine Wallpaper

Todos ficam em `src/` e rodam no processo principal (main process).

---

## `src/store.js` — Persistência de configuração

**Classe:** `Store`

Armazena a configuração do app em JSON no diretório home do usuário.

**Localização do arquivo:** `~/.engine-wallpaper/config.json`  
(ex: `C:\Users\kille\.engine-wallpaper\config.json`)

### API

```javascript
const store = new Store();

store.get('library')           // retorna o valor da chave
store.set('library', [...])   // salva o valor e persiste no disco
store.delete('library')       // remove a chave e persiste
```

### Chaves usadas no config.json

| Chave | Tipo | Descrição |
|-------|------|-----------|
| `library` | array | Lista de wallpapers cadastrados pelo usuário |
| `playlistConfig` | object | `{enabled, interval, shuffle}` |
| `settings` | object | Volume, autostart, etc. |
| `timeRules` | array | Regras de wallpaper por horário |
| `appRules` | array | Regras por nome de .exe |
| `activeWallpaper` | object | Wallpaper atualmente ativo |
| `displayAssignments` | object | Mapa displayId → wallpaperId |

---

## `src/playlist.js` — Rotação de wallpapers

**Classe:** `Playlist extends EventEmitter`

Gerencia a troca automática de wallpapers em intervalos definidos pelo usuário.

### Configuração

```javascript
{
  enabled: false,   // ativa/desativa a playlist
  interval: 30,     // segundos entre trocas
  shuffle: false    // ordem aleatória
}
```

### API

```javascript
const playlist = new Playlist(store);

playlist.configure(config)   // aplica nova config (para e reinicia se enabled)
playlist.start()             // inicia o timer
playlist.stop()              // para o timer
playlist.next()              // avança manualmente
playlist.previous()          // volta manualmente
```

### Evento emitido

```javascript
playlist.on('change', (wallpaper) => {
  // wallpaper = item da biblioteca a ser exibido
});
```

A lógica de shuffle usa `Math.random()` para escolher um índice aleatório da biblioteca. Sem shuffle, percorre sequencialmente com módulo.

---

## `src/workerw.js` — Embedding no desktop

**Função:** `embedBehindDesktop(hwndBuffer)`

Usa a API Win32 para posicionar a janela do wallpaper **atrás dos ícones da área de trabalho**, criando o efeito de wallpaper vivo.

### Como funciona

```
1. FindWindowA('Progman', null)
      → Encontra a janela raiz do Shell do Windows

2. SendMessageTimeoutA(progman, 0x052C, 0, 0, 0, 1000, ...)
      → Mensagem especial que faz o Progman criar um WorkerW entre desktop e ícones

3. EnumWindows(callback)
      → Itera todas as janelas para encontrar o WorkerW correto
      → Identifica pela presença de um filho 'SHELLDLL_DefView'

4. SetParent(hwndBrowserWindow, workerW)
      → Reparenta nossa janela Electron para ficar dentro do WorkerW
```

### Dependências

- `koffi` — FFI para chamar `user32.dll`
- Funções Win32: `FindWindowA`, `FindWindowExA`, `SendMessageTimeoutA`, `SetParent`, `EnumWindows`
- Só funciona em `process.platform === 'win32'`

---

## `src/fullscreen.js` — Detecção de tela cheia

**Função:** `isFullscreenAppRunning(displays)`

Verifica se existe algum app em tela cheia cobrindo um dos monitores. Usado para pausar/mutar o wallpaper automaticamente.

### Lógica

```
1. GetForegroundWindow()  → janela em foco
2. IsIconic(hwnd)         → se minimizada, não conta
3. GetWindowRect(hwnd)    → obtém dimensões da janela
4. Compara com bounds de cada display
5. Se cobrir completamente qualquer display → retorna true
```

### Dependências

- `koffi` — FFI para `user32.dll`
- Funções Win32: `GetForegroundWindow`, `GetWindowRect`, `IsIconic`
- Struct customizada: `RECT_FS { left, top, right, bottom }`
