import express, { Router, type Request, type Response } from 'express';
import { queryOne } from '../db/helpers.js';
import { authRequired, requirePermission } from '../middleware/auth.js';
import { decrypt } from '../services/encryption.js';
import { applyCredential } from '../services/credentials.js';
import { logAudit } from '../services/audit.js';
import { logFileSessionEvent } from '../services/fileSession.js';
import { computeFolderSize } from '../services/folderSize.js';
import { resolveClientIp } from '../services/ip.js';
import { connectionAccessGuard } from '../middleware/preBodyGuards.js';
import { connectionAccessWhere } from '../services/permissions.js';
import { patchSmbNtlm } from '../services/smbPatch.js';
import SMB2 from '@marsaud/smb2';

// Patch @marsaud/smb2 to use NTLMv2 — must run before any SMB connection
patchSmbNtlm();
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const router = Router();
router.use(authRequired);
router.use(requirePermission('protocols.smb'));

interface ConnRow {
  id: string;
  host: string;
  port: number;
  username: string | null;
  encrypted_password: string | null;
  extra_config_json: string | null;
  user_id: string;
  shared: number;
  credential_id: string | null;
  credential_domain?: string | null;
}

async function getConn(connectionId: string, userId: string, role: string): Promise<ConnRow | null> {
  const access = connectionAccessWhere('connections', userId, role);
  const conn = queryOne<ConnRow>(
    `SELECT id, host, port, username, encrypted_password, extra_config_json, user_id, shared, credential_id
     FROM connections
     WHERE id = ? AND ${access.where} AND protocol = 'smb'`,
    [connectionId, ...access.params],
  );
  return conn ? applyCredential(conn, userId) : null;
}

function makeSmbClient(conn: ConnRow): SMB2 {
  const password = conn.encrypted_password
    ? (() => { try { return decrypt(conn.encrypted_password!); } catch { return ''; } })()
    : '';

  // Parse share name from extra_config_json
  let shareName = '';
  let domain = '';
  try {
    if (conn.extra_config_json) {
      const cfg = JSON.parse(conn.extra_config_json) as { share?: string; domain?: string };
      // Strip any leading backslashes/forward slashes the user may have typed
      shareName = (cfg.share?.trim() ?? '').replace(/^[/\\]+/, '');
      domain = cfg.domain?.trim() ?? '';
    }
  } catch { /* ignore */ }

  // A linked credential's own domain takes precedence over the connection's.
  // It arrives via applyCredential, so a credential that isn't usable here
  // contributes no domain, just as it contributes no username or password.
  domain = conn.credential_domain || domain;

  if (!shareName) {
    throw new Error('SMB share name is not configured. Edit the connection and enter a share name.');
  }

  // SMB2 requires \\host\share format
  const share = `\\\\${conn.host}\\${shareName}`;

  // Anonymous access requires empty username/password — not 'guest'
  const isAnonymous = !conn.username && !password;
  return new SMB2({
    share,
    domain,
    username: isAnonymous ? '' : (conn.username || ''),
    password: isAnonymous ? '' : password,
    port: conn.port || 445,
    autoCloseTimeout: 5000,
  });
}

// Wrap an SMB operation so synchronous throws (e.g. from crypto) are caught too
async function smbOp<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      fn().then(resolve).catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// POST /:connectionId/list — list directory
router.post('/:connectionId/list', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath = '' } = req.body as { path?: string };
  let smb: SMB2 | null = null;

  // Log connect audit event when opening the root (initial connection)
  const isRootConnect = dirPath === '' || dirPath === '/' || dirPath === '\\';
  if (isRootConnect) {
    logAudit({
      userId,
      eventType: 'session.smb.connect',
      target: `${conn.host}:${conn.port || 445}`,
      details: { connectionId: req.params.connectionId },
      ipAddress: resolveClientIp(req),
    });
  }

  try {
    smb = makeSmbClient(conn);
    const files = await smbOp(() => smb!.readdir(dirPath, { stats: true }));
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'browse', path: dirPath || '\\', detail: { count: files.length } });
    res.json({
      files: files.map((f) => {
        const s = f as unknown as { size?: number };
        return {
          filename: f.name,
          fileAttributes: f.isDirectory() ? 0x10 : 0x00,
          size: f.isDirectory() ? undefined : (s.size ?? undefined),
        };
      }),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SMB error';
    console.error('[smb] list error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    smb?.disconnect();
  }
});

// GET /:connectionId/download — download a file
// Uses readFile() + temp file to avoid STATUS_PENDING from Windows SMB2 async interim responses
router.get('/:connectionId/download', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  const rawName = filePath.split(/[/\\]/).pop() || 'download';
  const safeFileName = encodeURIComponent(rawName).replace(/['()]/g, encodeURIComponent);
  const tmpFile = path.join(os.tmpdir(), `gatwy-smb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let smb: SMB2 | null = null;

  try {
    smb = makeSmbClient(conn);
    const data: Buffer = await smbOp(() => smb!.readFile(filePath));
    await fs.promises.writeFile(tmpFile, data);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFileName}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', data.length);
    const fileStream = fs.createReadStream(tmpFile);
    fileStream.pipe(res);
    await new Promise<void>((resolve, reject) => {
      fileStream.on('end', resolve);
      fileStream.on('error', reject);
      res.on('error', reject);
    });
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'download', path: filePath });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SMB error';
    console.error('[smb] download error:', msg);
    if (!res.headersSent) res.status(500).json({ error: 'Operation failed' });
  } finally {
    smb?.disconnect();
    fs.promises.unlink(tmpFile).catch(() => {});
  }
});

// POST /:connectionId/upload — upload a file
// SECURITY: express.raw() here (not at the app level) so the body is only read after
// router.use(authRequired)/requirePermission and connectionAccessGuard have run.
router.post('/:connectionId/upload', connectionAccessGuard('smb'), express.raw({ limit: '100mb', type: '*/*' }), async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'Invalid upload body' }); return; }

  let smb: SMB2 | null = null;

  try {
    smb = makeSmbClient(conn);
    const fileData = req.body;
    const stream = await smbOp(() => smb!.createWriteStream(filePath));
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end(fileData);
    });
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'upload', path: filePath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SMB error';
    console.error('[smb] upload error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    smb?.disconnect();
  }
});

// POST /:connectionId/mkdir — create directory
router.post('/:connectionId/mkdir', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath } = req.body as { path?: string };
  if (!dirPath) { res.status(400).json({ error: 'path required' }); return; }

  let smb: SMB2 | null = null;

  try {
    smb = makeSmbClient(conn);
    await smbOp(() => smb!.mkdir(dirPath));
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'mkdir', path: dirPath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SMB error';
    console.error('[smb] mkdir error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    smb?.disconnect();
  }
});

// Recursively delete a directory and all its contents
async function rmdirRecursive(smb: SMB2, dirPath: string): Promise<void> {
  const entries = await smbOp(() => smb.readdir(dirPath, { stats: true }));
  for (const entry of entries) {
    const childPath = dirPath ? `${dirPath}\\${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await rmdirRecursive(smb, childPath);
    } else {
      await smbOp(() => smb.unlink(childPath));
    }
  }
  await smbOp(() => smb.rmdir(dirPath));
}

// DELETE /:connectionId/file — delete a file or directory
router.delete('/:connectionId/file', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  let smb: SMB2 | null = null;

  try {
    smb = makeSmbClient(conn);
    // Try as file first; if that fails, try as directory (recursive)
    try {
      await smbOp(() => smb!.unlink(filePath));
    } catch {
      await rmdirRecursive(smb, filePath);
    }
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'delete', path: filePath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SMB error';
    console.error('[smb] delete error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    smb?.disconnect();
  }
});

// POST /:connectionId/rename — rename a file or folder
router.post('/:connectionId/rename', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { oldPath, newPath } = req.body as { oldPath?: string; newPath?: string };
  if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }

  let smb: SMB2 | null = null;
  try {
    smb = makeSmbClient(conn);
    await smbOp(() => smb!.rename(oldPath, newPath, { replace: false }));
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'rename', path: `${oldPath} → ${newPath}` });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'SMB error' });
  } finally { smb?.disconnect(); }
});

// POST /:connectionId/stat — get file/folder info (size, timestamps)
router.post('/:connectionId/stat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: filePath } = req.body as { path?: string };
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  let smb: SMB2 | null = null;
  try {
    smb = makeSmbClient(conn);
    const stats = await smbOp(() => smb!.stat(filePath)) as unknown as Record<string, unknown>;
    res.json({
      size: typeof stats.size === 'number' ? stats.size : null,
      mtime: stats.mtime instanceof Date ? stats.mtime.toISOString() : null,
      atime: stats.atime instanceof Date ? stats.atime.toISOString() : null,
      birthtime: stats.birthtime instanceof Date ? stats.birthtime.toISOString() : null,
      isDirectory: typeof stats.isDirectory === 'function' ? (stats.isDirectory as () => boolean)() : false,
    });
  } catch (e: unknown) {
    console.error('[smb] stat error:', e instanceof Error ? e.message : e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'SMB stat failed' });
  } finally { smb?.disconnect(); }
});

// POST /:connectionId/folder-size — recursively total a folder's size (on demand, bounded)
router.post('/:connectionId/folder-size', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath } = req.body as { path?: unknown };
  if (typeof dirPath !== 'string' || !dirPath || dirPath.length > 4096) { res.status(400).json({ error: 'path required' }); return; }

  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  let smb: SMB2 | null = null;
  try {
    smb = makeSmbClient(conn);
    const client = smb;

    const total = await computeFolderSize(dirPath, {
      signal: abort.signal,
      joinPath: (dir, name) => (dir ? `${dir}\\${name}` : name),
      listDir: async (p) => {
        const entries = await smbOp(() => client.readdir(p, { stats: true }));
        return entries.map((f) => ({
          name: f.name,
          isDirectory: f.isDirectory(),
          size: (f as unknown as { size?: number }).size,
        }));
      },
    });

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'folder-size', path: dirPath, detail: { ...total } });
    res.json(total);
  } catch (e: unknown) {
    console.error('[smb] folder-size error:', e instanceof Error ? e.message : e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to calculate folder size' });
  } finally { smb?.disconnect(); }
});

// POST /:connectionId/copy — copy a file (server-side read + write)
router.post('/:connectionId/copy', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = await getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { srcPath, destPath } = req.body as { srcPath?: string; destPath?: string };
  if (!srcPath || !destPath) { res.status(400).json({ error: 'srcPath and destPath required' }); return; }

  let smb: SMB2 | null = null;
  try {
    smb = makeSmbClient(conn);

    // Check if source is a directory — if so, do recursive copy
    const stats = await smbOp(() => smb!.stat(srcPath));
    const isDirectory = (stats as unknown as { isDirectory: () => boolean }).isDirectory();

    if (isDirectory) {
      await copyDirRecursive(smb, srcPath, destPath);
    } else {
      const data = await smbOp(() => smb!.readFile(srcPath));
      await smbOp(() => smb!.writeFile(destPath, data));
    }

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'smb', action: 'copy', path: `${srcPath} → ${destPath}` });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'SMB error' });
  } finally { smb?.disconnect(); }
});

// Recursively copy a directory and all its contents
async function copyDirRecursive(smb: SMB2, srcDir: string, destDir: string): Promise<void> {
  await smbOp(() => smb.mkdir(destDir));
  const entries = await smbOp(() => smb.readdir(srcDir, { stats: true }));
  for (const entry of entries) {
    const srcChild = `${srcDir}\\${entry.name}`;
    const destChild = `${destDir}\\${entry.name}`;
    if (entry.isDirectory()) {
      await copyDirRecursive(smb, srcChild, destChild);
    } else {
      const data = await smbOp(() => smb.readFile(srcChild));
      await smbOp(() => smb.writeFile(destChild, data));
    }
  }
}

export default router;
