// Dev watcher: packs ASAR and restarts Electron on source file changes.
// This electron binary only registers built-in modules when loading from the ASAR.
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const electronExe = path.join(root, 'bin', 'electron.exe');
const packScript = path.join(__dirname, 'pack.js');

let electronProc = null;
let busy = false;

function pack() {
  console.log('\n[dev] Packing...');
  execSync(`node "${packScript}"`, { cwd: root, stdio: 'inherit' });
}

function killElectron() {
  return new Promise((resolve) => {
    if (!electronProc) return resolve();
    const proc = electronProc;
    proc.once('exit', () => resolve());
    try { process.kill(proc.pid); } catch (_) { resolve(); }
  });
}

function startElectron() {
  console.log('[dev] Launching...\n');
  electronProc = spawn(electronExe, [], { cwd: root, stdio: 'inherit', detached: false });
  electronProc.on('exit', () => { electronProc = null; });
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
    if (electronProc) try { process.kill(electronProc.pid); } catch (_) {}
    process.exit(0);
  });
} catch (e) {
  console.log('[dev] chokidar not available — run npm run pack + npm start to iterate manually.');
}
