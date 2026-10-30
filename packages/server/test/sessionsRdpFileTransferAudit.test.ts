import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-rdp-file-transfer-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'rdp-file-transfer-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryAll } = await import('../src/db/helpers.js');
const { getPermissionsForRole } = await import('../src/services/permissions.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { default: sessionsRouter } = await import('../src/routes/sessions.js');
const { addActiveSession, listActiveSessions, removeActiveSession } = await import('../src/ws/activeSessions.js');
const { default: express } = await import('express');

let server: Server;
let baseUrl: string;
let aliceToken: string;
let noRdpToken: string;

before(async () => {
  await initDb();
  initJwt();

  for (const [id, role] of [['u-alice', 'user'], ['u-bob', 'user']] as const) {
    execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`, [id, id, 'x', id, role]);
  }
  aliceToken = signToken({ userId: 'u-alice', username: 'u-alice', role: 'user' });
  // A role that may use connections but not the RDP protocol: the proxy would refuse it, so must this route.
  execute(`INSERT INTO roles (id, name, description, is_builtin, permissions_json) VALUES ('no-rdp', 'No RDP', '', 0, ?)`,
    [JSON.stringify(getPermissionsForRole('user').filter((p: string) => p !== 'protocols.rdp'))]);
  execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`, ['u-nordp', 'u-nordp', 'x', 'u-nordp', 'no-rdp']);
  noRdpToken = signToken({ userId: 'u-nordp', username: 'u-nordp', role: 'no-rdp' });

  const conn = (id: string, owner: string, protocol: string, host: string, port: number) =>
    execute(`INSERT INTO connections (id, user_id, name, protocol, host, port) VALUES (?, ?, ?, ?, ?, ?)`, [id, owner, id, protocol, host, port]);
  conn('c-alice-rdp', 'u-alice', 'rdp', 'win-host.lan', 3389);
  conn('c-alice-rdp-2', 'u-alice', 'rdp', 'win-host-2.lan', 3389);
  conn('c-alice-ssh', 'u-alice', 'ssh', 'win-host.lan', 22);
  conn('c-bob-private', 'u-bob', 'rdp', 'private-host', 3389); // Alice cannot open this one
  conn('c-bob-shared-user', 'u-bob', 'rdp', 'shared-user-host', 3389);
  execute(`INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES ('rs-1', 'connection', 'c-bob-shared-user', 'user', 'u-alice', 'view')`);
  conn('c-nordp', 'u-nordp', 'rdp', 'win-host.lan', 3389);

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

afterEach(() => {
  for (const s of listActiveSessions()) removeActiveSession(s.id);
  execute(`DELETE FROM audit_log WHERE event_type LIKE 'session.rdp.file_%'`);
});

const post = (body: unknown, token: string | null = aliceToken) =>
  fetch(`${baseUrl}/rdp-file-transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

function session(id: string, userId: string, connectionId: string, protocol: 'rdp' | 'ssh' = 'rdp') {
  addActiveSession({ id, userId, connectionId, connectionName: connectionId, protocol, end: () => {} });
}

const valid = { connectionId: 'c-alice-rdp', fileName: 'report.pdf', fileSize: 1234, direction: 'upload' };

const auditRows = () => queryAll<{ user_id: string; event_type: string; target: string; details_json: string }>(
  `SELECT user_id, event_type, target, details_json FROM audit_log WHERE event_type LIKE 'session.rdp.file_%'`,
);

describe('POST /rdp-file-transfer', () => {
  it('is refused with 401 without a login', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    assert.equal((await post(valid, null)).status, 401);
    assert.equal(auditRows().length, 0);
  });

  it('is refused with 403 for a role that may not use RDP, like the proxy', async () => {
    session('s1', 'u-nordp', 'c-nordp');
    assert.equal((await post({ ...valid, connectionId: 'c-nordp' }, noRdpToken)).status, 403);
    assert.equal(auditRows().length, 0);
  });

  it('logs a valid event with the caller as user, and the ip and size it was given', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    const res = await post(valid);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const rows = auditRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'u-alice');
    assert.equal(rows[0].event_type, 'session.rdp.file_upload');
    assert.equal(rows[0].target, 'c-alice-rdp');
    assert.deepEqual(JSON.parse(rows[0].details_json), { fileName: 'report.pdf', fileSize: 1234, direction: 'upload' });
  });

  it('logs a download as file_download', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    assert.equal((await post({ ...valid, direction: 'download' })).status, 200);
    assert.equal(auditRows()[0].event_type, 'session.rdp.file_download');
  });

  it('rejects a direction other than upload or download, so no free-form event type is written', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    for (const direction of ['x/../y', 'UPLOAD', '', 'upload ', 1, null, ['upload'], { a: 1 }]) {
      assert.equal((await post({ ...valid, direction })).status, 400, `direction ${JSON.stringify(direction)}`);
    }
    assert.equal(auditRows().length, 0);
  });

  it('rejects a missing or non-string connectionId and fileName', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    for (const patch of [
      { connectionId: undefined }, { connectionId: '' }, { connectionId: 5 }, { connectionId: ['c-alice-rdp'] },
      { fileName: undefined }, { fileName: '' }, { fileName: 5 }, { fileName: { a: 1 } },
    ]) {
      assert.equal((await post({ ...valid, ...patch })).status, 400, JSON.stringify(patch));
    }
    assert.equal(auditRows().length, 0);
  });

  it('answers 404 for a connection the caller cannot open, even if a session exists on it', async () => {
    session('s1', 'u-alice', 'c-bob-private'); // a planted registry entry must not make the check pass
    assert.equal((await post({ ...valid, connectionId: 'c-bob-private' })).status, 404);
    assert.equal((await post({ ...valid, connectionId: 'does-not-exist' })).status, 404);
    assert.equal(auditRows().length, 0);
  });

  it('answers 404 for a connection that is not RDP', async () => {
    session('s1', 'u-alice', 'c-alice-ssh', 'ssh');
    assert.equal((await post({ ...valid, connectionId: 'c-alice-ssh' })).status, 404);
    assert.equal(auditRows().length, 0);
  });

  it('is refused with 403 when the caller has no live session at all', async () => {
    assert.equal((await post(valid)).status, 403);
    assert.equal(auditRows().length, 0);
  });

  it('is refused with 403 when the live session belongs to another user, to another connection or to another protocol', async () => {
    session('s-bob', 'u-bob', 'c-alice-rdp');
    session('s-other-conn', 'u-alice', 'c-alice-rdp-2');
    session('s-ssh', 'u-alice', 'c-alice-rdp', 'ssh');
    assert.equal((await post(valid)).status, 403);
    assert.equal(auditRows().length, 0);
  });

  it('works for a connection shared with the caller, with a live session on it', async () => {
    session('s1', 'u-alice', 'c-bob-shared-user');
    assert.equal((await post({ ...valid, connectionId: 'c-bob-shared-user' })).status, 200);
    assert.equal(auditRows()[0].target, 'c-bob-shared-user');
  });

  it('is refused again once the session has ended', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    assert.equal((await post(valid)).status, 200);
    removeActiveSession('s1');
    assert.equal((await post(valid)).status, 403);
    assert.equal(auditRows().length, 1);
  });

  it('truncates a long fileName to 255 characters', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    assert.equal((await post({ ...valid, fileName: 'a'.repeat(5000) })).status, 200);
    assert.equal(JSON.parse(auditRows()[0].details_json).fileName.length, 255);
  });

  it('stores 0 for a fileSize that is not a finite non-negative number', async () => {
    session('s1', 'u-alice', 'c-alice-rdp');
    for (const fileSize of [undefined, '12', -1, null, { a: 1 }]) {
      assert.equal((await post({ ...valid, fileSize })).status, 200);
    }
    const sizes = auditRows().map((r) => JSON.parse(r.details_json).fileSize);
    assert.deepEqual(sizes, [0, 0, 0, 0, 0]);
  });
});
