import { useEffect, useState, type FormEvent } from 'react';
import { showToast } from '../../hooks/useToast';
import { invalidateGeneralPrefs } from '../../hooks/useGeneralPrefs';

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

export function GeneralSettings() {
  const [commandPaletteShortcut, setCommandPaletteShortcut] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/v1/profile/general-prefs', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { commandPaletteShortcut?: boolean }) => {
        setCommandPaletteShortcut(d.commandPaletteShortcut !== false);
      })
      .catch(() => {});
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/v1/profile/general-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ commandPaletteShortcut }),
      });
      if (res.ok) {
        invalidateGeneralPrefs();
        showToast('Saved.', 'success');
      } else {
        const d = await res.json() as { error?: string };
        showToast(d.error || 'Failed to save.', 'error');
      }
    } catch {
      showToast('Network error.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4 max-w-lg">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">Keyboard Shortcuts</h3>
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="text-sm text-text-primary">Command palette (Ctrl/Cmd+K)</div>
            <div className="text-xs text-text-secondary">Opens the quick-connect palette from anywhere in the app.</div>
          </div>
          <Toggle value={commandPaletteShortcut} onChange={setCommandPaletteShortcut} />
        </div>
      </section>

      <button
        type="submit"
        disabled={saving}
        className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </form>
  );
}
