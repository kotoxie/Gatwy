import fs from 'fs';
import path from 'path';

/**
 * Builds the index.html served for the SPA catch-all route, rewritten to work behind a
 * reverse-proxy path prefix (`BASE_PATH`, see config.ts#normalizeBasePath). 
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
