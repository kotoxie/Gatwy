/**
 * Reverse-proxy path prefix the app is served under (e.g. '/sys/ftp'), injected by the server at
 * runtime via a `<meta name="gatwy-base-path">` tag in index.html (see
 * packages/server/src/services/indexHtml.ts). Empty string when served at the root.
 *
 * Most client code never needs this directly: every existing `fetch('/api/...')` and
 * `new WebSocket('.../ws/...')` call site keeps working unmodified — `main.tsx`'s global
 * fetch/WebSocket patches rewrite those same-origin, root-absolute requests with this prefix
 * once, at the source. BASE_PATH is only imported directly where an absolute URL is built for
 * *display*, not a request — the OIDC redirect URI shown to admins.
 */
export const BASE_PATH: string = (() => {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="gatwy-base-path"]')?.getAttribute('content') ?? '';
})();
