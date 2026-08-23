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
    } catch (err) {
      // JSON corrompido (ex: queda de energia no meio de uma escrita antiga,
      // antes do rename atômico acima existir) — guarda uma cópia antes de
      // resetar pra {}, em vez de destruir a evidência silenciosamente. Não
      // tenta recuperar automaticamente (arquivo truncado pode não ter jeito
      // de recuperar de forma confiável), só preserva pra inspeção manual.
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.corrupted-' + Date.now());
      } catch (_) {}
      console.error('[store] config.json corrompido, resetando (backup salvo):', err.message);
    }
    return {};
  }

  // Escreve num arquivo temporário e troca com rename() — atômico no mesmo
  // volume, então uma queda de luz no meio da escrita nunca deixa o
  // config.json real truncado. Bug real encontrado: writeFileSync direto no
  // arquivo final deixava uma janela onde uma queda de energia corrompia o
  // JSON; _load() então falhava o parse e resetava TUDO pra {} (perdendo
  // machineId + licença), forçando reativação que falhava com
  // "chave em uso em outro PC" (o servidor ainda lembrava do machineId
  // antigo). Ver license-server/store.js's validateKey.
  _save() {
    try {
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this._data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
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
