import { queryOne } from '../db/helpers.js';

/** All recognised permission keys */
export const ALL_PERMISSIONS = [
  'connections.create', 'connections.edit_own', 'connections.delete_own',
  'connections.edit_any', 'connections.delete_any', 'connections.share', 'connections.import_export',
  'sessions.view_own', 'sessions.view_any', 'sessions.delete',
  'audit.view_own', 'audit.view_any',
  'users.manage', 'settings.manage', 'settings.auth_providers', 'settings.security', 'settings.backup', 'settings.notifications',
  'roles.manage',
  'protocols.ssh', 'protocols.rdp', 'protocols.vnc', 'protocols.moonlight', 'protocols.smb', 'protocols.ftp', 'protocols.telnet',
  'protocols.postgres', 'protocols.mysql',
] as const;

export type PermissionKey = typeof ALL_PERMISSIONS[number];

/** Default permissions for built-in roles */
export const DEFAULT_BUILTIN_PERMISSIONS: Record<string, PermissionKey[]> = {
  admin: [...ALL_PERMISSIONS],
  user: [
    'connections.create', 'connections.edit_own', 'connections.delete_own', 'connections.share', 'connections.import_export',
    'sessions.view_own',
    'audit.view_own',
    'protocols.ssh', 'protocols.rdp', 'protocols.vnc', 'protocols.moonlight', 'protocols.smb', 'protocols.ftp', 'protocols.telnet',
    'protocols.postgres', 'protocols.mysql',
  ],
};

/** Human-friendly permission groups for UI */
export const PERMISSION_GROUPS: Record<string, { label: string; permissions: { key: PermissionKey; label: string }[] }> = {
  connections: {
    label: 'Connections',
    permissions: [
      { key: 'connections.create', label: 'Create connections' },
      { key: 'connections.edit_own', label: 'Edit own connections' },
      { key: 'connections.delete_own', label: 'Delete own connections' },
      { key: 'connections.edit_any', label: 'Edit any connection' },
      { key: 'connections.delete_any', label: 'Delete any connection' },
      { key: 'connections.share', label: 'Share connections' },
      { key: 'connections.import_export', label: 'Import / Export connections' },
    ],
  },
  sessions: {
    label: 'Sessions & Recordings',
    permissions: [
      { key: 'sessions.view_own', label: 'View own recordings' },
      { key: 'sessions.view_any', label: 'View all recordings' },
      { key: 'sessions.delete', label: 'Delete / purge recordings' },
    ],
  },
  audit: {
    label: 'Audit Log',
    permissions: [
      { key: 'audit.view_own', label: 'View own audit entries' },
      { key: 'audit.view_any', label: 'View all audit entries' },
    ],
  },
  admin: {
    label: 'Administration',
    permissions: [
      { key: 'users.manage', label: 'Manage users' },
      { key: 'settings.manage', label: 'Global settings' },
      { key: 'settings.auth_providers', label: 'Auth providers' },
      { key: 'settings.security', label: 'Security settings' },
      { key: 'settings.backup', label: 'Backup & restore' },
      { key: 'settings.notifications', label: 'Notifications' },
      { key: 'roles.manage', label: 'Manage roles' },
    ],
  },
  protocols: {
    label: 'Protocols',
    permissions: [
      { key: 'protocols.ssh', label: 'SSH' },
      { key: 'protocols.rdp', label: 'RDP' },
      { key: 'protocols.vnc', label: 'VNC' },
      { key: 'protocols.moonlight', label: 'Moonlight / Sunshine' },
      { key: 'protocols.smb', label: 'SMB' },
      { key: 'protocols.ftp', label: 'FTP' },
      { key: 'protocols.telnet', label: 'Telnet' },
      { key: 'protocols.postgres', label: 'PostgreSQL' },
      { key: 'protocols.mysql', label: 'MySQL / MariaDB' },
    ],
  },
};

/**
 * Resolve the permission set for a given role ID.
 * Returns the parsed JSON array from the roles table.
 */
export function getPermissionsForRole(roleId: string): string[] {
  const row = queryOne<{ permissions_json: string }>('SELECT permissions_json FROM roles WHERE id = ?', [roleId]);
  if (!row) return [];
  try {
    return JSON.parse(row.permissions_json) as string[];
  } catch {
    return [];
  }
}

/**
 * Check whether a role has a specific permission.
 */
export function roleHasPermission(roleId: string, perm: PermissionKey): boolean {
  return getPermissionsForRole(roleId).includes(perm);
}

/**
 * Check whether a user (by ID) has a specific permission.
 * Looks up their role from the users table then checks the role's permissions.
 */
export function userHasPermission(userId: string, perm: PermissionKey): boolean {
  const user = queryOne<{ role: string }>('SELECT role FROM users WHERE id = ?', [userId]);
  if (!user) return false;
  return roleHasPermission(user.role, perm);
}

/**
 * Build SQL WHERE clause + params for connection access (used by WS proxies).
 * Checks ownership, shared=1, or connection_shares matching user/role.
 */
export function wsCanAccess(userId: string): { where: string; params: unknown[] } {
  const user = queryOne<{ role: string }>('SELECT role FROM users WHERE id = ?', [userId]);
  const role = user?.role ?? '';
  return {
    where: '(user_id = ? OR shared = 1 OR id IN (SELECT cs.connection_id FROM connection_shares cs WHERE (cs.share_type = \'user\' AND cs.target_id = ?) OR (cs.share_type = \'role\' AND cs.target_id = ?)))',
    params: [userId, userId, role],
  };
}
