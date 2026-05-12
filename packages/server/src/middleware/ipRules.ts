import type { Request, Response, NextFunction } from 'express';
import { queryAll } from '../db/helpers.js';
import { getSetting } from '../services/settings.js';
import { logAudit } from '../services/audit.js';
import { resolveClientIp } from '../services/ip.js';

interface IpRuleRow {
  type: string;
  cidr: string;
}

function ipToNum(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) + parseInt(o, 10)) >>> 0, 0) >>> 0;
}

function matchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return cidr === ip;
  try {
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipToNum(ip) & mask) === (ipToNum(range) & mask);
  } catch {
    return false;
  }
}

export function ipRulesMiddleware(req: Request, res: Response, next: NextFunction): void {
  const enabled = getSetting('security.ip_rules_enabled') === 'true';
  if (!enabled) { next(); return; }

  const clientIp = resolveClientIp(req);

  const mode = getSetting('security.ip_rules_mode'); // 'allowlist' | 'denylist'
  const rules = queryAll<IpRuleRow>('SELECT type, cidr FROM ip_rules ORDER BY rowid');

  if (mode === 'allowlist') {
    const allowed = rules
      .filter((r) => r.type === 'allow')
      .some((r) => matchesCidr(clientIp, r.cidr));
    if (!allowed) {
      logAudit({
        eventType: 'security.ip_blocked',
        ipAddress: clientIp,
        details: { reason: 'not_in_allowlist', path: req.path, method: req.method },
      });
      res.status(403).json({ error: 'Access denied' });
      return;
    }
  } else {
    // denylist
    const denied = rules
      .filter((r) => r.type === 'deny')
      .some((r) => matchesCidr(clientIp, r.cidr));
    if (denied) {
      logAudit({
        eventType: 'security.ip_blocked',
        ipAddress: clientIp,
        details: { reason: 'in_denylist', path: req.path, method: req.method },
      });
      res.status(403).json({ error: 'Access denied' });
      return;
    }
  }

  next();
}
