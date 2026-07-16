# UI — Painel de Controle — Engine Wallpaper

Arquivos: `ui/index.html`, `ui/app.js` (49 KB), `ui/styles.css`

---

## Layout geral

O painel tem uma barra lateral com abas e uma área de conteúdo principal.

### Abas principais

| Aba | Ícone | Funcionalidade |
|-----|-------|----------------|
| Library | 🖼️ | Gerenciar wallpapers salvos |
| Workshop | 🎮 | Navegar e baixar do Steam Workshop |
| Playlist | 📋 | Configurar rotação automática |
| Settings | ⚙️ | Volume, autostart, tela cheia, áudio |

### Seções secundárias

- **Display** — selecionar qual monitor recebe o wallpaper
- **Time Rules** — agendar trocas por horário
- **App Rules** — pausar/mutar quando app específico roda
- **Log** — console de debug (mensagens do processo principal)

---

## Seção: Library

**Gerenciamento da biblioteca local de wallpapers.**

Ações disponíveis:
- **Adicionar** — abre dialog de arquivo (`ipc: open-file-dialog`) ou digita URL/nome de cena
- **Pesquisar** — filtro em tempo real por nome
- **Selecionar** — clique na thumbnail aplica o wallpaper no display selecionado
- **Editar** — muda nome, thumbnail, propriedades
- **Deletar** — remove da biblioteca (não apaga o arquivo)

**Formato de um wallpaper na biblioteca:**
```javascript
{
  id: "uuid-gerado",
  name: "Meu Wallpaper",
  type: "video",      // video | image | url | scene | workshop
  path: "C:/...",     // ou URL/sceneId
  thumbnail: "...",   // base64 ou path
  properties: {}      // opções customizadas (volume, speed, etc.)
}
```

---

## Seção: Workshop

**Navegador integrado do Steam Workshop.**

Funcionalidades:
- Browse por trending/recentes
- Pesquisa por texto
- Paginação
- Thumbnail + título + tags de cada item
- Botão de download → inicia `workshop-download`
- Progresso de download via `workshop-progress` IPC
- Login com QR Code quando necessário

---

## Seção: Playlist

**Configuração da rotação automática.**

Controles:
- Toggle on/off
- Slider de intervalo (segundos)
- Toggle shuffle
- Botões "anterior" / "próximo" (manual)
- Preview da ordem atual da playlist

---

## Seção: Settings

```
Volume geral:          [slider 0-100%]
Iniciar com Windows:   [toggle]
Pausar em tela cheia:  [toggle]
Mutar em tela cheia:   [toggle]
Áudio reativo:         [toggle]
```

---

## Sistema de tray (system tray)

**Arquivo:** `main.js` — `createTray()`

**Ícone:** `assets/tray.png`

**Menu do tray:**
```
Engine Wallpaper          (título, desabilitado)
─────────────────
Abrir painel              → abre/foca controlWin
─────────────────
Pausar                    → pausa todos os wallpapers
Retomar                   → retoma todos
─────────────────
Sair                      → app.quit()
```

**Duplo clique:** abre o painel de controle

---

## Estilo visual (`ui/styles.css`)

- **Tema:** dark (fundo `#1a1a2e` / `#16213e`)
- **Cor de destaque:** `#5a54f9` (roxo-azulado)
- **Fonte:** sistema (sans-serif)
- **Cards:** bordas arredondadas, sombras suaves
- **Transições:** hover com transform scale
- **Scrollbar:** customizada para combinar com o tema
- **Glassmorphism:** alguns elementos com `backdrop-filter: blur`

---

## Logging

```javascript
// main.js envia logs para a UI via IPC
function appLog(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('app-log', { ts, msg, level });
  }
}

appLog.ok    = (msg) => appLog(msg, 'success');
appLog.warn  = (msg) => appLog(msg, 'warn');
appLog.err   = (msg) => appLog(msg, 'error');
appLog.debug = (msg) => appLog(msg, 'debug');
```

A aba "Log" da UI escuta o canal `app-log` e exibe as mensagens com cores por nível.
