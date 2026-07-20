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
  let stopCausedByPerformanceMode = false;

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
        if (settings.pauseOnFullscreen) {
          // "Modo Desempenho": em vez de só pausar (que mantém vídeo/textura/
          // partículas carregados na RAM/VRAM o tempo todo), descarrega tudo
          // de verdade — reaproveita o mesmo 'stop'/'unstop' já usado pelas
          // App Rules ("Parar (Economiza RAM/GPU)", ver wallpaper.js's
          // hideAll()/unstop). Troca velocidade de retomada (recarrega do
          // zero) por RAM/VRAM realmente livres durante o jogo.
          if (settings.performanceModeFullscreen) { rulesActive.stop = true; stopCausedByPerformanceMode = true; }
          else rulesActive.pause = true;
        }
        if (settings.muteOnFullscreen) rulesActive.mute = true;
      }
    } catch {}
  }

  // Pausa manual do painel sempre vence, independente do que as regras calcularam.
  if (manualPause) rulesActive.pause = true;

  const vol = settings.volume ?? 50;

  if (rulesActive.stop !== _appState.stop) {
    sendToAllWallpapers(rulesActive.stop ? 'stop' : 'unstop');
    // Card nativo (notificação do Windows) avisando que o Modo Desempenho
    // ligou — só faz sentido mostrar aqui (nunca dá tempo de aparecer algo
    // desenhado no PRÓPRIO wallpaper, já que ele fica atrás do jogo em
    // tela cheia segundos depois) e só quando é ESTE gatilho específico
    // (não quando uma App Rule manual "Parar" já configurada pelo usuário
    // dispara — esse já é um comportamento esperado por ele).
    if (rulesActive.stop && stopCausedByPerformanceMode) {
      try {
        const { Notification } = require('electron');
        if (Notification.isSupported()) {
          new Notification({
            title: 'Modo Desempenho ativado',
            body: 'Papel de parede descarregado da memória enquanto o jogo estiver em tela cheia.',
            silent: true,
          }).show();
        }
      } catch {}
    }
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
