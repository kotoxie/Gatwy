import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const STREAM_ALGORITHM = 'aes-256-ctr';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

// Recording magic: "GATWY_REC\0" (11) + version (1) + IV (16) = 28 bytes header
const REC_MAGIC = Buffer.from('GATWY_REC\0');
const REC_VERSION = 0x01;
export const REC_HEADER_SIZE = REC_MAGIC.length + 1 + IV_LENGTH; // 28

let encryptionKey: Buffer;
export let usingFileKey = false;

export function initEncryption(): void {
  const envKey = process.env.GATWY_ENCRYPTION_KEY;

  if (envKey) {
    try {
      let keyBuf: Buffer;
      if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
        keyBuf = Buffer.from(envKey, 'hex');
      } else {
        keyBuf = Buffer.from(envKey, 'base64');
      }
      if (keyBuf.length !== 32) {
        throw new Error(`must be 32 bytes (64 hex chars or 44 base64 chars), got ${keyBuf.length}`);
      }
      encryptionKey = keyBuf;
      usingFileKey = false;
      console.log('[Gatwy] Encryption key loaded from GATWY_ENCRYPTION_KEY.');
      return;
    } catch (e) {
      console.error(`\x1b[41m\x1b[97m[Gatwy] FATAL: Invalid GATWY_ENCRYPTION_KEY: ${(e as Error).message}\x1b[0m`);
      process.exit(1);
    }
  }

  usingFileKey = true;
  const keyPath = path.join(config.dataDir, 'encryption.key');
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(keyPath)) {
    encryptionKey = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'hex');
  } else {
    encryptionKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, encryptionKey.toString('hex'), { mode: 0o600 });
  }

  const R = '\x1b[41m\x1b[97m\x1b[1m';
  const X = '\x1b[0m';
  console.error('');
  console.error(`${R}╔══════════════════════════════════════════════════════════════════╗${X}`);
  console.error(`${R}║       !!  SECURITY WARNING — INSECURE KEY STORAGE  !!            ║${X}`);
  console.error(`${R}║                                                                  ║${X}`);
  console.error(`${R}║  GATWY_ENCRYPTION_KEY env variable is NOT set.                  ║${X}`);
  console.error(`${R}║  Using auto-generated key stored in /app/data/encryption.key     ║${X}`);
  console.error(`${R}║                                                                  ║${X}`);
  console.error(`${R}║  The key is co-located with encrypted data — anyone with the     ║${X}`);
  console.error(`${R}║  /data volume gets both the key and ciphertext.                  ║${X}`);
  console.error(`${R}║                                                                  ║${X}`);
  console.error(`${R}║  Fix: set in docker-compose.yml environment:                     ║${X}`);
  console.error(`${R}║    GATWY_ENCRYPTION_KEY: $(openssl rand -hex 32)                ║${X}`);
  console.error(`${R}╚══════════════════════════════════════════════════════════════════╝${X}`);
  console.error('');
}

// ── Credential encryption (AES-256-GCM, for DB strings) ──────────────────────

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// ── Recording encryption (AES-256-CTR, streamable) ───────────────────────────

/** Returns a Transform stream that prepends the encrypted file header then streams encrypted bytes. */
export function encryptRecordingStream(): Transform {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(STREAM_ALGORITHM, encryptionKey, iv);
  let headerWritten = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!headerWritten) {
        headerWritten = true;
        this.push(Buffer.concat([REC_MAGIC, Buffer.from([REC_VERSION]), iv]));
      }
      this.push(cipher.update(chunk));
      cb();
    },
    flush(cb) {
      const fin = cipher.final();
      if (fin.length > 0) this.push(fin);
      cb();
    },
  });
}

/** Returns true if the buffer starts with the Gatwy recording magic header. */
export function isEncryptedRecording(buf: Buffer): boolean {
  if (buf.length < REC_HEADER_SIZE) return false;
  return buf.subarray(0, REC_MAGIC.length).equals(REC_MAGIC);
}

/** Decrypt a full recording buffer. Handles both encrypted and legacy plaintext files. */
export function decryptRecording(buf: Buffer): Buffer {
  if (!isEncryptedRecording(buf)) return buf;
  const iv = buf.subarray(REC_MAGIC.length + 1, REC_HEADER_SIZE);
  const body = buf.subarray(REC_HEADER_SIZE);
  const decipher = crypto.createDecipheriv(STREAM_ALGORITHM, encryptionKey, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// ── Incremental RDP recording writer ─────────────────────────────────────────
// RDP recordings arrive as browser MediaRecorder chunks. We encrypt each chunk
// as it arrives so the file is never plaintext on disk.

export interface RdpRecordingWriter {
  writeChunk(data: Buffer): void;
  close(): void;
}

/**
 * Opens a new encrypted recording file and returns a writer that encrypts
 * each chunk with AES-256-CTR (continuous keystream across all chunks).
 * Writes the magic header + IV synchronously on creation.
 * Throws if the file already exists: a recording is never reopened, since that would truncate it.
 */
export function openRdpRecordingFile(requestedPath: string): RdpRecordingWriter {
  const recordingsRoot = path.resolve(config.recordingsDir);
  const filePath = path.resolve(requestedPath);
  if (!filePath.startsWith(recordingsRoot + path.sep)) {
    throw new Error('Recording path outside recordings directory');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(STREAM_ALGORITHM, encryptionKey, iv);
  const header = Buffer.concat([REC_MAGIC, Buffer.from([REC_VERSION]), iv]);
  fs.writeFileSync(filePath, header, { flag: 'wx' });
  return {
    writeChunk(data: Buffer) {
      fs.appendFileSync(filePath, cipher.update(data));
    },
    close() {
      const fin = cipher.final();
      if (fin.length > 0) fs.appendFileSync(filePath, fin);
    },
  };
}

/** Encrypt a complete plaintext buffer and return encrypted bytes with header. */
export function encryptRecordingBuffer(plaintextBuf: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(STREAM_ALGORITHM, encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  return Buffer.concat([REC_MAGIC, Buffer.from([REC_VERSION]), iv, encrypted]);
}

/** Encrypt a recording file in-place atomically. No-op if already encrypted or file missing. */
export function encryptRecordingFileInPlace(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath);
    if (isEncryptedRecording(raw)) return;
    const enc = encryptRecordingBuffer(raw);
    const tmp = filePath + '.enc.tmp';
    fs.writeFileSync(tmp, enc);
    fs.renameSync(tmp, filePath);
  } catch { /* best effort */ }
}

/** Return the current encryption key as hex (for backup). */
export function getEncryptionKeyHex(): string {
  return encryptionKey.toString('hex');
}

/** Hot-swap the encryption key (used after backup restore). */
export function setEncryptionKey(hexKey: string): void {
  encryptionKey = Buffer.from(hexKey, 'hex');
}
