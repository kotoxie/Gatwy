import { useEffect, useState } from 'react';

interface ActiveSessionRow {
  id: string;
  username: string | null;
  protocol: string;
  connectionName: string;
  status: 'connected' | 'grace';
  startedAt: string;
  durationMs: number;
}

const POLL_MS = 5000;

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ActiveSessions() {
  const [sessions, setSessions] = useState<ActiveSessionRow[]>([]);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Set once polling gave up (401/403): the table is cleared and the refresh hint hidden.
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    async function load() {
      // A slow response must not be overtaken by the next poll, or an older snapshot could win.
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch('/api/v1/sessions/active', { credentials: 'include' });
        if (res.status === 401 || res.status === 403) {
          // Login expired or permission revoked: retrying every 5s would only repeat the failure.
          clearInterval(timer);
          clearInterval(tick);
          if (!cancelled) { setSessions([]); setStopped(true); }
          throw new Error(res.status === 401 ? 'Session expired. Sign in again.' : 'You no longer have permission to view active sessions.');
        }
        if (!res.ok) throw new Error('Failed to load active sessions');
        const d = await res.json() as { sessions: ActiveSessionRow[] };
        if (!cancelled) { setSessions(d.sessions); setFetchedAt(Date.now()); setError(''); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load active sessions');
      }
      inFlight = false;
      if (!cancelled) setLoading(false);
    }
    void load();
    timer = setInterval(() => void load(), POLL_MS);
    // Durations tick locally between polls: the server's value plus the time since it was fetched
    // (so a skewed client clock cannot distort them).
    tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; clearInterval(timer); clearInterval(tick); };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Who's connected</h2>
        {!stopped && <span className="text-xs text-text-secondary">Refreshes every {POLL_MS / 1000}s</span>}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {loading && <p className="text-text-secondary text-sm">Loading active sessions...</p>}
      {!loading && !error && !stopped && sessions.length === 0 && (
        <p className="text-text-secondary text-sm">No active sessions.</p>
      )}

      {sessions.length > 0 && (
        <>
          <p className="text-xs text-text-secondary">
            <span className="font-medium text-text-primary">{sessions.length}</span> active session{sessions.length === 1 ? '' : 's'}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className="pb-2 pr-4 font-medium">User</th>
                  <th className="pb-2 pr-4 font-medium">Connection</th>
                  <th className="pb-2 pr-4 font-medium">Protocol</th>
                  <th className="pb-2 pr-4 font-medium">Duration</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-b-0">
                    <td className="py-2 pr-4 text-text-primary">{s.username ?? '—'}</td>
                    <td className="py-2 pr-4 text-text-primary">{s.connectionName}</td>
                    <td className="py-2 pr-4">
                      <span className="px-1.5 py-0.5 rounded text-xs bg-surface-hover text-text-secondary uppercase font-mono">
                        {s.protocol}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-xs text-text-secondary">{formatDuration(s.durationMs + Math.max(0, now - fetchedAt))}</td>
                    <td className="py-2">
                      {s.status === 'connected' ? (
                        <span className="px-1.5 py-0.5 rounded text-xs bg-accent/10 text-accent border border-accent/20">Connected</span>
                      ) : (
                        <span
                          className="px-1.5 py-0.5 rounded text-xs bg-surface-hover text-text-secondary border border-border"
                          title="The browser disconnected. The session stays open for a short time waiting for a reattach"
                        >
                          Reconnecting
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
