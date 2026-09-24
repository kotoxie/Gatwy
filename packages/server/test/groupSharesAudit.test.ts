import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-groupsharesaudit-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'group-shares-audit-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryOne } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { default: connectionsRouter } = await import('../src/routes/connections.js');
const { default: express } = await import('express');

let server: Server;
let baseUrl: string;
let ownerToken: string;
const ownerId = 'user-audit-owner';
const recipientId = 'user-audit-recipient';
const groupId = 'g-audit-capability';

before(async () => {
  await initDb();
  initJwt();

  execute(
    `INSERT INTO roles (id, name, description, is_builtin, permissions_json) VALUES (?, ?, ?, 0, ?)`,
    ['owner-share', 'Owner Share', 'can share folders', JSON.stringify([
      'connections.create', 'connections.edit_own', 'connections.share',
    ])],
  );
  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    [ownerId, 'audit-owner', 'x', 'Audit Owner', 'owner-share'],
  );
  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    [recipientId, 'audit-recipient', 'x', 'Audit Recipient', 'owner-share'],
  );
  ownerToken = signToken({ userId: ownerId, username: 'audit-owner', role: 'owner-share' });

  execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', [groupId, ownerId, 'Audit Group']);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/connections', connectionsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1/connections`;
});

after(() => new Promise<void>((resolve) => server.close(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  resolve();
})));

function authedFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

describe('PUT /groups/:id/shares — audit log captures capability explicitly', () => {
  it('records capability="edit" in the group.shares_updated audit details, typed not accidental', async () => {
    const res = await authedFetch(ownerToken, `${baseUrl}/groups/${groupId}/shares`, {
      method: 'PUT',
      body: JSON.stringify({ shares: [{ shareType: 'user', targetId: recipientId, capability: 'edit' }] }),
    });
    assert.equal(res.status, 200);

    const row = queryOne<{ details_json: string }>(
      `SELECT details_json FROM audit_log WHERE event_type = 'group.shares_updated' ORDER BY rowid DESC LIMIT 1`,
    );
    assert.ok(row, 'group.shares_updated event was logged');
    const details = JSON.parse(row!.details_json) as {
      after: { shareType: string; targetId: string; capability?: string }[];
    };
    const entry = details.after.find((e) => e.targetId === recipientId);
    assert.ok(entry, 'recipient entry present in after[]');
    assert.equal(entry?.capability, 'edit');
  });
});
