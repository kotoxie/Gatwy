import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-sessions-disconnect-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'sessions-disconnect-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryAll } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { default: sessionsRouter } = await import('../src/routes/sessions.js');
const { addActiveSession, listActiveSessions, removeActiveSession } = await import('../src/ws/activeSessions.js');
const { default: express } = await import('express');

let server: Server;
let baseUrl: string;
let adminToken: string;
let userToken: string;

before(async () => {
  await initDb();
  initJwt();

  execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    ['u-dc-admin', 'dc-admin', 'x', 'Admin', 'admin']);
  execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    ['u-dc-user', 'dc-user', 'x', 'User', 'user']);
  adminToken = signToken({ userId: 'u-dc-admin', username: 'dc-admin', role: 'admin' });
  userToken = signToken({ userId: 'u-dc-user', username: 'dc-user', role: 'user' });

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

const call = (token: string, url: string, method = 'GET') =>
  fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });

function register(id: string, end: () => void) {
  addActiveSession({ id, userId: 'u-dc-user', connectionId: 'c-dc', connectionName: 'Core switch', protocol: 'ssh', end });
}

describe('POST /active/:id/disconnect', () => {
  it('is refused with 401 without a login, and the session is left alone', async () => {
    let ended = 0;
    register('s-anon', () => { ended++; });
    const res = await fetch(`${baseUrl}/active/s-anon/disconnect`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(ended, 0);
    assert.ok(listActiveSessions().some((s) => s.id === 's-anon'));
    removeActiveSession('s-anon');
  });

  it('is refused with 403 for a role without sessions.disconnect, and the session is left alone', async () => {
    let ended = 0;
    register('s-forbidden', () => { ended++; });
    const res = await call(userToken, `${baseUrl}/active/s-forbidden/disconnect`, 'POST');
    assert.equal(res.status, 403);
    assert.equal(ended, 0);
    assert.ok(listActiveSessions().some((s) => s.id === 's-forbidden'));
    removeActiveSession('s-forbidden');
  });

  it('answers 404 for a session that is not registered', async () => {
    const res = await call(adminToken, `${baseUrl}/active/does-not-exist/disconnect`, 'POST');
    assert.equal(res.status, 404);
  });

  it('ends the session once, audits who did it and to whom, and then answers 404', async () => {
    let ended = 0;
    register('s-ok', () => { ended++; });
    const res = await call(adminToken, `${baseUrl}/active/s-ok/disconnect`, 'POST');
    assert.equal(res.status, 200);
    assert.equal(ended, 1, 'end() runs exactly once');
    assert.ok(!listActiveSessions().some((s) => s.id === 's-ok'), 'the entry leaves the registry');

    const rows = queryAll<{ user_id: string; target: string; details_json: string }>(
      `SELECT user_id, target, details_json FROM audit_log WHERE event_type = 'session.disconnect.forced'`, []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'u-dc-admin', 'the audit event is attributed to the administrator');
    assert.equal(rows[0].target, 'Core switch');
    const details = JSON.parse(rows[0].details_json) as Record<string, unknown>;
    assert.equal(details.sessionId, 's-ok');
    assert.equal(details.targetUserId, 'u-dc-user', 'and names the user whose session was ended');
    assert.equal(details.protocol, 'ssh');

    const again = await call(adminToken, `${baseUrl}/active/s-ok/disconnect`, 'POST');
    assert.equal(again.status, 404);
    assert.equal(ended, 1);
  });

  it('still ends the session and answers 200 when end() throws', async () => {
    register('s-throws', () => { throw new Error('socket already gone'); });
    const res = await call(adminToken, `${baseUrl}/active/s-throws/disconnect`, 'POST');
    assert.equal(res.status, 200);
    assert.ok(!listActiveSessions().some((s) => s.id === 's-throws'));
  });
});

describe('GET /active', () => {
  it('does not expose the end callback or any internal field', async () => {
    register('s-list', () => {});
    const res = await call(adminToken, `${baseUrl}/active`);
    assert.equal(res.status, 200);
    const body = await res.json() as { sessions: Array<Record<string, unknown>> };
    const row = body.sessions.find((s) => s.id === 's-list')!;
    assert.deepEqual(Object.keys(row).sort(),
      ['connectionName', 'durationMs', 'id', 'protocol', 'startedAt', 'status', 'userId', 'username']);
    removeActiveSession('s-list');
  });
});
