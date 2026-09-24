import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-treeownername-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'tree-owner-name-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryOne } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { default: connectionsRouter } = await import('../src/routes/connections.js');
const { default: express } = await import('express');

let server: Server;
let baseUrl: string;
let ownerToken: string;
let recipientToken: string;
const ownerId = 'user-tree-owner';
const recipientId = 'user-tree-recipient';
const rootGroupId = 'g-tree-owner-root';
const subGroupId = 'g-tree-owner-sub';

before(async () => {
  await initDb();
  initJwt();

  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    [ownerId, 'tree-owner', 'x', 'Owner Display Name', 'user'],
  );
  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    [recipientId, 'tree-recipient', 'x', 'Recipient Display Name', 'user'],
  );
  ownerToken = signToken({ userId: ownerId, username: 'tree-owner', role: 'user' });
  recipientToken = signToken({ userId: recipientId, username: 'tree-recipient', role: 'user' });

  execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', [rootGroupId, ownerId, 'Root']);
  execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)', [subGroupId, ownerId, 'Sub', rootGroupId]);
  // Only the root carries a share — the recipient reaches the sub-folder through it.
  execute(
    `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, 'user', ?, 'view')`,
    ['share-tree-root-to-recipient', rootGroupId, recipientId],
  );

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

interface GroupNode {
  id: string;
  name: string;
  children: GroupNode[];
  ownerName?: string;
}

function findNode(nodes: GroupNode[], id: string): GroupNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return undefined;
}

describe('GET / — ownerName on the shared-folder tree, recipient-only', () => {
  it('sets ownerName on every node of the shared branch, root and sub-folder alike', async () => {
    const res = await authedFetch(recipientToken, baseUrl);
    assert.equal(res.status, 200);
    const body = await res.json() as { sharedGroups: GroupNode[] };

    const root = findNode(body.sharedGroups, rootGroupId);
    assert.ok(root, 'shared root present in sharedGroups');
    assert.equal(root?.ownerName, 'Owner Display Name');

    const sub = findNode(body.sharedGroups, subGroupId);
    assert.ok(sub, 'sub-folder present, reached through the shared root');
    assert.equal(sub?.ownerName, 'Owner Display Name', 'sub-folder must carry ownerName too, not just the root');
  });

  it('never sets ownerName on the owner\'s own tree', async () => {
    const res = await authedFetch(ownerToken, baseUrl);
    assert.equal(res.status, 200);
    const body = await res.json() as { groups: GroupNode[] };

    const root = findNode(body.groups, rootGroupId);
    assert.ok(root, 'owner sees the root in their own groups');
    assert.equal(root?.ownerName, undefined, 'owner must never see ownerName on their own folder');

    const sub = findNode(body.groups, subGroupId);
    assert.ok(sub, 'owner sees the sub-folder too');
    assert.equal(sub?.ownerName, undefined);
  });
});

describe('GET / — LEFT JOIN keeps a shared folder in the tree when its owner row is gone', () => {
  // Simulates data left behind from before the resource_shares cleanup added in the prior
  // commit: the owner row is gone but the group and its share survive (no FK cascade
  // actually fires in this app — see routes/users.ts). Deletes the user directly with raw
  // SQL, bypassing DELETE /api/v1/users/:id, specifically to recreate that pre-cleanup state
  // rather than exercise the route's own cleanup.
  const goneOwnerId = 'user-tree-owner-gone';
  const recipientId2 = 'user-tree-recipient-of-gone-owner';
  const groupId = 'g-tree-owner-gone-group';
  let recipientToken2: string;

  before(async () => {
    execute(
      `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
      [goneOwnerId, 'tree-owner-gone', 'x', 'Soon Gone', 'user'],
    );
    execute(
      `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
      [recipientId2, 'tree-recipient-of-gone', 'x', 'Recipient Of Gone Owner', 'user'],
    );
    recipientToken2 = signToken({ userId: recipientId2, username: 'tree-recipient-of-gone', role: 'user' });

    execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', [groupId, goneOwnerId, 'Group of a gone owner']);
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, 'user', ?, 'view')`,
      ['share-tree-gone-owner-to-recipient', groupId, recipientId2],
    );

    execute('DELETE FROM users WHERE id = ?', [goneOwnerId]);
  });

  it('keeps the folder in the tree iff its row still exists, with ownerName undefined when the owner is gone', async () => {
    const res = await authedFetch(recipientToken2, baseUrl);
    assert.equal(res.status, 200);
    const body = await res.json() as { sharedGroups: GroupNode[] };

    const groupRow = queryOne('SELECT id FROM connection_groups WHERE id = ?', [groupId]);
    const node = findNode(body.sharedGroups, groupId);
    assert.equal(!!node, !!groupRow, 'folder must appear in the tree iff its row still exists — an inner JOIN would drop it even though the row is there');
    if (node) {
      assert.equal(node.ownerName, undefined, 'no display name to show when the owner row is gone');
    }
  });
});
