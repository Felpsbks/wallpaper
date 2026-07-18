// Rotina Mensal: ativa quando o mês atual (0=Janeiro..11=Dezembro, igual ao
// Date.getMonth() nativo do JS) está na lista de meses configurados.
module.exports = {
  type: 'monthly',
  label: 'Mês do ano',
  defaultPriority: 45,

  evaluate(routine, context) {
    const months = (routine.config || {}).months;
    if (!Array.isArray(months) || months.length === 0) return false;
    return months.includes(context.month);
  },

  validateConfig(config) {
    if (!config || !Array.isArray(config.months) || config.months.length === 0) {
      return { ok: false, msg: 'Escolha pelo menos um mês.' };
    }
    return { ok: true };
  },
};
