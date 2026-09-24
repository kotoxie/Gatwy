import { queryOne, queryAll } from '../db/helpers.js';

/** All recognised permission keys */
export const ALL_PERMISSIONS = [
  'connections.create', 'connections.edit_own', 'connections.delete_own',
  'connections.edit_any', 'connections.delete_any', 'connections.share', 'connections.import_export',
  'credentials.share', 'credentials.use_shared',
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
  credentials: {
    label: 'Credential Library',
    permissions: [
      { key: 'credentials.share', label: 'Create & manage shared credentials' },
      { key: 'credentials.use_shared', label: 'Use shared credentials in own connections' },
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
 * Whether the connection_groups row `groupId` exists and is owned by `ownerId`.
 * Single source of truth for the cross-owner nesting guard: a connection or a
 * sub-folder may only be filed under / reparented onto a folder its own owner
 * holds — never a folder merely shared to them — or it would be grafted into
 * whatever that folder is shared with.
 */
export function groupOwnedBy(groupId: string, ownerId: string): boolean {
  const row = queryOne<{ user_id: string }>('SELECT user_id FROM connection_groups WHERE id = ?', [groupId]);
  return !!row && row.user_id === ownerId;
}

/**
 * BFS from `rootIds` through connection_groups, descending into a child only when its
 * owner matches its parent's owner — a group grafted (via parent_id) under someone
 * else's folder must never inherit whatever that folder is reachable through.
 * Shared by accessibleSharedGroupIds (roots = directly-shared groups) and
 * descendantGroupIds (root = a single folder, e.g. the one just being shared).
 */
function ownerScopedDescendants(rootIds: string[]): string[] {
  if (rootIds.length === 0) return [];

  const allGroups = queryAll<{ id: string; parent_id: string | null; user_id: string }>(
    'SELECT id, parent_id, user_id FROM connection_groups',
  );
  const ownerOf = new Map(allGroups.map((g) => [g.id, g.user_id]));
  const childrenOf = new Map<string, string[]>();
  for (const g of allGroups) {
    if (!g.parent_id) continue;
    const list = childrenOf.get(g.parent_id) ?? [];
    list.push(g.id);
    childrenOf.set(g.parent_id, list);
  }

  // A root that no longer exists (deleted group, stale share row) seeds nothing.
  const validRoots = rootIds.filter((id) => ownerOf.has(id));
  if (validRoots.length === 0) return [];

  const result = new Set<string>();
  const queue = [...validRoots];
  while (queue.length > 0) {
    const gid = queue.pop()!;
    if (result.has(gid)) continue;
    result.add(gid);
    const owner = ownerOf.get(gid);
    for (const child of childrenOf.get(gid) ?? []) {
      if (ownerOf.get(child) === owner) queue.push(child);
    }
  }
  return [...result];
}

/**
 * All connection_group IDs reachable via a folder share to this user/role: the directly
 * shared groups plus every descendant. Resolved fresh on every call (never materialized
 * into per-connection rows), so a new sub-folder or a new connection dropped into an
 * already-shared folder inherits access immediately — no share row needs to be copied.
 */
export function accessibleSharedGroupIds(userId: string, role: string): string[] {
  const directRows = queryAll<{ resource_id: string }>(
    `SELECT DISTINCT resource_id FROM resource_shares WHERE resource_type = 'group' AND ((share_type = 'user' AND target_id = ?) OR (share_type = 'role' AND target_id = ?))`,
    [userId, role],
  );
  return ownerScopedDescendants(directRows.map((r) => r.resource_id));
}

/**
 * A folder plus every owner-scoped descendant beneath it — the full subtree that
 * becomes reachable when `rootId` itself is shared, regardless of who it's shared with.
 * Used to scan the about-to-be-shared subtree for connections whose credentials won't
 * actually be visible to the recipients (see connectionsWithUnshareableCredential).
 */
export function descendantGroupIds(rootId: string): string[] {
  return ownerScopedDescendants([rootId]);
}

/**
 * Every connection_group ID reachable via a folder share to this user/role at
 * `capability = 'edit'` — same shape as accessibleSharedGroupIds, filtered to editor
 * shares only. Used to gate the collaborator write routes (create/modify/delete inside
 * a shared folder); accessibleSharedGroupIds (any capability) still gates read access.
 */
export function editableSharedGroupIds(userId: string, role: string): string[] {
  const directRows = queryAll<{ resource_id: string }>(
    `SELECT DISTINCT resource_id FROM resource_shares
     WHERE resource_type = 'group' AND capability = 'edit'
       AND ((share_type = 'user' AND target_id = ?) OR (share_type = 'role' AND target_id = ?))`,
    [userId, role],
  );
  return ownerScopedDescendants(directRows.map((r) => r.resource_id));
}

/** True when `groupId` is writable by `userId` as an editor collaborator (not owner). */
export function canWriteSharedGroup(groupId: string, userId: string, role: string): boolean {
  return editableSharedGroupIds(userId, role).includes(groupId);
}

/**
 * Every directly-shared (capability='edit') group that is an ancestor-or-self of `groupId`
 * and grants this user/role write access to it — i.e. every distinct shared-folder "branch"
 * `groupId` is reachable through. Used to confine an editor's reparenting to sub-folders of
 * the SAME shared folder, within one such branch — canWriteSharedGroup alone only
 * proves a folder is writable, not that it's part of the specific branch being reorganized,
 * so an editor holding two independent edit-shares from the same owner could otherwise use
 * one to reach into the other.
 */
export function editableSharedRootsFor(groupId: string, userId: string, role: string): Set<string> {
  const directRows = queryAll<{ resource_id: string }>(
    `SELECT DISTINCT resource_id FROM resource_shares
     WHERE resource_type = 'group' AND capability = 'edit'
       AND ((share_type = 'user' AND target_id = ?) OR (share_type = 'role' AND target_id = ?))`,
    [userId, role],
  );
  const roots = new Set<string>();
  for (const row of directRows) {
    if (ownerScopedDescendants([row.resource_id]).includes(groupId)) roots.add(row.resource_id);
  }
  return roots;
}

/** True when `sourceGroupId` and `targetGroupId` share at least one common editable-share
 * branch (see editableSharedRootsFor) — the boundary that confines editor reparenting. */
export function sameSharedBranch(sourceGroupId: string, targetGroupId: string, userId: string, role: string): boolean {
  const sourceRoots = editableSharedRootsFor(sourceGroupId, userId, role);
  if (sourceRoots.size === 0) return false;
  const targetRoots = editableSharedRootsFor(targetGroupId, userId, role);
  for (const r of targetRoots) if (sourceRoots.has(r)) return true;
  return false;
}

/**
 * True when `groupId` is referenced by ANY folder share, regardless of who it was shared
 * with or who is asking — not just whichever share granted the current caller access.
 * Editor collaborators may write inside a shared folder's contents, but must never be able
 * to rename/delete the shared folder itself, or an independently-shared sub-folder nested
 * inside it (that would silently destroy someone else's share when resource_shares had no
 * FK left to cascade it automatically — see the cascade-delete cleanup in routes/connections.ts).
 */
export function isSharedGroup(groupId: string): boolean {
  return !!queryOne<{ id: string }>(
    `SELECT id FROM resource_shares WHERE resource_type = 'group' AND resource_id = ? LIMIT 1`,
    [groupId],
  );
}

/**
 * Same guard as isSharedGroup, for a single connection: true when `connectionId` carries
 * any share of its own. An editor collaborator may not delete a connection while this is
 * true — deleting it would silently destroy that share, since resource_shares has no FK
 * cascade to fall back on. The owner (or connections.delete_any) is never subject to this
 * check — see the DELETE routes in routes/connections.ts.
 */
export function isSharedConnection(connectionId: string): boolean {
  return !!queryOne<{ id: string }>(
    `SELECT id FROM resource_shares WHERE resource_type = 'connection' AND resource_id = ? LIMIT 1`,
    [connectionId],
  );
}

/**
 * Every connection_group ID that will actually be removed by SQLite's ON DELETE CASCADE
 * (connection_groups.parent_id → connection_groups.id) when `rootId` is deleted — the
 * root plus ALL descendants, regardless of owner. Unlike ownerScopedDescendants (used for
 * permission checks, where a cross-owner "planted" child must never inherit access), a
 * cleanup walk must not skip that child: SQLite will delete its row anyway, so any
 * resource_shares referencing it would be left orphaned if this walk stopped early.
 */
export function allDescendantGroupIdsUnscoped(rootId: string): string[] {
  const allGroups = queryAll<{ id: string; parent_id: string | null }>(
    'SELECT id, parent_id FROM connection_groups',
  );
  const childrenOf = new Map<string, string[]>();
  for (const g of allGroups) {
    if (!g.parent_id) continue;
    const list = childrenOf.get(g.parent_id) ?? [];
    list.push(g.id);
    childrenOf.set(g.parent_id, list);
  }
  if (!allGroups.some((g) => g.id === rootId)) return [];

  const result = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const gid = queue.pop()!;
    if (result.has(gid)) continue;
    result.add(gid);
    for (const child of childrenOf.get(gid) ?? []) queue.push(child);
  }
  return [...result];
}

/**
 * Walks UP from `groupId` through parent_id (the opposite direction of every other helper
 * in this file, which all walk down) to tell whether `groupId` or any ancestor is itself
 * shared as a folder. Used to extend the private-credential warning (see
 * connectionsWithUnshareableCredential) to connection create/update, not just to saving a
 * folder's shares: a connection filed under an already-shared folder is retroactively
 * affected the same way a newly-shared folder's existing connections are.
 */
export function isInsideSharedGroup(groupId: string | null): boolean {
  let current = groupId;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) return false; // defensive: a cyclic parent_id chain should never exist
    visited.add(current);
    if (isSharedGroup(current)) return true;
    const row = queryOne<{ parent_id: string | null }>(
      'SELECT parent_id FROM connection_groups WHERE id = ?', [current],
    );
    current = row?.parent_id ?? null;
  }
  return false;
}

/**
 * Build a SQL WHERE fragment + params: true when a connection is owned by, globally
 * shared to, individually shared to, or reachable via a shared parent folder for, the
 * given user/role. Single source of truth for connection access — every route that
 * gates connection access (SFTP/FTP/SMB/DB, sessions, WS proxies, the connections list)
 * must go through this rather than re-deriving the condition.
 */
export function connectionAccessWhere(alias: string, userId: string, role: string): { where: string; params: unknown[] } {
  const sharedGroups = accessibleSharedGroupIds(userId, role);
  // Require the connection's owner to match its folder's actual owner, not just group_id
  // membership — otherwise a connection "planted" (by direct DB write, or a bug elsewhere)
  // into someone else's shared folder would be reachable by everyone that folder is shared
  // with. Write-side routes already reject a mismatched groupId; this is defense in depth.
  const groupClause = sharedGroups.length > 0
    ? ` OR (${alias}.group_id IN (${sharedGroups.map(() => '?').join(',')}) AND ${alias}.user_id = (SELECT cg.user_id FROM connection_groups cg WHERE cg.id = ${alias}.group_id))`
    : '';
  return {
    where: `(${alias}.user_id = ? OR ${alias}.shared = 1 OR ${alias}.id IN (SELECT rs.resource_id FROM resource_shares rs WHERE rs.resource_type = 'connection' AND ((rs.share_type = 'user' AND rs.target_id = ?) OR (rs.share_type = 'role' AND rs.target_id = ?)))${groupClause})`,
    params: [userId, userId, role, ...sharedGroups],
  };
}

/**
 * Build SQL WHERE clause + params for connection access (used by WS proxies).
 * Checks ownership, shared=1, resource_shares, and shared-folder inheritance.
 */
export function wsCanAccess(userId: string): { where: string; params: unknown[] } {
  const user = queryOne<{ role: string }>('SELECT role FROM users WHERE id = ?', [userId]);
  const role = user?.role ?? '';
  return connectionAccessWhere('connections', userId, role);
}
