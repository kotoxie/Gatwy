import { Router, type Request, type Response } from 'express';
import net from 'net';
import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute } from '../db/helpers.js';
import { authRequired, userCan } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { logAudit } from '../services/audit.js';
import { applyCredential, checkCredentialAssignable, connectionsWithUnshareableCredential, isConnectionShared } from '../services/credentials.js';
import { prepareKey } from '../services/sshKeys.js';
import { filterListedConnections, isMoonlightWebAvailable, runtimeFeatures } from '../services/moonlightWeb.js';
import {
  accessibleSharedGroupIds, connectionAccessWhere, descendantGroupIds, groupOwnedBy,
  editableSharedGroupIds, canWriteSharedGroup, isSharedGroup, isSharedConnection,
  allDescendantGroupIdsUnscoped, isInsideSharedGroup, sameSharedBranch,
} from '../services/permissions.js';

const ALL_PROTOCOLS = ['ssh', 'rdp', 'smb', 'vnc', 'moonlight', 'sftp', 'ftp', 'telnet', 'postgres', 'mysql'] as const;

function createProtocols(): readonly string[] {
  return isMoonlightWebAvailable()
    ? ALL_PROTOCOLS
    : ALL_PROTOCOLS.filter((p) => p !== 'moonlight');
}

const router = Router();
router.use(authRequired);

/**
 * Prepare an inline (passphrase-less) private key for storage — PKCS#8 keys are
 * converted to a format ssh2 reads. Returns the key to store (null when none
 * was given), or an error message.
 */
function prepareInlineKey(privateKey: unknown): { key: string | null } | { error: string } {
  if (typeof privateKey !== 'string' || !privateKey.trim()) return { key: null };
  const prepared = prepareKey(privateKey);
  if ('error' in prepared) {
    return {
      error: /passphrase/i.test(prepared.error)
        ? 'This private key is encrypted. Connections can\'t store a key passphrase — save the key with its passphrase in Settings → Credentials and select it here.'
        : prepared.error,
    };
  }
  return { key: prepared.key.privateKey };
}

interface ConnectionRow {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  group_id: string | null;
  user_id: string;
  username: string | null;
  encrypted_password: string | null;
  private_key: string | null;
  sort_order: number;
  recording_enabled: number;
  shared: number;
  tunnels_json: string | null;
  extra_config_json: string | null;
  tags: string | null;
  skip_cert_validation: number;
  credential_id: string | null;
}

interface GroupRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

/** True if the payload asks to create a connection as globally shared without connections.share. */
function blockedSharedCreate(req: Request, sharedValue: unknown): boolean {
  return !!sharedValue && !userCan(req, 'connections.share');
}

/**
 * True if the payload actually changes the `shared` flag (vs. its current value) and the
 * caller lacks connections.share. Comparing against the existing value — instead of just
 * `shared !== undefined` — matters because the connection edit form always sends `shared`
 * on every save, even when the user didn't touch it; otherwise every edit by a non-sharing
 * role would 403.
 */
function blockedSharedUpdate(req: Request, sharedValue: unknown, existingShared: number): boolean {
  if (sharedValue === undefined) return false;
  const next = sharedValue ? 1 : 0;
  return next !== existingShared && !userCan(req, 'connections.share');
}

/** Folder name for an audit log entry — readable in place of a raw group_id, and stable
 * even if the folder is later renamed (this resolves it at the time of the action). */
function groupNameForAudit(groupId: string | null): string | null {
  if (!groupId) return null;
  const row = queryOne<{ name: string }>('SELECT name FROM connection_groups WHERE id = ?', [groupId]);
  return row?.name ?? null;
}

/** Attaches a human-readable targetName (role name or username) to each share entry,
 * so an audit log entry stays readable instead of just showing raw role/user ids. */
function resolveShareTargetNames(
  entries: { shareType: string; targetId: string; capability?: string }[],
): { shareType: string; targetId: string; targetName: string; capability?: string }[] {
  const roleIds = entries.filter((e) => e.shareType === 'role').map((e) => e.targetId);
  const userIds = entries.filter((e) => e.shareType === 'user').map((e) => e.targetId);
  const roleNames = new Map<string, string>();
  const userNames = new Map<string, string>();
  if (roleIds.length > 0) {
    queryAll<{ id: string; name: string }>(
      `SELECT id, name FROM roles WHERE id IN (${roleIds.map(() => '?').join(',')})`,
      roleIds,
    ).forEach((r) => roleNames.set(r.id, r.name));
  }
  if (userIds.length > 0) {
    queryAll<{ id: string; username: string }>(
      `SELECT id, username FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
      userIds,
    ).forEach((u) => userNames.set(u.id, u.username));
  }
  return entries.map((e) => ({
    ...e,
    targetName: e.shareType === 'role' ? (roleNames.get(e.targetId) ?? e.targetId) : (userNames.get(e.targetId) ?? e.targetId),
  }));
}

// List connections and groups
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const userRole = req.user!.role;

  const groups = queryAll<GroupRow>(
    'SELECT id, name, parent_id, sort_order FROM connection_groups WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE ASC',
    [userId],
  );

  // Which of the caller's own folders have been directly shared out (not just reachable
  // via an ancestor's share) — lets the client mark them for the owner without exposing
  // the recipient list itself.
  const ownSharedGroupIdSet = new Set<string>();
  if (groups.length > 0) {
    const ownGroupPlaceholders = groups.map(() => '?').join(',');
    queryAll<{ resource_id: string }>(
      `SELECT DISTINCT resource_id FROM resource_shares WHERE resource_type = 'group' AND resource_id IN (${ownGroupPlaceholders})`,
      groups.map((g) => g.id),
    ).forEach((r) => ownSharedGroupIdSet.add(r.resource_id));
  }

  const connections = filterListedConnections(queryAll<ConnectionRow>(
    'SELECT id, name, protocol, host, port, group_id, username, sort_order, shared, tags FROM connections WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE ASC',
    [userId],
  ));

  // Which of the caller's own connections are shared out (globally, or to a specific
  // role/user) — lets the client mark them for the owner, mirroring folder isSharedOut.
  const ownSharedConnectionIdSet = new Set<string>();
  connections.forEach((c) => { if (c.shared === 1) ownSharedConnectionIdSet.add(c.id); });
  if (connections.length > 0) {
    const ownConnPlaceholders = connections.map(() => '?').join(',');
    queryAll<{ resource_id: string }>(
      `SELECT DISTINCT resource_id FROM resource_shares WHERE resource_type = 'connection' AND resource_id IN (${ownConnPlaceholders})`,
      connections.map((c) => c.id),
    ).forEach((r) => ownSharedConnectionIdSet.add(r.resource_id));
  }

  // Folders (owned by someone else) reachable via a folder share — resolved live, so a
  // new sub-folder or connection dropped in later shows up without any extra share row.
  const sharedGroupIdList = accessibleSharedGroupIds(userId, userRole);
  let sharedGroupRows: (GroupRow & { user_id: string; owner_display_name: string | null })[] = [];
  let sharedGroupConnRows: ConnectionRow[] = [];
  if (sharedGroupIdList.length > 0) {
    const groupPlaceholders = sharedGroupIdList.map(() => '?').join(',');
    // owner_display_name: who to show the recipient in "Shared by <name>" — joined here so
    // it's available on every node of the shared tree (see the sharedGroupMap loop below),
    // not just the directly-shared root. LEFT JOIN, not JOIN: an INNER join would drop any
    // shared group (and its connections, sourced from these rows below) whose owner row is
    // gone — FK enforcement doesn't actually run in this app (see users.ts), so a deleted
    // owner's groups can outlive them. Losing the folder from the recipient's tree over a
    // missing label would be worse than showing it without one.
    sharedGroupRows = queryAll<GroupRow & { user_id: string; owner_display_name: string | null }>(
      `SELECT cg.id, cg.name, cg.parent_id, cg.sort_order, cg.user_id, u.display_name AS owner_display_name
       FROM connection_groups cg
       LEFT JOIN users u ON u.id = cg.user_id
       WHERE cg.id IN (${groupPlaceholders}) AND cg.user_id != ?`,
      [...sharedGroupIdList, userId],
    );
    if (sharedGroupRows.length > 0) {
      const ownedSharedGroupIds = sharedGroupRows.map((g) => g.id);
      const connPlaceholders = ownedSharedGroupIds.map(() => '?').join(',');
      const groupOwnerById = new Map(sharedGroupRows.map((g) => [g.id, g.user_id]));
      // Defense in depth: only surface a connection whose owner matches its folder's owner,
      // so a connection can't be "planted" into someone else's shared folder to leak into it.
      sharedGroupConnRows = filterListedConnections(queryAll<ConnectionRow>(
        `SELECT id, name, protocol, host, port, group_id, username, sort_order, shared, tags, user_id FROM connections WHERE group_id IN (${connPlaceholders}) ORDER BY sort_order, name COLLATE NOCASE ASC`,
        ownedSharedGroupIds,
      )).filter((c) => c.group_id && groupOwnerById.get(c.group_id) === c.user_id);
    }
  }
  const sharedGroupIdSet = new Set(sharedGroupRows.map((g) => g.id));

  // Individually-shared connections from other users (shared=1, or resource_shares) —
  // excluding any already reachable via a shared folder above, to avoid listing twice.
  const sharedConnections = filterListedConnections(queryAll<ConnectionRow>(
    `SELECT DISTINCT c.id, c.name, c.protocol, c.host, c.port, c.username, c.shared, c.user_id, c.tags, c.group_id
     FROM connections c
     WHERE c.user_id != ?
       AND (c.shared = 1
            OR c.id IN (SELECT rs.resource_id FROM resource_shares rs
                        WHERE rs.resource_type = 'connection'
                          AND ((rs.share_type = 'user' AND rs.target_id = ?)
                           OR (rs.share_type = 'role' AND rs.target_id = ?))))
     ORDER BY c.name`,
    [userId, userId, userRole],
  )).filter((c) => !c.group_id || !sharedGroupIdSet.has(c.group_id));

  // Build tree
  interface GroupNode {
    id: string;
    name: string;
    parentId: string | null;
    children: GroupNode[];
    connections: { id: string; name: string; protocol: string; host: string; port: number; groupId: string | null; isShared: boolean; isSharedOut: boolean; tags: string[] }[];
    isSharedOut: boolean;
    /** Set only on nodes in the shared-folder tree: the caller's access level to this folder
     * and everything inside it (inherited down the subtree, same as the access itself). */
    capability?: 'view' | 'edit';
    /** Set only on nodes in the shared-folder tree: true when this exact folder carries a
     * share of its own (isSharedGroup) — the client must never offer rename/delete/share
     * management on it even with edit capability, or an editor could destroy a share
     * unrelated to them. */
    locked?: boolean;
    /** Set only on nodes in the shared-folder tree (never on the owner's own rootGroups):
     * the display name of the user who owns this folder, so a recipient's right-click menu
     * can show "Shared by <name>" — on every node of the branch, not just the directly-
     * shared root, since a right-click on a sub-folder needs it too. */
    ownerName?: string;
  }

  function buildTree(rows: GroupRow[]): { map: Map<string, GroupNode>; roots: GroupNode[] } {
    const map = new Map<string, GroupNode>();
    for (const g of rows) {
      map.set(g.id, { id: g.id, name: g.name, parentId: g.parent_id, children: [], connections: [], isSharedOut: ownSharedGroupIdSet.has(g.id) });
    }
    const roots: GroupNode[] = [];
    for (const g of map.values()) {
      if (g.parentId && map.has(g.parentId)) {
        map.get(g.parentId)!.children.push(g);
      } else {
        roots.push(g);
      }
    }
    return { map, roots };
  }

  function mapConn(c: ConnectionRow, isShared: boolean, isSharedOut = false) {
    return {
      id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port, groupId: c.group_id, isShared, isSharedOut,
      tags: c.tags ? JSON.parse(c.tags) as string[] : [],
    };
  }

  const { map: groupMap, roots: rootGroups } = buildTree(groups);
  const connMapped = connections.map((c) => mapConn(c, false, ownSharedConnectionIdSet.has(c.id)));
  for (const conn of connMapped) {
    if (conn.groupId && groupMap.has(conn.groupId)) {
      groupMap.get(conn.groupId)!.connections.push(conn);
    }
  }
  const ungrouped = connMapped.filter((c) => !c.groupId || !groupMap.has(c.groupId));

  // Shared-folder tree — preserves the owner's hierarchy under each directly-shared folder
  // (its own unshared ancestors, if any, are simply not part of the tree).
  const { map: sharedGroupMap, roots: sharedRootGroups } = buildTree(sharedGroupRows);
  const editableGroupIdSet = new Set(editableSharedGroupIds(userId, userRole));
  const ownerNameByGroupId = new Map(sharedGroupRows.map((g) => [g.id, g.owner_display_name]));
  for (const node of sharedGroupMap.values()) {
    node.capability = editableGroupIdSet.has(node.id) ? 'edit' : 'view';
    node.locked = isSharedGroup(node.id);
    node.ownerName = ownerNameByGroupId.get(node.id) ?? undefined;
  }
  const sharedGroupConnMapped = sharedGroupConnRows.map((c) => mapConn(c, true));
  for (const conn of sharedGroupConnMapped) {
    if (conn.groupId && sharedGroupMap.has(conn.groupId)) {
      sharedGroupMap.get(conn.groupId)!.connections.push(conn);
    }
  }

  const sharedMapped = sharedConnections.map((c) => ({ ...mapConn(c, true), groupId: null }));

  res.json({
    groups: rootGroups,
    ungrouped,
    sharedConnections: sharedMapped,
    sharedGroups: sharedRootGroups,
    features: runtimeFeatures(),
  });
});

// Helper: check if IP is in a private/loopback/link-local range
// Block only loopback and cloud metadata endpoints — NOT private RFC-1918 ranges,
// since users legitimately connect to internal servers on those addresses.
// SSRF is already mitigated: hosts are resolved from the DB, never from user input.
function isDangerousHost(host: string): boolean {
  const dangerous = [
    /^127\./,
    /^169\.254\./,   // link-local / cloud metadata (AWS, Azure, GCP)
    /^::1$/,
    /^localhost$/i,
  ];
  return dangerous.some((p) => p.test(host));
}

// POST /health-check — TCP reachability for multiple connections
router.post('/health-check', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { checks } = req.body as { checks: { id: string; host: string; port: number }[] };
  if (!Array.isArray(checks)) { res.status(400).json({ error: 'checks array required' }); return; }

  // Resolve and validate each check against stored connections
  const access = connectionAccessWhere('connections', req.user!.userId, req.user!.role);
  const validatedChecks: { id: string; host: string; port: number }[] = [];
  for (const { id } of checks) {
    const conn = queryOne<{ host: string; port: number }>(
      `SELECT host, port FROM connections WHERE id = ? AND ${access.where}`,
      [id, ...access.params],
    );
    if (!conn) continue;
    if (isDangerousHost(conn.host)) continue;
    validatedChecks.push({ id, host: conn.host, port: conn.port });
  }

  const results = await Promise.all(
    validatedChecks.map(({ id, host, port }) =>
      new Promise<{ id: string; reachable: boolean; latencyMs: number | null }>((resolve) => {
        const start = Date.now();
        const socket = net.createConnection({ host, port, timeout: 3000 });
        socket.on('connect', () => {
          const latencyMs = Date.now() - start;
          socket.destroy();
          resolve({ id, reachable: true, latencyMs });
        });
        socket.on('timeout', () => { socket.destroy(); resolve({ id, reachable: false, latencyMs: null }); });
        socket.on('error', () => resolve({ id, reachable: false, latencyMs: null }));
      }),
    ),
  );

  // For connections that were filtered out (invalid/private), return reachable: false
  const allChecks = (req.body as { checks: { id: string }[] }).checks;
  const resultMap = new Map(results.map((r) => [r.id, r]));
  const finalResults = allChecks.map(({ id }) =>
    resultMap.get(id) ?? { id, reachable: false, latencyMs: null },
  );

  res.json({ results: finalResults });
});

// GET /export — export all connections and groups as JSON (no passwords)
router.get('/export', (req: Request, res: Response) => {
  if (!userCan(req, 'connections.import_export')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }
  const userId = req.user!.userId;
  const groups = queryAll<GroupRow>(
    'SELECT id, name, parent_id, sort_order FROM connection_groups WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE ASC',
    [userId],
  );
  interface ExportConn {
    id: string; name: string; protocol: string; host: string;
    port: number; username: string | null; group_id: string | null; shared: number;
    credential_id: string | null;
  }
  const connections = filterListedConnections(queryAll<ExportConn>(
    'SELECT id, name, protocol, host, port, username, group_id, shared, credential_id FROM connections WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE ASC',
    [userId],
  ));
  // Names only, for display if the credential can't be relinked on import (e.g.
  // a different instance) — every id here belongs to a credential this user
  // could already use, since it's linked to one of their own connections.
  const credentialIds = [...new Set(connections.map((c) => c.credential_id).filter((id): id is string => !!id))];
  const credentialNames = new Map(
    credentialIds.length
      ? queryAll<{ id: string; name: string }>(
          `SELECT id, name FROM credentials WHERE id IN (${credentialIds.map(() => '?').join(',')})`,
          credentialIds,
        ).map((c) => [c.id, c.name] as const)
      : [],
  );
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: groups.map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id, sortOrder: g.sort_order })),
    connections: connections.map((c) => ({
      id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port,
      username: c.username, groupId: c.group_id, shared: c.shared,
      credentialId: c.credential_id, credentialName: c.credential_id ? credentialNames.get(c.credential_id) ?? null : null,
    })),
  };
  res.setHeader('Content-Disposition', `attachment; filename="gatwy-connections-${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(payload);
});

// POST /import — import connections from JSON
router.post('/import', (req: Request, res: Response) => {
  if (!userCan(req, 'connections.import_export')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }
  const userId = req.user!.userId;
  const { groups, connections } = req.body as {
    version?: number;
    groups?: { id: string; name: string; parentId?: string | null; sortOrder?: number }[];
    connections?: {
      name: string; protocol: string; host: string; port: number; username?: string | null;
      groupId?: string | null; shared?: number; credentialId?: string | null;
    }[];
  };

  if ((connections ?? []).some(c => blockedSharedCreate(req, c.shared))) {
    res.status(403).json({ error: 'Sharing permission required' });
    return;
  }

  let groupsCreated = 0;
  let connectionsCreated = 0;
  let credentialsLinked = 0;
  const groupIdMap = new Map<string, string>(); // old id → new id

  // Create groups (preserve hierarchy by sorting: parents before children)
  const sortedGroups = (groups ?? []).slice().sort((a, b) => {
    if (!a.parentId) return -1;
    if (!b.parentId) return 1;
    return 0;
  });

  for (const g of sortedGroups) {
    const newId = uuid();
    groupIdMap.set(g.id, newId);
    const newParentId = g.parentId ? (groupIdMap.get(g.parentId) ?? null) : null;
    execute(
      'INSERT INTO connection_groups (id, user_id, name, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)',
      [newId, userId, g.name, newParentId, g.sortOrder ?? 0],
    );
    groupsCreated++;
  }

  for (const c of (connections ?? [])) {
    if (!c.name || !c.protocol || !c.host || !c.port) continue;
    if (!(ALL_PROTOCOLS as readonly string[]).includes(c.protocol)) continue;
    const newId = uuid();
    const newGroupId = c.groupId ? (groupIdMap.get(c.groupId) ?? null) : null;
    // Relink to the original credential only if it still exists here and the
    // importing user is allowed to use it — otherwise just import without one.
    const credentialId = c.credentialId
      && !checkCredentialAssignable(c.credentialId, userId, !!c.shared, userCan(req, 'credentials.use_shared'))
      ? c.credentialId
      : null;
    if (credentialId) credentialsLinked++;
    execute(
      `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port, username, shared, sort_order, credential_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, userId, newGroupId, c.name, c.protocol, c.host, c.port, credentialId ? null : (c.username ?? null), c.shared ?? 0, 0, credentialId],
    );
    connectionsCreated++;
  }

  logAudit({
    userId,
    eventType: 'connections.imported',
    details: { groupsCreated, connectionsCreated, credentialsLinked },
    ipAddress: req.ip,
  });

  res.json({ groupsCreated, connectionsCreated, credentialsLinked, newGroupIds: [...groupIdMap.values()] });
});

// Create connection
router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;

  if (!userCan(req, 'connections.create')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  const { name, protocol, host, port, username, password, groupId, privateKey, extraConfig, shared, tunnels, tags, skipCertValidation, credentialId } = req.body;

  if (!name || !protocol || !host || !port) {
    res.status(400).json({ error: 'Name, protocol, host, and port are required' });
    return;
  }

  if (!createProtocols().includes(protocol)) {
    res.status(400).json({ error: 'Invalid protocol' });
    return;
  }

  // A connection can only be filed under a folder its owner owns, or a folder shared to the
  // creator with editor capability — otherwise it could be planted into a folder merely
  // shared to the creator (view-only), surfacing it to everyone that folder is shared with.
  let ownerId = userId;
  if (groupId) {
    if (groupOwnedBy(groupId, userId)) {
      ownerId = userId;
    } else if (canWriteSharedGroup(groupId, userId, role)) {
      const owner = queryOne<{ user_id: string }>('SELECT user_id FROM connection_groups WHERE id = ?', [groupId]);
      if (!owner) { res.status(400).json({ error: 'Invalid folder' }); return; }
      ownerId = owner.user_id;
    } else {
      res.status(400).json({ error: 'Invalid folder' });
      return;
    }
  }
  const actingAsEditor = ownerId !== userId;

  // An editor collaborator can never publish a global share on the owner's connection —
  // even at creation time. Silently ignored, not an error, same as PUT /:id.
  const effectiveShared = actingAsEditor ? false : !!shared;

  if (blockedSharedCreate(req, effectiveShared)) {
    res.status(403).json({ error: 'Sharing permission required' });
    return;
  }

  // Validate VNC pointer scale: factor = 100/percent, valid percent range [50, 400] → factor [0.25, 2]
  if (protocol === 'vnc' && extraConfig) {
    const cfg = extraConfig as Record<string, unknown>;
    const sx = cfg.pointerScaleX;
    const sy = cfg.pointerScaleY;
    if (sx !== undefined && (typeof sx !== 'number' || !Number.isFinite(sx) || sx < 0.25 || sx > 2)) {
      res.status(400).json({ error: 'Invalid VNC pointer scale' }); return;
    }
    if (sy !== undefined && (typeof sy !== 'number' || !Number.isFinite(sy) || sy < 0.25 || sy > 2)) {
      res.status(400).json({ error: 'Invalid VNC pointer scale' }); return;
    }
  }

  if (credentialId) {
    // Validated against the folder OWNER, not the caller — an editor linking their own
    // private library credential gets the same hard block the owner would ("Credential
    // not found"), since the row this creates belongs to the owner either way.
    const err = checkCredentialAssignable(credentialId, ownerId, effectiveShared, userCan(req, 'credentials.use_shared'));
    if (err) { res.status(400).json({ error: err }); return; }
  }
  const inlineKey = credentialId ? { key: null } : prepareInlineKey(privateKey);
  if ('error' in inlineKey) { res.status(400).json({ error: inlineKey.error }); return; }

  const id = uuid();
  // A linked library credential replaces inline credentials entirely.
  const encryptedPassword = !credentialId && password ? encrypt(password) : null;
  const encryptedKey = inlineKey.key ? encrypt(inlineKey.key) : null;
  const tagsStr = Array.isArray(tags) ? JSON.stringify(tags.map((t: string) => t.trim()).filter(Boolean)) : null;

  execute(
    `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port, username, encrypted_password, private_key, extra_config_json, sort_order, shared, tunnels_json, tags, skip_cert_validation, credential_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ownerId, groupId || null, name, protocol, host, port,
      credentialId ? null : (username || null), encryptedPassword, encryptedKey,
      extraConfig ? JSON.stringify(extraConfig) : null, 0,
      effectiveShared ? 1 : 0,
      tunnels ? JSON.stringify(tunnels) : null,
      tagsStr,
      skipCertValidation ? 1 : 0,
      credentialId || null,
    ],
  );

  // Same non-blocking warning PUT /groups/:id/shares surfaces when a folder is (re)shared:
  // a private library credential the OWNER just linked, inside a folder already shared out,
  // won't actually be visible to that folder's recipients (applyCredential withholds it).
  // Never applies to the editor branch: checkCredentialAssignable above already hard-blocks
  // an editor from linking anything but their own already-shared or inline credentials.
  let credentialWarning: { connectionId: string; connectionName: string } | null = null;
  if (!actingAsEditor && credentialId && groupId && isInsideSharedGroup(groupId)) {
    const cred = queryOne<{ shared: number }>('SELECT shared FROM credentials WHERE id = ?', [credentialId]);
    if (cred && cred.shared === 0) credentialWarning = { connectionId: id, connectionName: name };
  }

  logAudit({
    userId,
    eventType: 'connection.created',
    target: `${protocol}://${host}:${port}`,
    details: actingAsEditor ? { connectionId: id, name, ownerId } : { connectionId: id, name },
    ipAddress: req.ip,
  });

  res.status(201).json({
    id, name, protocol, host, port, username, groupId: groupId || null, shared: effectiveShared ? 1 : 0,
    ...(credentialWarning ? { warning: credentialWarning } : {}),
  });
});

// PUT /reorder — batch-update sort_order for connections within a folder
// Must be defined before /:id to avoid Express matching "reorder" as an id param
router.put('/reorder', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const { items } = req.body as { items?: { id: string; sortOrder: number }[] };
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array is required' }); return; }
  const canEditAny = userCan(req, 'connections.edit_any');
  for (const item of items) {
    const conn = queryOne<{ user_id: string; group_id: string | null }>(
      'SELECT user_id, group_id FROM connections WHERE id = ?', [item.id],
    );
    if (!conn) continue;
    const isOwner = conn.user_id === userId;
    const editorAccess = !isOwner && !!conn.group_id && canWriteSharedGroup(conn.group_id, userId, role);
    if (!isOwner && !canEditAny && !editorAccess) continue;
    execute('UPDATE connections SET sort_order = ? WHERE id = ?', [item.sortOrder, item.id]);
  }
  res.json({ success: true });
});

// Update connection
router.put('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const id = req.params.id as string;

  interface ExistingConnectionRow {
    id: string;
    name: string;
    protocol: string;
    host: string;
    port: number;
    username: string | null;
    group_id: string | null;
    user_id: string;
    shared: number;
    extra_config_json: string | null;
    credential_id: string | null;
  }

  const existing = queryOne<ExistingConnectionRow>(
    'SELECT id, name, protocol, host, port, username, group_id, user_id, shared, extra_config_json, credential_id FROM connections WHERE id = ?',
    [id],
  );
  if (!existing) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  if (existing.protocol === 'moonlight' && !isMoonlightWebAvailable()) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const isOwner = existing.user_id === userId;
  const canEditAny = userCan(req, 'connections.edit_any');
  const canEditOwn = userCan(req, 'connections.edit_own');
  // A folder share grants access to that specific folder, it never bypasses the base RBAC
  // permission — a role stripped of connections.edit_own must stay locked out even with an
  // active editor share.
  const editorAccess = !isOwner && !canEditAny && canEditOwn && !!existing.group_id && canWriteSharedGroup(existing.group_id, userId, role);
  if (isOwner && !canEditOwn && !canEditAny) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }
  if (!isOwner && !canEditAny && !editorAccess) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  const before = {
    name: existing.name,
    protocol: existing.protocol,
    host: existing.host,
    port: existing.port,
    username: existing.username,
    folder: groupNameForAudit(existing.group_id),
    shared: existing.shared === 1,
  };

  const { name, protocol, host, port, username, password, groupId, privateKey, tunnels, extraConfig, tags, skipCertValidation, credentialId } = req.body;
  // An editor collaborator can never touch the `shared` flag on someone else's connection —
  // silently ignored, same treatment as POST / at creation time, not a 403.
  const shared = editorAccess ? undefined : req.body.shared;

  if (blockedSharedUpdate(req, shared, existing.shared)) {
    res.status(403).json({ error: 'Sharing permission required' });
    return;
  }

  if (protocol !== undefined && !createProtocols().includes(protocol)) {
    res.status(400).json({ error: 'Invalid protocol' });
    return;
  }

  // A connection can only be filed under a folder its owner owns — otherwise it could be
  // planted into a folder shared to the owner, surfacing it to everyone that folder is shared with.
  if (groupId && !groupOwnedBy(groupId, existing.user_id)) {
    res.status(400).json({ error: 'Invalid folder' });
    return;
  }
  // An editor's reparenting is scoped to sub-folders of the SAME shared folder they were
  // granted edit access to — canWriteSharedGroup alone only proves the target is writable
  // by this editor, not that it's the same branch: an editor holding two independent
  // edit-shares from the same owner could otherwise use one to reach into the other.
  if (groupId && editorAccess && !sameSharedBranch(existing.group_id!, groupId, userId, role)) {
    res.status(400).json({ error: 'Invalid folder' });
    return;
  }

  // Validate the credential the connection will use after this update — a newly
  // linked one, or the existing one if the connection is becoming shared. Always checked
  // against the connection's actual owner (existing.user_id), never the caller — already
  // correct for the editor branch too, since an editor linking their own private
  // credential must get the same hard block the owner would.
  const nextCredentialId: string | null = credentialId !== undefined ? (credentialId || null) : existing.credential_id;
  if (nextCredentialId && (credentialId !== undefined || shared !== undefined)) {
    const nextShared = isConnectionShared(id, shared !== undefined ? !!shared : existing.shared);
    const err = checkCredentialAssignable(nextCredentialId, existing.user_id, nextShared, userCan(req, 'credentials.use_shared'));
    if (err) { res.status(400).json({ error: err }); return; }
  }
  const inlineKey = nextCredentialId ? { key: null } : prepareInlineKey(privateKey);
  if ('error' in inlineKey) { res.status(400).json({ error: inlineKey.error }); return; }

  // Same non-blocking warning as on create: the OWNER linking their own private library
  // credential to a connection that sits inside an already-shared folder won't actually be
  // visible to that folder's recipients. Never applies to the editor branch (hard-blocked above).
  const effectiveGroupId = groupId !== undefined ? (groupId || null) : existing.group_id;
  let credentialWarning: { connectionId: string; connectionName: string } | null = null;
  if (!editorAccess && credentialId && effectiveGroupId && isInsideSharedGroup(effectiveGroupId)) {
    const cred = queryOne<{ shared: number }>('SELECT shared FROM credentials WHERE id = ?', [credentialId]);
    if (cred && cred.shared === 0) credentialWarning = { connectionId: id, connectionName: name ?? existing.name };
  }

  // Validate VNC pointer scale on update
  if (extraConfig && (protocol === 'vnc' || (!protocol && existing.protocol === 'vnc'))) {
    const cfg = extraConfig as Record<string, unknown>;
    const sx = cfg.pointerScaleX;
    const sy = cfg.pointerScaleY;
    if (sx !== undefined && (typeof sx !== 'number' || !Number.isFinite(sx) || sx < 0.25 || sx > 2)) {
      res.status(400).json({ error: 'Invalid VNC pointer scale' }); return;
    }
    if (sy !== undefined && (typeof sy !== 'number' || !Number.isFinite(sy) || sy < 0.25 || sy > 2)) {
      res.status(400).json({ error: 'Invalid VNC pointer scale' }); return;
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (protocol !== undefined) { updates.push('protocol = ?'); params.push(protocol); }
  if (host !== undefined) { updates.push('host = ?'); params.push(host); }
  if (port !== undefined) { updates.push('port = ?'); params.push(port); }
  if (credentialId !== undefined) { updates.push('credential_id = ?'); params.push(credentialId || null); }
  if (nextCredentialId) {
    // Linked to a library credential: drop any inline credentials.
    if (credentialId) updates.push('username = NULL', 'encrypted_password = NULL', 'private_key = NULL');
  } else {
    if (username !== undefined) { updates.push('username = ?'); params.push(username || null); }
    if (password) { updates.push('encrypted_password = ?'); params.push(encrypt(password)); }
    if (privateKey !== undefined) { updates.push('private_key = ?'); params.push(inlineKey.key ? encrypt(inlineKey.key) : null); }
  }
  if (groupId !== undefined) { updates.push('group_id = ?'); params.push(groupId || null); }
  if (shared !== undefined) { updates.push('shared = ?'); params.push(shared ? 1 : 0); }
  if (tunnels !== undefined) { updates.push('tunnels_json = ?'); params.push(tunnels ? JSON.stringify(tunnels) : null); }
  if (extraConfig !== undefined) {
    let nextExtra = extraConfig;
    if (existing.protocol === 'moonlight' || protocol === 'moonlight') {
      let prev: Record<string, unknown> = {};
      try {
        if (existing.extra_config_json) prev = JSON.parse(existing.extra_config_json) as Record<string, unknown>;
      } catch { /* ignore */ }
      nextExtra = {
        ...prev,
        ...(extraConfig && typeof extraConfig === 'object' ? extraConfig as Record<string, unknown> : {}),
      };
    }
    updates.push('extra_config_json = ?');
    params.push(nextExtra ? JSON.stringify(nextExtra) : null);
  }
  if (tags !== undefined) { updates.push('tags = ?'); params.push(Array.isArray(tags) ? JSON.stringify(tags.map((t: string) => t.trim()).filter(Boolean)) : null); }
  if (skipCertValidation !== undefined) { updates.push('skip_cert_validation = ?'); params.push(skipCertValidation ? 1 : 0); }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  updates.push("updated_at = datetime('now')");
  params.push(id);

  execute(`UPDATE connections SET ${updates.join(', ')} WHERE id = ?`, params);

  const after = {
    name: name !== undefined ? name : before.name,
    protocol: protocol !== undefined ? protocol : before.protocol,
    host: host !== undefined ? host : before.host,
    port: port !== undefined ? port : before.port,
    username: username !== undefined ? (username || null) : before.username,
    folder: groupId !== undefined ? groupNameForAudit(groupId || null) : before.folder,
    shared: shared !== undefined ? !!shared : before.shared,
  };

  logAudit({
    userId,
    eventType: 'connection.updated',
    target: existing.name,
    details: editorAccess ? { before, after, ownerId: existing.user_id } : { before, after },
    ipAddress: req.ip,
  });

  res.json({ success: true, ...(credentialWarning ? { warning: credentialWarning } : {}) });
});

// Delete connection
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const id = req.params.id as string;

  const conn = queryOne<{ user_id: string; name: string; group_id: string | null }>(
    'SELECT user_id, name, group_id FROM connections WHERE id = ?', [id],
  );
  if (!conn) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  const isOwner = conn.user_id === userId;
  const canDeleteAny = userCan(req, 'connections.delete_any');
  const canDeleteOwn = userCan(req, 'connections.delete_own');
  // Same RBAC floor as PUT /:id — an editor share never substitutes for the base
  // connections.delete_own permission.
  const editorAccess = !isOwner && !canDeleteAny && canDeleteOwn && !!conn.group_id && canWriteSharedGroup(conn.group_id, userId, role);
  if (isOwner && !canDeleteOwn && !canDeleteAny) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }
  if (!isOwner && !canDeleteAny && !editorAccess) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  // An editor collaborator (never the owner, never connections.delete_any) may not
  // delete a connection the owner separately shared to someone else — resource_shares has
  // no FK cascade, so this would silently destroy that third party's share. The owner can
  // always delete, condivisions included, same as before resource_shares existed.
  if (editorAccess && isSharedConnection(id)) {
    res.status(409).json({
      error: `This connection ("${conn.name}") is shared with someone else. Ask the owner to remove that share first, or to delete it themselves.`,
    });
    return;
  }

  // No FK cascade on resource_shares (see above) — clean up explicitly, before the delete.
  execute(`DELETE FROM resource_shares WHERE resource_type = 'connection' AND resource_id = ?`, [id]);
  execute('DELETE FROM connections WHERE id = ?', [id]);

  logAudit({
    userId,
    eventType: 'connection.deleted',
    target: conn.name,
    details: editorAccess ? { ownerId: conn.user_id } : undefined,
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// Get connection details
router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  const access = connectionAccessWhere('connections', req.user!.userId, req.user!.role);
  const conn = queryOne<ConnectionRow>(
    `SELECT * FROM connections WHERE id = ? AND ${access.where}`,
    [id, ...access.params],
  );

  if (!conn) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  if (conn.protocol === 'moonlight' && !isMoonlightWebAvailable()) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  let tunnels: unknown[] = [];
  try { if (conn.tunnels_json) tunnels = JSON.parse(conn.tunnels_json); } catch { /* ignore */ }

  let extraConfig: unknown = null;
  try { if (conn.extra_config_json) extraConfig = JSON.parse(conn.extra_config_json); } catch { /* ignore */ }

  let tags: string[] = [];
  try { if (conn.tags) tags = JSON.parse(conn.tags); } catch { /* ignore */ }

  // Include shares if this is the owner or has edit_any permission
  const isOwner = conn.user_id === userId;
  let shares: { shareType: string; targetId: string }[] = [];
  if (isOwner || userCan(req, 'connections.edit_any')) {
    const shareRows = queryAll<{ share_type: string; target_id: string }>(
      `SELECT share_type, target_id FROM resource_shares WHERE resource_type = 'connection' AND resource_id = ?`, [conn.id],
    );
    shares = shareRows.map(s => ({ shareType: s.share_type, targetId: s.target_id }));
  }

  res.json({
    id: conn.id,
    name: conn.name,
    protocol: conn.protocol,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    groupId: conn.group_id,
    recordingEnabled: conn.recording_enabled,
    hasPassword: !!conn.encrypted_password,
    hasPrivateKey: !!conn.private_key,
    credentialId: conn.credential_id,
    shared: conn.shared,
    tunnels,
    extraConfig,
    tags,
    shares,
    skipCertValidation: conn.skip_cert_validation === 1,
  });
});

// Get session credentials (decrypted password for RDP client auth)
router.get('/:id/session', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  // Credentials returned to the owner or to users with explicit share access
  const access = connectionAccessWhere('connections', req.user!.userId, req.user!.role);
  const row = queryOne<ConnectionRow>(
    `SELECT * FROM connections WHERE id = ? AND ${access.where}`,
    [id, ...access.params],
  );

  if (!row) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  if (row.protocol === 'moonlight' && !isMoonlightWebAvailable()) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  const conn = applyCredential(row, userId);

  const password = conn.encrypted_password ? decrypt(conn.encrypted_password) : '';

  // Only expose VNC pointer-scale fields — never return the full extraConfig blob.
  let vncPointerConfig: { pointerScaleX: number; pointerScaleY: number } | null = null;
  if (conn.protocol === 'vnc' && conn.extra_config_json) {
    try {
      const raw = JSON.parse(conn.extra_config_json) as Record<string, unknown>;
      const sx = raw.pointerScaleX;
      const sy = raw.pointerScaleY;
      if (typeof sx === 'number' && Number.isFinite(sx) && typeof sy === 'number' && Number.isFinite(sy)) {
        vncPointerConfig = { pointerScaleX: sx, pointerScaleY: sy };
      }
    } catch { /* ignore */ }
  }

  res.json({
    host: conn.host,
    port: conn.port,
    username: conn.username || '',
    password,
    ...(vncPointerConfig ? { extraConfig: vncPointerConfig } : {}),
  });
});

// --- Connection Groups ---
// IMPORTANT: these routes must be defined BEFORE /:id routes to avoid shadowing

// PUT /groups/reorder — batch-update sort_order for a set of groups (manual sort)
router.put('/groups/reorder', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const { items } = req.body as { items?: { id: string; sortOrder: number }[] };
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array is required' }); return; }
  const canEditAny = userCan(req, 'connections.edit_any');
  for (const item of items) {
    const group = queryOne<{ user_id: string }>(
      'SELECT user_id FROM connection_groups WHERE id = ?', [item.id],
    );
    if (!group) continue;
    const isOwner = group.user_id === userId;
    const editorAccess = !isOwner && canWriteSharedGroup(item.id, userId, role);
    if (!isOwner && !canEditAny && !editorAccess) continue;
    execute('UPDATE connection_groups SET sort_order = ? WHERE id = ?', [item.sortOrder, item.id]);
  }
  res.json({ success: true });
});

router.post('/groups', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const { name, parentId } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  // A group can only be nested under a folder its owner owns, or a folder shared to the
  // creator with editor capability — otherwise it could be grafted onto a folder merely
  // shared to the creator (view-only), surfacing it (and everything inside) to everyone
  // that folder is shared with.
  let ownerId = userId;
  if (parentId) {
    if (groupOwnedBy(parentId, userId)) {
      ownerId = userId;
    } else if (canWriteSharedGroup(parentId, userId, role)) {
      const parentOwner = queryOne<{ user_id: string }>('SELECT user_id FROM connection_groups WHERE id = ?', [parentId]);
      if (!parentOwner) { res.status(400).json({ error: 'Invalid parent folder' }); return; }
      ownerId = parentOwner.user_id;
    } else {
      res.status(400).json({ error: 'Invalid parent folder' });
      return;
    }
  }
  const actingAsEditor = ownerId !== userId;

  const id = uuid();
  execute(
    'INSERT INTO connection_groups (id, user_id, name, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, ownerId, name, parentId || null, 0],
  );

  logAudit({
    userId,
    eventType: 'group.created',
    target: name,
    details: actingAsEditor ? { groupId: id, ownerId } : { groupId: id },
    ipAddress: req.ip,
  });

  res.status(201).json({ id, name, parentId: parentId || null });
});

router.put('/groups/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const id = req.params.id as string;
  const { name, parentId } = req.body as { name?: string; parentId?: string | null };

  const group = queryOne<{ user_id: string; name: string }>(
    'SELECT user_id, name FROM connection_groups WHERE id = ?', [id],
  );
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  const isOwner = group.user_id === userId;
  const canEditAny = userCan(req, 'connections.edit_any');
  // isSharedGroup excluded even when otherwise editor-writable: an editor may change
  // *contents* of a shared folder, never the shared folder (or an independently-shared
  // sub-folder) itself — renaming it is not a content change.
  const editorAccess = !isOwner && !canEditAny && canWriteSharedGroup(id, userId, role) && !isSharedGroup(id);
  if (!isOwner && !canEditAny && !editorAccess) { res.status(403).json({ error: 'Not authorized' }); return; }

  // A group's parent must belong to the same owner as the group itself — not the caller —
  // otherwise an `edit_any` admin reparenting someone else's group under their own folder
  // (or the owner/an editor reparenting under a folder shared to them) grafts it into that share.
  if (parentId && !groupOwnedBy(parentId, group.user_id)) {
    res.status(400).json({ error: 'Invalid parent folder' });
    return;
  }
  // An editor's reparenting is scoped to sub-folders of the SAME shared folder they were
  // granted edit access to — canWriteSharedGroup alone only proves the target is writable
  // by this editor, not that it's the same branch: an editor holding two independent
  // edit-shares from the same owner could otherwise use one to reach into the other.
  if (parentId && editorAccess && !sameSharedBranch(id, parentId, userId, role)) {
    res.status(400).json({ error: 'Invalid parent folder' });
    return;
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
  if (parentId !== undefined) { updates.push('parent_id = ?'); params.push(parentId || null); }
  if (updates.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

  params.push(id);
  execute(`UPDATE connection_groups SET ${updates.join(', ')} WHERE id = ?`, params);

  logAudit({
    userId,
    eventType: 'group.updated',
    target: name !== undefined ? name.trim() : group.name,
    details: editorAccess ? { groupId: id, ownerId: group.user_id } : { groupId: id },
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

router.delete('/groups/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const id = req.params.id as string;

  const group = queryOne<{ user_id: string; name: string }>(
    'SELECT user_id, name FROM connection_groups WHERE id = ?', [id],
  );
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  const isOwner = group.user_id === userId;
  const canEditAny = userCan(req, 'connections.edit_any');
  // Same isSharedGroup exclusion as PUT /groups/:id: deleting the shared folder
  // itself (or an independently-shared sub-folder) is not a content change.
  const editorAccess = !isOwner && !canEditAny && canWriteSharedGroup(id, userId, role) && !isSharedGroup(id);
  if (!isOwner && !canEditAny && !editorAccess) { res.status(403).json({ error: 'Not authorized' }); return; }

  const ownerId = group.user_id;

  // Owner-scoped subtree (root + descendants actually owned by the folder owner) — the set
  // whose connections get explicitly deleted below, same boundary editableSharedGroupIds
  // and every other permission check in this file already use.
  const ownerScopedIds = descendantGroupIds(id);

  // The FULL subtree SQLite's ON DELETE CASCADE will actually remove once the root group
  // row is deleted below — including any owner-mismatched ("planted") descendant, which
  // ownerScopedIds deliberately excludes. resource_shares has no FK to cascade automatically
  // (see routes/connections.ts db/index.ts v23), so every group row about to disappear,
  // planted or not, needs its shares cleaned up explicitly or they'd be left orphaned.
  const allGroupIdsUnscoped = allDescendantGroupIdsUnscoped(id);

  const connectionRowsToDelete = ownerScopedIds.length > 0
    ? queryAll<{ id: string; name: string }>(
        `SELECT id, name FROM connections WHERE group_id IN (${ownerScopedIds.map(() => '?').join(',')}) AND user_id = ?`,
        [...ownerScopedIds, ownerId],
      )
    : [];
  const connectionIdsToDelete = connectionRowsToDelete.map((r) => r.id);

  // Editor branch only (never owner/edit_any): refuse the WHOLE deletion up front —
  // before any write — if any connection about to be deleted carries its own share, so a
  // collaborator can't use "delete the folder" as a back door around the same guard on
  // DELETE /:id. Evaluated over the complete set first: doing this check mid-loop below
  // would leave a partially-deleted subtree on the reject path.
  if (editorAccess) {
    const blockedConnectionNames = connectionRowsToDelete
      .filter((r) => isSharedConnection(r.id))
      .map((r) => r.name);
    if (blockedConnectionNames.length > 0) {
      const list = blockedConnectionNames.map((n) => `"${n}"`).join(', ');
      const error = blockedConnectionNames.length === 1
        ? `This folder contains a connection that is shared with someone else (${list}). Ask the owner to remove that share first, or to delete it themselves.`
        : `This folder contains connections that are shared with someone else (${list}). Ask the owner to remove those shares first, or to delete them themselves.`;
      res.status(409).json({ error });
      return;
    }
  }

  // Clean up resource_shares before any DELETE (no FK cascade to rely on).
  if (allGroupIdsUnscoped.length > 0) {
    execute(
      `DELETE FROM resource_shares WHERE resource_type = 'group' AND resource_id IN (${allGroupIdsUnscoped.map(() => '?').join(',')})`,
      allGroupIdsUnscoped,
    );
  }
  if (connectionIdsToDelete.length > 0) {
    execute(
      `DELETE FROM resource_shares WHERE resource_type = 'connection' AND resource_id IN (${connectionIdsToDelete.map(() => '?').join(',')})`,
      connectionIdsToDelete,
    );
  }

  // Delete the owner's connections in the owner-scoped subtree...
  for (const gid of ownerScopedIds) {
    execute('DELETE FROM connections WHERE group_id = ? AND user_id = ?', [gid, ownerId]);
  }
  // ...then the group itself — SQLite cascades to every descendant group row (owner-scoped
  // or planted) via the connection_groups.parent_id FK; no `user_id` filter here, ownership
  // and editor access were already fully authorized above.
  execute('DELETE FROM connection_groups WHERE id = ?', [id]);

  logAudit({
    userId,
    eventType: 'group.deleted',
    target: group.name,
    details: editorAccess ? { groupId: id, ownerId } : { groupId: id },
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// --- Group (folder) Shares ---
// Sharing a folder grants access to it, every sub-folder, and every connection inside
// them — resolved live by connectionAccessWhere/accessibleSharedGroupIds, so a
// connection or sub-folder added later inherits the share automatically.

// GET /groups/:id/shares — list shares for a folder (owner only)
router.get('/groups/:id/shares', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const group = queryOne<{ user_id: string }>('SELECT user_id FROM connection_groups WHERE id = ?', [id]);
  if (!group) { res.status(404).json({ error: 'Folder not found' }); return; }
  if (group.user_id !== userId && !userCan(req, 'connections.edit_any')) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  const shares = queryAll<{ id: string; share_type: string; target_id: string; capability: string; created_at: string }>(
    `SELECT id, share_type, target_id, capability, created_at FROM resource_shares WHERE resource_type = 'group' AND resource_id = ? ORDER BY share_type, target_id`,
    [id],
  );
  // Surfaced up front (not just after saving) — this depends only on the folder's
  // contents, not on who it's shared with, so there's no reason to gate it behind a save.
  const warnings = connectionsWithUnshareableCredential(descendantGroupIds(id))
    .map((c) => ({ connectionId: c.id, connectionName: c.name }));
  res.json({
    shares: shares.map(s => ({ id: s.id, shareType: s.share_type, targetId: s.target_id, capability: s.capability, createdAt: s.created_at })),
    warnings,
  });
});

// PUT /groups/:id/shares — replace all shares for a folder
router.put('/groups/:id/shares', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const group = queryOne<{ user_id: string; name: string }>('SELECT user_id, name FROM connection_groups WHERE id = ?', [id]);
  if (!group) { res.status(404).json({ error: 'Folder not found' }); return; }
  if (group.user_id !== userId && !userCan(req, 'connections.edit_any')) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  if (!userCan(req, 'connections.share')) {
    res.status(403).json({ error: 'Sharing permission required' }); return;
  }

  const { shares } = req.body as { shares: { shareType: string; targetId: string; capability?: string }[] };
  if (!Array.isArray(shares)) { res.status(400).json({ error: 'shares array required' }); return; }

  const before = queryAll<{ share_type: string; target_id: string; capability: string }>(
    `SELECT share_type, target_id, capability FROM resource_shares WHERE resource_type = 'group' AND resource_id = ? ORDER BY share_type, target_id`,
    [id],
  ).map((s) => ({ shareType: s.share_type, targetId: s.target_id, capability: s.capability }));

  execute(`DELETE FROM resource_shares WHERE resource_type = 'group' AND resource_id = ?`, [id]);
  const after: { shareType: string; targetId: string; capability: string }[] = [];
  for (const s of shares) {
    if (s.shareType !== 'role' && s.shareType !== 'user') continue;
    if (!s.targetId) continue;
    const capability = s.capability === 'edit' ? 'edit' : 'view';
    const sid = uuid();
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'group', ?, ?, ?, ?)`,
      [sid, id, s.shareType, s.targetId, capability],
    );
    after.push({ shareType: s.shareType, targetId: s.targetId, capability });
  }

  logAudit({
    userId,
    eventType: 'group.shares_updated',
    target: group.name,
    details: { before: resolveShareTargetNames(before), after: resolveShareTargetNames(after) },
    ipAddress: req.ip,
  });

  // Separate, narrower event for a pure capability change on an EXISTING recipient —
  // 'group.shares_updated' already carries this in its full before/after, but bundled
  // with any add/remove it's not filterable in the audit UI. Keyed on shareType+targetId,
  // limited to targets present in both snapshots whose capability actually differs, so a
  // recipient being added or removed (never in both maps) never triggers this event.
  const beforeByKey = new Map(before.map((s) => [`${s.shareType}:${s.targetId}`, s]));
  const afterByKey = new Map(after.map((s) => [`${s.shareType}:${s.targetId}`, s]));
  const capabilityChanged: { shareType: string; targetId: string; capability: string }[] = [];
  const capabilityChangedBefore: typeof before = [];
  for (const [key, afterEntry] of afterByKey) {
    const beforeEntry = beforeByKey.get(key);
    if (beforeEntry && beforeEntry.capability !== afterEntry.capability) {
      capabilityChangedBefore.push(beforeEntry);
      capabilityChanged.push(afterEntry);
    }
  }
  if (capabilityChanged.length > 0) {
    logAudit({
      userId,
      eventType: 'group.share_capability_changed',
      target: group.name,
      details: {
        before: resolveShareTargetNames(capabilityChangedBefore),
        after: resolveShareTargetNames(capabilityChanged),
      },
      ipAddress: req.ip,
    });
  }

  // Folder sharing never re-validates each connection's credential the way per-connection
  // sharing does — a private library credential inside just goes null for recipients
  // (applyCredential's defence in depth) instead of erroring. Surface that clearly rather
  // than let it look like the connection is simply broken.
  let warnings: { connectionId: string; connectionName: string }[] = [];
  if (after.length > 0) {
    const groupIds = descendantGroupIds(id);
    warnings = connectionsWithUnshareableCredential(groupIds)
      .map((c) => ({ connectionId: c.id, connectionName: c.name }));
  }

  res.json({ success: true, warnings });
});

// --- Connection Shares ---

// GET /:id/shares — list shares for a connection (owner only)
router.get('/:id/shares', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const conn = queryOne<{ user_id: string }>('SELECT user_id FROM connections WHERE id = ?', [id]);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  if (conn.user_id !== userId && !userCan(req, 'connections.edit_any')) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  const shares = queryAll<{ id: string; share_type: string; target_id: string; created_at: string }>(
    `SELECT id, share_type, target_id, created_at FROM resource_shares WHERE resource_type = 'connection' AND resource_id = ? ORDER BY share_type, target_id`,
    [id],
  );
  res.json(shares.map(s => ({ id: s.id, shareType: s.share_type, targetId: s.target_id, createdAt: s.created_at })));
});

// PUT /:id/shares — replace all shares for a connection
router.put('/:id/shares', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const conn = queryOne<{ user_id: string; name: string }>('SELECT user_id, name FROM connections WHERE id = ?', [id]);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  if (conn.user_id !== userId && !userCan(req, 'connections.edit_any')) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  if (!userCan(req, 'connections.share')) {
    res.status(403).json({ error: 'Sharing permission required' }); return;
  }

  const { shares } = req.body as { shares: { shareType: string; targetId: string }[] };
  if (!Array.isArray(shares)) { res.status(400).json({ error: 'shares array required' }); return; }

  const linked = queryOne<{ user_id: string; credential_id: string | null }>(
    'SELECT user_id, credential_id FROM connections WHERE id = ?', [id],
  );
  if (shares.length > 0 && linked?.credential_id) {
    const err = checkCredentialAssignable(linked.credential_id, linked.user_id, true, userCan(req, 'credentials.use_shared'));
    if (err) { res.status(400).json({ error: err }); return; }
  }

  const before = queryAll<{ share_type: string; target_id: string }>(
    `SELECT share_type, target_id FROM resource_shares WHERE resource_type = 'connection' AND resource_id = ? ORDER BY share_type, target_id`,
    [id],
  ).map((s) => ({ shareType: s.share_type, targetId: s.target_id }));

  // Replace all
  execute(`DELETE FROM resource_shares WHERE resource_type = 'connection' AND resource_id = ?`, [id]);
  const after: { shareType: string; targetId: string }[] = [];
  for (const s of shares) {
    if (s.shareType !== 'role' && s.shareType !== 'user') continue;
    if (!s.targetId) continue;
    const sid = uuid();
    execute(
      `INSERT INTO resource_shares (id, resource_type, resource_id, share_type, target_id, capability) VALUES (?, 'connection', ?, ?, ?, 'view')`,
      [sid, id, s.shareType, s.targetId],
    );
    after.push({ shareType: s.shareType, targetId: s.targetId });
  }

  logAudit({
    userId,
    eventType: 'connection.shares_updated',
    target: conn.name,
    details: { before: resolveShareTargetNames(before), after: resolveShareTargetNames(after) },
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

export default router;
