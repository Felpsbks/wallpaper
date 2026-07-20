// Dev watcher: packs ASAR and restarts Electron on source file changes.
// This electron binary only registers built-in modules when loading from the ASAR.
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const electronExe = path.join(root, 'bin', 'electron.exe');
const packScript = path.join(__dirname, 'pack.js');

let electronProc = null;
let busy = false;

// Two `npm run dev` instances fighting over the same bin/electron.exe is a
// real, confirmed cause of "spawn UNKNOWN" (2026-07-18: user's first dev.js
// was still running — actively repacking/relaunching on file changes — when
// a second one was started in another terminal; the second one's rcedit
// icon-rebrand collided with the first one's still-live electron.exe file
// lock). Refuse to start a second instance instead of racing it.
const lockFile = path.join(os.tmpdir(), 'engine-wallpaper-dev.lock');
try {
  if (fs.existsSync(lockFile)) {
    const oldPid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
    let alive = false;
    try { process.kill(oldPid, 0); alive = true; } catch (_) { alive = false; }
    if (alive) {
      console.error(`[dev] Já tem um "npm run dev" rodando (PID ${oldPid}). Feche aquele terminal (Ctrl+C) antes de abrir outro — dois ao mesmo tempo travam o bin/electron.exe um do outro.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch (_) {} });
} catch (_) { /* lock best-effort — não bloqueia o dev se o temp dir falhar */ }

function pack() {
  console.log('\n[dev] Packing...');
  execSync(`node "${packScript}"`, { cwd: root, stdio: 'inherit' });
}

function killElectron() {
  return new Promise((resolve) => {
    try {
      const workerw = require('../src/workerw.js');
      workerw.setTaskbarVisible(true);
      workerw.setDesktopIconsVisible(true);
    } catch (e) {
      console.error('[dev] Falha ao restaurar barra de tarefas:', e);
    }
    
    if (!electronProc) return resolve();
    const proc = electronProc;
    proc.once('exit', () => resolve());
    try { process.kill(proc.pid); } catch (_) { resolve(); }
  });
}

// Right after pack.js rewrites bin/electron.exe in place (icon rebrand via
// rcedit), Windows Defender/AV often locks the freshly-modified .exe for a
// moment to scan it — spawning immediately can hit that window and fail
// with a generic "spawn UNKNOWN". spawn() reports that asynchronously via
// the 'error' event; without a listener here, Node treated it as an
// uncaught exception and killed the whole dev watcher (exactly the crash
// seen live 2026-07-18). Retrying a few times with a short backoff rides
// out the AV lock instead of crashing.
function startElectron(attempt = 1) {
  console.log('[dev] Launching...\n');
  const retry = (reason) => {
    if (attempt >= 5) {
      console.error(`[dev] Falha ao iniciar o Electron após ${attempt} tentativas: ${reason}`);
      return;
    }
    console.warn(`[dev] Falha ao iniciar o Electron (tentativa ${attempt}/5): ${reason} — tentando de novo em 500ms...`);
    setTimeout(() => startElectron(attempt + 1), 500);
  };

  // spawn() pode jogar exceção SÍNCRONA (não só o evento 'error' assíncrono
  // tratado abaixo) em certos casos no Windows — visto ao vivo 2026-07-18,
  // stack trace apontava direto pro spawn(), nunca chegando no .on('error').
  let proc;
  try {
    proc = spawn(electronExe, [], { cwd: root, stdio: 'inherit', detached: false });
  } catch (err) {
    retry(err.message);
    return;
  }
  electronProc = proc;
  proc.on('exit', () => { if (electronProc === proc) electronProc = null; });
  proc.on('error', (err) => {
    if (electronProc === proc) electronProc = null;
    retry(err.message);
  });
}

pack();
startElectron();

let debounce = null;
function onChange(filePath) {
  if (busy) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(async () => {
    busy = true;
    console.log(`\n[dev] Changed: ${path.relative(root, filePath)}`);
    try {
      // Precisa matar o Electron antigo e esperar ele soltar os addons
      // nativos (.node) ANTES de empacotar — senão o Windows ainda está
      // com o arquivo travado e o asar falha com EBUSY.
      await killElectron();
      pack();
      startElectron();
    } catch (e) { console.error('[dev] Error:', e.message); }
    busy = false;
  }, 500);
}

// Watch source files using chokidar (already in node_modules via electron-reload)
try {
  const chokidar = require('chokidar');
  const watchPaths = ['main.js', 'ui', 'src', 'wallpaper', 'assets']
    .map(p => path.join(root, p))
    .filter(p => fs.existsSync(p));
  const watcher = chokidar.watch(watchPaths, {
    ignored: /node_modules|\.asar/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400 },
  });
  watcher.on('all', (_, p) => onChange(p));
  console.log('[dev] Watching for changes (Ctrl+C to stop)...');
  process.on('SIGINT', () => {
    watcher.close();
    try {
      const workerw = require('../src/workerw.js');
      workerw.setTaskbarVisible(true);
      workerw.setDesktopIconsVisible(true);
    } catch (e) {}
    if (electronProc) try { process.kill(electronProc.pid); } catch (_) {}
    process.exit(0);
  });
} catch (e) {
  console.log('[dev] chokidar not available — run npm run pack + npm start to iterate manually.');
}
