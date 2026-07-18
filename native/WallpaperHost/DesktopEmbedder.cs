using System.Runtime.InteropServices;

namespace WallpaperHost;

// C# port of src/workerw.js's embedBehindDesktop/isEmbeddedCorrectly, itself
// matched against Lively Wallpaper's real, confirmed-working implementation
// (WinDesktopCore.cs) rather than the generic blog-post version of this
// trick. Unlike the Electron/koffi version, there is no Buffer-vs-pointer
// conversion pitfall here — Control.Handle is already a proper IntPtr.
public static class DesktopEmbedder
{
    private const int GWL_STYLE = -16;
    private const int WS_CHILD = 0x40000000;

    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private static readonly IntPtr HWND_BOTTOM = new(1);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string? lpszClass, string? lpszWindow);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll")]
    private static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    public static bool EmbedBehindDesktop(IntPtr hwnd)
    {
        try
        {
            var progman = FindWindow("Progman", null);
            if (progman == IntPtr.Zero)
            {
                Console.WriteLine("[embed] Progman not found");
                return false;
            }

            // wParam=0xD, lParam=0x1 match Lively's exact call, not the
            // generic "0, 0" version found in most blog references.
            SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(0x1), 0, 1000, out _);

            var workerW = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
            var shellDllDefView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);

            if (workerW == IntPtr.Zero)
            {
                EnumWindows((hWnd, _) =>
                {
                    var defView = FindWindowEx(hWnd, IntPtr.Zero, "SHELLDLL_DefView", null);
                    if (defView != IntPtr.Zero)
                    {
                        workerW = FindWindowEx(IntPtr.Zero, hWnd, "WorkerW", null);
                        shellDllDefView = defView;
                    }
                    return true;
                }, IntPtr.Zero);
            }

            var style = GetWindowLong(hwnd, GWL_STYLE);
            SetWindowLong(hwnd, GWL_STYLE, style | WS_CHILD);

            // "Raised desktop with layered ShellView" — confirmed on this
            // exact machine via Lively's own log (SHELLDLL_DefView is a
            // direct child of Progman itself in this configuration).
            var isRaisedDesktop = shellDllDefView != IntPtr.Zero;

            if (isRaisedDesktop)
            {
                SetParent(hwnd, progman);
                SetWindowPos(hwnd, shellDllDefView, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            else
            {
                if (workerW == IntPtr.Zero)
                {
                    Console.WriteLine("[embed] Target WorkerW not found");
                    return false;
                }
                SetParent(hwnd, workerW);
                var insertAfter = shellDllDefView != IntPtr.Zero ? shellDllDefView : HWND_BOTTOM;
                SetWindowPos(hwnd, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }

            Console.WriteLine($"[embed] Successfully embedded behind desktop{(isRaisedDesktop ? " (raised desktop mode)" : "")}");
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[embed] Error: {ex.Message}");
            return false;
        }
    }

    // Mirrors workerw.js's isEmbeddedCorrectly — checked every watchdog tick
    // so we only pay the SetParent/SetWindowPos repaint cost when something
    // actually drifted, not unconditionally (that was the source of a
    // periodic-flicker bug in the Electron version).
    public static bool IsEmbeddedCorrectly(IntPtr hwnd)
    {
        try
        {
            var style = GetWindowLong(hwnd, GWL_STYLE);
            if ((style & WS_CHILD) == 0) return false;

            var progman = FindWindow("Progman", null);
            if (progman == IntPtr.Zero) return false;

            var parent = GetParent(hwnd);
            if (parent == progman) return true;

            var workerW = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
            return workerW != IntPtr.Zero && parent == workerW;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[embed] IsEmbeddedCorrectly error: {ex.Message}");
            return false;
        }
    }

    public static bool IsMinimized(IntPtr hwnd) => IsIconic(hwnd);
    public static bool IsVisible(IntPtr hwnd) => IsWindowVisible(hwnd);
}
