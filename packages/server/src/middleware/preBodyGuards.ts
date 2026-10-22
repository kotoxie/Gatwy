import type { Request, Response, NextFunction } from 'express';
import { queryOne } from '../db/helpers.js';
import { connectionAccessWhere } from '../services/permissions.js';

// Guards for routes that buffer a raw body (express.raw). They run after authRequired and
// BEFORE the parser, so a caller without access to the target never gets its body buffered.
// The handlers keep their own checks; these only gate the buffering.

/** 404 unless the user can access an existing connection of one of `protocols`. */
export function connectionAccessGuard(...protocols: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const access = connectionAccessWhere('connections', req.user!.userId, req.user!.role);
    const marks = protocols.map(() => '?').join(', ');
    const row = queryOne(
      `SELECT 1 FROM connections WHERE id = ? AND ${access.where} AND protocol IN (${marks})`,
      [req.params.connectionId, ...access.params, ...protocols],
    );
    if (!row) { res.status(404).json({ error: 'Connection not found' }); return; }
    next();
  };
}

/** Same session id format + ownership rules as the recording/chunk handler. */
export function recordingSessionGuard(req: Request, res: Response, next: NextFunction): void {
  const id = req.params.id as string;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    res.status(400).json({ error: 'Invalid session id' }); return;
  }
  const session = queryOne<{ user_id: string; protocol: string; ended_at: string | null }>(
    'SELECT user_id, protocol, ended_at FROM sessions WHERE id = ?',
    [id],
  );
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  // Owner only: sessions.view_any is a read permission and must not let anyone write into another user's recording.
  if (session.user_id !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  if (session.protocol !== 'rdp') { res.status(400).json({ error: 'Not an RDP session' }); return; }
  if (session.ended_at) { res.status(409).json({ error: 'Session already ended' }); return; }
  next();
}
