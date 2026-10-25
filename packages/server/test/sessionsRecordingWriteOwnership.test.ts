import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-recording-write-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'recording-write-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryOne } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { initEncryption } = await import('../src/services/encryption.js');
const { default: sessionsRouter } = await import('../src/routes/sessions.js');
const { default: express } = await import('express');

const OWNER = 'u-rw-owner';
const AUDITOR = 'u-rw-auditor';
const CONN = 'c-rw';
const ORIGINAL = Buffer.from('original recording bytes');

let server: Server;
let baseUrl: string;
let ownerToken: string;
let auditorToken: string;

interface SeedOptions { protocol?: string; endedAt?: string | null; withFile?: boolean }

// Each test gets its own session and recording file, so one test's writes never leak into another's.
// withFile=false leaves recording_path empty, like a recording that has not received its first chunk yet.
function seedSession(id: string, { protocol = 'rdp', endedAt = null, withFile = true }: SeedOptions = {}): string {
  const file = path.join(dataDir, `${id}.${protocol === 'rdp' ? 'webm' : 'cast'}`);
  if (withFile) fs.writeFileSync(file, ORIGINAL);
  execute(
    `INSERT INTO sessions (id, user_id, connection_id, protocol, username, connection_name, recording_path, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, OWNER, CONN, protocol, OWNER, CONN, withFile ? file : null, endedAt],
  );
  return file;
}

const endedAtOf = (id: string) => queryOne<{ ended_at: string | null }>('SELECT ended_at FROM sessions WHERE id = ?', [id])?.ended_at;

before(async () => {
  await initDb();
  initJwt();
  initEncryption();

  // Can read everyone's recordings, but is not an admin: a read permission, not a write one.
  execute(
    `INSERT INTO roles (id, name, description, is_builtin, permissions_json) VALUES (?, ?, ?, 0, ?)`,
    ['auditor', 'Auditor', 'views all recordings', JSON.stringify(['sessions.view_own', 'sessions.view_any'])],
  );
  execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'user')`, [OWNER, OWNER, 'x', OWNER]);
  execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'auditor')`, [AUDITOR, AUDITOR, 'x', AUDITOR]);
  ownerToken = signToken({ userId: OWNER, username: OWNER, role: 'user' });
  auditorToken = signToken({ userId: AUDITOR, username: AUDITOR, role: 'auditor' });

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

const chunk = (token: string, id: string) =>
  fetch(`${baseUrl}/${id}/recording/chunk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('injected'),
  });

const finalize = (token: string, id: string) =>
  fetch(`${baseUrl}/${id}/recording/finalize`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

describe('recording writes are owner-only, view_any stays read-only', () => {
  it('chunk from a view_any role is 403 and the recording file is left untouched', async () => {
    const id = '00000000-0000-4000-8000-0000000000c1';
    const file = seedSession(id);
    assert.equal((await chunk(auditorToken, id)).status, 403);
    assert.deepEqual(fs.readFileSync(file), ORIGINAL);
  });

  it('finalize from a view_any role is 403 and the session is not ended', async () => {
    const id = '00000000-0000-4000-8000-0000000000c2';
    seedSession(id);
    assert.equal((await finalize(auditorToken, id)).status, 403);
    assert.equal(endedAtOf(id), null);
  });

  it('view_any still reads: recording download and activity events are 200', async () => {
    const id = '00000000-0000-4000-8000-0000000000c3';
    seedSession(id);
    const rec = await fetch(`${baseUrl}/${id}/recording`, { headers: { Authorization: `Bearer ${auditorToken}` } });
    assert.equal(rec.status, 200);
    const events = await fetch(`${baseUrl}/${id}/recording/events`, { headers: { Authorization: `Bearer ${auditorToken}` } });
    assert.equal(events.status, 200);
  });

  it('the owner can still write: first chunk creates the file, finalize ends the session', async () => {
    const id = '00000000-0000-4000-8000-0000000000c4';
    seedSession(id, { withFile: false });
    assert.equal((await chunk(ownerToken, id)).status, 200);
    const file = queryOne<{ recording_path: string }>('SELECT recording_path FROM sessions WHERE id = ?', [id])!.recording_path;
    assert.ok(fs.statSync(file).size > 0);
    assert.equal((await chunk(ownerToken, id)).status, 200);
    assert.equal((await finalize(ownerToken, id)).status, 200);
    assert.ok(endedAtOf(id));
  });
});

describe('the owner cannot rewrite a finished or foreign-protocol recording', () => {
  it('chunk after the session ended is 409 and the recording is left untouched', async () => {
    const id = '00000000-0000-4000-8000-0000000000d1';
    const file = seedSession(id, { endedAt: '2026-01-01 00:00:00' });
    assert.equal((await chunk(ownerToken, id)).status, 409);
    assert.deepEqual(fs.readFileSync(file), ORIGINAL);
  });

  it('chunk on an SSH or Telnet session is 400 and its .cast is left untouched', async () => {
    const id = '00000000-0000-4000-8000-0000000000d2';
    const file = seedSession(id, { protocol: 'ssh' });
    assert.equal((await chunk(ownerToken, id)).status, 400);
    assert.deepEqual(fs.readFileSync(file), ORIGINAL);
  });

  it('finalize on an SSH or Telnet session is 400: it is not ended and the .cast is not re-encrypted', async () => {
    const id = '00000000-0000-4000-8000-0000000000d3';
    const file = seedSession(id, { protocol: 'telnet' });
    assert.equal((await finalize(ownerToken, id)).status, 400);
    assert.equal(endedAtOf(id), null);
    assert.deepEqual(fs.readFileSync(file), ORIGINAL);
  });

  it('finalize twice keeps the first end time', async () => {
    const id = '00000000-0000-4000-8000-0000000000d4';
    seedSession(id, { endedAt: '2026-01-01 00:00:00', withFile: false });
    assert.equal((await finalize(ownerToken, id)).status, 200);
    assert.equal(endedAtOf(id), '2026-01-01 00:00:00');
  });

  it('a chunk for a live session whose writer was lost (restart) fails instead of truncating the file', async () => {
    const id = '00000000-0000-4000-8000-0000000000d5';
    const file = seedSession(id);
    assert.equal((await chunk(ownerToken, id)).status, 500);
    assert.deepEqual(fs.readFileSync(file), ORIGINAL);
  });
});
