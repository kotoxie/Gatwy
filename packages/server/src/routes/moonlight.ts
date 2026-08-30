import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import { queryOne, execute } from '../db/helpers.js';
import { authRequired } from '../middleware/auth.js';
import { userHasPermission, wsCanAccess } from '../services/permissions.js';
import { logAudit } from '../services/audit.js';
import { resolveClientIp } from '../services/ip.js';
import { resolveMoonlightHostAddress } from '../services/moonlightAddress.js';
import {
  ensureMoonlightWeb,
  getMoonlightRuntimeError,
  isMoonlightWebAvailable,
  mlwAddHost,
  mlwDeleteHost,
  mlwGetHost,
  mlwListApps,
  mlwPair,
  MOONLIGHT_UNAVAILABLE_BODY,
  readPairInfoFromStorage,
  restorePairInfoToStorage,
} from '../services/moonlightWeb.js';
import {
  applyMoonlightSettingsPatch,
  deleteEncryptedPairing,
  loadEncryptedPairing,
  mergeMoonlightExtra,
  moonlightSettingsResponse,
  normalizeMoonlightResolution,
  normalizeMoonlightTouchMode,
  parseMoonlightExtra,
  resolveHttpPort,
  saveEncryptedPairing,
  type MoonlightExtraConfig,
} from '../services/moonlightPairing.js';

const router = Router();
router.use(authRequired);

interface ConnRow {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  user_id: string;
  extra_config_json: string | null;
}

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function getAccessibleMoonlightConn(req: Request, connectionId: string): ConnRow | null {
  const userId = req.user!.userId;
  if (!userHasPermission(userId, 'protocols.moonlight')) return null;
  const access = wsCanAccess(userId);
  return queryOne<ConnRow>(
    `SELECT id, name, protocol, host, port, user_id, extra_config_json
     FROM connections WHERE id = ? AND protocol = 'moonlight' AND ${access.where}`,
    [connectionId, ...access.params],
  ) ?? null;
}

function saveExtra(connectionId: string, extra: MoonlightExtraConfig): void {
  execute(
    `UPDATE connections SET extra_config_json = ?, updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(extra), connectionId],
  );
}

function rejectIfMoonlightUnavailable(res: Response): boolean {
  if (isMoonlightWebAvailable()) return false;
  const runtimeError = getMoonlightRuntimeError();
  res.status(503).json(runtimeError
    ? { ...MOONLIGHT_UNAVAILABLE_BODY, error: runtimeError }
    : MOONLIGHT_UNAVAILABLE_BODY);
  return true;
}

async function ensureHost(conn: ConnRow, extra: MoonlightExtraConfig): Promise<{ hostId: number; extra: MoonlightExtraConfig }> {
  await ensureMoonlightWeb();

  const httpPort = resolveHttpPort(conn.port, extra);
  const address = await resolveMoonlightHostAddress(conn.host);
  let hostId = extra.mlHostId;

  if (hostId) {
    const stored = loadEncryptedPairing(conn.id);
    if (stored?.pairInfo) {
      restorePairInfoToStorage(hostId, stored.pairInfo);
    }
    try {
      const host = await mlwGetHost(hostId);
      if (host.address === address) {
        return {
          hostId,
          extra: mergeMoonlightExtra(extra, {
            mlHostId: hostId,
            paired: host.paired === 'Paired',
          }),
        };
      }
      // moonlight-common RTSP requires an IP literal; replace hosts stored as DNS names.
      try { await mlwDeleteHost(hostId); } catch { /* recreate below */ }
      hostId = undefined;
    } catch {
      hostId = undefined;
    }
  }

  const host = await mlwAddHost(address, httpPort);
  const next = mergeMoonlightExtra(extra, {
    mlHostId: host.host_id,
    httpPort,
    paired: host.paired === 'Paired',
  });
  saveExtra(conn.id, next);

  const stored = loadEncryptedPairing(conn.id);
  if (stored?.pairInfo) {
    restorePairInfoToStorage(host.host_id, stored.pairInfo);
    try {
      const refreshed = await mlwGetHost(host.host_id);
      next.paired = refreshed.paired === 'Paired';
      saveExtra(conn.id, next);
    } catch { /* ignore */ }
  }

  return { hostId: host.host_id, extra: next };
}

router.get('/:id/status', async (req: Request, res: Response) => {
  const conn = getAccessibleMoonlightConn(req, paramId(req));
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  if (rejectIfMoonlightUnavailable(res)) return;

  try {
    let extra = parseMoonlightExtra(conn.extra_config_json);
    const { hostId, extra: next } = await ensureHost(conn, extra);
    extra = next;
    saveExtra(conn.id, extra);

    const host = await mlwGetHost(hostId);
    const paired = host.paired === 'Paired';
    if (extra.paired !== paired) {
      extra = mergeMoonlightExtra(extra, { paired });
      saveExtra(conn.id, extra);
    }

    let apps: { appId: number; title: string }[] = [];
    if (paired) {
      try {
        apps = (await mlwListApps(hostId)).map((a) => ({ appId: a.app_id, title: a.title }));
      } catch { /* host offline */ }
    }

    const runtimeError = getMoonlightRuntimeError();
    res.json({
      available: true,
      paired,
      hostId,
      host: conn.host,
      port: conn.port,
      httpPort: resolveHttpPort(conn.port, extra),
      appName: extra.appName || 'Desktop',
      appId: extra.appId ?? null,
      apps,
      hasStoredPairing: !!loadEncryptedPairing(conn.id),
      bitrateKbps: extra.bitrateKbps ?? 20000,
      fps: extra.fps ?? 60,
      resolution: normalizeMoonlightResolution(extra.resolution),
      touchMode: normalizeMoonlightTouchMode(extra.touchMode),
      ...(runtimeError ? { runtimeWarning: runtimeError } : {}),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Moonlight status failed' });
  }
});

router.put('/:id/settings', (req: Request, res: Response) => {
  const conn = getAccessibleMoonlightConn(req, paramId(req));
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  const extra = applyMoonlightSettingsPatch(
    parseMoonlightExtra(conn.extra_config_json),
    req.body as Record<string, unknown>,
  );
  saveExtra(conn.id, extra);
  res.json(moonlightSettingsResponse(extra));
});

router.post('/:id/pair', async (req: Request, res: Response) => {
  const conn = getAccessibleMoonlightConn(req, paramId(req));
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  if (rejectIfMoonlightUnavailable(res)) return;

  const clientIp = resolveClientIp(req);
  const sessionId = uuid();

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as unknown as { flushHeaders: () => void }).flushHeaders();
  }

  const write = (obj: unknown) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
  };

  try {
    let extra = parseMoonlightExtra(conn.extra_config_json);
    const { hostId, extra: next } = await ensureHost(conn, extra);
    extra = next;

    const current = await mlwGetHost(hostId);
    if (current.paired === 'Paired') {
      write({ paired: true, hostId, alreadyPaired: true });
      res.end();
      return;
    }

    logAudit({
      userId: req.user!.userId,
      eventType: 'session.moonlight.pair',
      target: `${conn.host}:${conn.port}`,
      details: { connectionId: conn.id, sessionId, hostId, phase: 'start' },
      ipAddress: clientIp,
    });

    const pairedHost = await mlwPair(hostId, (pin) => {
      write({ pin });
    });

    const pairInfo = readPairInfoFromStorage(hostId);
    if (pairInfo) {
      saveEncryptedPairing({
        connectionId: conn.id,
        host: conn.host,
        httpPort: resolveHttpPort(conn.port, extra),
        mlHostId: hostId,
        pairInfo,
        savedAt: new Date().toISOString(),
      });
    }

    extra = mergeMoonlightExtra(extra, { paired: true, mlHostId: hostId });
    saveExtra(conn.id, extra);

    logAudit({
      userId: req.user!.userId,
      eventType: 'session.moonlight.pair',
      target: `${conn.host}:${conn.port}`,
      details: { connectionId: conn.id, sessionId, hostId, phase: 'complete', name: pairedHost.name },
      ipAddress: clientIp,
    });

    write({ paired: true, hostId, name: pairedHost.name ?? conn.name });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pairing failed';
    logAudit({
      userId: req.user!.userId,
      eventType: 'session.moonlight.pair',
      target: `${conn.host}:${conn.port}`,
      details: { connectionId: conn.id, sessionId, phase: 'error', error: message },
      ipAddress: clientIp,
    });
    write({ error: message });
    res.end();
  }
});

router.delete('/:id/pairing', async (req: Request, res: Response) => {
  const conn = getAccessibleMoonlightConn(req, paramId(req));
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  if (rejectIfMoonlightUnavailable(res)) return;

  try {
    await ensureMoonlightWeb();
    const extra = parseMoonlightExtra(conn.extra_config_json);
    if (extra.mlHostId) {
      try { await mlwDeleteHost(extra.mlHostId); } catch { /* ignore */ }
    }
    deleteEncryptedPairing(conn.id);
    const next = mergeMoonlightExtra(extra, {
      paired: false,
      mlHostId: undefined,
    });
    delete next.mlHostId;
    saveExtra(conn.id, { ...next, paired: false });

    logAudit({
      userId: req.user!.userId,
      eventType: 'session.moonlight.pair',
      target: `${conn.host}:${conn.port}`,
      details: { connectionId: conn.id, phase: 'forget' },
      ipAddress: resolveClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to forget pairing' });
  }
});

router.get('/:id/apps', async (req: Request, res: Response) => {
  const conn = getAccessibleMoonlightConn(req, paramId(req));
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  if (rejectIfMoonlightUnavailable(res)) return;

  try {
    const extra = parseMoonlightExtra(conn.extra_config_json);
    const { hostId } = await ensureHost(conn, extra);
    const apps = await mlwListApps(hostId);
    res.json({
      hostId,
      apps: apps.map((a) => ({ appId: a.app_id, title: a.title, hdr: !!a.is_hdr_supported })),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to list apps' });
  }
});

router.post('/:id/session', async (req: Request, res: Response) => {
  const conn = getAccessibleMoonlightConn(req, paramId(req));
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  if (rejectIfMoonlightUnavailable(res)) return;

  try {
    let extra = parseMoonlightExtra(conn.extra_config_json);
    const { hostId, extra: next } = await ensureHost(conn, extra);
    extra = next;

    const host = await mlwGetHost(hostId);
    if (host.paired !== 'Paired') {
      res.status(409).json({ error: 'Host is not paired', needsPairing: true, hostId });
      return;
    }

    const apps = await mlwListApps(hostId);
    const preferredName = (typeof req.body?.appName === 'string' && req.body.appName.trim())
      || extra.appName
      || 'Desktop';
    const preferredId = typeof req.body?.appId === 'number'
      ? req.body.appId
      : extra.appId;

    let app = preferredId != null
      ? apps.find((a) => a.app_id === preferredId)
      : undefined;
    if (!app) {
      app = apps.find((a) => a.title.toLowerCase() === preferredName.toLowerCase())
        || apps.find((a) => a.title.toLowerCase().includes('desktop'))
        || apps[0];
    }
    if (!app) {
      res.status(404).json({ error: 'No apps available on Sunshine host' });
      return;
    }

    extra = mergeMoonlightExtra(extra, { appId: app.app_id, appName: app.title, paired: true });
    saveExtra(conn.id, extra);

    const sessionId = uuid();
    logAudit({
      userId: req.user!.userId,
      eventType: 'session.moonlight.connect',
      target: `${conn.host}:${conn.port}`,
      details: {
        connectionId: conn.id,
        sessionId,
        hostId,
        appId: app.app_id,
        appTitle: app.title,
      },
      ipAddress: resolveClientIp(req),
    });

    const bitrateKbps = typeof req.body?.bitrateKbps === 'number' && Number.isFinite(req.body.bitrateKbps)
      ? Math.max(1000, Math.min(150000, Math.round(req.body.bitrateKbps)))
      : (extra.bitrateKbps ?? 20000);
    const fps = typeof req.body?.fps === 'number' && Number.isFinite(req.body.fps)
      ? Math.max(15, Math.min(240, Math.round(req.body.fps)))
      : (extra.fps ?? 60);
    const resolution = req.body?.resolution !== undefined
      ? normalizeMoonlightResolution(req.body.resolution)
      : normalizeMoonlightResolution(extra.resolution);
    const touchMode = req.body?.touchMode !== undefined
      ? normalizeMoonlightTouchMode(req.body.touchMode)
      : normalizeMoonlightTouchMode(extra.touchMode);

    extra = mergeMoonlightExtra(extra, { bitrateKbps, fps, resolution, touchMode, paired: true });
    saveExtra(conn.id, extra);

    res.json({
      sessionId,
      hostId,
      appId: app.app_id,
      appTitle: app.title,
      streamPath: `/mlw/stream.html?hostId=${hostId}&appId=${app.app_id}`,
      bitrateKbps,
      fps,
      resolution,
      touchMode,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to start session' });
  }
});

router.post('/:id/disconnect-audit', (req: Request, res: Response) => {
  const conn = getAccessibleMoonlightConn(req, paramId(req));
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

  logAudit({
    userId: req.user!.userId,
    eventType: 'session.moonlight.disconnect',
    target: `${conn.host}:${conn.port}`,
    details: {
      connectionId: conn.id,
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined,
    },
    ipAddress: resolveClientIp(req),
  });
  res.json({ ok: true });
});

export default router;
