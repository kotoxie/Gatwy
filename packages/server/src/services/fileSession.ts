import { v4 as uuid } from 'uuid';
import type { Request } from 'express';
import { execute, queryOne } from '../db/helpers.js';

export type FileSessionAction = 'browse' | 'download' | 'upload' | 'mkdir' | 'delete' | 'rename' | 'chmod' | 'copy';

export function logFileSessionEvent(params: {
  req: Request;
  userId: string;
  connectionId: string;
  protocol: 'sftp' | 'smb' | 'ftp';
  action: FileSessionAction;
  path: string;
  detail?: Record<string, unknown>;
}): void {
  const sessionId = params.req.headers['x-file-session-id'];
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) return;

  try {
    // Cheap, single-row lookups — INSERT OR IGNORE discards them harmlessly on every
    // call after the session's first (session_id already exists), so this only actually
    // matters once per session, not once per browse/download/upload event.
    const connRow = queryOne<{ name: string }>('SELECT name FROM connections WHERE id = ?', [params.connectionId]);
    const userRow = queryOne<{ username: string }>('SELECT username FROM users WHERE id = ?', [params.userId]);
    execute(
      `INSERT OR IGNORE INTO file_sessions (id, user_id, connection_id, protocol, username, connection_name) VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, params.userId, params.connectionId, params.protocol, userRow?.username ?? null, connRow?.name ?? null],
    );
    // The id comes from a client header, and sessions.view_any holders can list every id. Only the
    // session that created the row may add events to it or move its end time.
    const owner = queryOne<{ user_id: string; connection_id: string; protocol: string }>(
      'SELECT user_id, connection_id, protocol FROM file_sessions WHERE id = ?',
      [sessionId],
    );
    if (!owner || owner.user_id !== params.userId || owner.connection_id !== params.connectionId || owner.protocol !== params.protocol) return;
    execute(
      `UPDATE file_sessions SET ended_at = datetime('now') WHERE id = ?`,
      [sessionId],
    );
    execute(
      `INSERT INTO file_session_events (id, session_id, action, path, detail_json) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), sessionId, params.action, params.path, params.detail ? JSON.stringify(params.detail) : null],
    );
  } catch (err) {
    console.error('[FileSession] Failed to log event:', err);
  }
}
