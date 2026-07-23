using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace WallpaperHost;

// Porta do bloqueio de anúncio + limpeza de página do YouTube que já existia
// só no lado Electron (main.js: setupYoutubeAdBlock/injectYoutubeWatchCleanup,
// YOUTUBE_AD_BLOCK_PATTERNS). Mesma lista de domínios, mesmo CSS, mesmo loop
// de clique em consentimento/skip-ad — só a API de interceptação de rede muda
// (WebResourceRequested do WebView2 em vez de session.webRequest do Electron).
public static class YoutubeWallpaperController
{
    public static readonly System.Text.RegularExpressions.Regex WatchUrlRegex =
        new(@"^https://(www\.)?youtube\.com/watch\?", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    private static readonly string[] AdBlockFilters =
    {
        "https://*.doubleclick.net/*",
        "https://*.googlesyndication.com/*",
        "https://*.googleadservices.com/*",
        "https://googleads.g.doubleclick.net/*",
        "https://*.google.com/pagead/*",
        "https://*.youtube.com/api/stats/ads*",
        "https://*.youtube.com/pagead/*",
        "https://*.youtube.com/ptracking*",
    };

    private static bool _wired = false;

    // Os filtros ficam ativos pra sempre no CoreWebView2 (não são desfeitos ao
    // navegar) — só precisa ser chamado uma vez por processo, mesmo que o
    // wallpaper alterne entre a shell (vídeo) e o YouTube várias vezes.
    public static void EnsureAdBlock(CoreWebView2 webView)
    {
        if (_wired) return;
        _wired = true;
        try
        {
            foreach (var filter in AdBlockFilters)
                webView.AddWebResourceRequestedFilter(filter, CoreWebView2WebResourceContext.All);

            webView.WebResourceRequested += (_, e) =>
            {
                e.Response = webView.Environment.CreateWebResourceResponse(null, 403, "Blocked", "");
            };
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[youtube] EnsureAdBlock error: {ex.Message}");
        }
    }

    // Esconde cabeçalho/sidebar/comentários/diálogos de consentimento da
    // página normal de assistir e estica o player pra tela cheia. Texto
    // idêntico ao usado em main.js's injectYoutubeWatchCleanup — qualquer
    // ajuste de seletor deve ser replicado nos dois lugares.
    private const string WatchCleanupCss = @"
        html, body { background: #000 !important; overflow: hidden !important; }
        #masthead-container, ytd-masthead, #secondary, #comments, ytd-comments,
        #related, ytd-watch-metadata, #below, tp-yt-paper-dialog,
        ytd-consent-bail-out-renderer, ytd-popup-container, #chat, #panels,
        .ytp-chrome-top, .ytp-gradient-top, .ytp-watermark, .ytp-pause-overlay,
        .ytp-ce-element, ytd-mealbar-promo-renderer, #chips-wrapper,
        .ytp-ad-overlay-container, .ytp-ad-overlay-slot, .ytp-ad-image-overlay,
        .ytp-ad-text-overlay, .video-ads, .ytp-ad-progress-list, .ytp-ad-player-overlay,
        .ytp-ad-message-container {
          display: none !important;
        }
        ytd-app, #content, #page-manager, ytd-watch-flexy, #primary,
        #primary-inner, #player-container-outer, #player-container-inner,
        #player, #movie_player, #movie_player video, .html5-video-container {
          position: fixed !important; inset: 0 !important;
          width: 100vw !important; height: 100vh !important;
          max-width: none !important; max-height: none !important;
          margin: 0 !important; padding: 0 !important;
        }
    ";

    private const string WatchCleanupJs = @"
        (function() {
          let tries = 0;
          const t = setInterval(function() {
            tries++;
            const consentBtn = document.querySelector('ytd-consent-bail-out-renderer button, tp-yt-paper-dialog button[aria-label*=""Aceitar"" i], tp-yt-paper-dialog button[aria-label*=""Accept"" i]');
            if (consentBtn) consentBtn.click();

            const player = document.getElementById('movie_player');
            if (player && player.classList.contains('ad-showing')) {
              const skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
              if (skipBtn) skipBtn.click();
              else {
                const adVideo = player.querySelector('video');
                if (adVideo && isFinite(adVideo.duration)) adVideo.currentTime = adVideo.duration;
              }
            }

            if (tries > 600) clearInterval(t);
          }, 1000);
        })();
    ";

    public static async Task InjectWatchCleanup(CoreWebView2 webView)
    {
        var cssAsJsString = JsonSerializer.Serialize(WatchCleanupCss);
        var injectCss = $@"
            (function() {{
              var s = document.createElement('style');
              s.textContent = {cssAsJsString};
              document.head.appendChild(s);
            }})();
        ";
        try { await webView.ExecuteScriptAsync(injectCss); } catch (Exception ex) { Console.WriteLine($"[youtube] CSS inject error: {ex.Message}"); }
        try { await webView.ExecuteScriptAsync(WatchCleanupJs); } catch (Exception ex) { Console.WriteLine($"[youtube] JS inject error: {ex.Message}"); }
    }
}
