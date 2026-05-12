import https from 'https';
import fs from 'fs';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { initDb, persistDb } from './db/index.js';
import { initJwt } from './services/jwt.js';
import { initEncryption } from './services/encryption.js';
import { ensureTlsCerts } from './services/tls.js';
import { setupRdpProxy } from './ws/rdpProxy.js';
import { setupSshProxy } from './ws/sshProxy.js';
import { setupVncProxy } from './ws/vncProxy.js';
import { setupTelnetProxy } from './ws/telnetProxy.js';
import { getSetting } from './services/settings.js';
import { startAutoBackupScheduler } from './services/autoBackup.js';
import authRoutes from './routes/auth.js';
import connectionRoutes from './routes/connections.js';
import healthRoutes from './routes/health.js';
import settingsRoutes from './routes/settings.js';
import profileRoutes from './routes/profile.js';
import loginSessionsRoutes from './routes/loginSessions.js';
import usersRoutes from './routes/users.js';
import auditRoutes from './routes/audit.js';
import versionRoutes from './routes/version.js';
import sessionsRoutes from './routes/sessions.js';
import backupRoutes from './routes/backup.js';
import smbRoutes from './routes/smb.js';
import sftpRoutes from './routes/sftp.js';
import ftpRoutes from './routes/ftp.js';
import fileSessionsRoutes from './routes/file-sessions.js';
import rolesRoutes from './routes/roles.js';
import notificationsRoutes from './routes/notifications.js';
import databaseRoutes from './routes/database.js';
import { ipRulesMiddleware } from './middleware/ipRules.js';

async function main() {
  // Ensure data directories
  for (const dir of [config.dataDir, config.certsDir, config.recordingsDir, config.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Initialize services
  console.log('[Gatwy] Initializing...');
  await initDb();
  initJwt();
  initEncryption();
  startAutoBackupScheduler();

  // Encrypt any plaintext recording files left from crashed sessions
  if (fs.existsSync(config.recordingsDir)) {
    const { encryptRecordingFileInPlace, isEncryptedRecording } = await import('./services/encryption.js');
    for (const fname of fs.readdirSync(config.recordingsDir)) {
      if (!fname.endsWith('.webm') && !fname.endsWith('.cast')) continue;
      const fp = path.join(config.recordingsDir, fname);
      try {
        const buf = fs.readFileSync(fp);
        if (!isEncryptedRecording(buf)) encryptRecordingFileInPlace(fp);
      } catch { /* skip */ }
    }
  }

  const { cert, key } = ensureTlsCerts();

  // Express app
  const app = express();

  // Trust proxy — dynamically evaluated per request so UI changes take effect
  // without a container restart.
  app.set('trust proxy', (ip: string) => {
    // Node.js reports IPv4 clients as ::ffff:x.x.x.x on dual-stack sockets.
    // Strip the IPv6-mapped prefix so configured entries like "192.168.1.1"
    // or "192.168.1.0/24" match correctly.
    const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    const val = getSetting('security.trusted_proxies').trim();
    if (!val || val === 'false') return false;
    if (val === 'true' || val === '*') return true;
    const entries = val.split(',').map((s) => s.trim()).filter(Boolean);
    return entries.some((entry) => {
      if (entry.includes('/')) {
        // CIDR match (IPv4 only)
        try {
          const [range, bitsStr] = entry.split('/');
          const bits = parseInt(bitsStr, 10);
          if (bits < 0 || bits > 32) return false;
          const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
          const toNum = (s: string) =>
            s.split('.').reduce((acc, o) => ((acc << 8) + parseInt(o, 10)) >>> 0, 0) >>> 0;
          return (toNum(addr) & mask) === (toNum(range) & mask);
        } catch { return false; }
      }
      return entry === addr;
    });
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        connectSrc: ["'self'", "wss:", "ws:", "data:"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
      },
    },
  }));
  app.use('/api/v1/smb/:connectionId/upload', express.raw({ limit: '100mb', type: '*/*' }));
  app.use('/api/v1/sftp/:connectionId/upload', express.raw({ limit: '100mb', type: '*/*' }));
  app.use('/api/v1/ftp/:connectionId/upload', express.raw({ limit: '100mb', type: '*/*' }));
  app.use('/api/v1/sessions/:id/recording/chunk', express.raw({ limit: '100mb', type: '*/*' }));
  app.use('/api/v1/backup/import', express.raw({ limit: '4gb', type: 'application/octet-stream' }));
  app.use(express.json({ limit: '6mb' })); // allow base64-encoded logos (~4 MB image → ~5.4 MB base64)
  app.use(cookieParser());

  // CSRF protection: for state-changing API requests that carry a session cookie,
  // validate the Origin or Referer header matches the server host.
  // This satisfies the double-submit / origin-check CSRF mitigation pattern.
  app.use('/api/v1', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    // Only apply to cookie-carrying requests
    if (!req.cookies?.gatwy_token) return next();

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const host = req.headers.host;
    if (!host) return next(); // no Host header — can't validate, allow through

    // Build expected origin from Host header
    const expectedOrigin = `https://${host}`;
    const source = origin ?? (referer ? new URL(referer).origin : undefined);
    if (source && source !== expectedOrigin) {
      res.status(403).json({ error: 'CSRF check failed' });
      return;
    }
    next();
  });

  // API routes
  app.use('/api/v1', ipRulesMiddleware);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/connections', connectionRoutes);
  app.use('/api/v1/settings', settingsRoutes);
  app.use('/api/v1/profile/login-sessions', loginSessionsRoutes);
  app.use('/api/v1/profile', profileRoutes);
  app.use('/api/v1/users', usersRoutes);
  app.use('/api/v1/audit', auditRoutes);
  app.use('/api/v1/version', versionRoutes);
  app.use('/api/v1/sessions', sessionsRoutes);
  app.use('/api/v1/backup', backupRoutes);
  app.use('/api/v1/smb', smbRoutes);
  app.use('/api/v1/sftp', sftpRoutes);
  app.use('/api/v1/ftp', ftpRoutes);
  app.use('/api/v1/file-sessions', fileSessionsRoutes);
  app.use('/api/v1/roles', rolesRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);
  app.use('/api/v1/db', databaseRoutes);
  app.use('/health', healthRoutes);

  // Global JSON error handler — prevents Express from returning HTML 500 pages
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Gatwy] Unhandled error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Serve frontend static files
  const clientDir = config.clientDir;
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({ message: 'Gatwy API is running. Frontend not built yet.' });
    });
  }

  // HTTPS server
  const server = https.createServer({ cert, key }, app);

  // WebSocket proxies
  setupRdpProxy(server);
  setupSshProxy(server);
  setupVncProxy(server);
  setupTelnetProxy(server);

  // Graceful shutdown
  function shutdown() {
    console.log('\n[Gatwy] Shutting down gracefully...');
    persistDb();
    server.close(() => {
      console.log('[Gatwy] Server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start
  server.listen(config.port, () => {
    console.log(`[Gatwy] Running on https://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[Gatwy] Fatal error:', err);
  process.exit(1);
});
