# Configuração do App — Engine Wallpaper

---

## Onde a configuração é salva

```
C:\Users\<user>\.engine-wallpaper\
├── config.json               # Configuração principal
└── downloads/
    ├── <itemId>.zip          # ZIPs baixados do Workshop (antes de extrair)
    └── wallpapers/
        └── <itemId>/         # Conteúdo extraído de cada item do Workshop
            ├── project.json
            ├── preview.jpg
            └── <arquivos do wallpaper>
```

---

## Estrutura do `config.json`

```json
{
  "library": [
    {
      "id": "uuid-string",
      "name": "Nome do Wallpaper",
      "type": "video",
      "path": "C:\\Videos\\wallpaper.mp4",
      "thumbnail": "data:image/jpeg;base64,...",
      "properties": {
        "volume": 0.5,
        "loop": true
      }
    }
  ],

  "activeWallpaper": {
    "id": "uuid-string",
    "type": "scene",
    "sceneId": "particles"
  },

  "displayAssignments": {
    "2528732444": "uuid-wallpaper-1",
    "3291847562": "uuid-wallpaper-2"
  },

  "playlistConfig": {
    "enabled": false,
    "interval": 30,
    "shuffle": false
  },

  "settings": {
    "volume": 0.5,
    "pauseOnFullscreen": true,
    "muteOnFullscreen": false,
    "autostart": false,
    "audioReactive": false
  },

  "timeRules": [
    {
      "id": "rule-uuid",
      "time": "09:00",
      "wallpaperId": "uuid-string",
      "displayId": null,
      "enabled": true
    }
  ],

  "appRules": [
    {
      "id": "rule-uuid",
      "exe": "game.exe",
      "action": "pause",
      "displayId": null,
      "enabled": true
    }
  ]
}
```

---

## Tipos de wallpaper (campo `type`)

| Tipo | Campo obrigatório | Descrição |
|------|-------------------|-----------|
| `video` | `path` | Caminho para arquivo de vídeo |
| `image` | `path` | Caminho para arquivo de imagem |
| `url` | `path` | URL completa (https://...) |
| `scene` | `sceneId` | Nome da cena (`particles`, `waves`, `matrix`, `aurora`, `visualizer`) |
| `workshop` | `path` | Caminho para pasta do item extraído do Workshop |

---

## Propriedades por tipo (`properties`)

### Video / URL
```json
{
  "volume": 0.5,
  "loop": true,
  "muted": false
}
```

### Scene (particles)
```json
{
  "count": 3000,
  "color": "#4fc3f7",
  "speed": 0.3,
  "size": 1.5
}
```

### Scene (waves)
```json
{
  "color": "#00e5ff",
  "speed": 0.5,
  "amplitude": 2.0
}
```

### Scene (matrix)
```json
{
  "color": "#00ff41",
  "speed": 1.0,
  "fontSize": 14
}
```

---

## Acesso via Store

```javascript
const Store = require('./src/store');
const store = new Store();

// Ler biblioteca
const library = store.get('library') || [];

// Adicionar wallpaper
library.push(newWallpaper);
store.set('library', library);

// Ler settings
const settings = store.get('settings') || {};

// Caminho do arquivo
console.log(store.filePath);
// → C:\Users\kille\.engine-wallpaper\config.json
```
