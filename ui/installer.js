const { ipcRenderer } = require('electron');

const fill = document.getElementById('install-progress-fill');
const text = document.getElementById('install-progress-text');
const subtitle = document.getElementById('install-subtitle');
const info = document.getElementById('install-info');
const log = document.getElementById('install-log');

ipcRenderer.on('install-progress', (_, data) => {
  const pct = Math.max(0, Math.min(100, Math.round((data.pct || 0) * 100)));
  fill.style.width = pct + '%';
  text.textContent = pct + '%';
  if (data.subtitle) subtitle.textContent = data.subtitle;
  if (data.info) info.textContent = data.info;
});

ipcRenderer.on('install-log-line', (_, line) => {
  log.textContent += (log.textContent ? '\n' : '') + line;
  log.scrollTop = log.scrollHeight;
});
