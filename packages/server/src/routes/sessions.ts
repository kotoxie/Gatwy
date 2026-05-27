import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute, getChanges } from '../db/helpers.js';
import { authRequired, requirePermission, userCan } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { config } from '../config.js';
import { decryptRecording, encryptRecordingFileInPlace, openRdpRecordingFile, type RdpRecordingWriter } from '../services/encryption.js';
import { resolveClientIp } from '../services/ip.js';

const router = Router();
router.use(authRequired);

// Per-session cipher context for RDP recordings. Keyed by session ID.
// Allows each incoming chunk to be encrypted immediately as it arrives.
const rdpWriters = new Map<string, RdpRecordingWriter>();

interface SessionRow {
  id: string;
  user_id: string;
  connection_id: string;
  protocol: string;
  started_at: string;
  ended_at: string | null;
  recording_path: string | null;
  connection_name: string | null;
  username: string | null;
}

// GET / — list sessions (view_any sees all, otherwise own only)
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const canViewAny = userCan(req, 'sessions.view_any');
  const page = Math.max(1, parseInt(req.query.page as string || '1', 10));
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit as string || '50', 10)));
  const offset = (page - 1) * limit;

  const whereClause = canViewAny ? '' : 'WHERE s.user_id = ?';
  const params: unknown[] = canViewAny ? [limit, offset] : [userId, limit, offset];

  const sessions = queryAll<SessionRow>(
    `SELECT s.id, s.user_id, s.connection_id, s.protocol, s.started_at, s.ended_at, s.recording_path,
            c.name AS connection_name, u.username
     FROM sessions s
     LEFT JOIN connections c ON c.id = s.connection_id
     LEFT JOIN users u ON u.id = s.user_id
     ${whereClause}
     ORDER BY s.started_at DESC
     LIMIT ? OFFSET ?`,
    params,
  );

  res.json({
    sessions: sessions.map((s) => {
      const exists = !!s.recording_path && fs.existsSync(s.recording_path);
      let fileSize: number | null = null;
      if (exists) {
        try { fileSize = fs.statSync(s.recording_path!).size; } catch { /* ignore */ }
      }
      return {
        id: s.id,
        userId: s.user_id,
        protocol: s.protocol,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        hasRecording: exists,
        fileSize,
        connectionName: s.connection_name,
        username: s.username,
      };
    }),
    page,
    limit,
  });
});

// DELETE / — purge all session history and recordings (sessions.delete permission)
router.delete('/', requirePermission('sessions.delete'), (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Collect all recording file paths before deleting rows
  const rows = queryAll<{ recording_path: string | null }>('SELECT recording_path FROM sessions', []);
  const totalSessions = rows.length;
  const totalFileSessions = queryAll<{ id: string }>('SELECT id FROM file_sessions', []).length;

  // Close any in-flight RDP recording writers
  for (const [sid, writer] of rdpWriters) {
    try { writer.close(); } catch { /* ignore */ }
    rdpWriters.delete(sid);
  }

  // Delete recording files from disk
  let deletedRecordings = 0;
  for (const row of rows) {
    if (row.recording_path && fs.existsSync(row.recording_path)) {
      try { fs.unlinkSync(row.recording_path); deletedRecordings++; } catch { /* ignore */ }
    }
  }

  // Delete all session rows
  execute('DELETE FROM sessions', []);

  // Delete all file activity sessions and their events
  execute('DELETE FROM file_session_events', []);
  execute('DELETE FROM file_sessions', []);

  logAudit({
    userId,
    eventType: 'admin.sessions.purge',
    target: 'all',
    details: { deletedSessions: totalSessions, deletedRecordings, deletedFileSessions: totalFileSessions },
    ipAddress: req.ip,
  });

  res.json({ ok: true, deletedSessions: totalSessions, deletedRecordings, deletedFileSessions: totalFileSessions });
});

// GET /:id/recording — stream recording file (.cast or .webm) with Range support
router.get('/:id/recording', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const canViewAny = userCan(req, 'sessions.view_any');
  const { id } = req.params;

  const session = queryOne<{ recording_path: string | null; user_id: string }>(
    'SELECT recording_path, user_id FROM sessions WHERE id = ?',
    [id],
  );

  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!canViewAny && session.user_id !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (!session.recording_path || !fs.existsSync(session.recording_path)) {
    res.status(404).json({ error: 'Recording not found' }); return;
  }

  const filePath = session.recording_path;
  const isWebm = filePath.endsWith('.webm');
  const mimeType = isWebm ? 'video/webm' : 'text/plain';

  // Read and decrypt (handles both encrypted and legacy plaintext files)
  const rawBuf = fs.readFileSync(filePath);
  const decrypted = decryptRecording(rawBuf);
  const fileSize = decrypted.length;

  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', mimeType);

  if (isWebm) {
    const rangeHeader = req.headers['range'];
    res.setHeader('Accept-Ranges', 'bytes');
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) { res.status(416).send('Range Not Satisfiable'); return; }
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      if (start > end || end >= fileSize) { res.status(416).send('Range Not Satisfiable'); return; }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      res.end(decrypted.subarray(start, end + 1));
    } else {
      res.status(200);
      res.setHeader('Content-Length', fileSize);
      res.end(decrypted);
    }
    return;
  }

  res.setHeader('Content-Length', fileSize);
  res.end(decrypted);
});

// POST /rdp-session — create a session row for an RDP recording and return sessionId
router.post('/rdp-session', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { connectionId } = req.body as { connectionId?: string };
  if (!connectionId) { res.status(400).json({ error: 'connectionId required' }); return; }

  const role = req.user!.role;
  const conn = queryOne<{ id: string; recording_enabled: number }>(
    `SELECT id, recording_enabled FROM connections WHERE id = ? AND (user_id = ? OR shared = 1 OR id IN (SELECT cs.connection_id FROM connection_shares cs WHERE (cs.share_type = 'user' AND cs.target_id = ?) OR (cs.share_type = 'role' AND cs.target_id = ?)))`,
    [connectionId, userId, userId, role],
  );
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const globalRecording = getSetting('session.recording_enabled') === 'true';
  const shouldRecord = globalRecording && conn.recording_enabled === 1;

  if (!shouldRecord) {
    res.json({ sessionId: null, shouldRecord: false });
    return;
  }

  const sessionId = uuid();
  execute(
    'INSERT INTO sessions (id, user_id, connection_id, protocol) VALUES (?, ?, ?, ?)',
    [sessionId, userId, connectionId, 'rdp'],
  );
  res.json({ sessionId, shouldRecord: true });
});

// POST /rdp-file-transfer — audit log an RDP file transfer event (client-side CLIPRDR)
router.post('/rdp-file-transfer', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { connectionId, fileName, fileSize, direction } = req.body as {
    connectionId?: string;
    fileName?: string;
    fileSize?: number;
    direction?: 'upload' | 'download';
  };
  if (!connectionId || !fileName || !direction) {
    res.status(400).json({ error: 'connectionId, fileName, and direction are required' });
    return;
  }

  logAudit({
    userId,
    eventType: `session.rdp.file_${direction}`,
    target: connectionId,
    details: { fileName, fileSize: fileSize ?? 0, direction },
    ipAddress: resolveClientIp(req),
  });
  res.json({ ok: true });
});

// POST /:id/recording/chunk — append a binary WebM chunk to the recording file
router.post('/:id/recording/chunk', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const canViewAny = userCan(req, 'sessions.view_any');
  const id = req.params.id as string;
  // Validate UUID format to prevent path traversal in recording file path
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    res.status(400).json({ error: 'Invalid session id' }); return;
  }

  const session = queryOne<{ recording_path: string | null; user_id: string }>(
    'SELECT recording_path, user_id FROM sessions WHERE id = ?',
    [id],
  );
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!canViewAny && session.user_id !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  let filePath = session.recording_path;
  if (!filePath) {
    fs.mkdirSync(config.recordingsDir, { recursive: true });
    filePath = path.join(config.recordingsDir, `${id}.webm`);
    execute('UPDATE sessions SET recording_path = ? WHERE id = ?', [filePath, id]);
  }

  try {
    let writer = rdpWriters.get(id);
    if (!writer) {
      // First chunk — create the encrypted file with header and a new cipher context
      writer = openRdpRecordingFile(filePath);
      rdpWriters.set(id, writer);
    }
    writer.writeChunk(req.body as Buffer);
  } catch {
    res.status(500).json({ error: 'Failed to write chunk' }); return;
  }
  res.json({ ok: true });
});

// POST /:id/recording/finalize — mark RDP session as ended
router.post('/:id/recording/finalize', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const canViewAny = userCan(req, 'sessions.view_any');
  const id = req.params.id as string;

  const session = queryOne<{ user_id: string }>(
    'SELECT user_id FROM sessions WHERE id = ?',
    [id],
  );
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!canViewAny && session.user_id !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  execute("UPDATE sessions SET ended_at = datetime('now') WHERE id = ?", [id]);
  // Finalize the in-flight cipher (CTR final() is a no-op but closes cleanly)
  const writer = rdpWriters.get(id);
  if (writer) { writer.close(); rdpWriters.delete(id); }
  // If no writer (e.g. recording was already on disk from a previous run), encrypt in-place as fallback
  const finSession = queryOne<{ recording_path: string | null }>('SELECT recording_path FROM sessions WHERE id = ?', [id]);
  if (finSession?.recording_path && !writer) encryptRecordingFileInPlace(finSession.recording_path);
  res.json({ ok: true });
});

// POST /:id/recording/events — batch-insert RDP input events (mouse/keyboard activity)
router.post('/:id/recording/events', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const session = queryOne<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', [id]);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (session.user_id !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const events = req.body as { elapsed: number; type: string }[];
  if (!Array.isArray(events) || events.length === 0) { res.json({ ok: true }); return; }

  try {
    const stmt = 'INSERT INTO rdp_events (session_id, elapsed, event_type) VALUES (?, ?, ?)';
    for (const evt of events) {
      if (typeof evt.elapsed === 'number' && ['click', 'key', 'move'].includes(evt.type)) {
        execute(stmt, [id, evt.elapsed, evt.type]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[sessions] Failed to insert RDP events:', e);
    res.status(500).json({ error: 'Failed to store events' });
  }
});

// GET /:id/recording/events — retrieve RDP input events for activity bar
router.get('/:id/recording/events', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const canViewAny = userCan(req, 'sessions.view_any');
  const id = req.params.id as string;
  const session = queryOne<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', [id]);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!canViewAny && session.user_id !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const events = queryAll<{ elapsed: number; event_type: string }>(
    'SELECT elapsed, event_type FROM rdp_events WHERE session_id = ? ORDER BY elapsed ASC',
    [id],
  );
  res.json({ events });
});

// GET /:id/commands — list SSH commands logged for a session
router.get('/:id/commands', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const canViewAny = userCan(req, 'sessions.view_any');
  const id = req.params.id as string;

  const session = queryOne<{ user_id: string; protocol: string }>(
    'SELECT user_id, protocol FROM sessions WHERE id = ?',
    [id],
  );
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!canViewAny && session.user_id !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const commands = queryAll<{ id: string; timestamp: string; elapsed: number; command: string; output_preview: string | null }>(
    'SELECT id, timestamp, elapsed, command, output_preview FROM ssh_commands WHERE session_id = ? ORDER BY elapsed ASC',
    [id],
  );
  res.json({ commands });
});

// GET /storage — return total bytes used by all recording files (admin only)
router.get('/storage', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  let totalBytes = 0;
  if (fs.existsSync(config.recordingsDir)) {
    for (const f of fs.readdirSync(config.recordingsDir)) {
      try {
        const stat = fs.statSync(path.join(config.recordingsDir, f));
        if (stat.isFile()) totalBytes += stat.size;
      } catch { /* ignore */ }
    }
  }
  res.json({ bytes: totalBytes });
});

// ─── Automatic recording retention purge ──────────────────────────────────────

export function purgeOldRecordings(): void {
  const daysEnabled = getSetting('session.recording_retention_days_enabled') !== 'false';
  const sizeEnabled = getSetting('session.recording_retention_size_enabled') === 'true';

  if (!daysEnabled && !sizeEnabled) return;

  let totalDeleted = 0;

  // Day-based retention: delete recordings older than N days
  if (daysEnabled) {
    const days = parseInt(getSetting('session.recording_retention_days') ?? '90', 10);
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const expired = queryAll<{ id: string; recording_path: string | null }>(
        'SELECT id, recording_path FROM sessions WHERE recording_path IS NOT NULL AND started_at < ?',
        [cutoff],
      );
      for (const row of expired) {
        if (row.recording_path && fs.existsSync(row.recording_path)) {
          try { fs.unlinkSync(row.recording_path); } catch { /* ignore */ }
        }
      }
      if (expired.length > 0) {
        execute(
          `UPDATE sessions SET recording_path = NULL WHERE recording_path IS NOT NULL AND started_at < ?`,
          [cutoff],
        );
        totalDeleted += expired.length;
      }
    }
  }

  // Size-based retention: if total size exceeds max, delete oldest recordings first (FIFO)
  if (sizeEnabled) {
    const maxGb = parseFloat(getSetting('session.recording_retention_max_size_gb') ?? '10');
    const maxBytes = maxGb * 1024 ** 3;
    if (maxBytes > 0) {
      let currentBytes = 0;
      if (fs.existsSync(config.recordingsDir)) {
        for (const f of fs.readdirSync(config.recordingsDir)) {
          try { currentBytes += fs.statSync(path.join(config.recordingsDir, f)).size; } catch { /* ignore */ }
        }
      }

      if (currentBytes > maxBytes) {
        const rows = queryAll<{ id: string; recording_path: string | null }>(
          'SELECT id, recording_path FROM sessions WHERE recording_path IS NOT NULL ORDER BY started_at ASC',
          [],
        );
        let sizeDeleted = 0;
        for (const row of rows) {
          if (currentBytes - sizeDeleted <= maxBytes) break;
          if (row.recording_path && fs.existsSync(row.recording_path)) {
            try {
              const sz = fs.statSync(row.recording_path).size;
              fs.unlinkSync(row.recording_path);
              sizeDeleted += sz;
              execute('UPDATE sessions SET recording_path = NULL WHERE id = ?', [row.id]);
              totalDeleted++;
            } catch { /* ignore */ }
          }
        }
      }
    }
  }

  if (totalDeleted > 0) {
    logAudit({
      userId: 'system',
      eventType: 'recordings.retention_purged',
      details: {
        deleted: totalDeleted,
        daysEnabled,
        sizeEnabled,
        retentionDays: daysEnabled ? parseInt(getSetting('session.recording_retention_days') ?? '90', 10) : null,
        maxSizeGb: sizeEnabled ? parseFloat(getSetting('session.recording_retention_max_size_gb') ?? '10') : null,
      },
    });
  }
}

// Run purge on startup and then every 6 hours
setTimeout(() => {
  purgeOldRecordings();
  setInterval(() => purgeOldRecordings(), 6 * 60 * 60 * 1000);
}, 5000);

export default router;
