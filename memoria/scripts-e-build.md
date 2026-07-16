# Scripts e Build — Engine Wallpaper

## Scripts npm

```bash
npm start          # Lança bin/electron.exe diretamente
npm run pack       # Empacota o app em bin/resources/app.asar
npm run dev        # Modo desenvolvimento: empacota + lança + assiste mudanças
npm run icons      # Gera ícones (scripts/gen-icon.js)
npm run dist       # Build completa: ícones + pack + build-dist
```

## Fluxo de desenvolvimento (`npm run dev`)

```
scripts/dev.js
 ├── 1. Executa pack.js → gera app.asar
 ├── 2. Lança bin/electron.exe
 └── 3. Assiste com chokidar:
         • main.js, ui/, src/, wallpaper/, assets/
         • Ao detectar mudança: debounce 500ms → pack + restart
```

**Por que precisa empacotar antes de rodar?**
O `bin/electron.exe` só carrega módulos nativos (como `koffi`) corretamente quando lê do ASAR. Rodar o `main.js` diretamente sem empacotar falha na inicialização — ver memory em `project_electron_binary.md`.

## Fluxo de empacotamento (`scripts/pack.js`)

```
1. Cria pasta temporária em %TEMP%/ew_app_src/
2. Copia: main.js, package.json
3. Copia dirs: src/, wallpaper/, ui/, assets/
4. Copia node_modules/ (exceto 'electron' e '.bin')
5. npx @electron/asar pack <tmp> bin/resources/app.asar --unpack "**/*.node"
6. Remove pasta temporária
```

O flag `--unpack "**/*.node"` garante que módulos nativos (koffi.node) fiquem fora do ASAR (ao lado dele em `app.asar.unpacked/`), o que é necessário porque o Node.js não consegue fazer `dlopen` de arquivos dentro de um ASAR.

## Fluxo de build de distribuição (`scripts/build-dist.js`)

```
1. Limpa dist/ inteiro
2. Copia bin/ → dist/Engine Wallpaper/
   • electron.exe → Engine Wallpaper.exe (renomeado)
   • rcedit.exe é excluído da cópia
3. Embute ícone e metadados via rcedit.exe:
   • assets/icon.ico → Engine Wallpaper.exe
   • FileVersion: 1.0.0.0
   • ProductName: Engine Wallpaper
4. Output final: dist/Engine Wallpaper/  (~350+ MB com runtime Electron)
```

## Comando completo de distribuição

```bash
npm run dist
# equivale a:
node scripts/gen-icon.js && node scripts/pack.js && node scripts/build-dist.js
```

## Flags do Chromium (main.js — economia de RAM)

```javascript
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-spell-checking');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('disable-pdf-extension');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-metrics');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
```

## Argumentos de linha de comando

| Argumento | Modo | Comportamento |
|-----------|------|---------------|
| `/s` ou `-s` | Screensaver | Janela fullscreen, focusable, alwaysOnTop |
| `/c` ou `-c` | Config | Abre somente o painel de controle |
| `/p` ou `-p` | Preview | Encerra imediatamente (`app.exit(0)`) — não suportado |
