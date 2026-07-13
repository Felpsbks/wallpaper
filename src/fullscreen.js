// Win32 fullscreen detection — checks if foreground window covers a full display
const koffi = require('koffi');

let _api = null;

function loadAPIs() {
  if (_api) return _api;
  const u32 = koffi.load('user32.dll');
  koffi.struct('RECT_FS', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
  _api = {
    GetForegroundWindow: u32.func('void* GetForegroundWindow()'),
    GetWindowRect:       u32.func('bool GetWindowRect(void* hWnd, _Out_ RECT_FS* lpRect)'),
    IsIconic:            u32.func('bool IsIconic(void* hWnd)'),
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
