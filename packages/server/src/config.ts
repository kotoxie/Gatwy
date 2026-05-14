import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '7443', 10),
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, '../../..', 'data'),
  tlsCertPath: process.env.TLS_CERT_PATH || '',
  tlsKeyPath: process.env.TLS_KEY_PATH || '',
  jwtSecret: process.env.JWT_SECRET || '',
  sessionTimeout: process.env.SESSION_TIMEOUT || '90d',

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
