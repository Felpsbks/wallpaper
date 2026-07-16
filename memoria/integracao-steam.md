# Integração Steam — Engine Wallpaper

O app possui um navegador integrado do Steam Workshop que permite buscar, visualizar e baixar wallpapers diretamente do Workshop da Steam.

---

## Visão geral do fluxo

```
UI (Workshop tab)
  → ipcRenderer.invoke('workshop-search', query)
     → main.js faz scraping do Steam Workshop
        → retorna lista de itens

  → usuário clica "Download"
     → ipcRenderer.invoke('workshop-download', itemId)
        → main.js baixa ZIP
        → extrai com adm-zip
        → adiciona à biblioteca local
```

---

## Scraping do Workshop

O app **não usa a API oficial do Steam para browsing** — ele faz scraping da página web do Workshop:

- URL de browse: `https://steamcommunity.com/workshop/browse/?appid=...`
- URL de busca: `https://steamcommunity.com/workshop/browse/?appid=...&searchtext=...`
- API pública para detalhes: `https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/`

**Paginação:** suporte a múltiplas páginas de resultados.

---

## Autenticação Steam

Para acessar conteúdo restrito ou fazer downloads autenticados:

- Autenticação via **QR Code** (lib `qrcode`)
- Fluxo: gera QR → usuário scanneia com app Steam no celular → recebe cookies de sessão
- Cookies são armazenados para requests subsequentes

---

## Download e extração

```javascript
// main.js — download de item do Workshop
const AdmZip = require('adm-zip');

// 1. Download do ZIP para:
//    ~/.engine-wallpaper/downloads/<itemId>.zip

// 2. Extração para:
//    ~/.engine-wallpaper/downloads/wallpapers/<itemId>/

// 3. Parse do project.json dentro da pasta extraída
// 4. Adiciona à biblioteca com tipo 'workshop'
```

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
