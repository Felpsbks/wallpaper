const { ipcRenderer } = require('electron');

const keyInput = document.getElementById('key');
const submitBtn = document.getElementById('submit');
const msg = document.getElementById('msg');

const REASON_MESSAGES = {
  not_found: 'Chave inválida.',
  revoked: 'Esta chave foi revogada.',
  expired: 'Esta chave expirou.',
  machine_mismatch: 'Esta chave já está em uso em outro computador.',
  network_error: 'Não foi possível conectar ao servidor de licenças. Verifique sua internet.',
  invalid: 'Chave inválida.',
};

async function submit() {
  const key = keyInput.value.trim().toUpperCase();
  if (!key) return;

  submitBtn.disabled = true;
  msg.textContent = '';

  const result = await ipcRenderer.invoke('license-activate', key);
  if (!result.ok) {
    msg.textContent = REASON_MESSAGES[result.reason] || 'Não foi possível ativar. Tente novamente.';
    submitBtn.disabled = false;
  }
  // on success, the main process closes this window itself
}

submitBtn.addEventListener('click', submit);
keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
