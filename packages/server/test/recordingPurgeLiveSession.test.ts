import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-recording-purge-live-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'recording-purge-live-session-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryOne } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { initEncryption } = await import('../src/services/encryption.js');
const { default: sessionsRouter, purgeOldRecordings } = await import('../src/routes/sessions.js');
const { default: express } = await import('express');

const recordingsDir = path.join(dataDir, 'recordings');
const userId = 'user-recording-purge-live';
const connectionId = 'conn-recording-purge-live';
const OLD = '2020-01-01T00:00:00.000Z';
const OLD_ENDED = '2020-01-01 01:00:00';

let server: Server;
let baseUrl: string;
let ownerToken: string;

before(async () => {
  await initDb();
  initJwt();
  initEncryption();
  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    [userId, 'recording-purge-live', 'x', 'Recording Purge Live', 'user'],
  );
  ownerToken = signToken({ userId, username: 'recording-purge-live', role: 'user' });
  execute(
    `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port, recording_enabled)
     VALUES (?, ?, NULL, ?, 'ssh', 'h', 22, 1)`,
    [connectionId, userId, 'Purge Connection'],
  );
  fs.mkdirSync(recordingsDir, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/sessions', sessionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1/sessions`;
});

after(() => new Promise<void>((resolve) => server.close(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  resolve();
})));

beforeEach(() => {
  execute('DELETE FROM sessions');
  for (const f of fs.readdirSync(recordingsDir)) fs.rmSync(path.join(recordingsDir, f));
  execute(`UPDATE settings SET value = 'true' WHERE key = 'session.recording_retention_days_enabled'`);
  execute(`UPDATE settings SET value = '30' WHERE key = 'session.recording_retention_days'`);
  execute(`UPDATE settings SET value = 'false' WHERE key = 'session.recording_retention_size_enabled'`);
});

function addSession(id: string, ended: boolean, bytes = 4096): string {
  const file = path.join(recordingsDir, `${id}.cast`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  execute(
    `INSERT INTO sessions (id, user_id, connection_id, protocol, username, connection_name, started_at, ended_at, recording_path)
     VALUES (?, ?, ?, 'ssh', 'u', 'c', ?, ?, ?)`,
    [id, userId, connectionId, OLD, ended ? OLD_ENDED : null, file],
  );
  return file;
}

function recordingPath(id: string): string | null {
  return queryOne<{ recording_path: string | null }>('SELECT recording_path FROM sessions WHERE id = ?', [id])!.recording_path;
}

describe('retention purge and live sessions', () => {
  it('age based purge deletes the file of an ended session', () => {
    const file = addSession('ended-old', true);
    purgeOldRecordings();
    assert.equal(fs.existsSync(file), false);
    assert.equal(recordingPath('ended-old'), null);
  });

  it('age based purge leaves the recording of a live session alone', () => {
    const file = addSession('live-old', false);
    purgeOldRecordings();
    assert.equal(fs.existsSync(file), true, 'file of a live session must survive');
    assert.equal(recordingPath('live-old'), file, 'recording_path of a live session must be kept');
  });

  it('size based purge skips live sessions and removes ended ones', () => {
    execute(`UPDATE settings SET value = 'false' WHERE key = 'session.recording_retention_days_enabled'`);
    execute(`UPDATE settings SET value = 'true' WHERE key = 'session.recording_retention_size_enabled'`);
    // 0.000001 GB is about 1 KB, so any file here is over the cap
    execute(`UPDATE settings SET value = '0.000001' WHERE key = 'session.recording_retention_max_size_gb'`);
    const live = addSession('live-size', false);
    const ended = addSession('ended-size', true);
    purgeOldRecordings();
    assert.equal(fs.existsSync(live), true, 'file of a live session must survive');
    assert.equal(recordingPath('live-size'), live);
    assert.equal(fs.existsSync(ended), false);
    assert.equal(recordingPath('ended-size'), null);
  });
});

describe('a live RDP recording survives the purge', () => {
  const id = '00000000-0000-4000-8000-0000000000e1';
  const auth = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/octet-stream' };
  const post = (suffix: string, body?: string) =>
    fetch(`${baseUrl}/${id}/recording/${suffix}`, { method: 'POST', headers: { ...auth, Authorization: `Bearer ${ownerToken}` }, body });

  it('chunks written after a purge run still produce a readable recording', async () => {
    // Old live session, like an RDP tab left open past the retention window
    execute(
      `INSERT INTO sessions (id, user_id, connection_id, protocol, username, connection_name, started_at)
       VALUES (?, ?, ?, 'rdp', 'u', 'c', ?)`,
      [id, userId, connectionId, OLD],
    );
    assert.equal((await post('chunk', 'first-')).status, 200);
    purgeOldRecordings();
    assert.equal((await post('chunk', 'second')).status, 200);
    assert.equal((await post('finalize')).status, 200);

    const res = await fetch(`${baseUrl}/${id}/recording`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'first-second');
  });
});
