import crypto from 'crypto';
import http from 'http';
import type { Server, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
  ensureMoonlightWeb,
  isMoonlightWebAvailable,
  MOONLIGHT_UNAVAILABLE_BODY,
  moonlightProxyHeader,
  moonlightUpstream,
} from '../services/moonlightWeb.js';
import { verifyToken } from '../services/jwt.js';
import { checkAndTouchSession } from '../services/loginSession.js';
import { userHasPermission } from '../services/permissions.js';

const PREFIX = '/mlw';

function shouldProxy(url: string | undefined): boolean {
  if (!url) return false;
  return url === PREFIX || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function authorizeUpgrade(req: IncomingMessage): boolean {
  try {
    const token = parseCookie(req.headers.cookie, 'gatwy_token');
    if (!token) return false;
    const payload = verifyToken(token);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const status = checkAndTouchSession(tokenHash, false);
    if (status === 'revoked' || status === 'idle_expired') return false;
    if (!isMoonlightWebAvailable()) return false;
    return userHasPermission(payload.userId, 'protocols.moonlight');
  } catch {
    return false;
  }
}

/**
 * Reverse-proxy moonlight-web (HTTP + WebSocket) under /mlw.
 * Injects the forwarded-user header so MLW trusts Gatwy as the auth front-door.
 * Callers must already be authenticated for stream pages via Gatwy session cookie
 * when going through the gated middleware; the binary itself uses header auth.
 */
export function setupMoonlightProxy(server: Server, app: import('express').Express): void {
  const header = moonlightProxyHeader();

  // HTTP proxy for /mlw/*
  app.use(PREFIX, async (req, res) => {
    if (!isMoonlightWebAvailable()) {
      res.status(503).json(MOONLIGHT_UNAVAILABLE_BODY);
      return;
    }

    try {
      await ensureMoonlightWeb();
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Moonlight unavailable' });
      return;
    }

    const upstream = moonlightUpstream();
    const targetPath = req.originalUrl.startsWith(PREFIX)
      ? req.originalUrl
      : `${PREFIX}${req.url}`;

    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `${upstream.host}:${upstream.port}` };
    headers[header.name] = header.value;
    delete headers['content-length'];

    const proxyReq = http.request(
      {
        host: upstream.host,
        port: upstream.port,
        path: targetPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: `Moonlight proxy error: ${err.message}` });
      } else {
        res.end();
      }
    });

    req.pipe(proxyReq);
  });

  // WebSocket upgrades for /mlw/api/host/stream etc.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (!shouldProxy(url)) return;

    if (!authorizeUpgrade(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isMoonlightWebAvailable()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    void (async () => {
      try {
        await ensureMoonlightWeb();
      } catch {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const upstream = moonlightUpstream();
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `${upstream.host}:${upstream.port}` };
      headers[header.name] = header.value;

      const proxyReq = http.request({
        host: upstream.host,
        port: upstream.port,
        path: url,
        method: 'GET',
        headers,
      });

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        const lines = [
          'HTTP/1.1 101 Switching Protocols',
          ...Object.entries(proxyRes.headers).flatMap(([k, v]) => {
            if (v === undefined) return [];
            if (Array.isArray(v)) return v.map((item) => `${k}: ${item}`);
            return [`${k}: ${v}`];
          }),
          '',
          '',
        ];
        socket.write(lines.join('\r\n'));
        if (proxyHead.length) proxySocket.write(proxyHead);
        if (head.length) socket.write(head);

        proxySocket.pipe(socket);
        socket.pipe(proxySocket);

        proxySocket.on('error', () => socket.destroy());
        socket.on('error', () => proxySocket.destroy());
      });

      proxyReq.on('error', () => {
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        } catch { /* ignore */ }
        socket.destroy();
      });

      // If upstream responds without upgrade, close
      proxyReq.on('response', (res) => {
        const lines = [
          `HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`.trim(),
          ...Object.entries(res.headers).flatMap(([k, v]) => {
            if (v === undefined) return [];
            if (Array.isArray(v)) return v.map((item) => `${k}: ${item}`);
            return [`${k}: ${v}`];
          }),
          '',
          '',
        ];
        socket.write(lines.join('\r\n'));
        res.pipe(socket);
      });

      proxyReq.end();
    })();
  });
}
