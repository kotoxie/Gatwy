import net from 'net';
import tls from 'tls';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
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
import { performCredSSP } from '../services/credssp.js';

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

interface RedirectInfo {
  host: string;
  port: number;
  routingToken?: Buffer;
  username?: string;
  domain?: string;
  password?: string;
}

const IO_CHANNEL_ID = 1003;
const MCS_DISCONNECT_PROVIDER_ULTIMATUM = 0x08;
const PDU_TYPE_DEMAND_ACTIVE = 0x1;
const PDU_TYPE_DEACTIVATE_ALL = 0x6;
const PDU_TYPE_SERVER_REDIRECTION = 0x0a;
const SEC_REDIRECTION_PKT = 0x0400;
const LB_TARGET_NET_ADDRESS = 0x00000001;
const LB_LOAD_BALANCE_INFO = 0x00000002;
const LB_USERNAME = 0x00000004;
const LB_DOMAIN = 0x00000008;
const LB_PASSWORD = 0x00000010;
const LB_TARGET_FQDN = 0x00000100;
const LB_TARGET_NETBIOS_NAME = 0x00000200;
const LB_PASSWORD_IS_PK_ENCRYPTED = 0x00004000;
const RDP_TRACE_ENABLED = process.env.GATWY_RDP_TRACE === '1' || process.env.GATWY_RDP_TRACE === 'true';
const RDP_TRACE_MAX_EVENTS = Number.parseInt(process.env.GATWY_RDP_TRACE_MAX_EVENTS ?? '300', 10);

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

  function encodeRDCleanPathResponse(x224cc: Buffer, serverAddr: string, certDers: Buffer[]): Uint8Array {
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

  function encodeRDCleanPathError(): Uint8Array {
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
  * Returns the buffer to forward and whether a patch was applied.
   */
  function patchHighColorDepth(input: Uint8Array): { buffer: Buffer; patched: boolean } {
    const buf = Buffer.from(input);
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
      return { buffer: patched, patched: true };
    }
    return { buffer: Buffer.from(buf), patched: false };
  }

  function readX224Pdu(sock: net.Socket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Uint8Array) => {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
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

  function parseRdpNegBlock(x224: Buffer): { type: number; flags: number; length: number; value: number } | null {
    if (x224.length < 8) return null;
    const off = x224.length - 8;
    const type = x224[off];
    const flags = x224[off + 1];
    const length = x224.readUInt16LE(off + 2);
    if ((type !== 0x01 && type !== 0x02 && type !== 0x03) || length !== 8) return null;
    return { type, flags, length, value: x224.readUInt32LE(off + 4) };
  }

  function getSelectedProtocol(x224cc: Buffer): number | null {
    const neg = parseRdpNegBlock(x224cc);
    return neg?.type === 0x02 ? neg.value : null;
  }

  function parsePerLength(buf: Buffer, off: number): { value: number; bytesRead: number } | null {
    if (off >= buf.length) return null;
    const first = buf[off];
    if ((first & 0x80) === 0) return { value: first, bytesRead: 1 };
    if (off + 1 >= buf.length) return null;
    return { value: ((first & 0x7f) << 8) | buf[off + 1], bytesRead: 2 };
  }

  function decodeSendDataIndication(frame: Buffer): { channelId: number; userData: Buffer } | null {
    if (frame.length < 8 || frame[0] !== 0x03 || frame[1] !== 0x00 || frame[5] !== 0xf0) return null;

    let off = 7;
    if (off >= frame.length || frame[off] !== 0x68) return null;
    off += 1; // SendDataIndication choice

    if (off + 5 > frame.length) return null;
    off += 2; // initiator id
    const channelId = (frame[off] << 8) | frame[off + 1];
    off += 2;
    off += 1; // dataPriority + segmentation

    const userDataLen = parsePerLength(frame, off);
    if (!userDataLen) return null;
    off += userDataLen.bytesRead;
    if (off + userDataLen.value > frame.length) return null;

    return { channelId, userData: frame.subarray(off, off + userDataLen.value) };
  }

  function isDisconnectProviderUltimatum(frame: Buffer): boolean {
    if (frame.length < 8 || frame[0] !== 0x03 || frame[1] !== 0x00 || frame[5] !== 0xf0) return false;
    return frame[7] === MCS_DISCONNECT_PROVIDER_ULTIMATUM;
  }

  function decodeDisconnectProviderUltimatumReason(frame: Buffer): { raw: number | null; decoded: number | null } {
    if (!isDisconnectProviderUltimatum(frame)) return { raw: null, decoded: null };
    if (frame.length < 9) return { raw: null, decoded: null };
    const raw = frame[8];
    return { raw, decoded: raw & 0x0f };
  }

  function parseShareControlHeader(userData: Buffer): { pduType: number; body: Buffer } | null {
    if (userData.length < 8) return null;
    const totalLength = userData.readUInt16LE(0);
    const pduType = userData.readUInt16LE(2) & 0x0f;
    const bodyLength = Math.max(0, Math.min(totalLength, userData.length) - 8);
    return { pduType, body: userData.subarray(8, 8 + bodyLength) };
  }

  function readLengthPrefixedData(buf: Buffer, off: number, end: number): { value: Buffer; next: number } | null {
    if (off + 4 > end) return null;
    const length = buf.readUInt32LE(off);
    if (off + 4 + length > end) return null;
    return { value: buf.subarray(off + 4, off + 4 + length), next: off + 4 + length };
  }

  function readLengthPrefixedUnicode(buf: Buffer, off: number, end: number): { value: string; next: number } | null {
    const data = readLengthPrefixedData(buf, off, end);
    if (!data) return null;
    let bytes = data.value;
    while (bytes.length >= 2 && bytes.readUInt16LE(bytes.length - 2) === 0) {
      bytes = bytes.subarray(0, bytes.length - 2);
    }
    return { value: bytes.toString('utf16le'), next: data.next };
  }

  function splitTargetAddress(address: string, defaultPort: number): { host: string; port: number } {
    const trimmed = address.trim();
    if (trimmed.startsWith('[')) {
      const end = trimmed.indexOf(']');
      if (end > 0) {
        const host = trimmed.slice(1, end);
        const rawPort = trimmed.slice(end + 1).replace(/^:/, '');
        const port = Number.parseInt(rawPort, 10);
        return { host, port: Number.isFinite(port) ? port : defaultPort };
      }
    }

    const firstColon = trimmed.indexOf(':');
    const lastColon = trimmed.lastIndexOf(':');
    if (firstColon > 0 && firstColon === lastColon) {
      const host = trimmed.slice(0, lastColon);
      const port = Number.parseInt(trimmed.slice(lastColon + 1), 10);
      return { host, port: Number.isFinite(port) ? port : defaultPort };
    }

    return { host: trimmed, port: defaultPort };
  }

  function buildRoutingTokenLine(routingToken: Buffer): Buffer {
    const prefix = Buffer.from('Cookie: msts=');
    const crlf = Buffer.from('\r\n');

    if (routingToken.subarray(0, prefix.length).equals(prefix) || routingToken.subarray(0, 4).equals(Buffer.from('tsv:'))) {
      return routingToken.subarray(routingToken.length - 2).equals(crlf)
        ? routingToken
        : Buffer.concat([routingToken, crlf]);
    }

    return Buffer.concat([prefix, routingToken, crlf]);
  }

  function buildX224ConnectionRequest(baseRequest: Buffer, routingToken: Buffer): Buffer {
    const nego = parseRdpNegBlock(baseRequest);
    const head = nego ? baseRequest.subarray(0, baseRequest.length - 8) : baseRequest;
    const tail = nego ? baseRequest.subarray(baseRequest.length - 8) : Buffer.alloc(0);
    const rebuilt = Buffer.concat([head, buildRoutingTokenLine(routingToken), tail]);
    const out = Buffer.from(rebuilt);
    out.writeUInt16BE(out.length, 2);
    out[4] = out.length - 5;
    return out;
  }

  function parseServerRedirectionPacket(data: Buffer, defaultPort: number): RedirectInfo | null {
    let off = 0;
    if (data.length >= 14 && data.readUInt16LE(0) === 0x0000) off = 2;
    if (data.length < off + 12) return null;

    const flags = data.readUInt16LE(off);
    if (flags !== SEC_REDIRECTION_PKT) return null;

    const packetLength = data.readUInt16LE(off + 2);
    const end = Math.min(data.length, off + packetLength);
    const redirectionFlags = data.readUInt32LE(off + 8);
    off += 12;

    let targetAddress = '';
    let targetFqdn = '';
    let targetNetbios = '';
    let username = '';
    let domain = '';
    let password = '';
    let routingToken: Buffer | undefined;

    if (redirectionFlags & LB_TARGET_NET_ADDRESS) {
      const parsed = readLengthPrefixedUnicode(data, off, end);
      if (!parsed) return null;
      targetAddress = parsed.value;
      off = parsed.next;
    }
    if (redirectionFlags & LB_LOAD_BALANCE_INFO) {
      const parsed = readLengthPrefixedData(data, off, end);
      if (!parsed) return null;
      routingToken = Buffer.from(parsed.value);
      off = parsed.next;
    }
    if (redirectionFlags & LB_USERNAME) {
      const parsed = readLengthPrefixedUnicode(data, off, end);
      if (!parsed) return null;
      username = parsed.value;
      off = parsed.next;
    }
    if (redirectionFlags & LB_DOMAIN) {
      const parsed = readLengthPrefixedUnicode(data, off, end);
      if (!parsed) return null;
      domain = parsed.value;
      off = parsed.next;
    }
    if (redirectionFlags & LB_PASSWORD) {
      const parsed = readLengthPrefixedData(data, off, end);
      if (!parsed) return null;
      if ((redirectionFlags & LB_PASSWORD_IS_PK_ENCRYPTED) === 0) {
        let bytes = parsed.value;
        while (bytes.length >= 2 && bytes.readUInt16LE(bytes.length - 2) === 0) {
          bytes = bytes.subarray(0, bytes.length - 2);
        }
        password = bytes.toString('utf16le');
      }
      off = parsed.next;
    }
    if (redirectionFlags & LB_TARGET_FQDN) {
      const parsed = readLengthPrefixedUnicode(data, off, end);
      if (!parsed) return null;
      targetFqdn = parsed.value;
      off = parsed.next;
    }
    if (redirectionFlags & LB_TARGET_NETBIOS_NAME) {
      const parsed = readLengthPrefixedUnicode(data, off, end);
      if (!parsed) return null;
      targetNetbios = parsed.value;
    }

    const target = targetFqdn || targetAddress || targetNetbios;
    const { host, port } = splitTargetAddress(target || '', defaultPort);
    if (!host) return null;

    return {
      host,
      port,
      routingToken,
      username: username || undefined,
      domain: domain || undefined,
      password: password || undefined,
    };
  }

  function inspectServerPreActivationFrame(frame: Buffer, defaultPort: number):
    | { kind: 'other' }
    | { kind: 'disconnect-provider-ultimatum'; reasonRaw: number | null; reasonDecoded: number | null }
    | { kind: 'demand-active' }
    | { kind: 'deactivate-all' }
    | { kind: 'redirect'; redirect: RedirectInfo } {
    if (isDisconnectProviderUltimatum(frame)) {
      const reason = decodeDisconnectProviderUltimatumReason(frame);
      return { kind: 'disconnect-provider-ultimatum', reasonRaw: reason.raw, reasonDecoded: reason.decoded };
    }

    const indication = decodeSendDataIndication(frame);
    if (!indication || indication.channelId !== IO_CHANNEL_ID) return { kind: 'other' };

    const basicRedirection = parseServerRedirectionPacket(indication.userData, defaultPort);
    if (basicRedirection) return { kind: 'redirect', redirect: basicRedirection };

    const shareControl = parseShareControlHeader(indication.userData);
    if (!shareControl) return { kind: 'other' };

    if (shareControl.pduType === PDU_TYPE_DEACTIVATE_ALL) return { kind: 'deactivate-all' };
    if (shareControl.pduType === PDU_TYPE_DEMAND_ACTIVE) return { kind: 'demand-active' };
    if (shareControl.pduType === PDU_TYPE_SERVER_REDIRECTION) {
      const redirect = parseServerRedirectionPacket(shareControl.body, defaultPort);
      if (redirect) return { kind: 'redirect', redirect };
    }

    return { kind: 'other' };
  }

  function rawDataToBytes(data: RawData): Uint8Array {
    if (typeof data === 'string') return Buffer.from(data);
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) {
      const chunks = data.map((chunk) => new Uint8Array(chunk));
      let total = 0;
      for (const chunk of chunks) total += chunk.byteLength;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    }
    return new Uint8Array(data);
  }

  function sendBinary(ws: WebSocket, data: Uint8Array): void {
    ws.send(data as RawData);
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
    let wsRelayHandler: ((msg: RawData) => void) | null = null;
    let activationComplete = false;
    let browserHandshakeSent = false;
    let activeGeneration = 0;
    let preActivationServerBuf = Buffer.alloc(0);
    let colorDepthPatched = false;
    let redirectCount = 0;
    let closed = false;
    let originalPassword = '';
    const bufferedClientFrames: Buffer[] = [];
    const traceStartedAt = Date.now();
    let traceSeq = 0;
    const traceEvents: Array<Record<string, unknown>> = [];

    const trace = (event: string, details?: Record<string, unknown>) => {
      if (!RDP_TRACE_ENABLED) return;
      traceSeq += 1;
      traceEvents.push({
        seq: traceSeq,
        tMs: Date.now() - traceStartedAt,
        event,
        ...(details ?? {}),
      });
      if (traceEvents.length > RDP_TRACE_MAX_EVENTS) traceEvents.shift();
    };

    const flushTrace = (reason: string, details?: Record<string, unknown>) => {
      if (!RDP_TRACE_ENABLED) return;
      console.error('[rdp-trace]', JSON.stringify({
        reason,
        sessionId,
        userId,
        connectionId,
        target: `${conn.host}:${conn.port}`,
        redirects: redirectCount,
        activationComplete,
        details: details ?? {},
        events: traceEvents,
      }));
    };

    trace('session.start', {
      clientIp,
      targetHost: conn.host,
      targetPort: conn.port,
      skipCertValidation: conn.skip_cert_validation === 1,
    });

    if (conn.encrypted_password) {
      try { originalPassword = decrypt(conn.encrypted_password); } catch { /**/ }
    }

    const cleanup = () => {
      if (wsRelayHandler) {
        ws.removeListener('message', wsRelayHandler);
        wsRelayHandler = null;
      }
      if (tlsTunnel) { try { tlsTunnel.destroy(); } catch { /**/ } tlsTunnel = null; }
      if (tunnel) { try { tunnel.destroy(); } catch { /**/ } tunnel = null; }
      trace('session.cleanup');
    };

    // First WebSocket message = RDCleanPath request DER
    ws.once('message', (data: RawData) => {
      const rdcp = Buffer.from(rawDataToBytes(data));
      let x224cr: Buffer;
      try { x224cr = extractX224CR(rdcp); }
      catch (e) {
        console.error('[rdp] parse error:', e);
        trace('client.initial-parse.error', { message: e instanceof Error ? e.message : String(e) });
        flushTrace('client.initial-parse.error');
        if (ws.readyState === WebSocket.OPEN) { sendBinary(ws, encodeRDCleanPathError()); ws.close(4004, 'Bad PDU'); }
        return;
      }
      trace('client.initial-parse.ok', { x224Length: x224cr.length });

      const formatUsername = (username: string, domain?: string) => {
        if (!domain || username.includes('\\') || username.includes('@')) return username;
        return `${domain}\\${username}`;
      };

      const connectBackend = (redirect?: RedirectInfo) => {
        if (redirect) redirectCount += 1;
        const generation = ++activeGeneration;
        preActivationServerBuf = Buffer.alloc(0);
        trace('backend.connect.start', {
          generation,
          redirected: !!redirect,
          redirectHost: redirect?.host,
          redirectPort: redirect?.port,
          hasRoutingToken: !!redirect?.routingToken,
          hasRedirectUsername: !!redirect?.username,
          hasRedirectPassword: !!redirect?.password,
        });

        if (tlsTunnel) { try { tlsTunnel.destroy(); } catch { /**/ } }
        if (tunnel) { try { tunnel.destroy(); } catch { /**/ } }
        tlsTunnel = null;
        tunnel = null;

        const targetHost = redirect?.host ?? conn.host;
        const targetPort = redirect?.port ?? conn.port;
        const x224Request = redirect?.routingToken ? buildX224ConnectionRequest(x224cr, redirect.routingToken) : x224cr;

        tunnel = net.connect(targetPort, targetHost, () => tunnel!.write(x224Request));
        trace('backend.tcp.connected', { generation, targetHost, targetPort, x224RequestLen: x224Request.length });

        readX224Pdu(tunnel)
          .then((x224cc) => {
            if (generation !== activeGeneration || ws.readyState !== WebSocket.OPEN) return;
            trace('backend.x224.response', { generation, x224ResponseLen: x224cc.length });

            tlsTunnel = tls.connect({
              socket: tunnel!,
              rejectUnauthorized: conn.skip_cert_validation !== 1,
              host: targetHost,
              ...(conn.skip_cert_validation === 1 ? { checkServerIdentity: () => undefined } : {}),
            });

            const currentTls = tlsTunnel;
            currentTls.once('secureConnect', async () => {
              if (generation !== activeGeneration || ws.readyState !== WebSocket.OPEN) return;
              trace('backend.tls.secure', { generation, targetHost, targetPort });

              const certs: Buffer[] = [];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let c: any = currentTls.getPeerCertificate(true);
              const seen = new Set<string>();
              while (c && c.raw) {
                const key = (c.raw as Buffer).toString('hex');
                if (seen.has(key)) break;
                seen.add(key);
                certs.push(Buffer.from(c.raw as Buffer));
                c = c.issuerCertificate;
              }

              if (!browserHandshakeSent) {
                ws.send(encodeRDCleanPathResponse(x224cc, targetHost, certs));
                browserHandshakeSent = true;
                trace('browser.handshake.sent', { generation, certCount: certs.length });
              }

              const selectedProtocol = getSelectedProtocol(x224cc);
              const redirectUser = redirect?.username ?? conn.username ?? '';
              const redirectPassword = redirect?.password ?? originalPassword;
              if (redirect && selectedProtocol === 0x02 && redirectUser && redirectPassword) {
                trace('backend.credssp.start', { generation, selectedProtocol, hasRedirectDomain: !!redirect?.domain });
                await performCredSSP(
                  currentTls,
                  formatUsername(redirectUser, redirect?.domain),
                  redirectPassword,
                  certs[0] ?? Buffer.alloc(0),
                );
                trace('backend.credssp.done', { generation });
              }

              currentTls.on('data', (chunk: Uint8Array) => {
                if (generation !== activeGeneration) return;

                if (activationComplete) {
                  if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
                  return;
                }

                preActivationServerBuf = Buffer.concat([preActivationServerBuf, chunk]);
                while (preActivationServerBuf.length >= 4) {
                  if (preActivationServerBuf[0] !== 0x03 || preActivationServerBuf[1] !== 0x00) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(preActivationServerBuf);
                    preActivationServerBuf = Buffer.alloc(0);
                    return;
                  }

                  const pduLen = preActivationServerBuf.readUInt16BE(2);
                  if (preActivationServerBuf.length < pduLen) return;

                  const frame = Buffer.from(preActivationServerBuf.subarray(0, pduLen));
                  preActivationServerBuf = preActivationServerBuf.subarray(pduLen);

                  const inspection = inspectServerPreActivationFrame(frame, targetPort);
                  trace('server.preactivation.frame', {
                    generation,
                    frameLen: frame.length,
                    pduLen,
                    kind: inspection.kind,
                  });
                  if (inspection.kind === 'redirect') {
                    trace('server.preactivation.redirect', {
                      generation,
                      redirectHost: inspection.redirect.host,
                      redirectPort: inspection.redirect.port,
                      hasRoutingToken: !!inspection.redirect.routingToken,
                      hasUsername: !!inspection.redirect.username,
                      hasPassword: !!inspection.redirect.password,
                    });
                    if (redirectCount >= 4) {
                      trace('server.preactivation.redirect.limit', { generation, redirectCount });
                      flushTrace('redirect.limit');
                      if (ws.readyState === WebSocket.OPEN) ws.close(4003, 'Too many redirects');
                      cleanup();
                      return;
                    }
                    connectBackend(inspection.redirect);
                    return;
                  }
                  if (inspection.kind === 'deactivate-all') continue;
                  if (inspection.kind === 'disconnect-provider-ultimatum') {
                    trace('server.preactivation.disconnect-provider-ultimatum', {
                      generation,
                      reasonRaw: inspection.reasonRaw,
                      reasonDecoded: inspection.reasonDecoded,
                      frameHexHead: frame.subarray(0, Math.min(24, frame.length)).toString('hex'),
                    });
                    continue;
                  }
                  if (inspection.kind === 'demand-active') {
                    activationComplete = true;
                    bufferedClientFrames.length = 0;
                    trace('server.activation.complete', { generation });
                  }

                  if (ws.readyState === WebSocket.OPEN) ws.send(frame);
                  if (activationComplete && preActivationServerBuf.length > 0) {
                    ws.send(preActivationServerBuf);
                    preActivationServerBuf = Buffer.alloc(0);
                    return;
                  }
                }
              });

              currentTls.once('close', () => {
                if (generation !== activeGeneration || closed) return;
                trace('backend.tls.close', { generation });
                flushTrace('backend.tls.close');
                if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'TCP closed');
              });

              if (redirect && bufferedClientFrames.length > 0) {
                trace('client.buffered.replay', { generation, bufferedCount: bufferedClientFrames.length });
                for (const frame of bufferedClientFrames) {
                  if (!currentTls.destroyed && currentTls.writable) currentTls.write(frame);
                }
              }
            });

            currentTls.once('error', (e: Error) => {
              if (generation !== activeGeneration) return;
              console.error('[rdp] TLS error:', e.message);
              trace('backend.tls.error', { generation, message: e.message });
              flushTrace('backend.tls.error', { message: e.message });
              if (ws.readyState === WebSocket.OPEN) {
                sendBinary(ws, encodeRDCleanPathError());
                ws.close(4003, 'TLS error');
              }
              cleanup();
            });
          })
          .catch((e) => {
            if (generation !== activeGeneration) return;
            console.error('[rdp] X.224 error:', e);
            trace('backend.x224.error', { generation, message: e instanceof Error ? e.message : String(e) });
            flushTrace('backend.x224.error', { message: e instanceof Error ? e.message : String(e) });
            if (ws.readyState === WebSocket.OPEN) {
              sendBinary(ws, encodeRDCleanPathError());
              ws.close(4003, 'X.224 error');
            }
            cleanup();
          });

        tunnel.on('error', (err: Error) => {
          if (generation !== activeGeneration) return;
          console.error('[rdp] TCP error:', err.message);
          trace('backend.tcp.error', { generation, message: err.message });
          flushTrace('backend.tcp.error', { message: err.message });
          if (ws.readyState === WebSocket.OPEN) ws.close(4003, 'TCP error');
          cleanup();
        });
      };

      wsRelayHandler = (msg: RawData) => {
        const rawBytes = rawDataToBytes(msg);
        let relayBytes: Uint8Array = rawBytes;
        if (!colorDepthPatched) {
          const patched = patchHighColorDepth(rawBytes);
          if (patched.patched) colorDepthPatched = true;
          relayBytes = patched.buffer;
        }

        if (!activationComplete) bufferedClientFrames.push(Buffer.from(relayBytes));
        if (!activationComplete) {
          trace('client.frame.buffered', {
            bufferedCount: bufferedClientFrames.length,
            frameLen: relayBytes.byteLength,
            colorDepthPatched,
          });
        }
        if (tlsTunnel && !tlsTunnel.destroyed && tlsTunnel.writable) tlsTunnel.write(relayBytes);
      };
      ws.on('message', wsRelayHandler);
      connectBackend();
    });

    ws.on('close', () => {
      closed = true;
      trace('browser.ws.close');
      flushTrace('browser.ws.close');
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
    ws.on('error', (err) => {
      trace('browser.ws.error', { message: err.message });
      flushTrace('browser.ws.error', { message: err.message });
      cleanup();
    });
  });
}
