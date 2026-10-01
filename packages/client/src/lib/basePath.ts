/**
 * Reverse-proxy path prefix the app is served under (e.g. '/sys/ftp'), injected by the server at
 * runtime via a `<meta name="gatwy-base-path">` tag in index.html (see
 * packages/server/src/services/indexHtml.ts). Empty string when served at the root.
 *
 * Most client code never needs this directly: fetch calls use document-relative paths
 * ('api/v1/...', no leading slash) that resolve against the `<base href>` the server also
 * injects. BASE_PATH is only needed where an absolute URL is built manually — WebSocket URLs
 * (which must include scheme + host) and the OIDC redirect URI shown to admins.
 */
export const BASE_PATH: string = (() => {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="gatwy-base-path"]')?.getAttribute('content') ?? '';
})();
