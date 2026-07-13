const { EventEmitter } = require('events');

class Playlist extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.timer = null;
    this.index = 0;
    this.config = store.get('playlistConfig') || { enabled: false, interval: 30, shuffle: false };
  }

  configure(config) {
    this.config = config;
    this.stop();
    if (config.enabled) this.start();
  }

  start() {
    if (!this.config.enabled) return;
    this.stop();
    const ms = (this.config.interval || 30) * 1000;
    this.timer = setInterval(() => this.next(), ms);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  next() {
    const library = this.store.get('library') || [];
    if (library.length === 0) return;

    if (this.config.shuffle) {
      const idx = Math.floor(Math.random() * library.length);
      this.emit('change', library[idx]);
    } else {
      this.index = (this.index + 1) % library.length;
      this.emit('change', library[this.index]);
    }
  }

  previous() {
    const library = this.store.get('library') || [];
    if (library.length === 0) return;
    this.index = (this.index - 1 + library.length) % library.length;
    this.emit('change', library[this.index]);
  }
}

module.exports = Playlist;
