const { ipcRenderer } = require('electron');

async function ipc(channel, ...args) { return ipcRenderer.invoke(channel, ...args); }

// ---- State ----
let library          = [];
let current          = null;
let selectedScene    = 'particles';
let playlistConfig   = {};
let settings         = {};
let allDisplays      = [];
let displayWallpapers = {};
let targetDisplayId  = null;   // null = all displays
let timeRules        = [];
let searchQuery      = '';
let propsWallpaper   = null;   // wallpaper being edited in props modal

// ---- Navigation ----
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('panel-' + item.dataset.panel).classList.add('active');
  });
});

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
  if (!searchQuery) return library;
  const q = searchQuery.toLowerCase();
  return library.filter(w => w.name.toLowerCase().includes(q) || typeName(w.type, w.scene).toLowerCase().includes(q));
}

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
    if (w.thumbnail) {
      thumbHtml = `<img class="card-thumb-img" src="${w.thumbnail}" />`;
    } else if (w.type === 'image') {
      thumbHtml = `<img class="card-thumb-img" src="${toFileUrl(w.src)}" />`;
    } else {
      thumbHtml = `<div class="card-thumb">${typeIcon(w.type, w.scene)}</div>`;
    }

    const hasProps = (w.type === 'scene' || w.type === 'video');

    card.innerHTML = `
      <div class="card-active-badge">ATIVO</div>
      <div class="card-thumb-wrap">${thumbHtml}</div>
      <div class="card-info">
        <div class="card-name" title="${w.name}">${w.name}</div>
        <div class="card-type">${typeName(w.type, w.scene)}</div>
      </div>
      <div class="card-actions">
        ${hasProps ? '<button class="card-btn props" title="Propriedades">⚙</button>' : ''}
        <button class="card-btn delete" title="Remover">✕</button>
      </div>
    `;

    card.addEventListener('click', e => {
      if (e.target.classList.contains('delete')) { removeWallpaper(w.id); return; }
      if (e.target.classList.contains('props'))  { openProps(w); return; }
      setWallpaper(w);
    });

    grid.appendChild(card);
  }
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
  await ipc('remove-wallpaper', id);
  library = library.filter(w => w.id !== id);
  if (current && current.id === id) { current = null; updateNowPlaying(); }
  timeRules = timeRules.filter(r => r.wallpaperId !== id);
  await ipc('set-time-rules', timeRules);
  renderLibrary();
  renderTimeRules();
}

// ---- Search ----
document.getElementById('search-input').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  renderLibrary();
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

function openProps(w) {
  propsWallpaper = w;
  document.getElementById('props-title').textContent = `Propriedades — ${w.name}`;
  const fields = document.getElementById('props-fields');
  fields.innerHTML = '';

  let defs = [];
  if (w.type === 'scene') defs = SCENE_FIELDS[w.scene] || [];
  if (w.type === 'video') defs = [{ key: 'volume', label: 'Volume (%)', type: 'range', def: 50, min: 0, max: 100, step: 1 }];

  if (!defs.length) { fields.innerHTML = '<p style="color:var(--text2);font-size:13px">Sem propriedades configuráveis.</p>'; }

  for (const f of defs) {
    const opts = w.options || {};
    const val  = opts[f.key] !== undefined ? opts[f.key] : f.def;
    const row  = document.createElement('div');
    row.className = 'field';

    if (f.type === 'color') {
      row.innerHTML = `<label>${f.label}</label><div class="color-row"><input type="color" id="pf-${f.key}" value="${val}" /><span class="color-hex" id="pf-${f.key}-hex">${val}</span></div>`;
      setTimeout(() => {
        const inp = row.querySelector(`#pf-${f.key}`);
        const hex = row.querySelector(`#pf-${f.key}-hex`);
        inp.addEventListener('input', () => { hex.textContent = inp.value; });
      });
    } else if (f.type === 'range') {
      row.innerHTML = `<label>${f.label} <span class="range-val" id="pf-${f.key}-val" style="float:right">${val}</span></label><input type="range" id="pf-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}" />`;
      setTimeout(() => {
        const inp = row.querySelector(`#pf-${f.key}`);
        const lbl = row.querySelector(`#pf-${f.key}-val`);
        inp.addEventListener('input', () => { lbl.textContent = (+inp.value).toFixed(f.step < 1 ? 1 : 0); });
      });
    } else if (f.type === 'select') {
      const options = f.opts.map((o, i) => `<option value="${o}" ${o === val ? 'selected' : ''}>${f.optLabels[i]}</option>`).join('');
      row.innerHTML = `<label>${f.label}</label><select id="pf-${f.key}">${options}</select>`;
    }
    fields.appendChild(row);
  }

  document.getElementById('modal-props').classList.add('open');
}

document.getElementById('btn-props-save').addEventListener('click', async () => {
  if (!propsWallpaper) return;
  const w   = { ...propsWallpaper };
  const defs = w.type === 'scene' ? (SCENE_FIELDS[w.scene] || []) : [{ key: 'volume', type: 'range' }];
  const opts = { ...(w.options || {}) };

  for (const f of defs) {
    const el = document.getElementById(`pf-${f.key}`);
    if (!el) continue;
    opts[f.key] = f.type === 'range' ? +el.value : el.value;
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

// ---- Playlist ----
const plEnabled     = document.getElementById('pl-enabled');
const plInterval    = document.getElementById('pl-interval');
const plIntervalVal = document.getElementById('pl-interval-val');
const plShuffle     = document.getElementById('pl-shuffle');

function formatInterval(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'min';
  return Math.floor(s / 3600) + 'h';
}
plInterval.addEventListener('input', () => { plIntervalVal.textContent = formatInterval(+plInterval.value); });

async function savePlaylist() {
  playlistConfig = { enabled: plEnabled.checked, interval: +plInterval.value, shuffle: plShuffle.checked };
  await ipc('set-playlist-config', playlistConfig);
}
plEnabled.addEventListener('change', savePlaylist);
plInterval.addEventListener('change', savePlaylist);
plShuffle.addEventListener('change', savePlaylist);

// ---- Settings ----
const setVolume  = document.getElementById('set-volume');
const setVolumeV = document.getElementById('set-volume-val');
const setPauseFs = document.getElementById('set-pause-fs');
const setMuteFs  = document.getElementById('set-mute-fs');
const setStartup = document.getElementById('set-startup');

setVolume.addEventListener('input', () => { setVolumeV.textContent = setVolume.value + '%'; });

async function saveSettings() {
  settings = { volume: +setVolume.value, pauseOnFullscreen: setPauseFs.checked, muteOnFullscreen: setMuteFs.checked, startWithWindows: setStartup.checked };
  await ipc('set-settings', settings);
}
[setVolume, setPauseFs, setMuteFs, setStartup].forEach(el => el.addEventListener('change', saveSettings));

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

// ---- Time Rules ----
function renderTimeRules() {
  const list = document.getElementById('time-rules-list');
  list.innerHTML = '';
  if (!timeRules.length) {
    list.innerHTML = '<p style="color:var(--text2);font-size:12px;padding:8px 0">Nenhuma regra configurada</p>';
    return;
  }
  const sorted = [...timeRules].sort((a, b) => a.time.localeCompare(b.time));
  for (const rule of sorted) {
    const wp = library.find(w => w.id === rule.wallpaperId);
    const row = document.createElement('div');
    row.className = 'time-rule-row';
    row.innerHTML = `
      <span class="tr-time">${rule.time}</span>
      <span class="tr-arrow">→</span>
      <span class="tr-name">${wp ? wp.name : '(removido)'}</span>
      <button class="card-btn delete tr-del" data-id="${rule.id}">✕</button>
    `;
    row.querySelector('.tr-del').addEventListener('click', async () => {
      timeRules = timeRules.filter(r => r.id !== rule.id);
      await ipc('set-time-rules', timeRules);
      renderTimeRules();
    });
    list.appendChild(row);
  }
}

document.getElementById('btn-add-time-rule').addEventListener('click', () => {
  const sel = document.getElementById('tr-wallpaper');
  sel.innerHTML = library.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
  document.getElementById('modal-time-rule').classList.add('open');
});

document.getElementById('btn-tr-add').addEventListener('click', async () => {
  const time       = document.getElementById('tr-time').value;
  const wallpaperId = document.getElementById('tr-wallpaper').value;
  if (!time || !wallpaperId) return;
  const rule = { id: Date.now().toString(), time, wallpaperId };
  timeRules.push(rule);
  await ipc('set-time-rules', timeRules);
  renderTimeRules();
  closeModal('modal-time-rule');
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
    // WE Scene (.pkg) can't be rendered — import as static image using its preview
    const importType = wp.type === 'scene' ? 'image' : wp.type;
    const w = await ipc('add-wallpaper', { type: importType, name: wp.name, src: wp.src, thumbnail, steamId: wp.workshopId });
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

// ---- Listen for events from main ----
ipcRenderer.on('wallpaper-changed', (_, w) => {
  current = w;
  renderLibrary();
  updateNowPlaying();
});

// ---- Workshop Store ----
const wsGrid   = document.getElementById('ws-grid');
const wsSearch = document.getElementById('ws-search');
const wsSort   = document.getElementById('ws-sort');
const wsRefresh = document.getElementById('ws-refresh');
const wsStatus = document.getElementById('ws-status-bar');

let wsCurrentPage = 1;
let wsItems = [];

async function loadWorkshopItems(page = 1, append = false) {
  if (!append) {
    wsGrid.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Carregando wallpapers...</p></div>';
    wsItems = [];
  } else {
    document.getElementById('ws-load-more')?.remove();
  }
  wsCurrentPage = page;

  const result = await ipc('browse-workshop', {
    sort: wsSort.value,
    search: wsSearch.value.trim(),
    page,
  });

  if (result.error) {
    wsGrid.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><p>Erro ao carregar</p><small>${result.error}</small></div>`;
    return;
  }

  const newItems = result.items;
  wsItems = append ? [...wsItems, ...newItems] : newItems;
  renderWorkshopGrid(append ? newItems : null);
}

function renderWorkshopGrid(appendItems = null) {
  if (wsItems.length === 0) {
    wsGrid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>Nenhum wallpaper encontrado</p><small>Tente outra busca ou filtro</small></div>';
    return;
  }

  const itemsToRender = appendItems || wsItems;
  if (!appendItems) wsGrid.innerHTML = '';

  itemsToRender.forEach(item => {
    const card = document.createElement('div');
    card.className = 'ws-card-new';
    card.dataset.wsid = item.workshopId;
    card.title = `${item.title}\n${item.tags.join(', ')}\n${item.subscribers} inscritos`;
    card.innerHTML = `
      ${item.preview ? `<img class="ws-card-img" src="${item.preview}" loading="lazy" />` : '<div style="width:100%;height:100%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:24px">🌐</div>'}
      <div class="ws-card-overlay"></div>
      <div class="ws-card-stats">
        <div class="ws-dl-count">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          ${formatSubscribers(item.subscribers)}
        </div>
        <div class="ws-heart">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
        </div>
      </div>
    `;
    card.addEventListener('click', () => {
      document.querySelectorAll('.ws-card-new').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      populateDetailsPanel(item);
    });
    wsGrid.appendChild(card);
  });

  // Load more button
  const moreWrap = document.createElement('div');
  moreWrap.id = 'ws-load-more';
  moreWrap.style.cssText = 'grid-column:1/-1; text-align:center; padding:16px;';
  moreWrap.innerHTML = '<button class="btn btn-secondary" style="padding:10px 30px;">Carregar mais</button>';
  moreWrap.querySelector('button').addEventListener('click', () => loadWorkshopItems(wsCurrentPage + 1, true));
  wsGrid.appendChild(moreWrap);
}

function populateDetailsPanel(item) {
  const details = document.getElementById('ws-details');
  const safeTitle = item.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  
  details.innerHTML = `
    <div class="det-img-wrap">
      ${item.preview ? `<img class="det-img" src="${item.preview}" />` : ''}
    </div>
    <div class="det-title">${item.title}</div>
    <div class="det-author">Por: <span>Desconhecido</span> <svg class="verified-icon" viewBox="0 0 24 24"><path d="M12 2l3.09 2.26 3.83-.86 1.15 3.73 3.4 1.94-1.94 3.4 1.94 3.4-3.4 1.94-1.15 3.73-3.83-.86L12 22l-3.09-2.26-3.83.86-1.15-3.73-3.4-1.94 1.94-3.4-1.94-3.4 3.4-1.94 1.15-3.73 3.83.86z"></path><polyline points="9 12 11 14 15 10" fill="none" stroke="#fff" stroke-width="2"></polyline></svg></div>
    
    <div class="det-stats-row">
      <div class="det-stat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        ${formatSubscribers(item.subscribers)}
      </div>
      <div class="det-stat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        4.8
      </div>
      <div class="det-stat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="10" rx="2" ry="2"></rect><line x1="12" y1="7" x2="12" y2="17"></line></svg>
        16:9
      </div>
    </div>

    <div class="det-btn-row">
      <button class="btn-apply" onclick="startWorkshopDownload('${item.workshopId}', '${safeTitle}', '${item.preview || ''}', '${item.file_url || ''}')">
        📥 Baixar wallpaper
      </button>
      <button class="btn-secondary-full">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
        Adicionar à playlist
      </button>
    </div>

    <div class="det-section-title">Informações</div>
    <div class="det-info-grid">
      <div class="det-info-lbl">Tipo:</div><div class="det-info-val">Vídeo</div>
      <div class="det-info-lbl">Resolução:</div><div class="det-info-val">1920x1080</div>
      <div class="det-info-lbl">Duração:</div><div class="det-info-val">00:24</div>
      <div class="det-info-lbl">Tags:</div><div class="det-info-val">${(item.tags || []).slice(0, 4).join(', ')}</div>
    </div>

    <div class="det-section-title">Criado em</div>
    <div class="det-info-grid">
      <div class="det-info-val" style="grid-column:1/-1">20 de abr. de 2024</div>
    </div>
  `;
}

function formatSubscribers(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

async function startWorkshopDownload(workshopId, title, previewUrl, fileUrl) {
  wsStatus.style.display = 'block';
  wsStatus.style.background = 'var(--accent)';
  wsStatus.style.color = '#000';
  wsStatus.textContent = `⏳ Preparando download: ${title}...`;
  await ipc('download-workshop-item', { workshopId, name: title, previewUrl: previewUrl || null, fileUrl: fileUrl || null });
}

// Sort / search events
wsSort.addEventListener('change', () => loadWorkshopItems(1, false));
wsRefresh.addEventListener('click', () => loadWorkshopItems(1, false));

let wsSearchTimeout;
wsSearch.addEventListener('input', () => {
  clearTimeout(wsSearchTimeout);
  wsSearchTimeout = setTimeout(() => loadWorkshopItems(1, false), 600);
});

// Download progress from main process
// ---- QR Code Login ----
let _qrPollTimer = null;

async function startQRLogin() {
  document.getElementById('qr-loading').style.display = 'block';
  document.getElementById('qr-code-img').style.display = 'none';
  document.getElementById('qr-status').textContent = 'Gerando QR code...';
  document.getElementById('qr-status').style.color = 'var(--text2)';
  document.getElementById('modal-qr-login').classList.add('open');

  const res = await ipc('begin-qr-auth');
  if (res.error) {
    document.getElementById('qr-status').textContent = '❌ ' + res.error;
    return;
  }

  document.getElementById('qr-loading').style.display = 'none';
  const img = document.getElementById('qr-code-img');
  img.src = res.qrDataUrl;
  img.style.display = 'block';
  document.getElementById('qr-status').textContent = 'Aguardando scan no app Steam...';

  _qrPollTimer = setInterval(async () => {
    const poll = await ipc('poll-qr-auth');
    if (poll.status === 'approved') {
      clearInterval(_qrPollTimer); _qrPollTimer = null;
      document.getElementById('qr-status').style.color = 'var(--success)';
      document.getElementById('qr-status').textContent = `✅ Conectado como ${poll.accountName}! Credenciais salvas.`;
      setTimeout(() => {
        closeModal('modal-qr-login');
        closeModal('modal-steam-login');
        document.getElementById('qr-status').style.color = 'var(--text2)';
      }, 2000);
    } else if (poll.status === 'refresh') {
      img.src = poll.qrDataUrl;
    } else if (poll.status === 'error') {
      clearInterval(_qrPollTimer); _qrPollTimer = null;
      document.getElementById('qr-status').textContent = '❌ ' + poll.error;
    }
  }, 3000);
}

document.getElementById('btn-open-qr').addEventListener('click', () => {
  closeModal('modal-steam-login');
  startQRLogin();
});

document.getElementById('btn-qr-cancel').addEventListener('click', () => {
  if (_qrPollTimer) { clearInterval(_qrPollTimer); _qrPollTimer = null; }
  closeModal('modal-qr-login');
});

// ---- Steam login modal ----
let _slPending  = null; // { workshopId, name, previewUrl }
let _setupMode  = false; // true when modal is opened at startup to configure credentials

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

function _resetLoginModal() {
  document.querySelector('#modal-steam-login h3').textContent = '🔑 Login Steam necessário';
  document.getElementById('sl-desc').textContent =
    'Este wallpaper requer o Wallpaper Engine. Se não lembra a senha, use o QR Code abaixo.';
  document.getElementById('btn-sl-use-preview').style.display = '';
  document.getElementById('btn-sl-login').textContent = '📥 Baixar';
  document.getElementById('sl-2fa-wrap').style.display = 'none';
  _setupMode = false;
}

function openSetupModal() {
  _setupMode = true;
  document.querySelector('#modal-steam-login h3').textContent = '🔑 Configurar conta Steam';
  document.getElementById('sl-desc').textContent =
    'Entre com sua conta Steam para baixar wallpapers do Workshop sem precisar digitar a senha toda vez.';
  document.getElementById('btn-sl-use-preview').style.display = 'none';
  document.getElementById('btn-sl-login').textContent = '💾 Salvar';
  document.getElementById('sl-user').value = '';
  document.getElementById('sl-pass').value = '';
  document.getElementById('modal-steam-login').classList.add('open');
}

document.getElementById('btn-sl-login').addEventListener('click', async () => {
  const username   = document.getElementById('sl-user').value.trim();
  const password   = document.getElementById('sl-pass').value;
  const steamGuard = document.getElementById('sl-2fa').value.trim();
  if (!username || !password) return;

  if (_setupMode) {
    closeModal('modal-steam-login');
    _resetLoginModal();
    wsStatus.style.display = 'block';
    wsStatus.style.background = 'var(--accent)';
    wsStatus.style.color = '#000';
    wsStatus.textContent = '⏳ Verificando conta Steam...';
    const result = await ipc('validate-steam-login', { username, password, steamGuard });
    if (result.ok) {
      wsStatus.style.background = '#4caf50';
      wsStatus.textContent = `✅ Conta ${username} configurada! Downloads do Workshop habilitados.`;
      setTimeout(() => { wsStatus.style.display = 'none'; }, 5000);
    } else if (result.needs2fa) {
      document.getElementById('sl-2fa-wrap').style.display = 'block';
      openSetupModal();
    } else {
      wsStatus.style.background = 'var(--error, #c0392b)';
      wsStatus.style.color = '#fff';
      wsStatus.textContent = `❌ ${result.msg || 'Falha ao verificar conta.'}`;
      setTimeout(() => { wsStatus.style.display = 'none'; }, 6000);
    }
    return;
  }

  closeModal('modal-steam-login');
  wsStatus.style.display = 'block';
  wsStatus.style.background = 'var(--accent)';
  wsStatus.style.color = '#000';
  wsStatus.textContent = '⏳ Fazendo login e baixando...';
  await ipc('download-workshop-with-login', {
    workshopId: _slPending?.workshopId,
    name:       _slPending?.name,
    username, password, steamGuard,
  });
});

ipcRenderer.on('download-progress', (_, data) => {
  if (data.state === 'preparing') {
    wsStatus.style.display = 'block';
    wsStatus.style.background = 'var(--accent)';
    wsStatus.style.color = '#000';
    wsStatus.textContent = `⏳ ${data.name}`;
  } else if (data.state === 'start') {
    wsStatus.style.display = 'block';
    wsStatus.style.background = 'var(--accent)';
    wsStatus.style.color = '#000';
    wsStatus.textContent = `📥 Baixando: ${data.name}`;
  } else if (data.state === 'progress') {
    wsStatus.style.display = 'block';
    wsStatus.style.background = 'var(--accent)';
    wsStatus.style.color = '#000';
    wsStatus.textContent = `📥 Baixando... ${Math.round(data.pct * 100)}%`;
  } else if (data.state === 'completed') {
    wsStatus.style.display = 'block';
    wsStatus.style.background = '#4caf50';
    wsStatus.style.color = '#000';
    wsStatus.textContent = '✅ Download concluído! Wallpaper adicionado à biblioteca.';
    setTimeout(() => { wsStatus.style.display = 'none'; }, 5000);
    _slPending = null;
    const wp = data.wallpaper;
    if (wp && !library.some(w => w.id === wp.id)) {
      library.push(wp);
      renderLibrary();
    }
  } else if (data.state === 'needs-login') {
    wsStatus.style.display = 'none';
    _slPending = { workshopId: data.workshopId, name: data.name, previewUrl: data.previewUrl };
    const previewImg  = document.getElementById('sl-preview-img');
    const previewWrap = document.getElementById('sl-preview-wrap');
    if (data.previewUrl) {
      previewImg.src = data.previewUrl;
      previewWrap.style.display = 'block';
    } else {
      previewWrap.style.display = 'none';
    }
    document.getElementById('sl-user').value = '';
    document.getElementById('sl-pass').value = '';
    document.getElementById('sl-2fa').value = '';
    document.getElementById('sl-2fa-wrap').style.display = 'none';
    document.getElementById('modal-steam-login').classList.add('open');
  } else if (data.state === 'needs-2fa') {
    _slPending = { workshopId: data.workshopId, name: data.name, previewUrl: data.previewUrl };
    document.getElementById('sl-user').value = data.username || '';
    document.getElementById('sl-pass').value = data.password || '';
    document.getElementById('sl-2fa-wrap').style.display = 'block';
    document.getElementById('sl-2fa').value = '';
    document.getElementById('modal-steam-login').classList.add('open');
  } else if (data.state === 'error') {
    wsStatus.style.display = 'block';
    wsStatus.style.background = '#f44336';
    wsStatus.style.color = '#fff';
    wsStatus.textContent = '❌ ' + data.msg;
    setTimeout(() => { wsStatus.style.display = 'none'; }, 8000);
  }
});

// ---- Init ----
async function init() {
  [library, current, playlistConfig, settings, allDisplays, displayWallpapers, timeRules] = await Promise.all([
    ipc('get-library'),
    ipc('get-current'),
    ipc('get-playlist-config'),
    ipc('get-settings'),
    ipc('get-displays'),
    ipc('get-display-wallpapers'),
    ipc('get-time-rules'),
  ]);

  // Playlist UI
  plEnabled.checked = playlistConfig.enabled || false;
  plInterval.value  = playlistConfig.interval || 30;
  plIntervalVal.textContent = formatInterval(playlistConfig.interval || 30);
  plShuffle.checked = playlistConfig.shuffle || false;

  // Settings UI
  setVolume.value = settings.volume ?? 50;
  setVolumeV.textContent = (settings.volume ?? 50) + '%';
  setPauseFs.checked = settings.pauseOnFullscreen ?? true;
  setMuteFs.checked  = settings.muteOnFullscreen  ?? false;
  setStartup.checked = settings.startWithWindows  ?? false;

  renderLibrary();
  updateNowPlaying();
  renderMonitors();
  renderTimeRules();
  loadWorkshopItems(1);

  // Ask for Steam credentials on first launch if not configured
  const savedAuth = await ipc('get-steam-auth');
  if (!savedAuth) {
    setTimeout(() => openSetupModal(), 800);
  }
}

init();
