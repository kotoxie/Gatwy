import { useState, useEffect, useCallback } from 'react';

interface HistoryItem {
  id: string;
  query_text: string;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  executed_at: string;
}

interface QueryHistoryProps {
  connectionId: string;
  onLoadQuery: (sql: string) => void;
  onClose: () => void;
}

export function QueryHistory({ connectionId, onLoadQuery, onClose }: QueryHistoryProps) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const fetchHistory = useCallback(() => {
    setLoading(true);
    fetch(`/api/v1/db/${connectionId}/history?limit=200`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.history)) setHistory(d.history); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [connectionId]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const confirmClear = () => {
    setShowConfirm(false);
    fetch(`/api/v1/db/${connectionId}/history`, { method: 'DELETE', credentials: 'include' })
      .then(() => setHistory([]))
      .catch(() => {});
  };

  const filtered = search
    ? history.filter(h => h.query_text.toLowerCase().includes(search.toLowerCase()))
    : history;

  return (
    <div className="flex flex-col h-full bg-surface border-l border-border">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-text-secondary">Query History</span>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setShowConfirm(true)} className="text-xs text-text-secondary hover:text-text-primary">Clear</button>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg leading-none">×</button>
        </div>
      </div>
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter queries…"
          className="w-full px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && <p className="text-xs text-text-secondary text-center py-4">Loading…</p>}
        {!loading && filtered.length === 0 && (
          <p className="text-xs text-text-secondary text-center py-4">No history</p>
        )}
        {filtered.map(item => (
          <div
            key={item.id}
            onClick={() => onLoadQuery(item.query_text)}
            className="px-3 py-2 border-b border-border/50 cursor-pointer hover:bg-surface-hover group"
          >
            <pre className="text-xs text-text-primary font-mono whitespace-pre-wrap line-clamp-3 leading-relaxed">{item.query_text}</pre>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-text-secondary">
                {new Date(item.executed_at).toLocaleString()}
              </span>
              {item.error ? (
                <span className="text-[10px] text-red-400">Error</span>
              ) : item.row_count !== null ? (
                <span className="text-[10px] text-text-secondary">{item.row_count} rows</span>
              ) : null}
              {item.duration_ms !== null && (
                <span className="text-[10px] text-text-secondary">{item.duration_ms}ms</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {showConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setShowConfirm(false); }}
        >
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Clear Query History</h3>
                <p className="text-sm text-text-secondary mt-1">This will permanently remove all query history for this connection. This action cannot be undone.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1.5 text-sm rounded bg-surface hover:bg-surface-hover border border-border text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={confirmClear}
                className="px-3 py-1.5 text-sm rounded bg-red-600 hover:bg-red-700 text-white font-medium"
              >
                Clear History
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
