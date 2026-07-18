// Rotina de Intervalo: fica "ativa" o tempo todo enquanto habilitada — ela é
// o gatilho de fundo (baixa prioridade) que qualquer outra rotina pode
// sobrepor. A rotação em si (qual wallpaper mostrar e quando avançar dentro
// da playlist vencedora) é feita pelo RoutineEngine, não aqui — evaluate()
// só decide SE a playlist dela concorre, não QUAL item dela é mostrado.
module.exports = {
  type: 'interval',
  label: 'Intervalo',
  defaultPriority: 30,

  evaluate(routine) {
    return !!(routine.config && routine.config.seconds > 0);
  },

  validateConfig(config) {
    if (!config || !(config.seconds > 0)) return { ok: false, msg: 'Defina um intervalo em segundos maior que zero.' };
    if (config.mode && !['sequential', 'random'].includes(config.mode)) {
      return { ok: false, msg: 'Modo inválido (use "sequential" ou "random").' };
    }
    return { ok: true };
  },
};
