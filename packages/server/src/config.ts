import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Normalizes a reverse-proxy path prefix (e.g. for Traefik `PathPrefix('/sys/ftp')` routing):
 * always starts with a single leading `/`, never ends with a trailing `/`, and is `''` for root
 * (so every consumer can safely do `${basePath}/api/v1/...` without special-casing root).
 */
export function normalizeBasePath(raw: string | undefined): string {
  if (!raw) return '';
  let p = raw.trim();
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = `/${p}`;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p === '/' ? '' : p;
}

export const config = {
  port: parseInt(process.env.PORT || '7443', 10),
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, '../../..', 'data'),
  tlsCertPath: process.env.TLS_CERT_PATH || '',
  tlsKeyPath: process.env.TLS_KEY_PATH || '',
  jwtSecret: process.env.JWT_SECRET || '',
  sessionTimeout: process.env.SESSION_TIMEOUT || '90d',
  // Reverse-proxy path prefix Gatwy is served under, e.g. '/sys/ftp'. Empty string ('') means
  // root, which is fully backward compatible with every existing deployment.
  basePath: normalizeBasePath(process.env.BASE_PATH),

  get dbPath() {
    return path.join(this.dataDir, 'gatwy.db');
  },
  get certsDir() {
    return path.join(this.dataDir, 'certs');
  },
  get recordingsDir() {
    return path.join(this.dataDir, 'recordings');
  },
  get logsDir() {
    return path.join(this.dataDir, 'logs');
  },
  get jwtSecretPath() {
    return path.join(this.dataDir, 'jwt.secret');
  },
  get clientDir() {
    return path.resolve(__dirname, '../../client/dist');
  },
};
