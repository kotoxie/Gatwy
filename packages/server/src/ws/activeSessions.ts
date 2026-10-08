/**
 * In-memory registry of live proxied sessions (SSH, Telnet, RDP, VNC), backing the admin
 * "Who's connected" view. Each proxy adds an entry when its session is established and removes it
 * in the same place the per-user connection slot is released.
 * Keys are the ids the proxies generate server-side (the same value as `details.sessionId` in the
 * audit log), never a client-supplied id. Nothing here touches the database: after a restart the
 * registry is empty, which matches the live sockets.
 */

export type ActiveSessionProtocol = 'ssh' | 'telnet' | 'rdp' | 'vnc';
/** `grace`: the browser left and the session waits for a reattach (SSH/Telnet only). */
export type ActiveSessionStatus = 'connected' | 'grace';

export interface ActiveSession {
  id: string;
  userId: string;
  connectionId: string;
  connectionName: string;
  protocol: ActiveSessionProtocol;
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

export function listActiveSessions(): ActiveSession[] {
  return [...registry.values()].sort((a, b) => a.startedAt - b.startedAt);
}
