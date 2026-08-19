import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTimezone } from '../../hooks/useTimezone';
import { formatDate as formatDateTz } from '../../utils/formatDate';
import { DateTimePicker } from '../DateTimePicker';

interface AuditEntry {
  id: string;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  eventType: string;
  target: string | null;
  details: unknown;
  ipAddress: string | null;
  timestamp: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface AuditUser {
  id: string | null;
  username: string | null;
  displayName: string | null;
}

// formatTs is now replaced by formatDateTz(iso, timezone) using the app timezone

function eventCategory(eventType: string): string {
  if (eventType.startsWith('auth.')) return 'auth';
  if (eventType.startsWith('session.')) return 'session';
  if (eventType.startsWith('connection.')) return 'connection';
  if (eventType.startsWith('settings.')) return 'settings';
  if (eventType.startsWith('profile.')) return 'profile';
  if (eventType.startsWith('user.')) return 'user';
  return 'other';
}

const CATEGORY_CLASSES: Record<string, string> = {
  auth: 'bg-blue-500/15 text-blue-400',
  session: 'bg-green-500/15 text-green-400',
  connection: 'bg-purple-500/15 text-purple-400',
  settings: 'bg-orange-500/15 text-orange-400',
  profile: 'bg-yellow-500/15 text-yellow-400',
  user: 'bg-indigo-500/15 text-indigo-400',
  other: 'bg-surface-hover text-text-secondary',
};

function DiffView({ before, after }: { before: Record<string, unknown>; after: Record<string, unknown> }) {
  const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  const changedKeys = allKeys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changedKeys.length === 0) return <span className="text-text-secondary text-xs">No changes detected.</span>;

  return (
    <div className="grid grid-cols-2 gap-2 text-xs font-mono mt-1">
      <div className="bg-red-500/10 rounded p-2">
        <div className="text-red-400 font-sans font-medium mb-1 not-italic">Before</div>
        {changedKeys.map((k) => (
          <div key={k} className="text-red-300">
            <span className="text-text-secondary">{k}: </span>{JSON.stringify(before[k])}
          </div>
        ))}
      </div>
      <div className="bg-green-500/10 rounded p-2">
        <div className="text-green-400 font-sans font-medium mb-1 not-italic">After</div>
        {changedKeys.map((k) => (
          <div key={k} className="text-green-300">
            <span className="text-text-secondary">{k}: </span>{JSON.stringify(after[k])}
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailsView({ details }: { details: unknown }) {
  if (details === null || details === undefined) return null;
  if (typeof details === 'object' && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    if (d.before && d.after) {
      return <DiffView before={d.before as Record<string, unknown>} after={d.after as Record<string, unknown>} />;
    }
  }
  return (
    <pre className="text-xs font-mono bg-surface rounded p-2 mt-1 overflow-x-auto text-text-secondary whitespace-pre-wrap break-all">
      {JSON.stringify(details, null, 2)}
    </pre>
  );
}

function EventTypeMultiSelect({ eventTypes, selected, onChange }: {
  eventTypes: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function toggle(et: string) {
    onChange(selected.includes(et) ? selected.filter((s) => s !== et) : [...selected, et]);
  }

  const label = selected.length === 0
    ? 'All event types'
    : selected.length === 1
      ? selected[0]
      : `${selected.length} event types`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1.5 bg-surface border border-border rounded text-text-primary text-sm min-w-[160px] text-left"
      >
        <span className="flex-1 truncate">{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-text-secondary">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full mt-1 z-50 bg-surface-alt border border-border rounded-lg shadow-xl py-1 w-[240px] max-h-[280px] overflow-y-auto">
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full px-3 py-1.5 text-left text-xs text-accent hover:bg-surface-hover"
            >
              Clear all
            </button>
          )}
          {eventTypes.map((et) => (
            <label
              key={et}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(et)}
                onChange={() => toggle(et)}
                className="rounded border-border text-accent focus:ring-accent"
              />
              <span className="text-xs text-text-primary truncate">{et}</span>
            </label>
          ))}
          {eventTypes.length === 0 && (
            <span className="block px-3 py-2 text-xs text-text-secondary">No event types</span>
          )}
        </div>
      )}
    </div>
  );
}

export function AuditTrail() {
  const { user } = useAuth();
  const timezone = useTimezone();
  const canViewAny = user?.permissions?.includes('audit.view_any') ?? false;

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [eventTypeFilters, setEventTypeFilters] = useState<string[]>([]);
  const [userFilter, setUserFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  // Reference data
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [auditUsers, setAuditUsers] = useState<AuditUser[]>([]);

  // Debounce search
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search]);

  const buildParams = useCallback((overridePage?: number) => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set('search', debouncedSearch);
    if (eventTypeFilters.length > 0) p.set('eventType', eventTypeFilters.join(','));
    if (userFilter) p.set('userId', userFilter);
    if (fromDate) p.set('from', fromDate);
    if (toDate) p.set('to', toDate);
    p.set('page', String(overridePage ?? page));
    p.set('limit', '50');
    return p;
  }, [debouncedSearch, eventTypeFilters, userFilter, fromDate, toDate, page]);

  const loadEntries = useCallback(async (overridePage?: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/audit?${buildParams(overridePage)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const d = await res.json();
        setEntries(d.entries);
        setPagination(d.pagination);
      }
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  useEffect(() => {
    fetch('/api/v1/audit/event-types', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setEventTypes(d.eventTypes ?? []))
      .catch(() => {});

    if (canViewAny) {
      fetch('/api/v1/audit/users', { credentials: 'include' })
        .then((r) => r.json())
        .then((d) => setAuditUsers(d.users ?? []))
        .catch(() => {});
    }
  }, [canViewAny]);

  async function exportData(format: 'csv' | 'json') {
    const p = buildParams(1);
    p.set('limit', '10000');
    const res = await fetch(`/api/v1/audit?${p}`, { credentials: 'include' });
    if (!res.ok) return;
    const d = await res.json();
    const rows: AuditEntry[] = d.entries;

    let blob: Blob;
    let filename: string;

    if (format === 'json') {
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      filename = 'audit-log.json';
    } else {
      const headers = ['timestamp', 'username', 'eventType', 'target', 'ipAddress', 'details'];
      const csvRows = [
        headers.join(','),
        ...rows.map((r) =>
          headers.map((h) => {
            const key = h as keyof AuditEntry;
            const val = h === 'details' ? JSON.stringify(r[key]) : String(r[key] ?? '');
            return `"${val.replace(/"/g, '""')}"`;
          }).join(',')
        ),
      ];
      blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
      filename = 'audit-log.csv';
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    loadEntries(newPage);
  }

  function resetFilters() {
    setSearch('');
    setEventTypeFilters([]);
    setUserFilter('');
    setFromDate('');
    setToDate('');
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Audit Trail</h2>
        <div className="flex gap-2">
          <button onClick={() => exportData('csv')}
            className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover">
            Export CSV
          </button>
          <button onClick={() => exportData('json')}
            className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover">
            Export JSON
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search..."
          className="flex-1 min-w-[160px] px-3 py-1.5 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
        />
        {/* Event type multi-select */}
        <div className="relative">
          <EventTypeMultiSelect
            eventTypes={eventTypes}
            selected={eventTypeFilters}
            onChange={(v) => { setEventTypeFilters(v); setPage(1); }}
          />
        </div>

        {canViewAny && (
          <select
            value={userFilter}
            onChange={(e) => { setUserFilter(e.target.value); setPage(1); }}
            className="px-2 py-1.5 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
          >
            <option value="">All users</option>
            {auditUsers.map((u) => (
              <option key={u.id} value={u.id ?? ''}>{u.username ?? u.id}</option>
            ))}
          </select>
        )}

        <DateTimePicker
          value={fromDate}
          onChange={(v) => { setFromDate(v); setPage(1); }}
          placeholder="From date"
          className="px-2 py-1.5 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm w-[170px]"
        />
        <DateTimePicker
          value={toDate}
          onChange={(v) => { setToDate(v); setPage(1); }}
          placeholder="To date"
          align="right"
          className="px-2 py-1.5 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm w-[170px]"
        />
        <button onClick={resetFilters}
          className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover">
          Reset
        </button>
      </div>

      {/* Top pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary text-xs">
          {pagination.total} entries total
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handlePageChange(pagination.page - 1)}
            disabled={pagination.page <= 1}
            className="px-3 py-1 border border-border rounded text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed text-xs"
          >
            Previous
          </button>
          <span className="text-text-secondary text-xs">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            onClick={() => handlePageChange(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages}
            className="px-3 py-1 border border-border rounded text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed text-xs"
          >
            Next
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt border-b border-border">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Timestamp</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">User</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Event Type</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Target</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">IP Address</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-text-secondary text-sm">Loading...</td>
              </tr>
            )}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-text-secondary text-sm">No entries found.</td>
              </tr>
            )}
            {!loading && entries.map((entry) => {
              const expanded = expandedId === entry.id;
              const cat = eventCategory(entry.eventType);
              return (
                <>
                  <tr
                    key={entry.id}
                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                    className="border-b border-border cursor-pointer hover:bg-surface-hover transition-colors last:border-b-0"
                  >
                    <td className="px-3 py-2 text-text-secondary text-xs whitespace-nowrap">{formatDateTz(entry.timestamp, timezone)}</td>
                    <td className="px-3 py-2 text-text-primary text-xs">{entry.displayName ?? entry.username ?? <span className="text-text-secondary italic">System</span>}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${CATEGORY_CLASSES[cat] ?? CATEGORY_CLASSES.other}`}>
                        {entry.eventType}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-text-secondary text-xs max-w-[160px] truncate">{entry.target ?? '—'}</td>
                    <td className="px-3 py-2 text-text-secondary text-xs font-mono">{entry.ipAddress ?? '—'}</td>
                  </tr>
                  {expanded && (
                    <tr key={`${entry.id}-expanded`} className="bg-surface-alt border-b border-border">
                      <td colSpan={5} className="px-4 py-3">
                        <DetailsView details={entry.details} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary text-xs">
          {pagination.total} entries total
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handlePageChange(pagination.page - 1)}
            disabled={pagination.page <= 1}
            className="px-3 py-1 border border-border rounded text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed text-xs"
          >
            Previous
          </button>
          <span className="text-text-secondary text-xs">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            onClick={() => handlePageChange(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages}
            className="px-3 py-1 border border-border rounded text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed text-xs"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
