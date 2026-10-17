// Preload da BrowserView de wallpapers "web" (ver getOrCreateWallpaperWebView
// em main.js). Existe por um motivo só: a API que o Wallpaper Engine oferece
// pra página precisa existir ANTES dos scripts dela rodarem.
//
// Achado 2026-10-13 (Preset "DanDaDan - Momo Ayase" 3343173896 → motor
// "Customizable Module Visualizer" 1081733658, preto desde julho): o motor
// checa `window.wallpaperRegisterAudioListener` no carregamento; sem ela cai
// num gerador de áudio falso que quebra (`_.generator` undefined), derruba o
// módulo de áudio e, em cascata, o js/main.js inteiro (tela preta). A gente só
// definia a função no 'dom-ready' — tarde demais, os scripts já tinham
// rodado. Confirmado no Playwright: definindo antes do carregamento, o preset
// aparece completo (Momo, fundo, visualizador, relógio), sem nenhum erro.
//
// contextBridge (e não webFrame.executeJavaScript) porque é o único jeito com
// garantia de estar no mundo da página antes do primeiro <script> dela.
const { contextBridge } = require('electron');

let audioCallback = null;

contextBridge.exposeInMainWorld('wallpaperRegisterAudioListener', (cb) => {
  if (typeof cb === 'function') audioCallback = cb;
});

// Ainda não há captura de áudio do sistema alimentando wallpapers web — o
// callback fica guardado aqui pra quando isso existir. Sem dados, páginas
// tipo visualizador só ficam com as barras paradas (e algumas logam "No
// audio data"), mas renderizam normalmente.
void audioCallback;
