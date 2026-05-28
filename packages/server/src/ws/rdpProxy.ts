import net from 'net';
import tls from 'tls';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type https from 'https';
import { isSessionRevoked } from '../services/loginSession.js';
import { registerWs, unregisterWs } from './wsRegistry.js';
import { acquireConnection, releaseConnection } from './connectionLimits.js';
import { redeemWsTicket } from '../services/wsTicket.js';
import { userHasPermission, wsCanAccess } from '../services/permissions.js';
import { queryOne, execute } from '../db/helpers.js';
import { decrypt } from '../services/encryption.js';
import { logAudit } from '../services/audit.js';
import { resolveClientIp } from '../services/ip.js';
import { v4 as uuid } from 'uuid';

interface ConnectionRow {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username: string | null;
  encrypted_password: string | null;
  name: string;
  skip_cert_validation: number;
}

export function setupRdpProxy(server: https.Server): void {
  const wssRaw = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `https://${req.headers.host}`);

    if (url.pathname === '/ws/rdp-raw') {
      wssRaw.handleUpgrade(req, socket, head, (ws) => {
        wssRaw.emit('connection', ws, req);
      });
    }
  });

  // ── DER helpers ──────────────────────────────────────────────────────────────
  function derLen(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x100) return Buffer.from([0x81, n]);
    return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
  }
  function derTlv(tag: number, content: Buffer): Buffer {
    return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
  }
  function derInt(value: number): Buffer {
    let hex = value.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    let b = Buffer.from(hex, 'hex');
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return derTlv(0x02, b);
  }
  function derUtf8(str: string): Buffer { return derTlv(0x0c, Buffer.from(str, 'utf8')); }
  function derOctet(b: Buffer): Buffer { return derTlv(0x04, b); }
  function derSeq(b: Buffer): Buffer { return derTlv(0x30, b); }
  function derCtx(n: number, b: Buffer): Buffer { return derTlv(0xa0 | n, b); }

  function readDerLen(buf: Buffer, off: number): { value: number; bytesRead: number } {
    const first = buf[off];
    if (first < 0x80) return { value: first, bytesRead: 1 };
    const nb = first & 0x7f;
    let v = 0;
    for (let i = 0; i < nb; i++) v = (v << 8) | buf[off + 1 + i];
    return { value: v, bytesRead: 1 + nb };
  }

  /** Extract the X.224 CR OCTET STRING from an RDCleanPath request DER PDU (field [6]). */
  function extractX224CR(pdu: Buffer): Buffer {
    let off = 0;
    if (pdu[off++] !== 0x30) throw new Error('Expected SEQUENCE');
    const outer = readDerLen(pdu, off);
    off += outer.bytesRead;
    const end = off + outer.value;
    while (off < end) {
      const tag = pdu[off++];
      const fl = readDerLen(pdu, off);
      off += fl.bytesRead;
      const fc = pdu.slice(off, off + fl.value);
      off += fl.value;
      if (tag === 0xa6) {
        let i = 0;
        if (fc[i++] !== 0x04) throw new Error('Expected OCTET STRING in [6]');
        const il = readDerLen(fc, i);
        i += il.bytesRead;
        return fc.slice(i, i + il.value);
      }
    }
    throw new Error('Field [6] (x224_connection_pdu) not found');
  }

  function encodeRDCleanPathResponse(x224cc: Buffer, serverAddr: string, certDers: Buffer[]): Buffer {
    const certContent = certDers.length > 0
      ? Buffer.concat(certDers.map(c => derOctet(c)))
      : Buffer.alloc(0);
    return derSeq(Buffer.concat([
      derCtx(0, derInt(3390)),
      derCtx(6, derOctet(x224cc)),
      derCtx(7, derSeq(certContent)),
      derCtx(9, derUtf8(serverAddr)),
    ]));
  }

  function encodeRDCleanPathError(): Buffer {
    return derSeq(Buffer.concat([
      derCtx(0, derInt(3390)),
      derCtx(1, derSeq(derCtx(0, derInt(1)))),
    ]));
  }

  /**
   * Read one complete TPKT/X.224 PDU from a socket (length from bytes [2-3]).
   * Any leftover bytes are re-emitted as a 'data' event.
   */
  /**
   * Searches for the RDP Client Core Data (TS_UD_CS_CORE, type 0xC001) in a buffer
   * and patches it to request a 32bpp session from xrdp.
   *
   * IronRDP's WASM is compiled with color_depth=16, so xrdp negotiates 16bpp and
   * sends 16bpp legacy bitmaps. IronRDP's canvas renderer always assumes 32bpp input,
   * so any other bpp causes a stride mismatch and display corruption:
   *   16bpp → alternating-row pattern (stride ratio 1:2)
   *   24bpp → diagonal shear pattern  (stride ratio 3:4)
   *   32bpp → correct rendering
   *
   * The three fields required to signal 32bpp to xrdp (MS-RDPBCGR 2.2.1.3.2):
   *   +140 highColorDepth (2)       24  — highest valid enum value for "high color"
   *   +142 supportedColorDepths (2) |= 0x0008  — RNS_UD_32BPP_SUPPORT flag
   *   +144 earlyCapabilityFlags (2) |= 0x0002  — RNS_UD_CS_WANT_32BPP_SESSION flag
   *
   * Returns a new Buffer if patched, or the same reference if CS_CORE was not found.
   */
  function patchHighColorDepth(buf: Buffer): Buffer {
    // TS_UD_CS_CORE header: type = 0xC001 (LE bytes 0x01 0xC0)
    //
    // Scanner strategy:
    //  1. Look for the 0x01 0xC0 type marker.
    //  2. Verify SASSequence at body offset +10 (buffer i+14) == 0xAA03
    //     (RNS_UD_SAS_DEL — every spec-compliant client sets this).
    //     This reliably rejects accidental 0x01 0xC0 byte sequences that
    //     appear in TPKT/X.224/MCS/GCC headers before the real CS_CORE.
    //  3. Only patch when highColorDepth < 32 (i.e. xrdp would negotiate < 32bpp).
    //
    // Fix strategy — two independent paths both result in bpp=32 in xrdp:
    //  a) highColorDepth = 32  →  xrdp: bpp = highColorDepth = 32  (direct assignment)
    //  b) supportedColorDepths |= 0x0008 (RNS_UD_32BPP_SUPPORT)
    //     + earlyCapabilityFlags |= 0x0002 (RNS_UD_CS_WANT_32BPP_SESSION)
    //     →  xrdp: if (earlyCapabilityFlags & 0x0002) && (supportedColorDepths & 0x0008)
    //              then bpp = 32
    //
    // CS_CORE field offsets relative to the 0x01 0xC0 marker at position i
    // (all offsets include the 4-byte TS_UD_HEADER):
    //   i+14  SASSequence        (2) must be 0xAA03
    //   i+140 highColorDepth     (2) patch to 32
    //   i+142 supportedColorDepths (2) set RNS_UD_32BPP_SUPPORT bit
    //   i+144 earlyCapabilityFlags (2) set RNS_UD_CS_WANT_32BPP_SESSION bit
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] !== 0x01 || buf[i + 1] !== 0xC0) continue;
      if (i + 4 > buf.length) continue;
      const csLen = buf.readUInt16LE(i + 2);
      if (csLen < 146 || i + csLen > buf.length) continue;
      if (buf.readUInt16LE(i + 14) !== 0xAA03) continue;   // SASSequence must be RNS_UD_SAS_DEL
      const highColor = buf.readUInt16LE(i + 140);
      if (highColor >= 32) continue;                        // already 32bpp or more, no patch needed
      const patched = Buffer.from(buf);
      patched.writeUInt16LE(32, i + 140);                                        // highColorDepth = 32
      patched.writeUInt16LE(patched.readUInt16LE(i + 142) | 0x0008, i + 142);   // RNS_UD_32BPP_SUPPORT
      patched.writeUInt16LE(patched.readUInt16LE(i + 144) | 0x0002, i + 144);   // RNS_UD_CS_WANT_32BPP_SESSION
      return patched;
    }
    return buf;
  }

  function readX224Pdu(sock: net.Socket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const total = (buf[2] << 8) | buf[3];
        if (buf.length < total) return;
        sock.removeListener('data', onData);
        sock.removeListener('error', onErr);
        sock.removeListener('close', onClose);
        const pdu = buf.slice(0, total);
        const leftover = buf.slice(total);
        if (leftover.length > 0) setImmediate(() => sock.emit('data', leftover));
        resolve(pdu);
      };
      const onErr = (e: Error) => reject(e);
      const onClose = () => reject(new Error('Socket closed before X.224 PDU'));
      sock.on('data', onData);
      sock.once('error', onErr);
      sock.once('close', onClose);
    });
  }

  // ── RDCleanPath proxy for IronRDP ─────────────────────────────────────────────
  wssRaw.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '', `https://${req.headers.host}`);
    const ticketId = url.searchParams.get('ticket');
    const connectionId = url.searchParams.get('connectionId');
    const clientIp = resolveClientIp(req);

    if (!ticketId || !connectionId) { ws.close(4001, 'Missing ticket or connectionId'); return; }

    const ticketData = redeemWsTicket(ticketId);
    if (!ticketData) { ws.close(4001, 'Invalid or expired ticket'); return; }
    const { userId, tokenHash } = ticketData;

    if (isSessionRevoked(tokenHash)) { ws.close(4001, 'Session revoked'); return; }

    // Protocol permission check
    if (!userHasPermission(userId, 'protocols.rdp')) { ws.close(4003, 'Protocol not permitted'); return; }

    registerWs(tokenHash, ws);
    ws.once('close', () => { unregisterWs(tokenHash, ws); releaseConnection(userId); });

    // Enforce per-user and global connection limits (H2)
    const limit = acquireConnection(userId);
    if (!limit.allowed) { ws.close(4008, limit.reason ?? 'Connection limit'); return; }

    const access = wsCanAccess(userId);
    const conn = queryOne<ConnectionRow>(
      `SELECT * FROM connections WHERE id = ? AND ${access.where}`,
      [connectionId, ...access.params],
    );
    if (!conn || conn.protocol !== 'rdp') { ws.close(4002, 'Connection not found or not RDP'); return; }

    const sessionId = uuid();
    // RDP has no recording support — sessions are tracked via audit trail only
    logAudit({ userId, eventType: 'session.rdp.connect',
      target: `${conn.host}:${conn.port}`,
      details: { connectionId, sessionId, connectionName: conn.name }, ipAddress: clientIp });

    let tunnel: net.Socket | null = null;
    let tlsTunnel: tls.TLSSocket | null = null;
    const cleanup = () => {
      if (tlsTunnel) { try { tlsTunnel.destroy(); } catch { /**/ } tlsTunnel = null; }
      if (tunnel) { try { tunnel.destroy(); } catch { /**/ } tunnel = null; }
    };

    // First WebSocket message = RDCleanPath request DER
    ws.once('message', (data: Buffer | string) => {
      const rdcp = typeof data === 'string' ? Buffer.from(data) : (data as Buffer);
      let x224cr: Buffer;
      try { x224cr = extractX224CR(rdcp); }
      catch (e) {
        console.error('[rdp] parse error:', e);
        if (ws.readyState === WebSocket.OPEN) { ws.send(encodeRDCleanPathError()); ws.close(4004, 'Bad PDU'); }
        return;
      }

      // Open TCP tunnel, do X.224 handshake, then upgrade to TLS.
      // IronRDP sends raw CredSSP/RDP bytes through the WebSocket; the proxy
      // wraps them in TLS when talking to the actual RDP host.  The server cert
      // is captured from the TLS handshake and sent back in the RDCleanPath
      // response so IronRDP can compute CredSSP channel bindings.
      tunnel = net.connect(conn.port, conn.host, () => tunnel!.write(x224cr));

      readX224Pdu(tunnel)
        .then((x224cc) => {
          if (ws.readyState !== WebSocket.OPEN) { cleanup(); return; }

          // Upgrade the raw TCP socket to TLS (Node.js/OpenSSL acts as TLS client)
          // skip_cert_validation is a per-connection toggle (C5 security fix — default: validate)
          tlsTunnel = tls.connect({
            socket: tunnel!,
            rejectUnauthorized: conn.skip_cert_validation !== 1,
            host: conn.host,
            ...(conn.skip_cert_validation === 1 ? { checkServerIdentity: () => undefined } : {}),
          });

          tlsTunnel.once('secureConnect', () => {
            // Capture server cert chain for IronRDP's CredSSP channel bindings
            const certs: Buffer[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let c: any = tlsTunnel!.getPeerCertificate(true);
            const seen = new Set<string>();
            while (c && c.raw) {
              const key = (c.raw as Buffer).toString('hex');
              if (seen.has(key)) break;
              seen.add(key);
              certs.push(Buffer.from(c.raw as Buffer));
              c = c.issuerCertificate;
            }
            if (ws.readyState !== WebSocket.OPEN) { cleanup(); return; }

            ws.send(encodeRDCleanPathResponse(x224cc, conn.host, certs));

            const t = tlsTunnel!;

            // TLS → WebSocket
            t.on('data', (chunk: Buffer) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
            });
            t.once('close', () => {
              if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'TCP closed');
            });

            // WebSocket → TLS (patch Client Core Data bpp on the way through)
            let colorDepthPatched = false;
            ws.on('message', (msg: Buffer | string) => {
              let buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as string);
              if (!colorDepthPatched) {
                const patched = patchHighColorDepth(buf);
                if (patched !== buf) colorDepthPatched = true;
                buf = patched;
              }
              if (!t.destroyed && t.writable) t.write(buf);
            });
          });

          tlsTunnel.once('error', (e: Error) => {
            console.error('[rdp] TLS error:', e.message);
            if (ws.readyState === WebSocket.OPEN) { ws.send(encodeRDCleanPathError()); ws.close(4003, 'TLS error'); }
            cleanup();
          });
        })
        .catch((e) => {
          console.error('[rdp] X.224 error:', e);
          if (ws.readyState === WebSocket.OPEN) { ws.send(encodeRDCleanPathError()); ws.close(4003, 'X.224 error'); }
          cleanup();
        });

      tunnel.on('error', (err: Error) => {
        console.error('[rdp] TCP error:', err.message);
        if (ws.readyState === WebSocket.OPEN) ws.close(4003, 'TCP error');
        cleanup();
      });
      // Only fire TCP close if TLS hasn't taken over yet
      tunnel.on('close', () => {
        if (!tlsTunnel && ws.readyState === WebSocket.OPEN) ws.close(1000, 'TCP closed');
      });
    });

    ws.on('close', () => {
      cleanup();
      // Mark the session as ended in the DB — covers the case where the browser
      // closes/crashes before the client can call /recording/finalize.
      execute("UPDATE sessions SET ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?", [sessionId]);
      // Note: RDP recording files are encrypted chunk-by-chunk as they arrive.
      // The finalize endpoint handles cipher cleanup; no re-encryption needed here.
      logAudit({ userId, eventType: 'session.rdp.disconnect',
        target: `${conn.host}:${conn.port}`,
        details: { connectionId, sessionId }, ipAddress: clientIp });
    });
    ws.on('error', () => cleanup());
  });
}
