// Win32 fullscreen detection — checks if foreground window covers a full display
const koffi = require('koffi');

let _api = null;

// Desktop-shell window classes that can legitimately become the foreground
// window and legitimately cover a full display (Progman/WorkerW's rect IS
// the whole screen by definition) without actually being a fullscreen "app"
// in any sense a user would recognize. Win+D ("show desktop") is the classic
// trigger: it makes Progman the foreground window, and without this check
// that gets misdetected as a fullscreen app, spuriously pausing the wallpaper
// every time Win+D is pressed. This existed unnoticed before the WebView2
// migration because the older Electron embedding bug made the whole wallpaper
// window disappear on Win+D anyway — a paused-but-still-visible frame is a
// new, more visible symptom of this same old bug, not a new one.
const DESKTOP_SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd']);

function loadAPIs() {
  if (_api) return _api;
  const u32 = koffi.load('user32.dll');
  koffi.struct('RECT_FS', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
  _api = {
    GetForegroundWindow: u32.func('void* GetForegroundWindow()'),
    GetWindowRect:       u32.func('bool GetWindowRect(void* hWnd, _Out_ RECT_FS* lpRect)'),
    IsIconic:            u32.func('bool IsIconic(void* hWnd)'),
    GetClassNameA:       u32.func('int GetClassNameA(void* hWnd, _Out_ char* lpClassName, int nMaxCount)'),
  };
  return _api;
}

function isFullscreenAppRunning(displays) {
  if (process.platform !== 'win32') return false;
  try {
    const api = loadAPIs();
    const hwnd = api.GetForegroundWindow();
    if (!hwnd) return false;
    if (api.IsIconic(hwnd)) return false;

    const classBuf = Buffer.alloc(256);
    const classLen = api.GetClassNameA(hwnd, classBuf, classBuf.length);
    const className = classLen > 0 ? classBuf.toString('utf8', 0, classLen) : '';
    if (DESKTOP_SHELL_CLASSES.has(className)) return false;

    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!api.GetWindowRect(hwnd, rect)) return false;
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    for (const d of displays) {
      if (w >= d.bounds.width && h >= d.bounds.height) return true;
    }
    return false;
  } catch { return false; }
}

module.exports = { isFullscreenAppRunning };
