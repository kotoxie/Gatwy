import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type https from 'https';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { registerWs, unregisterWs } from './wsRegistry.js';
import { acquireConnection, releaseConnection } from './connectionLimits.js';
import { queryOne, execute } from '../db/helpers.js';
import { redeemWsTicket } from '../services/wsTicket.js';
import { userHasPermission, wsCanAccess } from '../services/permissions.js';
import { applyCredential } from '../services/credentials.js';
import { decrypt, encryptRecordingStream } from '../services/encryption.js';
import { logAudit } from '../services/audit.js';
import { resolveClientIp } from '../services/ip.js';
import { config } from '../config.js';
import { getSetting } from '../services/settings.js';
import { v4 as uuid } from 'uuid';
import { isSessionRevoked } from '../services/loginSession.js';

interface ConnectionRow {
  id: string; host: string; port: number; protocol: string;
  user_id: string; credential_id: string | null;
  username: string | null; encrypted_password: string | null;
  private_key: string | null; name: string;
  recording_enabled: number;
}

/** Write a credential string to a Telnet socket, escaping IAC bytes (C6 security fix).
 *  Without escaping, a 0xFF byte in username/password triggers Telnet command injection. */
function writeTelnetCredential(socket: net.Socket, text: string): void {
  const raw = Buffer.from(text, 'utf8');
  const escaped: number[] = [];
  for (const b of raw) {
    escaped.push(b);
    if (b === IAC) escaped.push(IAC); // RFC 854: double IAC to send literal 0xFF
  }
  escaped.push(0x0D, 0x0A); // \r\n
  socket.write(Buffer.from(escaped));
}

interface TelnetCachedSession {
  socket: net.Socket;
  ws: WebSocket | null;
  outputBuffer: Buffer[];
  outputBufferBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  userId: string;
  tokenHash: string; // H4: bind session to the token that created it
  sessionDbId: string;
  connectionId: string;
  cols: number;
  rows: number;
  castFile: import('stream').Writable | null;
  castStart: number;
}

const MAX_BUFFER = 512 * 1024;
const GRACE_MS = 30_000;

const sessions = new Map<string, TelnetCachedSession>();

function appendToBuffer(s: TelnetCachedSession, data: Buffer) {
  s.outputBuffer.push(data);
  s.outputBufferBytes += data.length;
  while (s.outputBufferBytes > MAX_BUFFER && s.outputBuffer.length > 1) {
    const removed = s.outputBuffer.shift()!;
    s.outputBufferBytes -= removed.length;
  }
}

function startGrace(id: string, onExpire: () => void) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    onExpire();
  }, GRACE_MS);
}

function clearGrace(id: string) {
  const s = sessions.get(id);
  if (s?.timer) { clearTimeout(s.timer); s.timer = null; }
}

// Telnet IAC constants
const IAC  = 0xFF;
const WILL = 0xFB;
const WONT = 0xFC;
const DO   = 0xFD;
const DONT = 0xFE;
const SB   = 0xFA;
const SE   = 0xF0;

// Telnet options
const OPT_ECHO     = 1;
const OPT_SGA      = 3;   // Suppress Go Ahead
const OPT_TTYPE    = 24;  // Terminal Type
const OPT_NAWS     = 31;  // Negotiate About Window Size

function buildIacResponse(data: Buffer): { clean: Buffer; responses: Buffer[] } {
  const responses: Buffer[] = [];
  const clean: number[] = [];
  let i = 0;

  while (i < data.length) {
    if (data[i] === IAC && i + 1 < data.length) {
      const cmd = data[i + 1];

      if (cmd === IAC) {
        // Escaped 0xFF
        clean.push(0xFF);
        i += 2;
        continue;
      }

      if ((cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) && i + 2 < data.length) {
        const opt = data[i + 2];

        if (cmd === DO) {
          if (opt === OPT_TTYPE) {
            responses.push(Buffer.from([IAC, WILL, OPT_TTYPE]));
          } else if (opt === OPT_NAWS) {
            responses.push(Buffer.from([IAC, WILL, OPT_NAWS]));
          } else {
            responses.push(Buffer.from([IAC, WONT, opt]));
          }
        } else if (cmd === WILL) {
          if (opt === OPT_ECHO || opt === OPT_SGA) {
            responses.push(Buffer.from([IAC, DO, opt]));
          } else {
            responses.push(Buffer.from([IAC, DONT, opt]));
          }
        }
        // DONT/WONT — no response needed
        i += 3;
        continue;
      }

      if (cmd === SB) {
        // Subnegotiation — find SE
        let j = i + 2;
        while (j < data.length - 1) {
          if (data[j] === IAC && data[j + 1] === SE) break;
          j++;
        }
        // Handle terminal type subnegotiation request (IAC SB TTYPE SEND IAC SE)
        if (i + 3 < data.length && data[i + 2] === OPT_TTYPE && data[i + 3] === 1) {
          // Reply: IAC SB TTYPE IS xterm-256color IAC SE
          const termType = Buffer.from('xterm-256color');
          const reply = Buffer.alloc(termType.length + 6);
          reply[0] = IAC; reply[1] = SB; reply[2] = OPT_TTYPE; reply[3] = 0; // IS
          termType.copy(reply, 4);
          reply[termType.length + 4] = IAC;
          reply[termType.length + 5] = SE;
          responses.push(reply);
        }
        i = j + 2; // Skip past IAC SE
        continue;
      }

      // Other 2-byte IAC commands
      i += 2;
      continue;
    }

    clean.push(data[i]);
    i++;
  }

  return { clean: Buffer.from(clean), responses };
}

function buildNawsSubneg(cols: number, rows: number): Buffer {
  // IAC SB NAWS <width-hi> <width-lo> <height-hi> <height-lo> IAC SE
  // Need to escape 0xFF bytes in the data
  const buf: number[] = [IAC, SB, OPT_NAWS];
  const addByte = (b: number) => { buf.push(b); if (b === 0xFF) buf.push(0xFF); };
  addByte((cols >> 8) & 0xFF);
  addByte(cols & 0xFF);
  addByte((rows >> 8) & 0xFF);
  addByte(rows & 0xFF);
  buf.push(IAC, SE);
  return Buffer.from(buf);
}

function teardownSession(
  clientSessionId: string,
  session: TelnetCachedSession,
  userId: string,
  host: string,
  port: number,
  connectionId: string,
  sessionDbId: string,
  clientIp: string,
): void {
  if (session.castFile) { try { session.castFile.end(); } catch { /**/ } session.castFile = null; }
  try { session.socket.destroy(); } catch { /**/ }
  execute("UPDATE sessions SET ended_at = datetime('now') WHERE id = ?", [sessionDbId]);
  logAudit({
    userId, eventType: 'session.telnet.disconnect',
    target: `${host}:${port}`,
    details: { connectionId, sessionId: sessionDbId }, ipAddress: clientIp,
  });
  sessions.delete(clientSessionId);
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
    const s = sessions.get(clientSessionId);
    if (!s) return;
    try {
      const json = JSON.parse(typeof msg === 'string' ? msg : msg.toString('utf8'));
      if (json.type === 'resize') {
        s.cols = json.cols; s.rows = json.rows;
        s.socket.write(buildNawsSubneg(s.cols, s.rows));
      } else if (json.type === 'data') {
        s.socket.write(json.data);
      }
    } catch {
      const s2 = sessions.get(clientSessionId);
      if (s2) s2.socket.write(msg as Buffer);
    }
  });
  ws.on('close', () => {
    const s = sessions.get(clientSessionId);
    if (s) {
      s.ws = null;
      startGrace(clientSessionId, () =>
        teardownSession(clientSessionId, s, userId, host, port, connectionId, sessionDbId, clientIp));
    }
  });
  ws.on('error', () => { const s = sessions.get(clientSessionId); if (s) s.ws = null; });
}

export function setupTelnetProxy(server: https.Server, basePath = ''): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `https://${req.headers.host}`);
    if (url.pathname === `${basePath}/ws/telnet`) {
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
    if (!userHasPermission(userId, 'protocols.telnet')) { ws.close(4003, 'Protocol not permitted'); return; }

    registerWs(tokenHash, ws);
    ws.once('close', () => unregisterWs(tokenHash, ws));

    // Reattach path
    const cached = sessions.get(clientSessionId);
    if (cached && cached.userId === userId && cached.connectionId === connectionId && cached.tokenHash === tokenHash) {
      clearGrace(clientSessionId);
      cached.ws = ws;
      ws.send(JSON.stringify({ type: 'status', message: 'Reattached' }));
      for (const chunk of cached.outputBuffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      }
      wireClientWs(clientSessionId, ws, userId, '', 0, connectionId, cached.sessionDbId, clientIp);
      return;
    }

    // New session
    // Enforce per-user and global connection limits (H2)
    const limit = acquireConnection(userId);
    if (!limit.allowed) { ws.close(4008, limit.reason ?? 'Connection limit'); return; }

    const access = wsCanAccess(userId);
    const connRow = queryOne<ConnectionRow>(
      `SELECT * FROM connections WHERE id = ? AND ${access.where}`,
      [connectionId, ...access.params],
    );
    const conn = connRow ? applyCredential(connRow, userId) : undefined;
    if (!conn || conn.protocol !== 'telnet') { ws.close(4002, 'Not found or not Telnet'); return; }

    const sessionDbId = uuid();
    const globalRecording = getSetting('session.recording_enabled') === 'true';
    const doRecord = globalRecording && conn.recording_enabled === 1;

    // Wrapped: this runs inside a raw 'connection' event handler, not an Express route,
    // so an unguarded throw here isn't caught by anything and would crash the process.
    if (doRecord) {
      try {
        const actingUser = queryOne<{ username: string }>('SELECT username FROM users WHERE id = ?', [userId]);
        execute('INSERT INTO sessions (id, user_id, connection_id, protocol, username, connection_name) VALUES (?, ?, ?, ?, ?, ?)',
          [sessionDbId, userId, connectionId, 'telnet', actingUser?.username ?? null, conn.name]);
      } catch (err) {
        console.error('[telnetProxy] Failed to create session record:', err);
      }
    }
    logAudit({
      userId, eventType: 'session.telnet.connect',
      target: `${conn.host}:${conn.port}`,
      details: { connectionId, sessionId: sessionDbId, connectionName: conn.name }, ipAddress: clientIp,
    });

    let cols = 80, rows = 24;
    ws.once('message', (msg: Buffer | string) => {
      try {
        const json = JSON.parse(typeof msg === 'string' ? msg : msg.toString('utf8'));
        if (json.type === 'resize' && json.cols > 0 && json.rows > 0) {
          cols = json.cols;
          rows = json.rows;
        }
      } catch { /* ignore */ }
    });

    const socket = net.createConnection({ host: conn.host, port: conn.port }, () => {
      ws.send(JSON.stringify({ type: 'status', message: 'Connected' }));

      let castFile: import('stream').Writable | null = null;
      let castStart = 0;

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

      const session: TelnetCachedSession = {
        socket, ws, timer: null,
        outputBuffer: [], outputBufferBytes: 0,
        userId, tokenHash, sessionDbId, connectionId,
        cols, rows,
        castFile, castStart,
      };
      sessions.set(clientSessionId, session);

      // Send initial NAWS
      socket.write(buildNawsSubneg(cols, rows));

      // Send credentials if available
      const password = conn.encrypted_password
        ? (() => { try { return decrypt(conn.encrypted_password!); } catch { return ''; } })()
        : '';

      let loginSent = false;
      let passwordSent = false;
      let loginBuffer = '';

      socket.on('data', (data: Buffer) => {
        const s = sessions.get(clientSessionId);
        if (!s) return;

        // Process IAC commands
        const { clean, responses } = buildIacResponse(data);
        for (const resp of responses) socket.write(resp);

        if (clean.length > 0) {
          appendToBuffer(s, clean);
          if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(clean);

          const text = clean.toString('utf8');
          if (s.castFile) {
            const elapsed = (Date.now() - s.castStart) / 1000;
            s.castFile.write(JSON.stringify([elapsed, 'o', text]) + '\n');
          }

          // Auto-login: detect login/password prompts
          if (!loginSent || !passwordSent) {
            loginBuffer += text;
            const lower = loginBuffer.toLowerCase();
            if (!loginSent && (lower.includes('login:') || lower.includes('username:'))) {
              if (conn.username) {
                writeTelnetCredential(socket, conn.username);
                loginSent = true;
                loginBuffer = '';
              }
            } else if (loginSent && !passwordSent && lower.includes('password:')) {
              if (password) {
                writeTelnetCredential(socket, password);
              }
              passwordSent = true;
              loginBuffer = '';
            }
            // Truncate buffer to prevent unbounded growth
            if (loginBuffer.length > 2000) loginBuffer = loginBuffer.slice(-500);
          }
        }
      });

      socket.on('close', () => {
        const s = sessions.get(clientSessionId);
        if (s?.ws?.readyState === WebSocket.OPEN) s.ws.close(1000, 'Connection closed');
        teardownSession(clientSessionId, session, userId, conn.host, conn.port, connectionId, sessionDbId, clientIp);
      });

      socket.on('error', (err) => {
        console.error('[telnet] socket error:', err.message);
        const s = sessions.get(clientSessionId);
        if (s?.ws?.readyState === WebSocket.OPEN) {
          s.ws.send(JSON.stringify({ type: 'error', message: err.message }));
          s.ws.close(4003, err.message);
        }
      });

      wireClientWs(clientSessionId, ws, userId, conn.host, conn.port, connectionId, sessionDbId, clientIp);
    });

    socket.on('error', (err) => {
      console.error('[telnet] connect error:', err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close(4003, err.message);
      }
    });

    socket.setTimeout(15000, () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Connection timed out' }));
        ws.close(4003, 'Timeout');
      }
      socket.destroy();
    });
  });
}
