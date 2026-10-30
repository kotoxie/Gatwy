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
  /** `host:port` of the remote machine (see targetKey). Only used to spot two sessions on the same host,
   * never returned by the API. Set for RDP. */
  target?: string;
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

/** Identity of a remote machine for matching sessions on it: host is case-insensitive. A hostname and
 * an IP that point to the same machine are not matched. */
export function targetKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/** Is a session of another user open on this target? A user's own sessions never count. */
export function isTargetInUseByOthers(protocol: ActiveSessionProtocol, target: string, userId: string): boolean {
  for (const s of registry.values()) {
    if (s.protocol === protocol && s.target === target && s.userId !== userId) return true;
  }
  return false;
}

/** Does this user have a live session of this protocol on this connection? */
export function hasActiveSession(protocol: ActiveSessionProtocol, connectionId: string, userId: string): boolean {
  for (const s of registry.values()) {
    if (s.protocol === protocol && s.connectionId === connectionId && s.userId === userId) return true;
  }
  return false;
}

export function listActiveSessions(): ActiveSession[] {
  return [...registry.values()].sort((a, b) => a.startedAt - b.startedAt);
}
