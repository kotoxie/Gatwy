/**
 * Patches @marsaud/smb2 to fix known incompatibilities with modern Windows:
 *
 * 1. NTLMv2 authentication — the library ships with the `ntlm` package (v0.1.3,
 *    2012) which only implements NTLMv1. Modern Windows rejects NTLMv1 by default
 *    ("Send NTLMv2 response only" policy), returning STATUS_INVALID_PARAMETER
 *    during session setup.
 *
 * 2. SMB2 async interim responses — Windows Server 2022 always responds to READ
 *    requests with a STATUS_PENDING (0x103) interim frame before the final
 *    STATUS_SUCCESS frame. The library has no async handling: it dispatches the
 *    callback immediately on the interim frame (treating it as an error) and
 *    discards the real response. We patch smb2-forge.js to silently skip
 *    STATUS_PENDING frames so the callback fires on the real response instead.
 *
 * 3. SMB2 session signing — Windows 11 requires signing (SecurityMode 0x02) on
 *    every outbound SMB2 packet after session setup.  Without it Windows 11
 *    returns STATUS_ACCESS_DENIED even when NTLMv2 auth succeeded.
 *    We unconditionally sign all post-auth packets: MS-SMB2 §3.2.4.1 states
 *    servers MUST accept signed packets even when signing is only "enabled"
 *    (not required), so this is safe for all server versions.
 *
 *    Root cause of the previous failed attempt: smb2-message.js stores every
 *    parsed response field as a raw Buffer slice (readData = buffer.slice()).
 *    Checking `SecurityMode & 0x02` on a Buffer always returns 0, so signing
 *    was never activated.  The fix: remove the conditional entirely and always
 *    activate signing once we have an ExportedSessionKey.
 *
 * All patches replace entries in the CJS module cache — no library changes needed.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { encodeNegotiate, decodeChallenge, encodeAuthenticateEx, type NtlmChallenge } from './ntlmv2.js';

const _require = createRequire(import.meta.url);

let patched = false;

// ── Patch 3 helper: wrap socket.write to sign all post-session SMB2 packets ──
//
// SMB 2.x signing (MS-SMB2 §3.1.4.1):
//   SigningKey = Session.ExportedSessionKey (the NTLM session key, 16 bytes)
//   Signature  = HMAC-SHA256(SigningKey, message_with_sig_zeroed)[0:16]
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function activateSmb2Signing(connection: Record<string, any>): void {
  const signingKey: Buffer = connection.smbSigningKey;
  if (!signingKey) return;

  const SMB2_PROTO = Buffer.from([0xfe, 0x53, 0x4d, 0x42]); // \xFESMB
  const SMB2_HDR_LEN = 64;
  const FLAG_SIGNED  = 0x00000008;
  const CMD_NEGOTIATE     = 0x0000;
  const CMD_SESSION_SETUP = 0x0001;

  const OUT_NAMES: Record<number, string> = {
    0x0003: 'TREE_CONNECT', 0x0005: 'CREATE', 0x0006: 'CLOSE',
    0x0008: 'READ', 0x0009: 'WRITE', 0x000e: 'QUERY_DIRECTORY',
    0x0010: 'QUERY_INFO', 0x0011: 'SET_INFO',
  };


  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sock = connection.socket as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origWrite: (...args: any[]) => boolean = sock.write.bind(sock);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock.write = function (data: any, ...rest: any[]): boolean {
    // Only touch Buffers with at least a NetBIOS header (4) + SMB2 header (64)
    if (Buffer.isBuffer(data) && data.length >= 68) {
      const smb = data.slice(4); // skip 4-byte NetBIOS length prefix
      if (
        smb.length >= SMB2_HDR_LEN &&
        smb[0] === SMB2_PROTO[0] && smb[1] === SMB2_PROTO[1] &&
        smb[2] === SMB2_PROTO[2] && smb[3] === SMB2_PROTO[3]
      ) {
        const cmd = smb.readUInt16LE(12);
        if (cmd !== CMD_NEGOTIATE && cmd !== CMD_SESSION_SETUP) {
          // Work on a copy so we don't mutate shared buffers
          const signed = Buffer.from(data);
          const msg    = signed.slice(4);
          // Set SIGNED flag in Flags field (SMB2 header offset 16)
          msg.writeUInt32LE(msg.readUInt32LE(16) | FLAG_SIGNED, 16);
          // Zero Signature field (SMB2 header offset 48–63)
          msg.fill(0, 48, 64);
          // Compute HMAC-SHA256(signingKey, full-smb2-message)[0:16]
          const sig = crypto.createHmac('sha256', signingKey).update(msg).digest();
          sig.copy(msg, 48, 0, 16);
          const cmdName = OUT_NAMES[cmd] ?? `CMD_0x${cmd.toString(16).padStart(4,'0')}`;
          const sessId = msg.slice(40, 48).toString('hex');
          return origWrite(signed, ...rest);
        }
      }
    }
    return origWrite(data, ...rest);
  };
}

export function patchSmbNtlm(): void {
  if (patched) return;
  patched = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SMB = _require('@marsaud/smb2/lib/smb2') as { prototype: Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoPromise = _require('@marsaud/smb2/lib/tools/auto-promise') as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SMB2Connection = _require('@marsaud/smb2/lib/tools/smb2-connection') as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stats = _require('@marsaud/smb2/lib/tools/stats.js') as (v: Record<string, unknown>) => Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SMB2Message = _require('@marsaud/smb2/lib/tools/smb2-message') as new (opts: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SMB2Forge = _require('@marsaud/smb2/lib/tools/smb2-forge') as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step1 = _require('@marsaud/smb2/lib/messages/session_setup_step1') as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step2 = _require('@marsaud/smb2/lib/messages/session_setup_step2') as Record<string, any>;

  // ── Patch 1: skip STATUS_PENDING async interim responses ─────────────────
  // Windows Server 2022 always replies to READ with an interim STATUS_PENDING
  // frame before the real STATUS_SUCCESS frame. Both frames share the same
  // MessageId, so leaving the callback registered lets it fire on the real one.
  const STATUS_PENDING = 0x00000103;

  // Command-code → name map for trace output.
  // NOTE: smb2-message.js unTranslate() converts h.Command from a number to
  // a string like "SESSION_SETUP" for known commands. h.Command is therefore
  // a string in parsed responses, NOT a number. We handle both.
  const CMD_NAMES: Record<number, string> = {
    0x0000: 'NEGOTIATE', 0x0001: 'SESSION_SETUP', 0x0002: 'LOGOFF',
    0x0003: 'TREE_CONNECT', 0x0004: 'TREE_DISCONNECT', 0x0005: 'CREATE',
    0x0006: 'CLOSE', 0x0008: 'READ', 0x0009: 'WRITE',
    0x000e: 'QUERY_DIRECTORY', 0x0010: 'QUERY_INFO', 0x0011: 'SET_INFO',
  };
  const resolveCmd = (cmd: unknown): string => {
    if (typeof cmd === 'string') return cmd; // already resolved by smb2-message.js
    if (typeof cmd === 'number') return CMD_NAMES[cmd] ?? `CMD_0x${cmd.toString(16).padStart(4,'0')}`;
    if (Buffer.isBuffer(cmd)) {
      const v = cmd.readUInt16LE(0);
      return CMD_NAMES[v] ?? `CMD_0x${v.toString(16).padStart(4,'0')}`;
    }
    return String(cmd);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SMB2Forge.response = function (c: any) {
    c.responses = {};
    c.responsesCB = {};
    c.responseBuffer = Buffer.allocUnsafe(0);
    return function (data: Buffer) {
      c.responseBuffer = Buffer.concat([c.responseBuffer, data]);
      let extract = true;
      while (extract) {
        extract = false;
        if (c.responseBuffer.length >= 4) {
          const msgLength = (c.responseBuffer.readUInt8(1) << 16) + c.responseBuffer.readUInt16BE(2);
          if (c.responseBuffer.length >= msgLength + 4) {
            extract = true;
            const r = c.responseBuffer.slice(4, msgLength + 4);
            c.responseBuffer = c.responseBuffer.slice(msgLength + 4);
            const message = new SMB2Message(undefined);
            message.parseBuffer(r);
            const h = message.getHeaders();
            // h.Status is a raw Buffer slice — must read as LE uint32 for numeric comparison
            const statusVal = (h.Status as Buffer).readUInt32LE(0);
            // h.Command is a string for known commands (smb2-message.js unTranslate)
            const cmdName = resolveCmd(h.Command);
            if (statusVal === STATUS_PENDING) {
              continue;
            }
            if (statusVal !== 0) {
            } else {
            }
            const mId: string = h.MessageId.toString('hex');
            if (c.responsesCB[mId]) {
              c.responsesCB[mId](message);
              delete c.responsesCB[mId];
            } else {
              c.responses[mId] = message;
            }
          }
        }
      }
    };
  };

  // ── Patch 2: send NTLMv2 Negotiate (Type 1) ─────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step1.generate = function (connection: Record<string, any>) {
    const negotiateMsg = encodeNegotiate(connection.ip ?? '', connection.domain ?? '');
    connection.ntlmNegotiateMsg = negotiateMsg;
    return new SMB2Message({
      headers: { Command: 'SESSION_SETUP', ProcessId: connection.ProcessId },
      request: { Buffer: negotiateMsg },
    });
  };

  // ── Patch 2 cont: capture full Type 2 challenge (incl. TargetInfo for blob) ─
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step1.onSuccess = function (connection: Record<string, any>, response: any) {
    const h = response.getHeaders();
    connection.SessionId = h.SessionId;
    const rawBuf = response.getResponse().Buffer as Buffer;
    connection.ntlmChallengeMsg = rawBuf;
    try {
      const ch = decodeChallenge(rawBuf);
      connection.nonce           = ch.serverChallenge;
      connection.ntlmv2Challenge = ch;
      const avFlags = ch.targetInfo?.length ? (() => {
        let off = 0; while (off + 4 <= ch.targetInfo.length) {
          const id = ch.targetInfo.readUInt16LE(off), len = ch.targetInfo.readUInt16LE(off + 2); off += 4;
          if (id === 0) break; if (id === 6 && len >= 4) return ch.targetInfo.readUInt32LE(off);
          off += len;
        } return 0;
      })() : 0;
    } catch (e) {
      if (rawBuf?.length >= 32) connection.nonce = rawBuf.slice(24, 32);
    }
  };

  // ── Patch 2 cont: send NTLMv2 Authenticate (Type 3) + store signing key ───
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step2.generate = function (connection: Record<string, any>) {
    const ch: NtlmChallenge = connection.ntlmv2Challenge ?? {
      serverChallenge: connection.nonce ?? Buffer.alloc(8),
      targetInfo:      Buffer.alloc(0),
      flags:           0,
    };
    const { msg, exportedSessionKey } = encodeAuthenticateEx(
      connection.username   ?? '',
      connection.domain     ?? '',
      connection.ip         ?? '',
      connection.password   ?? '',
      ch,
      connection.ntlmNegotiateMsg as Buffer | undefined,
      connection.ntlmChallengeMsg as Buffer | undefined,
    );
    connection.smbSigningKey = exportedSessionKey;
    return new SMB2Message({
      headers: {
        Command:   'SESSION_SETUP',
        SessionId: connection.SessionId,
        ProcessId: connection.ProcessId,
      },
      request: { Buffer: msg },
    });
  };

  // ── Patch 3 cont: activate socket-level signing after successful auth ─────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step2.onSuccess = function (connection: Record<string, any>) {
    activateSmb2Signing(connection);
  };

  // ── Patch 4a: fix open_folder DesiredAccess ───────────────────────────────
  // @marsaud/smb2 open_folder.js requests DELETE | FILE_WRITE_DATA | WRITE_DAC
  // and other broad permissions. Windows 11 enforces NTFS/share ACLs strictly:
  // if the user has read-only access (common default on Windows 11 personal),
  // requesting write/delete flags returns STATUS_ACCESS_DENIED even though read
  // listing would succeed. Windows 11→Windows 11 works because the native client
  // negotiates SMB 3.1.1 and handles access differently.
  // Fix: request only the minimum access required for directory enumeration.
  const openFolderMod = _require('@marsaud/smb2/lib/messages/open_folder') as Record<string, any>;
  // FILE_LIST_DIRECTORY(0x01)|FILE_READ_EA(0x08)|FILE_READ_ATTRIBUTES(0x80)
  // |READ_CONTROL(0x20000)|SYNCHRONIZE(0x100000) = 0x00120089
  const DIR_LIST_ACCESS = 0x00000001 | 0x00000008 | 0x00000080 | 0x00020000 | 0x00100000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origOpenFolderGen = openFolderMod.generate as (c: any, p: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openFolderMod.generate = function (connection: any, params: any): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = origOpenFolderGen.call(openFolderMod, connection, params) as any;
    msg.request.DesiredAccess = DIR_LIST_ACCESS;
    return msg;
  };

  // ── Patch 4b: fix readdir to open directories as directories ──────────────
  // Upstream readdir uses SMB2Request('open', ...) which builds a file-style
  // CREATE (CreateOptions lacks FILE_DIRECTORY_FILE). Windows 11 is stricter
  // about directory handle semantics. Use open_folder (with patched access above).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SMB2Request = SMB2Forge.request as (name: string, params: any, connection: any, cb: (err?: any, res?: any) => void) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patchedReaddir = function (this: any, p: string, options: any, cb: (err?: Error | null, res?: unknown[]) => void) {
    const connection = this;

    if (typeof options === 'function') {
      cb = options as (err?: Error | null, res?: unknown[]) => void;
      options = {};
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapping = options?.stats
      ? (v: any) => {
          const obj = stats(v) as Record<string, unknown> & { name?: string };
          obj.name = v.Filename;
          return obj;
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (v: any) => v.Filename;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function queryDirectory(filesBatch: unknown[][], file: any, done: (err?: Error | null, out?: unknown[][]) => void) {
      SMB2Request('query_directory', file, connection, (err?: Error & { code?: string }, files?: unknown[]) => {
        if (err) {
          if (err.code === 'STATUS_NO_MORE_FILES') {
            done(null, filesBatch);
          } else {
            done(err);
          }
          return;
        }
        const mapped = (files ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((v: any) => v.Filename !== '.' && v.Filename !== '..')
          .map(mapping);
        filesBatch.push(mapped);
        queryDirectory(filesBatch, file, done);
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function openDirectory(done: (err?: Error | null, file?: any) => void) {
      SMB2Request('open_folder', { path: p }, connection, (err?: Error & { code?: string }, file?: unknown) => {
        if (!err) {
          done(null, file);
          return;
        }
        SMB2Request('open', { path: p }, connection, (err2?: Error & { code?: string }, file2?: unknown) => {
          if (err2) {
          } else {
          }
          done(err2 ?? null, file2);
        });
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function closeDirectory(file: any, done: (err?: Error | null) => void) {
      SMB2Request('close', file, connection, (err?: Error & { code?: string }) => {
        if (err && err.code !== 'STATUS_FILE_CLOSED') {
          done(err);
          return;
        }
        done(null);
      });
    }

    openDirectory((err?: Error | null, file?: unknown) => {
      if (err || !file) {
        console.error('[smb] openDirectory error:', err?.message);
        cb(err ?? new Error('Failed to open directory'));
        return;
      }
      const filesBatch: unknown[][] = [];
      queryDirectory(filesBatch, file, (qErr?: Error | null, out?: unknown[][]) => {
        if (qErr) {
          console.error('[smb] queryDirectory error:', qErr?.message);
          cb(qErr);
          return;
        }
        closeDirectory(file, (cErr?: Error | null) => {
          if (cErr) {
            cb(cErr);
            return;
          }
          cb(null, ([] as unknown[]).concat(...(out ?? [])));
        });
      });
    });
  };

  SMB.prototype.readdir = autoPromise(SMB2Connection.requireConnect(patchedReaddir));
}
