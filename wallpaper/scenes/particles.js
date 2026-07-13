// Three.js particle field scene
const THREE = require('three/build/three.cjs');

class ParticlesScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = {
      count: options.count || 3000,
      color: options.color || '#4fc3f7',
      speed: options.speed || 0.3,
      size: options.size || 1.5,
    };
    this.animId = null;
  }

  start() {
    const { canvas, options } = this;
    const w = canvas.width, h = canvas.height;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, w / h, 0.1, 1000);
    this.camera.position.z = 80;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(options.count * 3);
    const velocities = new Float32Array(options.count * 3);

    for (let i = 0; i < options.count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 200;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 200;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 200;
      velocities[i * 3]     = (Math.random() - 0.5) * 0.02;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.02;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.02;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._velocities = velocities;
    this._positions = positions;
    this._posAttr = geometry.attributes.position;

    const material = new THREE.PointsMaterial({
      color: options.color,
      size: options.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.8,
    });

    this.points = new THREE.Points(geometry, material);
    this.scene.add(this.points);

    this._clock = new THREE.Clock();
    this._animate();
  }

  _animate() {
    this.animId = requestAnimationFrame(() => this._animate());
    const t = this._clock.getElapsedTime() * this.options.speed;
    const pos = this._posAttr.array;
    const vel = this._velocities;
    const count = this.options.count;

    for (let i = 0; i < count; i++) {
      pos[i * 3]     += vel[i * 3];
      pos[i * 3 + 1] += vel[i * 3 + 1];
      pos[i * 3 + 2] += vel[i * 3 + 2];
      // Wrap around
      if (pos[i * 3] > 100) pos[i * 3] = -100;
      if (pos[i * 3] < -100) pos[i * 3] = 100;
      if (pos[i * 3 + 1] > 100) pos[i * 3 + 1] = -100;
      if (pos[i * 3 + 1] < -100) pos[i * 3 + 1] = 100;
      if (pos[i * 3 + 2] > 100) pos[i * 3 + 2] = -100;
      if (pos[i * 3 + 2] < -100) pos[i * 3 + 2] = 100;
    }
    this._posAttr.needsUpdate = true;
    this.points.rotation.y = t * 0.05;
    this.points.rotation.x = t * 0.02;
    this.renderer.render(this.scene, this.camera);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
    this.renderer?.dispose();
  }
}

module.exports = ParticlesScene;
