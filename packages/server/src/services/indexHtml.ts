import fs from 'fs';
import path from 'path';

/**
 * Builds the index.html served for the SPA catch-all route, rewritten to work behind a
 * reverse-proxy path prefix (`BASE_PATH`, see config.ts#normalizeBasePath).
 *
 * The Vite build always emits root-absolute references (`src="/assets/index-<hash>.js"`,
 * `href="/favicon.png"`, ...) because `vite.config.ts` has no `base` option — rebuilding per
 * deployment prefix would defeat the point of a single pre-built Docker image configured via
 * env var. Root-absolute paths ignore `<base href>` (per the URL spec, a path-absolute
 * reference resolves against the base's origin only, not its path), so without this rewrite a
 * request behind e.g. Traefik's `PathPrefix('/sys/ftp')` asks for `/assets/index-<hash>.js` at
 * the host root instead of `/sys/ftp/assets/index-<hash>.js` — 404, or the wrong app's HTML.
 *
 * `<base href>` and a `gatwy-base-path` meta tag are also injected so client code can resolve
 * document-relative URLs (e.g. `fetch('api/v1/...')`) and read the prefix at runtime for the
 * handful of places that build an absolute URL manually (WebSocket URLs, the OIDC redirect URI
 * shown in settings).
 */
export function renderIndexHtml(clientDir: string, basePath: string): string {
  const raw = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf-8');
  let html = raw;
  if (basePath) {
    html = html.replace(/((?:href|src)=")\//g, `$1${basePath}/`);
  }
  const headInjection = `<base href="${basePath}/" />\n    <meta name="gatwy-base-path" content="${basePath}" />\n  </head>`;
  html = html.replace(/<\/head>/, headInjection);
  return html;
}
