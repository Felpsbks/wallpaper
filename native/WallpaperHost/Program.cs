namespace WallpaperHost;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // O try/catch em MainForm.cs's Load handler só cobre a inicialização
        // do WebView2 em si — confirmado ao vivo (PC afetado, v1.0.29) que
        // existe pelo menos mais um jeito de estourar uma exceção não tratada
        // fora dali (uma corrida de layout bem no WmCreate da própria janela,
        // "CoreWebView2 members cannot be accessed after the WebView2 control
        // is disposed" + o mesmo 0x8007139F). Em vez de caçar call site por
        // call site, captura qualquer exceção da thread de UI globalmente —
        // precisa vir ANTES de qualquer coisa que crie uma janela/handle.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => ReportFatalAndExit(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => ReportFatalAndExit(e.ExceptionObject as Exception);

        ApplicationConfiguration.Initialize();

        // args[0]: absolute path to the wallpaper content folder (contains index.html)
        // args[1..4]: display bounds (x, y, width, height) — required for real
        // (main.js-spawned) usage; falls back to the primary screen when
        // omitted, for quick manual testing.
        // args[5] (optional): a real image/video file path, sent through the
        // host bridge as a one-off test "set-wallpaper" message a couple
        // seconds after load — this is how part 3 was validated end-to-end.
        var contentDir = args.Length > 0
            ? args[0]
            : Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "wallpaper");

        Rectangle bounds;
        if (args.Length >= 5 &&
            int.TryParse(args[1], out var x) && int.TryParse(args[2], out var y) &&
            int.TryParse(args[3], out var w) && int.TryParse(args[4], out var h))
        {
            bounds = new Rectangle(x, y, w, h);
        }
        else
        {
            bounds = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1920, 1080);
        }

        var testMediaPath = args.Length > 5 ? args[5] : null;
        // args[6] (optional): pass "--clock" to also enable the live clock
        // overlay a couple seconds in — isolates whether the overlay's 1s
        // setInterval DOM update is what triggers the freeze, independent of
        // whatever else is different about running under the real app.
        var testClock = args.Length > 6 && args[6] == "--clock";

        Application.Run(new MainForm(Path.GetFullPath(contentDir), bounds, testMediaPath, testClock));
    }

    private static void ReportFatalAndExit(Exception? ex)
    {
        if (ex == null) { Environment.Exit(1); return; }
        Console.WriteLine($"[fatal] Exceção não tratada: {ex.GetType().Name}: {ex.Message}");
        var inner = ex.InnerException;
        while (inner != null)
        {
            Console.WriteLine($"[fatal]   causada por: {inner.GetType().Name}: {inner.Message}");
            if (inner is System.Runtime.InteropServices.COMException comEx)
            {
                var hr = unchecked((uint)comEx.HResult);
                Console.WriteLine($"[fatal]   HRESULT: 0x{hr:X8}" + (hr == 0x8007139F
                    ? " — WebView2 não conseguiu inicializar/redimensionar (recurso não estava pronto). Pode ser instabilidade do WebView2 Runtime neste PC, não necessariamente colisão entre processos."
                    : ""));
            }
            inner = inner.InnerException;
        }
        Environment.Exit(1);
    }
}
