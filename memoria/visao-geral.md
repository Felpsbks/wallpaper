# Visão Geral — Engine Wallpaper

## O que é

**Engine Wallpaper** é uma aplicação desktop para Windows que permite configurar wallpapers animados e dinâmicos diretamente na área de trabalho. O usuário pode usar vídeos, imagens, websites embutidos, cenas 3D/2D geradas em tempo real, ou conteúdo baixado do Steam Workshop.

## Dados do projeto

| Campo | Valor |
|-------|-------|
| Nome do pacote | `engine-wallpaper` |
| Versão | `1.0.0` (package.json) / `2.0.0` (commit history) |
| Plataforma alvo | Windows (Win32) |
| Framework | Electron |
| Entry point | `main.js` |
| Idioma da UI | Português (pt-BR) |
| Cor de destaque | `#5a54f9` |

## Tipos de wallpaper suportados

1. **Vídeo** — MP4, WebM, com loop e controle de volume
2. **Imagem** — PNG, JPG, com efeitos de fade
3. **Website (URL)** — embutido via `<webview>` do Electron
4. **Cena** — animações 3D/2D nativas (5 opções built-in)
5. **Steam Workshop** — conteúdo baixado em formato `project.json`

## Funcionalidades principais

- Suporte a múltiplos monitores (uma janela de wallpaper por display)
- Playlist com rotação automática e modo shuffle
- Detecção de app em tela cheia para pausar/mutar o wallpaper
- Regras por nome de executável (.exe)
- Agendamento por horário (HH:MM)
- Integração com sistema de bandeja (tray icon)
- Inicialização automática com o Windows
- Captura de áudio do desktop para visualização reativa
- Navegador integrado do Steam Workshop
