import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type https from 'https';
import { Client as SshClient, type ClientChannel } from 'ssh2';
import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { hashToken, isSessionRevoked } from '../services/loginSession.js';
import { registerWs, unregisterWs } from './wsRegistry.js';
import { acquireConnection, releaseConnection } from './connectionLimits.js';
import { queryOne, execute } from '../db/helpers.js';
import { redeemWsTicket } from '../services/wsTicket.js';
import { userHasPermission, wsCanAccess } from '../services/permissions.js';
import { decrypt, encryptRecordingStream } from '../services/encryption.js';
import { logAudit } from '../services/audit.js';
import { resolveClientIp } from '../services/ip.js';
import { config } from '../config.js';
import { getSetting } from '../services/settings.js';
import { v4 as uuid } from 'uuid';
import {
  storeSession,
  getSession,
  removeSession,
  appendToBuffer,
  startGrace,
  clearGrace,
  type SshCachedSession,
} from './sshSessionCache.js';
import { CommandTracker } from './commandTracker.js';

interface ConnectionRow {
  id: string; host: string; port: number; protocol: string;
  username: string | null; encrypted_password: string | null;
  private_key: string | null; name: string;
  recording_enabled: number;
  tunnels_json: string | null;
  host_fingerprint: string | null;
  extra_config_json: string | null;
}

interface TunnelConfig { localPort: number; remoteHost: string; remotePort: number; }
interface TunnelStatus extends TunnelConfig { status: 'listening' | 'failed'; error?: string; }

const MAX_TUNNELS_PER_SESSION = 5;

/** Block loopback and cloud metadata endpoints in tunnel remote hosts (C8 SSRF fix).
 *  RFC-1918 private ranges are intentionally allowed — tunnels to internal servers are a
 *  legitimate use case relative to the SSH target's network, not the Gatwy server. */
function isDangerousTunnelHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    /^127\./.test(h) ||                // IPv4 loopback
    h === '::1' ||                     // IPv6 loopback
    h === 'localhost' ||               // loopback hostname
    /^169\.254\./.test(h) ||           // link-local / cloud metadata (AWS/Azure/GCP)
    /^0\.0\.0\.0/.test(h) ||           // unspecified address
    /^fc00:/i.test(h) ||               // unique local IPv6
    /^fe80:/i.test(h)                  // link-local IPv6
  );
}

function teardownSession(
  clientSessionId: string,
  session: SshCachedSession,
  userId: string,
  host: string,
  port: number,
  connectionId: string,
  sessionDbId: string,
  clientIp: string,
): void {
  if (session.castFile) { try { session.castFile.end(); } catch { /**/ } session.castFile = null; }
  if (session.cmdTracker) { try { session.cmdTracker.flush(); } catch { /**/ } session.cmdTracker = null; }
  session.tunnelServers.forEach((s) => { try { s.close(); } catch { /**/ } });
  try { session.ssh.end(); } catch { /**/ }
  execute("UPDATE sessions SET ended_at = datetime('now') WHERE id = ?", [sessionDbId]);
  logAudit({
    userId, eventType: 'session.ssh.disconnect',
    target: `${host}:${port}`,
    details: { connectionId, sessionId: sessionDbId }, ipAddress: clientIp,
  });
  removeSession(clientSessionId);
  releaseConnection(userId);
}

function wireClientWs(
  clientSessionId: string,
  ws: WebSocket,
  userId: string,
  host: string,
  port: number,
  connectionId: string,
  sessionDbId: string,
  clientIp: string,
): void {
  ws.on('message', (msg: Buffer | string) => {
    const s = getSession(clientSessionId);
    if (!s) return;
    try {
      const json = JSON.parse(typeof msg === 'string' ? msg : msg.toString('utf8'));
      if (json.type === 'resize') {
        s.cols = json.cols; s.rows = json.rows;
        s.shellStream.setWindow(s.rows, s.cols, 0, 0);
      } else if (json.type === 'data') {
        s.shellStream.write(json.data);
        if (s.cmdTracker) s.cmdTracker.feedInput(json.data);
      }
    } catch {
      const s2 = getSession(clientSessionId);
      if (s2) s2.shellStream.write(msg as Buffer);
    }
  });
  ws.on('close', () => {
    const s = getSession(clientSessionId);
    if (s) {
      s.ws = null;
      startGrace(clientSessionId, () =>
        teardownSession(clientSessionId, s, userId, host, port, connectionId, sessionDbId, clientIp));
    }
  });
  ws.on('error', () => { const s = getSession(clientSessionId); if (s) s.ws = null; });
}

export function setupSshProxy(server: https.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `https://${req.headers.host}`);
    if (url.pathname === '/ws/ssh') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '', `https://${req.headers.host}`);
    const ticketId = url.searchParams.get('ticket');
    const connectionId = url.searchParams.get('connectionId');
    const clientSessionId = url.searchParams.get('sessionId') || uuid();
    const clientIp = resolveClientIp(req);

    if (!ticketId || !connectionId) { ws.close(4001, 'Missing params'); return; }

    const ticketData = redeemWsTicket(ticketId);
    if (!ticketData) { ws.close(4001, 'Invalid or expired ticket'); return; }
    const { userId, tokenHash } = ticketData;

    if (isSessionRevoked(tokenHash)) { ws.close(4001, 'Session revoked'); return; }

    // Protocol permission check
    if (!userHasPermission(userId, 'protocols.ssh')) { ws.close(4003, 'Protocol not permitted'); return; }

    registerWs(tokenHash, ws);
    ws.once('close', () => unregisterWs(tokenHash, ws));

    // ── Reattach path ────────────────────────────────────────────────────────
    const cached = getSession(clientSessionId);
    if (cached && cached.userId === userId && cached.connectionId === connectionId && cached.tokenHash === tokenHash) {
      clearGrace(clientSessionId);
      cached.ws = ws;
      ws.send(JSON.stringify({ type: 'status', message: 'Reattached' }));
      // Replay buffered output so the terminal catches up
      for (const chunk of cached.outputBuffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      }
      wireClientWs(clientSessionId, ws, userId, '', 0, connectionId, cached.sessionDbId, clientIp);
      return;
    }

    // ── New session path ─────────────────────────────────────────────────────
    // Enforce per-user and global connection limits (H2)
    const limit = acquireConnection(userId);
    if (!limit.allowed) { ws.close(4008, limit.reason ?? 'Connection limit'); return; }

    const access = wsCanAccess(userId);
    const conn = queryOne<ConnectionRow>(
      `SELECT * FROM connections WHERE id = ? AND ${access.where}`,
      [connectionId, ...access.params],
    );
    if (!conn || conn.protocol !== 'ssh') { ws.close(4002, 'Not found or not SSH'); return; }

    const sessionDbId = uuid();
    const globalRecording = getSetting('session.recording_enabled') === 'true';
    const doRecord = globalRecording && conn.recording_enabled === 1;

    // Only track in sessions table when a recording will be made
    if (doRecord) {
      execute('INSERT INTO sessions (id, user_id, connection_id, protocol) VALUES (?, ?, ?, ?)',
        [sessionDbId, userId, connectionId, 'ssh']);
    }
    logAudit({
      userId, eventType: 'session.ssh.connect',
      target: `${conn.host}:${conn.port}`,
      details: { connectionId, sessionId: sessionDbId, connectionName: conn.name }, ipAddress: clientIp,
    });
    let castFile: import('stream').Writable | null = null;
    let castStart = 0;

    const ssh = new SshClient();
    let cols = 80, rows = 24;

    ssh.on('banner', (message: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(message));
    });

    ssh.on('ready', () => {
      ws.send(JSON.stringify({ type: 'status', message: 'Connected' }));

      if (doRecord) {
        const recordingsDir = path.join(config.dataDir, 'recordings');
        fs.mkdirSync(recordingsDir, { recursive: true });
        const castPath = path.join(recordingsDir, `${sessionDbId}.cast`);
        castStart = Date.now();
        const fileStream = fs.createWriteStream(castPath);
        const cipherStream = encryptRecordingStream();
        cipherStream.pipe(fileStream);
        castFile = cipherStream;
        const header = JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(castStart / 1000), title: conn.name });
        castFile.write(header + '\n');
        execute("UPDATE sessions SET recording_path = ? WHERE id = ?", [castPath, sessionDbId]);
      }

      const tunnelServers: net.Server[] = [];
      let tunnelConfigs: TunnelConfig[] = [];
      try {
        if (conn.tunnels_json) tunnelConfigs = JSON.parse(conn.tunnels_json) as TunnelConfig[];
      } catch { /* ignore */ }

      if (tunnelConfigs.length > 0) {
        // Enforce tunnel count limit and block dangerous remote hosts (C8 SSRF fix)
        tunnelConfigs = tunnelConfigs
          .slice(0, MAX_TUNNELS_PER_SESSION)
          .filter((t) => !isDangerousTunnelHost(t.remoteHost));

        // Set up each tunnel and collect status asynchronously, then notify the client once all are ready.
        const tunnelStatuses: TunnelStatus[] = [];
        let pending = 0;

        for (const tunnel of tunnelConfigs) {
          if (!tunnel.localPort || !tunnel.remoteHost || !tunnel.remotePort) continue;
          pending++;
          const statusEntry: TunnelStatus = { ...tunnel, status: 'listening' };
          tunnelStatuses.push(statusEntry);

          const srv = net.createServer((localSocket) => {
            const s = getSession(clientSessionId);
            if (!s) { localSocket.destroy(); return; }
            s.ssh.forwardOut('127.0.0.1', tunnel.localPort, tunnel.remoteHost, tunnel.remotePort, (err, stream) => {
              if (err) { localSocket.destroy(); return; }
              localSocket.pipe(stream); stream.pipe(localSocket);
              localSocket.on('close', () => stream.destroy());
              stream.on('close', () => localSocket.destroy());
              stream.on('error', () => localSocket.destroy());
              localSocket.on('error', () => stream.destroy());
            });
          });

          srv.once('listening', () => {
            statusEntry.status = 'listening';
            pending--;
            if (pending === 0 && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tunnels', tunnels: tunnelStatuses }));
            }
          });

          srv.once('error', (err: NodeJS.ErrnoException) => {
            statusEntry.status = 'failed';
            statusEntry.error = err.code === 'EADDRINUSE'
              ? `Port ${tunnel.localPort} already in use`
              : (err.message ?? 'Unknown error');
            pending--;
            if (pending === 0 && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tunnels', tunnels: tunnelStatuses }));
            }
          });

          srv.listen(tunnel.localPort, '127.0.0.1');
          tunnelServers.push(srv);
        }
      }

      ssh.shell({ term: 'xterm-256color', cols, rows }, (err, shellStream: ClientChannel) => {
        if (err) {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          ws.close(4003, 'Shell error'); return;
        }

        const session: SshCachedSession = {
          ssh, shellStream, tunnelServers,
          outputBuffer: [], outputBufferBytes: 0,
          ws, timer: null,
          userId, tokenHash, sessionDbId, connectionId,
          cols, rows,
          castFile, castStart,
          cmdTracker: doRecord ? new CommandTracker(sessionDbId, castStart) : null,
        };
        storeSession(clientSessionId, session);
        shellStream.setWindow(rows, cols, 0, 0);

        shellStream.on('data', (data: Buffer) => {
          const s = getSession(clientSessionId);
          if (!s) return;
          appendToBuffer(s, data);
          if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(data);
          const text = data.toString('utf8');
          if (s.cmdTracker) s.cmdTracker.feedOutput(text);
          if (s.castFile) {
            const elapsed = (Date.now() - s.castStart) / 1000;
            s.castFile.write(JSON.stringify([elapsed, 'o', text]) + '\n');
          }
        });
        shellStream.stderr.on('data', (data: Buffer) => {
          const s = getSession(clientSessionId);
          if (s?.ws?.readyState === WebSocket.OPEN) s.ws.send(data);
        });
        shellStream.on('close', () => {
          const s = getSession(clientSessionId);
          if (s?.ws?.readyState === WebSocket.OPEN) s.ws.close(1000, 'Shell closed');
          teardownSession(clientSessionId, session, userId, conn.host, conn.port, connectionId, sessionDbId, clientIp);
        });

        wireClientWs(clientSessionId, ws, userId, conn.host, conn.port, connectionId, sessionDbId, clientIp);
      });
    });

    ssh.on('error', (err: Error) => {
      console.error('[ssh] error:', err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close(4003, err.message);
      }
    });

    let extraCfg: Record<string, unknown> = {};
    try { if (conn.extra_config_json) extraCfg = JSON.parse(conn.extra_config_json) as Record<string, unknown>; } catch { /* ignore */ }
    const promptOnConnect = extraCfg.promptOnConnect === true;

    const password = conn.encrypted_password
      ? (() => { try { return decrypt(conn.encrypted_password!); } catch { return undefined; } })()
      : undefined;
    const privateKey = conn.private_key
      ? (() => { try { return decrypt(conn.private_key!); } catch { return undefined; } })()
      : undefined;

    const hostVerifier = (key: Buffer): boolean => {
      const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
      if (conn.host_fingerprint) {
        return conn.host_fingerprint === fingerprint;
      }
      execute('UPDATE connections SET host_fingerprint = ? WHERE id = ?', [fingerprint, conn.id]);
      return true;
    };

    if (promptOnConnect) {
      const authTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
          ws.close(4007, 'Auth timeout');
        }
      }, 30000);

      ws.once('message', (authMsg: Buffer | string) => {
        clearTimeout(authTimeout);
        let oneTimePassword: string | undefined;
        try {
          const json = JSON.parse(typeof authMsg === 'string' ? authMsg : authMsg.toString('utf8'));
          if (json.type !== 'auth' || typeof json.password !== 'string') {
            if (ws.readyState === WebSocket.OPEN) ws.close(4007, 'Expected auth message');
            return;
          }
          oneTimePassword = json.password;
        } catch {
          if (ws.readyState === WebSocket.OPEN) ws.close(4007, 'Expected auth message');
          return;
        }
        ws.once('message', (resizeMsg: Buffer | string) => {
          try {
            const json = JSON.parse(typeof resizeMsg === 'string' ? resizeMsg : resizeMsg.toString('utf8'));
            if (json.type === 'resize' && json.cols > 0 && json.rows > 0) {
              cols = json.cols;
              rows = json.rows;
            }
          } catch { /* use defaults */ }
          ssh.connect({
            host: conn.host, port: conn.port,
            username: conn.username || '',
            password: oneTimePassword,
            readyTimeout: 15000,
            hostVerifier,
          });
        });
      });
    } else {
      ws.once('message', (msg: Buffer | string) => {
        try {
          const json = JSON.parse(typeof msg === 'string' ? msg : msg.toString('utf8'));
          if (json.type === 'resize' && json.cols > 0 && json.rows > 0) {
            cols = json.cols;
            rows = json.rows;
          }
        } catch { /* not a resize — ignore */ }
      });
      ssh.connect({
        host: conn.host, port: conn.port,
        username: conn.username || '',
        ...(privateKey ? { privateKey } : { password }),
        readyTimeout: 15000,
        hostVerifier,
      });
    }
  });
}
