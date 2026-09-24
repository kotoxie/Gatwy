import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// config reads DATA_DIR at import time, so point it at a scratch dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-migration-test-'));
process.env.DATA_DIR = dataDir;
process.env.GATWY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { initDb, getDb, closeDb, restoreDbFromBytes } = await import('../src/db/index.js');

describe('migration upgrade path', () => {
  before(async () => {
    await initDb();
  });

  after(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates group_shares (v22) then immediately folds it into resource_shares (v23) for a DB that was already at v21', () => {
    // Simulate a deployed instance that upgraded through the old, broken numbering:
    // it already has schema_version rows through v21 (credentials + domain applied)
    // but never got group_shares, because that migration used to be numbered v20 —
    // a version <= its already-applied v21, so runMigrations skipped it entirely.
    // connection_shares has existed since v6, so it's recreated here to model that
    // accurately (the shared `db` instance already dropped it once, for real, when it
    // first reached v23 during this file's initDb() in `before`).
    const db = getDb();
    db.run('DROP TABLE IF EXISTS group_shares');
    db.run('DROP TABLE IF EXISTS resource_shares');
    db.run(`CREATE TABLE IF NOT EXISTS connection_shares (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      share_type TEXT NOT NULL CHECK(share_type IN ('role', 'user')),
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run('DELETE FROM schema_version WHERE version > 21');

    const maxBefore = db.exec('SELECT MAX(version) as v FROM schema_version')[0]!.values[0]![0];
    assert.equal(maxBefore, 21);
    const tableBefore = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='group_shares'");
    assert.equal(tableBefore.length, 0);

    // restoreDbFromBytes re-runs runMigrations against the restored bytes, exactly as
    // happens on every real app startup against the persisted file. From v21 that now
    // applies both v22 (creates group_shares) and v23 (folds it — and connection_shares —
    // into resource_shares, then drops both) in the same pass.
    const bytes = Buffer.from(db.export());
    restoreDbFromBytes(bytes);

    const after = getDb();
    const groupSharesAfter = after.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='group_shares'");
    assert.equal(groupSharesAfter.length, 0, 'group_shares must not survive past v23 — folded into resource_shares');
    const resourceSharesAfter = after.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_shares'");
    assert.equal(resourceSharesAfter.length, 1, 'resource_shares table must exist after upgrading from v21');
    const maxAfter = after.exec('SELECT MAX(version) as v FROM schema_version')[0]!.values[0]![0];
    assert.equal(maxAfter, 23);
  });

  it('migrates real connection_shares and group_shares rows into resource_shares from a v22 database', () => {
    const db = getDb();

    // Simulate a real DB that completed the v22 migration: connection_shares (since v6)
    // and group_shares (v22) both exist, with real rows referencing real resources.
    db.run('DROP TABLE IF EXISTS resource_shares');
    db.run(`CREATE TABLE IF NOT EXISTS connection_shares (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      share_type TEXT NOT NULL CHECK(share_type IN ('role', 'user')),
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS group_shares (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES connection_groups(id) ON DELETE CASCADE,
      share_type TEXT NOT NULL CHECK(share_type IN ('role', 'user')),
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    db.run("INSERT INTO users (id, username, password_hash, display_name, role) VALUES ('mig-user', 'mig-user', 'x', 'mig-user', 'user')");
    db.run("INSERT INTO connection_groups (id, user_id, name) VALUES ('mig-group', 'mig-user', 'mig-group')");
    db.run(`INSERT INTO connections (id, user_id, group_id, name, protocol, host, port)
            VALUES ('mig-conn', 'mig-user', 'mig-group', 'mig-conn', 'ssh', 'host', 22)`);
    db.run("INSERT INTO connection_shares (id, connection_id, share_type, target_id) VALUES ('mig-cs-1', 'mig-conn', 'user', 'target-user-1')");
    db.run("INSERT INTO group_shares (id, group_id, share_type, target_id) VALUES ('mig-gs-1', 'mig-group', 'role', 'admin')");

    db.run('DELETE FROM schema_version WHERE version > 22');
    const maxBefore = db.exec('SELECT MAX(version) as v FROM schema_version')[0]!.values[0]![0];
    assert.equal(maxBefore, 22);

    const bytes = Buffer.from(db.export());
    restoreDbFromBytes(bytes);

    const after = getDb();
    const rows = after.exec(
      'SELECT id, resource_type, resource_id, share_type, target_id, capability FROM resource_shares ORDER BY resource_type',
    );
    const values = rows[0]?.values ?? [];
    assert.equal(values.length, 2, 'both pre-existing shares must survive the migration');
    const byId = new Map(values.map((v) => [v[0], v]));
    assert.deepEqual(byId.get('mig-cs-1'), ['mig-cs-1', 'connection', 'mig-conn', 'user', 'target-user-1', 'view']);
    assert.deepEqual(byId.get('mig-gs-1'), ['mig-gs-1', 'group', 'mig-group', 'role', 'admin', 'view']);

    const oldTables = after.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('connection_shares', 'group_shares')",
    );
    assert.equal(oldTables.length, 0, 'connection_shares and group_shares must not survive past v23');

    const maxAfter = after.exec('SELECT MAX(version) as v FROM schema_version')[0]!.values[0]![0];
    assert.equal(maxAfter, 23);
  });
});
