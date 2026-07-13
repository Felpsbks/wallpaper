const path = require('path');
const fs = require('fs');
const os = require('os');

class Store {
  constructor() {
    const base = path.join(os.homedir(), '.engine-wallpaper');
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    this.filePath = path.join(base, 'config.json');
    this._data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch (_) {}
    return {};
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[store] Save error:', err.message);
    }
  }

  get(key) {
    return this._data[key];
  }

  set(key, value) {
    this._data[key] = value;
    this._save();
  }

  delete(key) {
    delete this._data[key];
    this._save();
  }
}

module.exports = Store;
