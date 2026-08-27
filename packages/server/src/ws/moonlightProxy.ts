import http from 'http';
import type { Server, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
  ensureMoonlightWeb,
  getMoonlightRuntimeError,
  isMoonlightWebAvailable,
  MOONLIGHT_UNAVAILABLE_BODY,
  moonlightProxyHeader,
  moonlightUpstream,
} from '../services/moonlightWeb.js';
import { authorizeMoonlightAccess } from './moonlightAuth.js';

const PREFIX = '/mlw';

/**
 * CSP for proxied /mlw documents only. STUN/TURN stay off the global helmet
 * policy in index.ts so WebRTC ICE cannot probe topology from the main app.
 */
export const MLW_FRAME_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
  "connect-src 'self' wss: ws: blob: stun: turn:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
].join('; ');

function shouldProxy(url: string | undefined): boolean {
  if (!url) return false;
  return url === PREFIX || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`);
}

function unavailableBody() {
  const runtimeError = getMoonlightRuntimeError();
  if (!runtimeError) return MOONLIGHT_UNAVAILABLE_BODY;
  return { ...MOONLIGHT_UNAVAILABLE_BODY, error: runtimeError };
}

function writeUpgradeError(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Reverse-proxy moonlight-web (HTTP + WebSocket) under /mlw.
 * HTTP GET/HEAD/POST /mlw/* and the WS upgrade use the same authorizeMoonlightAccess()
 * check: JWT cookie (or Bearer) + login session + protocols.moonlight + runtime.
 */
export function setupMoonlightProxy(server: Server, app: import('express').Express): void {
  const header = moonlightProxyHeader();

  app.use(PREFIX, async (req, res) => {
    const auth = authorizeMoonlightAccess(req);
    if (!auth.ok) {
      if (auth.status === 503) {
        res.status(503).json(unavailableBody());
        return;
      }
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    if (!isMoonlightWebAvailable()) {
      res.status(503).json(unavailableBody());
      return;
    }

    try {
      await ensureMoonlightWeb();
    } catch (err) {
      res.status(503).json({
        error: err instanceof Error ? err.message : 'Moonlight unavailable',
        available: false,
      });
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
        const outHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
        delete outHeaders['content-security-policy'];
        delete outHeaders['content-security-policy-report-only'];
        outHeaders['content-security-policy'] = MLW_FRAME_CSP;
        res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
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

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (!shouldProxy(url)) return;

    const auth = authorizeMoonlightAccess(req);
    if (!auth.ok) {
      const reason = auth.status === 403 ? 'Forbidden'
        : auth.status === 503 ? 'Service Unavailable'
          : 'Unauthorized';
      writeUpgradeError(socket, auth.status, reason);
      return;
    }

    if (!isMoonlightWebAvailable()) {
      writeUpgradeError(socket, 503, 'Service Unavailable');
      return;
    }

    void (async () => {
      try {
        await ensureMoonlightWeb();
      } catch {
        writeUpgradeError(socket, 503, 'Service Unavailable');
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
