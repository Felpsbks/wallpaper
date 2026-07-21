# Ícone real do app (não era o logo de verdade) — 2026-07-20

## O bug

O usuário reparou que "Engine Wallpaper" aparecia com um ícone genérico na tela de "Controle de aplicativo e navegador" do Windows. Investigando: `scripts/gen-icon.js` nunca usou o logo real do projeto — ele **desenhava** um ícone programaticamente (um encoder de PNG feito à mão, mais uma função `drawPixel` matemática desenhando um círculo com um triângulo de "play" dentro, tipo um placeholder genérico de app de mídia). Isso vinha de uma fase inicial do projeto, antes de existir a marca real (o logo roxo "phoenix/redemoinho" usado em todo o resto do app — `logo-loading.png`, `logo-tray.png`, etc.).

Confirmado com extração real do ícone embutido no `.exe` (via `[System.Drawing.Icon]::ExtractAssociatedIcon`) — era mesmo esse placeholder genérico, não um bug de exibição do Windows.

## Fix

Reescrito `scripts/gen-icon.js` pra usar `ui/logo-tray.png` (a versão só-marca, sem texto, 256×256 — as versões `logo-app-square.png`/`logo-app-zoomed.png` têm "FYNIX WALLPAPER ENGINE" escrito, ilegível em 16×16/32×32) como fonte real. Redimensiona via `System.Drawing` do .NET (chamado por `execSync` rodando um `.ps1` temporário) — sem precisar de nenhuma dependência nova tipo `sharp`/`jimp`, reaproveitando a mesma técnica já usada nesta sessão pra extrair ícone de `.exe` pra debug. O encoder de ICO (embute PNGs direto, compatível Vista+) já existia e foi mantido, só passou a receber os PNGs redimensionados reais em vez dos gerados por código.

## Validado

- `assets/icon.png` conferido visualmente — logo real (redemoinho roxo), não mais o placeholder.
- Ícone extraído de dentro do `.exe` depois do rebuild (`Engine Wallpaper.exe`) — confirmado visualmente que é o logo real, não o placeholder antigo.
- `npm run dist` completo rodou limpo, zip de distribuição regenerado.
