import { queryAll, execute } from '../db/helpers.js';

const DEFAULTS: Record<string, string> = {
  'app.name': 'Gatwy',
  'app.logo': '',
  'app.timezone': 'UTC',
  'security.session_timeout_minutes': '0',
  'security.max_failed_logins': '5',
  'security.lockout_minutes': '30',
  'security.trusted_proxies': '',
  'security.proxy_detection_enabled': 'true',
  'security.max_connections_per_user': '10',
  'security.ip_rules_enabled': 'false',
  'security.ip_rules_mode': 'allowlist',
  'audit.retention_days': '90',
  'notifications.log_retention_days': '90',
  'session.recording_enabled': 'false',
  'session.recording_retention_days': '90',
  'session.recording_retention_days_enabled': 'true',
  'session.recording_retention_size_enabled': 'false',
  'session.recording_retention_max_size_gb': '10',
  'health_monitor.enabled': 'true',
  'version.audit_log_checks': 'true',
  'version.toast_feedback': 'true',
  'version.notify_on_update': 'false',
  'ssh.font_size': '14',
  'ssh.font_family': 'Cascadia Code, Fira Code, Menlo, Monaco, Courier New, monospace',
  'ssh.scrollback': '5000',
  'ssh.cursor_style': 'block',
  'rdp.default_port': '3389',
  'rdp.default_width': '1920',
  'rdp.default_height': '1080',
  'auth.local_enabled': 'true',
  'auth.ldap_enabled': 'false',
  'auth.ldap_url': '',
  'auth.ldap_bind_dn': '',
  'auth.ldap_bind_password': '',
  'auth.ldap_search_base': '',
  'auth.ldap_user_filter': '(uid={username})',
  'auth.ldap_username_attr': 'uid',
  'auth.ldap_email_attr': 'mail',
  'auth.ldap_display_name_attr': 'cn',
  'auth.ldap_admin_group_dn': '',
  'auth.ldap_tls_reject_unauthorized': 'true',
  'auth.oidc_enabled': 'false',
  'auth.oidc_provider_url': '',
  'auth.oidc_client_id': '',
  'auth.oidc_client_secret': '',
  'auth.oidc_redirect_uri': '',
  'auth.oidc_scope': 'openid email profile',
  'auth.oidc_display_name_claim': 'name',
  'auth.oidc_username_claim': 'preferred_username',
  'auth.oidc_admin_group_claim': '',
  'auth.oidc_admin_group_value': '',
  'auth.oidc_button_label': 'Sign in with SSO',
  'auto_backup.enabled': 'false',
  'auto_backup.destination_mode': 'saved',
  'auto_backup.connection_id': '',
  'auto_backup.remote_path': '',
  'auto_backup.schedule_type': 'daily',
  'auto_backup.schedule_time': '02:30',
  'auto_backup.schedule_weekday': '1',
  'auto_backup.include_recordings': 'false',
  'auto_backup.retention_count': '14',
  'auto_backup.password_enc': '',
  'auto_backup.adhoc_enc': '',
  'auto_backup.next_run_at': '',
  'auto_backup.last_run_at': '',
  'auto_backup.last_status': '',
  'auto_backup.last_error': '',
  'auto_backup.last_filename': '',
  'auto_backup.last_size_bytes': '0',
  'auto_backup.consecutive_failures': '0',
  'auto_backup.auto_disabled': 'false',
};

interface SettingRow { key: string; value: string; }

export function getSetting(key: string): string {
  const rows = queryAll<SettingRow>('SELECT value FROM settings WHERE key = ?', [key]);
  return rows.length > 0 ? rows[0].value : (DEFAULTS[key] ?? '');
}

export function getAllSettings(): Record<string, string> {
  const rows = queryAll<SettingRow>('SELECT key, value FROM settings');
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function setSetting(key: string, value: string): void {
  execute(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  );
}

export function setSettings(updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) setSetting(key, value);
}
