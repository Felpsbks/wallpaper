// Sistema de nível cosmético (pedido do usuário: "não vale nada esses
// nível", é só um indicador de engajamento, sem recompensa real). Regra:
// >= 4h de app rodando NO DIA (soma de todas as sessões daquele dia, não
// precisa ser contínuo) = +1 nível; menos que isso (incluindo dia em que
// nunca abriu) = -1, com piso em 0. Guardado em store.get('levelSystem').
const ACTIVE_GOAL_MS = 4 * 60 * 60 * 1000; // 4h

function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Diferença em dias de calendário inteiros entre duas datas 'YYYY-MM-DD'.
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}

function getLevelState(store) {
  return store.get('levelSystem') || { level: 0, activeDate: todayStr(), activeMs: 0 };
}

// Chamado a cada tick (2s, mesmo intervalo do system-stats) enquanto o
// processo principal está vivo. `deltaMs` normalmente é o próprio período
// do tick — soma no dia corrente e, ao perceber virada de data (inclusive
// vários dias pulados de uma vez, se o app ficou fechado por um tempo),
// fecha o(s) dia(s) anterior(es) aplicando a regra acima antes de zerar.
function tickLevelSystem(store, deltaMs) {
  const state = getLevelState(store);
  const today = todayStr();

  if (state.activeDate !== today) {
    if (state.activeMs >= ACTIVE_GOAL_MS) state.level += 1;
    else state.level = Math.max(0, state.level - 1);

    // Dias inteiros no meio em que o app nunca abriu (zero registro) — cada
    // um desconta 1, também com piso em 0.
    const gap = daysBetween(state.activeDate, today) - 1;
    if (gap > 0) state.level = Math.max(0, state.level - gap);

    state.activeDate = today;
    state.activeMs = 0;
  }

  state.activeMs += deltaMs;
  store.set('levelSystem', state);
  return state;
}

module.exports = { tickLevelSystem, getLevelState, ACTIVE_GOAL_MS };
