// Aurora Borealis — Canvas 2D with layered gradient animation
class AuroraScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = {
      speed: options.speed || 0.5,
      colors: options.colors || ['#00ff88', '#0088ff', '#aa00ff', '#00ffee'],
    };
    this.animId = null;
    this._time = 0;
    this._layers = [];
  }

  start() {
    this._initLayers();
    this._animate();
  }

  _initLayers() {
    const colors = this.options.colors;
    this._layers = colors.map((color, i) => ({
      color,
      offset: (i / colors.length) * Math.PI * 2,
      amplitude: 80 + i * 30,
      frequency: 0.003 + i * 0.001,
      yBase: this.canvas.height * (0.3 + i * 0.1),
    }));
  }

  _animate() {
    this.animId = requestAnimationFrame(() => this._animate());
    this._time += 0.005 * this.options.speed;
    this._draw();
  }

  _draw() {
    const { ctx, canvas, _layers, _time } = this;
    const W = canvas.width, H = canvas.height;

    // Dark sky background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#000510');
    bg.addColorStop(1, '#001020');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Draw stars
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    if (!this._stars) {
      this._stars = Array.from({ length: 200 }, () => ({
        x: Math.random() * W,
        y: Math.random() * H * 0.6,
        r: Math.random() * 1.2,
        twinkle: Math.random() * Math.PI * 2,
      }));
    }
    for (const s of this._stars) {
      const alpha = 0.4 + 0.4 * Math.sin(_time * 2 + s.twinkle);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw aurora layers
    for (const layer of _layers) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      const gradient = ctx.createLinearGradient(0, layer.yBase - layer.amplitude, 0, layer.yBase + layer.amplitude * 2);
      gradient.addColorStop(0, 'transparent');
      gradient.addColorStop(0.3, layer.color + '44');
      gradient.addColorStop(0.5, layer.color + 'cc');
      gradient.addColorStop(0.7, layer.color + '44');
      gradient.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.moveTo(0, H);

      for (let x = 0; x <= W; x += 4) {
        const wave1 = Math.sin(x * layer.frequency + _time + layer.offset) * layer.amplitude;
        const wave2 = Math.sin(x * layer.frequency * 2.3 + _time * 1.5 + layer.offset) * layer.amplitude * 0.3;
        const y = layer.yBase + wave1 + wave2;
        ctx.lineTo(x, y);
      }

      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.restore();
    }
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this._stars = null;
    this._initLayers();
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
  }
}

module.exports = AuroraScene;
