import express, { Router, type Request, type Response } from 'express';
import { Client as SshClient } from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import crypto from 'crypto';
import { queryOne, execute } from '../db/helpers.js';
import { authRequired, requirePermission } from '../middleware/auth.js';
import { decrypt } from '../services/encryption.js';
import { applyCredential } from '../services/credentials.js';
import { friendlyKeyError, prepareKey } from '../services/sshKeys.js';
import { logAudit } from '../services/audit.js';
import { logFileSessionEvent } from '../services/fileSession.js';
import { computeFolderSize } from '../services/folderSize.js';
import { resolveClientIp } from '../services/ip.js';
import { connectionAccessGuard } from '../middleware/preBodyGuards.js';
import { connectionAccessWhere } from '../services/permissions.js';

const router = Router();
router.use(authRequired);
router.use(requirePermission('protocols.ssh'));

interface ConnRow {
  id: string;
  host: string;
  port: number;
  username: string | null;
  encrypted_password: string | null;
  private_key: string | null;
  user_id: string;
  shared: number;
  host_fingerprint: string | null;
  credential_id: string | null;
  encrypted_passphrase?: string | null;
}

function getConn(connectionId: string, userId: string, role: string): ConnRow | null {
  const access = connectionAccessWhere('connections', userId, role);
  const conn = queryOne<ConnRow>(
    `SELECT id, host, port, username, encrypted_password, private_key, user_id, shared, host_fingerprint, credential_id
     FROM connections
     WHERE id = ? AND ${access.where} AND protocol IN ('sftp', 'ssh')`,
    [connectionId, ...access.params],
  );
  return conn ? applyCredential(conn, userId) : null;
}

function connectSftp(conn: ConnRow): Promise<{ ssh: SshClient; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const ssh = new SshClient();
    const password = conn.encrypted_password
      ? (() => { try { return decrypt(conn.encrypted_password!); } catch { return undefined; } })()
      : undefined;
    const storedKey = conn.private_key
      ? (() => { try { return decrypt(conn.private_key!); } catch { return undefined; } })()
      : undefined;
    const storedPassphrase = conn.encrypted_passphrase
      ? (() => { try { return decrypt(conn.encrypted_passphrase!); } catch { return undefined; } })()
      : undefined;
    const preparedKey = storedKey ? prepareKey(storedKey, storedPassphrase) : undefined;
    if (preparedKey && 'error' in preparedKey) { reject(new Error(preparedKey.error)); return; }
    const privateKey = preparedKey?.key.privateKey;
    const passphrase = preparedKey?.key.passphrase;

    ssh.on('ready', () => {
      ssh.sftp((err, sftp) => {
        if (err) { ssh.end(); reject(err); return; }
        resolve({ ssh, sftp });
      });
    });

    ssh.on('error', (err) => reject(err));

    try {
      ssh.connect({
        host: conn.host,
        port: conn.port || 22,
        username: conn.username || 'root',
        ...(privateKey ? { privateKey, passphrase } : { password }),
        readyTimeout: 10000,
        hostVerifier: (key: Buffer) => {
          const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
          if (conn.host_fingerprint) {
            return conn.host_fingerprint === fingerprint;
          }
          execute('UPDATE connections SET host_fingerprint = ? WHERE id = ?', [fingerprint, conn.id]);
          return true;
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      const keyErr = msg.match(/^Cannot parse privateKey: (.*)$/);
      reject(new Error(keyErr ? friendlyKeyError(keyErr[1]) : msg));
    }
  });
}

// POST /:connectionId/list — list directory
router.post('/:connectionId/list', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath = '/' } = req.body as { path?: string };
  let ssh: SshClient | null = null;

  // Log connect audit event on root navigation (initial connection open)
  const isRootConnect = dirPath === '/' || dirPath === '' || dirPath === '.';
  if (isRootConnect) {
    logAudit({
      userId,
      eventType: 'session.sftp.connect',
      target: `${conn.host}:${conn.port || 22}`,
      details: { connectionId: req.params.connectionId },
      ipAddress: resolveClientIp(req),
    });
  }

  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;

    const entries = await new Promise<{ filename: string; fileAttributes: number; size?: number }[]>((resolve, reject) => {
      sftp.readdir(dirPath || '/', (err, list) => {
        if (err) { reject(err); return; }
        resolve(
          list.map((entry) => ({
            filename: entry.filename,
            fileAttributes: entry.attrs.isDirectory() ? 0x10 : 0x00,
            size: entry.attrs.isDirectory() ? undefined : (entry.attrs.size ?? undefined),
          })),
        );
      });
    });

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'browse', path: dirPath || '/', detail: { count: entries.length } });
    res.json({ files: entries });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SFTP error';
    console.error('[sftp] list error:', msg);
    res.status(500).json({ error: msg });
  } finally {
    ssh?.end();
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
  // Encode filename per RFC 5987 to prevent header injection
  const safeFileName = encodeURIComponent(rawName).replace(/['()]/g, encodeURIComponent);
  const clientSize = req.query.size ? parseInt(req.query.size as string, 10) : null;
  let ssh: SshClient | null = null;

  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;

    const stream = sftp.createReadStream(filePath);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFileName}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (clientSize !== null && !isNaN(clientSize)) res.setHeader('Content-Length', clientSize);
    stream.pipe(res);

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('error', reject);
    });
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'download', path: filePath });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SFTP error';
    console.error('[sftp] download error:', msg);
    if (!res.headersSent) res.status(500).json({ error: msg });
  } finally {
    ssh?.end();
  }
});

// POST /:connectionId/upload — upload a file (body is raw buffer)
// SECURITY: express.raw() here (not at the app level) so the body is only read after
// router.use(authRequired)/requirePermission and connectionAccessGuard have run.
router.post('/:connectionId/upload', connectionAccessGuard('sftp', 'ssh'), express.raw({ limit: '100mb', type: '*/*' }), async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'Invalid upload body' }); return; }

  let ssh: SshClient | null = null;

  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;

    const fileData = req.body;
    const writeStream = sftp.createWriteStream(filePath);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end(fileData);
    });

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'upload', path: filePath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SFTP error';
    console.error('[sftp] upload error:', msg);
    res.status(500).json({ error: msg });
  } finally {
    ssh?.end();
  }
});

// POST /:connectionId/mkdir — create directory
router.post('/:connectionId/mkdir', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: dirPath } = req.body as { path?: string };
  if (!dirPath) { res.status(400).json({ error: 'path required' }); return; }

  let ssh: SshClient | null = null;

  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;

    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => {
        if (err) { reject(err); return; }
        resolve();
      });
    });

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'mkdir', path: dirPath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SFTP error';
    console.error('[sftp] mkdir error:', msg);
    res.status(500).json({ error: msg });
  } finally {
    ssh?.end();
  }
});

// Recursively delete a directory using pure SFTP operations
async function sftpRmdirRecursive(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const entries = await new Promise<{ filename: string; attrs: import('ssh2').Stats }[]>((resolve, reject) => {
    sftp.readdir(dirPath, (err, list) => err ? reject(err) : resolve(list));
  });
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    const fullPath = dirPath.endsWith('/') ? `${dirPath}${entry.filename}` : `${dirPath}/${entry.filename}`;
    if (entry.attrs.isDirectory()) {
      await sftpRmdirRecursive(sftp, fullPath);
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(fullPath, (err) => err ? reject(err) : resolve());
      });
    }
  }
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(dirPath, (err) => err ? reject(err) : resolve());
  });
}

// Recursively copy a directory using pure SFTP operations
async function sftpCopyDirRecursive(sftp: SFTPWrapper, srcPath: string, destPath: string): Promise<void> {
  // Create destination directory
  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(destPath, (err) => err ? reject(err) : resolve());
  });
  const entries = await new Promise<{ filename: string; attrs: import('ssh2').Stats }[]>((resolve, reject) => {
    sftp.readdir(srcPath, (err, list) => err ? reject(err) : resolve(list));
  });
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    const src = srcPath.endsWith('/') ? `${srcPath}${entry.filename}` : `${srcPath}/${entry.filename}`;
    const dest = destPath.endsWith('/') ? `${destPath}${entry.filename}` : `${destPath}/${entry.filename}`;
    if (entry.attrs.isDirectory()) {
      await sftpCopyDirRecursive(sftp, src, dest);
    } else {
      // Read file into memory then write to destination
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const rs = sftp.createReadStream(src);
        rs.on('data', (chunk: Buffer) => chunks.push(chunk));
        rs.on('end', () => resolve(Buffer.concat(chunks)));
        rs.on('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(dest);
        ws.on('close', () => resolve());
        ws.on('error', reject);
        ws.end(data);
      });
    }
  }
}

// DELETE /:connectionId/file — delete a file or directory
router.delete('/:connectionId/file', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const rawPath = req.query.path as string;
  if (!rawPath) { res.status(400).json({ error: 'path required' }); return; }
  const filePath = rawPath.replace(/\/\/+/g, '/');

  let ssh: SshClient | null = null;

  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;

    const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.stat(filePath, (err, s) => err ? reject(err) : resolve(s));
    });

    if (stats.isDirectory()) {
      await sftpRmdirRecursive(sftp, filePath);
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(filePath, (err) => err ? reject(err) : resolve());
      });
    }

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'delete', path: filePath });
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SFTP error';
    res.status(500).json({ error: msg });
  } finally {
    ssh?.end();
  }
});

// POST /:connectionId/rename — rename a file or folder
router.post('/:connectionId/rename', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { oldPath, newPath } = req.body as { oldPath?: string; newPath?: string };
  if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }

  let ssh: SshClient | null = null;
  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => err ? reject(err) : resolve());
    });
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'rename', path: `${oldPath} → ${newPath}` });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'SFTP error' });
  } finally { ssh?.end(); }
});

// POST /:connectionId/stat — get file/folder info (size, permissions, timestamps)
router.post('/:connectionId/stat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: filePath } = req.body as { path?: string };
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

  let ssh: SshClient | null = null;
  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;
    const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.stat(filePath, (err, s) => err ? reject(err) : resolve(s));
    });
    res.json({
      size: stats.size,
      mode: stats.mode,
      permissions: `0${(stats.mode & 0o7777).toString(8)}`,
      uid: stats.uid,
      gid: stats.gid,
      atime: new Date(stats.atime * 1000).toISOString(),
      mtime: new Date(stats.mtime * 1000).toISOString(),
      isDirectory: stats.isDirectory(),
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'SFTP error' });
  } finally { ssh?.end(); }
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

  let ssh: SshClient | null = null;
  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;

    const total = await computeFolderSize(dirPath, {
      signal: abort.signal,
      joinPath: (dir, name) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`),
      listDir: (p) => new Promise((resolve, reject) => {
        sftp.readdir(p, (err, list) => {
          if (err) { reject(err); return; }
          resolve(list.map((e) => ({
            name: e.filename,
            isDirectory: e.attrs.isDirectory(),
            isSymlink: e.attrs.isSymbolicLink(),
            size: e.attrs.size,
          })));
        });
      }),
    });

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'folder-size', path: dirPath, detail: { ...total } });
    res.json(total);
  } catch (e: unknown) {
    console.error('[sftp] folder-size error:', e instanceof Error ? e.message : e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to calculate folder size' });
  } finally { ssh?.end(); }
});

// POST /:connectionId/chmod — change file permissions
router.post('/:connectionId/chmod', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { path: filePath, mode } = req.body as { path?: string; mode?: number };
  if (!filePath || mode === undefined) { res.status(400).json({ error: 'path and mode required' }); return; }

  let ssh: SshClient | null = null;
  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(filePath, mode, (err) => err ? reject(err) : resolve());
    });
    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'chmod', path: `${filePath} → ${mode.toString(8)}` });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'SFTP error' });
  } finally { ssh?.end(); }
});

// POST /:connectionId/copy — copy a file or directory using pure SFTP
router.post('/:connectionId/copy', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conn = getConn(req.params.connectionId as string, userId, req.user!.role);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const { srcPath, destPath } = req.body as { srcPath?: string; destPath?: string };
  if (!srcPath || !destPath) { res.status(400).json({ error: 'srcPath and destPath required' }); return; }

  let ssh: SshClient | null = null;
  try {
    const result = await connectSftp(conn);
    ssh = result.ssh;
    const { sftp } = result;

    const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.stat(srcPath, (err, s) => err ? reject(err) : resolve(s));
    });

    if (stats.isDirectory()) {
      await sftpCopyDirRecursive(sftp, srcPath, destPath);
    } else {
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const rs = sftp.createReadStream(srcPath);
        rs.on('data', (chunk: Buffer) => chunks.push(chunk));
        rs.on('end', () => resolve(Buffer.concat(chunks)));
        rs.on('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(destPath);
        ws.on('close', () => resolve());
        ws.on('error', reject);
        ws.end(data);
      });
    }

    logFileSessionEvent({ req, userId, connectionId: req.params.connectionId as string, protocol: 'sftp', action: 'copy', path: `${srcPath} → ${destPath}` });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'SFTP error' });
  } finally { ssh?.end(); }
});

export default router;
