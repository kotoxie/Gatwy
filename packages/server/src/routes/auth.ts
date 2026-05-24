import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { queryOne, execute } from '../db/helpers.js';
import { signToken, verifyToken, signMfaToken, verifyMfaToken } from '../services/jwt.js';
import { logAudit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { config } from '../config.js';
import { createLoginSession, hashToken } from '../services/loginSession.js';
import { authRequired, adminRequired } from '../middleware/auth.js';
import { getPermissionsForRole } from '../services/permissions.js';
import { verifySync as otpVerify } from 'otplib';
import { parseUA } from '../services/ua.js';
import { issueWsTicket } from '../services/wsTicket.js';
import { decrypt } from '../services/encryption.js';
import { authenticateLdap } from '../services/ldap.js';
import { buildOidcAuthUrl, handleOidcCallback, isOidcEnabled } from '../services/oidc.js';
import {
  isPasskeyEnabled,
  hasPasskeyMFA,
  getActivePasskeys,
  generatePasskeyAuthenticationOptions,
  verifyPasskeyAuthentication,
  cleanupExpiredChallenges,
} from '../services/passkey.js';

// ── Proxy detection helper ───────────────────────────────────────────────────
function detectProxyIp(req: Request): string | null {
  if (getSetting('security.proxy_detection_enabled') !== 'true') return null;

  const xff = req.headers['x-forwarded-for'];
  if (!xff) return null;

  const rawPeer = req.socket?.remoteAddress ?? '';
  const peerIp = rawPeer.replace(/^::ffff:/i, '');
  if (!peerIp) return null;

  const trusted = getSetting('security.trusted_proxies').trim();
  if (trusted === 'true' || trusted === '*') return null;
  if (trusted) {
    const entries = trusted.split(',').map((s) => s.trim()).filter(Boolean);
    const isAlreadyTrusted = entries.some((entry) => {
      if (entry.includes('/')) {
        try {
          const [range, bitsStr] = entry.split('/');
          const bits = parseInt(bitsStr, 10);
          if (bits < 0 || bits > 32) return false;
          const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
          const toNum = (s: string) =>
            s.split('.').reduce((acc, o) => ((acc << 8) + parseInt(o, 10)) >>> 0, 0) >>> 0;
          return (toNum(peerIp) & mask) === (toNum(range) & mask);
        } catch { return false; }
      }
      return entry === peerIp;
    });
    if (isAlreadyTrusted) return null;
  }

  return peerIp;
}

// ── IP-based rate limiting for login ──────────────────────────────────────────
interface IpRecord { count: number; resetAt: number; }
const ipLoginAttempts = new Map<string, IpRecord>();
const IP_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const IP_RATE_MAX = 30; // max login attempts per IP per window

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = ipLoginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    ipLoginAttempts.set(ip, { count: 1, resetAt: now + IP_RATE_WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= IP_RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipLoginAttempts) {
    if (now > rec.resetAt) ipLoginAttempts.delete(ip);
  }
}, IP_RATE_WINDOW_MS);

// ── Per-userId MFA brute-force protection ──────────────────────────────────────
const mfaLoginAttempts = new Map<string, IpRecord>();
const MFA_RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MFA_RATE_MAX = 5; // max failed MFA attempts per userId per window

function checkMfaRateLimit(userId: string): boolean {
  const now = Date.now();
  const rec = mfaLoginAttempts.get(userId);
  if (!rec || now > rec.resetAt) {
    mfaLoginAttempts.set(userId, { count: 1, resetAt: now + MFA_RATE_WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= MFA_RATE_MAX;
}

function clearMfaAttempts(userId: string): void {
  mfaLoginAttempts.delete(userId);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of mfaLoginAttempts) {
    if (now > rec.resetAt) mfaLoginAttempts.delete(id);
  }
}, MFA_RATE_WINDOW_MS);

const TRUSTED_DEVICE_COOKIE = 'gatwy_trusted_device';
const TRUSTED_DEVICE_DAYS = 30;

function isTrustedDevice(req: Request, userId: string): boolean {
  const cookieVal: string | undefined = req.cookies?.[TRUSTED_DEVICE_COOKIE];
  if (!cookieVal) return false;
  const hash = hashToken(cookieVal);
  const row = queryOne<{ id: string; expires_at: string }>(
    `SELECT id, expires_at FROM trusted_devices WHERE token_hash = ? AND user_id = ?`,
    [hash, userId],
  );
  if (!row) return false;
  // Check expiry
  const expiry = new Date(row.expires_at.replace(' ', 'T') + 'Z');
  if (expiry < new Date()) {
    execute('DELETE FROM trusted_devices WHERE id = ?', [row.id]);
    return false;
  }
  return true;
}

function setTrustedDevice(req: Request, res: Response, userId: string): void {
  const token = uuid() + uuid(); // 64-char random token
  const hash = hashToken(token);
  const ua = parseUA(req.headers['user-agent']);
  const ip = (req.ip ?? '').replace(/^::ffff:/i, '');
  const expiresDate = new Date();
  expiresDate.setDate(expiresDate.getDate() + TRUSTED_DEVICE_DAYS);
  const expiresStr = expiresDate.toISOString().replace('T', ' ').slice(0, 19);

  execute(
    `INSERT INTO trusted_devices (id, user_id, token_hash, browser, os, ip_address, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), userId, hash, ua.browser, ua.os, ip, expiresStr],
  );

  res.cookie(TRUSTED_DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

const router = Router();

// ── Helper: find or create a user authenticated via external provider ─────────
async function findOrCreateProviderUser(
  provider: 'ldap' | 'oidc',
  providerId: string,
  username: string,
  email: string | null,
  displayName: string | null,
  isAdmin: boolean,
): Promise<{ id: string; username: string; display_name: string; role: string }> {
  const existing = queryOne<{ id: string; username: string; display_name: string; role: string }>(
    'SELECT id, username, display_name, role FROM users WHERE auth_provider = ? AND provider_id = ?',
    [provider, providerId],
  );
  if (existing) {
    execute(
      "UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email), updated_at = datetime('now') WHERE id = ?",
      [displayName, email, existing.id],
    );
    return existing;
  }

  let finalUsername = username;
  const usernameConflict = queryOne<{ id: string }>('SELECT id FROM users WHERE username = ?', [username]);
  if (usernameConflict) {
    finalUsername = `${username}_${provider}`;
  }

  const newId = uuid();
  const role = isAdmin ? 'admin' : 'user';
  execute(
    `INSERT INTO users (id, username, display_name, email, role, auth_provider, provider_id, password_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, '')`,
    [newId, finalUsername, displayName ?? finalUsername, email, role, provider, providerId],
  );

  return { id: newId, username: finalUsername, display_name: displayName ?? finalUsername, role };
}

// ── GET /providers — unauthenticated; tells the login page what buttons to show ─
router.get('/providers', (_req: Request, res: Response) => {
  const localEnabled = getSetting('auth.local_enabled') !== 'false';
  const ldapEnabled = getSetting('auth.ldap_enabled') === 'true';
  const oidcEnabled = isOidcEnabled();
  const oidcButtonLabel = getSetting('auth.oidc_button_label') || 'Sign in with SSO';
  res.json({ local: localEnabled, ldap: ldapEnabled, oidc: oidcEnabled, oidcButtonLabel });
});

function setAuthCookie(res: Response, token: string, maxSessionMinutes?: number): void {
  const parseConfiguredTimeoutMs = (): number => {
    const timeout = config.sessionTimeout;
    const match = timeout.match(/^(\d+)(h|m|s|d)?$/);
    if (!match) return 90 * 24 * 60 * 60 * 1000;
    const num = parseInt(match[1], 10);
    const unit = match[2] || 's';
    const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return num * (multipliers[unit] || 1000);
  };

  const maxAgeMs = maxSessionMinutes
    ? maxSessionMinutes * 60 * 1000
    : parseConfiguredTimeoutMs();
  res.cookie('gatwy_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: maxAgeMs,
    path: '/',
  });
}

// In-memory tracker for non-existent usernames (resets on restart — acceptable for single-container)
interface AttemptRecord { count: number; lockedUntil: Date | null; }
const unknownAttempts = new Map<string, AttemptRecord>();

function checkUnknownLock(username: string): Date | null {
  const rec = unknownAttempts.get(username);
  if (rec?.lockedUntil && rec.lockedUntil > new Date()) return rec.lockedUntil;
  return null;
}

function recordUnknownFail(username: string, maxFailed: number, lockoutMinutes: number): void {
  const rec = unknownAttempts.get(username) ?? { count: 0, lockedUntil: null };
  rec.count += 1;
  if (rec.count >= maxFailed) {
    const until = new Date();
    until.setMinutes(until.getMinutes() + lockoutMinutes);
    rec.lockedUntil = until;
    logAudit({
      eventType: 'security.account_locked',
      target: username,
      details: { reason: 'too_many_failed_logins', user_exists: false, locked_until: until.toISOString(), failed_count: rec.count },
    });
  }
  unknownAttempts.set(username, rec);
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: string;
  theme: string | null;
  failed_login_count: number;
  locked_until: string | null;
  mfa_enabled: number;
  mfa_secret: string | null;
  mfa_method: string | null;
  dismissed_warnings_json: string | null;
}

function parseDismissedWarnings(json: string | null): string[] {
  if (!json) return [];
  try { return JSON.parse(json) as string[]; } catch { return []; }
}

// Check if setup is needed
router.get('/status', (_req: Request, res: Response) => {
  const row = queryOne<{ 'COUNT(*)': number }>('SELECT COUNT(*) FROM users');
  const count = row ? row['COUNT(*)'] : 0;
  res.json({ needsSetup: count === 0 });
});

// Initial setup — create admin
router.post('/setup', async (req: Request, res: Response) => {
  const row = queryOne<{ 'COUNT(*)': number }>('SELECT COUNT(*) FROM users');
  const count = row ? row['COUNT(*)'] : 0;
  if (count > 0) {
    res.status(400).json({ error: 'Setup already completed' });
    return;
  }

  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) {
    res.status(400).json({ error: 'Username, password, and display name are required' });
    return;
  }

  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const id = uuid();
  const passwordHash = await bcrypt.hash(password, 12);

  execute(
    'INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
    [id, username, passwordHash, displayName, 'admin'],
  );

  const token = signToken({ userId: id, username, role: 'admin' });
  createLoginSession(req, id, token);

  logAudit({
    userId: id,
    eventType: 'user.setup',
    target: username,
    ipAddress: req.ip,
  });

  setAuthCookie(res, token);
  res.json({
    token,
    user: { id, username, displayName, role: 'admin', theme: null, permissions: getPermissionsForRole('admin'), dismissedWarnings: [] },
  });
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  if (getSetting('auth.local_enabled') === 'false') {
    res.status(403).json({ error: 'Local authentication is disabled' });
    return;
  }

  // IP-based rate limiting(guards against password spraying / distributed brute force)
  const clientIp = (req.ip ?? 'unknown').replace(/^::ffff:/i, '');
  if (!checkIpRateLimit(clientIp)) {
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    return;
  }

  const maxFailed = parseInt(getSetting('security.max_failed_logins'), 10) || 5;
  const lockoutMinutes = parseInt(getSetting('security.lockout_minutes'), 10) || 30;

  const user = queryOne<UserRow>('SELECT id, username, password_hash, display_name, role, theme, failed_login_count, locked_until, mfa_enabled, mfa_secret, mfa_method, dismissed_warnings_json FROM users WHERE username = ? AND auth_provider = \'local\'', [username]);

  if (!user) {
    // Apply lockout to unknown usernames too (in-memory, resets on restart)
    const lockedUntil = checkUnknownLock(username);
    if (lockedUntil) {
      res.status(429).json({ error: `Account locked until ${lockedUntil.toLocaleString()}` });
      return;
    }
    recordUnknownFail(username, maxFailed, lockoutMinutes);
    logAudit({
      eventType: 'auth.login_failed',
      target: username,
      details: { reason: 'user_not_found' },
      ipAddress: req.ip,
    });
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // Check if account is locked
  // SQLite datetime() returns "YYYY-MM-DD HH:MM:SS" (space, not T) — add T+Z for correct UTC parsing
  if (user.locked_until && new Date(user.locked_until.replace(' ', 'T') + 'Z') > new Date()) {
    const lockedUntilDate = new Date(user.locked_until.replace(' ', 'T') + 'Z');
    logAudit({
      userId: user.id,
      eventType: 'security.locked_account_attempt',
      target: username,
      details: { locked_until: lockedUntilDate.toISOString() },
      ipAddress: req.ip,
    });
    const until = lockedUntilDate.toLocaleString();
    res.status(429).json({ error: `Account locked until ${until}` });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    const newCount = (user.failed_login_count ?? 0) + 1;

    if (newCount >= maxFailed) {
      execute(
        `UPDATE users SET failed_login_count = ?, locked_until = datetime('now', '+' || CAST(? AS TEXT) || ' minutes'), updated_at = datetime('now') WHERE id = ?`,
        [newCount, lockoutMinutes, user.id],
      );
      const lockedUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000).toISOString();
      logAudit({
        userId: user.id,
        eventType: 'security.account_locked',
        target: username,
        details: { reason: 'too_many_failed_logins', user_exists: true, locked_until: lockedUntil, failed_count: newCount },
        ipAddress: req.ip,
      });
    } else {
      execute(
        "UPDATE users SET failed_login_count = ?, updated_at = datetime('now') WHERE id = ?",
        [newCount, user.id],
      );
    }

    logAudit({
      userId: user.id,
      eventType: 'auth.login_failed',
      target: username,
      details: { reason: 'invalid_password', failedCount: newCount },
      ipAddress: req.ip,
    });
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // Reset lockout on success
  execute(
    "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [user.id],
  );

  // If MFA is enabled, check for trusted device cookie first
  if (user.mfa_enabled === 1 && !isTrustedDevice(req, user.id)) {
    const mfaToken = signMfaToken(user.id);
    // Determine MFA method
    const mfaMethod = user.mfa_method || 'totp';
    res.json({ mfaRequired: true, mfaToken, mfaMethod });
    return;
  }

  const maxSessionMinutes = parseInt(getSetting('security.max_session_minutes') ?? '0', 10);
  const token = signToken({ userId: user.id, username: user.username, role: user.role }, maxSessionMinutes || undefined);
  createLoginSession(req, user.id, token);

  logAudit({
    userId: user.id,
    eventType: 'auth.login_success',
    target: username,
    ipAddress: req.ip,
  });

  setAuthCookie(res, token, maxSessionMinutes || undefined);
  const proxyIp = detectProxyIp(req);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      theme: user.theme,
      permissions: getPermissionsForRole(user.role),
      dismissedWarnings: parseDismissedWarnings(user.dismissed_warnings_json),
    },
    ...(proxyIp ? { proxyIp } : {}),
  });
});

// POST /login/mfa — complete MFA login
router.post('/login/mfa', async (req: Request, res: Response) => {
  const { mfaToken, code, trustDevice } = req.body as { mfaToken?: string; code?: string; trustDevice?: boolean };

  if (!mfaToken || !code) {
    res.status(400).json({ error: 'mfaToken and code are required' });
    return;
  }

  let userId: string;
  try {
    const payload = verifyMfaToken(mfaToken);
    userId = payload.userId;
  } catch {
    res.status(401).json({ error: 'Invalid or expired MFA token' });
    return;
  }

  // MFA brute-force protection (C3)
  if (!checkMfaRateLimit(userId)) {
    res.status(429).json({ error: 'Too many MFA attempts. Please try again later.' });
    return;
  }

  const user = queryOne<UserRow>(
    'SELECT id, username, display_name, role, theme, mfa_secret, mfa_enabled, dismissed_warnings_json FROM users WHERE id = ?',
    [userId],
  );

  if (!user || !user.mfa_secret || user.mfa_enabled !== 1) {
    res.status(400).json({ error: 'MFA not configured for this user' });
    return;
  }

  const decryptedSecret = (() => { try { return decrypt(user.mfa_secret!); } catch { return null; } })();
  if (!decryptedSecret) {
    res.status(400).json({ error: 'MFA configuration error' });
    return;
  }
  const { valid: isValid } = otpVerify({ token: code, secret: decryptedSecret });
  if (!isValid) {
    res.status(401).json({ error: 'Invalid verification code' });
    return;
  }

  clearMfaAttempts(userId);

  const maxSessionMinutes = parseInt(getSetting('security.max_session_minutes') ?? '0', 10);
  const token = signToken({ userId: user.id, username: user.username, role: user.role }, maxSessionMinutes || undefined);
  createLoginSession(req, user.id, token);

  // Set trusted device cookie if requested
  if (trustDevice) {
    setTrustedDevice(req, res, user.id);
  }

  logAudit({
    userId: user.id,
    eventType: 'auth.login_success',
    target: user.username,
    details: { mfa: true, trustedDevice: !!trustDevice },
    ipAddress: req.ip,
  });

  setAuthCookie(res, token, maxSessionMinutes || undefined);
  const proxyIp = detectProxyIp(req);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      theme: user.theme,
      permissions: getPermissionsForRole(user.role),
      dismissedWarnings: parseDismissedWarnings(user.dismissed_warnings_json),
    },
    ...(proxyIp ? { proxyIp } : {}),
  });
});

// POST /login/passkey/options — get passkey authentication options for a user
router.post('/login/passkey/options', async (req: Request, res: Response) => {
  const { mfaToken, username } = req.body as { mfaToken?: string; username?: string };

  // Check if passkeys are enabled globally
  if (!await isPasskeyEnabled()) {
    res.status(400).json({ error: 'Passkeys are not enabled' });
    return;
  }

  const clientIp = (req.ip ?? 'unknown').replace(/^::ffff:/i, '');
  if (!checkIpRateLimit(clientIp)) {
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    return;
  }

  let userId: string | null = null;
  if (mfaToken) {
    try {
      const payload = verifyMfaToken(mfaToken);
      userId = payload.userId;
    } catch {
      res.status(401).json({ error: 'Invalid or expired MFA token' });
      return;
    }
  } else if (username) {
    const user = queryOne<{ id: string; mfa_enabled: number; mfa_method: string | null }>(
      `SELECT id, mfa_enabled, mfa_method FROM users WHERE username = ?`,
      [username],
    );
    if (!user || user.mfa_enabled !== 1 || user.mfa_method !== 'passkey') {
      res.status(400).json({ error: 'Passkey sign in is not available for this account' });
      return;
    }
    userId = user.id;
  } else {
    res.status(400).json({ error: 'mfaToken or username is required' });
    return;
  }

  // Check if user has passkey MFA with active passkeys
  if (!hasPasskeyMFA(userId)) {
    res.status(400).json({ error: 'Passkey sign in is not available for this account' });
    return;
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const result = await generatePasskeyAuthenticationOptions(userId, origin);
  
  if (!result) {
    res.status(400).json({ error: 'No active passkeys found' });
    return;
  }

  res.json({ options: result.options, challengeId: result.challengeId });
});

// POST /login/passkey — verify passkey authentication
router.post('/login/passkey', async (req: Request, res: Response) => {
  const { mfaToken, challengeId, response, trustDevice } = req.body as {
    mfaToken?: string;
    challengeId?: string;
    response?: unknown;
    trustDevice?: boolean;
  };

  if (!challengeId || !response) {
    res.status(400).json({ error: 'challengeId and response are required' });
    return;
  }

  const clientIp = (req.ip ?? 'unknown').replace(/^::ffff:/i, '');
  if (!checkIpRateLimit(clientIp)) {
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    return;
  }

  let expectedUserId: string | null = null;
  if (mfaToken) {
    try {
      const payload = verifyMfaToken(mfaToken);
      expectedUserId = payload.userId;
    } catch {
      res.status(401).json({ error: 'Invalid or expired MFA token' });
      return;
    }
  }

  // MFA brute-force protection
  if (expectedUserId && !checkMfaRateLimit(expectedUserId)) {
    res.status(429).json({ error: 'Too many MFA attempts. Please try again later.' });
    return;
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const result = await verifyPasskeyAuthentication(
    challengeId,
    response as Parameters<typeof verifyPasskeyAuthentication>[1],
    origin,
  );

  if (!result.success) {
    logAudit({
      userId: expectedUserId || undefined,
      eventType: 'auth.passkey_login_failed',
      details: { error: result.error },
      ipAddress: req.ip,
    });
    res.status(401).json({ error: result.error || 'Passkey verification failed' });
    return;
  }

  // Verify the passkey belongs to the expected user
  if (expectedUserId && result.userId !== expectedUserId) {
    res.status(401).json({ error: 'Passkey does not belong to this user' });
    return;
  }

  if (expectedUserId) {
    clearMfaAttempts(expectedUserId);
  }

  const user = queryOne<UserRow>(
    'SELECT id, username, display_name, role, theme, dismissed_warnings_json FROM users WHERE id = ?',
    [result.userId],
  );

  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  const maxSessionMinutes = parseInt(getSetting('security.max_session_minutes') ?? '0', 10);
  const token = signToken({ userId: user.id, username: user.username, role: user.role }, maxSessionMinutes || undefined);
  createLoginSession(req, user.id, token);

  // Set trusted device cookie if requested
  if (trustDevice) {
    setTrustedDevice(req, res, user.id);
  }

  logAudit({
    userId: user.id,
    eventType: 'auth.passkey_login_success',
    target: user.username,
    details: { passkeyId: result.passkeyId, trustedDevice: !!trustDevice },
    ipAddress: req.ip,
  });

  setAuthCookie(res, token, maxSessionMinutes || undefined);
  const proxyIp = detectProxyIp(req);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      theme: user.theme,
      permissions: getPermissionsForRole(user.role),
      dismissedWarnings: parseDismissedWarnings(user.dismissed_warnings_json),
    },
    ...(proxyIp ? { proxyIp } : {}),
  });
});

// Cleanup expired passkey challenges periodically
setInterval(() => {
  cleanupExpiredChallenges();
}, 5 * 60 * 1000); // Every 5 minutes

// Logout — revoke the current session token
router.post('/logout', authRequired, (req: Request, res: Response) => {
  const tokenHash = req.user!.tokenHash;
  if (tokenHash) {
    execute('UPDATE login_sessions SET revoked = 1 WHERE token_hash = ?', [tokenHash]);
  }
  logAudit({
    userId: req.user!.userId,
    eventType: 'auth.logout',
    target: req.user!.username,
    ipAddress: req.ip,
  });
  res.clearCookie('gatwy_token', { path: '/', secure: true, sameSite: 'strict' });
  res.json({ ok: true });
});

// POST /ws-ticket — issue a short-lived one-time WebSocket ticket
// Clients exchange this for the JWT token in WS URL params so the long-lived
// token never appears in server access logs.
router.post('/ws-ticket', authRequired, (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const tokenHash = req.user!.tokenHash!;
  const ticket = issueWsTicket(userId, tokenHash);
  res.json({ ticket });
});

// Get current user
router.get('/me', authRequired, (req: Request, res: Response) => {
  const user = queryOne<UserRow>(
    'SELECT id, username, display_name, role, theme, dismissed_warnings_json FROM users WHERE id = ?',
    [req.user!.userId],
  );

  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      theme: user.theme,
      permissions: getPermissionsForRole(user.role),
      dismissedWarnings: parseDismissedWarnings(user.dismissed_warnings_json),
    },
  });
});

// POST /login/ldap — authenticate via LDAP/Active Directory
router.post('/login/ldap', async (req: Request, res: Response) => {
  if (getSetting('auth.ldap_enabled') !== 'true') {
    res.status(400).json({ error: 'LDAP authentication is not enabled' });
    return;
  }

  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const clientIp = (req.ip ?? 'unknown').replace(/^::ffff:/i, '');
  if (!checkIpRateLimit(clientIp)) {
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    return;
  }

  const ldapUser = await authenticateLdap(username, password);
  if (!ldapUser) {
    logAudit({
      eventType: 'auth.login_failed',
      target: username,
      details: { reason: 'ldap_auth_failed', provider: 'ldap' },
      ipAddress: req.ip,
    });
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const user = await findOrCreateProviderUser(
    'ldap',
    ldapUser.dn,
    ldapUser.username,
    ldapUser.email,
    ldapUser.displayName,
    ldapUser.isAdmin,
  );

  const maxSessionMinutes = parseInt(getSetting('security.max_session_minutes') ?? '0', 10);
  const token = signToken({ userId: user.id, username: user.username, role: user.role }, maxSessionMinutes || undefined);
  createLoginSession(req, user.id, token);
  setAuthCookie(res, token, maxSessionMinutes || undefined);

  logAudit({
    userId: user.id,
    eventType: 'auth.login_success',
    target: user.username,
    details: { provider: 'ldap' },
    ipAddress: req.ip,
  });

  const proxyIp = detectProxyIp(req);
  res.json({
    token,
    user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, theme: null, permissions: getPermissionsForRole(user.role), dismissedWarnings: [] },
    ...(proxyIp ? { proxyIp } : {}),
  });
});

// GET /oidc/authorize — redirect the browser to the OIDC provider
router.get('/oidc/authorize', async (_req: Request, res: Response) => {
  if (!isOidcEnabled()) {
    res.status(400).json({ error: 'OIDC authentication is not enabled' });
    return;
  }

  const result = await buildOidcAuthUrl();
  if ('error' in result) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ url: result.url });
});

// GET /oidc/callback — OIDC provider redirects back here after authentication
router.get('/oidc/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    const msg = encodeURIComponent(error_description ?? error ?? 'OIDC error');
    res.redirect(`/?sso_error=${msg}`);
    return;
  }

  if (!code || !state) {
    res.redirect('/?sso_error=missing_params');
    return;
  }

  const oidcUser = await handleOidcCallback(code, state);
  if (!oidcUser) {
    res.redirect('/?sso_error=auth_failed');
    return;
  }

  const user = await findOrCreateProviderUser(
    'oidc',
    oidcUser.sub,
    oidcUser.username,
    oidcUser.email,
    oidcUser.displayName,
    oidcUser.isAdmin,
  );

  const maxSessionMinutes = parseInt(getSetting('security.max_session_minutes') ?? '0', 10);
  const token = signToken({ userId: user.id, username: user.username, role: user.role }, maxSessionMinutes || undefined);
  createLoginSession(req, user.id, token);
  setAuthCookie(res, token, maxSessionMinutes || undefined);

  logAudit({
    userId: user.id,
    eventType: 'auth.login_success',
    target: user.username,
    details: { provider: 'oidc' },
    ipAddress: req.ip,
  });

  res.redirect('/?sso=success');
});

// POST /ldap/test — admin-only endpoint to verify LDAP connectivity
router.post('/ldap/test', adminRequired, async (req: Request, res: Response) => {
  const { url, bindDn, bindPassword, searchBase } = req.body as {
    url?: string; bindDn?: string; bindPassword?: string; searchBase?: string;
  };
  if (!url || !searchBase) {
    res.status(400).json({ success: false, error: 'url and searchBase are required' });
    return;
  }
  try {
    const { Client: LdapClient } = await import('ldapts');
    const client = new LdapClient({ url, connectTimeout: 5000 });
    if (bindDn && bindPassword) await client.bind(bindDn, bindPassword);
    await client.search(searchBase, { scope: 'base', filter: '(objectClass=*)', sizeLimit: 1 });
    await client.unbind();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

export default router;
