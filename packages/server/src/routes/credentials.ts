import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute } from '../db/helpers.js';
import { authRequired, userCan } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { prepareKey, type PreparedKey } from '../services/sshKeys.js';
import { logAudit } from '../services/audit.js';
import { CREDENTIAL_TYPES, type CredentialRow } from '../services/credentials.js';

const router = Router();
router.use(authRequired);

interface ListRow extends CredentialRow {
  owner_username: string | null;
  usage_count: number;
}

/** Connections using a credential that would break if it became private to its owner. */
function nonOwnerUsages(cred: CredentialRow): { id: string; name: string; user_id: string }[] {
  return queryAll<{ id: string; name: string; user_id: string }>(
    `SELECT c.id, c.name, c.user_id FROM connections c
     WHERE c.credential_id = ?
       AND (c.user_id != ? OR c.shared = 1
            OR EXISTS (SELECT 1 FROM resource_shares rs WHERE rs.resource_type = 'connection' AND rs.resource_id = c.id))
     ORDER BY c.name COLLATE NOCASE`,
    [cred.id, cred.user_id],
  );
}

/** 409 body listing blocking connections — names only for the caller's own. */
function inUseBody(req: Request, error: string, conns: { id: string; name: string; user_id: string }[]) {
  const own = conns.filter((c) => c.user_id === req.user!.userId);
  return {
    error,
    connections: own.map((c) => ({ id: c.id, name: c.name })),
    otherCount: conns.length - own.length,
  };
}

function canEdit(req: Request, cred: CredentialRow): boolean {
  if (cred.user_id === req.user!.userId) return true;
  return cred.shared === 1 && userCan(req, 'credentials.share');
}

function toJson(req: Request, c: ListRow) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    username: c.username,
    domain: c.domain,
    shared: c.shared === 1,
    hasPassword: !!c.encrypted_password,
    hasPrivateKey: !!c.private_key,
    hasPassphrase: !!c.encrypted_passphrase,
    isOwner: c.user_id === req.user!.userId,
    ownerUsername: c.owner_username,
    canEdit: canEdit(req, c),
    usageCount: c.usage_count,
  };
}

const LIST_SELECT = `
  SELECT cr.*, u.username AS owner_username,
         (SELECT COUNT(*) FROM connections c WHERE c.credential_id = cr.id) AS usage_count
  FROM credentials cr LEFT JOIN users u ON u.id = cr.user_id`;

// GET / — own credentials plus shared ones the user may use or manage
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const seeShared = userCan(req, 'credentials.use_shared') || userCan(req, 'credentials.share');
  const rows = queryAll<ListRow>(
    `${LIST_SELECT}
     WHERE cr.user_id = ? ${seeShared ? 'OR cr.shared = 1' : ''}
     ORDER BY cr.name COLLATE NOCASE`,
    [userId],
  );
  res.json(rows.map((r) => toJson(req, r)));
});

// POST / — create a credential
router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { name, type, username, password, privateKey, passphrase, shared, domain } = req.body as {
    name?: string; type?: string; username?: string; password?: string;
    privateKey?: string; passphrase?: string; shared?: boolean; domain?: string;
  };

  if (!name?.trim()) { res.status(400).json({ error: 'Name is required' }); return; }
  if (!type || !(CREDENTIAL_TYPES as readonly string[]).includes(type)) {
    res.status(400).json({ error: 'Invalid credential type' }); return;
  }
  if (type === 'key' && !privateKey?.trim()) {
    res.status(400).json({ error: 'Private key is required' }); return;
  }
  // PKCS#8 keys are converted to an unencrypted format ssh2 reads; the
  // passphrase is then no longer needed (secrets are encrypted at rest anyway).
  let key: PreparedKey | null = null;
  if (type === 'key') {
    const prepared = prepareKey(privateKey!, passphrase || undefined);
    if ('error' in prepared) { res.status(400).json({ error: prepared.error }); return; }
    key = prepared.key;
  }
  if (shared && !userCan(req, 'credentials.share')) {
    res.status(403).json({ error: 'Not permitted to create shared credentials' }); return;
  }

  const id = uuid();
  const isKey = type === 'key';
  execute(
    `INSERT INTO credentials (id, user_id, name, type, username, encrypted_password, private_key, encrypted_passphrase, shared, domain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, userId, name.trim(), type, username?.trim() || null,
      !isKey && password ? encrypt(password) : null,
      key ? encrypt(key.privateKey) : null,
      key?.passphrase ? encrypt(key.passphrase) : null,
      shared ? 1 : 0,
      !isKey && domain?.trim() ? domain.trim() : null,
    ],
  );

  logAudit({
    userId,
    eventType: 'credential.created',
    target: id,
    details: { name: name.trim(), type, shared: !!shared },
    ipAddress: req.ip,
  });

  const row = queryOne<ListRow>(`${LIST_SELECT} WHERE cr.id = ?`, [id])!;
  res.status(201).json(toJson(req, row));
});

// PUT /:id — update a credential. Empty secret fields keep the stored value;
// `clearPassword` / `clearPassphrase` explicitly remove them.
router.put('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const cred = queryOne<CredentialRow>('SELECT * FROM credentials WHERE id = ?', [id]);
  if (!cred || (cred.user_id !== userId && !cred.shared)) {
    res.status(404).json({ error: 'Credential not found' }); return;
  }
  if (!canEdit(req, cred)) { res.status(403).json({ error: 'Not authorized' }); return; }

  const { name, username, password, privateKey, passphrase, shared, domain, clearPassword, clearPassphrase } = req.body as {
    name?: string; username?: string; password?: string; privateKey?: string; passphrase?: string;
    shared?: boolean; domain?: string; clearPassword?: boolean; clearPassphrase?: boolean;
  };
  const isKey = cred.type === 'key';

  // Re-validate whenever the key or its passphrase changes, against whichever
  // half is not being replaced.
  let key: PreparedKey | null = null;
  if (isKey && (privateKey?.trim() || passphrase || clearPassphrase)) {
    let nextKey = privateKey?.trim() ? privateKey : undefined;
    let nextPassphrase = passphrase || undefined;
    try {
      if (!nextKey && cred.private_key) nextKey = decrypt(cred.private_key);
      if (!nextPassphrase && !clearPassphrase && cred.encrypted_passphrase) nextPassphrase = decrypt(cred.encrypted_passphrase);
    } catch { /* stored value unreadable — validate what we have */ }
    if (!nextKey) { res.status(400).json({ error: 'Private key is required' }); return; }
    const prepared = prepareKey(nextKey, nextPassphrase);
    if ('error' in prepared) { res.status(400).json({ error: prepared.error }); return; }
    key = prepared.key;
  }

  if (shared !== undefined && !!shared !== (cred.shared === 1)) {
    if (!userCan(req, 'credentials.share')) {
      res.status(403).json({ error: 'Not permitted to change credential sharing' }); return;
    }
    if (!shared) {
      const blocking = nonOwnerUsages(cred);
      if (blocking.length) {
        res.status(409).json(inUseBody(req, 'Credential is used by shared or other users\' connections', blocking));
        return;
      }
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  if (name !== undefined) {
    if (!name.trim()) { res.status(400).json({ error: 'Name is required' }); return; }
    updates.push('name = ?'); params.push(name.trim());
  }
  if (username !== undefined) { updates.push('username = ?'); params.push(username.trim() || null); }
  if (!isKey && domain !== undefined) { updates.push('domain = ?'); params.push(domain.trim() || null); }
  if (!isKey) {
    if (password) { updates.push('encrypted_password = ?'); params.push(encrypt(password)); }
    else if (clearPassword) { updates.push('encrypted_password = NULL'); }
  } else {
    if (key?.converted) {
      // Converted keys are stored unencrypted, so any passphrase is dropped.
      updates.push('private_key = ?', 'encrypted_passphrase = NULL'); params.push(encrypt(key.privateKey));
    } else {
      if (privateKey?.trim()) { updates.push('private_key = ?'); params.push(encrypt(privateKey)); }
      if (passphrase) { updates.push('encrypted_passphrase = ?'); params.push(encrypt(passphrase)); }
      else if (clearPassphrase) { updates.push('encrypted_passphrase = NULL'); }
    }
  }
  if (shared !== undefined) { updates.push('shared = ?'); params.push(shared ? 1 : 0); }

  if (updates.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  updates.push("updated_at = datetime('now')");
  params.push(id);
  execute(`UPDATE credentials SET ${updates.join(', ')} WHERE id = ?`, params);

  logAudit({
    userId,
    eventType: 'credential.updated',
    target: id,
    details: {
      name: name?.trim() ?? cred.name,
      secretChanged: !!(password || privateKey || passphrase || clearPassword || clearPassphrase),
      ...(shared !== undefined ? { shared: !!shared } : {}),
    },
    ipAddress: req.ip,
  });

  const row = queryOne<ListRow>(`${LIST_SELECT} WHERE cr.id = ?`, [id])!;
  res.json(toJson(req, row));
});

// DELETE /:id — refuses while any connection still references the credential
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const cred = queryOne<CredentialRow>('SELECT * FROM credentials WHERE id = ?', [id]);
  if (!cred || (cred.user_id !== userId && !cred.shared)) {
    res.status(404).json({ error: 'Credential not found' }); return;
  }
  if (!canEdit(req, cred)) { res.status(403).json({ error: 'Not authorized' }); return; }

  const inUse = queryAll<{ id: string; name: string; user_id: string }>(
    'SELECT id, name, user_id FROM connections WHERE credential_id = ? ORDER BY name COLLATE NOCASE', [id],
  );
  if (inUse.length) {
    res.status(409).json(inUseBody(req, 'Credential is in use', inUse));
    return;
  }

  execute('DELETE FROM credentials WHERE id = ?', [id]);
  logAudit({
    userId,
    eventType: 'credential.deleted',
    target: id,
    details: { name: cred.name },
    ipAddress: req.ip,
  });
  res.json({ success: true });
});

export default router;
