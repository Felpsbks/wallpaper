// Matrix digital rain — Canvas 2D, no external deps
class MatrixScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = {
      color: options.color || '#00ff41',
      bgAlpha: options.bgAlpha || 0.05,
      fontSize: options.fontSize || 14,
      speed: options.speed || 1,
    };
    this.animId = null;
    this._drops = [];
    this._chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';
  }

  start() {
    this._setup();
    this._lastTime = 0;
    this._interval = 33 / (this.options.speed || 1);
    this._animate(0);
  }

  _setup() {
    const { canvas, options } = this;
    const cols = Math.floor(canvas.width / options.fontSize);
    this._drops = Array.from({ length: cols }, () => Math.random() * -canvas.height);
    this._cols = cols;
  }

  _animate(now) {
    this.animId = requestAnimationFrame((t) => this._animate(t));
    if (now - this._lastTime < this._interval) return;
    this._lastTime = now;

    const { ctx, canvas, options, _chars } = this;
    const fs = options.fontSize;

    // Fade effect
    ctx.fillStyle = `rgba(0,0,0,${options.bgAlpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = options.color;
    ctx.font = `${fs}px monospace`;

    for (let i = 0; i < this._cols; i++) {
      const char = _chars[Math.floor(Math.random() * _chars.length)];
      const x = i * fs;
      const y = this._drops[i];
      ctx.fillText(char, x, y);

      // Bright head character
      ctx.fillStyle = '#ffffff';
      ctx.fillText(char, x, y);
      ctx.fillStyle = options.color;

      if (y > canvas.height && Math.random() > 0.975) {
        this._drops[i] = 0;
      }
      this._drops[i] += fs;
    }
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this._setup();
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
  }
}

module.exports = MatrixScene;
