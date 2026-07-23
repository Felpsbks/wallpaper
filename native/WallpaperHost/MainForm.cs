using System.Text.Json;
using Microsoft.Web.WebView2.WinForms;

namespace WallpaperHost;

// Part 2: same WebView2 content window as part 1, now actually reparented
// behind the desktop (Progman/WorkerW) via DesktopEmbedder — the C# port of
// our validated src/workerw.js logic. A watchdog timer re-checks/re-applies
// this every second, mirroring main.js's startWorkerWWatchdog, including the
// "only re-embed if actually needed" fix that avoided flicker there.
//
// NOTE: once embedded as a WS_CHILD under another process's window, this
// window no longer reliably receives keyboard focus (the same reason the
// Electron wallpaper windows can't use Escape either) — close this test via
// `taskkill /F /IM WallpaperHost.exe`, not a keypress.
public class MainForm : Form
{
    private readonly WebView2 _webView = new();
    private readonly string _contentDir;
    private readonly string? _testMediaPath;
    private readonly bool _testClock;
    private readonly System.Windows.Forms.Timer _watchdog = new() { Interval = 1000 };

    // main.js can write to this process's stdin the instant it spawns it,
    // long before WebView2 has finished navigating and wallpaper.js has
    // registered its hostBridge listeners — a message posted before then
    // would just be silently lost (no buffering on the page side). Queue
    // everything here until NavigationCompleted fires, then flush in order.
    private readonly List<string> _pendingMessages = new();
    private readonly object _pendingLock = new();
    private bool _pageReady = false;

    // type:'url' (hoje só YouTube ao vivo) é tratado inteiramente aqui, sem
    // nunca repassar a mensagem pra shell (wallpaper.js) — ver HandleHostMessage
    // e ShowWebWallpaper abaixo. _lastMuted guarda o último estado pra reaplicar
    // se o próprio processo do YouTube for recriado por uma navegação.
    private bool _webMode = false;
    private bool _lastMuted = false;

    public MainForm(string contentDir, Rectangle bounds, string? testMediaPath = null, bool testClock = false)
    {
        _contentDir = contentDir;
        _testMediaPath = testMediaPath;
        _testClock = testClock;

        Text = "WallpaperHost";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Location = bounds.Location;
        Size = bounds.Size;
        BackColor = Color.Black;

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);

        Load += async (_, _) => await InitializeWebViewAsync();

        Shown += (_, _) =>
        {
            DesktopEmbedder.EmbedBehindDesktop(Handle);
            _watchdog.Tick += (_, _) => WatchdogTick();
            _watchdog.Start();
        };
    }

    private void WatchdogTick()
    {
        if (DesktopEmbedder.IsMinimized(Handle))
        {
            ShowWindow(Handle, SW_RESTORE);
            Console.WriteLine("[watchdog] wallpaper window was minimized — restored");
        }
        if (!DesktopEmbedder.IsVisible(Handle))
        {
            Visible = true;
            Console.WriteLine("[watchdog] wallpaper window was hidden — shown");
        }
        if (DesktopEmbedder.IsEmbeddedCorrectly(Handle)) return;

        Console.WriteLine("[watchdog] wallpaper window not correctly embedded — re-attaching");
        DesktopEmbedder.EmbedBehindDesktop(Handle);
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    private const int SW_RESTORE = 9;

    private async Task InitializeWebViewAsync()
    {
        // This window is *always* occluded from the OS's point of view — it
        // permanently sits behind the desktop icons layer by design. Chromium
        // (which WebView2 is built on, same as Electron) has a native-window-
        // occlusion feature that uses that exact signal to throttle rendering
        // and timers for windows it thinks are hidden, to save power — the
        // WebView2-side equivalent of the `backgroundThrottling: false` fix
        // already needed on the Electron side for the same reason (see
        // project_workerw_fragility memory: "Related discovery — Chromium
        // background throttling"). Confirmed via the heartbeat diagnostic
        // that the freeze is exactly this class of bug again (JS never hangs,
        // heartbeats keep arriving on schedule — only paint stops), so disable
        // it here too via Chromium command-line switches, passed through
        // WebView2's environment options (there's no simple settings-object
        // flag for this, unlike Electron's webPreferences).
        var envOptions = new Microsoft.Web.WebView2.Core.CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments =
                "--disable-features=CalculateNativeWinOcclusion " +
                "--disable-backgrounding-occluded-windows " +
                "--disable-renderer-backgrounding " +
                "--disable-background-timer-throttling",
        };
        var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, null, envOptions);
        await _webView.EnsureCoreWebView2Async(env);

        // Filtros de bloqueio de anúncio do YouTube ficam ativos pro processo
        // inteiro (não atrapalham a shell/vídeo — só casam domínio de anúncio).
        YoutubeWallpaperController.EnsureAdBlock(_webView.CoreWebView2);

        // Serve the wallpaper folder under a virtual hostname so relative
        // <script src="wallpaper.js"> references resolve like a normal
        // http(s) page, without needing Node's fs/path or a file:// origin
        // (WebView2 has no Node integration at all, unlike Electron's
        // renderer processes — this mapping is the WebView2-native
        // replacement for that kind of local file access).
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "wallpaper.local", _contentDir, Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);

        // Real wallpaper media (Steam Workshop downloads, user-picked files)
        // lives at arbitrary absolute paths on disk. The page is served from
        // https://wallpaper.local/, so a raw file:// src is cross-origin
        // mixed content and WebView2 (real Chromium) blocks it silently —
        // <img>/<video> just never load, with no visible error. Map each
        // drive root to its own virtual hostname so main.js can address any
        // local file as https://localfs-<drive>/<rest of path>; only C: and
        // D: for now (covers the default Windows/Steam-library locations —
        // extend here if a wallpaper on another drive needs it).
        foreach (var drive in new[] { "C", "D" })
        {
            var root = $"{drive}:\\";
            if (Directory.Exists(root))
            {
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    $"localfs-{drive.ToLowerInvariant()}", root, Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
            }
        }

        string? testMediaUrl = null;
        if (_testMediaPath != null && File.Exists(_testMediaPath))
        {
            // Map the test file's own folder too, so <img>/<video src> can load
            // it as a normal https:// virtual-host URL (matches how index.html
            // itself is served — avoids file:// mixed-content/CORS restrictions).
            var mediaDir = Path.GetDirectoryName(Path.GetFullPath(_testMediaPath))!;
            var fileName = Path.GetFileName(_testMediaPath);
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "media.local", mediaDir, Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
            testMediaUrl = $"https://media.local/{Uri.EscapeDataString(fileName)}";
        }

        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        StartStdinBridge();

        _webView.CoreWebView2.NavigationCompleted += (_, e) =>
        {
            if (!e.IsSuccess) return;

            lock (_pendingLock)
            {
                _pageReady = true;
                foreach (var msg in _pendingMessages) PostNow(msg);
                _pendingMessages.Clear();
            }

            if (_testClock)
            {
                _ = Task.Delay(1500).ContinueWith(_ =>
                {
                    var clockPayload = JsonSerializer.Serialize(new
                    {
                        channel = "update-settings",
                        data = new
                        {
                            clockOverlay = new
                            {
                                enabled = true, position = "top-left", format24h = true,
                                showSeconds = false, showDate = true, showDayName = true,
                                color = "#ffffff", fontSize = 48,
                            },
                        },
                    });
                    BeginInvoke(() => PostNow(clockPayload));
                });
            }

            if (testMediaUrl == null) return;
            var ext = Path.GetExtension(_testMediaPath).ToLowerInvariant();
            var type = ext is ".mp4" or ".webm" or ".mkv" ? "video" : "image";

            // Small delay purely so this one-off manual test is easy to see
            // land after the real content is visibly up — the queue above
            // already makes this unnecessary for correctness.
            _ = Task.Delay(1500).ContinueWith(_ =>
            {
                var payload = JsonSerializer.Serialize(new
                {
                    channel = "set-wallpaper",
                    data = new { type, src = testMediaUrl }
                });
                BeginInvoke(() => PostNow(payload));
            });
        };

        _webView.CoreWebView2.Navigate("https://wallpaper.local/index.html");
    }

    private void PostNow(string json)
    {
        try { _webView.CoreWebView2.PostWebMessageAsJson(json); }
        catch (Exception ex) { Console.WriteLine($"[bridge] post error: {ex.Message}"); }
    }

    private void PostOrQueue(string json)
    {
        lock (_pendingLock)
        {
            if (_pageReady) PostNow(json);
            else _pendingMessages.Add(json);
        }
    }

    // Relays main.js -> page messages. main.js writes one JSON line per
    // message to this process's stdin (matching the {channel, data} shape
    // host-bridge.js expects) instead of a named pipe/socket — simplest
    // transport child_process already gives us for free.
    //
    // Reads via a manually-built StreamReader(Console.OpenStandardInput(),
    // Encoding.UTF8) instead of Console.In/Console.In.ReadLineAsync() —
    // Console.In's decoding follows Console.InputEncoding, which for a
    // redirected pipe on a WinExe (no real console attached) falls back to
    // the system's default codepage, not UTF-8. main.js (Node) always writes
    // plain UTF-8 with no BOM, so any accented character (wallpaper name,
    // file path, YouTube title) decoded under a different codepage garbles
    // silently — confirmed live: a stray 0xC3 byte broke JSON parsing on the
    // very first message sent through a mismatched encoding. Explicitly
    // setting Console.InputEncoding itself was tried first and is WRONG here
    // — it throws (`Identificador inválido` / invalid handle) because that
    // setter needs a real attached console, which a redirected pipe doesn't
    // have; reading the raw stream ourselves sidesteps that entirely.
    private void StartStdinBridge()
    {
        _ = Task.Run(async () =>
        {
            using var reader = new StreamReader(Console.OpenStandardInput(), System.Text.Encoding.UTF8);
            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                var toSend = line;
                if (string.IsNullOrWhiteSpace(toSend)) continue;
                BeginInvoke(() => HandleHostMessage(toSend));
            }
        });
    }

    // Intercepta duas coisas antes de deixar o resto seguir pro caminho normal
    // (PostOrQueue -> shell/wallpaper.js via hostBridge): (1) set-wallpaper com
    // type:'url' (YouTube ao vivo hoje) nunca chega na shell — troca a
    // navegação do próprio WebView2 pra URL real; (2) mute/unmute enquanto em
    // modo YouTube vira CoreWebView2.IsMuted em vez de postMessage (a página
    // crua do YouTube não tem o listener do hostBridge).
    private void HandleHostMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var channel = root.TryGetProperty("channel", out var chEl) ? chEl.GetString() : null;

            if (channel == "set-wallpaper" && root.TryGetProperty("data", out var dataEl))
            {
                var type = dataEl.TryGetProperty("type", out var typeEl) ? typeEl.GetString() : null;
                if (type == "url" && dataEl.TryGetProperty("src", out var srcEl))
                {
                    var muted = dataEl.TryGetProperty("muted", out var mutedEl) && mutedEl.ValueKind == JsonValueKind.True;
                    _lastMuted = muted;
                    _webMode = true;
                    ShowWebWallpaper(srcEl.GetString() ?? "", muted);
                    return;
                }

                if (_webMode)
                {
                    // Saindo do YouTube pra vídeo/imagem/etc — reencaixa a
                    // shell e só então repassa esta mesma mensagem (fica na
                    // fila de _pendingMessages até o NavigationCompleted
                    // principal, em InitializeWebViewAsync, marcar
                    // _pageReady=true de novo).
                    _webMode = false;
                    _pageReady = false;
                    _webView.CoreWebView2.Navigate("https://wallpaper.local/index.html");
                    PostOrQueue(json);
                    return;
                }
            }

            if ((channel == "mute" || channel == "unmute") && _webMode)
            {
                _lastMuted = channel == "mute";
                _webView.CoreWebView2.IsMuted = _lastMuted;
                return;
            }

            PostOrQueue(json);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[bridge] HandleHostMessage error: {ex.Message}");
        }
    }

    // Navega o WebView2 direto pra URL real do YouTube (sem passar pela
    // shell/wallpaper.js) e aplica bloqueio de anúncio + limpeza de página já
    // registrados globalmente (EnsureAdBlock, chamado uma vez em
    // InitializeWebViewAsync). Mesma técnica confirmada funcionando no lado
    // Electron: carregar a página real de assistir (não /embed/), porque
    // /embed/ falha (Erro 153) pra vídeos com incorporação desativada.
    private void ShowWebWallpaper(string url, bool muted)
    {
        if (string.IsNullOrEmpty(url)) return;
        _webView.CoreWebView2.IsMuted = muted;

        void OnNavCompleted(object? sender, Microsoft.Web.WebView2.Core.CoreWebView2NavigationCompletedEventArgs e)
        {
            _webView.CoreWebView2.NavigationCompleted -= OnNavCompleted;
            if (!e.IsSuccess) return;
            if (YoutubeWallpaperController.WatchUrlRegex.IsMatch(url))
            {
                _ = YoutubeWallpaperController.InjectWatchCleanup(_webView.CoreWebView2);
            }
        }

        _webView.CoreWebView2.NavigationCompleted += OnNavCompleted;
        _webView.CoreWebView2.Navigate(url);
    }

    private void OnWebMessageReceived(object? sender, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            var channel = root.TryGetProperty("channel", out var chEl) ? chEl.GetString() : null;

            // Minimal stub so wallpaper.js's `hostBridge.invoke('get-settings')`
            // resolves instead of hanging forever. main.js sends the real
            // settings right after spawning this process via an
            // 'update-settings' stdin message, which wallpaper.js already
            // knows how to apply — no need to relay this particular request
            // back to Node and wait for a real answer.
            if (channel == "get-settings" && root.TryGetProperty("requestId", out var reqIdEl))
            {
                var response = JsonSerializer.Serialize(new
                {
                    requestId = reqIdEl.GetInt32(),
                    __invokeResponse = true,
                    result = new { }
                });
                _webView.CoreWebView2.PostWebMessageAsJson(response);
                return;
            }

            // Everything else (heartbeat/diagnostic pings, etc.) is just
            // relayed to stdout with a distinct prefix, where main.js's
            // child.stdout listener logs it into the app's own log tab the
            // same way it already does for [workerw]/[watchdog] lines.
            Console.WriteLine($"[page->host] {e.WebMessageAsJson}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[bridge] WebMessageReceived parse error: {ex.Message}");
        }
    }
}
