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
    assert.equal(maxAfter, 25);
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
    assert.equal(maxAfter, 25);
  });

  it('applies a lower-numbered migration that is missing even when a higher one is already applied', () => {
    // Models two branches merging in the opposite order of their migration numbers: an
    // install already at v23 must still pick up a lower-numbered migration it never ran.
    // Gating on MAX(version) skips it forever; gating on the set of applied versions
    // does not. v22 (group_shares) stands in for the missing lower-numbered migration.
    const db = getDb();
    db.run('DROP TABLE IF EXISTS group_shares');
    db.run('DELETE FROM schema_version WHERE version = 22');

    const maxBefore = db.exec('SELECT MAX(version) as v FROM schema_version')[0]!.values[0]![0];
    assert.equal(maxBefore, 25, 'precondition: a higher version is already applied');
    assert.equal(db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='group_shares'").length, 0);

    restoreDbFromBytes(Buffer.from(db.export()));

    const migrated = getDb();
    assert.equal(migrated.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='group_shares'").length, 1, 'v22 must run even though v23 is already applied');
    assert.equal(migrated.exec('SELECT COUNT(*) FROM schema_version WHERE version = 22')[0]!.values[0]![0], 1);
    assert.equal(migrated.exec('SELECT COUNT(*) FROM schema_version WHERE version = 23')[0]!.values[0]![0], 1, 'v23 must not be re-applied');
  });

  it('v5/v13/v18 connections rebuilds keep sessions/file_sessions/ssh_commands intact', () => {
    // Same failure mode as the v24 regression below, but for three earlier migrations
    // that rebuild `connections` itself (v5 adds 'telnet' + tags, v13 adds postgres/
    // mysql, v18 adds moonlight — v14 only heals a database where v13's rebuild was
    // recorded as applied but never actually ran, so starting from a clean v4-era
    // schema it's a no-op here and never touches `connections`). Each does DROP TABLE
    // connections to change its CHECK constraint — with foreign_keys ON, that
    // cascade-deletes every sessions/file_sessions row referencing it (ON DELETE
    // CASCADE), and transitively every ssh_commands/rdp_events/file_session_events row
    // under THOSE — on any populated install that upgraded through them while carrying
    // that history. Confirmed via `git log`/`git show`: at 18c698e (2026-03-29, when
    // this v5 body was introduced), `applyDbPragmas` already turned foreign_keys ON
    // before `runMigrations()` ran, with no save/export in between — so this was live
    // and unfixed from that commit onward, until the whole migration run was wrapped in
    // one foreign_keys OFF/ON pair (see runMigrations()) alongside the v24 fix.
    const db = getDb();

    for (const t of ['ssh_commands', 'file_session_events', 'file_sessions', 'sessions', 'connections']) {
      db.run(`DROP TABLE IF EXISTS ${t}`);
    }
    // Recreate the pre-v5 (v1/v3/v4-era) shape: CASCADE FK from sessions/file_sessions
    // to connections, and from ssh_commands to sessions.
    db.run(`CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('ssh', 'rdp', 'smb', 'vnc', 'sftp', 'ftp')),
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      encrypted_password TEXT,
      private_key TEXT,
      extra_config_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      recording_enabled INTEGER NOT NULL DEFAULT 1,
      shared INTEGER NOT NULL DEFAULT 0,
      tunnels_json TEXT,
      host_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      protocol TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      recording_path TEXT
    )`);
    db.run(`CREATE TABLE file_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      protocol TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    )`);
    db.run(`CREATE TABLE ssh_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      elapsed REAL NOT NULL DEFAULT 0,
      command TEXT NOT NULL,
      output_preview TEXT
    )`);

    // Pin at v4 (post ssh_commands, pre v5 connections rebuild) and seed real history.
    db.run('DELETE FROM schema_version WHERE version > 4');
    db.run(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES ('u-v5-upgrade', 'v5-upgrade-user', 'x', 'V5 Upgrade User', 'user')`);
    db.run(`INSERT INTO connections (id, user_id, name, protocol, host, port) VALUES ('c-v5-upgrade', 'u-v5-upgrade', 'V5 Upgrade Conn', 'ssh', 'h', 22)`);
    db.run(`INSERT INTO sessions (id, user_id, connection_id, protocol) VALUES ('s-v5-upgrade', 'u-v5-upgrade', 'c-v5-upgrade', 'ssh')`);
    db.run(`INSERT INTO file_sessions (id, user_id, connection_id, protocol) VALUES ('fs-v5-upgrade', 'u-v5-upgrade', 'c-v5-upgrade', 'sftp')`);
    db.run(`INSERT INTO ssh_commands (id, session_id, command) VALUES ('cmd-v5-upgrade', 's-v5-upgrade', 'ls -la')`);

    const bytes = Buffer.from(db.export());
    restoreDbFromBytes(bytes);
    const migrated = getDb();

    const count = (sql: string) => (migrated.exec(sql)[0]?.values[0]?.[0] as number) ?? 0;
    assert.equal(count(`SELECT COUNT(*) FROM sessions WHERE id = 's-v5-upgrade'`), 1, 'sessions must survive the v5/v13/v18 connections rebuilds');
    assert.equal(count(`SELECT COUNT(*) FROM file_sessions WHERE id = 'fs-v5-upgrade'`), 1, 'file_sessions must survive the v5/v13/v18 connections rebuilds');
    assert.equal(count(`SELECT COUNT(*) FROM ssh_commands WHERE id = 'cmd-v5-upgrade'`), 1, 'ssh_commands must survive transitively (its parent session must survive first)');
  });

  it('v24 rebuild keeps ssh_commands/rdp_events/file_session_events intact and backfills username/connection_name', () => {
    // Simulate a real, populated install upgrading from v23: recreate sessions/
    // file_sessions/db_query_history with their OLD (CASCADE-FK, no snapshot columns)
    // shape, seed real history under them, then let v24 run for real via
    // restoreDbFromBytes. A naive rebuild (DROP TABLE with foreign_keys still ON)
    // cascade-deletes ssh_commands/rdp_events/file_session_events the moment the parent
    // table is dropped, before it's even recreated — this is the regression guard for
    // that specific failure mode, not just a schema/shape check.
    const db = getDb();

    for (const t of ['ssh_commands', 'rdp_events', 'file_session_events', 'db_query_history', 'file_sessions', 'sessions']) {
      db.run(`DROP TABLE IF EXISTS ${t}`);
    }
    db.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      protocol TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      recording_path TEXT
    )`);
    db.run(`CREATE TABLE file_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      protocol TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    )`);
    db.run(`CREATE TABLE db_query_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      query_text TEXT NOT NULL,
      row_count INTEGER,
      duration_ms INTEGER,
      error TEXT,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE ssh_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      elapsed REAL NOT NULL DEFAULT 0,
      command TEXT NOT NULL,
      output_preview TEXT
    )`);
    db.run(`CREATE TABLE rdp_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      elapsed REAL NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('click', 'key', 'move'))
    )`);
    db.run(`CREATE TABLE file_session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES file_sessions(id) ON DELETE CASCADE,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      path TEXT NOT NULL,
      detail_json TEXT
    )`);

    db.run(`INSERT INTO users (id, username, password_hash, display_name, role) VALUES ('u-v24-upgrade', 'v24-upgrade-user', 'x', 'V24 Upgrade User', 'user')`);
    db.run(`INSERT INTO connections (id, user_id, name, protocol, host, port) VALUES ('c-v24-upgrade', 'u-v24-upgrade', 'V24 Upgrade Conn', 'ssh', 'h', 22)`);
    db.run(`INSERT INTO sessions (id, user_id, connection_id, protocol) VALUES ('s-v24-upgrade', 'u-v24-upgrade', 'c-v24-upgrade', 'ssh')`);
    db.run(`INSERT INTO ssh_commands (id, session_id, command) VALUES ('cmd-v24-upgrade', 's-v24-upgrade', 'ls -la')`);
    db.run(`INSERT INTO rdp_events (session_id, elapsed, event_type) VALUES ('s-v24-upgrade', 1.5, 'click')`);
    db.run(`INSERT INTO file_sessions (id, user_id, connection_id, protocol) VALUES ('fs-v24-upgrade', 'u-v24-upgrade', 'c-v24-upgrade', 'sftp')`);
    db.run(`INSERT INTO file_session_events (id, session_id, action, path) VALUES ('evt-v24-upgrade', 'fs-v24-upgrade', 'browse', '/')`);
    db.run(`INSERT INTO db_query_history (id, user_id, connection_id, query_text) VALUES ('q-v24-upgrade', 'u-v24-upgrade', 'c-v24-upgrade', 'SELECT 1')`);

    db.run('DELETE FROM schema_version WHERE version > 23');

    const bytes = Buffer.from(db.export());
    restoreDbFromBytes(bytes);
    const migrated = getDb();

    const count = (sql: string) => (migrated.exec(sql)[0]?.values[0]?.[0] as number) ?? 0;
    assert.equal(count(`SELECT COUNT(*) FROM ssh_commands WHERE session_id = 's-v24-upgrade'`), 1, 'ssh_commands must survive the sessions table rebuild');
    assert.equal(count(`SELECT COUNT(*) FROM rdp_events WHERE session_id = 's-v24-upgrade'`), 1, 'rdp_events must survive the sessions table rebuild');
    assert.equal(count(`SELECT COUNT(*) FROM file_session_events WHERE session_id = 'fs-v24-upgrade'`), 1, 'file_session_events must survive the file_sessions table rebuild');

    const sessionRow = migrated.exec(`SELECT username, connection_name FROM sessions WHERE id = 's-v24-upgrade'`)[0]!.values[0]!;
    assert.deepEqual(sessionRow, ['v24-upgrade-user', 'V24 Upgrade Conn'], 'sessions row must be backfilled from the still-live user/connection');

    const fileSessionRow = migrated.exec(`SELECT username, connection_name FROM file_sessions WHERE id = 'fs-v24-upgrade'`)[0]!.values[0]!;
    assert.deepEqual(fileSessionRow, ['v24-upgrade-user', 'V24 Upgrade Conn']);

    const historyRow = migrated.exec(`SELECT username, connection_name FROM db_query_history WHERE id = 'q-v24-upgrade'`)[0]!.values[0]!;
    assert.deepEqual(historyRow, ['v24-upgrade-user', 'V24 Upgrade Conn']);

    assert.equal(migrated.exec('PRAGMA foreign_keys')[0]!.values[0]![0], 1, 'foreign_keys must be back ON after the migration, not left OFF');
    assert.equal(migrated.exec('PRAGMA foreign_key_list(sessions)').length, 0, 'sessions must have no FK left on user_id/connection_id');

    // The children's own FK (ssh_commands/rdp_events -> sessions.id) must still point at
    // the rebuilt table and still fire: the RENAME under foreign_keys=OFF must not have
    // left them referencing a table that no longer exists.
    migrated.run(`DELETE FROM sessions WHERE id = 's-v24-upgrade'`);
    assert.equal(count(`SELECT COUNT(*) FROM ssh_commands WHERE session_id = 's-v24-upgrade'`), 0, 'ssh_commands must still cascade off the rebuilt sessions table');
    assert.equal(count(`SELECT COUNT(*) FROM rdp_events WHERE session_id = 's-v24-upgrade'`), 0, 'rdp_events must still cascade off the rebuilt sessions table');
    migrated.run(`DELETE FROM file_sessions WHERE id = 'fs-v24-upgrade'`);
    assert.equal(count(`SELECT COUNT(*) FROM file_session_events WHERE session_id = 'fs-v24-upgrade'`), 0, 'file_session_events must still cascade off the rebuilt file_sessions table');
  });

  describe('v25 sessions.view_active grant', () => {
    const PERM = 'sessions.view_active';
    const readPerms = (roleId: string): string[] => {
      const res = getDb().exec(`SELECT permissions_json FROM roles WHERE id = '${roleId}'`);
      return JSON.parse(res[0]!.values[0]![0] as string) as string[];
    };
    // Rewind to v24 with the given admin permission set, then re-run migrations for real.
    const rewindToV24 = (adminPerms: string[]) => {
      const db = getDb();
      db.run(`UPDATE roles SET permissions_json = ? WHERE id = 'admin'`, [JSON.stringify(adminPerms)]);
      db.run(`UPDATE roles SET permissions_json = ? WHERE id = 'user'`, [JSON.stringify(readPerms('user').filter((p) => p !== PERM))]);
      db.run('DELETE FROM schema_version WHERE version > 24');
      restoreDbFromBytes(Buffer.from(db.export()));
    };

    it('grants sessions.view_active to builtin admin exactly once and not to builtin user when upgrading from v24', () => {
      const adminBefore = readPerms('admin').filter((p) => p !== PERM);
      rewindToV24(adminBefore);

      const maxAfter = getDb().exec('SELECT MAX(version) as v FROM schema_version')[0]!.values[0]![0];
      assert.equal(maxAfter, 25);

      const admin = readPerms('admin');
      assert.equal(admin.filter((p) => p === PERM).length, 1, 'admin must have the permission exactly once');
      assert.equal(admin.length, adminBefore.length + 1, 'no other admin permission may be added or removed');
      assert.ok(!readPerms('user').includes(PERM), 'builtin user role must not get the permission');
    });

    it('does not duplicate sessions.view_active when admin already has it', () => {
      const adminWith = [...readPerms('admin').filter((p) => p !== PERM), PERM];
      rewindToV24(adminWith);

      const admin = readPerms('admin');
      assert.equal(admin.filter((p) => p === PERM).length, 1);
      assert.deepEqual(admin, adminWith, 'admin permissions must be left untouched');
      assert.ok(!readPerms('user').includes(PERM));
    });
  });
});
