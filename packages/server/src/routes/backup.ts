import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import initSqlJs from 'sql.js';
import { requirePermission, userCan } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { createBackup, restoreBackup, getRecordingsSizeInfo } from '../services/backup.js';
import { getDb, restoreDbFromBytes } from '../db/index.js';
import { config } from '../config.js';
import { getEncryptionKeyHex } from '../services/encryption.js';
import {
  getAutoBackupConfigForApi,
  getAutoBackupStatus,
  listAdminSmbConnections,
  listAutoBackupHistory,
  runAutoBackupNow,
  testAutoBackupDestination,
  updateAutoBackupConfig,
} from '../services/autoBackup.js';

const AES_GCM = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;
const UNCHANGED_SENTINEL = '__unchanged__';

/** Decrypt a credential that was encrypted with an arbitrary key (backup's key). */
function decryptWith(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = buf.subarray(IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv(AES_GCM, key, iv);
  d.setAuthTag(tag);
  return d.update(body) + d.final('utf8');
}

/** Encrypt a credential with an arbitrary key (the live key). */
function encryptWith(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(AES_GCM, key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

/**
 * Re-encrypt all credential fields in `dbBytes` from `backupKey` to `liveKey`.
 * Opens the DB in-memory, iterates every encrypted column, and returns the
 * patched bytes. Leaves rows with NULL / empty / already-correct values untouched.
 */
async function reEncryptDbBytes(dbBytes: Buffer, backupKeyHex: string, liveKeyHex: string): Promise<Buffer> {
  if (backupKeyHex === liveKeyHex) return dbBytes; // keys are identical — nothing to do

  const backupKey = Buffer.from(backupKeyHex, 'hex');
  const liveKey = Buffer.from(liveKeyHex, 'hex');

  const SQL = await initSqlJs();
  const tmpDb = new SQL.Database(dbBytes);

  function reEncryptColumn(table: string, col: string) {
    const rows = tmpDb.exec(`SELECT id, ${col} FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`);
    if (!rows.length || !rows[0].values.length) return;
    for (const [id, ciphertext] of rows[0].values as [string, string][]) {
      try {
        const plain = decryptWith(ciphertext, backupKey);
        const reEncrypted = encryptWith(plain, liveKey);
        tmpDb.run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, [reEncrypted, id]);
      } catch {
        // If decryption fails the value may already be in plaintext (legacy) or
        // corrupted — leave it as-is rather than silently destroying it.
      }
    }
  }

  function reEncryptSetting(key: string) {
    const rows = tmpDb.exec(`SELECT value FROM settings WHERE key = ? AND value IS NOT NULL AND value != ''`, [key]);
    if (!rows.length || !rows[0].values.length) return;
    const [ciphertext] = rows[0].values[0] as [string];
    try {
      const plain = decryptWith(ciphertext, backupKey);
      const reEncrypted = encryptWith(plain, liveKey);
      tmpDb.run(`UPDATE settings SET value = ? WHERE key = ?`, [reEncrypted, key]);
    } catch { /* leave as-is */ }
  }

  // connections table
  reEncryptColumn('connections', 'encrypted_password');
  reEncryptColumn('connections', 'private_key');

  // users table — MFA secrets
  reEncryptColumn('users', 'mfa_secret');

  // settings table — LDAP bind password, OIDC client secret
  reEncryptSetting('auth.ldap_bind_password');
  reEncryptSetting('auth.oidc_client_secret');

  const result = Buffer.from(tmpDb.export());
  tmpDb.close();
  return result;
}

const router = Router();

// GET /size — return estimated backup size breakdown
router.get('/size', requirePermission('settings.backup'), (_req: Request, res: Response) => {
  try {
    const dbSize = Buffer.from(getDb().export()).length;
    const { recordingsSize, recordingCount } = getRecordingsSizeInfo();
    res.json({ dbSize, recordingsSize, recordingCount });
  } catch (e) {
    res.status(500).json({ error: `Size check failed: ${(e as Error).message}` });
  }
});

// POST /export — create and download encrypted backup
router.post('/export', requirePermission('settings.backup'), (req: Request, res: Response) => {
  const { password, includeRecordings = false } = req.body as { password?: string; includeRecordings?: boolean };
  if (!password || password.length < 8) {
    res.status(400).json({ error: 'Backup password must be at least 8 characters' });
    return;
  }
  try {
    const dbBytes = Buffer.from(getDb().export());
    const backupBuf = createBackup(password, dbBytes, includeRecordings);
    const filename = `gatwy-backup-${new Date().toISOString().slice(0, 10)}.geb`;
    logAudit({
      userId: req.user!.userId,
      eventType: 'admin.backup.export',
      target: filename,
      details: { sizeBytes: backupBuf.length, includeRecordings },
      ipAddress: req.ip,
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', backupBuf.length);
    res.end(backupBuf);
  } catch (e) {
    res.status(500).json({ error: `Backup failed: ${(e as Error).message}` });
  }
});

// POST /import — restore system from encrypted backup
// Body: raw .geb binary. Password in X-Backup-Password header.
router.post('/import', requirePermission('settings.backup'), async (req: Request, res: Response) => {
  const password = req.headers['x-backup-password'];
  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'X-Backup-Password header required' });
    return;
  }
  const raw: unknown = req.body;
  if (!Buffer.isBuffer(raw)) {
    res.status(400).json({ error: 'Valid backup file required' });
    return;
  }
  // Construct a fresh Buffer immediately after type guard — all further checks
  // operate on `data` so CodeQL sees a clearly-typed value, not the raw body.
  const data: Buffer = Buffer.from(raw);
  if (data.length < 100) {
    res.status(400).json({ error: 'Valid backup file required' });
    return;
  }
  try {
    const restored = restoreBackup(data, password);

    // Re-encrypt all credentials from the backup's encryption key to the
    // currently active live key before hot-swapping the database.
    // Without this step credentials would be undecryptable after restore.
    const liveKeyHex = getEncryptionKeyHex();
    const reEncryptedDb = await reEncryptDbBytes(restored.dbBytes, restored.encryptionKeyHex, liveKeyHex);

    // Restore recordings — sanitize filenames to prevent path traversal (C2)
    fs.mkdirSync(config.recordingsDir, { recursive: true });
    for (const f of fs.readdirSync(config.recordingsDir)) {
      try { fs.unlinkSync(path.join(config.recordingsDir, f)); } catch { /* ignore */ }
    }
    for (const rec of restored.recordings) {
      const safeName = path.basename(rec.name);
      if (!safeName || !/^[\w.\-]+$/.test(safeName)) {
        console.warn(`[backup] Skipping recording with invalid filename: ${rec.name}`);
        continue;
      }
      fs.writeFileSync(path.join(config.recordingsDir, safeName), rec.data);
    }

    // Hot-swap the database (last, so the audit log above isn't lost)
    restoreDbFromBytes(reEncryptedDb);

    res.json({
      ok: true,
      message: 'Backup restored successfully. Please reload the page.',
      recordingsRestored: restored.recordings.length,
    });
  } catch (e) {
    const msg = (e as Error).message;
    // Use 422 (not 401) for wrong password — 401 can trigger browser auth dialogs
    const status = msg.includes('Invalid backup password') || msg.includes('corrupted') ? 422 : 400;
    res.status(status).json({ error: msg });
  }
});

// GET /auto/config — read auto-backup config
router.get('/auto/config', requirePermission('settings.backup'), (_req: Request, res: Response) => {
  try {
    const payload = getAutoBackupConfigForApi();
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: `Failed to load auto-backup config: ${(e as Error).message}` });
  }
});

// PUT /auto/config — update auto-backup config
router.put('/auto/config', requirePermission('settings.backup'), (req: Request, res: Response) => {
  const body = req.body as {
    enabled?: boolean;
    destinationMode?: 'saved' | 'adhoc';
    connectionId?: string;
    remotePath?: string;
    scheduleType?: 'daily' | 'weekly';
    scheduleTime?: string;
    scheduleWeekday?: number;
    includeRecordings?: boolean;
    retentionCount?: number;
    password?: string;
    adhoc?: {
      host?: string;
      port?: number;
      share?: string;
      username?: string;
      password?: string;
      domain?: string;
    };
  };

  try {
    updateAutoBackupConfig({
      enabled: !!body.enabled,
      destinationMode: body.destinationMode === 'adhoc' ? 'adhoc' : 'saved',
      connectionId: String(body.connectionId ?? ''),
      remotePath: String(body.remotePath ?? ''),
      scheduleType: body.scheduleType === 'weekly' ? 'weekly' : 'daily',
      scheduleTime: String(body.scheduleTime ?? '02:30'),
      scheduleWeekday: Number(body.scheduleWeekday ?? 1),
      includeRecordings: !!body.includeRecordings,
      retentionCount: Number(body.retentionCount ?? 14),
      password: String(body.password ?? ''),
      adhoc: {
        host: String(body.adhoc?.host ?? ''),
        port: Number(body.adhoc?.port ?? 445),
        share: String(body.adhoc?.share ?? ''),
        username: String(body.adhoc?.username ?? ''),
        password: String(body.adhoc?.password ?? ''),
        domain: String(body.adhoc?.domain ?? ''),
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// GET /auto/connections — list admin-owned SMB connections
router.get('/auto/connections', requirePermission('settings.backup'), (_req: Request, res: Response) => {
  try {
    res.json({
      connections: listAdminSmbConnections(),
    });
  } catch (e) {
    res.status(500).json({ error: `Failed to list SMB destinations: ${(e as Error).message}` });
  }
});

// POST /auto/test — test SMB destination using saved/ad-hoc config
router.post('/auto/test', requirePermission('settings.backup'), async (req: Request, res: Response) => {
  const body = req.body as {
    destinationMode?: 'saved' | 'adhoc';
    connectionId?: string;
    remotePath?: string;
    adhoc?: {
      host?: string;
      port?: number;
      share?: string;
      username?: string;
      password?: string;
      domain?: string;
    };
  };

  try {
    await testAutoBackupDestination({
      destinationMode: body.destinationMode === 'adhoc' ? 'adhoc' : 'saved',
      connectionId: String(body.connectionId ?? ''),
      remotePath: String(body.remotePath ?? ''),
      adhoc: {
        host: String(body.adhoc?.host ?? ''),
        port: Number(body.adhoc?.port ?? 445),
        share: String(body.adhoc?.share ?? ''),
        username: String(body.adhoc?.username ?? ''),
        password: String(body.adhoc?.password ?? UNCHANGED_SENTINEL),
        domain: String(body.adhoc?.domain ?? ''),
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /auto/run-now — force immediate run
router.post('/auto/run-now', requirePermission('settings.backup'), async (_req: Request, res: Response) => {
  try {
    await runAutoBackupNow();
    res.json({ ok: true });
  } catch (e) {
    const message = (e as Error).message;
    const status = message.includes('already in progress') ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

// GET /auto/status — monitoring endpoint
router.get('/auto/status', requirePermission('settings.backup'), (_req: Request, res: Response) => {
  try {
    const status = getAutoBackupStatus();
    res.json({ status });
  } catch (e) {
    res.status(500).json({ error: `Failed to get status: ${(e as Error).message}` });
  }
});

// GET /auto/history — latest run history
router.get('/auto/history', requirePermission('settings.backup'), (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit ?? '50'), 10);
  try {
    const rows = listAutoBackupHistory(Number.isFinite(limit) ? limit : 50);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: `Failed to get history: ${(e as Error).message}` });
  }
});

// GET /auto/capabilities — helper for UI warnings/caps
router.get('/auto/capabilities', requirePermission('settings.backup'), (req: Request, res: Response) => {
  const canUseSmb = userCan(req, 'protocols.smb');
  res.json({
    maxFileSizeBytes: 4 * 1024 * 1024 * 1024,
    passwordSentinel: UNCHANGED_SENTINEL,
    canUseSmb,
  });
});

export default router;
