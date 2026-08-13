/**
 * Gatwy: when html.gatwy-fullscreen (object-fit: fill), skip MLW’s
 * getStreamRectCorrected letterbox math so touch/mouse hit the stretched pane.
 * Windowed contain still uses the original corrected rect.
 * Keep in sync with MLW_GATWY_HELPER_SCRIPT in MoonlightSession.tsx.
 */
(function gatwyStreamRect() {
  if (window.__gatwyStreamRectInstalled) return;
  window.__gatwyStreamRectInstalled = true;

  function rawVideoRect() {
    var el = document.querySelector('video.video-stream, canvas.video-stream, .video-stream');
    if (el && typeof el.getBoundingClientRect === 'function') {
      return el.getBoundingClientRect();
    }
    return null;
  }

  function wrapGetStreamRect(obj) {
    if (!obj || typeof obj.getStreamRect !== 'function' || obj.getStreamRect.__gatwyFillWrap) {
      return false;
    }
    var orig = obj.getStreamRect.bind(obj);
    function wrapped() {
      try {
        if (document.documentElement && document.documentElement.classList.contains('gatwy-fullscreen')) {
          var raw = rawVideoRect();
          if (raw) return raw;
        }
      } catch (_e) { /* fall through */ }
      return orig();
    }
    wrapped.__gatwyFillWrap = true;
    obj.getStreamRect = wrapped;
    return true;
  }

  function patch() {
    var app = window.app || null;
    wrapGetStreamRect(app);
    try {
      var stream = app && typeof app.getStream === 'function' ? app.getStream() : null;
      var renderer = stream && typeof stream.getVideoRenderer === 'function'
        ? stream.getVideoRenderer()
        : null;
      wrapGetStreamRect(renderer);
    } catch (_e) { /* stream not ready */ }
  }

  function boot() {
    patch();
    var n = 0;
    var t = setInterval(function () {
      patch();
      n += 1;
      if (n >= 80) clearInterval(t);
    }, 100);
    try {
      if (typeof MutationObserver !== 'undefined' && document.documentElement && !window.__gatwyRectObserver) {
        var obs = new MutationObserver(function () { patch(); });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        window.__gatwyRectObserver = obs;
        setTimeout(function () { try { obs.disconnect(); } catch (_e) {} }, 30000);
      }
    } catch (_e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
