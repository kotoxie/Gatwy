import { useEffect, useState, type FormEvent } from 'react';
import { useSettings, invalidateSettings } from '../../hooks/useSettings';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

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

export function RecordingSettings() {
  const { settings, refresh } = useSettings();

  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [recordingRetention, setRecordingRetention] = useState('90');
  const [retentionDaysEnabled, setRetentionDaysEnabled] = useState(true);
  const [retentionSizeEnabled, setRetentionSizeEnabled] = useState(false);
  const [retentionMaxSizeGb, setRetentionMaxSizeGb] = useState('10');
  const [recordingMsg, setRecordingMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingRecording, setSavingRecording] = useState(false);

  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [storageBytes, setStorageBytes] = useState<number | null>(null);

  useEffect(() => {
    setRecordingEnabled(settings['session.recording_enabled'] === 'true');
    setRecordingRetention(settings['session.recording_retention_days'] ?? '90');
    setRetentionDaysEnabled(settings['session.recording_retention_days_enabled'] !== 'false');
    setRetentionSizeEnabled(settings['session.recording_retention_size_enabled'] === 'true');
    setRetentionMaxSizeGb(settings['session.recording_retention_max_size_gb'] ?? '10');
  }, [settings]);

  useEffect(() => {
    fetch('/api/v1/sessions/storage', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { bytes: number } | null) => {
        if (d) setStorageBytes(d.bytes);
      })
      .catch(() => {});
  }, []);

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
    const d = (await res.json()) as { error?: string };
    return { ok: false, error: d.error || 'Failed to save.' };
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

  async function handlePurge() {
    setPurging(true);
    setPurgeMsg(null);
    try {
      const res = await fetch('/api/v1/sessions', {
        method: 'DELETE',
        credentials: 'include',
      });
      const d = (await res.json()) as {
        ok?: boolean;
        deletedSessions?: number;
        deletedRecordings?: number;
        deletedFileSessions?: number;
        error?: string;
      };
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

  return (
    <div className="space-y-6 max-w-lg">
      <form onSubmit={handleRecordingSave} className="space-y-4">
        <div className="flex items-center gap-3">
          <Toggle value={recordingEnabled} onChange={setRecordingEnabled} />
          <span className="text-sm text-text-secondary">Session recording enabled <span className="text-xs text-text-secondary/60">(SSH &amp; RDP)</span></span>
        </div>

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
            Both retention policies are active, whichever limit is reached first will trigger cleanup (FIFO).
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

      {storageBytes !== null && (
        <div className="border border-border rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-primary">Recording Storage</h3>
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

      <div className="mt-8 border border-red-500/20 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-red-400">Danger Zone</h3>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-text-primary">Delete all recordings</p>
            <p className="text-xs text-text-secondary mt-0.5">Permanently deletes all recording files and their session records from disk.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowPurgeConfirm(true);
              setPurgeMsg(null);
            }}
            className="shrink-0 px-3 py-1.5 border border-red-500/40 rounded text-sm text-red-400 hover:bg-red-500/10 font-medium"
          >
            Delete History
          </button>
        </div>
        {purgeMsg && (
          <p className={`text-sm ${purgeMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>{purgeMsg.text}</p>
        )}
      </div>

      {showPurgeConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowPurgeConfirm(false);
          }}
        >
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-base font-semibold text-text-primary">Delete all recordings?</h3>
            <p className="text-sm text-text-secondary">
              This will permanently delete all recording files and their session records from disk.
              This action cannot be undone.
            </p>
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
  );
}
