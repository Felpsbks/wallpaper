// ==================================================================
// Oficina — Editor Visual de Wallpapers (V1: imagem estática)
// Carregado como <script> normal depois de app.js, no MESMO escopo global
// (nodeIntegration:true, sem type=module) — por isso `ipc`, `library`,
// `renderLibrary`, `toFileUrl` etc. (definidos em app.js) são acessíveis
// direto aqui, sem precisar de bridge/export.
// ==================================================================
const Konva = require('konva').default || require('konva');

(function () {
  let stage = null, bgLayer = null, mainLayer = null, transformer = null;
  let edLayers = [];       // modelos das camadas (fonte de verdade do painel de camadas)
  let edNodes = {};        // id -> nó Konva correspondente
  let edSelectedIds = [];  // seleção múltipla (shift+clique)
  let edInitialized = false;
  let edProjectId = null;
  let edCanvasSize = { width: 1920, height: 1080, aspectPreset: '16:9' };
  let edZoom = 1;
  let edHistory = [];      // pilha de undo (snapshots serializados de edLayers)
  let edFuture = [];       // pilha de redo
  let edAutosaveTimer = null;
  let edSuppressHistory = false;

  const ASPECT_PRESETS = { free: null, '16:9': 16 / 9, '21:9': 21 / 9, '9:16': 9 / 16, '1:1': 1, dual: 32 / 9, triple: 48 / 9 };
  const LAYER_ICONS = { image: '🖼', text: '📝', shape: '▭', group: '▣' };

  function genId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

  // ---- Inicialização ----
  function init() {
    if (edInitialized) { fitToScreen(); return; }
    edInitialized = true;
    setupStage();
    wireToolbar();
    wireAddButtons();
    wireCanvasToolbar();
    wireBottomBar();
    wireKeyboardShortcuts();
    loadOrCreateProject();
  }

  function setupStage() {
    const container = document.getElementById('ed-konva-container');
    stage = new Konva.Stage({ container, width: edCanvasSize.width, height: edCanvasSize.height });
    bgLayer = new Konva.Layer();
    mainLayer = new Konva.Layer();
    stage.add(bgLayer);
    stage.add(mainLayer);

    const bg = new Konva.Rect({ x: 0, y: 0, width: edCanvasSize.width, height: edCanvasSize.height, fill: '#000000', name: '__background' });
    bgLayer.add(bg);
    bgLayer.draw();

    transformer = new Konva.Transformer({ rotateEnabled: true, borderStroke: '#7c3aed', anchorStroke: '#7c3aed', anchorFill: '#fff' });
    mainLayer.add(transformer);

    stage.on('click tap', (e) => {
      if (e.target === stage || e.target.name() === '__background') { selectLayers([]); return; }
      const layerId = e.target.getAttr('edLayerId');
      if (!layerId) return;
      const additive = e.evt && (e.evt.shiftKey || e.evt.ctrlKey);
      if (additive) toggleLayerSelection(layerId);
      else selectLayers([layerId]);
    });

    fitToScreen();
  }

  function fitToScreen() {
    const wrap = document.getElementById('ed-canvas-wrap');
    if (!wrap || !stage) return;
    const availW = wrap.clientWidth - 24;
    const availH = wrap.clientHeight - 24;
    const zoom = Math.min(availW / edCanvasSize.width, availH / edCanvasSize.height, 1);
    setZoom(zoom > 0 ? zoom : 1);
  }

  function setZoom(zoom) {
    edZoom = Math.max(0.05, Math.min(4, zoom));
    stage.width(edCanvasSize.width * edZoom);
    stage.height(edCanvasSize.height * edZoom);
    stage.scale({ x: edZoom, y: edZoom });
    stage.draw();
    const label = document.getElementById('ed-zoom-label');
    if (label) label.textContent = Math.round(edZoom * 100) + '%';
  }

  // ---- Camadas: criação de nós Konva a partir do modelo ----
  function createNodeForLayer(layer) {
    let node;
    if (layer.type === 'image') {
      const imgEl = new Image();
      imgEl.src = toFileUrl(layer.src);
      node = new Konva.Image({ image: imgEl, width: layer.width || 400, height: layer.height || 300 });
      imgEl.onload = () => { node.image(imgEl); mainLayer.batchDraw(); };
    } else if (layer.type === 'text') {
      node = new Konva.Text({
        text: layer.text || 'Texto', fontSize: (layer.font && layer.font.size) || 64,
        fontFamily: (layer.font && layer.font.family) || 'Arial', fontStyle: (layer.font && layer.font.weight >= 700) ? 'bold' : 'normal',
        fill: (layer.fill && layer.fill.color) || '#ffffff',
        letterSpacing: (layer.font && layer.font.letterSpacing) || 0,
      });
    } else if (layer.type === 'shape') {
      if (layer.shapeKind === 'ellipse') {
        node = new Konva.Ellipse({ radiusX: (layer.width || 200) / 2, radiusY: (layer.height || 150) / 2, fill: layer.fill || '#7c84f4' });
      } else {
        node = new Konva.Rect({ width: layer.width || 200, height: layer.height || 150, fill: layer.fill || '#7c84f4', cornerRadius: layer.cornerRadius || 0 });
      }
    } else if (layer.type === 'group') {
      node = new Konva.Group();
    }
    if (!node) return null;

    node.setAttrs({
      x: layer.transform.x, y: layer.transform.y, rotation: layer.transform.rotation,
      scaleX: layer.transform.scaleX, scaleY: layer.transform.scaleY,
      opacity: layer.opacity, visible: layer.visible, draggable: !layer.locked,
    });
    node.setAttr('edLayerId', layer.id);

    node.on('dragend transformend', () => {
      layer.transform.x = node.x(); layer.transform.y = node.y(); layer.transform.rotation = node.rotation();
      layer.transform.scaleX = node.scaleX(); layer.transform.scaleY = node.scaleY();
      pushHistory();
      scheduleAutosave();
    });

    return node;
  }

  function addLayer(layer, opts) {
    opts = opts || {};
    edLayers.push(layer);
    const node = createNodeForLayer(layer);
    edNodes[layer.id] = node;
    mainLayer.add(node);
    reorderZIndexes();
    renderLayersList();
    if (!opts.silent) selectLayers([layer.id]);
    if (!opts.skipHistory) pushHistory();
    scheduleAutosave();
    return node;
  }

  function removeLayer(id) {
    const node = edNodes[id];
    if (node) node.destroy();
    delete edNodes[id];
    edLayers = edLayers.filter(l => l.id !== id);
    edSelectedIds = edSelectedIds.filter(sid => sid !== id);
    updateTransformerSelection();
    renderLayersList();
    mainLayer.batchDraw();
  }

  function reorderZIndexes() {
    edLayers.forEach((l, i) => { l.zIndex = i; });
    edLayers.forEach(l => { const n = edNodes[l.id]; if (n) n.zIndex(l.zIndex + 1); }); // +1: transformer fica no topo (índice 0 reservado)
    mainLayer.batchDraw();
  }

  // ---- Seleção ----
  function selectLayers(ids) {
    edSelectedIds = ids.slice();
    updateTransformerSelection();
    renderLayersList();
    renderPropertiesPanel();
  }
  function toggleLayerSelection(id) {
    if (edSelectedIds.includes(id)) edSelectedIds = edSelectedIds.filter(x => x !== id);
    else edSelectedIds.push(id);
    updateTransformerSelection();
    renderLayersList();
    renderPropertiesPanel();
  }
  function updateTransformerSelection() {
    const nodes = edSelectedIds.map(id => edNodes[id]).filter(Boolean).filter(n => {
      const l = edLayers.find(x => x.id === n.getAttr('edLayerId'));
      return l && !l.locked;
    });
    transformer.nodes(nodes);
    mainLayer.batchDraw();
  }

  // ---- Painel de camadas (arrastar pra reordenar incluído) ----
  function renderLayersList() {
    const list = document.getElementById('ed-layers-list');
    if (!list) return;
    if (edLayers.length === 0) { list.innerHTML = '<p class="ed-empty-hint">Nenhuma camada ainda</p>'; return; }
    list.innerHTML = '';
    // Mais alto zIndex primeiro (convenção Photoshop: topo da lista = frente)
    const ordered = edLayers.slice().sort((a, b) => b.zIndex - a.zIndex);
    ordered.forEach(layer => {
      const row = document.createElement('div');
      row.className = 'ed-layer-row' + (edSelectedIds.includes(layer.id) ? ' selected' : '');
      row.draggable = true;
      row.dataset.id = layer.id;
      row.innerHTML = `
        <span class="ed-layer-icon">${LAYER_ICONS[layer.type] || '◆'}</span>
        <span class="ed-layer-name" title="${layer.name}">${layer.name}</span>
        <button class="ed-layer-btn ed-layer-vis" title="Visibilidade">${layer.visible ? '👁' : '🚫'}</button>
        <button class="ed-layer-btn ed-layer-lock" title="Bloquear">${layer.locked ? '🔒' : '🔓'}</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.ed-layer-vis') || e.target.closest('.ed-layer-lock')) return;
        if (e.shiftKey || e.ctrlKey) toggleLayerSelection(layer.id);
        else selectLayers([layer.id]);
      });
      row.querySelector('.ed-layer-vis').addEventListener('click', () => {
        layer.visible = !layer.visible;
        const n = edNodes[layer.id]; if (n) n.visible(layer.visible);
        mainLayer.batchDraw(); renderLayersList(); pushHistory(); scheduleAutosave();
      });
      row.querySelector('.ed-layer-lock').addEventListener('click', () => {
        layer.locked = !layer.locked;
        const n = edNodes[layer.id]; if (n) n.draggable(!layer.locked);
        updateTransformerSelection(); renderLayersList(); pushHistory(); scheduleAutosave();
      });
      row.addEventListener('dragstart', () => row.classList.add('dragging'));
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); document.querySelectorAll('.ed-layer-row').forEach(r => r.classList.remove('drag-over')); });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const draggedId = list.querySelector('.dragging')?.dataset.id;
        if (!draggedId || draggedId === layer.id) return;
        const from = edLayers.findIndex(l => l.id === draggedId);
        const to = edLayers.findIndex(l => l.id === layer.id);
        const [moved] = edLayers.splice(from, 1);
        edLayers.splice(to, 0, moved);
        reorderZIndexes();
        renderLayersList();
        pushHistory();
        scheduleAutosave();
      });
      list.appendChild(row);
    });
  }

  // ---- Painel de propriedades (Transform sempre; ajustes/efeitos ficam pra fase (b)) ----
  function renderPropertiesPanel() {
    const panel = document.getElementById('ed-properties-panel');
    if (!panel) return;
    if (edSelectedIds.length === 0) { panel.innerHTML = '<p class="ed-empty-hint">Selecione uma camada pra editar</p>'; return; }
    if (edSelectedIds.length > 1) { panel.innerHTML = `<p class="ed-empty-hint">${edSelectedIds.length} camadas selecionadas</p>`; return; }

    const layer = edLayers.find(l => l.id === edSelectedIds[0]);
    if (!layer) { panel.innerHTML = ''; return; }

    let extra = '';
    if (layer.type === 'text') {
      extra = `
        <div class="ed-prop-row"><label>Texto</label><input type="text" id="ed-prop-text" value="${layer.text.replace(/"/g, '&quot;')}" /></div>
        <div class="ed-prop-row"><label>Tamanho</label><input type="number" id="ed-prop-fontsize" value="${layer.font.size}" min="8" max="400" /></div>
        <div class="ed-prop-row"><label>Cor</label><input type="color" id="ed-prop-fillcolor" value="${layer.fill.color}" /></div>`;
    } else if (layer.type === 'shape') {
      extra = `<div class="ed-prop-row"><label>Cor</label><input type="color" id="ed-prop-shapefill" value="${layer.fill}" /></div>`;
    }

    panel.innerHTML = `
      <div class="ed-prop-group open">
        <div class="ed-prop-group-header">Transformar</div>
        <div class="ed-prop-group-body">
          <div class="ed-prop-row"><label>X</label><input type="number" id="ed-prop-x" value="${Math.round(layer.transform.x)}" /></div>
          <div class="ed-prop-row"><label>Y</label><input type="number" id="ed-prop-y" value="${Math.round(layer.transform.y)}" /></div>
          <div class="ed-prop-row"><label>Rotação</label><input type="number" id="ed-prop-rotation" value="${Math.round(layer.transform.rotation)}" /></div>
          <div class="ed-prop-row"><label>Opacidade</label><input type="range" id="ed-prop-opacity" min="0" max="1" step="0.01" value="${layer.opacity}" /></div>
        </div>
      </div>
      ${extra ? `<div class="ed-prop-group open"><div class="ed-prop-group-header">Conteúdo</div><div class="ed-prop-group-body">${extra}</div></div>` : ''}
    `;

    const node = edNodes[layer.id];
    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('input', fn); };
    bind('ed-prop-x', e => { layer.transform.x = +e.target.value; node.x(+e.target.value); mainLayer.batchDraw(); });
    bind('ed-prop-y', e => { layer.transform.y = +e.target.value; node.y(+e.target.value); mainLayer.batchDraw(); });
    bind('ed-prop-rotation', e => { layer.transform.rotation = +e.target.value; node.rotation(+e.target.value); mainLayer.batchDraw(); });
    bind('ed-prop-opacity', e => { layer.opacity = +e.target.value; node.opacity(+e.target.value); mainLayer.batchDraw(); });
    bind('ed-prop-text', e => { layer.text = e.target.value; node.text(e.target.value); mainLayer.batchDraw(); renderLayersList(); });
    bind('ed-prop-fontsize', e => { layer.font.size = +e.target.value; node.fontSize(+e.target.value); mainLayer.batchDraw(); });
    bind('ed-prop-fillcolor', e => { layer.fill.color = e.target.value; node.fill(e.target.value); mainLayer.batchDraw(); });
    bind('ed-prop-shapefill', e => { layer.fill = e.target.value; node.fill(e.target.value); mainLayer.batchDraw(); });
    ['ed-prop-x','ed-prop-y','ed-prop-rotation','ed-prop-opacity','ed-prop-text','ed-prop-fontsize','ed-prop-fillcolor','ed-prop-shapefill'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => { pushHistory(); scheduleAutosave(); });
    });
  }

  // ---- Adicionar camadas ----
  function wireAddButtons() {
    document.getElementById('ed-add-image')?.addEventListener('click', async () => {
      const result = await ipc('open-file-dialog', {
        title: 'Selecionar imagem', filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths.length) return;
      const src = result.filePaths[0];
      const name = src.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      addLayer({
        id: genId('layer'), type: 'image', name, visible: true, locked: false, opacity: 1, zIndex: edLayers.length,
        parentGroupId: null, transform: { x: edCanvasSize.width / 2 - 200, y: edCanvasSize.height / 2 - 150, rotation: 0, scaleX: 1, scaleY: 1 },
        src, width: 400, height: 300, crop: { x: 0, y: 0, width: 1, height: 1 }, cornerRadius: 0, flipH: false, flipV: false,
        adjustments: { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, sharpness: 0, gamma: 1, blur: 0, vignette: 0, grain: 0 },
        effects: { glow: null, neon: null, shadow: null, outline: null, glass: null, bloom: null, pixelate: 0 },
      });
    });

    document.getElementById('ed-add-text')?.addEventListener('click', () => {
      addLayer({
        id: genId('layer'), type: 'text', name: 'Texto', visible: true, locked: false, opacity: 1, zIndex: edLayers.length,
        parentGroupId: null, transform: { x: edCanvasSize.width / 2 - 100, y: edCanvasSize.height / 2, rotation: 0, scaleX: 1, scaleY: 1 },
        text: 'Seu texto aqui', font: { family: 'Arial', size: 64, weight: 700, letterSpacing: 0, curve: 0 },
        fill: { mode: 'solid', color: '#ffffff', gradient: null }, stroke: { color: '#000000', width: 0 },
        effects: { glow: null, shadow: null, outline: null },
      });
    });

    document.getElementById('ed-add-rect')?.addEventListener('click', () => {
      addLayer({
        id: genId('layer'), type: 'shape', shapeKind: 'rect', name: 'Retângulo', visible: true, locked: false, opacity: 1, zIndex: edLayers.length,
        parentGroupId: null, transform: { x: edCanvasSize.width / 2 - 100, y: edCanvasSize.height / 2 - 75, rotation: 0, scaleX: 1, scaleY: 1 },
        fill: '#7c84f4', stroke: null, width: 200, height: 150, cornerRadius: 0,
      });
    });

    document.getElementById('ed-add-ellipse')?.addEventListener('click', () => {
      addLayer({
        id: genId('layer'), type: 'shape', shapeKind: 'ellipse', name: 'Elipse', visible: true, locked: false, opacity: 1, zIndex: edLayers.length,
        parentGroupId: null, transform: { x: edCanvasSize.width / 2, y: edCanvasSize.height / 2, rotation: 0, scaleX: 1, scaleY: 1 },
        fill: '#7c84f4', stroke: null, width: 200, height: 150,
      });
    });
  }

  // ---- Toolbar (ferramentas) ----
  function wireToolbar() {
    document.querySelectorAll('.ed-tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ed-tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.getElementById('ed-btn-duplicate')?.addEventListener('click', () => {
      const newIds = [];
      edSelectedIds.forEach(id => {
        const original = edLayers.find(l => l.id === id);
        if (!original) return;
        const copy = JSON.parse(JSON.stringify(original));
        copy.id = genId('layer'); copy.name = original.name + ' (cópia)';
        copy.transform.x += 24; copy.transform.y += 24; copy.zIndex = edLayers.length;
        edLayers.push(copy);
        const node = createNodeForLayer(copy);
        edNodes[copy.id] = node;
        mainLayer.add(node);
        newIds.push(copy.id);
      });
      reorderZIndexes();
      renderLayersList();
      if (newIds.length) selectLayers(newIds);
      pushHistory(); scheduleAutosave();
    });

    document.getElementById('ed-btn-delete')?.addEventListener('click', () => {
      edSelectedIds.slice().forEach(id => removeLayer(id));
      renderPropertiesPanel();
      pushHistory(); scheduleAutosave();
    });

    document.getElementById('ed-btn-lock')?.addEventListener('click', () => {
      edSelectedIds.forEach(id => {
        const l = edLayers.find(x => x.id === id); if (!l) return;
        l.locked = !l.locked;
        const n = edNodes[id]; if (n) n.draggable(!l.locked);
      });
      updateTransformerSelection(); renderLayersList(); pushHistory(); scheduleAutosave();
    });

    document.getElementById('ed-btn-hide')?.addEventListener('click', () => {
      edSelectedIds.forEach(id => {
        const l = edLayers.find(x => x.id === id); if (!l) return;
        l.visible = !l.visible;
        const n = edNodes[id]; if (n) n.visible(l.visible);
      });
      mainLayer.batchDraw(); renderLayersList(); pushHistory(); scheduleAutosave();
    });

    document.getElementById('ed-btn-align-h')?.addEventListener('click', () => alignSelected('h'));
    document.getElementById('ed-btn-align-v')?.addEventListener('click', () => alignSelected('v'));
    document.getElementById('ed-btn-group')?.addEventListener('click', groupSelected);
    document.getElementById('ed-btn-ungroup')?.addEventListener('click', ungroupSelected);
    document.getElementById('ed-btn-undo')?.addEventListener('click', undo);
    document.getElementById('ed-btn-redo')?.addEventListener('click', redo);
  }

  function alignSelected(axis) {
    if (edSelectedIds.length < 2) return;
    const nodes = edSelectedIds.map(id => ({ id, node: edNodes[id], layer: edLayers.find(l => l.id === id) })).filter(x => x.node);
    if (axis === 'h') {
      const avgX = nodes.reduce((s, n) => s + n.node.x(), 0) / nodes.length;
      nodes.forEach(n => { n.node.x(avgX); n.layer.transform.x = avgX; });
    } else {
      const avgY = nodes.reduce((s, n) => s + n.node.y(), 0) / nodes.length;
      nodes.forEach(n => { n.node.y(avgY); n.layer.transform.y = avgY; });
    }
    mainLayer.batchDraw(); pushHistory(); scheduleAutosave();
  }

  function groupSelected() {
    if (edSelectedIds.length < 2) { alert('Selecione 2 ou mais camadas (clique segurando Shift) pra agrupar.'); return; }
    const groupId = genId('layer');
    const children = edSelectedIds.map(id => edLayers.find(l => l.id === id)).filter(Boolean);
    children.forEach(c => { c.parentGroupId = groupId; });
    const groupLayer = {
      id: groupId, type: 'group', name: 'Grupo', visible: true, locked: false, opacity: 1, zIndex: edLayers.length,
      parentGroupId: null, transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    };
    edLayers.push(groupLayer);
    const groupNode = createNodeForLayer(groupLayer);
    children.forEach(c => { const n = edNodes[c.id]; if (n) { n.moveTo(groupNode); } });
    edNodes[groupId] = groupNode;
    mainLayer.add(groupNode);
    reorderZIndexes();
    renderLayersList();
    selectLayers([groupId]);
    pushHistory(); scheduleAutosave();
  }

  function ungroupSelected() {
    const group = edLayers.find(l => l.id === edSelectedIds[0] && l.type === 'group');
    if (!group) { alert('Selecione um grupo pra desagrupar.'); return; }
    const children = edLayers.filter(l => l.parentGroupId === group.id);
    const groupNode = edNodes[group.id];
    children.forEach(c => {
      c.parentGroupId = null;
      const n = edNodes[c.id];
      if (n) { n.moveTo(mainLayer); }
    });
    removeLayer(group.id);
    reorderZIndexes();
    renderLayersList();
    selectLayers(children.map(c => c.id));
    pushHistory(); scheduleAutosave();
  }

  // ---- Barra de canvas (zoom/grade) ----
  function wireCanvasToolbar() {
    document.getElementById('ed-zoom-in')?.addEventListener('click', () => setZoom(edZoom + 0.1));
    document.getElementById('ed-zoom-out')?.addEventListener('click', () => setZoom(edZoom - 0.1));
    document.getElementById('ed-zoom-fit')?.addEventListener('click', fitToScreen);
    document.getElementById('ed-toggle-grid')?.addEventListener('change', (e) => {
      document.getElementById('ed-konva-container').classList.toggle('ed-grid-on', e.target.checked);
    });
  }

  // ---- Barra inferior (proporção + exportar) ----
  function wireBottomBar() {
    document.getElementById('ed-aspect-select')?.addEventListener('change', (e) => {
      edCanvasSize.aspectPreset = e.target.value;
      const ratio = ASPECT_PRESETS[e.target.value];
      if (ratio) {
        edCanvasSize.height = Math.round(edCanvasSize.width / ratio);
        stage.height(edCanvasSize.height * edZoom);
        const bg = bgLayer.findOne('.__background') || bgLayer.children[0];
        if (bg) bg.height(edCanvasSize.height);
        bgLayer.batchDraw();
        document.getElementById('ed-canvas-size-label').textContent = `${edCanvasSize.width} × ${edCanvasSize.height}`;
        fitToScreen();
        scheduleAutosave();
      }
    });

    document.getElementById('ed-btn-export')?.addEventListener('click', exportAsWallpaper);
  }

  async function exportAsWallpaper() {
    selectLayers([]); // esconde os handles de seleção antes de renderizar, senão vazam pra imagem exportada
    const dataUrl = stage.toDataURL({ pixelRatio: 1 });
    const name = (edLayers.length ? 'Wallpaper' : 'Wallpaper') + ' — ' + new Date().toLocaleDateString('pt-BR');
    const filePath = await ipc('export-editor-image', { dataUrl, name });
    const w = await ipc('add-wallpaper', { type: 'image', name, src: filePath });
    if (typeof library !== 'undefined' && typeof renderLibrary === 'function') {
      library.push(w);
      renderLibrary();
    }
    const btn = document.getElementById('ed-btn-export');
    const original = btn.innerHTML;
    btn.innerHTML = '✅ Exportado!';
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  }

  // ---- Atalhos de teclado ----
  function wireKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (!document.getElementById('panel-downloader')?.classList.contains('active')) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); document.getElementById('ed-btn-duplicate')?.click(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { document.getElementById('ed-btn-delete')?.click(); }
    });
  }

  // ---- Undo/Redo (pilha de snapshots serializados) ----
  function serializeLayers() { return JSON.parse(JSON.stringify(edLayers)); }
  function pushHistory() {
    if (edSuppressHistory) return;
    edHistory.push(serializeLayers());
    if (edHistory.length > 50) edHistory.shift();
    edFuture = [];
  }
  function undo() {
    if (edHistory.length < 2) return;
    edFuture.push(edHistory.pop());
    restoreSnapshot(edHistory[edHistory.length - 1]);
  }
  function redo() {
    if (edFuture.length === 0) return;
    const snap = edFuture.pop();
    edHistory.push(snap);
    restoreSnapshot(snap);
  }
  function restoreSnapshot(snapshot) {
    edSuppressHistory = true;
    Object.values(edNodes).forEach(n => n.destroy());
    edNodes = {};
    edLayers = JSON.parse(JSON.stringify(snapshot));
    edLayers.forEach(l => { const n = createNodeForLayer(l); edNodes[l.id] = n; mainLayer.add(n); });
    reorderZIndexes();
    selectLayers([]);
    renderLayersList();
    mainLayer.batchDraw();
    edSuppressHistory = false;
    scheduleAutosave();
  }

  // ---- Autosave (projeto em edição, separado do export final) ----
  function scheduleAutosave() {
    const label = document.getElementById('ed-autosave-label');
    if (label) label.textContent = 'Salvando...';
    clearTimeout(edAutosaveTimer);
    edAutosaveTimer = setTimeout(async () => {
      const project = {
        id: edProjectId, name: 'Projeto sem título', updatedAt: Date.now(),
        canvas: edCanvasSize, layers: serializeLayers(),
      };
      const saved = await ipc('save-editor-project', project);
      edProjectId = saved.id;
      if (label) label.textContent = 'Salvo automaticamente';
    }, 900);
  }

  async function loadOrCreateProject() {
    const projects = await ipc('get-editor-projects');
    const existing = projects && projects[0]; // V1: um projeto em edição por vez
    if (existing) {
      edProjectId = existing.id;
      edCanvasSize = existing.canvas || edCanvasSize;
      document.getElementById('ed-aspect-select').value = edCanvasSize.aspectPreset || '16:9';
      document.getElementById('ed-canvas-size-label').textContent = `${edCanvasSize.width} × ${edCanvasSize.height}`;
      stage.width(edCanvasSize.width); stage.height(edCanvasSize.height);
      const bg = bgLayer.children[0]; if (bg) { bg.width(edCanvasSize.width); bg.height(edCanvasSize.height); }
      (existing.layers || []).forEach(l => { const n = createNodeForLayer(l); edNodes[l.id] = n; mainLayer.add(n); edLayers.push(l); });
      reorderZIndexes();
      renderLayersList();
      fitToScreen();
    }
    pushHistory();
  }

  window.EngineEditor = { init };
})();
