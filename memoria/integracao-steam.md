# Integração Steam — Engine Wallpaper

*(Corrigido em 2026-07-20 — a versão anterior deste doc descrevia scraping+ZIP+QR code, que não bate com o código atual. O app não baixa nada "por fora" da Steam: ele automatiza inscrição via sessão web real e deixa o download de fato por conta do cliente Steam instalado.)*

O app tem um feed "Descobrir" que navega o Workshop da Wallpaper Engine (appid `431960`) e permite baixar itens, mas o download em si sempre passa pela conta Steam real do usuário e pelo cliente Steam instalado — não existe download direto/bypass.

---

## Visão geral do fluxo real

```
UI (aba Descobrir)
  → ipcRenderer.invoke('download-workshop-item', { workshopId, name })
     → main.js confere cookies de sessão salvos (steamWebCookies)
        → sem cookies: retorna 'needs_login' → abre janela de login Steam
     → confere se a conta possui Wallpaper Engine (appid 431960)
        → não possui: bloqueia, mostra aviso explícito
     → POST autenticado em steamcommunity.com/sharedfiles/subscribe
        (inscreve a conta real no item, como um clique real em "Subscribe")
     → espera (polling, até 4min) a pasta local
        steamapps/workshop/content/431960/<id> ganhar arquivos
        — quem baixa de fato é o CLIENTE STEAM, não o app
     → importa da pasta pra biblioteca local (importFromContentDir)
```

**Requisitos reais no PC do usuário final:**
- Steam instalada e **aberta** (é ela quem baixa o arquivo).
- Conta Steam **possui o Wallpaper Engine** (appid 431960, pago) — sem isso o download fica bloqueado mesmo logado.
- Logado no cliente Steam com a **mesma conta** usada no login web do app.

---

## Login Steam (sessão web)

`ipcMain.handle('steam-web-login', ...)`: abre uma `BrowserWindow` carregando a página real `https://steamcommunity.com/login/home/?goto=` — o usuário loga normalmente (usuário/senha, 2FA, ou QR se a própria Steam oferecer). Ao detectar redirecionamento pra `steamcommunity.com/` (ou `/id/`, `/profiles/`), captura os cookies (`sessionid`, `steamLoginSecure`) da sessão e salva em `store` (`steamWebCookies`) pra reusar depois.

Existe também exportar/importar sessão entre PCs (`export-steam-session`/`import-steam-session`) — gera um código que carrega esses cookies noutra instalação, sem precisar logar de novo.

---

## Verificação de posse do app (`checkOwnsApp`)

Antes de tentar inscrever, o app confere via `dynamicstore/userdata` (com os cookies da sessão) se a conta logada tem o appid `431960` (Wallpaper Engine) na biblioteca Steam. Sem isso, a Steam nem deixaria a inscrição acontecer de verdade — o app antecipa e mostra um aviso claro em vez de deixar falhar silenciosamente.

---

## Limitação real confirmada: precisa do Wallpaper Engine instalado

Testado ao vivo em 2026-07-20: usuário desinstalou o Wallpaper Engine (mas seguia dono do app na Steam) e o download de um item novo do Workshop nunca completou — ficou preso até o timeout de 4 minutos.

Causa confirmada com dado real: consultei `GetPublishedFileDetails` pro item da Miku (`3005028837`) e `file_url` veio **vazio** (`""`), só `hcontent_file` populado. Isso significa que o conteúdo do Workshop da Wallpaper Engine é servido pelo sistema de depot da Steam (SteamPipe), não por upload simples de arquivo — não existe link HTTP direto pra baixar via API pra esse tipo de conteúdo. A única forma de baixar depot/Workshop content é pelo cliente Steam de verdade (que exige o app associado pelo menos registrado/instalado) ou via SteamCMD.

**SteamCMD está descartado por decisão prévia do usuário** — ver `feedback-no-steamcmd` na memória (já causou problema antes, revertido numa sessão anterior). Não é uma opção a reconsiderar.

**Conclusão:** com o approach atual (web-subscribe + poll da pasta local), **não tem como baixar itens novos do Workshop sem o Wallpaper Engine estar instalado** — é limitação da própria Steam (como ela distribui conteúdo de depot), não do nosso código. Usuário pode instalar → baixar o que precisa → desinstalar depois (não confirmado se o conteúdo já baixado permanece na pasta após desinstalar o WE — não testado).

Ainda sem mudança de código pra isso — usuário pediu só documentar por enquanto (2026-07-20). Ideias em aberto pra quando for revisitar: avisar na UI antes de tentar baixar, ou detectar instalação antes de sequer chamar subscribe.

---

## Outras duas formas de importar (sem passar pelo fluxo de login/subscribe)

- **`scan-steam-workshop`**: acha o caminho da Steam via registro do Windows (`HKLM\...\Valve\Steam`), resolve todas as `libraryfolders.vdf` (múltiplos discos), escaneia `steamapps/workshop/content/431960` em cada uma — pega qualquer coisa que **já** tenha sido baixada antes pela Steam (por inscrição feita direto no site/cliente, sem passar pelo nosso app).
- **`scan-custom-workshop`**: usuário aponta manualmente uma pasta qualquer com subpastas no formato `project.json` — útil pra quem recebeu/copiou wallpapers de outro jeito.

---

## Formato de item do Workshop

Itens do Workshop compatíveis com o Wallpaper Engine (original da Steam) têm este formato:

```
<itemId>/
├── project.json        # Metadados do wallpaper
├── preview.jpg         # Thumbnail
└── <arquivos do wallpaper>
    ├── index.html      # Para wallpapers web
    ├── scene.json      # Para wallpapers de cena
    └── ...
```

### `project.json` exemplo:

```json
{
  "title": "Nome do Wallpaper",
  "type": "web",           // ou "video", "scene", "application"
  "file": "index.html",
  "preview": "preview.jpg",
  "tags": ["abstract", "anime"],
  "workshopid": "1234567890"
}
```

---

## Path do Steam (Registry)

O app consulta o registro do Windows para encontrar o caminho de instalação do Steam:

```
HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam
  InstallPath → C:\Program Files (x86)\Steam
```

Isso permite localizar a pasta do Workshop local se já houver downloads via Steam.

---

## Variável de estado

```javascript
let _pendingWorkshopId = null;  // ID de item aguardando download após login
```

Quando o usuário tenta baixar sem estar logado, o ID é guardado aqui. Após o login com QR, o download é retomado automaticamente.
