import { Router, type Request, type Response } from 'express';
import net from 'net';
import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute } from '../db/helpers.js';
import { authRequired, userCan } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { logAudit } from '../services/audit.js';
import { filterListedConnections, isMoonlightWebAvailable, runtimeFeatures } from '../services/moonlightWeb.js';

const ALL_PROTOCOLS = ['ssh', 'rdp', 'smb', 'vnc', 'moonlight', 'sftp', 'ftp', 'telnet', 'postgres', 'mysql'] as const;

function createProtocols(): readonly string[] {
  return isMoonlightWebAvailable()
    ? ALL_PROTOCOLS
    : ALL_PROTOCOLS.filter((p) => p !== 'moonlight');
}

const router = Router();
router.use(authRequired);

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
}

interface GroupRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

/** SQL condition: user owns the connection, OR it's shared globally, OR shared via connection_shares */
function canAccessWhere(alias = 'connections'): string {
  return `(${alias}.user_id = ? OR ${alias}.shared = 1 OR ${alias}.id IN (SELECT cs.connection_id FROM connection_shares cs WHERE (cs.share_type = 'user' AND cs.target_id = ?) OR (cs.share_type = 'role' AND cs.target_id = ?)))`;
}
function canAccessParams(req: Request): unknown[] {
  return [req.user!.userId, req.user!.userId, req.user!.role];
}

// List connections and groups
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const groups = queryAll<GroupRow>(
    'SELECT id, name, parent_id, sort_order FROM connection_groups WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE ASC',
    [userId],
  );

  const connections = filterListedConnections(queryAll<ConnectionRow>(
    'SELECT id, name, protocol, host, port, group_id, username, sort_order, shared, tags FROM connections WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE ASC',
    [userId],
  ));

  // Shared connections from other users (shared=1 globally, or shared via connection_shares to this user or role)
  const userRole = req.user!.role;
  const sharedConnections = filterListedConnections(queryAll<ConnectionRow>(
    `SELECT DISTINCT c.id, c.name, c.protocol, c.host, c.port, c.username, c.shared, c.user_id, c.tags
     FROM connections c
     WHERE c.user_id != ?
       AND (c.shared = 1
            OR c.id IN (SELECT cs.connection_id FROM connection_shares cs
                        WHERE (cs.share_type = 'user' AND cs.target_id = ?)
                           OR (cs.share_type = 'role' AND cs.target_id = ?)))
     ORDER BY c.name`,
    [userId, userId, userRole],
  ));

  // Build tree
  interface GroupNode {
    id: string;
    name: string;
    parentId: string | null;
    children: GroupNode[];
    connections: { id: string; name: string; protocol: string; host: string; port: number; groupId: string | null; isShared: boolean; tags: string[] }[];
  }

  const groupMap = new Map<string, GroupNode>();
  for (const g of groups) {
    groupMap.set(g.id, { id: g.id, name: g.name, parentId: g.parent_id, children: [], connections: [] });
  }

  const rootGroups: GroupNode[] = [];
  for (const g of groupMap.values()) {
    if (g.parentId && groupMap.has(g.parentId)) {
      groupMap.get(g.parentId)!.children.push(g);
    } else {
      rootGroups.push(g);
    }
  }

  const connMapped = connections.map((c) => ({
    id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port, groupId: c.group_id, isShared: false,
    tags: c.tags ? JSON.parse(c.tags) as string[] : [],
  }));

  for (const conn of connMapped) {
    if (conn.groupId && groupMap.has(conn.groupId)) {
      groupMap.get(conn.groupId)!.connections.push(conn);
    }
  }

  const ungrouped = connMapped.filter((c) => !c.groupId || !groupMap.has(c.groupId));

  const sharedMapped = sharedConnections.map((c) => ({
    id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port, groupId: null, isShared: true,
    tags: c.tags ? JSON.parse(c.tags) as string[] : [],
  }));

  res.json({ groups: rootGroups, ungrouped, sharedConnections: sharedMapped, features: runtimeFeatures() });
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
  const validatedChecks: { id: string; host: string; port: number }[] = [];
  for (const { id } of checks) {
    const conn = queryOne<{ host: string; port: number }>(
      `SELECT host, port FROM connections WHERE id = ? AND ${canAccessWhere('connections')}`,
      [id, ...canAccessParams(req)],
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
  }
  const connections = filterListedConnections(queryAll<ExportConn>(
    'SELECT id, name, protocol, host, port, username, group_id, shared FROM connections WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE ASC',
    [userId],
  ));
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: groups.map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id, sortOrder: g.sort_order })),
    connections: connections.map((c) => ({
      id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port,
      username: c.username, groupId: c.group_id, shared: c.shared,
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
    connections?: { name: string; protocol: string; host: string; port: number; username?: string | null; groupId?: string | null; shared?: number }[];
  };

  let groupsCreated = 0;
  let connectionsCreated = 0;
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
    execute(
      `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port, username, shared, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, userId, newGroupId, c.name, c.protocol, c.host, c.port, c.username ?? null, c.shared ?? 0, 0],
    );
    connectionsCreated++;
  }

  logAudit({
    userId,
    eventType: 'connections.imported',
    details: { groupsCreated, connectionsCreated },
    ipAddress: req.ip,
  });

  res.json({ groupsCreated, connectionsCreated, newGroupIds: [...groupIdMap.values()] });
});

// Create connection
router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;

  if (!userCan(req, 'connections.create')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  const { name, protocol, host, port, username, password, groupId, privateKey, extraConfig, shared, tunnels, tags, skipCertValidation } = req.body;

  if (!name || !protocol || !host || !port) {
    res.status(400).json({ error: 'Name, protocol, host, and port are required' });
    return;
  }

  if (!createProtocols().includes(protocol)) {
    res.status(400).json({ error: 'Invalid protocol' });
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

  const id = uuid();
  const encryptedPassword = password ? encrypt(password) : null;
  const encryptedKey = privateKey ? encrypt(privateKey) : null;
  const tagsStr = Array.isArray(tags) ? JSON.stringify(tags.map((t: string) => t.trim()).filter(Boolean)) : null;

  execute(
    `INSERT INTO connections (id, user_id, group_id, name, protocol, host, port, username, encrypted_password, private_key, extra_config_json, sort_order, shared, tunnels_json, tags, skip_cert_validation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, userId, groupId || null, name, protocol, host, port,
      username || null, encryptedPassword, encryptedKey,
      extraConfig ? JSON.stringify(extraConfig) : null, 0,
      shared ? 1 : 0,
      tunnels ? JSON.stringify(tunnels) : null,
      tagsStr,
      skipCertValidation ? 1 : 0,
    ],
  );

  logAudit({
    userId,
    eventType: 'connection.created',
    target: `${protocol}://${host}:${port}`,
    details: { connectionId: id, name },
    ipAddress: req.ip,
  });

  res.status(201).json({
    id, name, protocol, host, port, username, groupId: groupId || null, shared: shared ? 1 : 0,
  });
});

// PUT /reorder — batch-update sort_order for connections within a folder
// Must be defined before /:id to avoid Express matching "reorder" as an id param
router.put('/reorder', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { items } = req.body as { items?: { id: string; sortOrder: number }[] };
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array is required' }); return; }
  for (const item of items) {
    const conn = queryOne<{ user_id: string }>(
      'SELECT user_id FROM connections WHERE id = ?', [item.id],
    );
    if (!conn || (conn.user_id !== userId && !userCan(req, 'connections.edit_any'))) continue;
    execute('UPDATE connections SET sort_order = ? WHERE id = ?', [item.sortOrder, item.id]);
  }
  res.json({ success: true });
});

// Update connection
router.put('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
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
  }

  const existing = queryOne<ExistingConnectionRow>(
    'SELECT id, name, protocol, host, port, username, group_id, user_id, shared, extra_config_json FROM connections WHERE id = ?',
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
  if (isOwner && !canEditOwn && !canEditAny) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }
  if (!isOwner && !canEditAny) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  const before = {
    name: existing.name,
    protocol: existing.protocol,
    host: existing.host,
    port: existing.port,
    username: existing.username,
    groupId: existing.group_id,
  };

  const { name, protocol, host, port, username, password, groupId, privateKey, shared, tunnels, extraConfig, tags, skipCertValidation } = req.body;

  if (protocol !== undefined && !createProtocols().includes(protocol)) {
    res.status(400).json({ error: 'Invalid protocol' });
    return;
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
  if (username !== undefined) { updates.push('username = ?'); params.push(username || null); }
  if (password) { updates.push('encrypted_password = ?'); params.push(encrypt(password)); }
  if (privateKey !== undefined) { updates.push('private_key = ?'); params.push(privateKey ? encrypt(privateKey) : null); }
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
    groupId: groupId !== undefined ? (groupId || null) : before.groupId,
  };

  logAudit({
    userId,
    eventType: 'connection.updated',
    target: id,
    details: { before, after },
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// Delete connection
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  const conn = queryOne<{ user_id: string }>('SELECT user_id FROM connections WHERE id = ?', [id]);
  if (!conn) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  const isOwner = conn.user_id === userId;
  const canDeleteAny = userCan(req, 'connections.delete_any');
  const canDeleteOwn = userCan(req, 'connections.delete_own');
  if (isOwner && !canDeleteOwn && !canDeleteAny) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }
  if (!isOwner && !canDeleteAny) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  execute('DELETE FROM connections WHERE id = ?', [id]);

  logAudit({
    userId,
    eventType: 'connection.deleted',
    target: id,
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// Get connection details
router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  const conn = queryOne<ConnectionRow>(
    `SELECT * FROM connections WHERE id = ? AND ${canAccessWhere()}`,
    [id, ...canAccessParams(req)],
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
      'SELECT share_type, target_id FROM connection_shares WHERE connection_id = ?', [conn.id],
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
  const conn = queryOne<ConnectionRow>(
    `SELECT * FROM connections WHERE id = ? AND ${canAccessWhere()}`,
    [id, ...canAccessParams(req)],
  );

  if (!conn) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  if (conn.protocol === 'moonlight' && !isMoonlightWebAvailable()) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

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
  const { items } = req.body as { items?: { id: string; sortOrder: number }[] };
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array is required' }); return; }
  for (const item of items) {
    const group = queryOne<{ user_id: string }>(
      'SELECT user_id FROM connection_groups WHERE id = ?', [item.id],
    );
    if (!group || (group.user_id !== userId && !userCan(req, 'connections.edit_any'))) continue;
    execute('UPDATE connection_groups SET sort_order = ? WHERE id = ?', [item.sortOrder, item.id]);
  }
  res.json({ success: true });
});

router.post('/groups', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { name, parentId } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const id = uuid();
  execute(
    'INSERT INTO connection_groups (id, user_id, name, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, userId, name, parentId || null, 0],
  );

  res.status(201).json({ id, name, parentId: parentId || null });
});

router.put('/groups/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const { name, parentId } = req.body as { name?: string; parentId?: string | null };

  const group = queryOne<{ user_id: string }>(
    'SELECT user_id FROM connection_groups WHERE id = ?', [id],
  );
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.user_id !== userId && !userCan(req, 'connections.edit_any')) { res.status(403).json({ error: 'Not authorized' }); return; }

  const updates: string[] = [];
  const params: unknown[] = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
  if (parentId !== undefined) { updates.push('parent_id = ?'); params.push(parentId || null); }
  if (updates.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

  params.push(id);
  execute(`UPDATE connection_groups SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ success: true });
});

router.delete('/groups/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  // Verify ownership
  const group = queryOne<{ user_id: string }>(
    'SELECT user_id FROM connection_groups WHERE id = ? AND user_id = ?', [id, userId],
  );
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  // Recursively collect all descendant group IDs (including this one)
  const allGroupIds: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop()!;
    allGroupIds.push(current);
    const children = queryAll<{ id: string }>(
      'SELECT id FROM connection_groups WHERE parent_id = ? AND user_id = ?', [current, userId],
    );
    children.forEach(c => queue.push(c.id));
  }

  // Delete all connections in those groups
  for (const gid of allGroupIds) {
    execute('DELETE FROM connections WHERE group_id = ? AND user_id = ?', [gid, userId]);
  }

  // Delete the group (cascades to subgroups via ON DELETE CASCADE)
  execute('DELETE FROM connection_groups WHERE id = ? AND user_id = ?', [id, userId]);

  res.json({ success: true });
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
    'SELECT id, share_type, target_id, created_at FROM connection_shares WHERE connection_id = ? ORDER BY share_type, target_id',
    [id],
  );
  res.json(shares.map(s => ({ id: s.id, shareType: s.share_type, targetId: s.target_id, createdAt: s.created_at })));
});

// PUT /:id/shares — replace all shares for a connection
router.put('/:id/shares', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const conn = queryOne<{ user_id: string }>('SELECT user_id FROM connections WHERE id = ?', [id]);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  if (conn.user_id !== userId && !userCan(req, 'connections.edit_any')) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  if (!userCan(req, 'connections.share')) {
    res.status(403).json({ error: 'Sharing permission required' }); return;
  }

  const { shares } = req.body as { shares: { shareType: string; targetId: string }[] };
  if (!Array.isArray(shares)) { res.status(400).json({ error: 'shares array required' }); return; }

  // Replace all
  execute('DELETE FROM connection_shares WHERE connection_id = ?', [id]);
  for (const s of shares) {
    if (s.shareType !== 'role' && s.shareType !== 'user') continue;
    if (!s.targetId) continue;
    const sid = uuid();
    execute(
      'INSERT INTO connection_shares (id, connection_id, share_type, target_id) VALUES (?, ?, ?, ?)',
      [sid, id, s.shareType, s.targetId],
    );
  }
  res.json({ success: true });
});

export default router;
