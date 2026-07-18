// Extraído de main.js (antigo startFullscreenMonitor). Reconciliação de
// pausa/muta/stop do wallpaper — um eixo totalmente separado de "qual
// wallpaper está mostrando" (isso é responsabilidade do RoutineEngine). As
// duas coisas só compartilham o mesmo tick de 2s pra não rodar dois timers
// e não executar `tasklist` duas vezes por ciclo.
let _appState = { pause: false, mute: false, stop: false };

function appRulesNeedProcesses(store) {
  const settings = store.get('settings') || {};
  return !!(settings.appRules && settings.appRules.length > 0);
}

function reconcilePlaybackControls(store, sendToAllWallpapers, context, manualPause) {
  const settings = store.get('settings') || {};
  let rulesActive = { pause: false, mute: false, stop: false };

  // 1. App Rules
  if (settings.appRules && settings.appRules.length > 0 && context.runningProcesses) {
    for (const rule of settings.appRules) {
      if (context.runningProcesses.includes(String(rule.exe).toLowerCase())) {
        if (rule.action === 'pause') rulesActive.pause = true;
        if (rule.action === 'mute') rulesActive.mute = true;
        if (rule.action === 'stop') rulesActive.stop = true;
      }
    }
  }

  // 2. Fullscreen Rules
  if (settings.pauseOnFullscreen || settings.muteOnFullscreen) {
    try {
      const { screen } = require('electron');
      const { isFullscreenAppRunning } = require('./fullscreen');
      const isFs = isFullscreenAppRunning(screen.getAllDisplays());
      if (isFs) {
        if (settings.pauseOnFullscreen) rulesActive.pause = true;
        if (settings.muteOnFullscreen) rulesActive.mute = true;
      }
    } catch {}
  }

  // Pausa manual do painel sempre vence, independente do que as regras calcularam.
  if (manualPause) rulesActive.pause = true;

  const vol = settings.volume ?? 50;

  if (rulesActive.stop !== _appState.stop) {
    sendToAllWallpapers(rulesActive.stop ? 'stop' : 'unstop');
  }
  if (!rulesActive.stop) {
    if (rulesActive.pause !== _appState.pause) {
      sendToAllWallpapers(rulesActive.pause ? 'pause' : 'resume');
    }
  }
  if (rulesActive.mute !== _appState.mute) {
    sendToAllWallpapers(rulesActive.mute ? 'mute' : 'unmute', vol);
  }

  _appState = rulesActive;
}

function getAppState() { return _appState; }
function setAppStatePause(pause) { _appState.pause = pause; }

module.exports = { reconcilePlaybackControls, appRulesNeedProcesses, getAppState, setAppStatePause };
