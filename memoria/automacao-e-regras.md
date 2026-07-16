# Automação e Regras — Engine Wallpaper

O app tem um sistema de automação que controla o wallpaper de forma inteligente baseado em contexto.

---

## 1. Playlist — Rotação automática

**Configuração salva em:** `config.json > playlistConfig`

```javascript
{
  enabled: false,    // ativa/desativa
  interval: 30,      // segundos entre trocas (padrão: 30s)
  shuffle: false     // aleatório ou sequencial
}
```

**Comportamento:**
- Timer com `setInterval` em `src/playlist.js`
- Emite evento `change` com o próximo wallpaper da biblioteca
- `main.js` escuta e aplica o wallpaper em todos os monitores (ou no display alvo)
- Sem shuffle: índice circular (`(index + 1) % library.length`)
- Com shuffle: índice aleatório a cada ciclo

**Controle manual:** botões "anterior" e "próximo" no painel invocam `playlist.previous()` / `playlist.next()`.

---

## 2. Detecção de tela cheia — Pausa automática

**Arquivo:** `src/fullscreen.js`

**Verificação:** polling com `setInterval` no `main.js` a cada ~2 segundos

**Lógica:**
```
GetForegroundWindow() → janela em foco
IsIconic(hwnd)         → ignora minimizadas
GetWindowRect(hwnd)    → pega dimensões
Compara com cada display.bounds
→ se cobrir qualquer display: fullscreen = true
```

**Ação quando fullscreen detectado:**
- Pausa o wallpaper (envia `pause-wallpaper` para janelas)
- Opcionalmente muta (dependendo das settings)
- Quando fullscreen termina: retoma (`resume-wallpaper`)

**Configurável pelo usuário** no painel de Settings (pode desativar).

---

## 3. Regras por aplicativo (App Rules)

**Configuração salva em:** `config.json > appRules`

```javascript
[
  {
    exe: "game.exe",       // nome do processo (case-insensitive)
    action: "pause",       // "pause" | "mute" | "stop"
    displayId: null        // null = todos | number = display específico
  }
]
```

**Como detecta:** `execSync('tasklist /fo csv /nh')` no Windows — lista processos rodando.

**Verificação:** polling periódico (mesmo intervalo do fullscreen check).

**Ações disponíveis:**
- `pause` — pausa renderização/vídeo
- `mute` — silencia sem pausar
- `stop` — para completamente (requer reinício manual)

---

## 4. Regras de horário (Time Rules)

**Configuração salva em:** `config.json > timeRules`

```javascript
[
  {
    time: "09:00",         // HH:MM (24h)
    wallpaperId: "abc123", // ID do wallpaper na biblioteca
    displayId: null        // null = todos | number = display específico
  },
  {
    time: "22:00",
    wallpaperId: "def456"
  }
]
```

**Como funciona:**
- `setInterval` no `main.js` verifica o horário atual a cada ~30 segundos
- Compara `HH:MM` atual com regras
- Quando bate: aplica o wallpaper configurado
- Cada regra só dispara uma vez por dia (marcada como disparada até meia-noite)

---

## 5. Settings gerais

**Configuração salva em:** `config.json > settings`

```javascript
{
  volume: 0.5,                  // 0.0 a 1.0
  muteOnFullscreen: true,       // muta em vez de pausar quando fullscreen
  pauseOnFullscreen: true,      // pausa em vez de muta quando fullscreen
  autostart: false,             // iniciar com o Windows
  audioReactive: false          // habilitar captura de áudio desktop
}
```

**Autostart:** configura entrada no registro do Windows (Login Items) via Electron `app.setLoginItemSettings()`.

---

## Diagrama de prioridade das automações

```
Tela cheia detectada?  ──YES──→ Aplica muteOnFullscreen ou pauseOnFullscreen
      │
     NO
      │
App Rule ativa? ────────YES──→ Aplica action (pause/mute/stop)
      │
     NO
      │
Time Rule disparou? ────YES──→ Troca para wallpaper configurado
      │
     NO
      │
Playlist tick? ─────────YES──→ Avança para próximo da biblioteca
      │
     NO
      │
Nenhuma automação — wallpaper permanece como está
```
