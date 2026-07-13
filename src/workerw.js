const koffi = require('koffi');

let user32 = null;
let FindWindowA, FindWindowExA, SendMessageTimeoutA, SetParent, EnumWindows, EnumWindowsCb;

function loadUser32() {
  if (user32) return true;
  try {
    user32 = koffi.load('user32.dll');

    EnumWindowsCb = koffi.proto('EnumWindowsCb', 'bool __stdcall (void* hWnd, intptr_t lParam)');

    FindWindowA = user32.func('void* FindWindowA(const char* lpClassName, const char* lpWindowName)');
    FindWindowExA = user32.func('void* FindWindowExA(void* hwndParent, void* hwndChildAfter, const char* lpszClass, const char* lpszWindow)');
    SendMessageTimeoutA = user32.func('intptr_t SendMessageTimeoutA(void* hWnd, uint Msg, uintptr_t wParam, intptr_t lParam, uint fuFlags, uint uTimeout, _Out_ uint* lpdwResult)');
    SetParent = user32.func('void* SetParent(void* hWndChild, void* hWndNewParent)');
    EnumWindows = user32.func('bool EnumWindows(EnumWindowsCb* lpEnumFunc, intptr_t lParam)');

    return true;
  } catch (err) {
    console.error('[workerw] Failed to load user32:', err.message);
    return false;
  }
}

function embedBehindDesktop(hwndBuffer) {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;

  try {
    // Find Progman (desktop shell window)
    const progman = FindWindowA('Progman', null);
    if (!progman) {
      console.error('[workerw] Progman not found');
      return false;
    }

    // Send 0x052C to Progman — spawns a WorkerW between desktop and icons
    const smResult = [0];
    SendMessageTimeoutA(progman, 0x052C, 0, 0, 0, 1000, smResult);

    // Enumerate top-level windows to find WorkerW that sits after SHELLDLL_DefView
    let workerW = null;

    const callback = koffi.register((hwnd, _lParam) => {
      const defView = FindWindowExA(hwnd, null, 'SHELLDLL_DefView', null);
      if (defView) {
        // The WorkerW we want is the NEXT sibling after this window
        workerW = FindWindowExA(null, hwnd, 'WorkerW', null);
      }
      return true;
    }, koffi.pointer(EnumWindowsCb));

    EnumWindows(callback, 0);
    koffi.unregister(callback);

    if (!workerW) {
      console.error('[workerw] Target WorkerW not found');
      return false;
    }

    // Re-parent our BrowserWindow under WorkerW
    SetParent(hwndBuffer, workerW);
    console.log('[workerw] Successfully embedded behind desktop');
    return true;
  } catch (err) {
    console.error('[workerw] Error:', err.message);
    return false;
  }
}

module.exports = { embedBehindDesktop };
