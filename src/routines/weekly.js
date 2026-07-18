// Rotina de Dia da Semana: ativa quando o dia atual (0=Domingo..6=Sábado,
// igual ao Date.getDay() nativo do JS) está na lista de dias configurados.
module.exports = {
  type: 'weekly',
  label: 'Dia da semana',
  defaultPriority: 50,

  evaluate(routine, context) {
    const days = (routine.config || {}).days;
    if (!Array.isArray(days) || days.length === 0) return false;
    return days.includes(context.dayOfWeek);
  },

  validateConfig(config) {
    if (!config || !Array.isArray(config.days) || config.days.length === 0) {
      return { ok: false, msg: 'Escolha pelo menos um dia da semana.' };
    }
    return { ok: true };
  },
};
