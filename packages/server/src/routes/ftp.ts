import express, { Router, type Request, type Response } from 'express';
import { PassThrough, Readable } from 'stream';
import * as ftp from 'basic-ftp';
import type { ConnectionOptions as TlsConnectionOptions } from 'tls';
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

/**
 * TLS options for an FTPS control/data connection. Certificate validation is on
 * (rejectUnauthorized: true) unless the connection was explicitly opted out via
 * skip_cert_validation — same per-connection flag and semantics as RDP's
 * skip_cert_validation (rdpProxy.ts), instead of the previous unconditional
 * rejectUnauthorized: false for every FTPS connection.
 */
export function ftpsSecureOptions(useFtps: boolean, skipCertValidation: number): TlsConnectionOptions | undefined {
  if (!useFtps) return undefined;
  return {
    rejectUnauthorized: skipCertValidation !== 1,
    ...(skipCertValidation === 1 ? { checkServerIdentity: () => undefined } : {}),
  };
}

const router = Router();
router.use(authRequired);
router.use(requirePermission('protocols.ftp'));

interface ConnRow {
  id: string;
  host: string;
  port: number;
  username: string | null;
  encrypted_password: string | null;
  user_id: string;
  shared: number;
  extra_config_json: string | null;
  skip_cert_validation: number;
  credential_id: string | null;
}

function getConn(connectionId: string, userId: string, role: string): ConnRow | null {
  const access = connectionAccessWhere('connections', userId, role);
  const conn = queryOne<ConnRow>(
    `SELECT id, host, port, username, encrypted_password, user_id, shared, extra_config_json, skip_cert_validation, credential_id
     FROM connections
     WHERE id = ? AND ${access.where} AND protocol = 'ftp'`,
    [connectionId, ...access.params],
  );
  return conn ? applyCredential(conn, userId) : null;
}

async function makeFtpClient(conn: ConnRow): Promise<ftp.Client> {
  const password = conn.encrypted_password
    ? (() => { try { return decrypt(conn.encrypted_password!); } catch { return ''; } })()
    : '';

  let useFtps = false;
  try {
    if (conn.extra_config_json) {
      const cfg = JSON.parse(conn.extra_config_json) as Record<string, unknown>;
      useFtps = cfg['ftps'] === true;
    }
  } catch { /* ignore */ }

  const client = new ftp.Client(10000);
  await client.access({
    host: conn.host,
    port: conn.port || 21,
    user: conn.username || 'anonymous',
    password,
    secure: useFtps,
    secureOptions: ftpsSecureOptions(useFtps, conn.skip_cert_validation),
  });
  return client;
}

// POST /:connectionId/list — list directory
router.post('/:connectionId/list', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath = '/' } = req.body as { path?: string };
  let client: ftp.Client | null = null;

  // Log connect audit event on root navigation (initial connection open)
  const isRootConnect = dirPath === '/' || dirPath === '' || dirPath === '.';
  if (isRootConnect) {
    logAudit({
      userId,
      eventType: 'session.ftp.connect',
      target: `${conn.host}:${conn.port || 21}`,
      details: { connectionId: req.params.connectionId },
      ipAddress: resolveClientIp(req),
    });
  }

  try {
    client = await makeFtpClient(conn);
    const entries = await client.list(dirPath || '/');
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'browse', path: dirPath || '/', detail: { count: entries.length } });
    res.json({
      files: entries.map((e) => ({
        filename: e.name,
        fileAttributes: e.isDirectory ? 0x10 : 0x00,
        size: e.isDirectory ? undefined : (e.size ?? undefined),
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'FTP error';
    console.error('[ftp] list error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    client?.close();
  }
});

// GET /:connectionId/download — download a file
router.get('/:connectionId/download', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  const rawName = filePath.split('/').pop() || 'download';
  const safeFileName = encodeURIComponent(rawName).replace(/['()]/g, encodeURIComponent);
  const clientSize = req.query.size ? parseInt(req.query.size as string, 10) : null;
  let client: ftp.Client | null = null;

  try {
    client = await makeFtpClient(conn);
    const pass = new PassThrough();
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFileName}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (clientSize !== null && !isNaN(clientSize)) res.setHeader('Content-Length', clientSize);
    pass.pipe(res);
    await client.downloadTo(pass, filePath);
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'download', path: filePath });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'FTP error';
    console.error('[ftp] download error:', msg);
    if (!res.headersSent) res.status(500).json({ error: 'Operation failed' });
  } finally {
    client?.close();
  }
});

// POST /:connectionId/upload — upload a file (body is raw buffer / req is readable)
// SECURITY: express.raw() here (not at the app level) so the body is only read after
// router.use(authRequired)/requirePermission and connectionAccessGuard have run.
router.post('/:connectionId/upload', connectionAccessGuard('ftp'), express.raw({ limit: '100mb', type: '*/*' }), async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'Invalid upload body' }); return; }

  let client: ftp.Client | null = null;

  try {
    client = await makeFtpClient(conn);
    await client.uploadFrom(Readable.from(req.body), filePath);
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'upload', path: filePath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'FTP error';
    console.error('[ftp] upload error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    client?.close();
  }
});

// POST /:connectionId/mkdir — create directory
router.post('/:connectionId/mkdir', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath } = req.body as { path?: string };
  if (!dirPath) { res.status(400).json({ error: 'path required' }); return; }

  let client: ftp.Client | null = null;

  try {
    client = await makeFtpClient(conn);
    await client.ensureDir(dirPath);
    // cd back to root so the connection is in a clean state before closing
    await client.cd('/');
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'mkdir', path: dirPath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'FTP error';
    console.error('[ftp] mkdir error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    client?.close();
  }
});

// DELETE /:connectionId/file — delete a file or directory
router.delete('/:connectionId/file', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  let client: ftp.Client | null = null;

  try {
    client = await makeFtpClient(conn);
    // Try as file first; if that fails, try as directory
    try {
      await client.remove(filePath);
    } catch {
      await client.removeDir(filePath);
    }
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'delete', path: filePath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'FTP error';
    console.error('[ftp] delete error:', msg);
    res.status(500).json({ error: 'Operation failed' });
  } finally {
    client?.close();
  }
});

// POST /:connectionId/rename — rename a file or folder
router.post('/:connectionId/rename', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { oldPath, newPath } = req.body as { oldPath?: string; newPath?: string };
  if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }

  let client: ftp.Client | null = null;
  try {
    client = await makeFtpClient(conn);
    await client.rename(oldPath, newPath);
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'rename', path: `${oldPath} → ${newPath}` });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'FTP error' });
  } finally { client?.close(); }
});

// POST /:connectionId/stat — get file info (size)
router.post('/:connectionId/stat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: filePath } = req.body as { path?: string };
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  let client: ftp.Client | null = null;
  try {
    client = await makeFtpClient(conn);
    const size = await client.size(filePath);
    const lastMod = await client.lastMod(filePath);
    res.json({
      size,
      mtime: lastMod.toISOString(),
      isDirectory: false,
    });
  } catch (e: unknown) {
    // If size fails, it's likely a directory
    try {
      res.json({ size: null, mtime: null, isDirectory: true });
    } catch {
      res.status(500).json({ error: e instanceof Error ? e.message : 'FTP error' });
    }
  } finally { client?.close(); }
});

// POST /:connectionId/folder-size — recursively total a folder's size (on demand, bounded)
router.post('/:connectionId/folder-size', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath } = req.body as { path?: unknown };
  if (typeof dirPath !== 'string' || !dirPath || dirPath.length > 4096) { res.status(400).json({ error: 'path required' }); return; }

  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  let client: ftp.Client | null = null;
  try {
    client = await makeFtpClient(conn);
    const ftpClient = client;

    const total = await computeFolderSize(dirPath, {
      signal: abort.signal,
      joinPath: (dir, name) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`),
      listDir: async (p) => {
        const entries = await ftpClient.list(p);
        return entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory,
          isSymlink: e.isSymbolicLink,
          size: e.size,
        }));
      },
    });

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'folder-size', path: dirPath, detail: { ...total } });
    res.json(total);
  } catch (e: unknown) {
    console.error('[ftp] folder-size error:', e instanceof Error ? e.message : e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to calculate folder size' });
  } finally { client?.close(); }
});

// POST /:connectionId/copy — copy a file (server-side download + upload)
router.post('/:connectionId/copy', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { srcPath, destPath } = req.body as { srcPath?: string; destPath?: string };
  if (!srcPath || !destPath) { res.status(400).json({ error: 'srcPath and destPath required' }); return; }

  let client: ftp.Client | null = null;
  try {
    client = await makeFtpClient(conn);
    // Download to memory then upload (FTP has no native copy)
    const pass = new PassThrough();
    const chunks: Buffer[] = [];
    pass.on('data', (chunk: Buffer) => chunks.push(chunk));
    await client.downloadTo(pass, srcPath);
    const data = Buffer.concat(chunks);
    const uploadStream = new PassThrough();
    uploadStream.end(data);
    await client.uploadFrom(uploadStream, destPath);
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'ftp', action: 'copy', path: `${srcPath} → ${destPath}` });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'FTP error' });
  } finally { client?.close(); }
});

export default router;
