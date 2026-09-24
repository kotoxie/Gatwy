import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// config reads DATA_DIR at import time, so point it at a scratch dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-perm-test-'));
process.env.DATA_DIR = dataDir;
process.env.GATWY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { initDb, getDb, closeDb } = await import('../src/db/index.js');
const { execute, queryAll } = await import('../src/db/helpers.js');
const {
  accessibleSharedGroupIds, connectionAccessWhere, descendantGroupIds, groupOwnedBy,
  editableSharedGroupIds, canWriteSharedGroup, isSharedGroup, isSharedConnection,
  allDescendantGroupIdsUnscoped, isInsideSharedGroup, sameSharedBranch,
} = await import('../src/services/permissions.js');

const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';

function addUser(id: string, role = 'user') {
  execute("INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, 'x', ?, ?)", [id, id, id, role]);
}

function addGroup(id: string, ownerId: string, parentId: string | null = null) {
  execute('INSERT INTO connection_groups (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)', [id, ownerId, id, parentId]);
}

function shareGroup(groupId: string, shareType: 'user' | 'role', targetId: string) {
  execute(
    `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, ?, ?, 'view')`,
    [`share-${groupId}-${targetId}`, groupId, shareType, targetId],
  );
}

function shareGroupEdit(groupId: string, shareType: 'user' | 'role', targetId: string) {
  execute(
    `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, ?, ?, 'edit')`,
    [`share-edit-${groupId}-${targetId}`, groupId, shareType, targetId],
  );
}

function shareConnection(connectionId: string, shareType: 'user' | 'role', targetId: string) {
  execute(
    `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'connection', ?, ?, ?, 'view')`,
    [`share-conn-${connectionId}-${targetId}`, connectionId, shareType, targetId],
  );
}

function addConnection(id: string, ownerId: string, groupId: string | null = null) {
  execute(
    `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port)
     VALUES (?, ?, ?, ?, 'ssh', 'host', 22)`,
    [id, ownerId, groupId, id],
  );
}

function connIdsAccessibleTo(userId: string, role: string): string[] {
  const access = connectionAccessWhere('connections', userId, role);
  const rows = queryAll<{ id: string }>(`SELECT id FROM connections WHERE ${access.where} ORDER BY id`, access.params);
  return rows.map((r) => r.id);
}

describe('permissions', () => {
  before(async () => {
    await initDb();
    addUser(ALICE);
    addUser(BOB);
    addUser(CAROL);
  });

  after(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('groupOwnedBy', () => {
    it('is true when the group exists and belongs to the given owner', () => {
      addGroup('g-owned', ALICE);
      assert.equal(groupOwnedBy('g-owned', ALICE), true);
    });

    it('is false when the group belongs to someone else', () => {
      assert.equal(groupOwnedBy('g-owned', BOB), false);
    });

    it('is false when the group does not exist', () => {
      assert.equal(groupOwnedBy('g-missing', ALICE), false);
    });
  });

  describe('accessibleSharedGroupIds', () => {
    it('is empty when nothing is shared to the user or role', () => {
      assert.deepEqual(accessibleSharedGroupIds(BOB, 'user'), []);
    });

    it('returns a directly-shared group', () => {
      addGroup('g-direct', ALICE);
      shareGroup('g-direct', 'user', BOB);
      assert.deepEqual(accessibleSharedGroupIds(BOB, 'user'), ['g-direct']);
    });

    it('inherits into descendants owned by the same owner', () => {
      addGroup('g-parent', ALICE);
      addGroup('g-child', ALICE, 'g-parent');
      addGroup('g-grandchild', ALICE, 'g-child');
      shareGroup('g-parent', 'user', CAROL);
      const ids = accessibleSharedGroupIds(CAROL, 'user').sort();
      assert.deepEqual(ids, ['g-child', 'g-grandchild', 'g-parent']);
    });

    it('does not descend into a child grafted under a different owner', () => {
      addGroup('g-planted-parent', ALICE);
      addGroup('g-planted-child', BOB, 'g-planted-parent'); // grafted: parent_id points cross-owner
      shareGroup('g-planted-parent', 'user', 'user-dave');
      execute("INSERT INTO users (id, username, password_hash, display_name, role) VALUES ('user-dave', 'user-dave', 'x', 'dave', 'user')");
      const ids = accessibleSharedGroupIds('user-dave', 'user');
      assert.deepEqual(ids, ['g-planted-parent']);
      assert.ok(!ids.includes('g-planted-child'));
    });

    it('resolves a share made to a role, independent of the specific user', () => {
      addGroup('g-role-shared', ALICE);
      shareGroup('g-role-shared', 'role', 'admin');
      addUser('user-erin', 'admin');
      assert.deepEqual(accessibleSharedGroupIds('user-erin', 'admin'), ['g-role-shared']);
      assert.deepEqual(accessibleSharedGroupIds('user-erin', 'user'), []);
    });
  });

  describe('descendantGroupIds', () => {
    it('includes the root and its owner-scoped descendants', () => {
      addGroup('d-root', ALICE);
      addGroup('d-child', ALICE, 'd-root');
      addGroup('d-grandchild', ALICE, 'd-child');
      assert.deepEqual(descendantGroupIds('d-root').sort(), ['d-child', 'd-grandchild', 'd-root']);
    });

    it('excludes a child grafted under a different owner', () => {
      addGroup('d-root2', ALICE);
      addGroup('d-planted', BOB, 'd-root2');
      assert.deepEqual(descendantGroupIds('d-root2'), ['d-root2']);
    });

    it('is empty for a group that does not exist', () => {
      assert.deepEqual(descendantGroupIds('d-missing'), []);
    });

    it('prunes the whole branch at a planted node — a grandchild re-owned by the root owner is still excluded', () => {
      // Regression for DELETE /groups/:id (routes/connections.ts): the old inline walk used
      // `WHERE parent_id = ? AND user_id = ?` (the constant root owner) at every level, which
      // also stops enqueuing descendants the first time a node's owner doesn't match — so it
      // never even looks past a planted node, regardless of who owns anything beneath it.
      // descendantGroupIds must delete exactly the same connection set, or a real DELETE would
      // silently leave connections orphaned with group_id pointing at a removed row.
      addGroup('d-root3', ALICE);
      addGroup('d-planted2', BOB, 'd-root3');
      addGroup('d-reowned', ALICE, 'd-planted2'); // owned by ALICE again, but parented under BOB's planted node
      assert.deepEqual(descendantGroupIds('d-root3'), ['d-root3']);
      assert.ok(!descendantGroupIds('d-root3').includes('d-planted2'));
      assert.ok(!descendantGroupIds('d-root3').includes('d-reowned'));
    });
  });

  describe('connectionAccessWhere — folder-share inheritance and planted-connection defence', () => {
    it('lets the owner access their own connection', () => {
      addGroup('g-own', ALICE);
      addConnection('conn-own', ALICE, 'g-own');
      assert.ok(connIdsAccessibleTo(ALICE, 'user').includes('conn-own'));
    });

    it('grants access to a connection filed under a shared folder', () => {
      addGroup('g-shared-folder', ALICE);
      shareGroup('g-shared-folder', 'user', BOB);
      addConnection('conn-in-shared-folder', ALICE, 'g-shared-folder');
      assert.ok(connIdsAccessibleTo(BOB, 'user').includes('conn-in-shared-folder'));
    });

    it('withholds a connection whose owner does not match its folder\'s owner (planted connection)', () => {
      // g-shared-folder is owned by ALICE and shared with BOB (from the previous test).
      // A connection "planted" into it by a different owner must not leak via the share,
      // even though its group_id still matches — defence in depth against a bug elsewhere
      // (or a direct DB write) that lets a connection's group_id diverge from its owner.
      addConnection('conn-planted', CAROL, 'g-shared-folder');
      assert.ok(!connIdsAccessibleTo(BOB, 'user').includes('conn-planted'));
      // The actual owner can still see their own connection, regardless of the folder mismatch.
      assert.ok(connIdsAccessibleTo(CAROL, 'user').includes('conn-planted'));
    });

    it('does not grant access to an unrelated user', () => {
      assert.ok(!connIdsAccessibleTo('user-erin', 'user').includes('conn-in-shared-folder'));
    });
  });

  describe('editableSharedGroupIds / canWriteSharedGroup', () => {
    it('is empty when a folder is shared read-only', () => {
      addGroup('e-view-only', ALICE);
      shareGroup('e-view-only', 'user', BOB);
      assert.deepEqual(editableSharedGroupIds(BOB, 'user'), []);
      assert.equal(canWriteSharedGroup('e-view-only', BOB, 'user'), false);
    });

    it('includes a folder shared with edit capability, and inherits into its descendants', () => {
      addGroup('e-root', ALICE);
      addGroup('e-child', ALICE, 'e-root');
      shareGroupEdit('e-root', 'user', BOB);
      const ids = editableSharedGroupIds(BOB, 'user').sort();
      assert.deepEqual(ids, ['e-child', 'e-root']);
      assert.equal(canWriteSharedGroup('e-root', BOB, 'user'), true);
      assert.equal(canWriteSharedGroup('e-child', BOB, 'user'), true);
    });

    it('does not inherit edit capability into a child grafted under a different owner', () => {
      addGroup('e-root2', ALICE);
      addGroup('e-planted', BOB, 'e-root2');
      shareGroupEdit('e-root2', 'user', CAROL);
      assert.equal(canWriteSharedGroup('e-planted', CAROL, 'user'), false);
    });

    it('is a subset of accessibleSharedGroupIds for the same user/role', () => {
      addGroup('e-mixed-view', ALICE);
      addGroup('e-mixed-edit', ALICE);
      shareGroup('e-mixed-view', 'user', 'user-dana');
      shareGroupEdit('e-mixed-edit', 'user', 'user-dana');
      addUser('user-dana');
      const accessible = new Set(accessibleSharedGroupIds('user-dana', 'user'));
      const editable = editableSharedGroupIds('user-dana', 'user');
      assert.ok(editable.every((id) => accessible.has(id)));
      assert.ok(accessible.has('e-mixed-view'));
      assert.ok(!editable.includes('e-mixed-view'));
    });
  });

  describe('isSharedGroup / isSharedConnection', () => {
    it('is true for a group referenced by any share, regardless of who is asking', () => {
      addGroup('s-group', ALICE);
      shareGroup('s-group', 'user', BOB);
      assert.equal(isSharedGroup('s-group'), true);
    });

    it('is false for a group with no shares', () => {
      addGroup('s-group-unshared', ALICE);
      assert.equal(isSharedGroup('s-group-unshared'), false);
    });

    it('is true for a connection referenced by its own share', () => {
      addGroup('s-conn-group', ALICE);
      addConnection('s-conn', ALICE, 's-conn-group');
      shareConnection('s-conn', 'user', BOB);
      assert.equal(isSharedConnection('s-conn'), true);
    });

    it('is false for a connection with no shares of its own, even inside a shared folder', () => {
      addGroup('s-conn-group2', ALICE);
      shareGroupEdit('s-conn-group2', 'user', BOB);
      addConnection('s-conn-2', ALICE, 's-conn-group2');
      assert.equal(isSharedConnection('s-conn-2'), false);
    });
  });

  describe('allDescendantGroupIdsUnscoped', () => {
    it('includes the root and every descendant, regardless of owner', () => {
      addGroup('u-root', ALICE);
      addGroup('u-child', ALICE, 'u-root');
      addGroup('u-planted', BOB, 'u-child'); // grafted: parent_id points cross-owner
      const ids = allDescendantGroupIdsUnscoped('u-root').sort();
      assert.deepEqual(ids, ['u-child', 'u-planted', 'u-root']);
    });

    it('is empty for a group that does not exist', () => {
      assert.deepEqual(allDescendantGroupIdsUnscoped('u-missing'), []);
    });
  });

  describe('sameSharedBranch (editor reparenting confined to one shared branch)', () => {
    it('is true for two sub-folders of the same directly-shared root', () => {
      addGroup('b-root', ALICE);
      addGroup('b-child1', ALICE, 'b-root');
      addGroup('b-child2', ALICE, 'b-root');
      shareGroupEdit('b-root', 'user', BOB);
      assert.equal(sameSharedBranch('b-child1', 'b-child2', BOB, 'user'), true);
      assert.equal(sameSharedBranch('b-root', 'b-child1', BOB, 'user'), true);
    });

    it('is false across two independent edit-shares from the same owner', () => {
      addGroup('b-rootA', ALICE);
      addGroup('b-rootB', ALICE);
      shareGroupEdit('b-rootA', 'user', CAROL);
      shareGroupEdit('b-rootB', 'user', CAROL);
      // Both are individually writable by CAROL, but they are two separate shares —
      // moving between them is not "the same shared folder".
      assert.equal(canWriteSharedGroup('b-rootA', CAROL, 'user'), true);
      assert.equal(canWriteSharedGroup('b-rootB', CAROL, 'user'), true);
      assert.equal(sameSharedBranch('b-rootA', 'b-rootB', CAROL, 'user'), false);
    });

    it('is false when the source folder is not shared to this user at all', () => {
      addGroup('b-unrelated', ALICE);
      addGroup('b-shared-target', ALICE);
      shareGroupEdit('b-shared-target', 'user', 'user-frank');
      addUser('user-frank');
      assert.equal(sameSharedBranch('b-unrelated', 'b-shared-target', 'user-frank', 'user'), false);
    });
  });

  describe('isInsideSharedGroup', () => {
    it('is false for a folder that is not shared and has no shared ancestor', () => {
      addGroup('w-unshared', ALICE);
      assert.equal(isInsideSharedGroup('w-unshared'), false);
    });

    it('is true for the shared folder itself', () => {
      addGroup('w-root', ALICE);
      shareGroup('w-root', 'user', BOB);
      assert.equal(isInsideSharedGroup('w-root'), true);
    });

    it('is true for a descendant of a shared folder, walking up through multiple levels', () => {
      addGroup('w-root2', ALICE);
      addGroup('w-child', ALICE, 'w-root2');
      addGroup('w-grandchild', ALICE, 'w-child');
      shareGroup('w-root2', 'user', BOB);
      assert.equal(isInsideSharedGroup('w-grandchild'), true);
    });

    it('is false for null (no folder)', () => {
      assert.equal(isInsideSharedGroup(null), false);
    });
  });
});
