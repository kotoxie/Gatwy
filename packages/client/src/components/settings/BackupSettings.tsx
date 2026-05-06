import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';

interface SizeInfo { dbSize: number; recordingsSize: number; recordingCount: number }
interface SmbConnection { id: string; name: string; host: string; port: number }
interface AutoConfig {
  enabled: boolean;
  destinationMode: 'saved' | 'adhoc';
  connectionId: string;
  remotePath: string;
  scheduleType: 'daily' | 'weekly';
  scheduleTime: string;
  scheduleWeekday: number;
  includeRecordings: boolean;
  retentionCount: number;
  autoDisabled: boolean;
}
interface AutoStatus {
  enabled: boolean;
  autoDisabled: boolean;
  runInProgress: boolean;
  queuedScheduledRun: boolean;
  nextRunAt: string;
  lastRunAt: string;
  lastStatus: string;
  lastError: string;
  lastFilename: string;
  lastSizeBytes: number;
  consecutiveFailures: number;
  maxFileSizeBytes: number;
}
interface AutoHistoryRow {
  id: string;
  trigger_type: string;
  status: string;
  started_at: string;
  size_bytes: number | null;
  filename: string | null;
  error_message: string | null;
}

type Tab = 'manual' | 'auto';

function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="relative inline-flex h-5 w-9 shrink-0">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="absolute inset-0 rounded-full bg-border transition-colors peer-checked:bg-accent" />
      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
    </span>
  );
}

export function BackupSettings() {
  const [tab, setTab] = useState<Tab>('manual');

  return (
    <div className="space-y-5">
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab('manual')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'manual' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
        >
          Manual Backup
        </button>
        <button
          onClick={() => setTab('auto')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'auto' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
        >
          Auto Backup
        </button>
      </div>

      {tab === 'manual' ? <ManualBackupTab /> : <AutoBackupTab />}
    </div>
  );
}

function ManualBackupTab() {
  const [exportPassword, setExportPassword] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [includeRecordings, setIncludeRecordings] = useState(false);
  const [sizeInfo, setSizeInfo] = useState<SizeInfo | null>(null);
  const [sizeLoading, setSizeLoading] = useState(true);

  const [importPassword, setImportPassword] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importMsg, setImportMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSizeLoading(true);
    fetch('/api/v1/backup/size', { credentials: 'include' })
      .then((r) => r.ok ? r.json() as Promise<SizeInfo> : Promise.reject())
      .then((d) => setSizeInfo(d))
      .catch(() => setSizeInfo(null))
      .finally(() => setSizeLoading(false));
  }, []);

  async function handleExport(e: React.FormEvent) {
    e.preventDefault();
    setExportMsg(null);
    if (exportPassword.length < 8) { setExportMsg({ type: 'error', text: 'Password must be at least 8 characters.' }); return; }
    if (exportPassword !== exportConfirm) { setExportMsg({ type: 'error', text: 'Passwords do not match.' }); return; }
    setExportLoading(true);
    try {
      const res = await fetch('/api/v1/backup/export', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: exportPassword, includeRecordings }),
      });
      if (!res.ok) {
        const d = await res.json() as { error: string };
        setExportMsg({ type: 'error', text: d.error || 'Export failed.' });
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const fname = cd.match(/filename="([^"]+)"/)?.[1] ?? 'gatwy-backup.geb';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
      setExportMsg({ type: 'success', text: `Backup downloaded: ${fname}` });
      setExportPassword('');
      setExportConfirm('');
    } catch {
      setExportMsg({ type: 'error', text: 'Network error during export.' });
    } finally {
      setExportLoading(false);
    }
  }

  async function doImport() {
    if (!importFile || !importPassword) return;
    setImportLoading(true);
    setImportMsg(null);
    setShowConfirm(false);
    try {
      const arrayBuf = await importFile.arrayBuffer();
      const res = await fetch('/api/v1/backup/import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Password': importPassword },
        body: arrayBuf,
      });

      let d: { ok?: boolean; message?: string; error?: string; recordingsRestored?: number } = {};
      try { d = await res.json() as typeof d; } catch { /* non-json */ }

      if (!res.ok) {
        const msg = res.status === 422 ? 'Incorrect backup password.' : (d.error || `Import failed (HTTP ${res.status}).`);
        setImportMsg({ type: 'error', text: msg });
        return;
      }

      setImportMsg({ type: 'success', text: `${d.message ?? 'Restored.'} (${d.recordingsRestored ?? 0} recordings restored)` });
      setImportFile(null);
      setImportPassword('');
      if (fileRef.current) fileRef.current.value = '';
    } catch {
      setImportMsg({ type: 'error', text: 'Network error during import.' });
    } finally {
      setImportLoading(false);
    }
  }

  return (
    <div className="max-w-lg space-y-8">
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">Export Backup</h2>
        <p className="text-sm text-text-secondary mb-4">
          Creates an encrypted backup of the database and encryption key.
          Optionally includes session recordings.
        </p>
        <div className="mb-4 rounded-lg border border-border bg-surface-hover px-4 py-3 text-sm space-y-1">
          {sizeLoading ? (
            <p className="text-text-secondary">Calculating sizes...</p>
          ) : sizeInfo ? (
            <>
              <p className="text-text-secondary"><span className="font-medium text-text-primary">Database:</span> ~{fmtBytes(sizeInfo.dbSize)}</p>
              <p className="text-text-secondary">
                <span className="font-medium text-text-primary">Recordings:</span> ~{fmtBytes(sizeInfo.recordingsSize)}
                {sizeInfo.recordingCount > 0 && <span className="text-text-secondary/70"> ({sizeInfo.recordingCount} files)</span>}
              </p>
              <p className="font-medium text-text-primary pt-1 border-t border-border">Estimated total: ~{fmtBytes(sizeInfo.dbSize + (includeRecordings ? sizeInfo.recordingsSize : 0))}</p>
            </>
          ) : (
            <p className="text-text-secondary/70">Could not load size info.</p>
          )}
        </div>

        <label className="flex items-center gap-3 mb-4 cursor-pointer select-none w-fit">
          <Toggle checked={includeRecordings} onChange={setIncludeRecordings} />
          <span className="text-sm text-text-secondary">Include recordings in backup</span>
        </label>

        <form onSubmit={handleExport} className="space-y-3">
          <input type="password" value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} placeholder="Backup password" className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary text-sm" />
          <input type="password" value={exportConfirm} onChange={(e) => setExportConfirm(e.target.value)} placeholder="Confirm password" className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary text-sm" />
          {exportMsg && <p className={`text-sm ${exportMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>{exportMsg.text}</p>}
          <button type="submit" disabled={exportLoading} className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium">
            {exportLoading ? 'Creating backup...' : 'Download Backup'}
          </button>
        </form>
      </section>

      <hr className="border-border" />

      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">Import / Restore Backup</h2>
        <p className="text-sm text-red-400 font-medium mb-4">This overwrites all current data.</p>
        <div className="space-y-3">
          <input ref={fileRef} type="file" accept=".geb" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} className="w-full text-sm text-text-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-border file:bg-surface-hover file:text-text-primary file:cursor-pointer hover:file:bg-surface" />
          <input type="password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} placeholder="Backup password" className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary text-sm" />

          {showConfirm && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400 space-y-2">
              <p className="font-medium">This will permanently overwrite all current data. Continue?</p>
              <div className="flex gap-2">
                <button onClick={doImport} className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700">Yes, restore</button>
                <button onClick={() => setShowConfirm(false)} className="px-3 py-1.5 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm">Cancel</button>
              </div>
            </div>
          )}

          {importMsg && <p className={`text-sm ${importMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>{importMsg.text}</p>}

          {!showConfirm && (
            <button
              onClick={() => {
                if (!importFile) { setImportMsg({ type: 'error', text: 'Select a backup file first.' }); return; }
                if (!importPassword) { setImportMsg({ type: 'error', text: 'Enter the backup password.' }); return; }
                setImportMsg(null);
                setShowConfirm(true);
              }}
              disabled={importLoading}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 text-sm font-medium"
            >
              {importLoading ? 'Restoring...' : 'Restore Backup'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function AutoBackupTab() {
  const { user } = useAuth();
  const hasSmbPermission = user?.permissions?.includes('protocols.smb') ?? false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [passwordSentinel, setPasswordSentinel] = useState('__unchanged__');
  const [config, setConfig] = useState<AutoConfig>({
    enabled: false,
    destinationMode: 'saved',
    connectionId: '',
    remotePath: '',
    scheduleType: 'daily',
    scheduleTime: '02:30',
    scheduleWeekday: 1,
    includeRecordings: false,
    retentionCount: 14,
    autoDisabled: false,
  });
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [history, setHistory] = useState<AutoHistoryRow[]>([]);
  const [connections, setConnections] = useState<SmbConnection[]>([]);

  const [globalPassword, setGlobalPassword] = useState('');
  const [globalPasswordConfirm, setGlobalPasswordConfirm] = useState('');
  const [hasPassword, setHasPassword] = useState(false);

  const [adhocOpen, setAdhocOpen] = useState(false);
  const [adhoc, setAdhoc] = useState({ host: '', port: 445, share: '', username: '', password: '', domain: '' });
  const [adhocHasPassword, setAdhocHasPassword] = useState(false);

  const weekdays = [
    { value: 0, label: 'Sunday' },
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
  ];

  async function load() {
    setLoading(true);
    setMsg(null);
    try {
      const [cfgRes, stRes, histRes, conRes, capRes] = await Promise.all([
        fetch('/api/v1/backup/auto/config', { credentials: 'include' }),
        fetch('/api/v1/backup/auto/status', { credentials: 'include' }),
        fetch('/api/v1/backup/auto/history?limit=30', { credentials: 'include' }),
        fetch('/api/v1/backup/auto/connections', { credentials: 'include' }),
        fetch('/api/v1/backup/auto/capabilities', { credentials: 'include' }),
      ]);

      if (capRes.ok) {
        const capData = await capRes.json() as { passwordSentinel?: string };
        if (capData.passwordSentinel) setPasswordSentinel(capData.passwordSentinel);
      }

      if (cfgRes.ok) {
        const data = await cfgRes.json() as {
          config: AutoConfig;
          hasPassword: boolean;
          hasAdhocPassword: boolean;
          adhoc: { host: string; port: number; share: string; username: string; domain: string };
        };
        setConfig(data.config);
        setHasPassword(data.hasPassword);
        setAdhocHasPassword(data.hasAdhocPassword);
        setAdhoc((prev) => ({
          ...prev,
          host: data.adhoc.host || '',
          port: data.adhoc.port || 445,
          share: data.adhoc.share || '',
          username: data.adhoc.username || '',
          domain: data.adhoc.domain || '',
          password: '',
        }));
      }

      if (stRes.ok) {
        const data = await stRes.json() as { status: AutoStatus };
        setStatus(data.status);
      }

      if (histRes.ok) {
        const data = await histRes.json() as { rows: AutoHistoryRow[] };
        setHistory(data.rows ?? []);
      }

      if (conRes.ok) {
        const data = await conRes.json() as { connections: SmbConnection[] };
        setConnections(data.connections ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveConfig() {
    setSaving(true);
    setMsg(null);
    try {
      if (!globalPassword && !hasPassword) {
        setMsg({ type: 'error', text: 'Global backup password is required.' });
        return;
      }
      if (globalPassword && globalPassword.length < 8) {
        setMsg({ type: 'error', text: 'Global backup password must be at least 8 characters.' });
        return;
      }
      if (globalPassword && globalPassword !== globalPasswordConfirm) {
        setMsg({ type: 'error', text: 'Global password confirmation does not match.' });
        return;
      }
      if (config.destinationMode === 'saved' && !config.connectionId) {
        setMsg({ type: 'error', text: 'Select an SMB destination connection.' });
        return;
      }
      if (config.destinationMode === 'adhoc' && (!adhoc.host || !adhoc.share)) {
        setMsg({ type: 'error', text: 'Ad-hoc SMB host and share are required.' });
        return;
      }

      const res = await fetch('/api/v1/backup/auto/config', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          password: globalPassword || passwordSentinel,
          adhoc: {
            ...adhoc,
            password: adhoc.password || passwordSentinel,
          },
        }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) {
        setMsg({ type: 'error', text: d.error || 'Failed to save auto-backup config.' });
        return;
      }

      setMsg({ type: 'success', text: 'Auto-backup configuration saved.' });
      setGlobalPassword('');
      setGlobalPasswordConfirm('');
      setAdhoc((p) => ({ ...p, password: '' }));
      setHasPassword(true);
      setAdhocHasPassword(true);
      await load();
    } catch {
      setMsg({ type: 'error', text: 'Network error while saving configuration.' });
    } finally {
      setSaving(false);
    }
  }

  async function testDestination() {
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/backup/auto/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationMode: config.destinationMode,
          connectionId: config.connectionId,
          remotePath: config.remotePath,
          adhoc: {
            ...adhoc,
            password: adhoc.password || passwordSentinel,
          },
        }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) {
        setMsg({ type: 'error', text: d.error || 'Destination test failed.' });
        return;
      }
      setMsg({ type: 'success', text: 'Destination test passed.' });
      setAdhoc((p) => ({ ...p, password: '' }));
      setAdhocHasPassword(true);
    } catch {
      setMsg({ type: 'error', text: 'Network error while testing destination.' });
    } finally {
      setTesting(false);
    }
  }

  async function runNow() {
    setRunningNow(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/backup/auto/run-now', {
        method: 'POST',
        credentials: 'include',
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) {
        setMsg({ type: 'error', text: d.error || 'Run now failed.' });
        return;
      }
      setMsg({ type: 'success', text: 'Auto-backup run completed.' });
      await load();
    } catch {
      setMsg({ type: 'error', text: 'Network error while running backup.' });
    } finally {
      setRunningNow(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {!hasSmbPermission && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          SMB protocol permission is missing for your role. Auto-backup may fail until this permission is granted.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="space-y-4 border border-border rounded-2xl p-5 bg-gradient-to-br from-surface-alt to-surface shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text-primary">Configuration</h2>
              <p className="text-xs text-text-secondary mt-0.5">Single scheduled job. SMB destination only.</p>
            </div>
          </div>
          {loading ? (
            <p className="text-sm text-text-secondary">Loading auto-backup configuration...</p>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-surface-hover/60 p-3">
                <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
                  <span className="text-sm font-medium text-text-primary">Enable scheduled auto-backup</span>
                  <Toggle checked={config.enabled} onChange={(v) => setConfig((p) => ({ ...p, enabled: v }))} />
                </label>
              </div>

              <div className="rounded-xl border border-border bg-surface-hover/40 p-3 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Global Password</p>
                <input type="password" value={globalPassword} onChange={(e) => setGlobalPassword(e.target.value)} placeholder={hasPassword ? 'Leave blank to keep existing global password' : 'Global backup password (min 8 chars)'} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                <input type="password" value={globalPasswordConfirm} onChange={(e) => setGlobalPasswordConfirm(e.target.value)} placeholder="Confirm global password" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
              </div>

              <div className="rounded-xl border border-border bg-surface-hover/40 p-3 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Destination Mode</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setConfig((p) => ({ ...p, destinationMode: 'saved' }))}
                    className={`px-3 py-2 rounded-lg border text-sm text-left transition-colors ${config.destinationMode === 'saved' ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text-secondary hover:text-text-primary'}`}
                  >
                    Saved SMB connection
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfig((p) => ({ ...p, destinationMode: 'adhoc' }))}
                    className={`px-3 py-2 rounded-lg border text-sm text-left transition-colors ${config.destinationMode === 'adhoc' ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text-secondary hover:text-text-primary'}`}
                  >
                    Ad-hoc SMB destination
                  </button>
                </div>
              </div>

              {config.destinationMode === 'saved' && (
                <div className="rounded-xl border border-border bg-surface-hover/40 p-3 space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Saved Destination</p>
                  <select value={config.connectionId} onChange={(e) => setConfig((p) => ({ ...p, connectionId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm">
                    <option value="">Select admin-owned SMB destination...</option>
                    {connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.host}:{c.port})</option>)}
                  </select>
                </div>
              )}

              {config.destinationMode === 'adhoc' && (
                <details className="rounded-xl border border-border bg-surface-hover/40" open={adhocOpen} onToggle={(e) => setAdhocOpen((e.target as HTMLDetailsElement).open)}>
                  <summary className="px-3 py-2 text-sm cursor-pointer text-text-primary font-medium">Optional ad-hoc SMB settings</summary>
                  <div className="px-3 pb-3 space-y-2">
                    <input type="text" value={adhoc.host} onChange={(e) => setAdhoc((p) => ({ ...p, host: e.target.value }))} placeholder="SMB host" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                    <div className="grid grid-cols-2 gap-2">
                      <input type="number" min="1" value={adhoc.port} onChange={(e) => setAdhoc((p) => ({ ...p, port: parseInt(e.target.value || '445', 10) }))} placeholder="Port" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                      <input type="text" value={adhoc.share} onChange={(e) => setAdhoc((p) => ({ ...p, share: e.target.value }))} placeholder="Share" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                    </div>
                    <input type="text" value={adhoc.username} onChange={(e) => setAdhoc((p) => ({ ...p, username: e.target.value }))} placeholder="Username" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                    <input type="password" value={adhoc.password} onChange={(e) => setAdhoc((p) => ({ ...p, password: e.target.value }))} placeholder={adhocHasPassword ? 'Leave blank to keep ad-hoc password' : 'Ad-hoc password'} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                    <input type="text" value={adhoc.domain} onChange={(e) => setAdhoc((p) => ({ ...p, domain: e.target.value }))} placeholder="Domain (optional)" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                  </div>
                </details>
              )}

              <div className="rounded-xl border border-border bg-surface-hover/40 p-3 space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Schedule & Retention</p>
                <input type="text" value={config.remotePath} onChange={(e) => setConfig((p) => ({ ...p, remotePath: e.target.value }))} placeholder="Remote folder path" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />

                <div className="grid grid-cols-2 gap-2">
                  <select value={config.scheduleType} onChange={(e) => setConfig((p) => ({ ...p, scheduleType: e.target.value as 'daily' | 'weekly' }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm">
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                  <input type="time" value={config.scheduleTime} onChange={(e) => setConfig((p) => ({ ...p, scheduleTime: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                </div>

                {config.scheduleType === 'weekly' && (
                  <select value={config.scheduleWeekday} onChange={(e) => setConfig((p) => ({ ...p, scheduleWeekday: parseInt(e.target.value, 10) }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm">
                    {weekdays.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                )}

                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <label className="flex items-center gap-3 cursor-pointer select-none w-fit">
                    <Toggle checked={config.includeRecordings} onChange={(v) => setConfig((p) => ({ ...p, includeRecordings: v }))} />
                    <span className="text-sm text-text-secondary">Include recordings</span>
                  </label>

                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Retention count</label>
                    <input type="number" min="1" max="365" value={config.retentionCount} onChange={(e) => setConfig((p) => ({ ...p, retentionCount: parseInt(e.target.value || '1', 10) }))} className="w-28 px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm" />
                  </div>
                </div>
              </div>

              <p className="text-xs text-text-secondary">Max backup size is enforced server-side at 4 GB.</p>

              <div className="flex flex-wrap gap-2">
                <button onClick={saveConfig} disabled={saving} className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium">{saving ? 'Saving...' : 'Save'}</button>
                <button onClick={testDestination} disabled={testing} className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover disabled:opacity-50 text-sm font-medium">{testing ? 'Testing...' : 'Test Destination'}</button>
                <button onClick={runNow} disabled={runningNow} className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover disabled:opacity-50 text-sm font-medium">{runningNow ? 'Running...' : 'Run Now'}</button>
              </div>

              {msg && <p className={`text-sm ${msg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>{msg.text}</p>}
            </>
          )}
        </section>

        <section className="space-y-4 border border-border rounded-lg p-4">
          <h2 className="text-base font-semibold text-text-primary">Status</h2>
          {!status ? (
            <p className="text-sm text-text-secondary">Loading status...</p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-text-secondary">Enabled</span><span className="text-text-primary">{status.enabled ? 'Yes' : 'No'}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Running</span><span className="text-text-primary">{status.runInProgress ? 'Yes' : 'No'}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Queued scheduled run</span><span className="text-text-primary">{status.queuedScheduledRun ? 'Yes' : 'No'}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Auto-disabled</span><span className="text-text-primary">{status.autoDisabled ? 'Yes' : 'No'}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Consecutive failures</span><span className="text-text-primary">{status.consecutiveFailures}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Next run</span><span className="text-text-primary">{fmtDate(status.nextRunAt)}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Last run</span><span className="text-text-primary">{fmtDate(status.lastRunAt)}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Last status</span><span className="text-text-primary">{status.lastStatus || '-'}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Last file</span><span className="text-text-primary truncate max-w-[220px] text-right">{status.lastFilename || '-'}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Last size</span><span className="text-text-primary">{fmtBytes(status.lastSizeBytes)}</span></div>
              <div className="flex justify-between"><span className="text-text-secondary">Max file size</span><span className="text-text-primary">{fmtBytes(status.maxFileSizeBytes)}</span></div>
              {status.lastError && <p className="text-red-400 text-xs pt-2 border-t border-border">Last error: {status.lastError}</p>}
            </div>
          )}
        </section>
      </div>

      <section className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Run History</h2>
          <button onClick={() => void load()} className="px-3 py-1.5 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm">Refresh</button>
        </div>
        <p className="text-sm text-text-secondary">History retention is 90 days.</p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-text-secondary border-b border-border">
                <th className="py-2 pr-3">Started</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Trigger</th>
                <th className="py-2 pr-3">Size</th>
                <th className="py-2 pr-3">File</th>
                <th className="py-2 pr-3">Error</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td className="py-3 text-text-secondary" colSpan={6}>No runs yet.</td>
                </tr>
              )}
              {history.map((r) => (
                <tr key={r.id} className="border-b border-border/60 text-text-primary">
                  <td className="py-2 pr-3">{fmtDate(r.started_at)}</td>
                  <td className="py-2 pr-3">{r.status}</td>
                  <td className="py-2 pr-3">{r.trigger_type}</td>
                  <td className="py-2 pr-3">{fmtBytes(r.size_bytes ?? 0)}</td>
                  <td className="py-2 pr-3 max-w-[220px] truncate">{r.filename || '-'}</td>
                  <td className="py-2 pr-3 max-w-[260px] truncate text-red-400">{r.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
