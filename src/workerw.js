const koffi = require('koffi');

let user32 = null;
let shell32 = null;
let FindWindowA, FindWindowExA, SendMessageTimeoutA, SetParent, SetWindowPos, EnumWindows, EnumWindowsCb, SystemParametersInfoW, GetWindowLongA, SetWindowLongA, GetParent, IsIconic, IsWindowVisible, ShowWindow, PostMessageA;
let SHAppBarMessage;

// AppBar constants
const ABM_GETSTATE = 4;
const ABM_SETSTATE = 10;
const ABS_AUTOHIDE = 1;
const ABS_ALWAYSONTOP = 2;

let originalTaskbarState = null;

// Confirmado ao vivo (2026-07-21, PC com 2 monitores): as duas janelas de
// wallpaper (uma por monitor) eram posicionadas relativas ao MESMO ponto
// (shellDllDefView) na ordem de empilhamento — as duas competindo pela
// posição exata de "logo atrás dos ícones". Quem se encaixava por último
// "roubava" essa posição da outra, deixando só uma tela funcionando por vez
// (e trocando qual, dependendo da ordem/timing). Encadear cada janela nova
// atrás da anterior (em vez de sempre atrás do DefView) dá uma posição
// própria pra cada uma, sem conflito — todas continuam atrás dos ícones de
// qualquer forma, a ordem relativa entre elas não importa.
let _lastEmbeddedWallpaperHwnd = null;

const RECT = koffi.struct('RECT', {
  left: 'int', top: 'int', right: 'int', bottom: 'int'
});

const APPBARDATA = koffi.struct('APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'void*',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: RECT,
  lParam: 'intptr_t'
});

// SetWindowPos flags/constants (winuser.h)
const HWND_BOTTOM     = 1;
const SWP_NOSIZE      = 0x0001;
const SWP_NOMOVE      = 0x0002;
const SWP_NOACTIVATE  = 0x0010;

// Window style constants (winuser.h)
const GWL_STYLE = -16;
const WS_CHILD  = 0x40000000;

// SystemParametersInfo constants (winuser.h)
const SPI_SETDESKWALLPAPER = 0x0014;
const SPIF_UPDATEINIFILE   = 0x01;
const SPIF_SENDCHANGE      = 0x02;

// ShowWindow constants (winuser.h)
const SW_HIDE = 0;
const SW_SHOW = 5;

// WM_DISPLAYCHANGE broadcast (winuser.h) — see forceDisplayChangeBroadcast() below.
const WM_DISPLAYCHANGE = 0x007E;
const HWND_BROADCAST = 0xffff;

function loadUser32() {
  if (user32) return true;
  try {
    user32 = koffi.load('user32.dll');

    EnumWindowsCb = koffi.proto('bool __stdcall EnumWindowsCb(void* hWnd, intptr_t lParam)');

    FindWindowA = user32.func('void* FindWindowA(const char* lpClassName, const char* lpWindowName)');
    FindWindowExA = user32.func('void* FindWindowExA(void* hwndParent, void* hwndChildAfter, const char* lpszClass, const char* lpszWindow)');
    SendMessageTimeoutA = user32.func('intptr_t SendMessageTimeoutA(void* hWnd, uint Msg, uintptr_t wParam, intptr_t lParam, uint fuFlags, uint uTimeout, _Out_ uint* lpdwResult)');
    SetParent = user32.func('void* SetParent(void* hWndChild, void* hWndNewParent)');
    SetWindowPos = user32.func('bool SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)');
    EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsCb* lpEnumFunc, intptr_t lParam)');
    // The "W" (wide/UTF-16) variant, not "A" (ANSI) — the ANSI version
    // narrows the path to the process's current codepage (e.g. Windows-1252
    // on a pt-BR install), which silently mangles any CJK or other non-Latin
    // character in the path into garbage bytes. Windows then can't find the
    // file and resets the desktop wallpaper to its own default instead of
    // leaving the previous one in place — same failure mode as passing an
    // unsupported image format, just triggered by the file's path this time
    // instead of its content.
    SystemParametersInfoW = user32.func('bool SystemParametersInfoW(uint uiAction, uint uiParam, str16 pvParam, uint fWinIni)');
    GetWindowLongA = user32.func('int GetWindowLongA(void* hWnd, int nIndex)');
    SetWindowLongA = user32.func('int SetWindowLongA(void* hWnd, int nIndex, int dwNewLong)');
    GetParent = user32.func('void* GetParent(void* hWnd)');
    IsIconic = user32.func('bool IsIconic(void* hWnd)');
    IsWindowVisible = user32.func('bool IsWindowVisible(void* hWnd)');
    ShowWindow = user32.func('bool ShowWindow(void* hWnd, int nCmdShow)');
    // Posted (not sent) so it never blocks waiting on every top-level window
    // in the system to process it — same reasoning SendMessageTimeoutA above
    // already uses a timeout for, just via the fire-and-forget API instead.
    PostMessageA = user32.func('bool PostMessageA(void* hWnd, uint Msg, uintptr_t wParam, intptr_t lParam)');

    shell32 = koffi.load('shell32.dll');
    SHAppBarMessage = shell32.func('intptr_t SHAppBarMessage(uint32 dwMessage, APPBARDATA* pData)');

    return true;
  } catch (err) {
    console.error('[workerw] Failed to load user32:', err.message);
    return false;
  }
}

// Sets the *real* Windows desktop wallpaper via the official, documented
// SystemParametersInfo API — no WorkerW/SetParent hack involved, so it can
// never be broken by Win+D, Explorer restarts, or Windows updates changing
// the desktop window hierarchy. Only supports a single static image (that's
// a Windows limitation, not ours — it's exactly why animated wallpapers need
// the WorkerW overlay technique at all, in this app or any other).
function setNativeWallpaper(imagePath) {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;
  try {
    return SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, imagePath, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
  } catch (err) {
    console.error('[workerw] setNativeWallpaper error:', err.message);
    return false;
  }
}

// Electron's win.getNativeWindowHandle() returns a raw Buffer holding the
// HWND's pointer bytes (8 bytes, native-endian, on 64-bit Windows) — it is
// NOT the same thing as a koffi pointer, and passing the Buffer object
// directly as a `void*` argument silently resolves to garbage (verified:
// GetWindowLongA on the raw buffer returns 0 instead of the window's real
// style). Every koffi call needs the actual numeric pointer value read out
// of the buffer instead. This was the real, root cause of every "the fix
// didn't work" result in this file's history — none of the SetParent /
// SetWindowLongA calls were ever operating on the right window at all.
function toHwnd(hwndBuffer) {
  if (typeof hwndBuffer === 'bigint' || typeof hwndBuffer === 'number') return hwndBuffer;
  return hwndBuffer.readBigUInt64LE(0);
}

// Technique and parameters below are matched against Lively Wallpaper's real,
// working, open-source implementation (WinDesktopCore.cs) rather than the
// generic version of this trick found in most blog posts — confirmed to
// actually survive Win+D on the same machine where our own attempts didn't.
function embedBehindDesktop(hwndBuffer, bounds) {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;

  const hwnd = toHwnd(hwndBuffer);

  try {
    // Find Progman (desktop shell window)
    const progman = FindWindowA('Progman', null);
    if (!progman) {
      console.error('[workerw] Progman not found');
      return false;
    }

    // Send 0x052C to Progman to spawn/ensure the WorkerW exists. wParam=0xD,
    // lParam=0x1 match Lively's exact call — the generic "0, 0" version found
    // in most references may not trigger the same behavior on every build.
    const smResult = [0];
    SendMessageTimeoutA(progman, 0x052C, 0xD, 0x1, 0, 1000, smResult);

    // Modern Windows builds (confirmed on 10.0.26200 via direct diagnosis) put
    // the WorkerW we want as a direct child of Progman itself, alongside
    // SHELLDLL_DefView — no top-level sibling hunt needed. Try that first.
    let workerW = FindWindowExA(progman, null, 'WorkerW', null);
    let shellDllDefView = FindWindowExA(progman, null, 'SHELLDLL_DefView', null);

    // Older Windows 10 behavior: a *separate* top-level WorkerW appears as
    // the next sibling after whichever top-level window hosts SHELLDLL_DefView.
    if (!workerW) {
      const callback = koffi.register((hwnd, _lParam) => {
        const defView = FindWindowExA(hwnd, null, 'SHELLDLL_DefView', null);
        if (defView) {
          workerW = FindWindowExA(null, hwnd, 'WorkerW', null);
          shellDllDefView = defView;
        }
        return true;
      }, koffi.pointer(EnumWindowsCb));

      EnumWindows(callback, 0);
      koffi.unregister(callback);
    }

    // SetParent alone does NOT convert the window's style — without WS_CHILD,
    // Windows still treats it as top-level-ish for some purposes (notably:
    // still minimized by Win+D "show desktop", even while visually reparented).
    const style = GetWindowLongA(hwnd, GWL_STYLE);
    SetWindowLongA(hwnd, GWL_STYLE, style | WS_CHILD);

    // "Raised desktop with layered ShellView" — confirmed via Lively's own
    // real runtime log on this exact machine ("Raised desktop with layered
    // ShellView detected"). On this configuration, SHELLDLL_DefView is a
    // direct child of Progman itself (also confirmed via direct diagnosis),
    // and the wallpaper must attach straight to Progman as a *layered* child
    // — not to WorkerW at all, which is the wrong target here.
    const isRaisedDesktop = !!shellDllDefView;

    // Encadeia atrás da última janela de wallpaper já encaixada (se houver
    // outra, de outro monitor) em vez de sempre atrás do DefView — evita a
    // colisão de 2+ janelas competindo pelo mesmo ponto de inserção (ver
    // comentário de _lastEmbeddedWallpaperHwnd acima). A primeira janela de
    // cada boot ainda usa o DefView normalmente, como sempre.
    const chainTarget = (_lastEmbeddedWallpaperHwnd && _lastEmbeddedWallpaperHwnd !== hwnd)
      ? _lastEmbeddedWallpaperHwnd
      : null;

    if (isRaisedDesktop) {
      // Lively applies WS_EX_LAYERED here too, but Lively's renderer isn't
      // Chromium — Electron's `transparent: true` window already gets its
      // own DWM-based alpha compositing, and forcing the legacy GDI-style
      // layered-window mechanism on top of that stops Chromium from
      // repainting at all (confirmed: renderer JS keeps running fine via a
      // heartbeat ping — a still-updating clock just never shows on screen
      // — so this was specifically a paint/composite bug, not a hang).
      SetParent(hwnd, progman);
      SetWindowPos(hwnd, chainTarget || shellDllDefView, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    } else {
      if (!workerW) {
        console.error('[workerw] Target WorkerW not found');
        return false;
      }
      SetParent(hwnd, workerW);
      const insertAfter = chainTarget || shellDllDefView || HWND_BOTTOM;
      SetWindowPos(hwnd, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    _lastEmbeddedWallpaperHwnd = hwnd;

    console.log('[workerw] Successfully embedded behind desktop' + (isRaisedDesktop ? ' (raised desktop mode)' : ''));
    return true;
  } catch (err) {
    console.error('[workerw] Error:', err.message);
    return false;
  }
}

// Reverte embedBehindDesktop pra deixar o wallpaper clicável de verdade.
// Achado ao vivo (2026-07-21): desligar ignoreMouseEvents sozinho não
// bastava pra clicar num botão desenhado dentro de um wallpaper "web" —
// causa real é que a janela fica embaixo do SHELLDLL_DefView (os ícones),
// que cobre a área inteira do desktop e é sempre topo na ordem de
// empilhamento; cliques em QUALQUER ponto do desktop vão pro DefView
// primeiro e nunca chegam numa janela atrás dele, não importa a
// configuração da própria janela. Só dá pra receber clique virando janela
// de topo de novo (fora da árvore do Progman/WorkerW) — main.js chama isso
// e depois levanta a janela na ordem normal (win.moveTop()); pra voltar ao
// normal, embedBehindDesktop() de novo faz o caminho inverso.
function detachFromDesktop(hwndBuffer) {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;
  try {
    const hwnd = toHwnd(hwndBuffer);
    const style = GetWindowLongA(hwnd, GWL_STYLE);
    SetWindowLongA(hwnd, GWL_STYLE, style & ~WS_CHILD);
    SetParent(hwnd, null);
    return true;
  } catch (err) {
    console.error('[workerw] detachFromDesktop error:', err.message);
    return false;
  }
}

// Experimental (2026-07-21): real bug report from a second PC — on that
// machine (same GPU-compositing-fully-disabled_software family documented
// above), the wallpaper renders about one frame every 2+ minutes when only
// ONE monitor is connected, but runs normally once a SECOND monitor is
// plugged in. Physically connecting a monitor makes Windows broadcast
// WM_DISPLAYCHANGE to every top-level window on the system — this function
// sends that exact same broadcast on demand, without touching any real
// display config, to test whether it's the broadcast itself (not anything
// about having two monitors) that unsticks the frozen software-rendered
// frame. NOT wired into any automatic loop yet — call manually (tray menu)
// so we can watch the frozen wallpaper the moment it's sent and confirm the
// theory before deciding whether to run this periodically.
function forceDisplayChangeBroadcast() {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;
  try {
    const { width, height } = require('electron').screen.getPrimaryDisplay().size;
    const lParam = (height << 16) | (width & 0xffff);
    PostMessageA(HWND_BROADCAST, WM_DISPLAYCHANGE, 32, lParam);
    return true;
  } catch (err) {
    console.error('[workerw] forceDisplayChangeBroadcast error:', err.message);
    return false;
  }
}

function toAddr(ptr) {
  if (ptr === null || ptr === undefined) return 0n;
  if (typeof ptr === 'bigint') return ptr;
  if (typeof ptr === 'number') return BigInt(ptr);
  return BigInt(koffi.address(ptr));
}

// Checks whether the window is *already* correctly embedded (right parent +
// WS_CHILD style) without touching anything. The watchdog calls this first
// and only runs the actual SetParent/SetWindowPos dance when something is
// really wrong — running those unconditionally every tick (previous
// behavior) forces a repaint each time even when nothing needed fixing,
// which is what was causing the periodic flicker.
function isEmbeddedCorrectly(hwndBuffer) {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;
  try {
    const hwnd = toHwnd(hwndBuffer);
    const style = GetWindowLongA(hwnd, GWL_STYLE);
    if ((style & WS_CHILD) === 0) return false;

    const progman = FindWindowA('Progman', null);
    if (!progman) return false;
    const parent = GetParent(hwnd);
    const parentAddr = toAddr(parent);

    if (parentAddr === toAddr(progman)) return true; // raised-desktop target
    const workerW = FindWindowExA(progman, null, 'WorkerW', null);
    if (workerW && parentAddr === toAddr(workerW)) return true; // normal-mode target
    return false;
  } catch (err) {
    console.error('[workerw] isEmbeddedCorrectly error:', err.message);
    return false;
  }
}

// Diagnostic-only: logs the wallpaper window's real, current OS-level state
// (parent, WS_CHILD bit, visible/minimized) so we can see exactly what Win+D
// actually changes, instead of guessing at another fix blind. Call this from
// the watchdog every tick — the log around the moment Win+D is pressed is
// what we need to see.
function logWindowState(hwndBuffer, label) {
  if (process.platform !== 'win32') return;
  if (!loadUser32()) return;
  try {
    const hwnd = toHwnd(hwndBuffer);
    const parent = GetParent(hwnd);
    const style = GetWindowLongA(hwnd, GWL_STYLE);
    const hasChildStyle = (style & WS_CHILD) !== 0;
    const minimized = IsIconic(hwnd);
    const visible = IsWindowVisible(hwnd);
    console.log(`[workerw][diag] ${label} parent=${parent} WS_CHILD=${hasChildStyle} minimized=${minimized} visible=${visible}`);
  } catch (err) {
    console.error('[workerw][diag] error:', err.message);
  }
}

// Acha a ListView real dos ícones da área de trabalho (SysListView32, dentro
// de SHELLDLL_DefView). Reaproveita a mesma dualidade "desktop normal vs
// raised desktop" já documentada em embedBehindDesktop, mas usando o loop
// FindWindowExA(parent=null, ...) em vez de EnumWindows+callback — mais
// simples pra só enumerar top-level WorkerW's atrás do DefView.
function findDesktopListView() {
  const progman = FindWindowA('Progman', null);
  if (!progman) return null;

  let defView = FindWindowExA(progman, null, 'SHELLDLL_DefView', null);
  if (!defView) {
    let workerW = null;
    while (true) {
      workerW = FindWindowExA(null, workerW, 'WorkerW', null);
      if (!workerW) break;
      const candidate = FindWindowExA(workerW, null, 'SHELLDLL_DefView', null);
      if (candidate) { defView = candidate; break; }
    }
  }
  if (!defView) return null;
  return FindWindowExA(defView, null, 'SysListView32', null);
}

// Mostra/esconde os ícones da área de trabalho — mesmo efeito de clicar com
// o botão direito na área de trabalho > Exibir > Mostrar ícones da área de
// trabalho, só que via API direta (ShowWindow na ListView real) em vez do
// truque de "toggle" (WM_COMMAND 0x7402), que não dá pra saber com certeza
// o estado atual antes de mandar.
function setDesktopIconsVisible(visible) {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;
  try {
    const listView = findDesktopListView();
    if (!listView) { console.error('[workerw] SysListView32 não encontrada'); return false; }
    ShowWindow(listView, visible ? SW_SHOW : SW_HIDE);
    return true;
  } catch (err) {
    console.error('[workerw] setDesktopIconsVisible error:', err.message);
    return false;
  }
}

// Mostra/esconde a barra de tarefas — a principal (Shell_TrayWnd) e qualquer
// barra secundária em outros monitores (Shell_SecondaryTrayWnd), enumeradas
// com o mesmo loop de FindWindowExA (não existe só uma instância quando o
// Windows está configurado pra mostrar a barra em todas as telas).
function setTaskbarVisible(visible) {
  if (process.platform !== 'win32') return false;
  if (!loadUser32()) return false;
  try {
    const primary = FindWindowA('Shell_TrayWnd', null);
    if (primary) {
      const data = {
        cbSize: koffi.sizeof(APPBARDATA),
        hWnd: primary,
        uCallbackMessage: 0,
        uEdge: 0,
        rc: { left: 0, top: 0, right: 0, bottom: 0 },
        lParam: 0
      };

      if (!visible) {
        // Save the original state before changing it for the first time
        if (originalTaskbarState === null) {
          originalTaskbarState = SHAppBarMessage(ABM_GETSTATE, data);
        }
        data.lParam = ABS_AUTOHIDE;
        SHAppBarMessage(ABM_SETSTATE, data);
      } else {
        if (originalTaskbarState !== null) {
          data.lParam = originalTaskbarState;
          SHAppBarMessage(ABM_SETSTATE, data);
        } else {
          data.lParam = ABS_ALWAYSONTOP; // Fallback
          SHAppBarMessage(ABM_SETSTATE, data);
        }
      }
    }

    let any = !!primary;

    let secondary = null;
    while (true) {
      secondary = FindWindowExA(null, secondary, 'Shell_SecondaryTrayWnd', null);
      if (!secondary) break;
      any = true;
    }

    if (!any) console.error('[workerw] Nenhuma barra de tarefas encontrada');
    return any;
  } catch (err) {
    console.error('[workerw] setTaskbarVisible error:', err.message);
    return false;
  }
}

module.exports = { embedBehindDesktop, detachFromDesktop, setNativeWallpaper, logWindowState, isEmbeddedCorrectly, setDesktopIconsVisible, setTaskbarVisible, forceDisplayChangeBroadcast };
