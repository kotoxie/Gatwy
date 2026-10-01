import net from 'net';
import type { Server } from 'https';
import { WebSocketServer } from 'ws';
import { queryOne } from '../db/helpers.js';
import { isSessionRevoked } from '../services/loginSession.js';
import { registerWs, unregisterWs } from './wsRegistry.js';
import { acquireConnection, releaseConnection } from './connectionLimits.js';
import { redeemWsTicket } from '../services/wsTicket.js';
import { userHasPermission, wsCanAccess } from '../services/permissions.js';
import { logAudit } from '../services/audit.js';
import { resolveClientIp } from '../services/ip.js';
import { v4 as uuid } from 'uuid';

export function setupVncProxy(server: Server, basePath = ''): void {
  const wss = new WebSocketServer({ noServer: true });
  const mountPrefix = `${basePath}/ws/vnc/`;

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith(mountPrefix)) return;

    // URL format: {basePath}/ws/vnc/{connectionId}?ticket={ws-ticket}
    const [pathname, qs] = url.split('?');
    const connectionId = pathname.slice(mountPrefix.length);
    const ticketId = new URLSearchParams(qs).get('ticket');

    if (!ticketId) { socket.destroy(); return; }

    const ticketData = redeemWsTicket(ticketId);
    if (!ticketData) { socket.destroy(); return; }
    const { userId, tokenHash: vncTokenHash } = ticketData;

    if (isSessionRevoked(vncTokenHash)) { socket.destroy(); return; }

    // Protocol permission check
    if (!userHasPermission(userId, 'protocols.vnc')) { socket.destroy(); return; }

    const access = wsCanAccess(userId);
    const conn = queryOne<{ host: string; port: number; user_id: string; shared: number }>(
      `SELECT host, port, user_id, shared FROM connections WHERE id = ? AND ${access.where} AND protocol = 'vnc'`,
      [connectionId, ...access.params],
    );
    if (!conn) { socket.destroy(); return; }

    const connHost = conn.host;
    const connPort = conn.port;
    const clientIp = resolveClientIp(req);

    wss.handleUpgrade(req, socket as Parameters<typeof wss.handleUpgrade>[1], head, (ws) => {
      // Enforce per-user and global connection limits (H2)
      const limit = acquireConnection(userId);
      if (!limit.allowed) { ws.close(4008, limit.reason ?? 'Connection limit'); return; }

      registerWs(vncTokenHash, ws);

      // VNC has no recording support — sessions are tracked via audit trail only
      const sessionId = uuid();
      logAudit({
        userId,
        eventType: 'session.vnc.connect',
        target: `${connHost}:${connPort || 5900}`,
        details: { connectionId, sessionId },
        ipAddress: clientIp,
      });

      function teardown() {
        logAudit({
          userId,
          eventType: 'session.vnc.disconnect',
          target: `${connHost}:${connPort || 5900}`,
          details: { connectionId, sessionId },
          ipAddress: clientIp,
        });
        unregisterWs(vncTokenHash, ws);
        releaseConnection(userId);
      }

      ws.once('close', teardown);
      const tcp = net.connect(connPort || 5900, connHost);

      tcp.on('connect', () => {
        ws.on('message', (data) => { tcp.write(data as Buffer); });
        tcp.on('data', (data) => { if (ws.readyState === 1) ws.send(data); });
        ws.on('close', () => tcp.destroy());
        tcp.on('close', () => ws.close());
        tcp.on('error', () => ws.close());
        ws.on('error', () => tcp.destroy());
      });

      tcp.on('error', (err) => {
        ws.close(1011, err.message);
      });
    });
  });
}
