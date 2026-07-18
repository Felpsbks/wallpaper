// Rotina de Horário: ativa quando o horário atual (HH:MM) cai dentro de um
// intervalo [start, end). Suporta intervalo que cruza a meia-noite (ex:
// 22:00–06:00) comparando por OR em vez de AND.
module.exports = {
  type: 'time',
  label: 'Horário fixo',
  defaultPriority: 60,

  evaluate(routine, context) {
    const { start, end } = routine.config || {};
    if (!start || !end) return false;
    if (start <= end) return context.hhmm >= start && context.hhmm < end;
    return context.hhmm >= start || context.hhmm < end;
  },

  validateConfig(config) {
    if (!config || !config.start || !config.end) return { ok: false, msg: 'Defina o horário de início e fim.' };
    return { ok: true };
  },
};
