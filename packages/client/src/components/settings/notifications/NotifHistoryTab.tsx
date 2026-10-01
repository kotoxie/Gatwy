import { useState, useEffect, useCallback } from 'react';

const API = '/api/v1/notifications';

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(API + path, { credentials: 'include', ...opts });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

interface LogEntry {
  id: string;
  ruleId: string | null;
  ruleName: string;
  channel: string;
  status: 'sent' | 'failed';
  error: string | null;
  payload: unknown;
  sentAt: string;
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  smtp: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
  telegram: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  slack: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" />
      <path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
      <path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" />
      <path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" />
      <path d="M14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" />
      <path d="M15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z" />
      <path d="M10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5z" />
      <path d="M8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z" />
    </svg>
  ),
  webhook: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
};

function formatDate(iso: string) {
  return new Date(iso.includes('T') ? iso : iso + 'Z').toLocaleString();
}

function StatusBadge({ status }: { status: 'sent' | 'failed' }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-medium ${
      status === 'sent'
        ? 'bg-green-500/15 text-green-500'
        : 'bg-red-500/15 text-red-500'
    }`}>
      {status === 'sent' ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      )}
      {status}
    </span>
  );
}

export function NotifHistoryTab() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number>(90);
  const [editingRetention, setEditingRetention] = useState(false);
  const [retentionInput, setRetentionInput] = useState('90');
  const [savingRetention, setSavingRetention] = useState(false);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (statusFilter) qs.set('status', statusFilter);
    const { ok, data } = await apiFetch(`/log?${qs.toString()}`);
    if (ok) {
      setEntries(data.entries as LogEntry[]);
      setTotal(data.total as number);
    }
    setLoading(false);
  }, [page, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    apiFetch('/settings').then(({ ok, data }) => {
      if (ok) {
        const days = (data as { retentionDays: number }).retentionDays;
        setRetentionDays(days);
        setRetentionInput(String(days));
      }
    });
  }, []);

  async function retry(id: string) {
    setRetrying(id);
    const { ok, data } = await apiFetch(`/log/${id}/retry`, { method: 'POST' });
    setRetrying(null);
    setRetryMsg((m) => ({ ...m, [id]: ok ? '✓ Resent' : ((data as { error?: string }).error ?? 'Failed') }));
    if (ok) await load();
  }

  async function deleteEntry(id: string) {
    setDeleting(id);
    await apiFetch(`/log/${id}`, { method: 'DELETE' });
    setDeleting(null);
    await load();
  }

  async function clearAll() {
    const qs = statusFilter ? `?status=${statusFilter}` : '';
    await apiFetch(`/log${qs}`, { method: 'DELETE' });
    setConfirmClear(false);
    setPage(1);
    await load();
  }

  async function saveRetention() {
    const days = parseInt(retentionInput, 10);
    if (!days || days < 1) return;
    setSavingRetention(true);
    const { ok } = await apiFetch('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retentionDays: days }),
    });
    setSavingRetention(false);
    if (ok) { setRetentionDays(days); setEditingRetention(false); }
  }

  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      {/* Retention setting */}
      <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-alt text-sm flex-wrap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary shrink-0">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span className="text-text-secondary text-xs">Log retention:</span>
        {editingRetention ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              value={retentionInput}
              onChange={(e) => setRetentionInput(e.target.value)}
              className="w-20 px-2 py-1 text-xs rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-xs text-text-secondary">days</span>
            <button
              onClick={() => { void saveRetention(); }}
              disabled={savingRetention}
              className="px-2 py-1 text-xs bg-accent hover:bg-accent-hover text-white rounded disabled:opacity-50 transition-colors"
            >{savingRetention ? 'Saving…' : 'Save'}</button>
            <button onClick={() => { setEditingRetention(false); setRetentionInput(String(retentionDays)); }}
              className="px-2 py-1 text-xs border border-border rounded hover:bg-surface-hover text-text-secondary transition-colors">
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span className="text-xs font-medium text-text-primary">{retentionDays} days</span>
            <button onClick={() => setEditingRetention(true)} className="text-xs text-accent hover:underline">Edit</button>
          </>
        )}
      </div>

      {/* Filters + actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
        <button onClick={() => { void load(); }} className="px-3 py-1.5 text-sm border border-border rounded hover:bg-surface-hover text-text-primary transition-colors">
          Refresh
        </button>
        <span className="text-xs text-text-secondary">{total} total</span>
        {total > 0 && (
          <button
            onClick={() => setConfirmClear(true)}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-500/40 rounded hover:bg-red-500/10 text-red-500 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
            {statusFilter ? `Clear ${statusFilter}` : 'Clear all'}
          </button>
        )}
      </div>

      {/* In-app confirm modal for Clear All */}
      {confirmClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setConfirmClear(false)} />
          <div className="relative bg-surface border border-border rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4 space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">Clear notification history?</h3>
            <p className="text-xs text-text-secondary">
              This will permanently delete {statusFilter ? `all <strong>${statusFilter}</strong>` : 'all'} notification log entries{statusFilter ? ` with status "${statusFilter}"` : ''}.
              This action is irreversible.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmClear(false)}
                className="px-3 py-1.5 text-sm border border-border rounded hover:bg-surface-hover text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={() => { void clearAll(); }}
                className="px-4 py-1.5 text-sm bg-red-500 hover:bg-red-600 text-white rounded transition-colors">
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-text-secondary text-sm">No notifications logged yet.</div>
      ) : (
        <>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-alt border-b border-border">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-medium text-text-secondary">Time</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-text-secondary">Rule</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-text-secondary">Channel</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-text-secondary">Status</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-text-secondary">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((entry) => (
                  <>
                    <tr
                      key={entry.id}
                      className="hover:bg-surface-alt cursor-pointer transition-colors"
                      onClick={() => setExpanded((e) => e === entry.id ? null : entry.id)}
                    >
                      <td className="px-3 py-2.5 text-xs text-text-secondary whitespace-nowrap">{formatDate(entry.sentAt)}</td>
                      <td className="px-3 py-2.5 text-sm text-text-primary truncate max-w-[160px]">{entry.ruleName}</td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                          {CHANNEL_ICONS[entry.channel] ?? null}
                          {entry.channel}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge status={entry.status} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {entry.status === 'failed' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); void retry(entry.id); }}
                              disabled={retrying === entry.id}
                              className="text-xs text-accent hover:underline disabled:opacity-50"
                            >
                              {retrying === entry.id ? 'Retrying…' : retryMsg[entry.id] ?? 'Retry'}
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); void deleteEntry(entry.id); }}
                            disabled={deleting === entry.id}
                            title="Delete this log entry"
                            className="text-text-secondary hover:text-red-500 disabled:opacity-40 transition-colors"
                          >
                            {deleting === entry.id ? (
                              <span className="text-xs">…</span>
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                              </svg>
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === entry.id && (
                      <tr key={`${entry.id}-exp`} className="bg-surface-alt">
                        <td colSpan={5} className="px-4 py-3 text-xs">
                          {entry.error && (
                            <p className="text-red-500 mb-2"><strong>Error:</strong> {entry.error}</p>
                          )}
                          {entry.payload !== null && entry.payload !== undefined && (
                            <pre className="text-text-secondary font-mono text-[11px] whitespace-pre-wrap break-all bg-surface border border-border rounded p-2 max-h-40 overflow-y-auto">
                              {JSON.stringify(entry.payload, null, 2)}
                            </pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-hover disabled:opacity-40 transition-colors">
                ← Prev
              </button>
              <span className="text-xs text-text-secondary">Page {page} / {pages}</span>
              <button disabled={page === pages} onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-hover disabled:opacity-40 transition-colors">
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
