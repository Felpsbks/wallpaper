const TRIGGERS = require('./index');

// Motor único de Playlists + Rotinas. Substitui o timer do antigo
// src/playlist.js e o startTimeRulesMonitor de main.js. A cada tick:
// avalia toda rotina habilitada contra o `context` compartilhado, resolve
// por prioridade, aplica a playlist vencedora (com pilha de estado anterior
// pra "voltar pra rotina anterior" quando o gatilho de maior prioridade
// termina) e, se houver uma rotina de Intervalo ativa na playlist vencedora,
// cuida da rotação interna dela.
class RoutineEngine {
  constructor(store, sendToAllWallpapers, controlWinGetter, appLog) {
    this.store = store;
    this.sendToAllWallpapers = sendToAllWallpapers;
    this.getControlWin = controlWinGetter;
    this.appLog = appLog || Object.assign(() => {}, { err: () => {} });
    this.stack = []; // [{playlistId, routineId}, ...] — estado anterior, do mais antigo pro mais recente
    this.currentPlaylistId = null;
    this.currentRoutineId = null;
  }

  _routines() {
    return (this.store.get('routines') || []).filter(r => r.enabled);
  }

  _playlists() {
    return this.store.get('smartPlaylists') || [];
  }

  _resolvePlaylist(playlistId) {
    return this._playlists().find(p => p.id === playlistId) || null;
  }

  _playlistHasItems(playlist) {
    return !!(playlist && Array.isArray(playlist.wallpaperIds) && playlist.wallpaperIds.length > 0);
  }

  _safeEvaluate(trigger, routine, context) {
    try {
      return !!trigger.evaluate(routine, context);
    } catch (err) {
      this.appLog.err(`[routines] Erro avaliando rotina ${routine.id} (${routine.type}): ${err.message}`);
      return false;
    }
  }

  // Ação manual "Aplicar agora" — o mesmo caminho que a arbitração usa, mas
  // disparado direto pelo botão de play do card, sem esperar o próximo tick.
  applyPlaylistNow(playlistId) {
    const playlist = this._resolvePlaylist(playlistId);
    if (!this._playlistHasItems(playlist)) return false;
    this._applyPlaylist(playlist, null);
    this.currentPlaylistId = playlist.id;
    this.currentRoutineId = null;
    return true;
  }

  _pickWallpaper(playlist) {
    const library = this.store.get('library') || [];
    const stats = playlist.stats || {};
    const lastId = stats.lastWallpaperId;
    const idx = lastId ? playlist.wallpaperIds.indexOf(lastId) : -1;
    const nextId = playlist.wallpaperIds[(idx + 1) % playlist.wallpaperIds.length] || playlist.wallpaperIds[0];
    return library.find(w => w.id === nextId) || null;
  }

  _pickWallpaperRandom(playlist) {
    const library = this.store.get('library') || [];
    const ids = playlist.wallpaperIds;
    const id = ids[Math.floor(Math.random() * ids.length)];
    return library.find(w => w.id === id) || null;
  }

  _bumpStats(playlistId, wallpaperId, extra) {
    const playlists = this._playlists();
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx === -1) return;
    const p = playlists[idx];
    const now = Date.now();
    p.stats = {
      ...(p.stats || {}),
      lastWallpaperId: wallpaperId,
      lastAppliedAt: now,
      switchCount: ((p.stats && p.stats.switchCount) || 0) + 1,
      activeSinceMs: (p.stats && p.stats.activeSinceMs) || now,
      ...(extra || {}),
    };
    playlists[idx] = p;
    this.store.set('smartPlaylists', playlists);
  }

  _clearActiveSince(playlistId) {
    const playlists = this._playlists();
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx === -1) return;
    playlists[idx] = { ...playlists[idx], stats: { ...(playlists[idx].stats || {}), activeSinceMs: null } };
    this.store.set('smartPlaylists', playlists);
  }

  _applyPlaylist(playlist, routine) {
    const wallpaper = this._pickWallpaper(playlist);
    if (!wallpaper) return;
    this.store.set('current', wallpaper);
    this.sendToAllWallpapers('set-wallpaper', wallpaper);
    const controlWin = this.getControlWin && this.getControlWin();
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('wallpaper-changed', wallpaper);
      controlWin.webContents.send('playlist-changed', { playlistId: playlist.id, routineId: routine ? routine.id : null });
    }
    this._bumpStats(playlist.id, wallpaper.id, { lastRotationAt: Date.now() });
  }

  tick(context) {
    const allRoutines = this._routines();
    // Em modo restrito (screensaver/config) só a rotação de Intervalo continua
    // — gatilhos de Horário/Semana/Mês/Jogo/Aplicativo ficam em espera, igual
    // ao comportamento antigo (fullscreen/time-rules não rodavam nesses modos).
    const routines = context.restrictedMode ? allRoutines.filter(r => r.type === 'interval') : allRoutines;
    if (routines.length === 0) return;

    const evaluated = routines.map(r => ({
      routine: r,
      active: TRIGGERS[r.type] ? this._safeEvaluate(TRIGGERS[r.type], r, context) : false,
    }));

    const candidates = evaluated
      .filter(e => e.active)
      .map(e => ({ ...e, playlist: this._resolvePlaylist(e.routine.playlistId) }))
      .filter(e => this._playlistHasItems(e.playlist));

    candidates.sort((a, b) => b.routine.priority - a.routine.priority || a.routine.id.localeCompare(b.routine.id));
    const winner = candidates[0] || null;
    const winningPlaylistId = winner ? winner.playlist.id : null;

    if (winningPlaylistId !== this.currentPlaylistId) {
      if (this.currentPlaylistId) {
        this.stack.push({ playlistId: this.currentPlaylistId, routineId: this.currentRoutineId });
        this._clearActiveSince(this.currentPlaylistId);
      }
      const idx = this.stack.findIndex(s => s.playlistId === winningPlaylistId);
      if (idx !== -1) this.stack.splice(idx);

      if (winner) this._applyPlaylist(winner.playlist, winner.routine);
      this.currentPlaylistId = winningPlaylistId;
      this.currentRoutineId = winner ? winner.routine.id : null;
    }

    // Rotação de Intervalo dentro da playlist vencedora (independente de qual
    // rotina venceu a prioridade — mesmo uma playlist ganha por Horário pode
    // ter uma rotina de Intervalo própria rodando junto).
    const intervalRoutine = routines.find(r => r.type === 'interval' && r.playlistId === winningPlaylistId);
    if (intervalRoutine && winner) {
      const stats = winner.playlist.stats || {};
      const dueAt = (stats.lastRotationAt || stats.lastAppliedAt || 0) + (intervalRoutine.config.seconds * 1000);
      if (context.now.getTime() >= dueAt) {
        const wallpaper = intervalRoutine.config.mode === 'random'
          ? this._pickWallpaperRandom(winner.playlist)
          : this._pickWallpaper(winner.playlist);
        if (wallpaper) {
          this.store.set('current', wallpaper);
          this.sendToAllWallpapers('set-wallpaper', wallpaper);
          const controlWin = this.getControlWin && this.getControlWin();
          if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('wallpaper-changed', wallpaper);
          this._bumpStats(winner.playlist.id, wallpaper.id, { lastRotationAt: Date.now() });
        }
      }
    }
  }
}

module.exports = RoutineEngine;
