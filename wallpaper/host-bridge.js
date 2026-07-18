// Transport-agnostic messaging so wallpaper.js can run unmodified under
// either host: Electron's BrowserWindow (ipcRenderer, today's production
// path) or the new native WallpaperHost.exe (WebView2's
// window.chrome.webview postMessage API, no Node/Electron available at all).
// Everything else in this folder should talk to `hostBridge`, never
// directly to `ipcRenderer` or `window.chrome.webview`.
(function () {
  let ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (_) { /* not running under Electron */ }

  const isWebView2 = !ipcRenderer && !!(window.chrome && window.chrome.webview);
  const listeners = new Map(); // channel -> Set<fn(data)>
  let _invokeSeq = 0;
  const _pendingInvokes = new Map(); // requestId -> resolve

  function on(channel, fn) {
    if (ipcRenderer) {
      ipcRenderer.on(channel, (_event, data) => fn(data));
      return;
    }
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
  }

  function send(channel, data) {
    if (ipcRenderer) { ipcRenderer.send(channel, data); return; }
    if (isWebView2) window.chrome.webview.postMessage({ channel, data });
  }

  function invoke(channel, data) {
    if (ipcRenderer) return ipcRenderer.invoke(channel, data);
    if (!isWebView2) return Promise.resolve(undefined);
    const requestId = ++_invokeSeq;
    return new Promise((resolve) => {
      _pendingInvokes.set(requestId, resolve);
      window.chrome.webview.postMessage({ channel, data, requestId, __invoke: true });
    });
  }

  if (isWebView2) {
    window.chrome.webview.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.__invokeResponse && _pendingInvokes.has(msg.requestId)) {
        _pendingInvokes.get(msg.requestId)(msg.result);
        _pendingInvokes.delete(msg.requestId);
        return;
      }
      for (const fn of listeners.get(msg.channel) || []) fn(msg.data);
    });
  }

  window.hostBridge = { on, send, invoke, isWebView2: !!isWebView2 };
})();
