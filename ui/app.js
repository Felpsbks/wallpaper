const { ipcRenderer, shell } = require('electron');
const os = require('os');
const appVersion = require('../package.json').version;

async function ipc(channel, ...args) { return ipcRenderer.invoke(channel, ...args); }

// Manda erros de JS da tela (renderer) para a aba Log do app, não só o console
// do DevTools — assim dá pra ver o que quebrou sem precisar abrir o DevTools.
function _logUiError(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  if (typeof appendLogLine === 'function') {
    appendLogLine({ ts, msg, level: 'error' });
  }
  ctrlLog(`ERRO: ${msg}`);
}
window.addEventListener('error', (e) => {
  _logUiError(`[UI] ${e.message} (${e.filename ? e.filename.split(/[\\/]/).pop() : '?'}:${e.lineno})`);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  _logUiError(`[UI] Promise rejeitada: ${reason}`);
});

// Diagnóstico de um travamento real relatado pelo usuário (2026-07-20): a
// janela de controle carrega, o modal de aviso aparece e o botão fica
// clicável, mas depois disso nada mais responde a clique nenhum, nem os
// botões da própria titlebar. `_sendToUiLog`/o painel de log do próprio app
// (main.js) exige uma UI funcionando pra ser lido — inútil bem no momento
// em que ela trava. Grava direto num arquivo em disco via main.js
// (`_bootLog`/'control-log'), lido independente do estado da janela. Um
// heartbeat a cada 2s mostra ATÉ QUANDO o JS do renderer continuou rodando —
// se ele para de aparecer no arquivo no mesmo instante em que a tela
// congela, é o JS que travou; se continuar aparecendo normalmente com a
// tela já congelada, é especificamente o paint/composite (mesma classe de
// bug já documentada pra janela do wallpaper).
function ctrlLog(msg) {
  try { ipcRenderer.send('control-log', msg); } catch (_) {}
}
ctrlLog('app.js: script carregado, topo do arquivo executando');
setInterval(() => ctrlLog('heartbeat'), 2000);

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ---- State ----
let library          = [];
let current          = null;
let selectedScene    = 'particles';
let settings         = {};
let allDisplays      = [];
let displayWallpapers = {};
let targetDisplayId  = null;   // null = all displays
let favorites        = [];
let playlists        = [];
let routines         = [];
let searchQuery      = '';
let propsWallpaper   = null;   // wallpaper being edited in props modal
let libraryTypeFilter = '';    // '' = todos, senão w.type ('video'/'scene'/'application'/'url')
let librarySort       = 'recent'; // 'recent' (id = timestamp real) ou 'name'
let libraryViewMode   = 'grid';   // 'grid' ou 'list'
let favSearchQuery    = '';
let favTypeFilter     = '';    // '' = todos, senão item.waType
let favSort           = 'recent'; // 'recent' (ordem real de favoritado) ou 'name'
let favViewMode       = 'grid';

// ---- Navigation ----
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-' + item.dataset.panel).classList.add('active');

    const modalOverlay = document.getElementById('wallpaper-modal-overlay');
    if (modalOverlay) modalOverlay.classList.remove('open');

    if (item.dataset.panel === 'discover') {
      const popGrid = document.getElementById('discover-popular-grid');
      if (popGrid && popGrid.innerHTML.includes('Carregando')) {
        loadDiscoverTab();
      }
    }
    if (item.dataset.panel === 'favorites') {
      renderFavoritesGrid();
    }
    if (item.dataset.panel === 'downloader') {
      window.EngineEditor?.init();
    }
    if (item.dataset.panel === 'youtube') showYoutubePanel();
    else hideYoutubePanel();
  });
});

// Card de acesso ao YouTube dentro do Descobrir — clique aciona o mesmo
// nav-item (agora oculto na barra lateral), reaproveitando 100% da lógica
// de troca de painel já existente acima.
document.getElementById('discover-youtube-banner')?.addEventListener('click', () => {
  document.querySelector('.nav-item[data-panel="youtube"]')?.click();
});

// ---- Aba YouTube ----
// O navegador embutido é um BrowserView (superfície nativa controlada pelo
// main.js — ver 'youtube-panel-show' lá) posicionado por cima da div
// #youtube-view-container. A janela do app não é redimensionável, então só
// precisa calcular a posição uma vez, ao abrir a aba.
let _youtubeDetectedVideo = null;
function showYoutubePanel() {
  const container = document.getElementById('youtube-view-container');
  if (!container) return;
  const r = container.getBoundingClientRect();
  ipcRenderer.send('youtube-panel-show', { x: r.x, y: r.y, width: r.width, height: r.height });
}
function hideYoutubePanel() {
  ipcRenderer.send('youtube-panel-hide');
}
ipcRenderer.on('youtube-video-detected', (_e, info) => {
  _youtubeDetectedVideo = info.videoId ? info : null;
  const idle = document.getElementById('youtube-status-idle');
  const video = document.getElementById('youtube-status-video');
  const titleEl = document.getElementById('youtube-apply-title');
  if (!idle || !video || !titleEl) return;
  if (_youtubeDetectedVideo) {
    titleEl.textContent = _youtubeDetectedVideo.title;
    idle.style.display = 'none';
    video.style.display = 'flex';
  } else {
    idle.style.display = 'flex';
    video.style.display = 'none';
  }
});

// Clicar no vídeo já toca no fundo sozinho, sem precisar de botão — main.js
// manda isso assim que detecta um vídeo novo (ver upsertYoutubeLiveEntry +
// 'youtube-auto-apply' lá). O item já foi salvo na biblioteca do lado do
// main.js; aqui só sincroniza o array local e aplica de fato via
// setWallpaper (assim respeita "aplicar só nesse monitor" que a Biblioteca
// já respeita — ver targetDisplayId).
ipcRenderer.on('youtube-auto-apply', (_e, wallpaper) => {
  const idx = library.findIndex(w => w.id === wallpaper.id);
  if (idx === -1) library.push(wallpaper); else library[idx] = wallpaper;
  renderLibrary();
  setWallpaper(wallpaper);
});

// Mudo do wallpaper do YouTube — independente do volume global (Configurações
// > Volume do vídeo), preferência persistida e reaplicada a cada vídeo novo
// direto no main.js (ver 'set-wallpaper-muted'/'get-wallpaper-muted').
const youtubeMuteBtn = document.getElementById('youtube-mute-btn');
function updateYoutubeMuteBtnLabel(muted) {
  if (youtubeMuteBtn) youtubeMuteBtn.textContent = muted ? 'Com áudio' : 'Sem áudio';
}
ipc('get-wallpaper-muted').then(updateYoutubeMuteBtnLabel);
youtubeMuteBtn?.addEventListener('click', async () => {
  const currentlyMuted = youtubeMuteBtn.textContent === 'Com áudio';
  const next = !currentlyMuted;
  await ipc('set-wallpaper-muted', next);
  updateYoutubeMuteBtnLabel(next);
});

// Download OPCIONAL — guarda uma cópia de verdade em alta qualidade na
// biblioteca (yt-dlp + ffmpeg, até 4K), separado de tocar ao vivo (que já
// acontece sozinho ao clicar). Reusa a mesma tela
// cheia de progresso roxa (dl-loading-screen) que atualização/SteamCMD já
// usam, então dá pra ver baixando as ferramentas (só na 1ª vez) e o vídeo.
document.getElementById('youtube-apply-btn')?.addEventListener('click', async () => {
  if (!_youtubeDetectedVideo) return;
  const { title } = _youtubeDetectedVideo;

  const dlScreen = document.getElementById('dl-loading-screen');
  document.getElementById('dl-loading-title').textContent = 'Baixando vídeo do YouTube';
  document.getElementById('dl-loading-subtitle').textContent = title;
  document.getElementById('dl-progress-fill').style.width = '0%';
  document.getElementById('dl-progress-text').textContent = 'Iniciando...';
  const dlLog = document.getElementById('dl-log-lines');
  if (dlLog) { dlLog.textContent = ''; dlLog.style.display = 'none'; }
  dlScreen.classList.add('visible');

  const result = await ipc('youtube-download-wallpaper', _youtubeDetectedVideo);

  dlScreen.classList.remove('visible');
  if (result && result.ok) {
    library.push(result.wallpaper);
    renderLibrary();
    setWallpaper(result.wallpaper);
  } else {
    alert(`Não consegui baixar esse vídeo: ${(result && result.error) || 'erro desconhecido'}`);
  }
});

ipcRenderer.on('youtube-download-progress', (_e, data) => {
  const dlFill = document.getElementById('dl-progress-fill');
  const dlText = document.getElementById('dl-progress-text');
  if (!dlFill || !dlText) return;
  if (data.phase === 'yt-dlp' || data.phase === 'ffmpeg') {
    const label = data.phase === 'yt-dlp' ? 'Preparando ferramenta de download (só na 1ª vez)...' : 'Preparando conversor de vídeo (só na 1ª vez)...';
    if (data.total) {
      const pct = Math.round((data.received / data.total) * 100);
      dlFill.style.width = pct + '%';
      dlText.textContent = `${label} ${pct}% (${formatBytes(data.received)} / ${formatBytes(data.total)})`;
    } else {
      dlText.textContent = label;
    }
  } else if (data.phase === 'ffmpeg-extract') {
    dlText.textContent = 'Extraindo conversor de vídeo...';
  } else if (data.phase === 'video') {
    dlFill.style.width = Math.round(data.pct || 0) + '%';
    dlText.textContent = `Baixando vídeo... ${Math.round(data.pct || 0)}%`;
  } else if (data.phase === 'merging') {
    dlFill.style.width = '95%';
    dlText.textContent = 'Juntando vídeo e áudio (ffmpeg)...';
  } else if (data.phase === 'quality-limited') {
    // O Windows bloqueou o ffmpeg baixado nesta máquina — segue o download
    // normalmente, só que num teto de qualidade menor (formato já vem
    // pronto do YouTube, sem precisar juntar vídeo+áudio separado).
    dlText.textContent = 'Baixando em qualidade padrão (conversor de vídeo bloqueado pelo Windows nesta máquina)...';
  } else if (data.phase === 'done') {
    dlFill.style.width = '100%';
    dlText.textContent = 'Concluído!';
  }
});

// Por que uma cena caiu pro fallback de imagem estática em vez de renderizar
// ao vivo — mostrado no card da biblioteca para não deixar isso sem explicação.
const SCENE_FALLBACK_MESSAGES = {
  unsupported_package: 'Essa cena usa um formato de pacote que ainda não suportamos. Estamos trabalhando para dar suporte a mais formatos.',
  unpack_incomplete: 'Não conseguimos extrair os dados dessa cena corretamente. Estamos trabalhando nisso.',
  no_scene_data: 'Essa cena não trouxe os dados necessários para renderizar ao vivo. Estamos investigando.',
  default: 'Essa cena ainda não é totalmente suportada pelo nosso motor — mostrando a imagem estática por enquanto. Estamos trabalhando para melhorar isso.',
};

// ---- Helpers ----
function toFileUrl(p) {
  if (!p) return '';
  if (p.startsWith('file:///') || p.startsWith('http')) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

function typeIcon(type, scene) {
  if (type === 'video') return '🎬';
  if (type === 'image') return '🖼️';
  if (type === 'url')   return '🌐';
  const icons = { particles: '✨', waves: '🌊', matrix: '💻', aurora: '🌌', visualizer: '🎵' };
  return icons[scene] || '✨';
}

function typeName(type, scene) {
  if (type === 'video') return 'Vídeo';
  if (type === 'image') return 'Imagem';
  if (type === 'url')   return 'Website';
  const names = { particles: 'Partículas', waves: 'Ondas', matrix: 'Matrix', aurora: 'Aurora', visualizer: 'Visualizador' };
  return names[scene] || 'Cena';
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Substitui o confirm() nativo do Chromium (sem estilo, título genérico
// "engine-wallpaper") por um modal no mesmo visual do resto do app.
// Resolve true/false conforme o botão clicado — mesma assinatura de uso que
// confirm(), só que assíncrona: `if (await showConfirm('...')) { ... }`.
function showConfirm(message, title) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('modal-confirm-title').textContent = title || 'Confirmar';
    document.getElementById('modal-confirm-message').textContent = message;
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    const finish = (result) => { closeModal('modal-confirm'); resolve(result); };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    modal.classList.add('open');
  });
}
document.querySelectorAll('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', e => { if (e.target === bd) bd.classList.remove('open'); });
});

// ---- Thumbnail generation ----
async function generateVideoThumbnail(src) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.src = toFileUrl(src);

    const timeout = setTimeout(() => { video.remove(); resolve(null); }, 6000);

    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(2, video.duration * 0.05 || 0);
    });
    video.addEventListener('seeked', () => {
      clearTimeout(timeout);
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      c.getContext('2d').drawImage(video, 0, 0, 320, 180);
      video.remove();
      resolve(c.toDataURL('image/jpeg', 0.75));
    });
    video.addEventListener('error', () => { clearTimeout(timeout); video.remove(); resolve(null); });
    video.load();
  });
}

// ---- Library rendering ----
function filteredLibrary() {
  let items = library;
  if (libraryTypeFilter) items = items.filter(w => w.type === libraryTypeFilter);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(w => w.name.toLowerCase().includes(q) || typeName(w.type, w.scene).toLowerCase().includes(q));
  }
  // w.id é Date.now().toString() no momento em que foi adicionado (ver
  // 'add-wallpaper' no main.js) — dá pra ordenar por ele como timestamp real.
  items = items.slice();
  if (librarySort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
  else items.sort((a, b) => Number(b.id) - Number(a.id));
  return items;
}

function updateLibraryStatsBar() {
  const el = document.getElementById('lib-stats-text');
  if (!el) return;
  const total = library.length;
  const videos = library.filter(w => w.type === 'video').length;
  const scenes = library.filter(w => w.type === 'scene').length;
  const activeCount = current ? 1 : 0;
  const parts = [`${total} wallpaper${total === 1 ? '' : 's'}`];
  if (activeCount) parts.push(`${activeCount} ativo`);
  if (videos) parts.push(`${videos} vídeo${videos === 1 ? '' : 's'}`);
  if (scenes) parts.push(`${scenes} cena${scenes === 1 ? '' : 's'}`);
  el.textContent = parts.join(' • ');
}

function closeCardMenus() {
  document.querySelectorAll('.card-menu-dropdown.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.card-menu-btn.menu-open').forEach(b => b.classList.remove('menu-open'));
}
document.addEventListener('click', closeCardMenus);

function renderLibrary() {
  const grid  = document.getElementById('wallpaper-grid');
  const empty = document.getElementById('empty-state');
  const items = filteredLibrary();

  grid.querySelectorAll('.wallpaper-card').forEach(c => c.remove());
  empty.style.display = items.length === 0 ? 'block' : 'none';

  for (const w of items) {
    const isActive = current && current.id === w.id;
    const card = document.createElement('div');
    card.className = 'wallpaper-card' + (isActive ? ' active' : '');
    card.dataset.id = w.id;

    let thumbHtml;
    if (w.preview) {
      thumbHtml = `<img class="card-thumb-img" src="${toFileUrl(w.preview)}" />`;
    } else if (w.thumbnail) {
      thumbHtml = `<img class="card-thumb-img" src="${w.thumbnail}" />`;
    } else if (w.type === 'image') {
      thumbHtml = `<img class="card-thumb-img" src="${toFileUrl(w.src)}" />`;
    } else {
      thumbHtml = `<div class="card-thumb">${typeIcon(w.type, w.scene)}</div>`;
    }

    const hasProps = (w.type === 'scene' || w.type === 'video' || w.type === 'url' || !!w.properties);
    const sceneFallback = w.type === 'scene' && !w.weSceneDir;
    const sceneFallbackMsg = sceneFallback
      ? SCENE_FALLBACK_MESSAGES[w.weSceneFallbackReason] || SCENE_FALLBACK_MESSAGES.default
      : '';

    const isFav = isFavorited(w);
    const favHeartIcon = isFav
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';

    card.innerHTML = `
      <div class="card-active-badge">ATIVO</div>
      <div class="card-thumb-wrap">
        ${thumbHtml}
        <div class="card-type-badge">${typeIcon(w.type, w.scene)} ${typeName(w.type, w.scene)}</div>
        ${sceneFallback ? `<div class="card-scene-fallback-badge" title="${sceneFallbackMsg}">🚧 Cena parcial</div>` : ''}
        <button class="card-fav-heart-lib${isFav ? ' favorited' : ''}" title="${isFav ? 'Remover dos favoritos' : 'Favoritar'}">${favHeartIcon}</button>
        <button class="card-menu-btn" title="Mais opções">⋮</button>
        <div class="card-menu-dropdown">
          ${hasProps ? '<div class="card-menu-item props">⚙ Propriedades</div>' : ''}
          <div class="card-menu-item delete">✕ Remover</div>
        </div>
      </div>
      <div class="card-info">
        <div class="card-name" title="${w.name}">${w.name}</div>
      </div>
    `;

    const menuBtn = card.querySelector('.card-menu-btn');
    const menuDropdown = card.querySelector('.card-menu-dropdown');
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = menuDropdown.classList.contains('open');
      closeCardMenus();
      if (!wasOpen) { menuDropdown.classList.add('open'); menuBtn.classList.add('menu-open'); }
    });

    // Favoritar de verdade a partir da Biblioteca: normaliza o formato local
    // (w.name/w.preview = path em disco) pro mesmo formato que a aba
    // Favoritos/o modal já esperam (title/preview = URL exibível), senão o
    // item favoritado aparece quebrado lá (sem título, imagem não carrega).
    const favBtn = card.querySelector('.card-fav-heart-lib');
    favBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const favItem = {
        id: w.id,
        workshopId: w.workshopId || null,
        title: w.name,
        preview: w.preview ? toFileUrl(w.preview) : (w.thumbnail || ''),
        waType: w.type,
        tags: w.tags || [],
        subscribers: w.subscribers || 0,
        views: w.views || 0,
      };
      await toggleFavorite(favItem);
      renderLibrary();
    });

    card.addEventListener('click', e => {
      if (e.target.classList.contains('delete')) { removeWallpaper(w.id); return; }
      if (e.target.classList.contains('props'))  { openProps(w); return; }
      if (e.target.closest('.card-menu-dropdown') || e.target.closest('.card-menu-btn') || e.target.closest('.card-fav-heart-lib')) return;
      setWallpaper(w);
    });

    grid.appendChild(card);
  }

  updateLibraryStatsBar();
}

async function setWallpaper(w) {
  current = w;
  await ipc('set-wallpaper', w, targetDisplayId || undefined);
  if (targetDisplayId) displayWallpapers[targetDisplayId] = w;
  renderLibrary();
  renderMonitors();
  updateNowPlaying();
}

async function removeWallpaper(id) {
  if (!await showConfirm('Tem certeza que deseja remover este wallpaper da sua biblioteca?')) return;
  await ipc('remove-wallpaper', id);
  library = library.filter(w => w.id !== id);
  if (current && current.id === id) { current = null; updateNowPlaying(); }

  // Tira o wallpaper removido de qualquer playlist que o contenha.
  const affected = playlists.filter(p => p.wallpaperIds.includes(id));
  for (const p of affected) {
    p.wallpaperIds = p.wallpaperIds.filter(wid => wid !== id);
    await ipc('save-playlist', p);
  }
  if (affected.length) renderPlaylistsGrid();

  renderLibrary();
}

// ---- Search ----
document.getElementById('search-input').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  renderLibrary();
});

// ---- Filtro por tipo (pills), ordenação, modo de visualização e tamanho dos cards ----
document.querySelectorAll('#lib-type-pills .pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#lib-type-pills .pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    libraryTypeFilter = pill.dataset.libType || '';
    renderLibrary();
  });
});

document.getElementById('lib-sort-select').addEventListener('change', e => {
  librarySort = e.target.value;
  renderLibrary();
});

const libGrid = document.getElementById('wallpaper-grid');
document.getElementById('lib-view-grid').addEventListener('click', () => {
  libraryViewMode = 'grid';
  libGrid.classList.remove('list-view');
  document.getElementById('lib-view-grid').classList.add('active');
  document.getElementById('lib-view-list').classList.remove('active');
});
document.getElementById('lib-view-list').addEventListener('click', () => {
  libraryViewMode = 'list';
  libGrid.classList.add('list-view');
  document.getElementById('lib-view-list').classList.add('active');
  document.getElementById('lib-view-grid').classList.remove('active');
});
const libSizeSlider = document.getElementById('lib-size-slider');
libGrid.style.setProperty('--lib-card-min', libSizeSlider.value + 'px');
libSizeSlider.addEventListener('input', e => {
  libGrid.style.setProperty('--lib-card-min', e.target.value + 'px');
});

// ---- Add Video ----
document.getElementById('btn-add-video').addEventListener('click', async () => {
  const result = await ipc('open-file-dialog', {
    title: 'Selecionar vídeo',
    filters: [{ name: 'Vídeos', extensions: ['mp4', 'webm', 'mkv', 'avi', 'mov'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const src  = result.filePaths[0];
  const name = src.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const thumbnail = await generateVideoThumbnail(src);
  const w = await ipc('add-wallpaper', { type: 'video', name, src, thumbnail });
  library.push(w);
  renderLibrary();
  setWallpaper(w);
});

// ---- Add Image / GIF ----
document.getElementById('btn-add-image').addEventListener('click', async () => {
  const result = await ipc('open-file-dialog', {
    title: 'Selecionar imagem',
    filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const src  = result.filePaths[0];
  const name = src.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const w = await ipc('add-wallpaper', { type: 'image', name, src });
  library.push(w);
  renderLibrary();
  setWallpaper(w);
});

// ---- Add URL ----
document.getElementById('btn-add-url').addEventListener('click', () => {
  document.getElementById('url-input').value = '';
  document.getElementById('url-name-input').value = '';
  document.getElementById('modal-url').classList.add('open');
});
document.getElementById('btn-url-add').addEventListener('click', async () => {
  const url  = document.getElementById('url-input').value.trim();
  const name = document.getElementById('url-name-input').value.trim() || url;
  if (!url) return;
  const w = await ipc('add-wallpaper', { type: 'url', name, src: url });
  library.push(w);
  renderLibrary();
  setWallpaper(w);
  closeModal('modal-url');
});

// ---- Add Scene ----
document.querySelectorAll('.scene-option').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.scene-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    selectedScene = opt.dataset.scene;
  });
});
document.getElementById('btn-add-scene').addEventListener('click', () => {
  document.getElementById('scene-name-input').value = '';
  document.getElementById('modal-scene').classList.add('open');
});
document.getElementById('btn-scene-add').addEventListener('click', async () => {
  const sceneNames = { particles: 'Partículas', waves: 'Ondas', matrix: 'Matrix', aurora: 'Aurora', visualizer: 'Visualizador' };
  const name = document.getElementById('scene-name-input').value.trim() || sceneNames[selectedScene];
  const w = await ipc('add-wallpaper', { type: 'scene', name, scene: selectedScene, options: {} });
  library.push(w);
  renderLibrary();
  setWallpaper(w);
  closeModal('modal-scene');
});

// ---- Properties modal ----
const SCENE_FIELDS = {
  particles: [
    { key: 'color',  label: 'Cor',             type: 'color',  def: '#4fc3f7' },
    { key: 'speed',  label: 'Velocidade',       type: 'range',  def: 0.3,  min: 0.1, max: 3, step: 0.1 },
    { key: 'count',  label: 'Partículas',       type: 'range',  def: 3000, min: 200, max: 8000, step: 100 },
    { key: 'size',   label: 'Tamanho',          type: 'range',  def: 1.5,  min: 0.5, max: 6,  step: 0.1 },
  ],
  waves: [
    { key: 'color1',     label: 'Cor 1',        type: 'color',  def: '#0077ff' },
    { key: 'color2',     label: 'Cor 2',        type: 'color',  def: '#00ffcc' },
    { key: 'speed',      label: 'Velocidade',   type: 'range',  def: 1.0, min: 0.1, max: 3,   step: 0.1 },
    { key: 'amplitude',  label: 'Amplitude',    type: 'range',  def: 2.0, min: 0.5, max: 8,   step: 0.1 },
  ],
  matrix: [
    { key: 'color',  label: 'Cor',              type: 'color',  def: '#00ff41' },
    { key: 'speed',  label: 'Velocidade',       type: 'range',  def: 1,   min: 0.1, max: 5,   step: 0.1 },
  ],
  aurora: [
    { key: 'speed',  label: 'Velocidade',       type: 'range',  def: 0.5, min: 0.1, max: 3,   step: 0.1 },
  ],
  visualizer: [
    { key: 'color1',      label: 'Cor 1',       type: 'color',  def: '#4fc3f7' },
    { key: 'color2',      label: 'Cor 2',       type: 'color',  def: '#7c4dff' },
    { key: 'style',       label: 'Estilo',      type: 'select', def: 'bars', opts: ['bars', 'wave', 'circle'], optLabels: ['Barras', 'Onda', 'Círculo'] },
    { key: 'sensitivity', label: 'Sensibilidade', type: 'range', def: 1.2, min: 0.1, max: 3,   step: 0.1 },
  ],
};

function rgbToHex(str) {
  const parts = str.split(' ').map(Number);
  if (parts.length < 3) return '#ffffff';
  // WE typically uses 0.0 - 1.0, but some might use 0-255
  const isFloat = parts.some(p => p > 0 && p <= 1.0 && p.toString().includes('.'));
  const rgb = parts.map(p => {
    let v = isFloat || (p <= 1 && !Number.isInteger(p)) ? p * 255 : p;
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  });
  return `#${rgb[0]}${rgb[1]}${rgb[2]}`;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}

function openProps(w) {
  propsWallpaper = w;
  document.getElementById('props-title').textContent = `Propriedades — ${w.name}`;
  const fields = document.getElementById('props-fields');
  fields.innerHTML = '';

  let defs = [];
  
  // 1. Wallpaper Engine Native Properties
  if (w.properties) {
    for (const [key, prop] of Object.entries(w.properties)) {
      defs.push({
        isNative: true,
        key,
        label: prop.text || key,
        type: prop.type === 'slider' ? 'range' : (prop.type === 'bool' ? 'bool' : prop.type),
        def: prop.value,
        min: prop.min !== undefined ? prop.min : 0,
        max: prop.max !== undefined ? prop.max : 100,
        step: 1, // we don't always have step in WE
        opts: prop.options ? prop.options.map(o => o.value) : [],
        optLabels: prop.options ? prop.options.map(o => o.label) : []
      });
    }
  }
  
  // 2. Custom/Fallback Properties
  if (w.type === 'scene' && !w.properties) defs.push(...(SCENE_FIELDS[w.scene] || []));
  if (w.type === 'video') defs.push({ key: 'volume', label: 'Volume (%)', type: 'range', def: 50, min: 0, max: 100, step: 1 });

  if (!defs.length && !w.weSceneDir) {
    fields.innerHTML = '<p style="color:var(--text2);font-size:13px">Sem propriedades configuráveis.</p>';
  }

  if (w.weSceneDir) {
    const editRow = document.createElement('div');
    editRow.className = 'field';
    editRow.innerHTML = `
      <button class="btn btn-secondary" id="btn-we-scene-edit" style="width:100%">🖊️ Ajustar posição/tamanho dos textos</button>
      <div style="font-size:11px;color:var(--text2);margin-top:6px">Aplique este wallpaper primeiro.</div>
    `;
    fields.appendChild(editRow);
    setTimeout(() => {
      document.getElementById('btn-we-scene-edit').addEventListener('click', () => {
        closeModal('modal-props');
        document.getElementById('modal-we-scene-help').classList.add('open');
      });
    });
  }

  for (const f of defs) {
    const opts = w.options || {};
    const val  = opts[f.key] !== undefined ? opts[f.key] : f.def;
    const row  = document.createElement('div');
    row.className = 'field';
    row.dataset.key = f.key;
    row.dataset.native = f.isNative ? 'true' : 'false';

    if (f.type === 'color') {
      const hexVal = f.isNative && typeof val === 'string' && val.includes(' ') ? rgbToHex(val) : (val || '#ffffff');
      row.innerHTML = `<label>${f.label}</label><div class="color-row"><input type="color" id="pf-${f.key}" value="${hexVal}" /><span class="color-hex" id="pf-${f.key}-hex">${hexVal}</span></div>`;
      setTimeout(() => {
        const inp = row.querySelector(`#pf-${f.key}`);
        const hex = row.querySelector(`#pf-${f.key}-hex`);
        inp.addEventListener('input', () => { 
          hex.textContent = inp.value;
          sendLivePropUpdate(w, f, inp.value);
        });
      });
    } else if (f.type === 'range') {
      row.innerHTML = `<label>${f.label} <span class="range-val" id="pf-${f.key}-val" style="float:right">${val}</span></label><input type="range" id="pf-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}" />`;
      setTimeout(() => {
        const inp = row.querySelector(`#pf-${f.key}`);
        const lbl = row.querySelector(`#pf-${f.key}-val`);
        inp.addEventListener('input', () => { 
          lbl.textContent = (+inp.value).toFixed(f.step < 1 ? 1 : 0); 
          sendLivePropUpdate(w, f, +inp.value);
        });
      });
    } else if (f.type === 'bool') {
      row.innerHTML = `<label class="toggle" style="justify-content:space-between;width:100%;margin-top:8px">${f.label}<input type="checkbox" id="pf-${f.key}" ${val ? 'checked' : ''} /><div class="toggle-slider"></div></label>`;
      setTimeout(() => {
        const inp = row.querySelector(`#pf-${f.key}`);
        inp.addEventListener('change', () => {
          sendLivePropUpdate(w, f, inp.checked);
        });
      });
    } else if (f.type === 'select' || f.type === 'combo') {
      const options = f.opts.map((o, i) => `<option value="${o}" ${o === val ? 'selected' : ''}>${f.optLabels[i]}</option>`).join('');
      row.innerHTML = `<label>${f.label}</label><select id="pf-${f.key}">${options}</select>`;
      setTimeout(() => {
        const inp = row.querySelector(`#pf-${f.key}`);
        inp.addEventListener('change', () => {
          sendLivePropUpdate(w, f, inp.value);
        });
      });
    }
    fields.appendChild(row);
  }

  document.getElementById('modal-props').classList.add('open');
}

function sendLivePropUpdate(w, f, value) {
  if (w.id !== current?.id) return; // Only live update if it's the active wallpaper
  let formattedValue = value;
  if (f.type === 'color' && f.isNative) {
    formattedValue = hexToRgb(value);
  }
  
  if (f.isNative) {
    ipc('update-native-prop', { key: f.key, value: formattedValue });
  } else {
    // For custom scenes/video volume
    ipc('update-settings', { [f.key]: value });
  }
}

document.getElementById('btn-props-save').addEventListener('click', async () => {
  if (!propsWallpaper) return;
  const w   = { ...propsWallpaper };
  const opts = { ...(w.options || {}) };
  const fields = document.getElementById('props-fields').children;

  for (const row of fields) {
    const key = row.dataset.key;
    const isNative = row.dataset.native === 'true';
    const el = document.getElementById(`pf-${key}`);
    if (!el) continue;
    
    let val = el.type === 'checkbox' ? el.checked : (el.type === 'range' ? +el.value : el.value);
    if (el.type === 'color' && isNative) val = hexToRgb(val);
    opts[key] = val;
  }
  
  w.options = opts;

  // Update in library
  const idx = library.findIndex(l => l.id === w.id);
  if (idx !== -1) library[idx] = w;

  await ipc('update-wallpaper', w);
  propsWallpaper = null;
  renderLibrary();
  closeModal('modal-props');
});

// ---- Settings ----
const setVolume  = document.getElementById('set-volume');
const setVolumeV = document.getElementById('set-volume-val');
// Controle de acesso rápido na Biblioteca (mesmo valor de "Volume do vídeo"
// em Configurações, só sem precisar abrir a tela pra ajustar toda vez) —
// mantido em sincronia nos dois sentidos com o slider de Configurações.
const libVolumeSlider = document.getElementById('lib-volume-slider');
const setPauseFs = document.getElementById('set-pause-fs');
const setPerfModeFs = document.getElementById('set-performance-mode-fs');
const setMuteFs  = document.getElementById('set-mute-fs');
const setWebview2Compat = document.getElementById('set-webview2-compat');
const setStartup = document.getElementById('set-startup');
const setHideTaskbar = document.getElementById('set-hide-taskbar');
const setAudioRe = document.getElementById('set-audio-reactive');
const btnInstallScr = document.getElementById('btn-install-screensaver');

const clockEnabled   = document.getElementById('clock-enabled');
const clockPosition  = document.getElementById('clock-position');
const clockFormat24h = document.getElementById('clock-format24h');
const clockSeconds   = document.getElementById('clock-seconds');
const clockDate      = document.getElementById('clock-date');
const clockDayName   = document.getElementById('clock-dayname');
const clockColor     = document.getElementById('clock-color');
const clockFontSize  = document.getElementById('clock-fontsize');
const clockFontSizeV = document.getElementById('clock-fontsize-val');

setVolume.addEventListener('input', () => {
  setVolumeV.textContent = setVolume.value + '%';
  if (libVolumeSlider) libVolumeSlider.value = setVolume.value;
});
if (libVolumeSlider) {
  libVolumeSlider.addEventListener('input', () => {
    setVolume.value = libVolumeSlider.value;
    setVolumeV.textContent = libVolumeSlider.value + '%';
  });
  libVolumeSlider.addEventListener('change', saveSettings);
}
clockFontSize.addEventListener('input', () => { clockFontSizeV.textContent = clockFontSize.value + 'px'; });

async function saveSettings() {
  // Spread the previous settings first — appRules and other fields not owned by
  // this form live inside the same `settings` object and would otherwise be wiped.
  settings = {
    ...settings,
    volume: +setVolume.value,
    pauseOnFullscreen: setPauseFs.checked,
    performanceModeFullscreen: setPerfModeFs.checked,
    muteOnFullscreen: setMuteFs.checked,
    webview2CompatMode: setWebview2Compat.checked,
    startWithWindows: setStartup.checked,
    hideTaskbarAndIcons: setHideTaskbar.checked,
    audioReactive: setAudioRe.checked,
    clockOverlay: {
      enabled: clockEnabled.checked,
      position: clockPosition.value,
      format24h: clockFormat24h.checked,
      showSeconds: clockSeconds.checked,
      showDate: clockDate.checked,
      showDayName: clockDayName.checked,
      color: clockColor.value,
      fontSize: +clockFontSize.value,
    },
  };
  await ipc('set-settings', settings);
}
[setVolume, setPauseFs, setPerfModeFs, setMuteFs, setWebview2Compat, setStartup, setHideTaskbar, setAudioRe,
 clockEnabled, clockPosition, clockFormat24h, clockSeconds, clockDate, clockDayName, clockColor, clockFontSize
].forEach(el => el.addEventListener('change', saveSettings));

// O componente WallpaperHost.exe não vem mais no instalador padrão (ver
// scripts/build-dist.js) — main.js's ensureWallpaperHostInstalled() baixa
// sob demanda na primeira vez que este toggle liga, e manda o progresso
// disso por aqui. Sem isso, ligar o toggle pareceria não fazer nada por
// alguns segundos (ou minutos, dependendo da conexão) enquanto baixa.
const webview2InstallStatus = document.getElementById('webview2-install-status');
ipcRenderer.on('wallpaperhost-install-progress', (_e, data) => {
  if (!webview2InstallStatus) return;
  setWebview2Compat.disabled = data.status === 'downloading' || data.status === 'extracting';
  if (data.status === 'downloading') {
    webview2InstallStatus.style.display = 'block';
    const pct = data.pct !== null && data.pct !== undefined ? `${Math.round(data.pct * 100)}%` : '...';
    webview2InstallStatus.textContent = `Baixando componente necessário (${pct})`;
  } else if (data.status === 'extracting') {
    webview2InstallStatus.style.display = 'block';
    webview2InstallStatus.textContent = 'Instalando componente...';
  } else if (data.status === 'done') {
    webview2InstallStatus.textContent = 'Componente instalado.';
    setTimeout(() => { webview2InstallStatus.style.display = 'none'; }, 3000);
  } else if (data.status === 'error') {
    webview2InstallStatus.textContent = 'Falha ao baixar o componente — usando o modo padrão por enquanto. Tente ligar de novo mais tarde.';
    setTimeout(() => { webview2InstallStatus.style.display = 'none'; }, 6000);
  }
});

if (btnInstallScr) {
  btnInstallScr.addEventListener('click', async () => {
    btnInstallScr.textContent = 'Instalando...';
    const res = await ipc('install-screensaver');
    if (res.ok) btnInstallScr.textContent = 'Instalado!';
    else { btnInstallScr.textContent = 'Erro'; alert(res.msg); }
    setTimeout(() => btnInstallScr.textContent = 'Instalar', 3000);
  });
}

// ---- Monitors ----
function renderMonitors() {
  const grid = document.getElementById('monitors-grid');
  grid.innerHTML = '';
  if (!allDisplays.length) { grid.innerHTML = '<p style="color:var(--text2);font-size:12px">Nenhum monitor detectado</p>'; return; }

  allDisplays.forEach((d, i) => {
    const wp = displayWallpapers[d.id] || (i === 0 ? current : null);
    const card = document.createElement('div');
    card.className = 'monitor-card' + (targetDisplayId === d.id ? ' active' : '');
    card.innerHTML = `
      <div class="monitor-icon">🖥️</div>
      <div class="monitor-label">Monitor ${i + 1}</div>
      <div class="monitor-res">${d.bounds.width}×${d.bounds.height}</div>
      <div class="monitor-wp">${wp ? wp.name : 'Nenhum'}</div>
    `;
    card.addEventListener('click', () => {
      targetDisplayId = targetDisplayId === d.id ? null : d.id;
      renderMonitors();
      updateMonitorBar();
    });
    grid.appendChild(card);
  });
}

function updateMonitorBar() {
  const bar   = document.getElementById('monitor-target-bar');
  const label = document.getElementById('monitor-target-label');
  if (!targetDisplayId) { bar.style.display = 'none'; return; }
  const idx = allDisplays.findIndex(d => d.id === targetDisplayId);
  bar.style.display = 'flex';
  label.textContent = `Clique num wallpaper para aplicar no Monitor ${idx + 1}`;
}

document.getElementById('btn-clear-monitor-target').addEventListener('click', () => {
  targetDisplayId = null;
  renderMonitors();
  updateMonitorBar();
});

// Detecção automática de monitores: main.js manda essa mensagem sempre que
// um monitor é conectado/desconectado/desabilitado com o app já aberto (ver
// notifyDisplaysChanged em main.js) — sem depender de reiniciar o app pra
// "Configurações > Monitores" refletir a realidade.
ipcRenderer.on('displays-changed', (_e, displays) => {
  const previousCount = allDisplays.length;
  allDisplays = displays;
  if (targetDisplayId && !displays.some(d => d.id === targetDisplayId)) targetDisplayId = null;
  renderMonitors();
  updateMonitorBar();

  // Só avisa quando um monitor NOVO aparece (não no boot, não ao desconectar)
  // — e só se já tinha pelo menos 1 antes, pra não disparar na primeira
  // leitura antes do init() preencher allDisplays a primeira vez.
  if (previousCount > 0 && displays.length > previousCount) {
    showMonitorDetectedNotice(displays.length);
  }
});

// Atalho global Ctrl+Alt+W (ou o item no menu da bandeja — ver
// toggleWallpaperInteractive em main.js) liga/desliga o wallpaper aceitar
// cliques (pra dar pra clicar em algo tipo um botão de configuração dentro
// de um wallpaper "web") — esse toast é só feedback visual de qual dos
// dois modos está ativo agora.
ipcRenderer.on('wallpaper-interactive-changed', (_e, interactive) => {
  let toast = document.getElementById('wallpaper-interactive-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'wallpaper-interactive-toast';
    toast.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,0.4);transition:opacity .2s;';
    document.body.appendChild(toast);
  }
  toast.style.background = interactive ? '#6a32d6' : '#333';
  toast.textContent = interactive
    ? '🖱️ Wallpaper interativo LIGADO — dá pra clicar nele (Ctrl+Alt+W ou menu da bandeja pra desligar)'
    : '🖱️ Wallpaper interativo desligado';
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
});

function showMonitorDetectedNotice(count) {
  const banner = document.getElementById('monitor-detected-banner');
  const textEl = document.getElementById('monitor-detected-text');
  if (!banner || !textEl) return;
  textEl.textContent = `Detectamos ${count} monitores. Vá em Configurações > Monitores para escolher um wallpaper diferente em cada um.`;
  banner.style.display = 'flex';
  document.getElementById('monitor-detected-dismiss').onclick = () => { banner.style.display = 'none'; };
}

// ---- App Rules ----
let appRules = [];

function renderAppRules() {
  const list = document.getElementById('app-rules-list');
  list.innerHTML = '';
  if (!appRules.length) {
    list.innerHTML = '<p style="color:var(--text2);font-size:12px;padding:8px 0">Nenhuma regra configurada</p>';
    return;
  }
  for (const rule of appRules) {
    const row = document.createElement('div');
    row.className = 'time-rule-row'; // reusing styling
    let actionLabel = 'Pausar';
    if (rule.action === 'mute') actionLabel = 'Mutar';
    if (rule.action === 'stop') actionLabel = 'Parar';
    
    row.innerHTML = `
      <span class="tr-time" style="width:auto;margin-right:10px">${rule.exe}</span>
      <span class="tr-arrow">→</span>
      <span class="tr-name">${actionLabel}</span>
      <button class="card-btn delete tr-del" data-id="${rule.id}">✕</button>
    `;
    row.querySelector('.tr-del').addEventListener('click', async () => {
      appRules = appRules.filter(r => r.id !== rule.id);
      await ipc('set-settings', { ...settings, appRules });
      renderAppRules();
    });
    list.appendChild(row);
  }
}

document.getElementById('btn-add-app-rule').addEventListener('click', () => {
  document.getElementById('ar-exe').value = '';
  document.getElementById('ar-action').value = 'pause';
  document.getElementById('modal-app-rule').classList.add('open');
});

document.getElementById('btn-ar-add').addEventListener('click', async () => {
  const exe = document.getElementById('ar-exe').value.trim();
  const action = document.getElementById('ar-action').value;
  if (!exe) return alert('Digite o nome do executável (ex: cs2.exe)');
  
  appRules.push({ id: Date.now().toString(), exe, action });
  await ipc('set-settings', { ...settings, appRules });
  renderAppRules();
  closeModal('modal-app-rule');
});


// ---- Steam Workshop ----
let steamWallpapers = [];
let steamSelected   = new Set();

document.getElementById('btn-steam-custom-dir').addEventListener('click', async () => {
  const result = await ipc('open-file-dialog', {
    title: 'Selecionar pasta do Workshop',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const customDir = result.filePaths[0];

  steamWallpapers = []; steamSelected.clear();
  document.getElementById('steam-list').innerHTML = '';
  document.getElementById('steam-footer').style.display = 'none';
  document.getElementById('steam-status').style.display = 'block';
  document.getElementById('steam-status').textContent = '🔍 Lendo pasta selecionada...';

  const scanResult = await ipc('scan-custom-workshop', customDir);
  if (scanResult.error || !scanResult.wallpapers.length) {
    document.getElementById('steam-status').textContent = '⚠️ ' + (scanResult.error || 'Nenhum projeto encontrado nesta pasta.');
    return;
  }
  steamWallpapers = scanResult.wallpapers;
  document.getElementById('steam-status').style.display = 'none';
  document.getElementById('steam-footer').style.display = 'flex';
  renderSteamList();
  updateSteamCount();
});

document.getElementById('btn-add-steam').addEventListener('click', async () => {
  steamWallpapers = []; steamSelected.clear();
  document.getElementById('steam-list').innerHTML = '';
  document.getElementById('steam-footer').style.display = 'none';
  document.getElementById('steam-status').style.display = 'block';
  document.getElementById('steam-status').textContent = '🔍 Procurando wallpapers...';
  document.getElementById('modal-steam').classList.add('open');

  const result = await ipc('scan-steam-workshop');
  if (result.error || !result.wallpapers.length) {
    document.getElementById('steam-status').textContent = '⚠️ ' + (result.error || 'Nenhum wallpaper compatível encontrado (Vídeo, Web e Cena são suportados)');
    return;
  }
  steamWallpapers = result.wallpapers;
  document.getElementById('steam-status').style.display = 'none';
  document.getElementById('steam-footer').style.display = 'flex';
  renderSteamList();
  updateSteamCount();
});

function renderSteamList() {
  const list = document.getElementById('steam-list');
  list.innerHTML = '';
  for (const wp of steamWallpapers) {
    const already = library.some(l => l.src === wp.src);
    const item = document.createElement('div');
    item.className = 'steam-item' + (already ? ' steam-already' : '');
    const previewSrc = wp.preview ? toFileUrl(wp.preview) : '';
    const badgeLabel = wp.type === 'video' ? 'Vídeo' : wp.type === 'scene' ? 'Cena' : 'Web';
    const sceneNote  = wp.type === 'scene' ? ' · preview estático' : '';
    item.innerHTML = `
      <input type="checkbox" class="steam-check" ${already ? 'disabled' : ''} />
      <div class="steam-thumb">${previewSrc ? `<img src="${previewSrc}" onerror="this.parentNode.innerHTML=''" />` : ''}<span class="steam-badge steam-badge-${wp.type}">${badgeLabel}</span></div>
      <div class="steam-info"><div class="steam-name" title="${wp.name}">${wp.name}</div><div class="steam-tags">${already ? '✓ Já importado' : (wp.tags.slice(0,4).join(' · ') || '') + sceneNote}</div></div>
    `;
    if (!already) {
      const cb = item.querySelector('.steam-check');
      item.addEventListener('click', e => { if (e.target === cb) return; cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
      cb.addEventListener('change', () => {
        if (cb.checked) { steamSelected.add(wp.workshopId); item.classList.add('steam-selected'); }
        else            { steamSelected.delete(wp.workshopId); item.classList.remove('steam-selected'); }
        updateSteamCount();
      });
    }
    list.appendChild(item);
  }
}

function updateSteamCount() {
  const importable = steamWallpapers.filter(w => !library.some(l => l.src === w.src)).length;
  const sel = steamSelected.size;
  document.getElementById('steam-count').textContent = `${sel} de ${importable} selecionados`;
  document.getElementById('btn-steam-import').disabled = sel === 0;
  document.getElementById('btn-steam-selectall').textContent = (sel === importable && importable > 0) ? 'Desmarcar Tudo' : 'Selecionar Tudo';
}

document.getElementById('btn-steam-selectall').addEventListener('click', () => {
  const importable = steamWallpapers.filter(w => !library.some(l => l.src === w.src));
  const allSel = steamSelected.size === importable.length && importable.length > 0;
  steamSelected.clear();
  document.querySelectorAll('.steam-item:not(.steam-already)').forEach((item, i) => {
    const cb = item.querySelector('.steam-check');
    cb.checked = !allSel;
    item.classList.toggle('steam-selected', !allSel);
    if (!allSel) steamSelected.add(importable[i].workshopId);
  });
  updateSteamCount();
});

document.getElementById('btn-steam-import').addEventListener('click', async () => {
  const toImport = steamWallpapers.filter(w => steamSelected.has(w.workshopId));
  let lastAdded = null;
  for (const wp of toImport) {
    if (library.some(l => l.src === wp.src)) continue;
    let thumbnail = wp.preview ? toFileUrl(wp.preview) : null;
    // If we managed to unpack the scene's .pkg (see main.js resolveWeSceneDir),
    // keep it as a real 'scene' — wallpaper.js renders it live. Otherwise fall
    // back to importing its frozen preview as a static image.
    const importType = (wp.type === 'scene' && !wp.weSceneDir) ? 'image' : wp.type;
    const w = await ipc('add-wallpaper', { type: importType, name: wp.name, src: wp.src, thumbnail, steamId: wp.workshopId, weSceneDir: wp.weSceneDir });
    library.push(w);
    lastAdded = w;
  }
  renderLibrary();
  closeModal('modal-steam');
  if (lastAdded) setWallpaper(lastAdded);
});

document.getElementById('btn-steam-close').addEventListener('click', () => closeModal('modal-steam'));

// ---- Now Playing ----
function updateNowPlaying() {
  const nameEl  = document.getElementById('now-name');
  const typeEl  = document.getElementById('now-type');
  const thumbEl = document.getElementById('now-thumb');
  if (!current) {
    nameEl.textContent = 'Nenhum wallpaper ativo'; typeEl.textContent = '–'; 
    thumbEl.innerHTML = '<div style="background:#2a2a35;width:100%;height:100%;"></div>';
    return;
  }
  nameEl.textContent = current.name;
  typeEl.textContent = typeName(current.type, current.scene);
  if (current.thumbnail) {
    thumbEl.innerHTML = `<img src="${current.thumbnail}" style="width:100%;height:100%;object-fit:cover;" />`;
  } else if (current.type === 'image') {
    thumbEl.innerHTML = `<img src="${toFileUrl(current.src)}" style="width:100%;height:100%;object-fit:cover;" />`;
  } else {
    thumbEl.innerHTML = `<div style="background:var(--bg3);width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px">${typeIcon(current.type, current.scene)}</div>`;
  }
}

// ---- Controls ----
const app = {
  prevWallpaper() {
    const items = filteredLibrary();
    if (!items.length) return;
    const idx = items.findIndex(w => current && w.id === current.id);
    setWallpaper(items[(idx - 1 + items.length) % items.length]);
  },
  nextWallpaper() {
    const items = filteredLibrary();
    if (!items.length) return;
    const idx = items.findIndex(w => current && w.id === current.id);
    setWallpaper(items[(idx + 1) % items.length]);
  },
};

// ---- Play/Pause ----
const btnPlayPause = document.getElementById('btn-play-pause');
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
const ICON_PLAY   = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
btnPlayPause.addEventListener('click', async () => {
  const { paused } = await ipc('toggle-playback');
  btnPlayPause.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
  btnPlayPause.classList.toggle('np-paused', paused);
});

// ---- Listen for events from main ----
ipcRenderer.on('wallpaper-changed', (_, w) => {
  current = w;
  renderLibrary();
  updateNowPlaying();
});

// ---- Terminal de Logs + status de download (Descobrir) ----
// "ws-status-bar" é usado pelo fluxo real de download da aba Descobrir
// (showWallpaperModal/startWorkshopDownload/download-progress) — não tem
// mais um painel próprio (a Oficina virou o editor visual), então
// setWsStatus() abaixo é um no-op seguro caso o elemento não exista.
const wsStatus      = document.getElementById('ws-status-bar');
const wsStatusText   = document.getElementById('ws-status-text');
const wsStatusDetail = document.getElementById('ws-status-detail');
const wsProgressFill = document.getElementById('ws-progress-fill');
const wsLogLines     = document.getElementById('ws-log-lines');
const wsLogCount     = document.getElementById('ws-log-count');

let _logLineCount = 0;
const _logRawLines = []; // plain text for copy

const LOG_COLORS = {
  info:    { badge: '#5c6bc0', text: '#c0c8e8' },
  success: { badge: '#43a047', text: '#81c784' },
  warn:    { badge: '#ff9800', text: '#ffcc80' },
  error:   { badge: '#e53935', text: '#ef9a9a' },
  debug:   { badge: '#555',    text: '#777' },
};

const LOG_LABELS = {
  info: 'INFO', success: 'OK', warn: 'AVISO', error: 'ERRO', debug: 'DEBUG',
};

const LOG_ICONS = {
  info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌', debug: '🔍',
};

function appendLogLine(data) {
  // Support both old string format and new structured format
  let ts, msg, level;
  if (typeof data === 'string') {
    // Legacy format: "[HH:MM:SS] message"
    const m = data.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
    ts = m ? m[1] : '';
    msg = m ? m[2] : data;
    level = 'info';
  } else {
    ts = data.ts || '';
    msg = data.msg || '';
    level = data.level || 'info';
  }

  const colors = LOG_COLORS[level] || LOG_COLORS.info;
  const label = LOG_LABELS[level] || 'INFO';
  const icon = LOG_ICONS[level] || '';

  _logLineCount++;
  _logRawLines.push(`[${ts}] [${label}] ${msg}`);

  const line = document.createElement('div');
  line.style.cssText = `display:flex;align-items:flex-start;gap:8px;padding:2px 0;border-bottom:1px solid #1a1a1a;`;

  line.innerHTML = `
    <span style="color:#444;font-size:11px;flex-shrink:0;min-width:60px;">${ts}</span>
    <span style="background:${colors.badge};color:#fff;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;flex-shrink:0;min-width:42px;text-align:center;">${label}</span>
    <span style="color:${colors.text};flex:1;word-break:break-word;">${escapeHtml(msg)}</span>
  `;

  wsLogLines.appendChild(line);
  wsLogLines.scrollTop = wsLogLines.scrollHeight;
  wsLogCount.textContent = `${_logLineCount} linha${_logLineCount !== 1 ? 's' : ''}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

ipcRenderer.on('app-log', (_, data) => {
  appendLogLine(data);
});

// Log panel buttons
document.getElementById('btn-log-copy').addEventListener('click', () => {
  const text = _logRawLines.join('\n');
  if (!text) return;
  require('electron').clipboard.writeText(text);
  const btn = document.getElementById('btn-log-copy');
  const original = btn.innerHTML;
  btn.innerHTML = '✅ Copiado!';
  btn.style.color = '#4caf50';
  setTimeout(() => { btn.innerHTML = original; btn.style.color = '#8888cc'; }, 2000);
});

document.getElementById('btn-log-clear').addEventListener('click', () => {
  wsLogLines.innerHTML = '';
  _logLineCount = 0;
  _logRawLines.length = 0;
  wsLogCount.textContent = '0 linhas';
});


function setWsStatus(text, detail = '', pct = null, color = 'var(--accent)') {
  if (!wsStatus) return;
  wsStatus.style.display = 'block';
  wsStatus.style.background = color;
  wsStatus.style.color = color === 'var(--accent)' ? '#000' : '#fff';
  wsStatusText.textContent = text;
  wsStatusDetail.textContent = detail;
  wsProgressFill.style.width = pct !== null ? Math.min(100, Math.round(pct * 100)) + '%' : '0%';
}
// #ws-status-bar não existe mais no HTML atual (removido numa reforma
// anterior da UI) — wsStatus fica sempre null. setWsStatus() já se protegia
// pra isso, mas vários pontos espalhados faziam `wsStatus.style...` direto,
// sem checar null, e quebravam com "Cannot read properties of null"
// (confirmado ao vivo, main.js/app.js:1513). Helper seguro pra esconder,
// reusado em todos esses pontos.
function hideWsStatus() { if (wsStatus) wsStatus.style.display = 'none'; }


const WA_TYPE_LABELS = {
  video: 'Vídeo',
  web: 'Web',
  scene: 'Cena (importa como imagem estática)',
  application: 'Aplicativo — incompatível, não funciona neste app',
  unknown: 'Desconhecido',
};

let _defaultApplyBtnHtml = null;

function showWallpaperModal(item) {
  const overlay = document.getElementById('wallpaper-modal-overlay');
  if (!overlay) return;

  const safeTitle = item.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const typeLabel = WA_TYPE_LABELS[item.waType] || WA_TYPE_LABELS.unknown;

  document.getElementById('modal-hero-img').src = item.preview || '';
  document.getElementById('modal-title').textContent = item.title;
  document.getElementById('modal-type-badge').textContent = typeLabel;
  
  // Stats
  document.getElementById('modal-stat-dl').textContent = formatSubscribers(item.subscribers);
  document.getElementById('modal-stat-fav').textContent = formatSubscribers(item.favorited || Math.floor(item.subscribers * 0.3)); // Estimativa se não tiver
  document.getElementById('modal-stat-view').textContent = formatSubscribers(item.views);

  // Author info (fallbacks when unavailable from Steam public API)
  document.getElementById('modal-author-name').innerHTML = `Usuário Steam <svg viewBox="0 0 24 24" width="14" height="14" fill="#8E24AA" style="margin-left:4px"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;

  // Tags
  const tagsContainer = document.getElementById('modal-tags');
  tagsContainer.innerHTML = '';
  if (item.tags && item.tags.length > 0) {
    item.tags.forEach(t => {
      const sp = document.createElement('span');
      sp.className = 'modal-tag';
      sp.textContent = t;
      tagsContainer.appendChild(sp);
    });
  } else {
    tagsContainer.innerHTML = '<span class="modal-tag">Sem tags</span>';
  }

  // Action Button — bloqueia reinstalação de algo que já está na Biblioteca
  // em vez de baixar de novo por cima (o servidor da Steam nem precisa ser
  // consultado pra saber isso, já temos o workshopId localmente).
  const applyBtn = document.getElementById('modal-btn-apply');
  if (_defaultApplyBtnHtml === null) _defaultApplyBtnHtml = applyBtn.innerHTML;

  if (isInstalled(item)) {
    applyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"></path></svg> Já instalado';
    applyBtn.classList.add('installed');
    applyBtn.onclick = () => {
      setWsStatus('✅ Esse wallpaper já está na sua biblioteca — sem necessidade de baixar de novo.', '', null, '#10b981');
      setTimeout(() => { document.getElementById('ws-status-bar')?.style && (document.getElementById('ws-status-bar').style.display = 'none'); }, 4000);
    };
  } else {
    applyBtn.innerHTML = _defaultApplyBtnHtml;
    applyBtn.classList.remove('installed');
    // Padrão agora é baixar sem precisar do Wallpaper Engine instalado
    // (via SteamCMD) — um clique só, sem menu de escolha.
    applyBtn.onclick = (e) => {
      e.stopPropagation();
      if (!item.compatible) {
        setWsStatus('⚠️ Wallpaper incompatível com o formato livre deste motor.', '', null, '#f44336');
        setTimeout(() => { document.getElementById('ws-status-bar')?.style && (document.getElementById('ws-status-bar').style.display = 'none'); }, 4000);
        return;
      }
      overlay.classList.remove('open');
      startSteamCmdDirect(item.workshopId, item.title);
    };
  }

  // Favorite buttons (o "Favoritar" no rodapé e o coração no topo do modal fazem a mesma coisa)
  const favBtn = document.getElementById('modal-btn-favorite');
  const favIconBtn = document.getElementById('modal-icon-btn-favorite');
  const setFavBtnState = (favorited) => {
    favBtn.innerHTML = favorited
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg> Favoritado'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg> Favoritar';
    if (favIconBtn) {
      favIconBtn.innerHTML = favorited
        ? '<svg viewBox="0 0 24 24" fill="#e0245e" stroke="#e0245e" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
    }
  };
  setFavBtnState(isFavorited(item));
  const onFavClick = async () => {
    const added = await toggleFavorite(item);
    setFavBtnState(added);
  };
  favBtn.onclick = onFavClick;
  if (favIconBtn) favIconBtn.onclick = onFavClick;

  const addToPlBtn = document.getElementById('modal-btn-add-to-playlist');
  if (addToPlBtn) addToPlBtn.onclick = () => openAddToPlaylistPicker(item);

  overlay.classList.add('open');
}

// Fechamento do Modal
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('wallpaper-modal-overlay');
  const closeBtn = document.getElementById('modal-close');
  if (overlay && closeBtn) {
    closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
    
    // Fechar ao clicar fora do painel lateral
    document.addEventListener('mousedown', (e) => {
      if (overlay.classList.contains('open') && !overlay.contains(e.target)) {
        // Evitar conflito se o clique for exatamente num card que abre o modal
        const isCardClick = e.target.closest('.wp-card, .wallpaper-card, .playlist-card');
        if (!isCardClick) {
          overlay.classList.remove('open');
        }
      }
    });
  }
  initHeaderAndSystemPanel();
});

// Cabeçalho (saudação real + atalho de busca + status Steam + engrenagem),
// sidebar (EXPLORAR ligado aos filtros reais, painel SISTEMA com CPU/RAM/FPS
// de verdade) — tudo aqui usa dado real, nada inventado (ver main.js's
// 'system-stats'/'get-steam-status' e wallpaper.js's 'wallpaper-fps').
function initHeaderAndSystemPanel() {
  // Saudação: nome real da conta do Windows (não temos "nome de exibição"
  // próprio no app hoje) + período do dia real.
  const hour = new Date().getHours();
  const period = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  let osName = '';
  try { osName = os.userInfo().username; } catch (_) { /* segue sem nome se der erro */ }
  const greetingEl = document.getElementById('discover-greeting');
  if (greetingEl) greetingEl.textContent = osName ? `${period}, ${osName} 👋` : `${period} 👋`;
  const sidebarNameEl = document.getElementById('sidebar-user-name');
  if (sidebarNameEl) sidebarNameEl.textContent = osName || 'Usuário';
  const avatarFallback = document.getElementById('user-avatar-fallback');
  if (avatarFallback && osName) avatarFallback.textContent = osName[0].toUpperCase();

  const aboutVersionEl = document.getElementById('about-version');
  if (aboutVersionEl) aboutVersionEl.textContent = appVersion;
  const sidebarVersionEl = document.getElementById('sidebar-version-text');
  if (sidebarVersionEl) sidebarVersionEl.textContent = appVersion;

  // Ctrl+K (ou Cmd+K no mac) foca a busca da aba Descobrir, trocando de aba
  // se precisar — igual ao atalho mostrado no próprio campo.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const discoverNav = document.querySelector('.nav-item[data-panel="discover"]');
      if (discoverNav && !discoverNav.classList.contains('active')) discoverNav.click();
      const input = document.getElementById('discover-search-input');
      if (input) { input.focus(); input.select(); }
    }
  });

  // Engrenagem do cabeçalho só ativa a aba Configurações que já existe.
  const settingsBtn = document.getElementById('btn-header-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      const settingsNav = document.querySelector('.nav-item[data-panel="settings"]');
      if (settingsNav) settingsNav.click();
    });
  }

  // Ícone de Log no cabeçalho — mesmo padrão do Configurações. O painel
  // (#panel-logs) já existia no HTML, mas não tinha nenhum jeito de abrir.
  const logsBtn = document.getElementById('btn-header-logs');
  if (logsBtn) {
    logsBtn.addEventListener('click', () => {
      const logsNav = document.querySelector('.nav-item[data-panel="logs"]');
      if (logsNav) logsNav.click();
    });
  }

  // Clicar no nome/avatar do usuário na sidebar também abre Configurações.
  const sidebarUser = document.querySelector('.sidebar-user');
  if (sidebarUser) {
    sidebarUser.style.cursor = 'pointer';
    sidebarUser.addEventListener('click', () => {
      const settingsNav = document.querySelector('.nav-item[data-panel="settings"]');
      if (settingsNav) settingsNav.click();
    });
  }

  // Status real da sessão Steam (conectado = tem cookie de sessão salvo).
  ipc('get-steam-status').then((status) => {
    const badge = document.getElementById('steam-status-badge');
    if (!badge) return;
    badge.classList.toggle('connected', !!(status && status.connected));
    const label = document.getElementById('steam-status-label');
    if (label) label.textContent = status && status.connected ? 'Conectado' : 'Desconectado';
  }).catch(() => {});

  // Painel SISTEMA: CPU/RAM chegam prontos do main a cada 2s, FPS vem do
  // wallpaper ativo em tempo real — só refletimos o que chega, sem calcular
  // nada de fake aqui.
  ipcRenderer.on('system-stats', (_, { cpu, ram }) => {
    const cpuVal = document.getElementById('stat-cpu-val'), cpuBar = document.getElementById('stat-cpu-bar');
    const ramVal = document.getElementById('stat-ram-val'), ramBar = document.getElementById('stat-ram-bar');
    if (cpuVal) cpuVal.textContent = cpu + '%';
    if (cpuBar) cpuBar.style.width = cpu + '%';
    if (ramVal) ramVal.textContent = ram + '%';
    if (ramBar) ramBar.style.width = ram + '%';
  });
  ipcRenderer.on('wallpaper-fps-update', (_, { fps }) => {
    const fpsVal = document.getElementById('stat-fps-val');
    if (fpsVal) fpsVal.textContent = fps;
  });

  // Sidebar "EXPLORAR": troca pra aba Descobrir e aplica o mesmo filtro que
  // os chips/pills já usam (tendência/mais recentes/rolar até Categorias).
  document.querySelectorAll('.nav-item-sm[data-discover-sort]').forEach((item) => {
    item.addEventListener('click', () => {
      const discoverNav = document.querySelector('.nav-item[data-panel="discover"]');
      if (discoverNav) discoverNav.click();
      document.querySelectorAll('.nav-item-sm[data-discover-sort]').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      discoverDefaultSort = item.dataset.discoverSort;
      applyDiscoverFilter({}); // limpa tag/busca e já recarrega com o novo sort
    });
  });
  document.querySelectorAll('.nav-item-sm[data-discover-action="categories"]').forEach((item) => {
    item.addEventListener('click', () => {
      const discoverNav = document.querySelector('.nav-item[data-panel="discover"]');
      if (discoverNav) discoverNav.click();
      const target = document.getElementById('filter-pills');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  // "Ver todos" de Populares/Mais Baixados — aplica o sort real no próprio
  // feed do Descobrir (a Oficina não é mais um navegador de Workshop).
  document.getElementById('discover-viewall-popular')?.addEventListener('click', (e) => {
    e.preventDefault();
    discoverDefaultSort = 'trend';
    applyDiscoverFilter({});
  });
  document.getElementById('discover-viewall-toprated')?.addEventListener('click', (e) => {
    e.preventDefault();
    discoverDefaultSort = 'toprated';
    applyDiscoverFilter({});
  });
}

function formatSubscribers(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

async function startWorkshopDownload(workshopId, title, previewUrl, fileUrl) {
  // Trava de segurança: mesmo se chamado por outro caminho (retomada de
  // login pendente, etc.), nunca baixa de novo algo que já está na Biblioteca.
  if (library.some(w => String(w.workshopId) === String(workshopId))) {
    setWsStatus('✅ Esse wallpaper já está na sua biblioteca — sem necessidade de baixar de novo.', '', null, '#10b981');
    setTimeout(() => { document.getElementById('ws-status-bar')?.style && (document.getElementById('ws-status-bar').style.display = 'none'); }, 4000);
    return;
  }
  setWsStatus(`⏳ Preparando inscrição invisível: ${title}...`);
  const result = await ipc('download-workshop-item', { workshopId, name: title, previewUrl: previewUrl || null, fileUrl: fileUrl || null });
  
  if (result && result.msg === 'needs_login') {
    document.getElementById('dl-loading-screen').classList.remove('visible');
    _slPending = { workshopId, name: title, previewUrl };
    document.getElementById('sl-preview-img').src = previewUrl || '';
    document.getElementById('sl-preview-wrap').style.display = previewUrl ? 'block' : 'none';
    document.getElementById('modal-steam-login').classList.add('open');
  } else if (result && result.ok === false) {
    document.getElementById('dl-loading-screen').classList.remove('visible');
  }
}

// Download progress from main process
let _slPending  = null; // { workshopId, name, previewUrl }
let _setupMode  = false;

document.getElementById('btn-steam-web-login').addEventListener('click', async () => {
  setWsStatus('⏳ Abrindo janela de login da Steam...');
  const result = await ipc('steam-web-login');
  if (result.ok) {
    setWsStatus('✅ Login Steam realizado com sucesso!', 'Inscrições invisíveis habilitadas.', 1, '#4caf50');
    setTimeout(() => { hideWsStatus(); }, 4000);
    closeModal('modal-steam-login');
    
    // Se tinha um download pendente, tenta baixar de novo agora que tem cookies
    if (_slPending) {
      startWorkshopDownload(_slPending.workshopId, _slPending.name, _slPending.previewUrl);
    }
  } else {
    setWsStatus('❌ ' + (result.msg || 'Login cancelado/falhou.'), '', null, '#c0392b');
    setTimeout(() => { hideWsStatus(); }, 4000);
  }
});

document.getElementById('btn-sl-export-session').addEventListener('click', async () => {
  const result = await ipc('export-steam-session');
  const btn = document.getElementById('btn-sl-export-session');
  const original = btn.textContent;
  if (result.ok) {
    require('electron').clipboard.writeText(result.code);
    btn.textContent = '✅ Copiado! Cole no outro PC.';
  } else {
    btn.textContent = '❌ ' + result.msg;
  }
  setTimeout(() => { btn.textContent = original; }, 4000);
});

document.getElementById('btn-sl-import-session').addEventListener('click', async () => {
  const code = prompt('Cole aqui o código exportado do outro PC:');
  if (!code) return;
  const result = await ipc('import-steam-session', code.trim());
  const btn = document.getElementById('btn-sl-import-session');
  const original = btn.textContent;
  if (result.ok) {
    btn.textContent = '✅ Sessão importada!';
    setTimeout(() => {
      closeModal('modal-steam-login');
      if (_slPending) startWorkshopDownload(_slPending.workshopId, _slPending.name, _slPending.previewUrl);
    }, 1200);
  } else {
    btn.textContent = '❌ ' + (result.msg || 'Código inválido.');
    setTimeout(() => { btn.textContent = original; }, 4000);
  }
});

document.getElementById('btn-sl-use-preview').addEventListener('click', async () => {
  if (!_slPending?.previewUrl) { closeModal('modal-steam-login'); return; }
  const w = await ipc('add-wallpaper', {
    type: 'image',
    name: _slPending.name + ' (preview)',
    src: _slPending.previewUrl,
  });
  library.push(w);
  renderLibrary();
  closeModal('modal-steam-login');
  setWallpaper(w);
  _slPending = null;
});

document.getElementById('btn-we-scene-help-start').addEventListener('click', async () => {
  closeModal('modal-we-scene-help');
  await ipc('we-scene-enter-edit');
});

function openSetupModal() {
  _setupMode = true;
  document.getElementById('btn-sl-use-preview').style.display = 'none';
  document.getElementById('sl-preview-wrap').style.display = 'none';
  document.getElementById('modal-steam-login').classList.add('open');
}

document.getElementById('btn-settings-steam-session').addEventListener('click', openSetupModal);

document.getElementById('btn-unstick-steam').addEventListener('click', async () => {
  const btn = document.getElementById('btn-unstick-steam');
  const original = btn.textContent;
  btn.textContent = '⏳ Pedindo...';
  btn.disabled = true;
  await ipc('unstick-steam-downloads');
  btn.textContent = '✅ Steam avisada!';
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 3000);
});

// A Steam local às vezes pausa sozinha a fila de update do Wallpaper Engine
// com erro "File locked" (nosso próprio app mantendo um arquivo de vídeo do
// Workshop aberto — ver comentário em main.js/download-workshop-item) e não
// dá nenhum sinal disso pro nosso lado: o download só fica parado pra sempre
// no mesmo estado "progress" (que, nesse fluxo de web-subscribe, é só um
// placeholder fixo, não progresso real — não tem como distinguir "ainda
// baixando" de "travou"). Em vez de o usuário precisar descobrir isso e ir
// nas Configurações clicar em "Destravar", mostra o mesmo botão direto aqui
// depois de um tempo parado sem terminar.
const DL_UNSTICK_DELAY_MS = 20000;
let _dlUnstickTimer = null;
function armDlUnstickButton() {
  clearTimeout(_dlUnstickTimer);
  const btn = document.getElementById('dl-unstick-btn');
  btn.style.display = 'none';
  _dlUnstickTimer = setTimeout(() => { btn.style.display = 'inline-block'; }, DL_UNSTICK_DELAY_MS);
}
function disarmDlUnstickButton() {
  clearTimeout(_dlUnstickTimer);
  document.getElementById('dl-unstick-btn').style.display = 'none';
}
document.getElementById('dl-unstick-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const btn = e.currentTarget;
  const original = btn.textContent;
  btn.textContent = '⏳ Pedindo...';
  btn.disabled = true;
  await ipc('unstick-steam-downloads');
  btn.textContent = '✅ Steam avisada, aguarde...';
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 5000);
});

// ---- SteamCMD (opt-in, PC sem Wallpaper Engine instalado) ----
// Caminho ADICIONAL ao fluxo de download-progress acima — não mexe nele.
let _scmdPendingPromptKind = null; // 'password' | 'guard-code' | null

function _scmdSetStatus(text, busy) {
  document.getElementById('scmd-status-text').textContent = text;
  document.getElementById('scmd-status-dot').style.display = busy ? 'inline-block' : 'none';
}

function _scmdLog(line) {
  const box = document.getElementById('scmd-log-lines');
  box.style.display = 'block';
  box.textContent += (box.textContent ? '\n' : '') + line;
  box.scrollTop = box.scrollHeight;
}

function _setScmdBusy(busy) {
  document.getElementById('btn-scmd-validate').disabled = busy;
  document.getElementById('btn-scmd-download').disabled = busy;
  document.getElementById('btn-scmd-download').textContent = busy ? 'Aguarde...' : 'Baixar';
}

async function openSteamCmdModal(prefillWorkshopId) {
  const savedUsername = await ipc('steamcmd-get-username');
  document.getElementById('scmd-username').value = savedUsername || '';
  document.getElementById('scmd-workshop-id').value = prefillWorkshopId || '';
  document.getElementById('scmd-login-check').textContent = '';
  document.getElementById('scmd-prompt-field').style.display = 'none';
  document.getElementById('scmd-prompt-input').value = '';
  document.getElementById('btn-scmd-confirm-prompt').style.display = 'none';
  document.getElementById('scmd-log-lines').textContent = '';
  document.getElementById('scmd-log-lines').style.display = 'none';
  _scmdSetStatus('', false);
  _setScmdBusy(false);
  _scmdPendingPromptKind = null;
  document.getElementById('modal-steamcmd').classList.add('open');
}

document.getElementById('btn-open-steamcmd').addEventListener('click', () => openSteamCmdModal());

// Ação padrão do "Aplicar Wallpaper" pra item ainda não baixado: um clique
// só, sem abrir modal — usa o usuário Steam já salvo. Só abre o modal (pra
// digitar o usuário uma vez) se for a primeiríssima vez, sem nada salvo
// ainda. Usa a mesma tela cheia de carregamento do fluxo padrão
// (dl-loading-screen) — pedido do usuário, pra não ficar sem nenhuma
// indicação visual de que algo está acontecendo. Como o SteamCMD não dá
// porcentagem real (só estados discretos), a barra avança em degraus fixos
// por etapa, igual ao "progress" falso que o fluxo padrão já usava.
async function startSteamCmdDirect(workshopId, title) {
  const displayTitle = title || 'Wallpaper';
  const savedUsername = await ipc('steamcmd-get-username');
  if (!savedUsername) {
    openSteamCmdModal(workshopId);
    return;
  }
  const dlScreen = document.getElementById('dl-loading-screen');
  document.getElementById('dl-loading-title').textContent = 'Aplicando wallpaper';
  document.getElementById('dl-loading-subtitle').textContent = displayTitle;
  document.getElementById('dl-progress-fill').style.width = '0%';
  document.getElementById('dl-progress-text').textContent = 'Iniciando...';
  const dlLog = document.getElementById('dl-log-lines');
  dlLog.textContent = '';
  dlLog.style.display = 'none';
  dlScreen.classList.add('visible');
  setWsStatus(`⏳ ${displayTitle}`);

  const result = await ipc('steamcmd-download-item', { username: savedUsername, workshopId });
  if (!result || !result.ok) {
    dlScreen.classList.remove('visible');
    setWsStatus('❌ ' + (result && result.msg ? result.msg : 'Falha no download.'), '', null, '#c0392b');
    setTimeout(() => { hideWsStatus(); }, 5000);
  }
}

document.getElementById('btn-scmd-validate').addEventListener('click', async () => {
  const username = document.getElementById('scmd-username').value.trim();
  const checkEl = document.getElementById('scmd-login-check');
  if (!username) {
    _scmdSetStatus('❌ Informe o usuário Steam.', false);
    return;
  }
  _setScmdBusy(true);
  checkEl.textContent = '';
  document.getElementById('scmd-log-lines').textContent = '';
  document.getElementById('scmd-log-lines').style.display = 'none';
  _scmdSetStatus('Verificando login...', true);
  const result = await ipc('steamcmd-validate-login', { username });
  _setScmdBusy(false);
  document.getElementById('scmd-prompt-field').style.display = 'none';
  document.getElementById('btn-scmd-confirm-prompt').style.display = 'none';
  _scmdPendingPromptKind = null;
  _scmdSetStatus('', false);
  if (result && result.ok) {
    checkEl.textContent = '✅ Usuário e senha corretos.';
    checkEl.style.color = '#4caf50';
  } else {
    checkEl.textContent = '❌ ' + (result && result.msg ? result.msg : 'Usuário ou senha incorretos.');
    checkEl.style.color = '#e05a5a';
  }
});

document.getElementById('btn-scmd-download').addEventListener('click', async () => {
  const username = document.getElementById('scmd-username').value.trim();
  const workshopId = document.getElementById('scmd-workshop-id').value.trim();
  if (!username || !workshopId) {
    _scmdSetStatus('❌ Preencha usuário e ID/link do item.', false);
    return;
  }
  _setScmdBusy(true);
  document.getElementById('scmd-log-lines').textContent = '';
  document.getElementById('scmd-log-lines').style.display = 'none';
  _scmdSetStatus('Preparando SteamCMD...', true);
  const result = await ipc('steamcmd-download-item', { username, workshopId });
  _setScmdBusy(false);
  document.getElementById('scmd-prompt-field').style.display = 'none';
  document.getElementById('btn-scmd-confirm-prompt').style.display = 'none';
  _scmdPendingPromptKind = null;
  if (result && result.ok) {
    _scmdSetStatus('✅ Baixado e adicionado à biblioteca!', false);
  } else {
    _scmdSetStatus('❌ ' + (result && result.msg ? result.msg : 'Falha no download.'), false);
  }
});

document.getElementById('btn-scmd-confirm-prompt').addEventListener('click', async () => {
  const value = document.getElementById('scmd-prompt-input').value;
  if (!value || !_scmdPendingPromptKind) return;
  if (_scmdPendingPromptKind === 'password') {
    await ipc('steamcmd-provide-password', value);
  } else {
    await ipc('steamcmd-provide-guard-code', value);
  }
  document.getElementById('scmd-prompt-input').value = '';
  document.getElementById('scmd-prompt-field').style.display = 'none';
  document.getElementById('btn-scmd-confirm-prompt').style.display = 'none';
  _scmdSetStatus('Continuando...', true);
  _scmdPendingPromptKind = null;
});

ipcRenderer.on('steamcmd-need-password', () => {
  _scmdPendingPromptKind = 'password';
  _scmdSetStatus('🔑 A Steam pediu sua senha.', true);
  document.getElementById('scmd-prompt-label').textContent = 'Senha';
  document.getElementById('scmd-prompt-input').type = 'password';
  document.getElementById('scmd-prompt-input').value = '';
  document.getElementById('scmd-prompt-field').style.display = 'block';
  document.getElementById('btn-scmd-confirm-prompt').style.display = 'inline-block';
  document.getElementById('scmd-prompt-input').focus();
});

ipcRenderer.on('steamcmd-need-guard-code', () => {
  _scmdPendingPromptKind = 'guard-code';
  _scmdSetStatus('📱 Digite o código do Steam Guard.', true);
  document.getElementById('scmd-prompt-label').textContent = 'Código do Steam Guard';
  document.getElementById('scmd-prompt-input').type = 'text';
  document.getElementById('scmd-prompt-input').value = '';
  document.getElementById('scmd-prompt-field').style.display = 'block';
  document.getElementById('btn-scmd-confirm-prompt').style.display = 'inline-block';
  document.getElementById('scmd-prompt-input').focus();
});

// Linha crua do SteamCMD (mesmo texto que vai pra aba Log) — mostrada
// também aqui dentro do modal, pra não parecer travado numa espera longa.
ipcRenderer.on('steamcmd-log-line', (_, line) => {
  _scmdLog(line);
  // Também mostra na tela cheia de download (clique direto em "Aplicar
  // Wallpaper" nunca abre o modal do SteamCMD, então sem isso não tinha
  // NENHUM jeito de ver o que estava acontecendo enquanto travado).
  const dlLog = document.getElementById('dl-log-lines');
  if (dlLog) {
    dlLog.style.display = 'block';
    dlLog.textContent += (dlLog.textContent ? '\n' : '') + line;
    dlLog.scrollTop = dlLog.scrollHeight;
  }
});

ipcRenderer.on('steamcmd-status', (_, data) => {
  // Espelha o mesmo status na barra flutuante de sempre (setWsStatus) e,
  // quando veio do clique direto em "Aplicar Wallpaper", na tela cheia
  // clássica de download (dl-loading-screen) — sem porcentagem real (o
  // SteamCMD não dá isso), avança em degraus fixos por etapa.
  const dlScreen = document.getElementById('dl-loading-screen');
  const dlFill = document.getElementById('dl-progress-fill');
  const dlText = document.getElementById('dl-progress-text');
  const dlActive = dlScreen.classList.contains('visible');

  if (data.state === 'need-interactive-login') {
    _scmdSetStatus('🪟 Uma janela do SteamCMD vai abrir — se ela pedir senha ou código, digite direto ali (não aqui).', true);
    setWsStatus('🪟 Uma janela do SteamCMD vai abrir — se pedir senha/código, digite ali.', '', 0.2);
    if (dlActive) { dlFill.style.width = '20%'; dlText.textContent = 'Aguardando login na Steam...'; }
  } else if (data.state === 'validating') {
    _scmdSetStatus('Verificando login...', true);
    setWsStatus('⏳ Verificando login na Steam...', '', 0.4);
    if (dlActive) { dlFill.style.width = '45%'; dlText.textContent = 'Verificando login...'; }
  } else if (data.state === 'starting') {
    _scmdSetStatus('Baixando via SteamCMD...', true);
    setWsStatus('📥 Baixando via SteamCMD...', '', 0.6);
    if (dlActive) { dlFill.style.width = '70%'; dlText.textContent = 'Baixando arquivos...'; }
  } else if (data.state === 'completed') {
    const wp = data.wallpaper;
    if (wp && !library.some(w => w.id === wp.id)) {
      library.push(wp);
      renderLibrary();
    }
    if (wp) {
      // Mesmo comportamento do fluxo padrão: baixou, já aplica — e mostra o
      // mesmo aviso "flutuante" de sempre, visível mesmo se o modal já tiver
      // sido fechado, pra ficar óbvio que terminou e o quê aconteceu.
      setWallpaper(wp).catch((err) => console.error('[steamcmd-auto-aplicar]', err));
      setWsStatus('✅ Baixado via SteamCMD e aplicado!', wp.name || '', 1, '#4caf50');
      setTimeout(() => { hideWsStatus(); }, 5000);
    }
    if (dlActive) {
      document.getElementById('dl-loading-title').textContent = 'Concluído!';
      dlFill.style.width = '100%';
      dlText.textContent = 'Instalando wallpaper...';
      setTimeout(() => { dlScreen.classList.remove('visible'); }, 1500);
    }
  } else if (data.state === 'error') {
    if (dlActive) dlScreen.classList.remove('visible');
  }
  // 'error' já é refletido no texto de retorno do ipc('steamcmd-download-item')
  // acima — este evento também loga na aba Log (main.js), sem duplicar aqui.
});

ipcRenderer.on('download-progress', async (_, data) => {
  const dlScreen = document.getElementById('dl-loading-screen');
  const dlTitle = document.getElementById('dl-loading-title');
  const dlSubtitle = document.getElementById('dl-loading-subtitle');
  const dlFill = document.getElementById('dl-progress-fill');
  const dlText = document.getElementById('dl-progress-text');

  if (data.state === 'preparing') {
    dlTitle.textContent = 'Aplicando wallpaper';
    dlSubtitle.textContent = data.name;
    dlFill.style.width = '0%';
    dlText.textContent = 'Iniciando...';
    dlScreen.classList.add('visible');
    setWsStatus(`⏳ ${data.name}`);
    armDlUnstickButton();
  } else if (data.state === 'start') {
    dlTitle.textContent = 'Aplicando wallpaper';
    dlSubtitle.textContent = data.name;
    dlFill.style.width = '2%';
    dlText.textContent = '0% (Conectando...)';
    dlScreen.classList.add('visible');
    setWsStatus(`📥 Baixando: ${data.name}`, '', 0.02);
    armDlUnstickButton();
  } else if (data.state === 'progress') {
    const pct = data.pct || 0;
    const pctInt = Math.round(pct * 100);
    const size = data.total > 0
      ? `${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`
      : '';
    const spd = data.speed > 1024 ? `${formatBytes(data.speed)}/s` : '';
    
    dlFill.style.width = `${pctInt}%`;
    dlText.textContent = `${pctInt}% - ${spd} (${size})`;
    setWsStatus(`📥 ${pctInt}%  ${size}`, spd, pct);
  } else if (data.state === 'completed') {
    disarmDlUnstickButton();
    dlTitle.textContent = `Concluído!`;
    dlFill.style.width = '100%';
    dlText.textContent = 'Instalando wallpaper...';

    setWsStatus('✅ Download concluído!', 'Wallpaper adicionado à biblioteca.', 1, '#4caf50');
    setTimeout(() => { hideWsStatus(); }, 5000);
    _slPending = null;
    const wp = data.wallpaper;
    if (wp && !library.some(w => w.id === wp.id)) {
      library.push(wp);
      renderLibrary();
    }
    
    // Auto-aplicar
    if (wp) {
      setWallpaper(wp).catch((err) => console.error('[auto-aplicar]', err));
    }
    
    setTimeout(() => {
      dlScreen.classList.remove('visible');
    }, 1500);
  } else if (data.state === 'needs-login') {
    disarmDlUnstickButton();
    dlScreen.classList.remove('visible');
    hideWsStatus();
    _slPending = { workshopId: data.workshopId, name: data.name, previewUrl: data.previewUrl };
    const previewImg  = document.getElementById('sl-preview-img');
    const previewWrap = document.getElementById('sl-preview-wrap');
    if (data.previewUrl) {
      previewImg.src = data.previewUrl;
      previewWrap.style.display = 'block';
    } else {
      previewWrap.style.display = 'none';
    }
    document.getElementById('modal-steam-login').classList.add('open');
  } else if (data.state === 'needs-2fa') {
    _slPending = { workshopId: data.workshopId, name: data.name, previewUrl: data.previewUrl };
    document.getElementById('sl-2fa-wrap').style.display = 'block';
    document.getElementById('sl-2fa').value = '';
    document.getElementById('modal-steam-login').classList.add('open');
  } else if (data.state === 'needs-mobile-auth') {
    setWsStatus('📱 Aprove o login no aplicativo da Steam no celular...', '', null, '#ff9800');
  } else if (data.state === 'error') {
    disarmDlUnstickButton();
    document.getElementById('dl-loading-screen').classList.remove('visible');
    setWsStatus('❌ ' + data.msg, '', null, '#f44336');
    setTimeout(() => { hideWsStatus(); }, 8000);
  }
});

// ---- Aba Descobrir (FYNIX) ----
let discoverFeedPage = 1;
let discoverFeedHasMore = false;
let discoverFeedLoading = false;
let discoverSearchQuery = '';
let discoverTagFilter = '';
let discoverDefaultSort = 'mostrecent'; // trocado pelos atalhos "Em alta"/"Mais recentes" da sidebar

// Compartilhado pela busca por texto (Enter) e pelos chips de Categorias:
// esconde a Hero/Populares/Mais Baixados/Categorias e faz o feed de baixo
// mostrar só o filtro ativo. tag e search são mutuamente exclusivos —
// aplicar um limpa o outro.
function applyDiscoverFilter({ search = '', tag = '', label = '' } = {}) {
  discoverSearchQuery = search;
  discoverTagFilter = tag;
  const browseSections = document.getElementById('discover-browse-sections');
  const active = !!(search || tag);
  if (browseSections) browseSections.style.display = active ? 'none' : '';

  const title = document.getElementById('discover-feed-title');
  const sortLabel = discoverDefaultSort === 'trend' ? 'Em alta' : discoverDefaultSort === 'toprated' ? 'Mais baixados' : 'Explorar mais';
  if (title) title.textContent = label || (search ? `Resultados para "${search}"` : sortLabel);

  const searchInput = document.getElementById('discover-search-input');
  if (searchInput && !search) searchInput.value = '';

  document.querySelectorAll('.filter-pills .pill').forEach((chip) => {
    const chipTag = chip.dataset.tag || '', chipSearch = chip.dataset.search || '';
    if (chip.dataset.clear === '1') { chip.classList.toggle('active', !active); return; }
    chip.classList.toggle('active', (!!tag && chipTag === tag) || (!!search && chipSearch === search));
  });

  if (active) document.querySelectorAll('.nav-item-sm[data-discover-sort]').forEach((i) => i.classList.remove('active'));

  loadDiscoverFeed(1, false);
}

function initCategoryChips() {
  document.querySelectorAll('.filter-pills .pill').forEach((chip) => {
    if (chip.dataset.wired) return;
    chip.dataset.wired = '1';
    chip.addEventListener('click', () => {
      if (chip.dataset.clear === '1') { applyDiscoverFilter({}); return; }
      const tag = chip.dataset.tag || '';
      const search = chip.dataset.search || '';
      // Clicar de novo no chip/pill já ativo limpa o filtro e volta pro normal.
      if ((tag && discoverTagFilter === tag) || (search && discoverSearchQuery === search)) {
        applyDiscoverFilter({});
        return;
      }
      applyDiscoverFilter({ tag, search, label: `Resultados de "${chip.textContent}"` });
    });
  });
}

// Enter "confirma" a busca: some com a Hero/Populares/Mais Baixados/Categorias
// e o feed de baixo vira só os resultados. Digitando (sem apertar Enter)
// só mostra uma prévia em caixinha embaixo do campo, sem mexer no resto da
// página — a prévia usa a mesma busca por texto da Steam, só que limitada
// a poucos itens pra ficar rápida.
function initDiscoverSearch() {
  const input = document.getElementById('discover-search-input');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  const dropdown = document.getElementById('discover-search-dropdown');

  let debounceTimer;
  let previewToken = 0;

  function closeDropdown() {
    if (dropdown) { dropdown.classList.remove('open'); dropdown.innerHTML = ''; }
  }

  function commitSearch(query) {
    closeDropdown();
    applyDiscoverFilter({ search: query });
  }

  async function updatePreview(query) {
    if (!dropdown) return;
    const myToken = ++previewToken;
    dropdown.innerHTML = '<div class="discover-search-dropdown-loading">Buscando...</div>';
    dropdown.classList.add('open');
    try {
      const res = await ipc('browse-workshop', { sort: 'textsearch', search: query, page: 1 });
      if (myToken !== previewToken) return; // usuário já digitou algo mais novo — descarta essa resposta
      const items = (res.items || []).slice(0, 6);
      if (!items.length) {
        dropdown.innerHTML = '<div class="discover-search-dropdown-empty">Nenhum resultado encontrado.</div>';
        return;
      }
      dropdown.innerHTML = '';
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'discover-search-dropdown-item';
        row.innerHTML = `
          <img src="${item.preview || ''}" loading="lazy" />
          <div style="min-width:0;flex:1;">
            <div class="discover-search-dropdown-item-title">${item.title}</div>
            <div class="discover-search-dropdown-item-meta">${WA_TYPE_LABELS[item.waType] || 'Desconhecido'}</div>
          </div>
        `;
        row.addEventListener('mousedown', (e) => e.preventDefault()); // evita o blur do input roubar o clique
        row.addEventListener('click', () => {
          closeDropdown();
          showWallpaperModal(item);
        });
        dropdown.appendChild(row);
      }
      const seeAll = document.createElement('div');
      seeAll.className = 'discover-search-dropdown-seeall';
      seeAll.textContent = 'Ver todos os resultados ↵';
      seeAll.addEventListener('mousedown', (e) => e.preventDefault());
      seeAll.addEventListener('click', () => commitSearch(query));
      dropdown.appendChild(seeAll);
    } catch (_) {
      if (myToken !== previewToken) return;
      dropdown.innerHTML = '<div class="discover-search-dropdown-empty">Erro ao buscar.</div>';
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (!query) {
      // Campo limpo: some com a caixinha e restaura a página normal na hora,
      // sem esperar Enter.
      closeDropdown();
      if (discoverSearchQuery) commitSearch('');
      return;
    }
    debounceTimer = setTimeout(() => updatePreview(query), 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      commitSearch(input.value.trim());
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  input.addEventListener('blur', () => {
    // Delay curto pra não fechar antes do "mousedown" de um item processar.
    setTimeout(closeDropdown, 150);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim() && dropdown && dropdown.innerHTML) dropdown.classList.add('open');
  });
}

async function loadDiscoverTab() {
  initDiscoverSearch();
  initCategoryChips();

  const popGrid = document.getElementById('discover-popular-grid');
  const topGrid = document.getElementById('discover-toprated-grid');
  if (!popGrid || !topGrid) return;

  try {
    const popRes = await ipc('browse-workshop', { sort: 'trend', page: 1 });
    const topRes = await ipc('browse-workshop', { sort: 'toprated', page: 1 });
    
    // Busca o ID exato da arte Aeolian by WLOP para o destaque principal
    const heroRes = await ipc('get-workshop-details', ['1289832516']);
    
    renderDiscoverGrid(popGrid, popRes.items ? popRes.items.slice(0, 5) : []);
    renderDiscoverGrid(topGrid, topRes.items ? topRes.items.slice(0, 5) : []);
    
    if (heroRes.items && heroRes.items.length > 0) {
      updateHeroSection(heroRes.items[0]);
    } else if (popRes.items && popRes.items.length > 0) {
      updateHeroSection(popRes.items[0]);
    }
    
    // Inicia o grid infinito de exploracao
    loadDiscoverFeed(1, false);
  } catch (err) {
    popGrid.innerHTML = '<div style="grid-column:1/-1;color:var(--danger);text-align:center">Erro ao carregar wallpapers da Steam.</div>';
    topGrid.innerHTML = '<div style="grid-column:1/-1;color:var(--danger);text-align:center">Erro ao carregar wallpapers da Steam.</div>';
  }
}

async function loadDiscoverFeed(page = 1, append = false) {
  const feedGrid = document.getElementById('discover-feed-grid');
  const feedFooter = document.getElementById('discover-feed-footer');
  if (!feedGrid || !feedFooter) return;

  if (append) {
    if (discoverFeedLoading || !discoverFeedHasMore) return;
    discoverFeedLoading = true;
    feedFooter.textContent = '⏳ Carregando mais wallpapers...';
  } else {
    feedGrid.innerHTML = '';
    discoverFeedLoading = true;
    feedFooter.textContent = '⏳ Carregando wallpapers...';
  }
  
  discoverFeedPage = page;
  
  try {
    // Usamos 'mostrecent' (Mais recentes) ao invés de 'trend' para garantir scroll verdadeiramente infinito
    // — exceto com um filtro ativo: 'textsearch' pra busca por texto (relevância),
    // 'trend' pra tag de categoria (não há "relevância" pra ordenar tag sozinha).
    const params = discoverTagFilter
      ? { sort: 'trend', tag: discoverTagFilter, page: discoverFeedPage }
      : discoverSearchQuery
      ? { sort: 'textsearch', search: discoverSearchQuery, page: discoverFeedPage }
      : { sort: discoverDefaultSort, page: discoverFeedPage };
    const res = await ipc('browse-workshop', params);
    discoverFeedLoading = false;
    
    if (res.error) {
       feedFooter.textContent = '❌ Erro ao carregar mais.';
       return;
    }
    
    // Na primeira página, ignoramos os primeiros que talvez já estejam lá em cima (opcional para mostrecent, mas mantemos por segurança)
    let itemsToRender = res.items || [];

    // hasMore vem calculado no main.js a partir do tamanho da página CRUA da
    // Steam, não da quantidade de itens já filtrada aqui — uma página com
    // muita cena filtrada (comum, ver project_workshop_search_completeness)
    // ainda pode ter mais vídeo/web nas páginas seguintes, mesmo que esta
    // página em si tenha rendido poucos itens depois do filtro.
    discoverFeedHasMore = !!res.hasMore;
    renderDiscoverGrid(feedGrid, itemsToRender, append);
    
    feedFooter.textContent = discoverFeedHasMore ? '' : 'Fim dos resultados.';
  } catch (err) {
    discoverFeedLoading = false;
    feedFooter.textContent = '❌ Erro ao carregar mais.';
  }
}

// Scroll Infinito para aba Descobrir
const discoverMain = document.querySelector('.discover-main');
if (discoverMain) {
  discoverMain.addEventListener('scroll', () => {
    if (discoverFeedLoading || !discoverFeedHasMore) return;
    const { scrollTop, scrollHeight, clientHeight } = discoverMain;
    if (scrollTop + clientHeight >= scrollHeight - 400) {
      loadDiscoverFeed(discoverFeedPage + 1, true);
    }
  });
}

function renderDiscoverGrid(container, items, append = false) {
  if (!append) container.innerHTML = '';
  if (items.length === 0 && !append) {
    container.innerHTML = '<div style="grid-column:1/-1;color:var(--text2);text-align:center">Nenhum resultado encontrado.</div>';
    return;
  }
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'wp-card';
    card.title = item.title;
    const typeLabel = WA_TYPE_LABELS[item.waType] || 'Desconhecido';
    const installedBadge = isInstalled(item) ? '<div class="wp-card-installed-badge">✓ Instalado</div>' : '';
    // Vídeo: mesmo waType já calculado a partir da tag real "video" do
    // próprio item (ver inferWaType em main.js) — não é um chute visual.
    const videoBadge = item.waType === 'video'
      ? '<div class="wp-card-video-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>'
      : '';
    // "4K" só aparece se a própria Steam já marcou o item com uma tag de
    // resolução real (ex: "4K" ou "3840 x 2160") — nunca inventado aqui.
    const resTag = (item.tags || []).find(t => /4k/i.test(t) || /^\d{3,4}\s*x\s*\d{3,4}$/i.test(t));
    const resBadge = resTag ? `<div class="wp-card-res-badge">${/4k/i.test(resTag) ? '4K' : resTag}</div>` : '';
    card.innerHTML = `
      <div class="wp-card-img-wrap">${installedBadge}${videoBadge}${resBadge}<img src="${item.preview || ''}" loading="lazy" /></div>
      <div class="wp-card-info">
        <div class="wp-card-title">${item.title}</div>
        <div class="wp-card-meta">
          ${typeLabel}
          <span class="wp-card-stats">
            <span class="wp-card-views" title="Visualizações">👁 ${formatSubscribers(item.views || 0)}</span>
            <span class="wp-card-likes" title="Inscritos">♡ ${formatSubscribers(item.subscribers)}</span>
          </span>
        </div>
      </div>
    `;
    card.addEventListener('click', () => {
      showWallpaperModal(item);
    });
    container.appendChild(card);
  });
}

function isFavorited(item) {
  const key = item.workshopId || item.id;
  return favorites.some(f => (f.workshopId || f.id) === key);
}

// Compara por workshopId (string), não por objeto — a mesma cena aparece
// com objetos diferentes na Biblioteca vs no resultado da busca da Steam.
function isInstalled(item) {
  return library.some(w => String(w.workshopId) === String(item.workshopId));
}

async function toggleFavorite(item) {
  const result = await ipc('toggle-favorite', item);
  favorites = result.favorites;
  renderFavoritesGrid();
  return result.added;
}

function updateFavStatsRow() {
  const total  = favorites.length;
  const videos = favorites.filter(f => f.waType === 'video').length;
  const scenes = favorites.filter(f => f.waType === 'scene').length;
  const totalEl = document.getElementById('fav-stat-total');
  const videoEl = document.getElementById('fav-stat-video');
  const sceneEl = document.getElementById('fav-stat-scene');
  if (totalEl) totalEl.textContent = total;
  if (videoEl) videoEl.textContent = videos;
  if (sceneEl) sceneEl.textContent = scenes;
}

function filteredFavorites() {
  let items = favorites;
  if (favTypeFilter) items = items.filter(f => f.waType === favTypeFilter);
  if (favSearchQuery) {
    const q = favSearchQuery.toLowerCase();
    items = items.filter(f => (f.title || '').toLowerCase().includes(q));
  }
  items = items.slice();
  if (favSort === 'name') items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else items.reverse(); // favorites.push() no final = mais recente é o último do array
  return items;
}

function renderFavoritesGrid() {
  const grid = document.getElementById('favorites-grid');
  if (!grid) return;
  updateFavStatsRow();

  const items = filteredFavorites();
  if (favorites.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" id="favorites-empty">
        <div class="empty-icon">🤍</div>
        <p>Nenhum favorito ainda</p>
        <small>Clique no coração de um wallpaper na Biblioteca ou na Oficina para ele aparecer aqui</small>
      </div>
    `;
    return;
  }
  if (items.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;color:var(--text2);text-align:center;padding:40px 0">Nenhum favorito encontrado.</div>';
    return;
  }
  grid.innerHTML = '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'wp-card';
    card.title = item.title;
    const typeLabel = WA_TYPE_LABELS[item.waType] || 'Desconhecido';
    const resTag = (item.tags || []).find(t => /4k/i.test(t) || /^\d{3,4}\s*x\s*\d{3,4}$/i.test(t));
    const resBadge = resTag ? `<span class="wp-card-res-inline">${/4k/i.test(resTag) ? '4K' : resTag}</span>` : '';
    card.innerHTML = `
      <div class="wp-card-img-wrap">
        <div class="wp-card-type-badge">${typeLabel}</div>
        <button class="wp-card-fav-heart" title="Remover dos favoritos">♥</button>
        <img src="${item.preview || ''}" loading="lazy" />
      </div>
      <div class="wp-card-info">
        <div class="wp-card-title">${item.title}</div>
        <div class="wp-card-meta">
          <span class="wp-card-stats">
            <span class="wp-card-views" title="Visualizações">👁 ${formatSubscribers(item.views || 0)}</span>
            <span class="wp-card-likes" title="Inscritos">♡ ${formatSubscribers(item.subscribers)}</span>
          </span>
          <span class="wp-card-fav-extra">
            ${resBadge}
            <button class="card-menu-btn" title="Mais opções">⋮</button>
            <div class="card-menu-dropdown">
              <div class="card-menu-item remove-fav">💔 Remover dos favoritos</div>
            </div>
          </span>
        </div>
      </div>
    `;

    const heartBtn = card.querySelector('.wp-card-fav-heart');
    heartBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await toggleFavorite(item);
    });

    const menuBtn = card.querySelector('.card-menu-btn');
    const menuDropdown = card.querySelector('.card-menu-dropdown');
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = menuDropdown.classList.contains('open');
      closeCardMenus();
      if (!wasOpen) { menuDropdown.classList.add('open'); menuBtn.classList.add('menu-open'); }
    });
    card.querySelector('.remove-fav').addEventListener('click', async e => {
      e.stopPropagation();
      await toggleFavorite(item);
    });

    card.addEventListener('click', e => {
      if (e.target.closest('.card-menu-dropdown') || e.target.closest('.card-menu-btn') || e.target.closest('.wp-card-fav-heart')) return;
      showWallpaperModal(item);
    });
    grid.appendChild(card);
  });
}

// ---- Favoritos: busca, filtro por tipo (stat cards clicáveis), ordenação e modo de visualização ----
const favSearchInputEl = document.getElementById('fav-search-input');
if (favSearchInputEl) {
  favSearchInputEl.addEventListener('input', e => {
    favSearchQuery = e.target.value.trim();
    renderFavoritesGrid();
  });
}
const favSortSelectEl = document.getElementById('fav-sort-select');
if (favSortSelectEl) {
  favSortSelectEl.addEventListener('change', e => {
    favSort = e.target.value;
    renderFavoritesGrid();
  });
}
document.querySelectorAll('#fav-stats-row .fav-stat-card').forEach(statCard => {
  statCard.addEventListener('click', () => {
    document.querySelectorAll('#fav-stats-row .fav-stat-card').forEach(c => c.classList.remove('active'));
    statCard.classList.add('active');
    favTypeFilter = statCard.dataset.favType || '';
    renderFavoritesGrid();
  });
});
const favGridEl = document.getElementById('favorites-grid');
const favViewGridBtn = document.getElementById('fav-view-grid');
const favViewListBtn = document.getElementById('fav-view-list');
if (favViewGridBtn && favViewListBtn && favGridEl) {
  favViewGridBtn.addEventListener('click', () => {
    favViewMode = 'grid';
    favGridEl.classList.remove('list-view');
    favViewGridBtn.classList.add('active');
    favViewListBtn.classList.remove('active');
  });
  favViewListBtn.addEventListener('click', () => {
    favViewMode = 'list';
    favGridEl.classList.add('list-view');
    favViewListBtn.classList.add('active');
    favViewGridBtn.classList.remove('active');
  });
}
const btnFavExplore = document.getElementById('btn-fav-explore');
if (btnFavExplore) {
  btnFavExplore.addEventListener('click', () => {
    const discoverNav = document.querySelector('.nav-item[data-panel="discover"]');
    if (discoverNav) discoverNav.click();
  });
}

// ==================================================================
// ---- Playlists & Rotinas ----
// ==================================================================
let plSearchQuery = '';
let plStatusFilter = '';
let plSort = 'recent';
let plActivePlaylistId = null;
let plEditingId = null;         // id da playlist em edição no modal (null = criando nova)
let plSelectedIcon = '🎵';
let plSelectedWallpaperIds = new Set();
let rtEditingId = null;         // id da rotina em edição no modal de rotina (null = criando nova)

const RT_TYPE_LABELS = {
  time: 'Horário fixo', weekly: 'Dia da semana', monthly: 'Mês do ano',
  interval: 'Intervalo', game: 'Jogo em execução', application: 'Aplicativo em execução',
};
const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function wallpaperThumbUrl(w) {
  if (!w) return null;
  if (w.preview) return toFileUrl(w.preview);
  if (w.thumbnail) return w.thumbnail;
  if (w.type === 'image') return toFileUrl(w.src);
  return null;
}

function routineSummary(routine) {
  const c = routine.config || {};
  if (routine.type === 'time') return `Horário: ${c.start}–${c.end}`;
  if (routine.type === 'weekly') return `Dias: ${(c.days || []).map(d => WEEKDAY_LABELS[d]).join(', ') || '—'}`;
  if (routine.type === 'monthly') return `Meses: ${(c.months || []).map(m => MONTH_LABELS[m]).join(', ') || '—'}`;
  if (routine.type === 'interval') return `A cada ${c.seconds}s (${c.mode === 'random' ? 'aleatório' : 'sequencial'})`;
  if (routine.type === 'game') return `Jogo: ${c.exe}`;
  if (routine.type === 'application') return `Aplicativo: ${c.exe}`;
  return routine.type;
}

function filteredPlaylists() {
  let items = playlists;
  if (plStatusFilter === 'active') items = items.filter(p => p.id === plActivePlaylistId);
  if (plStatusFilter === 'noroutine') items = items.filter(p => !routines.some(r => r.playlistId === p.id));
  if (plSearchQuery) {
    const q = plSearchQuery.toLowerCase();
    items = items.filter(p => p.name.toLowerCase().includes(q));
  }
  items = items.slice();
  if (plSort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
  else if (plSort === 'mostused') items.sort((a, b) => ((b.stats && b.stats.switchCount) || 0) - ((a.stats && a.stats.switchCount) || 0));
  else if (plSort === 'lastapplied') items.sort((a, b) => ((b.stats && b.stats.lastAppliedAt) || 0) - ((a.stats && a.stats.lastAppliedAt) || 0));
  else items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

function updatePlStatsBar() {
  const el = document.getElementById('pl-stats-text');
  if (!el) return;
  const total = playlists.length;
  const activeCount = playlists.some(p => p.id === plActivePlaylistId) ? 1 : 0;
  const parts = [`${total} playlist${total === 1 ? '' : 's'}`];
  if (activeCount) parts.push('1 ativa');
  el.textContent = parts.join(' • ');
}

function renderPlaylistsGrid() {
  const grid = document.getElementById('playlists-grid');
  const empty = document.getElementById('playlists-empty');
  if (!grid) return;
  updatePlStatsBar();

  const items = filteredPlaylists();
  grid.querySelectorAll('.playlist-card').forEach(c => c.remove());
  if (empty) empty.style.display = items.length === 0 ? 'block' : 'none';

  for (const p of items) {
    const isActive = p.id === plActivePlaylistId;
    const card = document.createElement('div');
    card.className = 'playlist-card' + (isActive ? ' active' : '');
    card.dataset.id = p.id;

    const thumbs = p.wallpaperIds.slice(0, 4).map(id => library.find(w => w.id === id)).filter(Boolean);
    const cells = [0, 1, 2, 3].map(i => {
      const w = thumbs[i];
      const url = wallpaperThumbUrl(w);
      return url
        ? `<div class="pl-collage-cell" style="background-image:url('${url}')"></div>`
        : `<div class="pl-collage-cell pl-collage-empty"></div>`;
    }).join('');

    const routineCount = routines.filter(r => r.playlistId === p.id).length;

    card.innerHTML = `
      <div class="playlist-cover">
        <div class="pl-collage">${cells}</div>
        <div class="card-active-badge">ATIVA</div>
        <div class="pl-icon-overlay" style="background:${p.color}22;color:${p.color}">${p.icon}</div>
        <button class="pl-play-btn" title="Aplicar agora">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>
        <button class="card-menu-btn" title="Mais opções">⋮</button>
        <div class="card-menu-dropdown">
          <div class="card-menu-item duplicate">⧉ Duplicar</div>
          <div class="card-menu-item delete">✕ Excluir</div>
        </div>
      </div>
      <div class="card-info">
        <div class="card-name" title="${p.name}">${p.name}</div>
        <div class="card-type">${p.wallpaperIds.length} wallpaper${p.wallpaperIds.length === 1 ? '' : 's'} • ${routineCount} rotina${routineCount === 1 ? '' : 's'}</div>
      </div>
    `;

    card.querySelector('.pl-play-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const ok = await ipc('apply-playlist-now', p.id);
      if (ok) { plActivePlaylistId = p.id; renderPlaylistsGrid(); }
    });

    const menuBtn = card.querySelector('.card-menu-btn');
    const menuDropdown = card.querySelector('.card-menu-dropdown');
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = menuDropdown.classList.contains('open');
      closeCardMenus();
      if (!wasOpen) { menuDropdown.classList.add('open'); menuBtn.classList.add('menu-open'); }
    });
    card.querySelector('.duplicate').addEventListener('click', async e => {
      e.stopPropagation();
      const copy = await ipc('duplicate-playlist', p.id);
      if (copy) { playlists.push(copy); renderPlaylistsGrid(); }
    });
    card.querySelector('.delete').addEventListener('click', async e => {
      e.stopPropagation();
      if (!await showConfirm(`Excluir a playlist "${p.name}"? As rotinas dela também serão removidas.`)) return;
      await ipc('delete-playlist', p.id);
      playlists = playlists.filter(pl => pl.id !== p.id);
      routines = routines.filter(r => r.playlistId !== p.id);
      renderPlaylistsGrid();
    });

    card.addEventListener('click', e => {
      if (e.target.closest('.card-menu-dropdown') || e.target.closest('.card-menu-btn') || e.target.closest('.pl-play-btn')) return;
      openPlaylistModal(p);
    });

    grid.appendChild(card);
  }
}

document.getElementById('pl-search-input')?.addEventListener('input', e => {
  plSearchQuery = e.target.value.trim();
  renderPlaylistsGrid();
});
document.getElementById('pl-sort-select')?.addEventListener('change', e => {
  plSort = e.target.value;
  renderPlaylistsGrid();
});
document.querySelectorAll('#pl-status-pills .pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#pl-status-pills .pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    plStatusFilter = pill.dataset.plStatus || '';
    renderPlaylistsGrid();
  });
});
document.getElementById('btn-new-playlist')?.addEventListener('click', () => openPlaylistModal(null));

ipcRenderer.on('playlist-changed', (_, { playlistId }) => {
  plActivePlaylistId = playlistId;
  renderPlaylistsGrid();
});

// ---- Modal de criar/editar playlist ----
function openPlaylistModal(playlist) {
  plEditingId = playlist ? playlist.id : null;
  plSelectedIcon = playlist ? playlist.icon : '🎵';
  plSelectedWallpaperIds = new Set(playlist ? playlist.wallpaperIds : []);

  document.getElementById('pl-modal-title').textContent = playlist ? 'Editar Playlist' : 'Nova Playlist';
  document.getElementById('pl-name').value = playlist ? playlist.name : '';
  document.getElementById('pl-description').value = playlist ? playlist.description : '';
  document.getElementById('pl-color').value = playlist ? playlist.color : '#7c3aed';

  document.querySelectorAll('#pl-icon-grid .pl-icon-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.icon === plSelectedIcon);
  });

  document.getElementById('pl-wallpaper-search').value = '';
  renderPlWallpaperPicker('');
  renderPlRoutinesList();

  document.getElementById('modal-playlist').classList.add('open');
}

document.querySelectorAll('#pl-icon-grid .pl-icon-option').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('#pl-icon-grid .pl-icon-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    plSelectedIcon = opt.dataset.icon;
  });
});

function renderPlWallpaperPicker(query) {
  const picker = document.getElementById('pl-wallpaper-picker');
  const countEl = document.getElementById('pl-wallpaper-count');
  if (!picker) return;
  const q = (query || '').toLowerCase();
  const items = library.filter(w => !q || w.name.toLowerCase().includes(q));

  picker.innerHTML = items.map(w => {
    const url = wallpaperThumbUrl(w);
    const checked = plSelectedWallpaperIds.has(w.id);
    return `
      <div class="pl-wp-item ${checked ? 'checked' : ''}" data-id="${w.id}">
        ${url ? `<img src="${url}" />` : `<div class="pl-wp-noimg">${typeIcon(w.type, w.scene)}</div>`}
        <div class="pl-wp-name" title="${w.name}">${w.name}</div>
        <div class="pl-wp-check">${checked ? '✓' : ''}</div>
      </div>`;
  }).join('') || '<div style="color:var(--text2);font-size:12px;padding:8px 0">Nenhum wallpaper na biblioteca ainda.</div>';

  picker.querySelectorAll('.pl-wp-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (plSelectedWallpaperIds.has(id)) plSelectedWallpaperIds.delete(id);
      else plSelectedWallpaperIds.add(id);
      el.classList.toggle('checked');
      el.querySelector('.pl-wp-check').textContent = plSelectedWallpaperIds.has(id) ? '✓' : '';
      if (countEl) countEl.textContent = plSelectedWallpaperIds.size;
    });
  });
  if (countEl) countEl.textContent = plSelectedWallpaperIds.size;
}
document.getElementById('pl-wallpaper-search')?.addEventListener('input', e => renderPlWallpaperPicker(e.target.value));

function renderPlRoutinesList() {
  const list = document.getElementById('pl-routines-list');
  if (!list) return;
  const items = routines.filter(r => r.playlistId === plEditingId);
  if (!plEditingId || items.length === 0) {
    list.innerHTML = '<p style="color:var(--text2);font-size:12px;padding:8px 0">' +
      (plEditingId ? 'Nenhuma rotina ainda — sem rotina, a playlist só aplica manualmente.' : 'Salve a playlist primeiro pra poder adicionar rotinas.') +
      '</p>';
    return;
  }
  list.innerHTML = '';
  items.sort((a, b) => b.priority - a.priority).forEach(r => {
    const row = document.createElement('div');
    row.className = 'time-rule-row pl-routine-row';
    row.innerHTML = `
      <label class="toggle" style="margin-right:10px"><input type="checkbox" ${r.enabled ? 'checked' : ''} class="rt-enabled-toggle" /><div class="toggle-slider"></div></label>
      <span class="tr-name" style="flex:1">${RT_TYPE_LABELS[r.type] || r.type} <span style="color:var(--text2)">— ${routineSummary(r)}</span></span>
      <span style="color:var(--text2);font-size:11px;margin-right:8px">prio ${r.priority}</span>
      <button class="card-btn rt-edit-btn" title="Editar">✎</button>
      <button class="card-btn delete rt-del-btn" title="Excluir">✕</button>
    `;
    row.querySelector('.rt-enabled-toggle').addEventListener('change', async e => {
      await ipc('set-routine-enabled', r.id, e.target.checked);
      r.enabled = e.target.checked;
    });
    row.querySelector('.rt-edit-btn').addEventListener('click', () => openRoutineModal(r));
    row.querySelector('.rt-del-btn').addEventListener('click', async () => {
      if (!await showConfirm('Excluir esta rotina?')) return;
      await ipc('delete-routine', r.id);
      routines = routines.filter(x => x.id !== r.id);
      renderPlRoutinesList();
      renderPlaylistsGrid();
    });
    list.appendChild(row);
  });
}

document.getElementById('btn-add-routine')?.addEventListener('click', () => {
  if (!plEditingId) { alert('Salve a playlist primeiro pra poder adicionar rotinas.'); return; }
  openRoutineModal(null);
});

document.getElementById('btn-pl-save')?.addEventListener('click', async () => {
  const name = document.getElementById('pl-name').value.trim();
  if (!name) { alert('Dê um nome pra playlist.'); return; }
  const payload = {
    id: plEditingId || undefined,
    name,
    description: document.getElementById('pl-description').value.trim(),
    color: document.getElementById('pl-color').value,
    icon: plSelectedIcon,
    wallpaperIds: Array.from(plSelectedWallpaperIds),
  };
  const saved = await ipc('save-playlist', payload);
  const idx = playlists.findIndex(p => p.id === saved.id);
  if (idx !== -1) playlists[idx] = saved; else playlists.push(saved);
  plEditingId = saved.id;
  renderPlaylistsGrid();
  renderPlRoutinesList();
  closeModal('modal-playlist');
});

// ---- Modal de criar/editar rotina ----
function renderRoutineConfigFields(type, config) {
  const wrap = document.getElementById('rt-config-fields');
  config = config || {};
  if (type === 'time') {
    wrap.innerHTML = `
      <div class="field"><label>Início</label><input type="time" id="rt-start" value="${config.start || '08:00'}" /></div>
      <div class="field"><label>Fim</label><input type="time" id="rt-end" value="${config.end || '18:00'}" /></div>`;
  } else if (type === 'weekly') {
    const days = config.days || [];
    wrap.innerHTML = `<div class="field"><label>Dias da semana</label><div class="rt-day-grid">${
      WEEKDAY_LABELS.map((label, i) => `<div class="rt-day-option ${days.includes(i) ? 'selected' : ''}" data-day="${i}">${label}</div>`).join('')
    }</div></div>`;
    wrap.querySelectorAll('.rt-day-option').forEach(el => el.addEventListener('click', () => el.classList.toggle('selected')));
  } else if (type === 'monthly') {
    const months = config.months || [];
    wrap.innerHTML = `<div class="field"><label>Meses</label><div class="rt-day-grid">${
      MONTH_LABELS.map((label, i) => `<div class="rt-day-option ${months.includes(i) ? 'selected' : ''}" data-month="${i}">${label}</div>`).join('')
    }</div></div>`;
    wrap.querySelectorAll('.rt-day-option').forEach(el => el.addEventListener('click', () => el.classList.toggle('selected')));
  } else if (type === 'interval') {
    wrap.innerHTML = `
      <div class="field"><label>Intervalo (segundos)</label><input type="number" id="rt-seconds" min="5" value="${config.seconds || 30}" /></div>
      <div class="field"><label>Modo</label>
        <select id="rt-mode">
          <option value="sequential" ${config.mode !== 'random' ? 'selected' : ''}>Sequencial</option>
          <option value="random" ${config.mode === 'random' ? 'selected' : ''}>Aleatório</option>
        </select>
      </div>`;
  } else if (type === 'game' || type === 'application') {
    wrap.innerHTML = `<div class="field"><label>Nome do executável</label><input type="text" id="rt-exe" placeholder="ex: valorant.exe" value="${config.exe || ''}" /></div>`;
  }
}

function readRoutineConfigFromFields(type) {
  if (type === 'time') return { start: document.getElementById('rt-start').value, end: document.getElementById('rt-end').value };
  if (type === 'weekly') return { days: Array.from(document.querySelectorAll('.rt-day-option.selected')).map(el => +el.dataset.day) };
  if (type === 'monthly') return { months: Array.from(document.querySelectorAll('.rt-day-option.selected')).map(el => +el.dataset.month) };
  if (type === 'interval') return { seconds: +document.getElementById('rt-seconds').value, mode: document.getElementById('rt-mode').value };
  if (type === 'game' || type === 'application') return { exe: document.getElementById('rt-exe').value.trim() };
  return {};
}

const DEFAULT_ROUTINE_PRIORITY = { time: 60, weekly: 50, monthly: 45, interval: 30, game: 90, application: 100 };

function openRoutineModal(routine) {
  rtEditingId = routine ? routine.id : null;
  document.getElementById('rt-playlist-id').value = plEditingId;
  document.getElementById('rt-type').value = routine ? routine.type : 'time';
  document.getElementById('rt-priority').value = routine ? routine.priority : DEFAULT_ROUTINE_PRIORITY.time;
  document.getElementById('rt-error-msg').style.display = 'none';
  renderRoutineConfigFields(routine ? routine.type : 'time', routine ? routine.config : {});
  document.getElementById('modal-routine-edit').classList.add('open');
}

document.getElementById('rt-type')?.addEventListener('change', e => {
  renderRoutineConfigFields(e.target.value, {});
  document.getElementById('rt-priority').value = DEFAULT_ROUTINE_PRIORITY[e.target.value] || 50;
});

document.getElementById('btn-rt-save')?.addEventListener('click', async () => {
  const type = document.getElementById('rt-type').value;
  const payload = {
    id: rtEditingId || undefined,
    playlistId: document.getElementById('rt-playlist-id').value,
    type,
    enabled: true,
    priority: +document.getElementById('rt-priority').value,
    config: readRoutineConfigFromFields(type),
  };
  const result = await ipc('save-routine', payload);
  const errEl = document.getElementById('rt-error-msg');
  if (!result.ok) { errEl.textContent = result.msg; errEl.style.display = 'block'; return; }
  const idx = routines.findIndex(r => r.id === result.routine.id);
  if (idx !== -1) routines[idx] = result.routine; else routines.push(result.routine);
  renderPlRoutinesList();
  renderPlaylistsGrid();
  closeModal('modal-routine-edit');
});

// ---- Picker rápido "Adicionar à Playlist" (a partir do modal de detalhes do Workshop) ----
function openAddToPlaylistPicker(item) {
  const libraryMatch = library.find(w => w.workshopId && String(w.workshopId) === String(item.workshopId));
  const list = document.getElementById('atp-list');
  if (!libraryMatch) {
    list.innerHTML = '<p style="color:var(--text2);font-size:12px;padding:8px 0">Baixe/aplique este wallpaper primeiro — ele precisa estar na sua Biblioteca pra entrar numa playlist.</p>';
  } else if (playlists.length === 0) {
    list.innerHTML = '<p style="color:var(--text2);font-size:12px;padding:8px 0">Você ainda não tem nenhuma playlist. Crie uma na aba Playlists.</p>';
  } else {
    list.innerHTML = playlists.map(p => {
      const already = p.wallpaperIds.includes(libraryMatch.id);
      return `<div class="time-rule-row pl-routine-row" data-id="${p.id}">
        <span class="tr-name" style="flex:1">${p.icon} ${p.name}</span>
        <button class="btn btn-secondary btn-xs atp-add-btn" ${already ? 'disabled' : ''}>${already ? 'Já incluída' : '+ Adicionar'}</button>
      </div>`;
    }).join('');
    list.querySelectorAll('.atp-add-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('[data-id]');
        const p = playlists.find(pl => pl.id === row.dataset.id);
        if (!p) return;
        p.wallpaperIds = p.wallpaperIds.concat(libraryMatch.id);
        await ipc('save-playlist', p);
        closeModal('modal-add-to-playlist');
        renderPlaylistsGrid();
      });
    });
  }
  document.getElementById('modal-add-to-playlist').classList.add('open');
}

function updateHeroSection(item) {
   const heroTitle = document.querySelector('.hero-title');
   const heroMeta = document.querySelector('.hero-meta');
   const heroDesc = document.querySelector('.hero-desc');
   const heroImg = document.querySelector('.hero-image');
   
   if (heroTitle) heroTitle.textContent = item.title;
   if (heroMeta) heroMeta.innerHTML = `${WA_TYPE_LABELS[item.waType] || 'Desconhecido'} &bull; ${formatSubscribers(item.subscribers)} inscritos`;
   let desc = item.description || '';
   
   if (item.workshopId === '1289832516') {
     desc = 'Uma belíssima obra de arte animada que traz paz e elegância para sua área de trabalho. Criação original por WLOP.';
   } else {
     // Remove tags BBCode tipo [b], [u], [url] da descrição original da Steam
     desc = desc.replace(/\[\/?.*?\]/g, '').replace(/https?:\/\/[^\s]+/g, '').trim();
     desc = desc.substring(0, 150) + (desc.length > 150 ? '...' : '');
   }
   
   if (heroDesc) heroDesc.textContent = desc;
   if (heroImg) heroImg.src = item.preview || '';
   
   const btn = document.querySelector('.hero-btn');
   if (btn) {
      btn.onclick = () => {
       showWallpaperModal(item);
      };
   }
}

// ---- Init ----
async function init() {
  ctrlLog('init(): início');
  try {
    [library, current, settings, allDisplays, displayWallpapers, favorites, playlists, routines] = await Promise.all([
      ipc('get-library'),
      ipc('get-current'),
      ipc('get-settings'),
      ipc('get-displays'),
      ipc('get-display-wallpapers'),
      ipc('get-favorites'),
      ipc('get-playlists'),
      ipc('get-routines'),
    ]);
    ctrlLog('init(): Promise.all dos ipc() resolveu');

    // Settings UI
    setVolume.value = settings.volume ?? 50;
    setVolumeV.textContent = (settings.volume ?? 50) + '%';
    if (libVolumeSlider) libVolumeSlider.value = settings.volume ?? 50;
    setPauseFs.checked = settings.pauseOnFullscreen ?? true;
    setPerfModeFs.checked = settings.performanceModeFullscreen ?? false;
    setMuteFs.checked  = settings.muteOnFullscreen  ?? false;
    setWebview2Compat.checked = settings.webview2CompatMode ?? false;
    setStartup.checked = settings.startWithWindows  ?? true;
    setHideTaskbar.checked = settings.hideTaskbarAndIcons ?? true;
    setAudioRe.checked = settings.audioReactive     ?? false;
    appRules = settings.appRules || [];

    // Clock overlay UI
    const co = settings.clockOverlay || {};
    clockEnabled.checked   = co.enabled     ?? false;
    clockPosition.value    = co.position    ?? 'top-left';
    clockFormat24h.checked = co.format24h   ?? true;
    clockSeconds.checked   = co.showSeconds ?? false;
    clockDate.checked      = co.showDate    ?? true;
    clockDayName.checked   = co.showDayName ?? true;
    clockColor.value       = co.color       ?? '#ffffff';
    clockFontSize.value    = co.fontSize    ?? 48;
    clockFontSizeV.textContent = (co.fontSize ?? 48) + 'px';

    renderLibrary();
    updateNowPlaying();
    renderMonitors();
    renderAppRules();
    renderPlaylistsGrid();
    ctrlLog('init(): render*() todos concluídos, chamando checkFirstRunNotice');
    checkFirstRunNotice();
    ctrlLog('init(): fim (checkFirstRunNotice é async, pode continuar depois)');
  } catch (e) {
    ctrlLog(`init(): EXCEÇÃO capturada: ${e.stack}`);
    alert('Erro crítico no init: ' + e.stack);
  }
}

async function checkFirstRunNotice() {
  ctrlLog('checkFirstRunNotice(): início, chamando should-show-we-scene-notice');
  const shouldShow = await ipc('should-show-we-scene-notice');
  ctrlLog(`checkFirstRunNotice(): shouldShow=${shouldShow}`);
  if (!shouldShow) { checkWallpaperConflictNotice(); return; }

  const modal = document.getElementById('modal-first-run-notice');
  const btn = document.getElementById('btn-first-run-notice-close');
  modal.classList.add('open');
  ctrlLog('checkFirstRunNotice(): modal aberto, iniciando contagem de 3s');

  let secondsLeft = 3;
  btn.textContent = `Entendi (${secondsLeft})`;
  const countdown = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      clearInterval(countdown);
      btn.textContent = 'Entendi';
      btn.disabled = false;
      ctrlLog('checkFirstRunNotice(): botão Entendi liberado');
    } else {
      btn.textContent = `Entendi (${secondsLeft})`;
    }
  }, 1000);

  btn.addEventListener('click', async () => {
    ctrlLog('checkFirstRunNotice(): botão Entendi CLICADO');
    closeModal('modal-first-run-notice');
    const optOut = document.getElementById('chk-first-run-notice-optout')?.checked;
    if (optOut) await ipc('set-we-scene-notice-optout');
    checkWallpaperConflictNotice();
  }, { once: true });
}

// Encadeado depois do aviso de cenas do Workshop (ver checkFirstRunNotice) —
// só existe conteúdo pra mostrar se main.js's checkConflictingWallpaperApps()
// realmente detectou outro gerenciador de wallpaper (Lively, Wallpaper
// Engine) rodando junto no boot (ver [[project_workerw_fragility]]: dois
// apps brigando pelo mesmo truque de embutir atrás do desktop deixava este
// app com aparência de travado). IPC retorna null quando não há conflito ou
// o usuário já pediu pra não ver mais.
async function checkWallpaperConflictNotice() {
  const names = await ipc('should-show-wallpaper-conflict-notice');
  if (!names) return;

  const modal = document.getElementById('modal-wallpaper-conflict-notice');
  const btn = document.getElementById('btn-wallpaper-conflict-notice-close');
  const namesEl = document.getElementById('wallpaper-conflict-names');
  if (namesEl) namesEl.textContent = names;
  modal.classList.add('open');

  btn.addEventListener('click', async () => {
    closeModal('modal-wallpaper-conflict-notice');
    const optOut = document.getElementById('chk-wallpaper-conflict-notice-optout')?.checked;
    if (optOut) await ipc('set-wallpaper-conflict-notice-optout');
  }, { once: true });
}

// Checagem de atualização (main.js's checkForUpdates, GitHub Releases) —
// dois caminhos pro mesmo resultado: 'update-available' chega via push se a
// checagem em background terminar com a janela já aberta, ou puxamos direto
// aqui no boot (get-update-info) caso ela já tivesse rodado antes da janela
// existir. Qualquer um dos dois preenche o mesmo card no rodapé da sidebar.
let _pendingUpdateVersion = null;
function showUpdateBanner(info) {
  if (!info) return;
  _pendingUpdateVersion = info.version;
  const banner = document.getElementById('update-banner');
  const versionEl = document.getElementById('update-banner-version');
  const btn = document.getElementById('update-banner-download');
  if (versionEl) versionEl.textContent = `v${info.version}`;
  banner.style.display = 'flex';

  const resetButton = () => {
    btn.disabled = false;
    btn.textContent = info.assetUrl ? 'Atualizar agora' : 'Baixar';
  };
  resetButton();

  btn.onclick = () => {
    if (!info.assetUrl) { shell.openExternal(info.url); return; }
    btn.disabled = true;
    btn.textContent = 'Baixando...';
    ipc('apply-update').then((res) => {
      if (res && res.ok) return; // app já vai fechar e reabrir sozinho
      // Sem asset anexado nesta release, ou algo deu errado — cai pro link manual.
      resetButton();
      shell.openExternal(info.url);
    });
  };

  document.getElementById('update-banner-dismiss').onclick = async () => {
    banner.style.display = 'none';
    await ipc('dismiss-update-notice', info.version);
  };
}
ipcRenderer.on('update-available', (_e, info) => showUpdateBanner(info));
ipc('get-update-info').then(showUpdateBanner);

// Status da checagem de atualização, visível na tela "Sobre" — sem isso, uma
// checagem quebrada (repo errado, rede fora, API do GitHub com problema) fica
// invisível pra sempre na build empacotada, que não tem console visível.
function refreshUpdateCheckStatus() {
  const statusEl = document.getElementById('about-update-status');
  if (!statusEl) return;
  ipc('get-update-check-status').then((status) => {
    if (!status || !status.time) { statusEl.textContent = 'Ainda não checou nesta sessão'; return; }
    const when = new Date(status.time).toLocaleString('pt-BR');
    statusEl.textContent = status.ok
      ? `OK — última checagem em ${when} (${status.repo})`
      : `Falhou em ${when}: ${status.error} (${status.repo})`;
  });
}
refreshUpdateCheckStatus();
document.getElementById('btn-check-updates-now')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checando...';
  await ipc('force-check-updates');
  refreshUpdateCheckStatus();
  btn.disabled = false;
  btn.textContent = 'Checar agora';
});

// "O que mudou" desde a última vez que o usuário abriu o app — pedido
// explícito pra não deixar mudanças acontecendo "caladas". Só aparece uma
// vez por versão (main.js já filtra instalação nova e versão já vista).
ipc('get-whats-new').then((info) => {
  if (!info) return;
  const banner = document.getElementById('whatsnew-banner');
  const textEl = document.getElementById('whatsnew-banner-text');
  if (!banner || !textEl) return;
  textEl.textContent = info.text;
  banner.style.display = 'flex';
  document.getElementById('whatsnew-banner-dismiss').onclick = async () => {
    banner.style.display = 'none';
    await ipc('mark-whats-new-seen', info.version);
  };
});
// Antes disso, o único sinal de que uma atualização estava acontecendo era
// o texto de um botão pequeno na sidebar — que some assim que a janela
// fecha pra trocar de versão, dando a impressão de "só uma tela preta"
// (pedido explícito do usuário pra melhorar). Reusa a mesma tela cheia
// roxa de sempre (dl-loading-screen), com progresso real de bytes baixados.
ipcRenderer.on('update-apply-progress', (_e, data) => {
  const btn = document.getElementById('update-banner-download');
  const dlScreen = document.getElementById('dl-loading-screen');
  const dlFill = document.getElementById('dl-progress-fill');
  const dlText = document.getElementById('dl-progress-text');

  if (data.status === 'downloading') {
    if (btn) btn.textContent = 'Baixando...';
    document.getElementById('dl-loading-title').textContent = 'Atualizando o app';
    document.getElementById('dl-loading-subtitle').textContent = _pendingUpdateVersion ? `Versão ${_pendingUpdateVersion}` : '';
    dlScreen.classList.add('visible');
    if (data.pct !== null && data.pct !== undefined) {
      const pctInt = Math.round(data.pct * 100);
      dlFill.style.width = pctInt + '%';
      dlText.textContent = `${pctInt}% (${formatBytes(data.received)} / ${formatBytes(data.total)})`;
    } else {
      dlFill.style.width = '15%';
      dlText.textContent = 'Baixando...';
    }
  } else if (data.status === 'restarting') {
    if (btn) btn.textContent = 'Reiniciando...';
    document.getElementById('dl-loading-title').textContent = 'Quase lá!';
    dlFill.style.width = '100%';
    dlText.textContent = 'Reiniciando o app...';
  } else if (data.status === 'error') {
    if (btn) { btn.disabled = false; btn.textContent = 'Atualizar agora'; }
    dlScreen.classList.remove('visible');
    setWsStatus('❌ Falha ao atualizar: ' + (data.message || 'erro desconhecido'), '', null, '#c0392b');
    setTimeout(hideWsStatus, 6000);
  }
});

document.getElementById('btn-sync-steam')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync-steam');
  const oldText = btn.innerHTML;
  btn.innerHTML = 'Sincronizando...';
  btn.disabled = true;
  try {
    const res = await ipc('sync-steam-desktop');
    if (res.error) {
      alert('Erro ao sincronizar: ' + res.error);
    } else if (res.count === 0) {
      alert('Nenhum wallpaper novo encontrado na pasta da Steam. Você já tem todos ou ainda não se inscreveu em nenhum!');
    } else {
      alert(`Sincronização concluída! ${res.count} novo(s) wallpaper(s) importado(s).`);
      library = await ipc('get-library');
      renderLibrary();
    }
  } catch (e) {
    alert('Erro: ' + e.message);
  } finally {
    btn.innerHTML = oldText;
    btn.disabled = false;
  }
});

// Tela de carregamento cheia na abertura do app — fica visível até a
// biblioteca local (rápida) e a vitrine da Steam (mais lenta, depende de
// rede) estarem prontas, em vez de mostrar a UI "pronta" com pedaços ainda
// carregando por baixo. Nunca trava pra sempre: se a Steam demorar ou
// estiver fora do ar, libera a UI mesmo assim depois de um tempo razoável —
// as seções específicas continuam com seu próprio aviso local até resolverem.
async function boot() {
  const overlay = document.getElementById('app-loading-overlay');
  const message = document.getElementById('app-loading-message');
  const hideOverlay = () => { if (overlay) overlay.classList.add('hidden'); };
  const safetyTimeout = setTimeout(hideOverlay, 10000);

  await init();
  if (message) message.textContent = 'Carregando vitrine da Steam...';
  try {
    await loadDiscoverTab();
  } catch (_) { /* loadDiscoverTab já trata seus próprios erros internamente */ }

  clearTimeout(safetyTimeout);
  hideOverlay();
}

boot();
