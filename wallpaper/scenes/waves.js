// Three.js wave plane scene
const THREE = require('three/build/three.cjs');

class WavesScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = {
      color1: options.color1 || '#0077ff',
      color2: options.color2 || '#00ffcc',
      speed: options.speed || 1.0,
      amplitude: options.amplitude || 2.0,
    };
    this.animId = null;
  }

  start() {
    const { canvas, options } = this;
    const w = canvas.width, h = canvas.height;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000a1a);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000a1a, 0.02);

    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 500);
    this.camera.position.set(0, 30, 60);
    this.camera.lookAt(0, 0, 0);

    // Multiple wave planes
    this._planes = [];
    for (let k = 0; k < 3; k++) {
      const geo = new THREE.PlaneGeometry(200, 200, 80, 80);
      const mat = new THREE.MeshBasicMaterial({
        color: k === 0 ? options.color1 : options.color2,
        wireframe: true,
        transparent: true,
        opacity: k === 0 ? 0.6 : 0.3 - k * 0.05,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = -k * 3;
      this.scene.add(mesh);
      this._planes.push({ mesh, geo });
    }

    this._clock = new THREE.Clock();
    this._animate();
  }

  _animate() {
    this.animId = requestAnimationFrame(() => this._animate());
    const t = this._clock.getElapsedTime() * this.options.speed;
    const amp = this.options.amplitude;

    for (const { geo } of this._planes) {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = Math.sin(x * 0.1 + t) * amp + Math.cos(y * 0.1 + t * 0.7) * amp * 0.5;
        pos.setZ(i, z);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }

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

module.exports = WavesScene;
