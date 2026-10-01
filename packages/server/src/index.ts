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
import { setupMoonlightProxy } from './ws/moonlightProxy.js';
import { ensureMoonlightWeb, isMoonlightWebAvailable, stopMoonlightWeb } from './services/moonlightWeb.js';
import { startAutoBackupScheduler } from './services/autoBackup.js';
import authRoutes from './routes/auth.js';
import connectionRoutes from './routes/connections.js';
import credentialRoutes from './routes/credentials.js';
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
import moonlightRoutes from './routes/moonlight.js';
import { ipRulesMiddleware, guardUpgradesByIpRules } from './middleware/ipRules.js';
import { isTrustedProxyAddress } from './services/ip.js';
import { renderIndexHtml } from './services/indexHtml.js';

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

  // Reverse-proxy path prefix (e.g. '/sys/ftp'), '' at root. See config.ts#normalizeBasePath.
  const bp = config.basePath;

  // Express app
  const app = express();

  // Trust proxy — dynamically evaluated per request so UI changes take effect
  // without a container restart.
  // The predicate lives in services/ip.ts so WebSocket upgrades resolve the client IP the same way.
  app.set('trust proxy', (ip: string) => isTrustedProxyAddress(ip));
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
  app.use(`${bp}/api/v1/smb/:connectionId/upload`, express.raw({ limit: '100mb', type: '*/*' }));
  app.use(`${bp}/api/v1/sftp/:connectionId/upload`, express.raw({ limit: '100mb', type: '*/*' }));
  app.use(`${bp}/api/v1/ftp/:connectionId/upload`, express.raw({ limit: '100mb', type: '*/*' }));
  app.use(`${bp}/api/v1/sessions/:id/recording/chunk`, express.raw({ limit: '100mb', type: '*/*' }));
  app.use(`${bp}/api/v1/backup/import`, express.raw({ limit: '4gb', type: 'application/octet-stream' }));
  app.use(express.json({ limit: '6mb' })); // allow base64-encoded logos (~4 MB image → ~5.4 MB base64)
  app.use(cookieParser());

  // CSRF protection: for state-changing API requests that carry a session cookie,
  // validate the Origin or Referer header matches the server host.
  // This satisfies the double-submit / origin-check CSRF mitigation pattern.
  app.use(`${bp}/api/v1`, (req: express.Request, res: express.Response, next: express.NextFunction) => {
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
  app.use(`${bp}/api/v1`, ipRulesMiddleware);
  app.use(`${bp}/api/v1/auth`, authRoutes);
  app.use(`${bp}/api/v1/connections`, connectionRoutes);
  app.use(`${bp}/api/v1/credentials`, credentialRoutes);
  app.use(`${bp}/api/v1/settings`, settingsRoutes);
  app.use(`${bp}/api/v1/profile/login-sessions`, loginSessionsRoutes);
  app.use(`${bp}/api/v1/profile`, profileRoutes);
  app.use(`${bp}/api/v1/users`, usersRoutes);
  app.use(`${bp}/api/v1/audit`, auditRoutes);
  app.use(`${bp}/api/v1/version`, versionRoutes);
  app.use(`${bp}/api/v1/sessions`, sessionsRoutes);
  app.use(`${bp}/api/v1/backup`, backupRoutes);
  app.use(`${bp}/api/v1/smb`, smbRoutes);
  app.use(`${bp}/api/v1/sftp`, sftpRoutes);
  app.use(`${bp}/api/v1/ftp`, ftpRoutes);
  app.use(`${bp}/api/v1/file-sessions`, fileSessionsRoutes);
  app.use(`${bp}/api/v1/roles`, rolesRoutes);
  app.use(`${bp}/api/v1/notifications`, notificationsRoutes);
  app.use(`${bp}/api/v1/db`, databaseRoutes);
  app.use(`${bp}/api/v1/moonlight`, moonlightRoutes);
  app.use(`${bp}/health`, healthRoutes);

  // Global JSON error handler — prevents Express from returning HTML 500 pages
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Gatwy] Unhandled error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // HTTPS server (created before /mlw so the WS upgrade handler can attach)
  const server = https.createServer({ cert, key }, app);

  // IP rules also apply to every WebSocket upgrade (ssh/rdp/vnc/telnet//mlw) and to /mlw HTTP:
  // /api/v1 is the only Express mount covered by ipRulesMiddleware. Must come before the
  // proxies below register their own 'upgrade' listeners.
  guardUpgradesByIpRules(server);
  app.use(`${bp}/mlw`, ipRulesMiddleware);

  // /mlw HTTP + WS: JWT cookie + protocols.moonlight (same authorizeMoonlightAccess)
  // Must be registered before the SPA catch-all.
  setupMoonlightProxy(server, app, bp);

  // Serve frontend static files
  const clientDir = config.clientDir;
  if (fs.existsSync(clientDir)) {
    app.use(bp || '/', express.static(clientDir, { index: false }));
    const indexHtml = renderIndexHtml(clientDir, bp);
    app.get(`${bp}/{*splat}`, (_req, res) => {
      res.type('html').send(indexHtml);
    });
  } else {
    app.get(bp || '/', (_req, res) => {
      res.json({ message: 'Gatwy API is running. Frontend not built yet.' });
    });
  }

  // WebSocket proxies
  setupRdpProxy(server, bp);
  setupSshProxy(server, bp);
  setupVncProxy(server, bp);
  setupTelnetProxy(server, bp);

  // Graceful shutdown
  function shutdown() {
    console.log('\n[Gatwy] Shutting down gracefully...');
    stopMoonlightWeb();
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
    if (isMoonlightWebAvailable()) {
      ensureMoonlightWeb().catch((err) => {
        console.error('[Moonlight] Failed to start:', err instanceof Error ? err.message : err);
      });
    }
  });
}

main().catch((err) => {
  console.error('[Gatwy] Fatal error:', err);
  process.exit(1);
});
