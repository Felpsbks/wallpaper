// Migração única (guardada por store.get('routinesMigrated')) das antigas
// "Regras de Horário" (timeRules) e "Playlist (Modo Automático)"
// (playlistConfig) pro novo sistema de Playlists+Rotinas. "Regras de
// Aplicativos" (settings.appRules) NÃO migra — continua sendo só
// pausa/muta/stop, natureza diferente de troca de wallpaper.
function run(store, appLog) {
  if (store.get('routinesMigrated')) return;

  const playlists = store.get('smartPlaylists') || [];
  const routines = store.get('routines') || [];
  const library = store.get('library') || [];
  let migratedAnything = false;

  // ---- timeRules → 1 playlist de 1 item + rotina "time" com range até a próxima ----
  const timeRules = store.get('timeRules') || [];
  if (timeRules.length > 0) {
    const sorted = [...timeRules].sort((a, b) => a.time.localeCompare(b.time));
    sorted.forEach((rule, i) => {
      const wallpaper = library.find(w => w.id === rule.wallpaperId);
      if (!wallpaper) return;
      const nextRule = sorted[(i + 1) % sorted.length];
      const end = nextRule.time;
      const playlistId = `${Date.now()}${i}`;
      playlists.push({
        id: playlistId,
        name: wallpaper.name || `Horário ${rule.time}`,
        description: 'Migrado automaticamente da antiga Regra de Horário.',
        color: '#7c3aed',
        icon: '⏰',
        wallpaperIds: [wallpaper.id],
        createdAt: Date.now(),
        stats: { lastWallpaperId: null, lastAppliedAt: null, lastRotationAt: null, switchCount: 0, activeSinceMs: null },
      });
      routines.push({
        id: `${Date.now()}${i}t`,
        playlistId,
        type: 'time',
        enabled: true,
        priority: 60,
        config: { start: rule.time, end },
      });
      migratedAnything = true;
    });
    if (appLog) appLog(`[migração] ${sorted.length} regra(s) de horário migrada(s) para Playlists+Rotinas.`);
  }

  // ---- playlistConfig → 1 playlist "Toda a Biblioteca (migrado)" + rotina "interval" ----
  const playlistConfig = store.get('playlistConfig');
  if (playlistConfig && library.length > 0) {
    const playlistId = `${Date.now()}pl`;
    playlists.push({
      id: playlistId,
      name: 'Toda a Biblioteca (migrado)',
      description: 'Migrado automaticamente do antigo modo automático. Novos wallpapers adicionados à biblioteca não entram aqui sozinhos — edite a playlist pra incluí-los.',
      color: '#c084fc',
      icon: '🔀',
      wallpaperIds: library.map(w => w.id),
      createdAt: Date.now(),
      stats: { lastWallpaperId: null, lastAppliedAt: null, lastRotationAt: null, switchCount: 0, activeSinceMs: null },
    });
    routines.push({
      id: `${Date.now()}iv`,
      playlistId,
      type: 'interval',
      enabled: !!playlistConfig.enabled,
      priority: 30,
      config: { seconds: playlistConfig.interval || 30, mode: playlistConfig.shuffle ? 'random' : 'sequential' },
    });
    migratedAnything = true;
    if (appLog) appLog('[migração] Modo automático de playlist migrado para Playlists+Rotinas.');
  }

  if (migratedAnything) {
    store.set('smartPlaylists', playlists);
    store.set('routines', routines);
  }
  store.set('routinesMigrated', true);
}

module.exports = { run };
