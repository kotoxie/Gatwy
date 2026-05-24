import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { getSetting } from './settings.js';

// RP (Relying Party) configuration - derived from request origin
function getRPConfig(origin: string): { rpName: string; rpID: string; expectedOrigin: string } {
  const url = new URL(origin);
  return {
    rpName: 'Gatwy',
    rpID: url.hostname,
    expectedOrigin: origin,
  };
}

export interface StoredPasskey {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
  aaguid: string | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
  disabled_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}

export interface PasskeyChallenge {
  id: string;
  user_id: string | null;
  challenge: string;
  type: 'registration' | 'authentication';
  created_at: string;
  expires_at: string;
}

const MAX_PASSKEYS_PER_USER = 3;
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Clean up expired challenges
export function cleanupExpiredChallenges(): void {
  const db = getDb();
  db.run(`DELETE FROM passkey_challenges WHERE expires_at < datetime('now')`);
}

// Get user's passkeys
export function getUserPasskeys(userId: string): StoredPasskey[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM user_passkeys WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
  );
  if (!result.length || !result[0].values.length) return [];
  
  const cols = result[0].columns;
  return result[0].values.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj as unknown as StoredPasskey;
  });
}

// Get active (not disabled/revoked) passkeys for a user
export function getActivePasskeys(userId: string): StoredPasskey[] {
  return getUserPasskeys(userId).filter((pk) => !pk.disabled_at);
}

// Get passkey by credential ID
export function getPasskeyByCredentialId(credentialId: string): StoredPasskey | null {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM user_passkeys WHERE credential_id = ?`,
    [credentialId],
  );
  if (!result.length || !result[0].values.length) return null;
  
  const cols = result[0].columns;
  const row = result[0].values[0];
  const obj: Record<string, unknown> = {};
  cols.forEach((col, i) => { obj[col] = row[i]; });
  return obj as unknown as StoredPasskey;
}

// Check if user can add more passkeys
export function canAddPasskey(userId: string): boolean {
  const active = getActivePasskeys(userId);
  return active.length < MAX_PASSKEYS_PER_USER;
}

// Generate registration options
export async function generatePasskeyRegistrationOptions(
  userId: string,
  username: string,
  displayName: string,
  origin: string,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
  const { rpName, rpID } = getRPConfig(origin);
  
  // Get existing passkeys to exclude
  const existingPasskeys = getActivePasskeys(userId);
  const excludeCredentials = existingPasskeys.map((pk) => ({
    id: pk.credential_id,
    transports: pk.transports ? JSON.parse(pk.transports) as AuthenticatorTransportFuture[] : undefined,
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userDisplayName: displayName,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform',
    },
  });

  // Store challenge
  const db = getDb();
  const challengeId = uuidv4();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  
  db.run(
    `INSERT INTO passkey_challenges (id, user_id, challenge, type, expires_at) VALUES (?, ?, ?, 'registration', ?)`,
    [challengeId, userId, options.challenge, expiresAt],
  );

  return { options, challengeId };
}

// Verify registration response
export async function verifyPasskeyRegistration(
  challengeId: string,
  response: RegistrationResponseJSON,
  origin: string,
  passkeyName: string,
): Promise<{ success: boolean; passkey?: StoredPasskey; error?: string }> {
  const db = getDb();
  const { rpID, expectedOrigin } = getRPConfig(origin);

  // Get and validate challenge
  const challengeResult = db.exec(
    `SELECT * FROM passkey_challenges WHERE id = ? AND type = 'registration' AND expires_at > datetime('now')`,
    [challengeId],
  );
  
  if (!challengeResult.length || !challengeResult[0].values.length) {
    return { success: false, error: 'Challenge expired or not found' };
  }

  const cols = challengeResult[0].columns;
  const row = challengeResult[0].values[0];
  const challenge: Record<string, unknown> = {};
  cols.forEach((col, i) => { challenge[col] = row[i]; });
  const storedChallenge = challenge as unknown as PasskeyChallenge;

  if (!storedChallenge.user_id) {
    return { success: false, error: 'Invalid challenge' };
  }

  // Check if user can still add passkeys
  if (!canAddPasskey(storedChallenge.user_id)) {
    return { success: false, error: 'Maximum passkeys limit reached (3)' };
  }

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Verification failed' };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { success: false, error: 'Verification failed' };
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;

  // Store the passkey
  const passkeyId = uuidv4();
  db.run(
    `INSERT INTO user_passkeys (id, user_id, credential_id, public_key, sign_count, transports, aaguid, name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      passkeyId,
      storedChallenge.user_id,
      credential.id,
      Buffer.from(credential.publicKey).toString('base64'),
      credential.counter,
      response.response.transports ? JSON.stringify(response.response.transports) : null,
      aaguid || null,
      passkeyName,
    ],
  );

  // Delete the used challenge
  db.run(`DELETE FROM passkey_challenges WHERE id = ?`, [challengeId]);

  const passkey = getPasskeyByCredentialId(credential.id);
  return { success: true, passkey: passkey || undefined };
}

// Generate authentication options for a user (username-first flow)
export async function generatePasskeyAuthenticationOptions(
  userId: string,
  origin: string,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string } | null> {
  const { rpID } = getRPConfig(origin);
  
  const passkeys = getActivePasskeys(userId);
  if (passkeys.length === 0) return null;

  const allowCredentials = passkeys.map((pk) => ({
    id: pk.credential_id,
    transports: pk.transports ? JSON.parse(pk.transports) as AuthenticatorTransportFuture[] : undefined,
  }));

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'preferred',
  });

  // Store challenge
  const db = getDb();
  const challengeId = uuidv4();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  
  db.run(
    `INSERT INTO passkey_challenges (id, user_id, challenge, type, expires_at) VALUES (?, ?, ?, 'authentication', ?)`,
    [challengeId, userId, options.challenge, expiresAt],
  );

  return { options, challengeId };
}

// Verify authentication response
export async function verifyPasskeyAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON,
  origin: string,
): Promise<{ success: boolean; userId?: string; passkeyId?: string; error?: string }> {
  const db = getDb();
  const { rpID, expectedOrigin } = getRPConfig(origin);

  // Get and validate challenge
  const challengeResult = db.exec(
    `SELECT * FROM passkey_challenges WHERE id = ? AND type = 'authentication' AND expires_at > datetime('now')`,
    [challengeId],
  );
  
  if (!challengeResult.length || !challengeResult[0].values.length) {
    return { success: false, error: 'Challenge expired or not found' };
  }

  const cols = challengeResult[0].columns;
  const row = challengeResult[0].values[0];
  const challenge: Record<string, unknown> = {};
  cols.forEach((col, i) => { challenge[col] = row[i]; });
  const storedChallenge = challenge as unknown as PasskeyChallenge;

  // Get the passkey
  const passkey = getPasskeyByCredentialId(response.id);
  if (!passkey) {
    return { success: false, error: 'Passkey not found' };
  }

  if (passkey.disabled_at) {
    return { success: false, error: 'Passkey has been disabled' };
  }

  // Verify the user matches (for username-first flow)
  if (storedChallenge.user_id && passkey.user_id !== storedChallenge.user_id) {
    return { success: false, error: 'Passkey does not belong to this user' };
  }

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64')),
        counter: passkey.sign_count,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Verification failed' };
  }

  if (!verification.verified) {
    return { success: false, error: 'Verification failed' };
  }

  // Update sign count and last used
  db.run(
    `UPDATE user_passkeys SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?`,
    [verification.authenticationInfo.newCounter, passkey.id],
  );

  // Delete the used challenge
  db.run(`DELETE FROM passkey_challenges WHERE id = ?`, [challengeId]);

  return { success: true, userId: passkey.user_id, passkeyId: passkey.id };
}

// Rename a passkey
export function renamePasskey(passkeyId: string, userId: string, newName: string): boolean {
  const db = getDb();
  const result = db.exec(
    `SELECT id FROM user_passkeys WHERE id = ? AND user_id = ?`,
    [passkeyId, userId],
  );
  
  if (!result.length || !result[0].values.length) return false;

  db.run(`UPDATE user_passkeys SET name = ? WHERE id = ?`, [newName, passkeyId]);
  return true;
}

// Remove a passkey (user action)
export function removePasskey(passkeyId: string, userId: string): boolean {
  const db = getDb();
  const result = db.exec(
    `SELECT id FROM user_passkeys WHERE id = ? AND user_id = ?`,
    [passkeyId, userId],
  );
  
  if (!result.length || !result[0].values.length) return false;

  db.run(`DELETE FROM user_passkeys WHERE id = ?`, [passkeyId]);

  return true;
}

// Admin reset - disable all passkeys for a user with reason
export function adminResetPasskeys(
  targetUserId: string,
  adminUserId: string,
  reason: string,
): number {
  const db = getDb();
  const passkeys = getActivePasskeys(targetUserId);
  
  for (const pk of passkeys) {
    db.run(
      `UPDATE user_passkeys SET disabled_at = datetime('now'), revoked_by = ?, revoked_reason = ? WHERE id = ?`,
      [adminUserId, reason, pk.id],
    );
  }

  return passkeys.length;
}

// Check and disable inactive passkeys
export async function checkInactivePasskeys(): Promise<number> {
  const inactiveDays = parseInt(await getSetting('security.passkey_inactive_days') || '90', 10);
  if (inactiveDays <= 0) return 0; // Disabled

  const db = getDb();
  const cutoffDate = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000).toISOString();

  // Get passkeys that are active but haven't been used within the threshold
  // Use last_used_at if available, otherwise created_at
  const result = db.exec(
    `SELECT id, user_id FROM user_passkeys 
     WHERE disabled_at IS NULL 
     AND COALESCE(last_used_at, created_at) < ?`,
    [cutoffDate],
  );

  if (!result.length || !result[0].values.length) return 0;

  let count = 0;
  for (const [passkeyId, userId] of result[0].values as [string, string][]) {
    db.run(
      `UPDATE user_passkeys SET disabled_at = datetime('now'), revoked_reason = 'Disabled due to inactivity' WHERE id = ?`,
      [passkeyId],
    );
    count++;

  }

  return count;
}

// Check if passkeys are enabled globally
export async function isPasskeyEnabled(): Promise<boolean> {
  const setting = await getSetting('security.passkey_enabled');
  return setting === 'true';
}

