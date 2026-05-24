import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

let db: Database;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SqlModule: any;

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

function saveDb(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
}

// Auto-save on a timer to avoid data loss
let saveTimer: ReturnType<typeof setInterval>;

function startAutoSave(): void {
  saveTimer = setInterval(() => {
    try { saveDb(); } catch { /* ignore */ }
  }, 5000);
}

export async function initDb(): Promise<Database> {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const SQL = await initSqlJs();
  SqlModule = SQL;

  if (fs.existsSync(config.dbPath)) {
    const fileBuffer = fs.readFileSync(config.dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  runMigrations();

  // Close any sessions that were left open from a previous crash or restart.
  // These will never get their ended_at set by the normal WS close path.
  db.run("UPDATE sessions SET ended_at = datetime('now') WHERE ended_at IS NULL");

  saveDb();
  startAutoSave();

  // Save on process exit
  process.on('beforeExit', () => { try { saveDb(); } catch { /* ignore */ } });
  process.on('exit', () => { try { saveDb(); } catch { /* ignore */ } });

  return db;
}

export function persistDb(): void {
  saveDb();
}

export function restoreDbFromBytes(bytes: Buffer): void {
  db = new SqlModule.Database(bytes) as Database;
  saveDb();
}

function runMigrations() {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const result = db.exec('SELECT MAX(version) as v FROM schema_version');
  const currentVersion = result.length > 0 && result[0].values.length > 0
    ? (result[0].values[0][0] as number ?? 0)
    : 0;

  const migrations: { version: number; sql?: string; run?: (database: Database) => void }[] = [
    {
      // Single consolidated schema — represents the full current state.
      // New schema changes must be added as version 2, 3, … going forward.
      version: 1,
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          theme TEXT,
          email TEXT,
          avatar_text TEXT,
          failed_login_count INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          last_login_at TEXT,
          ssh_prefs_json TEXT,
          mfa_secret TEXT,
          mfa_enabled INTEGER NOT NULL DEFAULT 0,
          auth_provider TEXT NOT NULL DEFAULT 'local',
          provider_id TEXT,
          dismissed_warnings_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS connection_groups (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          parent_id TEXT REFERENCES connection_groups(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS connections (
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
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          protocol TEXT NOT NULL,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          recording_path TEXT
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          event_type TEXT NOT NULL,
          target TEXT,
          details_json TEXT,
          ip_address TEXT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ip_rules (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('allow', 'deny')),
          cidr TEXT NOT NULL,
          description TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS login_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          browser TEXT,
          os TEXT,
          ip_address TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
          revoked INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS trusted_devices (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          browser TEXT,
          os TEXT,
          ip_address TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id);
        CREATE INDEX IF NOT EXISTS idx_connection_groups_user ON connection_groups(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_login_sessions_token_hash ON login_sessions(token_hash);
        CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);
        CREATE INDEX IF NOT EXISTS idx_trusted_devices_hash ON trusted_devices(token_hash);

        INSERT OR IGNORE INTO settings (key, value) VALUES
          ('app.name', 'Gatwy'),
          ('app.logo', ''),
          ('app.timezone', 'UTC'),
          ('security.session_timeout_minutes', '0'),
          ('security.idle_timeout_minutes', '0'),
          ('security.max_session_minutes', '0'),
          ('security.max_failed_logins', '5'),
          ('security.lockout_minutes', '30'),
          ('security.proxy_detection_enabled', 'true'),
          ('security.ip_rules_enabled', 'false'),
          ('security.ip_rules_mode', 'allowlist'),
          ('audit.retention_days', '90'),
          ('session.recording_enabled', 'false'),
          ('session.recording_retention_days', '90'),
          ('session.recording_retention_days_enabled', 'true'),
          ('session.recording_retention_size_enabled', 'false'),
          ('session.recording_retention_max_size_gb', '10'),
          ('session.recording_path', 'recordings'),
          ('ssh.font_size', '14'),
          ('ssh.font_family', '"Fira Code", monospace'),
          ('ssh.scrollback', '5000'),
          ('ssh.cursor_style', 'block'),
          ('ssh.cursor_blink', 'true'),
          ('ssh.theme', 'vscode-dark'),
          ('rdp.default_port', '3389'),
          ('rdp.default_width', '1920'),
          ('rdp.default_height', '1080'),
          ('health_monitor.enabled', 'true'),
          ('auth.local_enabled', 'true'),
          ('auth.ldap_enabled', 'false'),
          ('auth.ldap_url', ''),
          ('auth.ldap_bind_dn', ''),
          ('auth.ldap_bind_password', ''),
          ('auth.ldap_search_base', ''),
          ('auth.ldap_user_filter', '(uid={username})'),
          ('auth.ldap_username_attr', 'uid'),
          ('auth.ldap_email_attr', 'mail'),
          ('auth.ldap_display_name_attr', 'cn'),
          ('auth.ldap_admin_group_dn', ''),
          ('auth.ldap_tls_reject_unauthorized', 'true'),
          ('auth.oidc_enabled', 'false'),
          ('auth.oidc_provider_url', ''),
          ('auth.oidc_client_id', ''),
          ('auth.oidc_client_secret', ''),
          ('auth.oidc_redirect_uri', ''),
          ('auth.oidc_scope', 'openid email profile'),
          ('auth.oidc_display_name_claim', 'name'),
          ('auth.oidc_username_claim', 'preferred_username'),
          ('auth.oidc_admin_group_claim', ''),
          ('auth.oidc_admin_group_value', ''),
          ('auth.oidc_button_label', 'Sign in with SSO');
      `,
    },
    {
      version: 2,
      // Column is already in the v1 schema for fresh installs; this only runs for
      // existing containers that have a v1 DB without the column.
      run: (database) => {
        try { database.run('ALTER TABLE users ADD COLUMN dismissed_warnings_json TEXT'); } catch { /* already exists */ }
      },
    },
    {
      version: 3,
      sql: `
        CREATE TABLE IF NOT EXISTS file_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          protocol TEXT NOT NULL,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT
        );

        CREATE TABLE IF NOT EXISTS file_session_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES file_sessions(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          action TEXT NOT NULL,
          path TEXT NOT NULL,
          detail_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_file_sessions_user ON file_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_file_session_events_session ON file_session_events(session_id);
      `,
    },
    {
      version: 4,
      sql: `
        CREATE TABLE IF NOT EXISTS ssh_commands (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          elapsed REAL NOT NULL DEFAULT 0,
          command TEXT NOT NULL,
          output_preview TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_ssh_commands_session ON ssh_commands(session_id);
      `,
    },
    {
      version: 5,
      run: (database: Database) => {
        // Add 'telnet' to protocol CHECK and add 'tags' column to connections
        // SQLite requires table recreation to change CHECK constraints
        database.run(`CREATE TABLE connections_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK(protocol IN ('ssh', 'rdp', 'smb', 'vnc', 'sftp', 'ftp', 'telnet')),
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
          tags TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        database.run(`INSERT INTO connections_new (id, user_id, group_id, name, protocol, host, port, username, encrypted_password, private_key, extra_config_json, sort_order, recording_enabled, shared, tunnels_json, host_fingerprint, created_at, updated_at)
          SELECT id, user_id, group_id, name, protocol, host, port, username, encrypted_password, private_key, extra_config_json, sort_order, recording_enabled, shared, tunnels_json, host_fingerprint, created_at, updated_at FROM connections`);
        database.run('DROP TABLE connections');
        database.run('ALTER TABLE connections_new RENAME TO connections');
        database.run('CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id)');
      },
    },
    {
      version: 6,
      run: (database: Database) => {
        // --- Roles table ---
        database.run(`CREATE TABLE IF NOT EXISTS roles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          is_builtin INTEGER NOT NULL DEFAULT 0,
          permissions_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);

        // --- Connection shares table ---
        database.run(`CREATE TABLE IF NOT EXISTS connection_shares (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          share_type TEXT NOT NULL CHECK(share_type IN ('role', 'user')),
          target_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        database.run('CREATE INDEX IF NOT EXISTS idx_connection_shares_conn ON connection_shares(connection_id)');
        database.run('CREATE INDEX IF NOT EXISTS idx_connection_shares_target ON connection_shares(share_type, target_id)');

        // --- Seed built-in roles ---
        const adminPerms = JSON.stringify([
          'connections.create', 'connections.edit_own', 'connections.delete_own',
          'connections.edit_any', 'connections.delete_any', 'connections.share', 'connections.import_export',
          'sessions.view_own', 'sessions.view_any', 'sessions.delete',
          'audit.view_own', 'audit.view_any',
          'users.manage', 'settings.manage', 'settings.auth_providers', 'settings.security', 'settings.backup', 'settings.notifications',
          'roles.manage',
          'protocols.ssh', 'protocols.rdp', 'protocols.vnc', 'protocols.smb', 'protocols.ftp', 'protocols.telnet',
        ]);
        const userPerms = JSON.stringify([
          'connections.create', 'connections.edit_own', 'connections.delete_own', 'connections.share',
          'sessions.view_own',
          'audit.view_own',
          'protocols.ssh', 'protocols.rdp', 'protocols.vnc', 'protocols.smb', 'protocols.ftp', 'protocols.telnet',
        ]);
        database.run(
          `INSERT OR IGNORE INTO roles (id, name, description, is_builtin, permissions_json) VALUES (?, ?, ?, 1, ?)`,
          ['admin', 'Admin', 'Full system access — all permissions enabled', adminPerms],
        );
        database.run(
          `INSERT OR IGNORE INTO roles (id, name, description, is_builtin, permissions_json) VALUES (?, ?, ?, 1, ?)`,
          ['user', 'User', 'Standard user — manage own connections and sessions', userPerms],
        );

        // Migrate existing users.role text to match role IDs
        // The existing values are already 'admin' or 'user' which match our role IDs
      },
    },
    {
      version: 7,
      sql: `
        CREATE TABLE IF NOT EXISTS rdp_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          elapsed REAL NOT NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('click', 'key', 'move'))
        );
        CREATE INDEX IF NOT EXISTS idx_rdp_events_session ON rdp_events(session_id);
      `,
    },
    {
      version: 8,
      sql: `
        CREATE TABLE IF NOT EXISTS notification_channels (
          id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          config_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT OR IGNORE INTO notification_channels (id, enabled, config_json) VALUES
          ('smtp',     0, '{}'),
          ('telegram', 0, '{}'),
          ('slack',    0, '{}'),
          ('webhook',  0, '{}');

        CREATE TABLE IF NOT EXISTS notification_rules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          event TEXT NOT NULL,
          condition_logic TEXT NOT NULL DEFAULT 'AND',
          conditions_json TEXT NOT NULL DEFAULT '[]',
          cadence_json TEXT NOT NULL DEFAULT '{"type":"always"}',
          actions_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_triggered_at TEXT
        );

        CREATE TABLE IF NOT EXISTS notification_log (
          id TEXT PRIMARY KEY,
          rule_id TEXT,
          rule_name TEXT NOT NULL,
          channel TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('sent','failed')),
          error TEXT,
          payload_json TEXT,
          sent_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at ON notification_log(sent_at);
        CREATE INDEX IF NOT EXISTS idx_notification_log_rule_id ON notification_log(rule_id);
      `,
    },
    {
      version: 9,
      run: (database: Database) => {
        // Add settings.notifications to the existing admin role's permissions_json.
        // Migration v6 used INSERT OR IGNORE so existing rows were never updated.
        const row = database.exec(
          `SELECT permissions_json FROM roles WHERE id = 'admin'`,
        );
        if (!row.length || !row[0].values.length) return;
        const raw = row[0].values[0][0] as string;
        let perms: string[] = [];
        try { perms = JSON.parse(raw) as string[]; } catch { return; }
        if (!perms.includes('settings.notifications')) {
          perms.push('settings.notifications');
          database.run(
            `UPDATE roles SET permissions_json = ? WHERE id = 'admin'`,
            [JSON.stringify(perms)],
          );
        }
      },
    },
    {
      version: 10,
      run: (database: Database) => {
        // Migrate existing single-string event values to JSON arrays
        const rows = database.exec(`SELECT id, event FROM notification_rules`);
        if (!rows.length || !rows[0].values.length) return;
        for (const [id, event] of rows[0].values as [string, string][]) {
          const raw = (event ?? '*').trimStart();
          if (!raw.startsWith('[')) {
            database.run(
              `UPDATE notification_rules SET event = ? WHERE id = ?`,
              [JSON.stringify([raw]), id],
            );
          }
        }
      },
    },
    {
      version: 11,
      run: (database: Database) => {
        // Add per-connection TLS cert validation toggle (C5 security fix)
        try { database.run('ALTER TABLE connections ADD COLUMN skip_cert_validation INTEGER NOT NULL DEFAULT 1'); } catch { /* already exists */ }
      },
    },
    {
      version: 12,
      run: (database: Database) => {
        // Add connections.import_export to the existing user role's permissions_json.
        // The user role was seeded in migration v6 without this permission.
        const row = database.exec(`SELECT permissions_json FROM roles WHERE id = 'user'`);
        if (!row.length || !row[0].values.length) return;
        const raw = row[0].values[0][0] as string;
        let perms: string[] = [];
        try { perms = JSON.parse(raw) as string[]; } catch { return; }
        if (!perms.includes('connections.import_export')) {
          perms.push('connections.import_export');
          database.run(`UPDATE roles SET permissions_json = ? WHERE id = 'user'`, [JSON.stringify(perms)]);
        }
      },
    },
    {
      version: 13,
      run: (database: Database) => {
        // Add 'postgres' and 'mysql' to the connections protocol CHECK constraint.
        // SQLite requires table recreation to change CHECK constraints.
        database.run(`CREATE TABLE connections_v13 (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK(protocol IN ('ssh','rdp','smb','vnc','sftp','ftp','telnet','postgres','mysql')),
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
          tags TEXT,
          skip_cert_validation INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        database.run(`INSERT INTO connections_v13
          SELECT id, user_id, group_id, name, protocol, host, port, username, encrypted_password,
                 private_key, extra_config_json, sort_order, recording_enabled, shared, tunnels_json,
                 host_fingerprint, tags, skip_cert_validation, created_at, updated_at
          FROM connections`);
        database.run('DROP TABLE connections');
        database.run('ALTER TABLE connections_v13 RENAME TO connections');
        database.run('CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id)');

        // Create db_query_history table
        database.run(`CREATE TABLE IF NOT EXISTS db_query_history (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          query_text TEXT NOT NULL,
          row_count INTEGER,
          duration_ms INTEGER,
          error TEXT,
          executed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        database.run('CREATE INDEX IF NOT EXISTS idx_db_query_history_user_conn ON db_query_history(user_id, connection_id)');
        database.run('CREATE INDEX IF NOT EXISTS idx_db_query_history_executed ON db_query_history(executed_at)');

        // Add protocols.postgres and protocols.mysql to admin and user roles
        for (const roleId of ['admin', 'user']) {
          const row = database.exec(`SELECT permissions_json FROM roles WHERE id = '${roleId}'`);
          if (!row.length || !row[0].values.length) continue;
          const raw = row[0].values[0][0] as string;
          let perms: string[] = [];
          try { perms = JSON.parse(raw) as string[]; } catch { continue; }
          let changed = false;
          for (const perm of ['protocols.postgres', 'protocols.mysql']) {
            if (!perms.includes(perm)) { perms.push(perm); changed = true; }
          }
          if (changed) {
            database.run(`UPDATE roles SET permissions_json = ? WHERE id = '${roleId}'`, [JSON.stringify(perms)]);
          }
        }

        // Add db.* default settings
        database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES
          ('db.default_row_limit', '1000'),
          ('db.query_timeout_ms', '30000'),
          ('db.idle_timeout_minutes', '10'),
          ('db.max_pool_connections', '5')`);
      },
    },
    {
      version: 14,
      run: (database: Database) => {
        // Heal databases where v13 was partially applied: the schema_version row
        // was recorded but the connections table was never recreated (so it still
        // carries the old v5 CHECK constraint without 'postgres'/'mysql').
        // Detect by checking the table's CREATE SQL for the new protocols.
        const res = database.exec(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='connections'`,
        );
        const createSql = (res[0]?.values[0]?.[0] as string) ?? '';
        if (createSql.includes("'mysql'")) return; // already correct, nothing to do

        // Recreate with the full constraint
        database.run(`CREATE TABLE connections_v14 (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK(protocol IN ('ssh','rdp','smb','vnc','sftp','ftp','telnet','postgres','mysql')),
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
          tags TEXT,
          skip_cert_validation INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        database.run(`INSERT INTO connections_v14
          SELECT id, user_id, group_id, name, protocol, host, port, username, encrypted_password,
                 private_key, extra_config_json, sort_order, recording_enabled, shared, tunnels_json,
                 host_fingerprint, tags, skip_cert_validation, created_at, updated_at
          FROM connections`);
        database.run('DROP TABLE connections');
        database.run('ALTER TABLE connections_v14 RENAME TO connections');
        database.run('CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id)');
      },
    },
    {
      version: 15,
      run: (database: Database) => {
        database.run(`CREATE TABLE IF NOT EXISTS auto_backup_history (
          id TEXT PRIMARY KEY,
          trigger_type TEXT NOT NULL CHECK(trigger_type IN ('scheduled','manual')),
          status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT,
          duration_ms INTEGER,
          size_bytes INTEGER,
          filename TEXT,
          destination_mode TEXT NOT NULL CHECK(destination_mode IN ('saved','adhoc')),
          destination_label TEXT,
          include_recordings INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
        )`);
        database.run('CREATE INDEX IF NOT EXISTS idx_auto_backup_history_started ON auto_backup_history(started_at)');
        database.run('CREATE INDEX IF NOT EXISTS idx_auto_backup_history_status ON auto_backup_history(status)');

        database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES
          ('auto_backup.enabled', 'false'),
          ('auto_backup.destination_mode', 'saved'),
          ('auto_backup.connection_id', ''),
          ('auto_backup.remote_path', ''),
          ('auto_backup.schedule_type', 'daily'),
          ('auto_backup.schedule_time', '02:30'),
          ('auto_backup.schedule_weekday', '1'),
          ('auto_backup.include_recordings', 'false'),
          ('auto_backup.retention_count', '14'),
          ('auto_backup.password_enc', ''),
          ('auto_backup.adhoc_enc', ''),
          ('auto_backup.next_run_at', ''),
          ('auto_backup.last_run_at', ''),
          ('auto_backup.last_status', ''),
          ('auto_backup.last_error', ''),
          ('auto_backup.last_filename', ''),
          ('auto_backup.last_size_bytes', '0'),
          ('auto_backup.consecutive_failures', '0'),
          ('auto_backup.auto_disabled', 'false')`);
      },
    },
    {
      version: 16,
      run: (database: Database) => {
        // Passkeys (WebAuthn) support
        database.run(`CREATE TABLE IF NOT EXISTS user_passkeys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_id TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL,
          sign_count INTEGER NOT NULL DEFAULT 0,
          transports TEXT,
          aaguid TEXT,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          disabled_at TEXT,
          revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          revoked_reason TEXT
        )`);
        database.run('CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id)');
        database.run('CREATE INDEX IF NOT EXISTS idx_user_passkeys_credential ON user_passkeys(credential_id)');

        // Passkey challenges (ephemeral, cleaned up periodically)
        database.run(`CREATE TABLE IF NOT EXISTS passkey_challenges (
          id TEXT PRIMARY KEY,
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          challenge TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('registration', 'authentication')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        )`);
        database.run('CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user ON passkey_challenges(user_id)');

        // Add passkey-related settings
        database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES
          ('security.passkey_enabled', 'true'),
          ('security.passkey_inactive_days', '90')`);

        // Add mfa_method column to users table to track which MFA method is active
        try { database.run('ALTER TABLE users ADD COLUMN mfa_method TEXT'); } catch { /* already exists */ }
      },
    },
  ];

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      if (migration.sql) {
        db.run(migration.sql);
      } else if (migration.run) {
        migration.run(db);
      }
      db.run('INSERT INTO schema_version (version) VALUES (?)', [migration.version]);
      console.log(`[DB] Applied migration v${migration.version}`);
    }
  }
}
