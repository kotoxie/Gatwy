import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';

// Applied after authRequired, so the limit is per user rather than per IP.
function perUser(req: Request): string {
  return req.user?.userId ?? 'anonymous';
}

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: perUser,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    message: { error: 'Too many requests, please try again later' },
  });
}

export const sessionsReadLimiter = limiter(60_000, 120);
export const sessionsActionLimiter = limiter(60_000, 60);
export const recordingChunkLimiter = limiter(60_000, 1200);
export const backupImportLimiter = limiter(15 * 60_000, 10);
