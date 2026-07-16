const { ipcRenderer } = require('electron');

async function ipc(channel, ...args) { return ipcRenderer.invoke(channel, ...args); }

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
  if (!confirm('Tem certeza que deseja remover este wallpaper da sua biblioteca?')) return;
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

  if (!defs.length) { 
    fields.innerHTML = '<p style="color:var(--text2);font-size:13px">Sem propriedades configuráveis.</p>'; 
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
const wsStatus      = document.getElementById('ws-status-bar');
const wsStatusText   = document.getElementById('ws-status-text');
const wsStatusDetail = document.getElementById('ws-status-detail');
const wsProgressFill = document.getElementById('ws-progress-fill');
const wsLogBar       = document.getElementById('ws-log-bar');
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
  wsLogBar.style.display = 'flex';
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

document.getElementById('btn-log-close').addEventListener('click', () => {
  wsLogBar.style.display = 'none';
});


function setWsStatus(text, detail = '', pct = null, color = 'var(--accent)') {
  wsStatus.style.display = 'block';
  wsStatus.style.background = color;
  wsStatus.style.color = color === 'var(--accent)' ? '#000' : '#fff';
  wsStatusText.textContent = text;
  wsStatusDetail.textContent = detail;
  wsProgressFill.style.width = pct !== null ? Math.min(100, Math.round(pct * 100)) + '%' : '0%';
}

let wsCurrentPage = 1;
let wsItems = [];

async function loadWorkshopItems(page = 1) {
  wsGrid.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Carregando wallpapers...</p></div>';
  wsItems = [];
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
  const hasMore = wsItems.length >= 30; // Steam API often limits around 30 per page for search
  renderWorkshopGrid(hasMore);
}

function renderWorkshopGrid(hasMore = false) {
  if (wsItems.length === 0) {
    wsGrid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>Nenhum wallpaper encontrado</p><small>Tente outra busca ou filtro</small></div>';
    return;
  }

  wsGrid.innerHTML = '';

  wsItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'ws-card-new';
    card.dataset.wsid = item.workshopId;
    card.title = `${item.title}\\n${item.tags.join(', ')}\\n${item.subscribers} inscritos`;
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

  // Numbered Pagination
  const pagWrap = document.createElement('div');
  pagWrap.id = 'ws-pagination';
  pagWrap.style.cssText = 'grid-column:1/-1; display:flex; justify-content:center; align-items:center; gap:8px; padding:16px 0 32px 0;';
  
  const createBtn = (label, pageNum, isActive = false) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.style.cssText = 'min-width:40px; padding:8px 12px; font-weight:bold; transition:all 0.2s ease; border-radius:6px;';
    if (isActive) {
      btn.style.background = 'var(--accent)';
      btn.style.color = '#000';
      btn.style.borderColor = 'var(--accent)';
    }
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (pageNum !== wsCurrentPage) loadWorkshopItems(pageNum);
    });
    return btn;
  };

  if (wsCurrentPage > 1) {
    pagWrap.appendChild(createBtn('← Anterior', wsCurrentPage - 1));
  }
  
  const startPage = Math.max(1, wsCurrentPage - 2);
  const endPage = startPage + 4;
  
  for (let i = startPage; i <= endPage; i++) {
    // Only show future pages if we are somewhat sure they exist, but Steam always returns 30 unless it's the end.
    if (i > wsCurrentPage && !hasMore && i !== endPage) continue;
    pagWrap.appendChild(createBtn(i, i, i === wsCurrentPage));
  }
  
  if (hasMore) {
    pagWrap.appendChild(createBtn('Próxima →', wsCurrentPage + 1));
  }
  
  wsGrid.appendChild(pagWrap);
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
  setWsStatus(`⏳ Preparando inscrição invisível: ${title}...`);
  const result = await ipc('download-workshop-item', { workshopId, name: title, previewUrl: previewUrl || null, fileUrl: fileUrl || null });
  
  if (result && result.msg === 'needs_login') {
    _slPending = { workshopId, name: title, previewUrl };
    document.getElementById('sl-preview-img').src = previewUrl || '';
    document.getElementById('sl-preview-wrap').style.display = previewUrl ? 'block' : 'none';
    document.getElementById('modal-steam-login').classList.add('open');
  }
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
let _slPending  = null; // { workshopId, name, previewUrl }
let _setupMode  = false;

document.getElementById('btn-steam-web-login').addEventListener('click', async () => {
  setWsStatus('⏳ Abrindo janela de login da Steam...');
  const result = await ipc('steam-web-login');
  if (result.ok) {
    setWsStatus('✅ Login Steam realizado com sucesso!', 'Inscrições invisíveis habilitadas.', 1, '#4caf50');
    setTimeout(() => { wsStatus.style.display = 'none'; }, 4000);
    closeModal('modal-steam-login');
    
    // Se tinha um download pendente, tenta baixar de novo agora que tem cookies
    if (_slPending) {
      startWorkshopDownload(_slPending.workshopId, _slPending.name, _slPending.previewUrl);
    }
  } else {
    setWsStatus('❌ ' + (result.msg || 'Login cancelado/falhou.'), '', null, '#c0392b');
    setTimeout(() => { wsStatus.style.display = 'none'; }, 4000);
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

function openSetupModal() {
  _setupMode = true;
  document.getElementById('btn-sl-use-preview').style.display = 'none';
  document.getElementById('sl-preview-wrap').style.display = 'none';
  document.getElementById('modal-steam-login').classList.add('open');
}

ipcRenderer.on('download-progress', async (_, data) => {
  if (data.state === 'preparing') {
    setWsStatus(`⏳ ${data.name}`);
  } else if (data.state === 'start') {
    setWsStatus(`📥 Baixando: ${data.name}`, '', 0.02);
  } else if (data.state === 'progress') {
    const pct = data.pct || 0;
    const size = data.total > 0
      ? `${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`
      : '';
    const spd = data.speed > 1024 ? `${formatBytes(data.speed)}/s` : '';
    setWsStatus(`📥 ${Math.round(pct * 100)}%  ${size}`, spd, pct);
  } else if (data.state === 'completed') {
    setWsStatus('✅ Download concluído!', 'Wallpaper adicionado à biblioteca.', 1, '#4caf50');
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
    const savedAuth = (await ipc('get-steam-auth')) || {};
    document.getElementById('sl-user').value = savedAuth.accountName || '';
    document.getElementById('sl-pass').value = savedAuth.password || '';
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
  } else if (data.state === 'needs-mobile-auth') {
    setWsStatus('📱 Aprove o login no aplicativo da Steam no celular...', '', null, '#ff9800');
  } else if (data.state === 'error') {
    setWsStatus('❌ ' + data.msg, '', null, '#f44336');
    setTimeout(() => { wsStatus.style.display = 'none'; }, 8000);
  }
});

// ---- Init ----
async function init() {
  try {
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
    appRules = settings.appRules || [];

    renderLibrary();
    updateNowPlaying();
    renderMonitors();
    renderAppRules();
    renderTimeRules();
    loadWorkshopItems(1);
  } catch (e) {
    alert('Erro crítico no init: ' + e.stack);
  }
}

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

init();
