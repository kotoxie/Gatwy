import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import { config } from '../config.js';

let secret: string;

export function initJwt(): void {
  if (config.jwtSecret) {
    secret = config.jwtSecret;
    return;
  }

  // Load or generate JWT secret
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(config.jwtSecretPath)) {
    secret = fs.readFileSync(config.jwtSecretPath, 'utf-8').trim();
  } else {
    secret = crypto.randomBytes(64).toString('hex');
    fs.writeFileSync(config.jwtSecretPath, secret, { mode: 0o600 });
  }
}

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
  type?: string;
}

export function signToken(payload: JwtPayload, maxMinutes?: number): string {
  let expiresInSeconds = 90 * 24 * 60 * 60; // default 90d
  if (maxMinutes && maxMinutes > 0) {
    expiresInSeconds = maxMinutes * 60;
  } else {
    const timeout = config.sessionTimeout;
    const match = timeout.match(/^(\d+)(h|m|s|d)?$/);
    if (match) {
      const num = parseInt(match[1], 10);
      const unit = match[2] || 's';
      const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
      expiresInSeconds = num * (multipliers[unit] || 1);
    }
  }
  return jwt.sign(payload, secret, { expiresIn: expiresInSeconds });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret) as JwtPayload;
}

export function signMfaToken(userId: string): string {
  return jwt.sign({ userId, type: 'mfa' }, secret, { expiresIn: 300 }); // 5 minutes
}

export function verifyMfaToken(token: string): { userId: string; type: string } {
  const payload = jwt.verify(token, secret) as { userId: string; type: string };
  if (payload.type !== 'mfa') throw new Error('Invalid MFA token type');
  return payload;
}
