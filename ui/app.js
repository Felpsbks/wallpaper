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
    nameEl.textContent = 'Nenhum wallpaper ativo'; typeEl.textContent = '–'; thumbEl.innerHTML = '—';
    return;
  }
  nameEl.textContent = current.name;
  typeEl.textContent = typeName(current.type, current.scene);
  if (current.thumbnail) {
    thumbEl.innerHTML = `<img src="${current.thumbnail}" style="width:100%;height:100%;object-fit:cover;border-radius:6px" />`;
  } else if (current.type === 'image') {
    thumbEl.innerHTML = `<img src="${toFileUrl(current.src)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px" />`;
  } else {
    thumbEl.textContent = typeIcon(current.type, current.scene);
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

async function loadWorkshopItems(page = 1) {
  wsGrid.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Carregando wallpapers...</p></div>';
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

  wsItems = result.items;
  renderWorkshopGrid();
}

function renderWorkshopGrid() {
  if (wsItems.length === 0) {
    wsGrid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>Nenhum wallpaper encontrado</p><small>Tente outra busca ou filtro</small></div>';
    return;
  }

  wsGrid.innerHTML = wsItems.map(item => `
    <div class="wallpaper-card ws-card" data-wsid="${item.workshopId}" title="${item.title}\n${item.tags.join(', ')}\n${item.subscribers} inscritos">
      <div class="card-thumb-wrap">
        ${item.preview ? `<img class="card-thumb-img" src="${item.preview}" alt="${item.title}" loading="lazy" />` : '<span class="card-thumb">🌐</span>'}
        <div class="ws-overlay">
          <div class="ws-dl-btn">📥 Baixar</div>
        </div>
      </div>
      <div class="card-info">
        <div class="card-name">${item.title}</div>
        <div class="card-type">${item.tags.slice(0, 3).join(' · ')} · ⭐ ${formatSubscribers(item.subscribers)}</div>
      </div>
    </div>
  `).join('');

  // Load more button
  wsGrid.innerHTML += `
    <div style="grid-column:1/-1; text-align:center; padding:16px;">
      <button class="btn btn-secondary" id="ws-load-more" style="padding:10px 30px;">Carregar mais</button>
    </div>
  `;

  document.getElementById('ws-load-more')?.addEventListener('click', () => {
    loadWorkshopItems(wsCurrentPage + 1);
  });

  // Click to download
  wsGrid.querySelectorAll('.ws-card').forEach(card => {
    card.addEventListener('click', () => {
      const wsid = card.dataset.wsid;
      const item = wsItems.find(i => i.workshopId === wsid);
      if (!item) return;
      startWorkshopDownload(wsid, item.title);
    });
  });
}

function formatSubscribers(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

async function startWorkshopDownload(workshopId, title) {
  wsStatus.style.display = 'block';
  wsStatus.style.background = 'var(--accent)';
  wsStatus.style.color = '#000';
  wsStatus.textContent = `⏳ Enviando para o servidor: ${title}...`;
  await ipc('download-workshop-item', { workshopId, name: title });
}

// Sort / search events
wsSort.addEventListener('change', () => loadWorkshopItems(1));
wsRefresh.addEventListener('click', () => loadWorkshopItems(wsCurrentPage));

let wsSearchTimeout;
wsSearch.addEventListener('input', () => {
  clearTimeout(wsSearchTimeout);
  wsSearchTimeout = setTimeout(() => loadWorkshopItems(1), 600);
});

// Download progress from main process
// ---- Steam login modal ----
let _slPending = null; // { workshopId, name }

document.getElementById('btn-sl-login').addEventListener('click', async () => {
  const username  = document.getElementById('sl-user').value.trim();
  const password  = document.getElementById('sl-pass').value;
  const steamGuard = document.getElementById('sl-2fa').value.trim();
  if (!username || !password) return;
  closeModal('modal-steam-login');
  wsStatus.style.display = 'block';
  wsStatus.style.background = 'var(--accent)';
  wsStatus.style.color = '#000';
  wsStatus.textContent = `⏳ Fazendo login e baixando...`;
  await ipc('download-workshop-with-login', {
    workshopId: _slPending?.workshopId,
    name:       _slPending?.name,
    username, password, steamGuard,
  });
});

ipcRenderer.on('download-progress', (_, data) => {
  wsStatus.style.display = 'block';
  wsStatus.style.color = '#000';
  if (data.state === 'preparing') {
    wsStatus.style.background = 'var(--accent)';
    wsStatus.textContent = `⏳ ${data.name}`;
  } else if (data.state === 'start') {
    wsStatus.style.background = 'var(--accent)';
    wsStatus.textContent = `📥 Baixando: ${data.name}`;
  } else if (data.state === 'progress') {
    wsStatus.textContent = `📥 Baixando... ${Math.round(data.pct * 100)}%`;
  } else if (data.state === 'completed') {
    wsStatus.style.background = '#4caf50';
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
    _slPending = { workshopId: data.workshopId, name: data.name };
    document.getElementById('sl-user').value = '';
    document.getElementById('sl-pass').value = '';
    document.getElementById('sl-2fa').value = '';
    document.getElementById('sl-2fa-wrap').style.display = 'none';
    document.getElementById('modal-steam-login').classList.add('open');
  } else if (data.state === 'needs-2fa') {
    // Re-open modal with 2FA field visible
    _slPending = { workshopId: data.workshopId, name: data.name };
    document.getElementById('sl-user').value = data.username || '';
    document.getElementById('sl-pass').value = data.password || '';
    document.getElementById('sl-2fa-wrap').style.display = 'block';
    document.getElementById('sl-2fa').value = '';
    document.getElementById('modal-steam-login').classList.add('open');
  } else if (data.state === 'error') {
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
}

init();
