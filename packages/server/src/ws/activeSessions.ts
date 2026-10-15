/**
 * In-memory registry of live proxied sessions (SSH, Telnet, RDP, VNC), backing the admin
 * "Who's connected" view. Each proxy adds an entry when its session is established and removes it
 * in the same place the per-user connection slot is released.
 * Keys are the ids the proxies generate server-side (the same value as `details.sessionId` in the
 * audit log), never a client-supplied id. Nothing here touches the database: after a restart the
 * registry is empty, which matches the live sockets.
 * Each entry carries an `end` callback so an administrator can close the session. It is never part of
 * what the API returns.
 */

/** WebSocket close code and reason sent to a session ended by an administrator. Not 4001: the client
 * treats that as a revoked login and signs the user out of the whole app. */
export const ADMIN_DISCONNECT_CODE = 4010;
export const ADMIN_DISCONNECT_REASON = 'Disconnected by an administrator';

export type ActiveSessionProtocol = 'ssh' | 'telnet' | 'rdp' | 'vnc';
/** `grace`: the browser left and the session waits for a reattach (SSH/Telnet only). */
export type ActiveSessionStatus = 'connected' | 'grace';

export interface ActiveSession {
  id: string;
  userId: string;
  connectionId: string;
  connectionName: string;
  protocol: ActiveSessionProtocol;
  /** Closes the session and releases everything it holds. Safe to call once. */
  end: () => void;
  startedAt: number;
  status: ActiveSessionStatus;
}

const registry = new Map<string, ActiveSession>();

export function addActiveSession(s: Omit<ActiveSession, 'startedAt' | 'status'>): void {
  registry.set(s.id, { ...s, startedAt: Date.now(), status: 'connected' });
}

export function removeActiveSession(id: string): void {
  registry.delete(id);
}

export function setActiveSessionStatus(id: string, status: ActiveSessionStatus): void {
  const s = registry.get(id);
  if (s) s.status = status;
}

export function getActiveSession(id: string): ActiveSession | undefined {
  return registry.get(id);
}

/** Ends a live session on behalf of an administrator. Returns false when it is no longer registered. */
export function endActiveSession(id: string): boolean {
  const s = registry.get(id);
  if (!s) return false;
  registry.delete(id);
  try { s.end(); } catch { /* the entry is gone either way */ }
  return true;
}

export function listActiveSessions(): ActiveSession[] {
  return [...registry.values()].sort((a, b) => a.startedAt - b.startedAt);
}
