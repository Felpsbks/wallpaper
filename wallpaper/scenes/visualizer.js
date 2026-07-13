// Audio visualizer — reacts to microphone / system audio via Web Audio API
class VisualizerScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = {
      color1:      options.color1      || '#4fc3f7',
      color2:      options.color2      || '#7c4dff',
      style:       options.style       || 'bars',   // bars | wave | circle
      sensitivity: options.sensitivity || 1.2,
    };
    this.animId = null;
    this._analyser = null;
    this._dataArray = null;
    this._demoMode = false;
    this._demoTime = 0;
  }

  async start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const actx = new AudioContext();
      const src = actx.createMediaStreamSource(stream);
      this._analyser = actx.createAnalyser();
      this._analyser.fftSize = 128;
      this._analyser.smoothingTimeConstant = 0.82;
      src.connect(this._analyser);
      this._dataArray = new Uint8Array(this._analyser.frequencyBinCount);
      this._actx = actx;
      this._stream = stream;
    } catch {
      this._demoMode = true;
    }
    this._loop();
  }

  _getData() {
    if (this._demoMode) {
      this._demoTime += 0.04;
      const len = 32;
      const arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const base = Math.abs(Math.sin(this._demoTime * 0.7 + i * 0.4)) * 0.7;
        const pulse = Math.abs(Math.sin(this._demoTime * 2.3)) * 0.3;
        arr[i] = (base + pulse) * 255 * this.options.sensitivity;
      }
      return arr;
    }
    if (this._analyser) {
      this._analyser.getByteFrequencyData(this._dataArray);
      return this._dataArray;
    }
    return new Uint8Array(0);
  }

  _loop() {
    this.animId = requestAnimationFrame(() => this._loop());
    const { canvas, ctx, options } = this;
    const W = canvas.width, H = canvas.height;
    const data = this._getData();
    const len = data.length;

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);

    const [r1, g1, b1] = hexToRgb(options.color1);
    const [r2, g2, b2] = hexToRgb(options.color2);

    if (options.style === 'bars') {
      const barW = W / len;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const val = Math.min(1, (data[i] / 255) * options.sensitivity);
        const barH = val * H * 0.85;
        const r = r1 + (r2 - r1) * t | 0;
        const g = g1 + (g2 - g1) * t | 0;
        const b = b1 + (b2 - b1) * t | 0;
        ctx.fillStyle = `rgba(${r},${g},${b},${0.6 + val * 0.4})`;
        ctx.fillRect(i * barW + 1, H - barH, barW - 2, barH);
        // Reflection
        ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
        ctx.fillRect(i * barW + 1, H, barW - 2, barH * 0.3);
      }
    } else if (options.style === 'wave') {
      ctx.lineWidth = 2.5;
      for (let line = 0; line < 2; line++) {
        ctx.beginPath();
        ctx.strokeStyle = line === 0 ? options.color1 : options.color2;
        ctx.globalAlpha = line === 0 ? 1 : 0.5;
        for (let i = 0; i < len; i++) {
          const x = (i / (len - 1)) * W;
          const norm = (data[i] / 128 - 1) * options.sensitivity;
          const y = H / 2 + norm * H * 0.35 * (line === 0 ? 1 : -0.6);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (options.style === 'circle') {
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) * 0.22;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.strokeStyle = options.color1;
      for (let i = 0; i <= len; i++) {
        const angle = (i / len) * Math.PI * 2 - Math.PI / 2;
        const val = Math.min(1, (data[i % len] / 255) * options.sensitivity);
        const r = R + val * R * 1.2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      // Inner circle
      ctx.beginPath();
      ctx.strokeStyle = options.color2;
      ctx.globalAlpha = 0.4;
      ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  resize(w, h) { this.canvas.width = w; this.canvas.height = h; }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
    this._stream?.getTracks().forEach(t => t.stop());
    this._actx?.close();
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

module.exports = VisualizerScene;
