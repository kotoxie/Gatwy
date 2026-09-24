import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-groupcapchanged-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'group-capability-changed-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryOne } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { default: connectionsRouter } = await import('../src/routes/connections.js');
const { default: express } = await import('express');

let server: Server;
let baseUrl: string;
let ownerToken: string;
const ownerId = 'user-capchanged-owner';
const recipientId = 'user-capchanged-recipient';
const groupId = 'g-capability-changed';

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
    [ownerId, 'capchanged-owner', 'x', 'Capchanged Owner', 'owner-share'],
  );
  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    [recipientId, 'capchanged-recipient', 'x', 'Capchanged Recipient', 'owner-share'],
  );
  ownerToken = signToken({ userId: ownerId, username: 'capchanged-owner', role: 'owner-share' });

  execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', [groupId, ownerId, 'Capability Changed Group']);

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

function capabilityChangedCount(): number {
  const row = queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM audit_log WHERE event_type = 'group.share_capability_changed'`);
  return row?.c ?? 0;
}

describe('PUT /groups/:id/shares — group.share_capability_changed emitted only on a real capability change', () => {
  it('does NOT emit the event when a target is newly added', async () => {
    const before_ = capabilityChangedCount();
    const res = await authedFetch(ownerToken, `${baseUrl}/groups/${groupId}/shares`, {
      method: 'PUT',
      body: JSON.stringify({ shares: [{ shareType: 'user', targetId: recipientId, capability: 'view' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(capabilityChangedCount(), before_, 'adding a new recipient must not emit a capability-changed event');
  });

  it('DOES emit the event when an existing recipient\'s capability actually changes', async () => {
    const before_ = capabilityChangedCount();
    const res = await authedFetch(ownerToken, `${baseUrl}/groups/${groupId}/shares`, {
      method: 'PUT',
      body: JSON.stringify({ shares: [{ shareType: 'user', targetId: recipientId, capability: 'edit' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(capabilityChangedCount(), before_ + 1, 'view -> edit on the same recipient must emit exactly one capability-changed event');

    const row = queryOne<{ details_json: string }>(
      `SELECT details_json FROM audit_log WHERE event_type = 'group.share_capability_changed' ORDER BY rowid DESC LIMIT 1`,
    );
    const details = JSON.parse(row!.details_json) as {
      before: { targetId: string; capability?: string }[];
      after: { targetId: string; capability?: string }[];
    };
    assert.equal(details.before.length, 1);
    assert.equal(details.after.length, 1);
    assert.equal(details.before[0]?.targetId, recipientId);
    assert.equal(details.before[0]?.capability, 'view');
    assert.equal(details.after[0]?.targetId, recipientId);
    assert.equal(details.after[0]?.capability, 'edit');
  });

  it('does NOT emit the event on pure removal', async () => {
    const before_ = capabilityChangedCount();
    const res = await authedFetch(ownerToken, `${baseUrl}/groups/${groupId}/shares`, {
      method: 'PUT',
      body: JSON.stringify({ shares: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(capabilityChangedCount(), before_, 'removing the only recipient must not emit a capability-changed event');
  });

  // Regression guard: a naive implementation that logs the FULL shares_updated snapshot
  // under the new eventType (instead of diffing it) would pass every test above, since
  // each one so far only ever has a single recipient. This mixes all four cases in one
  // save — changed, unchanged, added, removed — plus a user and a role sharing the same
  // targetId, to prove the diff is keyed on shareType+targetId and not targetId alone.
  describe('mixed save — only the actually-changed entry is reported, everything else is excluded', () => {
    const mixedGroupId = 'g-capability-changed-mixed';
    const collidingId = 'collide-user-and-role';
    const yId = 'user-capchanged-unchanged';
    const wId = 'user-capchanged-removed';
    const zId = 'user-capchanged-added';

    before(async () => {
      execute(
        `INSERT INTO roles (id, name, description, is_builtin, permissions_json) VALUES (?, ?, ?, 0, '[]')`,
        [collidingId, 'Colliding Role', 'role id intentionally equal to a user id in this scenario'],
      );
      for (const [id, username] of [[collidingId, 'colliding-user'], [yId, 'unchanged-user'], [wId, 'removed-user'], [zId, 'added-user']]) {
        execute(
          `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
          [id, username, 'x', username, 'owner-share'],
        );
      }
      execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', [mixedGroupId, ownerId, 'Mixed Group']);

      // Baseline (pure add, establishes the "before" state for the mixed save below):
      // user:collidingId=view, role:collidingId=view, user:yId=view, user:wId=view.
      const baseline = await authedFetch(ownerToken, `${baseUrl}/groups/${mixedGroupId}/shares`, {
        method: 'PUT',
        body: JSON.stringify({
          shares: [
            { shareType: 'user', targetId: collidingId, capability: 'view' },
            { shareType: 'role', targetId: collidingId, capability: 'view' },
            { shareType: 'user', targetId: yId, capability: 'view' },
            { shareType: 'user', targetId: wId, capability: 'view' },
          ],
        }),
      });
      assert.equal(baseline.status, 200);
    });

    it('reports only the one entry whose capability actually changed', async () => {
      const before_ = capabilityChangedCount();
      const res = await authedFetch(ownerToken, `${baseUrl}/groups/${mixedGroupId}/shares`, {
        method: 'PUT',
        body: JSON.stringify({
          shares: [
            { shareType: 'user', targetId: collidingId, capability: 'edit' }, // changed: view -> edit
            { shareType: 'role', targetId: collidingId, capability: 'view' }, // same targetId, different shareType, unchanged
            { shareType: 'user', targetId: yId, capability: 'view' },        // unchanged
            { shareType: 'user', targetId: zId, capability: 'view' },        // newly added
            // wId omitted -> removed
          ],
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(capabilityChangedCount(), before_ + 1, 'exactly one capability-changed event for one real change');

      const capRow = queryOne<{ details_json: string }>(
        `SELECT details_json FROM audit_log WHERE event_type = 'group.share_capability_changed' ORDER BY rowid DESC LIMIT 1`,
      );
      const capDetails = JSON.parse(capRow!.details_json) as {
        before: { shareType: string; targetId: string; capability?: string }[];
        after: { shareType: string; targetId: string; capability?: string }[];
      };
      assert.equal(capDetails.before.length, 1, 'before[] must contain only the changed entry, not the full snapshot');
      assert.equal(capDetails.after.length, 1, 'after[] must contain only the changed entry, not the full snapshot');
      assert.equal(capDetails.before[0]?.shareType, 'user');
      assert.equal(capDetails.before[0]?.targetId, collidingId);
      assert.equal(capDetails.before[0]?.capability, 'view');
      assert.equal(capDetails.after[0]?.shareType, 'user');
      assert.equal(capDetails.after[0]?.targetId, collidingId);
      assert.equal(capDetails.after[0]?.capability, 'edit');

      // group.shares_updated (unchanged behavior) still carries the FULL before/after snapshot.
      const fullRow = queryOne<{ details_json: string }>(
        `SELECT details_json FROM audit_log WHERE event_type = 'group.shares_updated' AND target = 'Mixed Group' ORDER BY rowid DESC LIMIT 1`,
      );
      const fullDetails = JSON.parse(fullRow!.details_json) as {
        before: { shareType: string; targetId: string }[];
        after: { shareType: string; targetId: string }[];
      };
      assert.equal(fullDetails.before.length, 4, 'full snapshot before: collidingId(user+role), yId, wId');
      assert.equal(fullDetails.after.length, 4, 'full snapshot after: collidingId(user+role), yId, zId');
      assert.ok(fullDetails.after.some((e) => e.shareType === 'user' && e.targetId === zId), 'newly added recipient present in the full snapshot');
      assert.ok(!fullDetails.after.some((e) => e.shareType === 'user' && e.targetId === wId), 'removed recipient absent from the full snapshot');
    });
  });
});
