import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { queryOne, execute } from '../db/helpers.js';
import { authRequired } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { getPermissionsForRole } from '../services/permissions.js';
import { generateSecret as otpGenerateSecret, verifySync as otpVerify, generateURI as otpGenerateURI } from 'otplib';
import QRCode from 'qrcode';
import { encrypt, decrypt } from '../services/encryption.js';
import {
  isPasskeyEnabled,
  getUserPasskeys,
  getActivePasskeys,
  canAddPasskey,
  generatePasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  renamePasskey,
  removePasskey,
  type StoredPasskey,
} from '../services/passkey.js';

const router = Router();
router.use(authRequired);

// ── Per-userId MFA brute-force protection (C3) ───────────────────────────────
interface MfaRecord { count: number; resetAt: number; }
const mfaVerifyAttempts = new Map<string, MfaRecord>();
const MFA_VERIFY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MFA_VERIFY_MAX = 5;

function checkMfaVerifyLimit(userId: string): boolean {
  const now = Date.now();
  const rec = mfaVerifyAttempts.get(userId);
  if (!rec || now > rec.resetAt) {
    mfaVerifyAttempts.set(userId, { count: 1, resetAt: now + MFA_VERIFY_WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= MFA_VERIFY_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of mfaVerifyAttempts) {
    if (now > rec.resetAt) mfaVerifyAttempts.delete(id);
  }
}, MFA_VERIFY_WINDOW_MS);

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  avatar_text: string | null;
  role: string;
  password_hash: string;
  mfa_enabled: number;
  mfa_secret: string | null;
  ssh_prefs_json: string | null;
  dismissed_warnings_json: string | null;
}

// GET / — return own profile
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = queryOne<UserRow>(
    'SELECT id, username, display_name, email, avatar_text, role, dismissed_warnings_json FROM users WHERE id = ?',
    [userId],
  );

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    email: user.email,
    avatarText: user.avatar_text,
    role: user.role,
    permissions: getPermissionsForRole(user.role),
    dismissedWarnings: user.dismissed_warnings_json ? JSON.parse(user.dismissed_warnings_json) as string[] : [],
  });
});

// PUT / — update displayName, email, avatarText
router.put('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { displayName, email, avatarText } = req.body as {
    displayName?: string;
    email?: string;
    avatarText?: string;
  };

  const updates: string[] = [];
  const params: unknown[] = [];

  if (displayName !== undefined) { updates.push('display_name = ?'); params.push(displayName); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email || null); }
  if (avatarText !== undefined) { updates.push('avatar_text = ?'); params.push(avatarText || null); }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  // Capture before values for audit diff
  const currentUser = queryOne<UserRow>(
    'SELECT display_name, email, avatar_text FROM users WHERE id = ?', [userId],
  );
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (displayName !== undefined) { before.displayName = currentUser?.display_name ?? null; after.displayName = displayName; }
  if (email !== undefined) { before.email = currentUser?.email ?? null; after.email = email || null; }
  if (avatarText !== undefined) { before.avatarText = currentUser?.avatar_text ?? null; after.avatarText = avatarText || null; }

  updates.push("updated_at = datetime('now')");
  params.push(userId);

  execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

  logAudit({
    userId,
    eventType: 'profile.updated',
    details: { before, after },
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// PUT /password — change password
router.put('/password', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword are required' });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' });
    return;
  }

  const user = queryOne<UserRow>('SELECT id, password_hash FROM users WHERE id = ?', [userId]);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  execute("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [newHash, userId]);

  // Revoke all other active sessions so compromised tokens can't persist (C4)
  execute('DELETE FROM login_sessions WHERE user_id = ? AND token_hash != ?', [userId, req.user!.tokenHash]);

  logAudit({
    userId,
    eventType: 'auth.password_changed',
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// GET /ssh-prefs — return user's SSH prefs merged with global defaults
router.get('/ssh-prefs', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = queryOne<UserRow>('SELECT ssh_prefs_json FROM users WHERE id = ?', [userId]);
  const json = user?.ssh_prefs_json ?? null;
  const userPrefs = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  const globalDefaults = {
    fontFamily: getSetting('ssh.font_family'),
    fontSize: getSetting('ssh.font_size'),
    cursorStyle: getSetting('ssh.cursor_style'),
    cursorBlink: getSetting('ssh.cursor_blink') !== 'false',
    theme: getSetting('ssh.theme') || 'vscode-dark',
    scrollback: getSetting('ssh.scrollback'),
  };
  res.json({ ...globalDefaults, ...userPrefs });
});

// PUT /ssh-prefs — save user's SSH prefs
router.put('/ssh-prefs', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const prefs = req.body as Record<string, unknown>;
  execute('UPDATE users SET ssh_prefs_json = ? WHERE id = ?', [JSON.stringify(prefs), userId]);
  res.json({ ok: true });
});

// DELETE /ssh-prefs — reset user's SSH prefs to global defaults
router.delete('/ssh-prefs', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  execute('UPDATE users SET ssh_prefs_json = NULL WHERE id = ?', [userId]);
  res.json({ ok: true });
});

// GET /mfa/status — return MFA enabled state
router.get('/mfa/status', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = queryOne<UserRow>('SELECT mfa_enabled FROM users WHERE id = ?', [userId]);
  res.json({ enabled: user?.mfa_enabled === 1 });
});

// POST /mfa/setup — generate TOTP secret and QR code
router.post('/mfa/setup', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = queryOne<UserRow>('SELECT username FROM users WHERE id = ?', [userId]);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const secret = otpGenerateSecret();
  const appName = getSetting('app.name') || 'Gatwy';
  // Label format: "Gatwy (username)" so users can identify the account in their authenticator app
  const otpUri = otpGenerateURI({ issuer: appName, label: `${appName} (${user.username})`, secret });
  const qrDataUrl = await QRCode.toDataURL(otpUri);

  execute('UPDATE users SET mfa_secret = ? WHERE id = ?', [encrypt(secret), userId]);
  res.json({ secret, qrDataUrl });
});

// POST /mfa/verify — verify TOTP and enable MFA
router.post('/mfa/verify', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { token } = req.body as { token?: string };
  if (!token) { res.status(400).json({ error: 'token is required' }); return; }

  // Rate-limit MFA setup verification (C3)
  if (!checkMfaVerifyLimit(userId)) {
    res.status(429).json({ error: 'Too many attempts. Please wait before trying again.' });
    return;
  }

  const user = queryOne<UserRow>('SELECT mfa_secret FROM users WHERE id = ?', [userId]);
  const secret = user?.mfa_secret ? (() => { try { return decrypt(user.mfa_secret); } catch { return null; } })() : null;
  if (!secret) { res.status(400).json({ error: 'MFA setup not started' }); return; }

  const { valid: isValid } = otpVerify({ token, secret });
  if (!isValid) { res.status(400).json({ error: 'Invalid verification code' }); return; }

  execute('UPDATE users SET mfa_enabled = 1 WHERE id = ?', [userId]);

  logAudit({
    userId,
    eventType: 'user.mfa_enabled',
    target: req.user!.username,
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

// POST /mfa/disable — disable MFA (requires current password — no TOTP needed in case it was lost)
router.post('/mfa/disable', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: 'password is required' }); return; }

  const user = queryOne<UserRow>('SELECT password_hash, mfa_enabled FROM users WHERE id = ?', [userId]);
  if (!user || user.mfa_enabled !== 1) {
    res.status(400).json({ error: 'MFA is not enabled' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) { res.status(400).json({ error: 'Incorrect password' }); return; }

  execute('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?', [userId]);

  logAudit({
    userId,
    eventType: 'user.mfa_disabled',
    target: req.user!.username,
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

// POST /dismiss-warning — permanently dismiss a named warning for this user
router.post('/dismiss-warning', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { warning } = req.body as { warning?: string };
  if (!warning) { res.status(400).json({ error: 'warning is required' }); return; }

  const row = queryOne<{ dismissed_warnings_json: string | null }>(
    'SELECT dismissed_warnings_json FROM users WHERE id = ?',
    [userId],
  );
  const current: string[] = row?.dismissed_warnings_json
    ? JSON.parse(row.dismissed_warnings_json) as string[]
    : [];
  if (!current.includes(warning)) current.push(warning);
  execute('UPDATE users SET dismissed_warnings_json = ? WHERE id = ?', [JSON.stringify(current), userId]);
  res.json({ ok: true });
});

// ── Passkey Management ─────────────────────────────────────────────────────────

// GET /passkeys — list user's passkeys
router.get('/passkeys', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  if (!await isPasskeyEnabled()) {
    res.status(400).json({ error: 'Passkeys are not enabled' });
    return;
  }

  const passkeys = getUserPasskeys(userId);
  // Return sanitized passkey info (no sensitive data)
  const sanitized = passkeys.map((pk) => ({
    id: pk.id,
    name: pk.name,
    createdAt: pk.created_at,
    lastUsedAt: pk.last_used_at,
    disabled: !!pk.disabled_at,
    disabledReason: pk.revoked_reason,
  }));

  res.json({ passkeys: sanitized, canAdd: canAddPasskey(userId), maxPasskeys: 3 });
});

// POST /passkeys/register/options — get registration options for a new passkey
router.post('/passkeys/register/options', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  if (!await isPasskeyEnabled()) {
    res.status(400).json({ error: 'Passkeys are not enabled' });
    return;
  }

  if (!canAddPasskey(userId)) {
    res.status(400).json({ error: 'Maximum passkeys limit reached (3)' });
    return;
  }

  const user = queryOne<{ username: string; display_name: string }>(
    'SELECT username, display_name FROM users WHERE id = ?',
    [userId],
  );
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const { options, challengeId } = await generatePasskeyRegistrationOptions(
    userId,
    user.username,
    user.display_name,
    origin,
  );

  res.json({ options, challengeId });
});

// POST /passkeys/register/verify — verify registration and store passkey
router.post('/passkeys/register/verify', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { challengeId, response, name } = req.body as {
    challengeId?: string;
    response?: unknown;
    name?: string;
  };

  if (!challengeId || !response || !name) {
    res.status(400).json({ error: 'challengeId, response, and name are required' });
    return;
  }

  if (!await isPasskeyEnabled()) {
    res.status(400).json({ error: 'Passkeys are not enabled' });
    return;
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const result = await verifyPasskeyRegistration(
    challengeId,
    response as Parameters<typeof verifyPasskeyRegistration>[1],
    origin,
    name,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error || 'Registration failed' });
    return;
  }

  logAudit({
    userId,
    eventType: 'auth.passkey_registered',
    target: req.user!.username,
    details: { passkeyId: result.passkey?.id, passkeyName: name },
    ipAddress: req.ip,
  });

  res.json({
    ok: true,
    passkey: result.passkey ? {
      id: result.passkey.id,
      name: result.passkey.name,
      createdAt: result.passkey.created_at,
    } : undefined,
  });
});

// PUT /passkeys/:id — rename a passkey
router.put('/passkeys/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const passkeyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name } = req.body as { name?: string };

  if (!passkeyId) {
    res.status(400).json({ error: 'Invalid passkey id' });
    return;
  }

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const success = renamePasskey(passkeyId, userId, name);
  if (!success) {
    res.status(404).json({ error: 'Passkey not found' });
    return;
  }

  logAudit({
    userId,
    eventType: 'auth.passkey_renamed',
    target: req.user!.username,
    details: { passkeyId, newName: name },
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

// DELETE /passkeys/:id — remove a passkey
router.delete('/passkeys/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const passkeyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!passkeyId) {
    res.status(400).json({ error: 'Invalid passkey id' });
    return;
  }

  const success = removePasskey(passkeyId, userId);
  if (!success) {
    res.status(404).json({ error: 'Passkey not found' });
    return;
  }

  logAudit({
    userId,
    eventType: 'auth.passkey_removed',
    target: req.user!.username,
    details: { passkeyId },
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

// GET /mfa/method — get current MFA method
router.get('/mfa/method', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = queryOne<{ mfa_enabled: number; mfa_method: string | null }>(
    'SELECT mfa_enabled, mfa_method FROM users WHERE id = ?',
    [userId],
  );

  res.json({
    enabled: user?.mfa_enabled === 1,
    method: user?.mfa_method || (user?.mfa_enabled === 1 ? 'totp' : null),
  });
});

export default router;
