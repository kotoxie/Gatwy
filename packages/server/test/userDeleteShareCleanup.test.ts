import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-userdeleteshare-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'user-delete-share-cleanup-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute, queryOne } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { default: express } = await import('express');

let server: Server;
let baseUrl: string;
let adminToken: string;

before(async () => {
  await initDb();
  initJwt();

  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    ['user-admin', 'admin-user', 'x', 'Admin User', 'admin'],
  );
  adminToken = signToken({ userId: 'user-admin', username: 'admin-user', role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/users', usersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1/users`;
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

describe('DELETE /:id (users) — cleans up resource_shares where the deleted user was owner or recipient', () => {
  it('removes shares in both roles, leaves an unrelated share between other users intact', async () => {
    const A = 'user-A-owner-and-recipient';
    const B = 'user-B-recipient-of-A';
    const C = 'user-C-owner-shares-to-A-and-B';

    for (const [id, username] of [[A, 'user-a'], [B, 'user-b'], [C, 'user-c']]) {
      execute(
        `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
        [id, username, 'x', username, 'user'],
      );
    }

    // A owns a group shared to B — this share must be cleaned up (A is the owner side).
    execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', ['g-owned-by-a', A, 'Owned by A']);
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, 'user', ?, 'view')`,
      ['share-a-owns-to-b', 'g-owned-by-a', B],
    );

    // A owns a connection shared to B too, same idea, different resource_type.
    execute(
      `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port) VALUES (?, ?, NULL, ?, 'ssh', 'h', 22)`,
      ['conn-owned-by-a', A, 'Conn owned by A'],
    );
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'connection', ?, 'user', ?, 'view')`,
      ['share-a-conn-to-b', 'conn-owned-by-a', B],
    );

    // C owns a group shared to A — this must be cleaned up too (A is the recipient side).
    execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', ['g-owned-by-c-to-a', C, 'Owned by C, shared to A']);
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, 'user', ?, 'edit')`,
      ['share-c-to-a', 'g-owned-by-c-to-a', A],
    );

    // C also shares a DIFFERENT group to B — completely unrelated to A, must survive untouched.
    execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', ['g-owned-by-c-to-b', C, 'Owned by C, shared to B']);
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, 'user', ?, 'view')`,
      ['share-c-to-b', 'g-owned-by-c-to-b', B],
    );

    const res = await authedFetch(adminToken, `${baseUrl}/${A}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    assert.equal(queryOne('SELECT id FROM resource_shares WHERE id = ?', ['share-a-owns-to-b']), undefined, 'A-as-owner group share must be gone');
    assert.equal(queryOne('SELECT id FROM resource_shares WHERE id = ?', ['share-a-conn-to-b']), undefined, 'A-as-owner connection share must be gone');
    assert.equal(queryOne('SELECT id FROM resource_shares WHERE id = ?', ['share-c-to-a']), undefined, 'A-as-recipient share must be gone');
    assert.ok(queryOne('SELECT id FROM resource_shares WHERE id = ?', ['share-c-to-b']), 'unrelated share between C and B must survive');
    assert.equal(queryOne('SELECT id FROM users WHERE id = ?', [A]), undefined, 'user A itself must be deleted');
  });

  it('keeps a "planted" sub-folder\'s share in sync with whether the folder itself still exists', async () => {
    // connection_groups.parent_id is declared ON DELETE CASCADE, but FK enforcement never
    // actually runs in this app today (sql.js drops PRAGMA foreign_keys on every
    // db.export(), i.e. every autosave — tracked separately, fixed on its own branch). A
    // sub-folder owned by a different user X but parented under A's root therefore
    // survives deleting A untouched today.
    //
    // The invariant below — not "the folder survives" — is what should hold in BOTH
    // states: today (no cascade, folder survives, share must survive with it) and after
    // the FK fix lands (cascade fires, folder is gone, share must be cleaned up too, which
    // needs the descendant-expansion this test currently guards against restoring
    // unconditionally). It fails if the share is orphaned OR if it's deleted out from
    // under a folder that's still there — pointing at the wrong one either way is a bug.
    const A = 'user-planted-root-owner';
    const X = 'user-planted-subfolder-owner';
    const B = 'user-planted-recipient';

    for (const [id, username] of [[A, 'user-planted-a'], [X, 'user-planted-x'], [B, 'user-planted-b']]) {
      execute(
        `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
        [id, username, 'x', username, 'user'],
      );
    }

    execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', ['g-planted-root', A, 'Root owned by A']);
    // Planted: owned by X, but parented under A's root.
    execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)', ['g-planted-sub', X, 'Sub owned by X', 'g-planted-root']);
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, 'user', ?, 'view')`,
      ['share-planted-sub-to-b', 'g-planted-sub', B],
    );

    const res = await authedFetch(adminToken, `${baseUrl}/${A}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    const subFolder = queryOne('SELECT id FROM connection_groups WHERE id = ?', ['g-planted-sub']);
    const share = queryOne('SELECT id FROM resource_shares WHERE id = ?', ['share-planted-sub-to-b']);
    assert.equal(!!share, !!subFolder, 'share must exist iff its folder still exists — no orphan, no lost share');
  });

  it('does not delete a role-targeted share whose role id collides with the deleted user id', async () => {
    // target_id has no FK — nothing stops a role from having the same id as some user.
    // The recipient-side cleanup must filter on share_type = 'user', not just target_id,
    // or it would delete this role share by accident.
    const D = 'collide-user-and-role-id';
    const owner = 'user-owns-group-shared-to-role';

    execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`, [D, 'user-d', 'x', 'user-d', 'user']);
    execute(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`, [owner, 'owner-user', 'x', 'owner-user', 'user']);
    execute(`INSERT INTO roles (id, name, description, is_builtin, permissions_json) VALUES (?, ?, ?, 0, '[]')`, [D, 'Colliding Role', 'same id as user D']);

    execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, NULL)', ['g-shared-to-role-d', owner, 'Shared to role D']);
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, 'role', ?, 'view')`,
      ['share-role-d', 'g-shared-to-role-d', D],
    );

    const res = await authedFetch(adminToken, `${baseUrl}/${D}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    assert.ok(queryOne('SELECT id FROM resource_shares WHERE id = ?', ['share-role-d']), 'role-targeted share must survive deleting the user with the colliding id');
    assert.equal(queryOne('SELECT id FROM users WHERE id = ?', [D]), undefined, 'user D itself must be deleted');
  });
});
