import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from 'express';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-filesession-owner-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'file-session-owner-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryAll, queryOne } = await import('../src/db/helpers.js');
const { logFileSessionEvent } = await import('../src/services/fileSession.js');

const ALICE = 'u-fso-alice';
const BOB = 'u-fso-bob';
const CONN_A = 'c-fso-a';
const CONN_B = 'c-fso-b';
const OLD = '2000-01-01 00:00:00';

before(async () => {
  await initDb();
  for (const id of [ALICE, BOB]) {
    execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'user')`, [id, id, 'x', id]);
  }
  for (const id of [CONN_A, CONN_B]) {
    execute(
      `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port, shared) VALUES (?, ?, NULL, ?, 'sftp', 'h', 22, 1)`,
      [id, ALICE, id],
    );
  }
});

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const log = (sessionId: string, userId: string, connectionId: string, protocol: 'sftp' | 'smb' | 'ftp' = 'sftp', p = '/x') =>
  logFileSessionEvent({
    req: { headers: { 'x-file-session-id': sessionId } } as unknown as Request,
    userId, connectionId, protocol, action: 'browse', path: p,
  });

const events = (sessionId: string) =>
  queryAll<{ path: string }>('SELECT path FROM file_session_events WHERE session_id = ? ORDER BY path', [sessionId]).map((e) => e.path);
const endedAt = (sessionId: string) =>
  queryOne<{ ended_at: string | null }>('SELECT ended_at FROM file_sessions WHERE id = ?', [sessionId])?.ended_at;

describe('file session events can only be logged by the session that owns the id', () => {
  it('the owner creates the session and keeps logging into it', () => {
    const id = 'fso-owner';
    log(id, ALICE, CONN_A, 'sftp', '/a');
    execute('UPDATE file_sessions SET ended_at = ? WHERE id = ?', [OLD, id]);
    log(id, ALICE, CONN_A, 'sftp', '/b');
    assert.deepEqual(events(id), ['/a', '/b']);
    assert.notEqual(endedAt(id), OLD);
  });

  it('another user with the same id adds no event and does not move ended_at', () => {
    const id = 'fso-foreign-user';
    log(id, ALICE, CONN_A, 'sftp', '/a');
    execute('UPDATE file_sessions SET ended_at = ? WHERE id = ?', [OLD, id]);
    log(id, BOB, CONN_A, 'sftp', '/forged');
    assert.deepEqual(events(id), ['/a']);
    assert.equal(endedAt(id), OLD);
  });

  it('the same user on another connection adds no event', () => {
    const id = 'fso-foreign-conn';
    log(id, ALICE, CONN_A, 'sftp', '/a');
    log(id, ALICE, CONN_B, 'sftp', '/forged');
    assert.deepEqual(events(id), ['/a']);
  });

  it('the same user with another protocol (a database session id) adds no event', () => {
    const id = 'fso-db-session';
    execute(`INSERT INTO file_sessions (id, user_id, connection_id, protocol) VALUES (?, ?, ?, 'postgres')`, [id, ALICE, CONN_A]);
    log(id, ALICE, CONN_A, 'sftp', '/forged');
    assert.deepEqual(events(id), []);
  });
});
