import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { authRequired, userCan } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { getAllSettings, getSetting, setSettings } from '../services/settings.js';
import { encrypt, usingFileKey } from '../services/encryption.js';
import { execute, queryAll } from '../db/helpers.js';
import { resolveClientIp } from '../services/ip.js';

const router = Router();

interface IpRuleRow {
  id: string;
  type: 'allow' | 'deny';
  cidr: string;
  description: string | null;
}

// GET /public — unauthenticated, returns safe public settings needed before login
router.get('/public', (_req: Request, res: Response) => {
  const PUBLIC_KEYS = [
    'app.name',
    'app.logo',
    'health_monitor.enabled',
    'ssh.font_family',
    'ssh.font_size',
    'ssh.cursor_style',
    'ssh.cursor_blink',
    'ssh.theme',
    'ssh.scrollback',
    'auth.oidc_enabled',
    'auth.oidc_button_label',
    'auth.ldap_enabled',
    'auth.local_enabled',
    'security.idle_timeout_minutes',
  ];
  const settings: Record<string, string> = {};
  for (const key of PUBLIC_KEYS) {
    settings[key] = getSetting(key);
  }
  settings['system.insecure_key'] = String(usingFileKey);
  res.json({ settings });
});

// All routes below require authentication
router.use(authRequired);

router.get('/ip-rules', (req: Request, res: Response) => {
  if (!userCan(req, 'settings.security')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  const mode = getSetting('security.ip_rules_mode') as 'allowlist' | 'denylist';
  const enabled = getSetting('security.ip_rules_enabled') === 'true';
  const rules = queryAll<IpRuleRow>('SELECT id, type, cidr, description FROM ip_rules ORDER BY rowid');
  res.json({ enabled, mode, currentIp: resolveClientIp(req), rules });
});

router.put('/ip-rules', (req: Request, res: Response) => {
  if (!userCan(req, 'settings.security')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  const body = req.body as {
    enabled?: boolean;
    mode?: 'allowlist' | 'denylist';
    rules?: Array<{ id?: string; type?: 'allow' | 'deny'; cidr?: string; description?: string }>;
  };

  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const enabled = !!body.enabled;
  const mode = body.mode === 'denylist' ? 'denylist' : 'allowlist';
  const rules = Array.isArray(body.rules) ? body.rules : [];
  const normalizedRules: Array<{ id?: string; type: 'allow' | 'deny'; cidr: string; description: string }> = [];

  for (const rule of rules) {
    if (!rule || (rule.type !== 'allow' && rule.type !== 'deny') || !rule.cidr?.trim()) {
      res.status(400).json({ error: 'Invalid IP rule' });
      return;
    }

    normalizedRules.push({
      id: rule.id,
      type: rule.type,
      cidr: rule.cidr.trim(),
      description: (rule.description ?? '').trim(),
    });
  }

  execute('DELETE FROM ip_rules');
  for (const rule of normalizedRules) {
    execute(
      'INSERT INTO ip_rules (id, type, cidr, description, created_by) VALUES (?, ?, ?, ?, ?)',
      [rule.id ?? crypto.randomUUID(), rule.type, rule.cidr, rule.description || null, req.user!.userId],
    );
  }

  setSettings({
    'security.ip_rules_enabled': String(enabled),
    'security.ip_rules_mode': mode,
  });

  logAudit({
    userId: req.user!.userId,
    eventType: 'security.ip_rules_updated',
    details: { enabled, mode, ruleCount: normalizedRules.length },
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// GET / — return all settings (settings.manage permission)
router.get('/', (req: Request, res: Response) => {
  if (!userCan(req, 'settings.manage')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }
  const settings = getAllSettings();
  settings['system.insecure_key'] = String(usingFileKey);
  res.json({ settings });
});

// PUT / — update settings (settings.manage permission)
router.put('/', (req: Request, res: Response) => {
  if (!userCan(req, 'settings.manage')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  const updates = req.body as Record<string, string>;
  if (typeof updates !== 'object' || Array.isArray(updates) || updates === null) {
    res.status(400).json({ error: 'Body must be a JSON object of key-value pairs' });
    return;
  }

  // Fields that must be encrypted before storage
  const ENCRYPTED_FIELDS = ['auth.ldap_bind_password', 'auth.oidc_client_secret'];
  const UNCHANGED_SENTINEL = '__unchanged__';

  // Capture before values for audit diff
  const before: Record<string, string> = {};
  for (const key of Object.keys(updates)) before[key] = getSetting(key);

  const processedUpdates: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === UNCHANGED_SENTINEL) continue;
    if (ENCRYPTED_FIELDS.includes(key) && value) {
      processedUpdates[key] = encrypt(value);
    } else {
      processedUpdates[key] = value;
    }
  }

  setSettings(processedUpdates);

  logAudit({
    userId: req.user!.userId,
    eventType: 'settings.updated',
    details: { before, after: processedUpdates },
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

export default router;
