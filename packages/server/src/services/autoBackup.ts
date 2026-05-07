import { v4 as uuid } from 'uuid';
import path from 'path';
import { queryAll, queryOne, execute } from '../db/helpers.js';
import { getSetting, setSetting } from './settings.js';
import { decrypt, encrypt } from './encryption.js';
import { createBackup, getRecordingsSizeInfo } from './backup.js';
import { getDb } from '../db/index.js';
import { logAudit } from './audit.js';
import { patchSmbNtlm } from './smbPatch.js';
import SMB2 from '@marsaud/smb2';

patchSmbNtlm();

const AUTO_PREFIX = 'auto_backup.';
const SENTINEL_UNCHANGED = '__unchanged__';
const MAX_BACKUP_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const RUN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SCHEDULE_TICK_MS = 30_000;
const HISTORY_RETENTION_DAYS = 90;
const FAILURE_DISABLE_THRESHOLD = 3;
const FILE_PREFIX = 'gatwy-auto-';
const FILE_SUFFIX = '.geb';

let schedulerStarted = false;
let runInProgress = false;
let queuedScheduledRun = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let purgeTimer: ReturnType<typeof setInterval> | null = null;

export type DestinationMode = 'saved' | 'adhoc';
export type ScheduleType = 'daily' | 'weekly';

type AutoBackupConfig = {
  enabled: boolean;
  destinationMode: DestinationMode;
  connectionId: string;
  remotePath: string;
  scheduleType: ScheduleType;
  scheduleTime: string;
  scheduleWeekday: number;
  includeRecordings: boolean;
  retentionCount: number;
  autoDisabled: boolean;
};

type AutoBackupSensitive = {
  password: string;
  adhoc: {
    host: string;
    port: number;
    share: string;
    username: string;
    password: string;
    domain: string;
  };
};

type AutoBackupHistoryRow = {
  id: string;
  trigger_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  filename: string | null;
  destination_mode: string;
  destination_label: string | null;
  include_recordings: number;
  error_message: string | null;
};

type SmbTarget = {
  host: string;
  port: number;
  share: string;
  username: string;
  password: string;
  domain: string;
};

type SavedSmbConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string | null;
  encrypted_password: string | null;
  extra_config_json: string | null;
};

function setting(key: string): string {
  return getSetting(`${AUTO_PREFIX}${key}`);
}

function setAutoSetting(key: string, value: string): void {
  setSetting(`${AUTO_PREFIX}${key}`, value);
}

function parseBool(raw: string, fallback: boolean): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function parseIntSafe(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSmbSegment(seg: string): string {
  return seg.trim().replace(/[\/]+/g, '');
}

function normalizeRemotePath(input: string): string {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  const unified = trimmed.replace(/\//g, '\\');
  const parts = unified.split('\\').map((p) => p.trim()).filter(Boolean);
  const safeParts = parts.map((p) => sanitizeSmbSegment(p)).filter(Boolean);
  return safeParts.join('\\');
}

function joinRemotePath(base: string, filename: string): string {
  const nBase = normalizeRemotePath(base);
  return nBase ? `${nBase}\\${filename}` : filename;
}

function validTimeHHMM(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function sanitizeRetentionCount(raw: number): number {
  if (!Number.isFinite(raw) || raw < 1) return 14;
  return Math.min(365, Math.floor(raw));
}

function parseScheduleWeekday(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const n = Math.floor(raw);
  if (n < 0 || n > 6) return 1;
  return n;
}

function getOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    parseInt(map.year ?? '0', 10),
    parseInt(map.month ?? '1', 10) - 1,
    parseInt(map.day ?? '1', 10),
    parseInt(map.hour ?? '0', 10),
    parseInt(map.minute ?? '0', 10),
    parseInt(map.second ?? '0', 10),
  );
  return asUtc - date.getTime();
}

function zonedLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const localUtcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let ts = localUtcGuess;
  for (let i = 0; i < 3; i++) {
    const offset = getOffsetMs(new Date(ts), timeZone);
    ts = localUtcGuess - offset;
  }
  return ts;
}

function getZonedNowParts(timeZone: string, now: Date): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = dtf.formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const wkMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: parseInt(map.year ?? '1970', 10),
    month: parseInt(map.month ?? '1', 10),
    day: parseInt(map.day ?? '1', 10),
    weekday: wkMap[map.weekday ?? 'Mon'] ?? 1,
    hour: parseInt(map.hour ?? '0', 10),
    minute: parseInt(map.minute ?? '0', 10),
  };
}

function computeNextRunAt(config: AutoBackupConfig, now: Date): string {
  const tz = getSetting('app.timezone') || 'UTC';
  const [hourStr, minuteStr] = config.scheduleTime.split(':');
  const targetHour = parseInt(hourStr ?? '2', 10);
  const targetMinute = parseInt(minuteStr ?? '30', 10);

  const nowParts = getZonedNowParts(tz, now);
  const todayTarget = zonedLocalToUtcMs(
    nowParts.year,
    nowParts.month,
    nowParts.day,
    targetHour,
    targetMinute,
    tz,
  );

  if (config.scheduleType === 'daily') {
    if (todayTarget > now.getTime()) {
      return new Date(todayTarget).toISOString();
    }
    const tomorrowUtc = new Date(todayTarget + 24 * 60 * 60 * 1000);
    const tomorrowParts = getZonedNowParts(tz, tomorrowUtc);
    const next = zonedLocalToUtcMs(
      tomorrowParts.year,
      tomorrowParts.month,
      tomorrowParts.day,
      targetHour,
      targetMinute,
      tz,
    );
    return new Date(next).toISOString();
  }

  const currentWeekday = nowParts.weekday;
  let delta = config.scheduleWeekday - currentWeekday;
  if (delta < 0) delta += 7;

  let candidate = todayTarget + delta * 24 * 60 * 60 * 1000;
  if (delta === 0 && candidate <= now.getTime()) {
    candidate += 7 * 24 * 60 * 60 * 1000;
  }

  const candidateParts = getZonedNowParts(tz, new Date(candidate));
  const next = zonedLocalToUtcMs(
    candidateParts.year,
    candidateParts.month,
    candidateParts.day,
    targetHour,
    targetMinute,
    tz,
  );
  return new Date(next).toISOString();
}

function getConfig(): AutoBackupConfig {
  const scheduleTypeRaw = setting('schedule_type');
  const destinationModeRaw = setting('destination_mode');

  return {
    enabled: parseBool(setting('enabled'), false),
    destinationMode: destinationModeRaw === 'adhoc' ? 'adhoc' : 'saved',
    connectionId: setting('connection_id'),
    remotePath: normalizeRemotePath(setting('remote_path')),
    scheduleType: scheduleTypeRaw === 'weekly' ? 'weekly' : 'daily',
    scheduleTime: validTimeHHMM(setting('schedule_time')) ? setting('schedule_time') : '02:30',
    scheduleWeekday: parseScheduleWeekday(parseIntSafe(setting('schedule_weekday'), 1)),
    includeRecordings: parseBool(setting('include_recordings'), false),
    retentionCount: sanitizeRetentionCount(parseIntSafe(setting('retention_count'), 14)),
    autoDisabled: parseBool(setting('auto_disabled'), false),
  };
}

function readSensitive(): AutoBackupSensitive {
  const encPassword = setting('password_enc');
  const encAdhoc = setting('adhoc_enc');

  let password = '';
  if (encPassword) {
    try { password = decrypt(encPassword); } catch { password = ''; }
  }

  let adhoc = {
    host: '',
    port: 445,
    share: '',
    username: '',
    password: '',
    domain: '',
  };

  if (encAdhoc) {
    try {
      const parsed = JSON.parse(decrypt(encAdhoc)) as Partial<AutoBackupSensitive['adhoc']>;
      adhoc = {
        host: String(parsed.host ?? ''),
        port: parseIntSafe(String(parsed.port ?? '445'), 445),
        share: String(parsed.share ?? ''),
        username: String(parsed.username ?? ''),
        password: String(parsed.password ?? ''),
        domain: String(parsed.domain ?? ''),
      };
    } catch {
      adhoc = {
        host: '',
        port: 445,
        share: '',
        username: '',
        password: '',
        domain: '',
      };
    }
  }

  return { password, adhoc };
}

function storeSensitive(data: AutoBackupSensitive): void {
  if (data.password) {
    setAutoSetting('password_enc', encrypt(data.password));
  }
  const adhocJson = JSON.stringify(data.adhoc);
  setAutoSetting('adhoc_enc', encrypt(adhocJson));
}

function getFailureCount(): number {
  return parseIntSafe(setting('consecutive_failures'), 0);
}

function setFailureCount(value: number): void {
  setAutoSetting('consecutive_failures', String(Math.max(0, value)));
}

function parseSmbConfigExtra(raw: string | null): { share: string; domain: string } {
  if (!raw) return { share: '', domain: '' };
  try {
    const p = JSON.parse(raw) as { share?: string; domain?: string };
    return {
      share: String(p.share ?? '').replace(/^[/\\]+/, ''),
      domain: String(p.domain ?? ''),
    };
  } catch {
    return { share: '', domain: '' };
  }
}

function makeSmbClient(target: SmbTarget): SMB2 {
  const isAnonymous = !target.username && !target.password;
  const safeShare = target.share.replace(/^[/\\]+/, '');
  const share = `\\\\${target.host}\\${safeShare}`;
  return new SMB2({
    share,
    domain: target.domain,
    username: isAnonymous ? '' : target.username,
    password: isAnonymous ? '' : target.password,
    port: target.port || 445,
    autoCloseTimeout: 5000,
  });
}

async function smbOp<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      fn().then(resolve).catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function ensureSmbDirs(smb: SMB2, remoteDir: string): Promise<void> {
  const n = normalizeRemotePath(remoteDir);
  if (!n) return;
  const parts = n.split('\\').filter(Boolean);
  let current = '';
  for (const p of parts) {
    current = current ? `${current}\\${p}` : p;
    try {
      await smbOp(() => smb.mkdir(current));
    } catch {
      // Already exists or cannot create; continue and let later write fail if needed.
    }
  }
}

function buildAutoFilename(): string {
  const tz = getSetting('app.timezone') || 'UTC';
  const now = new Date();
  const parts = getZonedNowParts(tz, now);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const ts = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}-${pad(parts.minute)}-00`;
  return `${FILE_PREFIX}${ts}${FILE_SUFFIX}`;
}

function isManagedBackupName(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

function estimateBackupSizeBytes(includeRecordings: boolean): number {
  const dbSize = Buffer.from(getDb().export()).length;
  if (!includeRecordings) return dbSize;
  const rec = getRecordingsSizeInfo();
  return dbSize + rec.recordingsSize;
}

function validateConfig(config: AutoBackupConfig, sensitive: AutoBackupSensitive): string | null {
  if (!validTimeHHMM(config.scheduleTime)) return 'Schedule time must be in HH:MM format.';
  if (config.scheduleType === 'weekly' && (config.scheduleWeekday < 0 || config.scheduleWeekday > 6)) {
    return 'Weekly schedule day must be between 0 and 6.';
  }
  if (config.retentionCount < 1) return 'Retention count must be at least 1.';
  if (!sensitive.password || sensitive.password.length < 8) return 'Global backup password must be at least 8 characters.';

  if (config.destinationMode === 'saved') {
    if (!config.connectionId) return 'Saved SMB connection is required.';
  } else {
    if (!sensitive.adhoc.host) return 'Ad-hoc SMB host is required.';
    if (!sensitive.adhoc.share) return 'Ad-hoc SMB share is required.';
  }

  return null;
}

function getSavedSmbConnections(): Array<{ id: string; name: string; host: string; port: number }> {
  return queryAll<{ id: string; name: string; host: string; port: number }>(
    `SELECT c.id, c.name, c.host, c.port
     FROM connections c
     INNER JOIN users u ON u.id = c.user_id
     WHERE c.protocol = 'smb' AND u.role = 'admin'
     ORDER BY c.name COLLATE NOCASE ASC`,
    [],
  );
}

function resolveSavedConnection(connectionId: string): SavedSmbConnection | null {
  return queryOne<SavedSmbConnection>(
    `SELECT c.id, c.name, c.host, c.port, c.username, c.encrypted_password, c.extra_config_json
     FROM connections c
     INNER JOIN users u ON u.id = c.user_id
     WHERE c.id = ? AND c.protocol = 'smb' AND u.role = 'admin'`,
    [connectionId],
  ) ?? null;
}

function resolveTarget(config: AutoBackupConfig, sensitive: AutoBackupSensitive): { target: SmbTarget; label: string } {
  if (config.destinationMode === 'saved') {
    const row = resolveSavedConnection(config.connectionId);
    if (!row) throw new Error('Configured SMB destination connection not found or not admin-owned.');

    const extra = parseSmbConfigExtra(row.extra_config_json);
    if (!extra.share) throw new Error('SMB destination share is missing on selected connection.');

    const password = row.encrypted_password
      ? (() => { try { return decrypt(row.encrypted_password); } catch { return ''; } })()
      : '';

    return {
      target: {
        host: row.host,
        port: row.port || 445,
        share: extra.share,
        username: row.username ?? '',
        password,
        domain: extra.domain,
      },
      label: `${row.name} (${row.host})`,
    };
  }

  return {
    target: {
      host: sensitive.adhoc.host,
      port: sensitive.adhoc.port || 445,
      share: sensitive.adhoc.share,
      username: sensitive.adhoc.username,
      password: sensitive.adhoc.password,
      domain: sensitive.adhoc.domain,
    },
    label: `adhoc:${sensitive.adhoc.host}`,
  };
}

function insertHistory(triggerType: string, config: AutoBackupConfig, destinationLabel: string): string {
  const id = uuid();
  execute(
    `INSERT INTO auto_backup_history (
      id, trigger_type, status, started_at, destination_mode, destination_label, include_recordings
    ) VALUES (?, ?, 'running', datetime('now'), ?, ?, ?)`,
    [id, triggerType, config.destinationMode, destinationLabel, config.includeRecordings ? 1 : 0],
  );
  return id;
}

function finishHistorySuccess(historyId: string, sizeBytes: number, filename: string, startedAtMs: number): void {
  execute(
    `UPDATE auto_backup_history
     SET status = 'success',
         finished_at = datetime('now'),
         duration_ms = ?,
         size_bytes = ?,
         filename = ?,
         error_message = NULL
     WHERE id = ?`,
    [Date.now() - startedAtMs, sizeBytes, filename, historyId],
  );
}

function finishHistoryFailed(historyId: string, errorMessage: string, startedAtMs: number): void {
  execute(
    `UPDATE auto_backup_history
     SET status = 'failed',
         finished_at = datetime('now'),
         duration_ms = ?,
         error_message = ?
     WHERE id = ?`,
    [Date.now() - startedAtMs, errorMessage.slice(0, 2000), historyId],
  );
}

async function applyRetention(smb: SMB2, remotePath: string, retentionCount: number): Promise<number> {
  const dir = normalizeRemotePath(remotePath);
  const list = await smbOp(() => smb.readdir(dir || '', { stats: true }));
  const managed = list
    .filter((f) => isManagedBackupName(f.name))
    .map((f) => ({ name: f.name, mtimeMs: f.mtime ? new Date(f.mtime as unknown as string).getTime() : 0 }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (managed.length <= retentionCount) return 0;

  let deleted = 0;
  const toDelete = managed.slice(retentionCount);
  for (const f of toDelete) {
    const full = joinRemotePath(dir, f.name);
    try {
      await smbOp(() => smb.unlink(full));
      deleted++;
    } catch {
      // Keep going on retention cleanup best-effort.
    }
  }
  return deleted;
}

async function uploadBackup(smb: SMB2, destinationPath: string, backupBuf: Buffer): Promise<void> {
  const stream = await smbOp(() => smb.createWriteStream(destinationPath));
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(backupBuf);
  });

  const stat = await smbOp(() => smb.stat(destinationPath));
  const size = Number((stat as { size?: number }).size ?? -1);
  if (size !== backupBuf.length) {
    throw new Error('SMB upload verification failed: remote file size mismatch.');
  }
}

function updateStatusFields(params: {
  status: 'success' | 'failed';
  filename?: string;
  sizeBytes?: number;
  error?: string;
}): void {
  setAutoSetting('last_run_at', nowIso());
  setAutoSetting('last_status', params.status);
  setAutoSetting('last_error', params.error ?? '');
  setAutoSetting('last_filename', params.filename ?? '');
  setAutoSetting('last_size_bytes', String(params.sizeBytes ?? 0));
}

async function runWithTimeout<T>(promiseFactory: () => Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promiseFactory(),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('Auto-backup run timed out after 5 minutes.')), timeoutMs);
    }),
  ]);
}

async function executeBackup(triggerType: 'scheduled' | 'manual'): Promise<void> {
  if (runInProgress) {
    if (triggerType === 'scheduled') {
      queuedScheduledRun = true;
      return;
    }
    throw new Error('Auto-backup run already in progress.');
  }

  runInProgress = true;
  const startedAtMs = Date.now();

  try {
    const config = getConfig();
    const sensitive = readSensitive();

    const validationError = validateConfig(config, sensitive);
    if (validationError) throw new Error(validationError);

    const { target, label } = resolveTarget(config, sensitive);
    const historyId = insertHistory(triggerType, config, label);

    await runWithTimeout(async () => {
      const estimated = estimateBackupSizeBytes(config.includeRecordings);
      if (estimated > MAX_BACKUP_BYTES) {
        throw new Error('Estimated backup size exceeds 4 GB limit.');
      }

      const dbBytes = Buffer.from(getDb().export());
      const backupBuf = createBackup(sensitive.password, dbBytes, config.includeRecordings);
      if (backupBuf.length > MAX_BACKUP_BYTES) {
        throw new Error('Backup size exceeds 4 GB limit.');
      }

      const filename = buildAutoFilename();
      const smb = makeSmbClient(target);
      const remoteDir = config.remotePath;
      const remoteFile = joinRemotePath(remoteDir, filename);

      try {
        await ensureSmbDirs(smb, remoteDir);
        await uploadBackup(smb, remoteFile, backupBuf);
        const deleted = await applyRetention(smb, remoteDir, config.retentionCount);

        finishHistorySuccess(historyId, backupBuf.length, filename, startedAtMs);
        updateStatusFields({ status: 'success', filename, sizeBytes: backupBuf.length });
        setFailureCount(0);
        setAutoSetting('auto_disabled', 'false');

        logAudit({
          userId: 'system',
          eventType: 'backup.auto.run_succeeded',
          target: filename,
          details: {
            triggerType,
            destinationMode: config.destinationMode,
            destinationLabel: label,
            includeRecordings: config.includeRecordings,
            sizeBytes: backupBuf.length,
            retentionDeleted: deleted,
          },
        });
      } finally {
        smb.disconnect();
      }
    }, RUN_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Auto-backup failed.';
    updateStatusFields({ status: 'failed', error: message });
    const failCount = getFailureCount() + 1;
    setFailureCount(failCount);

    const history = queryOne<{ id: string }>(
      `SELECT id FROM auto_backup_history WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
      [],
    );
    if (history?.id) finishHistoryFailed(history.id, message, startedAtMs);

    let autoDisabled = false;
    if (failCount >= FAILURE_DISABLE_THRESHOLD) {
      setAutoSetting('auto_disabled', 'true');
      autoDisabled = true;
      logAudit({
        userId: 'system',
        eventType: 'backup.auto.auto_disabled',
        details: { consecutiveFailures: failCount, reason: message },
      });
    }

    logAudit({
      userId: 'system',
      eventType: 'backup.auto.run_failed',
      details: {
        error: message,
        triggerType,
        consecutiveFailures: failCount,
        autoDisabled,
      },
    });

    if (triggerType === 'manual') throw error;
  } finally {
    runInProgress = false;

    if (queuedScheduledRun) {
      queuedScheduledRun = false;
      // Fire and forget queued scheduled run.
      void executeBackup('scheduled');
    }
  }
}

function scheduleNextRunFromNow(): void {
  const cfg = getConfig();
  if (!cfg.enabled || cfg.autoDisabled) {
    setAutoSetting('next_run_at', '');
    return;
  }
  const next = computeNextRunAt(cfg, new Date());
  setAutoSetting('next_run_at', next);
}

function shouldRunScheduled(now: Date): boolean {
  const cfg = getConfig();
  if (!cfg.enabled || cfg.autoDisabled) return false;
  const next = setting('next_run_at');
  if (!next) return false;
  const nextTs = new Date(next).getTime();
  if (!Number.isFinite(nextTs)) return false;
  return now.getTime() >= nextTs;
}

async function schedulerTick(): Promise<void> {
  const now = new Date();
  if (!shouldRunScheduled(now)) return;

  // Set next run ahead immediately so we do not retry missed windows after restarts.
  scheduleNextRunFromNow();

  if (runInProgress) {
    queuedScheduledRun = true;
    return;
  }

  await executeBackup('scheduled');
}

export function startAutoBackupScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  scheduleNextRunFromNow();
  tickTimer = setInterval(() => {
    void schedulerTick();
  }, SCHEDULE_TICK_MS);

  const purge = () => {
    execute(
      `DELETE FROM auto_backup_history
       WHERE started_at < datetime('now', ?)` ,
      [`-${HISTORY_RETENTION_DAYS} days`],
    );
  };

  setTimeout(() => purge(), 5000);
  purgeTimer = setInterval(() => purge(), 24 * 60 * 60 * 1000);
}

export function stopAutoBackupScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
  schedulerStarted = false;
}

export function listAdminSmbConnections(): Array<{ id: string; name: string; host: string; port: number }> {
  return getSavedSmbConnections();
}

export function getAutoBackupConfigForApi(): {
  config: AutoBackupConfig;
  hasPassword: boolean;
  hasAdhocPassword: boolean;
  adhoc: Omit<AutoBackupSensitive['adhoc'], 'password'>;
} {
  const config = getConfig();
  const sensitive = readSensitive();
  return {
    config,
    hasPassword: !!sensitive.password,
    hasAdhocPassword: !!sensitive.adhoc.password,
    adhoc: {
      host: sensitive.adhoc.host,
      port: sensitive.adhoc.port,
      share: sensitive.adhoc.share,
      username: sensitive.adhoc.username,
      domain: sensitive.adhoc.domain,
    },
  };
}

export function updateAutoBackupConfig(payload: {
  enabled: boolean;
  destinationMode: DestinationMode;
  connectionId: string;
  remotePath: string;
  scheduleType: ScheduleType;
  scheduleTime: string;
  scheduleWeekday: number;
  includeRecordings: boolean;
  retentionCount: number;
  password: string;
  adhoc: {
    host: string;
    port: number;
    share: string;
    username: string;
    password: string;
    domain: string;
  };
}): { ok: true } {
  const prev = getAutoBackupConfigForApi().config;
  const sensitive = readSensitive();

  const nextSensitive: AutoBackupSensitive = {
    password: payload.password === SENTINEL_UNCHANGED ? sensitive.password : payload.password,
    adhoc: {
      host: (payload.adhoc.host ?? '').trim(),
      port: parseIntSafe(String(payload.adhoc.port ?? 445), 445),
      share: (payload.adhoc.share ?? '').trim(),
      username: (payload.adhoc.username ?? '').trim(),
      password: payload.adhoc.password === SENTINEL_UNCHANGED ? sensitive.adhoc.password : payload.adhoc.password,
      domain: (payload.adhoc.domain ?? '').trim(),
    },
  };

  const nextConfig: AutoBackupConfig = {
    enabled: !!payload.enabled,
    destinationMode: payload.destinationMode === 'adhoc' ? 'adhoc' : 'saved',
    connectionId: String(payload.connectionId ?? '').trim(),
    remotePath: normalizeRemotePath(String(payload.remotePath ?? '').trim()),
    scheduleType: payload.scheduleType === 'weekly' ? 'weekly' : 'daily',
    scheduleTime: String(payload.scheduleTime ?? '02:30').trim(),
    scheduleWeekday: parseScheduleWeekday(parseIntSafe(String(payload.scheduleWeekday ?? 1), 1)),
    includeRecordings: !!payload.includeRecordings,
    retentionCount: sanitizeRetentionCount(parseIntSafe(String(payload.retentionCount ?? 14), 14)),
    autoDisabled: false,
  };

  const validationError = validateConfig(nextConfig, nextSensitive);
  if (validationError) {
    throw new Error(validationError);
  }

  setAutoSetting('enabled', String(nextConfig.enabled));
  setAutoSetting('destination_mode', nextConfig.destinationMode);
  setAutoSetting('connection_id', nextConfig.connectionId);
  setAutoSetting('remote_path', nextConfig.remotePath);
  setAutoSetting('schedule_type', nextConfig.scheduleType);
  setAutoSetting('schedule_time', nextConfig.scheduleTime);
  setAutoSetting('schedule_weekday', String(nextConfig.scheduleWeekday));
  setAutoSetting('include_recordings', String(nextConfig.includeRecordings));
  setAutoSetting('retention_count', String(nextConfig.retentionCount));
  setAutoSetting('auto_disabled', 'false');
  setFailureCount(0);

  storeSensitive(nextSensitive);

  scheduleNextRunFromNow();

  logAudit({
    userId: 'system',
    eventType: 'backup.auto.config_updated',
    details: {
      before: prev,
      after: nextConfig,
    },
  });

  return { ok: true };
}

export async function testAutoBackupDestination(payload: {
  destinationMode: DestinationMode;
  connectionId: string;
  remotePath: string;
  adhoc: {
    host: string;
    port: number;
    share: string;
    username: string;
    password: string;
    domain: string;
  };
}): Promise<{ ok: true }> {
  const sensitive = readSensitive();
  const config: AutoBackupConfig = {
    ...getConfig(),
    destinationMode: payload.destinationMode === 'adhoc' ? 'adhoc' : 'saved',
    connectionId: String(payload.connectionId ?? '').trim(),
    remotePath: normalizeRemotePath(String(payload.remotePath ?? '').trim()),
  };

  const testSensitive: AutoBackupSensitive = {
    ...sensitive,
    adhoc: {
      host: String(payload.adhoc.host ?? '').trim(),
      port: parseIntSafe(String(payload.adhoc.port ?? 445), 445),
      share: String(payload.adhoc.share ?? '').trim(),
      username: String(payload.adhoc.username ?? '').trim(),
      password: payload.adhoc.password === SENTINEL_UNCHANGED ? sensitive.adhoc.password : String(payload.adhoc.password ?? ''),
      domain: String(payload.adhoc.domain ?? '').trim(),
    },
  };

  const { target, label } = resolveTarget(config, testSensitive);
  const smb = makeSmbClient(target);
  const tempName = `${FILE_PREFIX}test-${Date.now()}.tmp`;
  const remoteDir = config.remotePath;
  const remoteFile = joinRemotePath(remoteDir, tempName);

  try {
    await ensureSmbDirs(smb, remoteDir);
    await uploadBackup(smb, remoteFile, Buffer.from('gatwy-auto-backup-test', 'utf8'));
    await smbOp(() => smb.unlink(remoteFile));
  } finally {
    smb.disconnect();
  }

  logAudit({
    userId: 'system',
    eventType: 'backup.auto.destination_tested',
    details: {
      destinationMode: config.destinationMode,
      destinationLabel: label,
      remotePath: config.remotePath,
      ok: true,
    },
  });

  return { ok: true };
}

export async function runAutoBackupNow(): Promise<{ started: true }> {
  if (runInProgress) {
    throw new Error('Auto-backup run already in progress.');
  }
  await executeBackup('manual');
  scheduleNextRunFromNow();
  return { started: true };
}

export function getAutoBackupStatus(): {
  enabled: boolean;
  autoDisabled: boolean;
  runInProgress: boolean;
  queuedScheduledRun: boolean;
  nextRunAt: string;
  lastRunAt: string;
  lastStatus: string;
  lastError: string;
  lastFilename: string;
  lastSizeBytes: number;
  consecutiveFailures: number;
  maxFileSizeBytes: number;
  scheduleTickMs: number;
} {
  return {
    enabled: parseBool(setting('enabled'), false),
    autoDisabled: parseBool(setting('auto_disabled'), false),
    runInProgress,
    queuedScheduledRun,
    nextRunAt: setting('next_run_at'),
    lastRunAt: setting('last_run_at'),
    lastStatus: setting('last_status'),
    lastError: setting('last_error'),
    lastFilename: setting('last_filename'),
    lastSizeBytes: parseIntSafe(setting('last_size_bytes'), 0),
    consecutiveFailures: getFailureCount(),
    maxFileSizeBytes: MAX_BACKUP_BYTES,
    scheduleTickMs: SCHEDULE_TICK_MS,
  };
}

export function listAutoBackupHistory(limit: number): AutoBackupHistoryRow[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit || 50)));
  return queryAll<AutoBackupHistoryRow>(
    `SELECT
      id,
      trigger_type,
      status,
      started_at,
      finished_at,
      duration_ms,
      size_bytes,
      filename,
      destination_mode,
      destination_label,
      include_recordings,
      error_message
     FROM auto_backup_history
     ORDER BY started_at DESC
     LIMIT ?`,
    [safeLimit],
  );
}
