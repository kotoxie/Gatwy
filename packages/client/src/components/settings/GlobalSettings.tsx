import { useEffect, useState, type FormEvent } from 'react';
import type React from 'react';
import { useSettings, invalidateSettings } from '../../hooks/useSettings';

type Tab = 'general' | 'recordings';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
];

// All IANA timezones supported by the runtime (Intl API).
// UTC is always pinned first since it is the system default and may not be
// returned by Intl.supportedValuesOf in all browser/environment combinations.
const TIMEZONES: string[] = (() => {
  try {
    const zones = Intl.supportedValuesOf('timeZone').filter((tz) => tz !== 'UTC');
    return ['UTC', ...zones];
  } catch {
    return ['UTC'];
  }
})();

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        value ? 'bg-accent' : 'bg-surface-hover border border-border'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function GlobalSettings() {
  const { settings, refresh } = useSettings();
  const [activeTab, setActiveTab] = useState<Tab>('general');

  // General
  const [appName, setAppName] = useState('Gatwy');
  const [timezone, setTimezone] = useState('UTC');
  const [healthMonitorEnabled, setHealthMonitorEnabled] = useState(true);
  const [generalMsg, setGeneralMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingGeneral, setSavingGeneral] = useState(false);

  // Logo
  const [logoPreview, setLogoPreview] = useState<string>('');

  // Recordings
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [recordingRetention, setRecordingRetention] = useState('90');
  const [retentionDaysEnabled, setRetentionDaysEnabled] = useState(true);
  const [retentionSizeEnabled, setRetentionSizeEnabled] = useState(false);
  const [retentionMaxSizeGb, setRetentionMaxSizeGb] = useState('10');
  const [recordingMsg, setRecordingMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingRecording, setSavingRecording] = useState(false);

  // Version check preferences
  const [versionAuditLog, setVersionAuditLog] = useState(true);
  const [versionToast, setVersionToast] = useState(true);
  const [versionNotify, setVersionNotify] = useState(false);

  // Audit retention (shown in General tab)
  const [auditRetention, setAuditRetention] = useState('90');

  // Purge session history
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Recording storage
  const [storageBytes, setStorageBytes] = useState<number | null>(null);

  useEffect(() => {
    setAppName(settings['app.name'] ?? 'Gatwy');
    setTimezone(settings['app.timezone'] || 'UTC');
    setLogoPreview(settings['app.logo'] ?? '');
    setAuditRetention(settings['audit.retention_days'] ?? '90');
    setHealthMonitorEnabled(settings['health_monitor.enabled'] !== 'false');
    setVersionAuditLog(settings['version.audit_log_checks'] !== 'false');
    setVersionToast(settings['version.toast_feedback'] !== 'false');
    setVersionNotify(settings['version.notify_on_update'] === 'true');
    setRecordingEnabled(settings['session.recording_enabled'] === 'true');
    setRecordingRetention(settings['session.recording_retention_days'] ?? '90');
    setRetentionDaysEnabled(settings['session.recording_retention_days_enabled'] !== 'false');
    setRetentionSizeEnabled(settings['session.recording_retention_size_enabled'] === 'true');
    setRetentionMaxSizeGb(settings['session.recording_retention_max_size_gb'] ?? '10');
  }, [settings]);

  useEffect(() => {
    if (activeTab !== 'recordings') return;
    fetch('/api/v1/sessions/storage', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { bytes: number } | null) => { if (d) setStorageBytes(d.bytes); })
      .catch(() => {});
  }, [activeTab]);

  async function saveSettings(updates: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch('/api/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      await refresh();
      invalidateSettings();
      return { ok: true };
    }
    const d = await res.json() as { error?: string };
    return { ok: false, error: d.error || 'Failed to save.' };
  }

  async function handleGeneralSave(e: FormEvent) {
    e.preventDefault();
    setSavingGeneral(true);
    setGeneralMsg(null);
    try {
      const result = await saveSettings({
        'app.name': appName,
        'app.timezone': timezone,
        'app.logo': logoPreview,
        'audit.retention_days': auditRetention,
        'health_monitor.enabled': String(healthMonitorEnabled),
        'version.audit_log_checks': String(versionAuditLog),
        'version.toast_feedback': String(versionToast),
        'version.notify_on_update': String(versionNotify),
      });
      setGeneralMsg(result.ok ? { type: 'success', text: 'Saved.' } : { type: 'error', text: result.error! });
    } catch {
      setGeneralMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingGeneral(false);
    }
  }

  function handleLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') setLogoPreview(reader.result); };
    reader.readAsDataURL(file);
    e.target.value = ''; // reset so same file can be re-selected
  }

  async function handlePurge() {
    setPurging(true);
    setPurgeMsg(null);
    try {
      const res = await fetch('/api/v1/sessions', {
        method: 'DELETE',
        credentials: 'include',
      });
      const d = await res.json() as { ok?: boolean; deletedSessions?: number; deletedRecordings?: number; deletedFileSessions?: number; error?: string };
      if (res.ok) {
        const fileNote = (d.deletedFileSessions ?? 0) > 0 ? ` and ${d.deletedFileSessions} file activity session(s)` : '';
        setPurgeMsg({ type: 'success', text: `Deleted ${d.deletedSessions ?? 0} sessions and ${d.deletedRecordings ?? 0} recordings${fileNote}.` });
        setShowPurgeConfirm(false);
        setStorageBytes(0);
      } else {
        setPurgeMsg({ type: 'error', text: d.error || 'Failed to purge.' });
      }
    } catch {
      setPurgeMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setPurging(false);
    }
  }

  async function handleRecordingSave(e: FormEvent) {
    e.preventDefault();
    setSavingRecording(true);
    setRecordingMsg(null);
    try {
      const result = await saveSettings({
        'session.recording_enabled': String(recordingEnabled),
        'session.recording_retention_days': recordingRetention,
        'session.recording_retention_days_enabled': String(retentionDaysEnabled),
        'session.recording_retention_size_enabled': String(retentionSizeEnabled),
        'session.recording_retention_max_size_gb': retentionMaxSizeGb,
      });
      setRecordingMsg(result.ok ? { type: 'success', text: 'Saved.' } : { type: 'error', text: result.error! });
    } catch {
      setRecordingMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingRecording(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-border mb-6 shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t.id
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* General */}
      {activeTab === 'general' && (
        <form onSubmit={handleGeneralSave} className="space-y-4 max-w-lg">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">App Name</label>
            <input
              type="text"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Timezone</label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <p className="text-xs text-text-secondary mt-1">Used to display timestamps across the app.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">App Logo</label>
            <div className="flex items-center gap-3">
              {logoPreview ? (
                <img src={logoPreview} alt="Logo preview" className="h-9 w-auto max-w-[120px] object-contain rounded border border-border bg-surface p-1" />
              ) : (
                <div className="h-9 w-20 rounded border border-dashed border-border flex items-center justify-center text-xs text-text-secondary">No logo</div>
              )}
              <label className="px-3 py-1.5 bg-surface-hover border border-border rounded text-sm text-text-primary hover:bg-surface cursor-pointer">
                Upload image
                <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp" className="hidden" onChange={handleLogoFile} />
              </label>
              {logoPreview && (
                <button type="button" onClick={() => setLogoPreview('')}
                  className="px-3 py-1.5 border border-border rounded text-sm text-text-secondary hover:bg-surface-hover">
                  Remove
                </button>
              )}
            </div>
            <p className="text-xs text-text-secondary mt-1">PNG, JPEG, SVG or WebP, max 4 MB. Replaces the text title in the header.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Audit log retention (days)</label>
            <input
              type="number"
              min="1"
              value={auditRetention}
              onChange={(e) => setAuditRetention(e.target.value)}
              className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <Toggle value={healthMonitorEnabled} onChange={setHealthMonitorEnabled} />
            <div>
              <span className="text-sm text-text-secondary">Health monitor</span>
              <p className="text-xs text-text-secondary/60 mt-0.5">Periodically checks if connections are reachable and shows green/red dots in the sidebar.</p>
            </div>
          </div>

          <div className="border-t border-border pt-4 space-y-3">
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Version Check Behaviour</p>
            <div className="flex items-center gap-3">
              <Toggle value={versionAuditLog} onChange={setVersionAuditLog} />
              <div>
                <span className="text-sm text-text-secondary">Log manual checks to audit trail</span>
                <p className="text-xs text-text-secondary/60 mt-0.5">Writes an entry to the audit log each time someone clicks "Check for updates", including the result and any error.</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Toggle value={versionToast} onChange={setVersionToast} />
              <div>
                <span className="text-sm text-text-secondary">Show toast after manual check</span>
                <p className="text-xs text-text-secondary/60 mt-0.5">Displays a brief notification with the result — up to date, new version found, or unreachable.</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Toggle value={versionNotify} onChange={setVersionNotify} />
              <div>
                <span className="text-sm text-text-secondary">Fire notification rule on update available</span>
                <p className="text-xs text-text-secondary/60 mt-0.5">Emits a <code className="text-xs bg-surface px-1 rounded">system.update_available</code> event you can use in notification rules to send an alert via email, Telegram, Slack, etc.</p>
              </div>
            </div>
          </div>
          {generalMsg && (
            <p className={`text-sm ${generalMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {generalMsg.text}
            </p>
          )}
          <button
            type="submit"
            disabled={savingGeneral}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingGeneral ? 'Saving...' : 'Save'}
          </button>
        </form>
      )}

      {/* Recordings */}
      {activeTab === 'recordings' && (
        <div className="space-y-6 max-w-lg">
        <form onSubmit={handleRecordingSave} className="space-y-4">
          <div className="flex items-center gap-3">
            <Toggle value={recordingEnabled} onChange={setRecordingEnabled} />
            <span className="text-sm text-text-secondary">Session recording enabled <span className="text-xs text-text-secondary/60">(SSH &amp; RDP)</span></span>
          </div>

          {/* Retention by days */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Toggle value={retentionDaysEnabled} onChange={setRetentionDaysEnabled} />
              <span className="text-sm text-text-secondary">Retention by age</span>
            </div>
            {retentionDaysEnabled && (
              <div className="ml-12">
                <label className="block text-sm font-medium text-text-secondary mb-1">Recording retention (days)</label>
                <p className="text-xs text-text-secondary mb-1">Recordings older than this will be automatically removed.</p>
                <input
                  type="number"
                  min="1"
                  value={recordingRetention}
                  onChange={(e) => setRecordingRetention(e.target.value)}
                  className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                />
              </div>
            )}
          </div>

          {/* Retention by size */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Toggle value={retentionSizeEnabled} onChange={setRetentionSizeEnabled} />
              <span className="text-sm text-text-secondary">Retention by size</span>
            </div>
            {retentionSizeEnabled && (
              <div className="ml-12">
                <label className="block text-sm font-medium text-text-secondary mb-1">Max recording storage (GB)</label>
                <p className="text-xs text-text-secondary mb-1">When total storage exceeds this limit, the oldest recordings are removed first.</p>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={retentionMaxSizeGb}
                  onChange={(e) => setRetentionMaxSizeGb(e.target.value)}
                  className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                />
              </div>
            )}
          </div>

          {retentionDaysEnabled && retentionSizeEnabled && (
            <p className="text-xs text-text-secondary bg-surface rounded px-3 py-2 border border-border">
              ℹ️ Both retention policies are active — whichever limit is reached first will trigger cleanup (FIFO).
            </p>
          )}
          {recordingMsg && (
            <p className={`text-sm ${recordingMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {recordingMsg.text}
            </p>
          )}
          <button
            type="submit"
            disabled={savingRecording}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingRecording ? 'Saving...' : 'Save'}
          </button>
        </form>

        {/* Storage usage */}
        {storageBytes !== null && (
          <div className="border border-border rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                  <path d="M3 12a9 3 0 0 0 18 0" />
                </svg>
                Recording Storage
              </h3>
              <span className="text-xs font-mono text-text-secondary">{formatBytes(storageBytes)}</span>
            </div>
            <div className="w-full h-2 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: storageBytes > 0 ? `${Math.min(100, (storageBytes / (10 * 1024 ** 3)) * 100)}%` : '0%' }}
              />
            </div>
            <p className="text-xs text-text-secondary">Space used by all recording files on disk.</p>
          </div>
        )}

        {/* Danger zone */}
        <div className="mt-8 border border-red-500/20 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-red-400 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Danger Zone
          </h3>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">Delete all recordings</p>
              <p className="text-xs text-text-secondary mt-0.5">Permanently deletes all recording files and their session records from disk.</p>
            </div>
            <button
              type="button"
              onClick={() => { setShowPurgeConfirm(true); setPurgeMsg(null); }}
              className="shrink-0 px-3 py-1.5 border border-red-500/40 rounded text-sm text-red-400 hover:bg-red-500/10 font-medium"
            >
              Delete History
            </button>
          </div>
          {purgeMsg && (
            <p className={`text-sm ${purgeMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>{purgeMsg.text}</p>
          )}
        </div>

        {/* Purge confirmation modal */}
        {showPurgeConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowPurgeConfirm(false); }}>
            <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary">Delete all recordings?</h3>
                  <p className="text-sm text-text-secondary mt-1">
                    This will permanently delete <strong className="text-text-primary">all recording files and their session records</strong> from disk.
                    This action <strong className="text-red-400">cannot be undone</strong>.
                  </p>
                  <p className="text-sm text-text-secondary mt-2">An entry will be written to the Audit Trail recording this deletion.</p>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handlePurge}
                  disabled={purging}
                  className="flex-1 py-2 px-4 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 font-medium text-sm"
                >
                  {purging ? 'Deleting…' : 'Yes, delete everything'}
                </button>
                <button
                  onClick={() => setShowPurgeConfirm(false)}
                  className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        </div>
      )}
    </div>
  );
}
