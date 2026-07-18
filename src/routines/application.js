const { matchesProcess } = require('./_processMatch');

// Rotina de Aplicativo: mesma mecânica de Jogo (processo em execução), mas
// pensada pra apps de produtividade (Photoshop, Spotify, VS Code...) — por
// isso um módulo próprio em vez de reaproveitar "game" diretamente, mesmo
// com a lógica de match idêntica (ver _processMatch.js).
module.exports = {
  type: 'application',
  label: 'Aplicativo em execução',
  defaultPriority: 100,

  evaluate(routine, context) {
    return matchesProcess(routine.config, context);
  },

  validateConfig(config) {
    if (!config || !config.exe || !String(config.exe).trim()) {
      return { ok: false, msg: 'Informe o nome do processo (ex: photoshop.exe).' };
    }
    return { ok: true };
  },
};
