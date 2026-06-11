import crypto from 'node:crypto';
import type tls from 'node:tls';
import { encodeNegotiate, decodeChallenge, encodeAuthenticateEx } from './ntlmv2.js';

interface RC4State {
  S: Uint8Array;
  i: number;
  j: number;
}

function rc4Init(key: Buffer): RC4State {
  const S = new Uint8Array(256);
  for (let idx = 0; idx < 256; idx++) S[idx] = idx;

  let j = 0;
  for (let idx = 0; idx < 256; idx++) {
    j = (j + S[idx] + key[idx % key.length]) & 0xff;
    const tmp = S[idx];
    S[idx] = S[j];
    S[j] = tmp;
  }

  return { S, i: 0, j: 0 };
}

function rc4Update(state: RC4State, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  let { i, j } = state;

  for (let idx = 0; idx < data.length; idx++) {
    i = (i + 1) & 0xff;
    j = (j + state.S[i]) & 0xff;
    const tmp = state.S[i];
    state.S[i] = state.S[j];
    state.S[j] = tmp;
    out[idx] = data[idx] ^ state.S[(state.S[i] + state.S[j]) & 0xff];
  }

  state.i = i;
  state.j = j;
  return out;
}

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
  if (hex.length % 2) hex = `0${hex}`;
  let out = Buffer.from(hex, 'hex');
  if (out[0] & 0x80) out = Buffer.concat([Buffer.from([0x00]), out]);
  return derTlv(0x02, out);
}

function derOctet(content: Buffer): Buffer {
  return derTlv(0x04, content);
}

function derSeq(content: Buffer): Buffer {
  return derTlv(0x30, content);
}

function derCtx(index: number, content: Buffer): Buffer {
  return derTlv(0xa0 | index, content);
}

function tryReadDerLen(buf: Buffer, off: number): { value: number; bytesRead: number } | null {
  if (off >= buf.length) return null;
  const first = buf[off];
  if (first < 0x80) return { value: first, bytesRead: 1 };

  const nb = first & 0x7f;
  if (off + 1 + nb > buf.length) return null;

  let value = 0;
  for (let idx = 0; idx < nb; idx++) value = (value << 8) | buf[off + 1 + idx];
  return { value, bytesRead: 1 + nb };
}

function derChildren(content: Buffer): Array<{ tag: number; value: Buffer }> {
  const out: Array<{ tag: number; value: Buffer }> = [];
  let off = 0;

  while (off < content.length) {
    const tag = content[off++];
    const len = tryReadDerLen(content, off);
    if (!len) break;
    off += len.bytesRead;
    out.push({ tag, value: content.slice(off, off + len.value) });
    off += len.value;
  }

  return out;
}

const SPNEGO_OID = Buffer.from([0x06, 0x06, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x02]);
const NTLM_OID = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x02, 0x0a]);

function spnegoNegTokenInit(ntlmNegotiate: Buffer): Buffer {
  const mechTypes = derSeq(NTLM_OID);
  const mechToken = derOctet(ntlmNegotiate);
  const negTokenInit = derSeq(Buffer.concat([
    derCtx(0, mechTypes),
    derCtx(2, mechToken),
  ]));
  return derTlv(0x60, Buffer.concat([SPNEGO_OID, derCtx(0, negTokenInit)]));
}

function spnegoNegTokenResp(ntlmAuthenticate: Buffer): Buffer {
  return derCtx(1, derSeq(derCtx(2, derOctet(ntlmAuthenticate))));
}

function encodeTsRequest(opts: {
  version?: number;
  negoTokens?: Buffer;
  authInfo?: Buffer;
  pubKeyAuth?: Buffer;
  clientNonce?: Buffer;
}): Buffer {
  const version = opts.version ?? 2;
  const parts: Buffer[] = [derCtx(0, derInt(version))];

  if (opts.negoTokens) {
    const item = derSeq(derCtx(0, derOctet(opts.negoTokens)));
    parts.push(derCtx(1, derSeq(item)));
  }
  if (opts.authInfo) parts.push(derCtx(2, derOctet(opts.authInfo)));
  if (opts.pubKeyAuth) parts.push(derCtx(3, derOctet(opts.pubKeyAuth)));
  if (opts.clientNonce) parts.push(derCtx(5, derOctet(opts.clientNonce)));

  return derSeq(Buffer.concat(parts));
}

function extractNegoTokenFromTsRequest(tsReq: Buffer): Buffer {
  if (tsReq[0] !== 0x30) throw new Error('CredSSP: expected TSRequest SEQUENCE');
  const len = tryReadDerLen(tsReq, 1);
  if (!len) throw new Error('CredSSP: incomplete TSRequest');
  const children = derChildren(tsReq.slice(1 + len.bytesRead, 1 + len.bytesRead + len.value));
  const negoField = children.find((child) => child.tag === 0xa1);
  if (!negoField) throw new Error('CredSSP: no negoTokens in TSRequest');

  const negoChildren = derChildren(negoField.value);
  if (!negoChildren.length || negoChildren[0].tag !== 0x30) {
    throw new Error('CredSSP: expected NegoData SEQUENCE');
  }

  const itemChildren = derChildren(negoChildren[0].value);
  const tokenField = itemChildren.find((child) => child.tag === 0xa0 || child.tag === 0xa1);
  if (tokenField) {
    const octetChildren = derChildren(tokenField.value);
    if (octetChildren.length && octetChildren[0].tag === 0x04) return octetChildren[0].value;
  }

  const sig = Buffer.from([0x4e, 0x54, 0x4c, 0x4d, 0x53, 0x53, 0x50, 0x00]);
  const rawIndex = negoChildren[0].value.indexOf(sig);
  if (rawIndex >= 0) return negoChildren[0].value.slice(rawIndex);
  throw new Error('CredSSP: could not extract nego token');
}

function extractNtlmFromSpnegoResp(spnego: Buffer): Buffer {
  const sig = Buffer.from([0x4e, 0x54, 0x4c, 0x4d, 0x53, 0x53, 0x50, 0x00]);
  const rawIndex = spnego.indexOf(sig);
  if (rawIndex >= 0 && rawIndex < 50) return spnego.slice(rawIndex);

  if (spnego[0] !== 0xa1) throw new Error('CredSSP: expected NegTokenResp');
  const len = tryReadDerLen(spnego, 1);
  if (!len) throw new Error('CredSSP: incomplete NegTokenResp');
  const seq = spnego.slice(1 + len.bytesRead);
  if (seq[0] !== 0x30) throw new Error('CredSSP: expected SEQUENCE inside NegTokenResp');
  const seqLen = tryReadDerLen(seq, 1);
  if (!seqLen) throw new Error('CredSSP: incomplete NegTokenResp SEQUENCE');
  const children = derChildren(seq.slice(1 + seqLen.bytesRead, 1 + seqLen.bytesRead + seqLen.value));
  const tokenField = children.find((child) => child.tag === 0xa2 || child.tag === 0xa0);
  if (!tokenField) throw new Error('CredSSP: no responseToken in NegTokenResp');
  const octetChildren = derChildren(tokenField.value);
  if (!octetChildren.length || octetChildren[0].tag !== 0x04) {
    throw new Error('CredSSP: invalid responseToken in NegTokenResp');
  }
  return octetChildren[0].value;
}

function md5(data: Buffer): Buffer {
  return crypto.createHash('md5').update(data).digest();
}

function hmacMd5(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('md5', key).update(data).digest();
}

function deriveKeys(exportedSessionKey: Buffer): { signKey: Buffer; sealKey: Buffer } {
  const signMagic = Buffer.from('session key to client-to-server signing key magic constant\0');
  const sealMagic = Buffer.from('session key to client-to-server sealing key magic constant\0');
  return {
    signKey: md5(Buffer.concat([exportedSessionKey, signMagic])),
    sealKey: md5(Buffer.concat([exportedSessionKey, sealMagic])),
  };
}

function ntlmSeal(rc4: RC4State, signKey: Buffer, seqNum: number, plaintext: Buffer): Buffer {
  const seqBuf = Buffer.allocUnsafe(4);
  seqBuf.writeUInt32LE(seqNum);

  const encMessage = rc4Update(rc4, plaintext);
  const macMessage = hmacMd5(signKey, Buffer.concat([seqBuf, plaintext]));
  const encChecksum = rc4Update(rc4, macMessage.subarray(0, 8));

  return Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    encChecksum,
    seqBuf,
    encMessage,
  ]);
}

function encodeTsCredentials(domain: string, username: string, password: string): Buffer {
  const passwordCreds = derSeq(Buffer.concat([
    derCtx(0, derOctet(Buffer.from(domain, 'utf16le'))),
    derCtx(1, derOctet(Buffer.from(username, 'utf16le'))),
    derCtx(2, derOctet(Buffer.from(password, 'utf16le'))),
  ]));

  return derSeq(Buffer.concat([
    derCtx(0, derInt(1)),
    derCtx(1, derOctet(passwordCreds)),
  ]));
}

function readDerMessage(sock: tls.TLSSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);

    const cleanup = () => {
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('close', onClose);
      sock.pause();
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      if (buf[0] !== 0x30) {
        cleanup();
        reject(new Error(`CredSSP: expected DER sequence, got 0x${buf[0].toString(16)}`));
        return;
      }

      const len = tryReadDerLen(buf, 1);
      if (!len) return;
      const total = 1 + len.bytesRead + len.value;
      if (buf.length < total) return;

      cleanup();
      const pdu = buf.slice(0, total);
      const leftover = buf.slice(total);
      if (leftover.length > 0) sock.unshift(leftover);
      resolve(pdu);
    };

    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('CredSSP: socket closed mid-handshake'));
    };

    sock.resume();
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.once('close', onClose);
  });
}

function splitDomain(raw: string): { domain: string; user: string } {
  const backslash = raw.indexOf('\\');
  if (backslash >= 0) return { domain: raw.slice(0, backslash), user: raw.slice(backslash + 1) };

  const at = raw.indexOf('@');
  if (at >= 0) return { domain: raw.slice(at + 1), user: raw.slice(0, at) };
  return { domain: '', user: raw };
}

export async function performCredSSP(
  tlsSocket: tls.TLSSocket,
  rawUsername: string,
  password: string,
  serverCertRaw: Buffer,
): Promise<void> {
  const { domain, user } = splitDomain(rawUsername);
  const cert = new crypto.X509Certificate(serverCertRaw);
  const subjectPublicKeyInfo = Buffer.from(cert.publicKey.export({ format: 'der', type: 'spki' }));
  const clientNonce = crypto.randomBytes(32);
  const version = 6;

  const round1 = encodeTsRequest({
    version,
    negoTokens: spnegoNegTokenInit(encodeNegotiate('GATWY', domain)),
    clientNonce,
  });
  tlsSocket.write(round1);

  const round2 = await readDerMessage(tlsSocket);
  const spnego2 = extractNegoTokenFromTsRequest(round2);
  const challenge = decodeChallenge(extractNtlmFromSpnegoResp(spnego2));

  const { msg: ntlmAuth, exportedSessionKey } = encodeAuthenticateEx(user, domain, 'GATWY', password, challenge);
  const { signKey, sealKey } = deriveKeys(exportedSessionKey);
  const rc4 = rc4Init(sealKey);

  const bindingStr = Buffer.from('CredSSP Client-To-Server Binding Hash\0');
  const bindingHash = crypto.createHash('sha256')
    .update(bindingStr)
    .update(crypto.createHash('sha256').update(subjectPublicKeyInfo).digest())
    .update(clientNonce)
    .digest();

  const round3 = encodeTsRequest({
    version,
    negoTokens: spnegoNegTokenResp(ntlmAuth),
    pubKeyAuth: ntlmSeal(rc4, signKey, 0, bindingHash),
    clientNonce,
  });
  tlsSocket.write(round3);

  await readDerMessage(tlsSocket);

  const round5 = encodeTsRequest({
    version,
    authInfo: ntlmSeal(rc4, signKey, 1, encodeTsCredentials(domain, user, password)),
    clientNonce,
  });
  tlsSocket.write(round5);
}