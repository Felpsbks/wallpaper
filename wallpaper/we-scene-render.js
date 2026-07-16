// Renders an unpacked Wallpaper Engine scene folder (background image +
// live text objects) using plain DOM/CSS instead of their proprietary
// engine. Covers the common "background + clock/day/date" scene pattern;
// anything else in scene.json (particles, custom shader effects, 3D models)
// is silently skipped rather than attempted.
const fs = require('fs');
const path = require('path');

// Wallpaper Engine text objects carry their live-update logic as real,
// embedded JavaScript (an ES-module-flavored script with an `update(value)`
// export). We run that exact script instead of reimplementing its format
// logic, so behavior (24h/12h, day names, delimiters, etc.) matches the
// original author's configuration exactly. `createScriptProperties()` is a
// no-op builder here because we already have the resolved property values
// straight from scene.json — we don't need to replay the WE editor's UI.
//
// Security note: this executes author-provided script from a downloaded
// Workshop item via `new Function`, with full access to this renderer's
// scope (nodeIntegration is on for wallpaper windows). That's the same
// trust boundary the app already extends to Workshop web wallpapers loaded
// via <webview>, not a new category of exposure — but worth knowing.
function compileWeTextScript(scriptSource, realProps) {
  const cleaned = scriptSource.replace(/^\s*export\s+/gm, '');
  const factory = new Function('createScriptProperties', cleaned + '\n;return update;');

  function createScriptProperties() {
    const obj = { ...realProps };
    const chain = {
      addCheckbox: () => chain, addText: () => chain, addCombo: () => chain,
      addSlider: () => chain, addColor: () => chain, addBool: () => chain,
      finish: () => obj,
    };
    return chain;
  }

  return factory(createScriptProperties);
}

class WeScene {
  constructor(container, sceneDir, overrides) {
    this.container = container;
    this.sceneDir = sceneDir;
    this.overrides = overrides || {}; // user-adjusted { [objName]: { origin, fontSize } }
    this.timer = null;
    this.fontFamilies = new Map(); // relative font path -> CSS family name
    this.textEntries = [];         // { el, objName, w, h, fontSize, updateFn, value }
    this._resizeHandler = null;
    this._currentScale = 1;
    this.editing = false;
  }

  start() {
    const scenePath = path.join(this.sceneDir, 'scene.json');
    const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));

    const proj = (scene.general && scene.general.orthogonalprojection) || {};
    this.designWidth  = proj.width  || 1920;
    this.designHeight = proj.height || 1080;

    this.stage = document.createElement('div');
    this.stage.style.cssText = `position:absolute; top:0; left:0; width:${this.designWidth}px; height:${this.designHeight}px; transform-origin: 0 0; overflow:hidden; background:#000;`;
    this.container.innerHTML = '';
    this.container.appendChild(this.stage);

    for (const obj of scene.objects || []) {
      try {
        if (obj.image) this._buildImageObject(obj);
        else if (obj.text) this._buildTextObject(obj);
      } catch (err) {
        console.warn('[we-scene] skipped object', obj.name, err.message);
      }
    }

    this._applyScale();
    this._resizeHandler = () => this._applyScale();
    window.addEventListener('resize', this._resizeHandler);

    this._tick();
    this.timer = setInterval(() => this._tick(), 1000);
  }

  _applyScale() {
    const scale = Math.max(window.innerWidth / this.designWidth, window.innerHeight / this.designHeight);
    this._currentScale = scale;
    const offsetX = (window.innerWidth  - this.designWidth  * scale) / 2;
    const offsetY = (window.innerHeight - this.designHeight * scale) / 2;
    this.stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  }

  // object.image -> "models/<id>.json" -> .material -> "materials/<id>.json"
  // -> .passes[0].textures[0] -> texture id -> materials/<id>.tex.png
  _resolveObjectTexturePng(obj) {
    const modelPath = path.join(this.sceneDir, obj.image);
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const materialPath = path.join(this.sceneDir, model.material);
    const material = JSON.parse(fs.readFileSync(materialPath, 'utf8'));
    const texId = material.passes && material.passes[0] && material.passes[0].textures && material.passes[0].textures[0];
    if (!texId) return null;
    const pngPath = path.join(this.sceneDir, 'materials', texId + '.tex.png');
    return fs.existsSync(pngPath) ? pngPath : null;
  }

  // Wallpaper Engine's scene coordinate space has Y increasing upward (same
  // convention as its 3D camera — see scene.json's camera.up = "0 1 0"), but
  // CSS `top` increases downward. Flip it once here for every object.
  _screenTop(oy, h) {
    return (this.designHeight - oy) - h / 2;
  }

  _buildImageObject(obj) {
    const pngPath = this._resolveObjectTexturePng(obj);
    if (!pngPath) return;

    const [w, h]   = (obj.size   || `${this.designWidth} ${this.designHeight}`).split(' ').map(Number);
    const [ox, oy] = (obj.origin || '0 0 0').split(' ').map(Number);

    const img = document.createElement('img');
    img.src = 'file:///' + pngPath.replace(/\\/g, '/');
    img.style.cssText = `position:absolute; left:${ox - w / 2}px; top:${this._screenTop(oy, h)}px; width:${w}px; height:${h}px; object-fit:cover;`;
    this.stage.appendChild(img);
  }

  _loadFont(fontRelPath) {
    if (this.fontFamilies.has(fontRelPath)) return this.fontFamilies.get(fontRelPath);
    const family = 'we-font-' + this.fontFamilies.size;
    const fullPath = path.join(this.sceneDir, fontRelPath);
    const style = document.createElement('style');
    style.textContent = `@font-face { font-family: '${family}'; src: url('file:///${fullPath.replace(/\\/g, '/')}'); }`;
    document.head.appendChild(style);
    this.fontFamilies.set(fontRelPath, family);
    return family;
  }

  _buildTextObject(obj) {
    const [w, h] = (obj.size || '400 200').split(' ').map(Number);
    const override = this.overrides[obj.name];

    let ox, oy, fontSize;
    if (override) {
      [ox, oy] = override.origin.split(' ').map(Number);
      fontSize = override.fontSize;
    } else {
      const [sx] = (obj.scale || '1 1 1').split(' ').map(Number);
      [ox, oy] = (obj.origin || '0 0 0').split(' ').map(Number);
      fontSize = (obj.pointsize || 32) * (sx || 1);
    }

    const family = obj.font ? this._loadFont(obj.font) : null;

    // WE's text objects reference a blur/glow effect (see scene.json's
    // "effects" block) that gives the text a soft halo so it reads over busy
    // backgrounds — we don't run their shader, but approximate it with a
    // layered text-shadow. `brightness` (always seen >1 in real scenes, tied
    // to their HDR/bloom pipeline) drives how strong that glow is.
    const glow = (obj.brightness || 1) * 6;
    const textShadow = `0 0 ${glow}px rgba(0,0,0,0.85), 0 0 ${glow * 2}px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.9)`;

    const el = document.createElement('div');
    el.style.cssText = `position:absolute; left:${ox - w / 2}px; top:${this._screenTop(oy, h)}px; width:${w}px; height:${h}px;
      display:flex; align-items:${obj.verticalalign === 'center' ? 'center' : 'flex-start'};
      justify-content:${obj.horizontalalign === 'center' ? 'center' : 'flex-start'};
      font-family:${family ? `'${family}'` : 'sans-serif'}; font-size:${fontSize}px;
      color:#fff; white-space:pre; text-align:${obj.horizontalalign || 'left'};
      text-shadow: ${textShadow};`;
    this.stage.appendChild(el);

    let updateFn = null;
    try {
      if (obj.text.script) updateFn = compileWeTextScript(obj.text.script, obj.text.scriptproperties || {});
    } catch (err) {
      console.warn('[we-scene] failed to compile text script for', obj.name, err.message);
    }

    const initialValue = obj.text.value || '';
    this.textEntries.push({ el, objName: obj.name, w, h, fontSize, updateFn, value: initialValue });
    el.textContent = initialValue;
  }

  // ---- Manual layout editing (drag to move, wheel to resize) ----
  // Reverse-engineering WE's exact pixel formula for every field is a moving
  // target with no documentation; letting the user drag/scroll to the look
  // they want sidesteps that entirely and is saved per-wallpaper.
  // `onSaveRequest` is called (no args) when the user clicks the on-screen
  // "Salvar e sair" button. We can't use a keyboard shortcut here — wallpaper
  // windows are created with `focusable: false` on purpose (so they never
  // steal focus from normal desktop use), which means they never receive
  // keydown events at all, no matter what's pressed.
  enterEditMode(onSaveRequest) {
    this.editing = true;
    for (const entry of this.textEntries) {
      entry.el.style.pointerEvents = 'auto';
      entry.el.style.cursor = 'move';
      entry.el.style.outline = '1px dashed rgba(255,255,255,0.6)';
      if (!entry._dragBound) {
        this._bindDragAndResize(entry);
        entry._dragBound = true;
      }
    }

    this._banner = document.createElement('div');
    this._banner.style.cssText = `position:fixed; top:16px; left:50%; transform:translateX(-50%); z-index:1000;
      background:rgba(0,0,0,0.75); color:#fff; font-family:sans-serif; font-size:14px; padding:10px 18px;
      border-radius:8px; pointer-events:none; text-align:center; line-height:1.5;
      display:flex; align-items:center; gap:14px;`;

    const label = document.createElement('span');
    label.textContent = 'Arraste os textos para reposicionar · Roda do mouse para aumentar/diminuir';
    this._banner.appendChild(label);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 Salvar e sair';
    saveBtn.style.cssText = `pointer-events:auto; cursor:pointer; background:#5a54f9; color:#fff; border:none; padding:6px 14px; border-radius:6px; font-size:13px; font-weight:600;`;
    saveBtn.addEventListener('click', () => { if (onSaveRequest) onSaveRequest(); });
    this._banner.appendChild(saveBtn);

    this.container.appendChild(this._banner);
  }

  exitEditMode() {
    this.editing = false;
    const overrides = {};
    for (const entry of this.textEntries) {
      entry.el.style.pointerEvents = '';
      entry.el.style.cursor = '';
      entry.el.style.outline = '';

      const left = parseFloat(entry.el.style.left);
      const top  = parseFloat(entry.el.style.top);
      const ox = left + entry.w / 2;
      const oy = this.designHeight - (top + entry.h / 2);
      overrides[entry.objName] = {
        origin: `${ox.toFixed(2)} ${oy.toFixed(2)} 0.00000`,
        fontSize: entry.fontSize,
      };
    }
    if (this._banner) { this._banner.remove(); this._banner = null; }
    return overrides;
  }

  _bindDragAndResize(entry) {
    const el = entry.el;

    el.addEventListener('mousedown', (e) => {
      if (!this.editing) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = parseFloat(el.style.left);
      const startTop  = parseFloat(el.style.top);

      const onMove = (me) => {
        const dx = (me.clientX - startX) / this._currentScale;
        const dy = (me.clientY - startY) / this._currentScale;
        el.style.left = (startLeft + dx) + 'px';
        el.style.top  = (startTop + dy) + 'px';
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    el.addEventListener('wheel', (e) => {
      if (!this.editing) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.5 : -1.5;
      entry.fontSize = Math.max(4, entry.fontSize + delta);
      el.style.fontSize = entry.fontSize + 'px';
    }, { passive: false });
  }

  _tick() {
    for (const entry of this.textEntries) {
      if (!entry.updateFn) continue;
      try {
        entry.value = entry.updateFn(entry.value);
        entry.el.textContent = entry.value;
      } catch (err) {
        console.warn('[we-scene] text update failed:', err.message);
      }
    }
  }

  resize() {
    if (this.stage) this._applyScale();
  }

  destroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    this.container.innerHTML = '';
    this.textEntries = [];
  }
}

module.exports = { WeScene, compileWeTextScript };
