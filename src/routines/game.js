const { matchesProcess } = require('./_processMatch');

// Rotina de Jogo: ativa enquanto o processo configurado (ex: "valorant.exe")
// está rodando. Prioridade alta por padrão — jogos costumam ser a intenção
// mais específica do usuário no momento.
module.exports = {
  type: 'game',
  label: 'Jogo em execução',
  defaultPriority: 90,

  evaluate(routine, context) {
    return matchesProcess(routine.config, context);
  },

  validateConfig(config) {
    if (!config || !config.exe || !String(config.exe).trim()) {
      return { ok: false, msg: 'Informe o nome do processo (ex: valorant.exe).' };
    }
    return { ok: true };
  },
};
