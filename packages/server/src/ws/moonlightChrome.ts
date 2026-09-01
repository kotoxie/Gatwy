const MARKER = 'data-gatwy-moonlight-chrome';

const HEAD_SNIPPET = `<link rel="stylesheet" href="/moonlight-overlay.css" ${MARKER}>
<script ${MARKER}>
(function () {
  try {
    var key = 'mlSettings';
    var settings = JSON.parse(localStorage.getItem(key) || '{}');
    settings.sidebarEdge = 'right';
    settings.dataTransport = 'websocket';
    localStorage.setItem(key, JSON.stringify(settings));
  } catch (e) {}
  var originalClose = window.close;
  // iframe window.close() is a no-op; tell Gatwy to tear down the session.
  window.close = function () {
    try { parent.postMessage({ source: 'gatwy-mlw', type: 'exit' }, '*'); } catch (e) {}
    if (typeof originalClose === 'function') originalClose.call(window);
  };
})();
</script>
`;

/** Rewrite proxied moonlight-web HTML so the stream HUD uses Gatwy chrome. */
export function injectGatwyMoonlightChrome(html: string): string {
  if (html.includes(MARKER)) return html;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${HEAD_SNIPPET}</head>`);
  }
  return HEAD_SNIPPET + html;
}

export function shouldThemeMoonlightHtml(urlPath: string): boolean {
  const path = urlPath.split('?')[0];
  return path === '/mlw/stream.html' || path.endsWith('/stream.html');
}
