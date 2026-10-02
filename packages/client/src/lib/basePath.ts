/**
 * Reverse-proxy path prefix the app is served under (e.g. '/sys/ftp'), injected by the server at
 * runtime via a `<meta name="gatwy-base-path">` tag in index.html (see
 * packages/server/src/services/indexHtml.ts). Empty string when served at the root.
 */
export const BASE_PATH: string = (() => {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="gatwy-base-path"]')?.getAttribute('content') ?? '';
})();
