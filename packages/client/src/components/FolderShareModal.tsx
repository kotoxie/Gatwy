import { useEffect, useState } from 'react';

interface FolderShareModalProps {
  groupId: string;
  groupName: string;
  onClose: () => void;
  onSaved: () => void;
}

type Capability = 'view' | 'edit';

function CapabilityToggle({ value, onChange }: { value: Capability; onChange: (v: Capability) => void }) {
  return (
    <div className="flex rounded border border-border overflow-hidden shrink-0 text-[10px] font-medium">
      {(['view', 'edit'] as const).map((cap) => (
        <button
          key={cap}
          type="button"
          onClick={() => onChange(cap)}
          className={`px-2 py-0.5 capitalize transition-colors ${
            value === cap ? 'bg-accent text-white' : 'bg-surface text-text-secondary hover:bg-surface-hover'
          }`}
        >
          {cap === 'edit' ? 'Editor' : 'Viewer'}
        </button>
      ))}
    </div>
  );
}

export function FolderShareModal({ groupId, groupName, onClose, onSaved }: FolderShareModalProps) {
  const [shareRoles, setShareRoles] = useState<{ id: string; name: string }[]>([]);
  const [shareUsers, setShareUsers] = useState<{ id: string; username: string }[]>([]);
  // Presence of a key = shared with that role/user; the value is their capability.
  const [roleCapabilities, setRoleCapabilities] = useState<Record<string, Capability>>({});
  const [userCapabilities, setUserCapabilities] = useState<Record<string, Capability>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<{ connectionId: string; connectionName: string }[] | null>(null);

  useEffect(() => {
    fetch('/api/v1/roles', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setShareRoles(d.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))); })
      .catch(() => {});
    fetch('/api/v1/users', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d?.users && Array.isArray(d.users)) setShareUsers(d.users.map((u: { id: string; username: string }) => ({ id: u.id, username: u.username }))); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/v1/connections/groups/${groupId}/shares`, { credentials: 'include' })
      .then(r => r.json())
      .then((d: { shares: { shareType: string; targetId: string; capability?: string }[]; warnings: { connectionId: string; connectionName: string }[] }) => {
        if (!Array.isArray(d.shares)) return;
        const roles: Record<string, Capability> = {};
        const users: Record<string, Capability> = {};
        for (const s of d.shares) {
          const cap: Capability = s.capability === 'edit' ? 'edit' : 'view';
          if (s.shareType === 'role') roles[s.targetId] = cap;
          else if (s.shareType === 'user') users[s.targetId] = cap;
        }
        setRoleCapabilities(roles);
        setUserCapabilities(users);
        if (Array.isArray(d.warnings) && d.warnings.length > 0) setWarnings(d.warnings);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [groupId]);

  function toggleShare(kind: 'role' | 'user', id: string) {
    const setCaps = kind === 'role' ? setRoleCapabilities : setUserCapabilities;
    setCaps((prev) => {
      const next = { ...prev };
      if (id in next) delete next[id]; else next[id] = 'view';
      return next;
    });
  }

  function setCapability(kind: 'role' | 'user', id: string, capability: Capability) {
    const setCaps = kind === 'role' ? setRoleCapabilities : setUserCapabilities;
    setCaps((prev) => ({ ...prev, [id]: capability }));
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const shares = [
        ...Object.entries(roleCapabilities).map(([id, capability]) => ({ shareType: 'role', targetId: id, capability })),
        ...Object.entries(userCapabilities).map(([id, capability]) => ({ shareType: 'user', targetId: id, capability })),
      ];
      const res = await fetch(`/api/v1/connections/groups/${groupId}/shares`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ shares }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'Failed to save');
        setSaving(false);
        return;
      }
      // Warnings (private-credential connections) were already shown proactively
      // before the user ever clicked Save, so there's nothing left to hold the modal
      // open for — a successful save always closes it like any other save action.
      onSaved();
    } catch {
      setError('Failed to save');
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b border-border">
          <h2 className="text-base font-bold text-text-primary">Share "{groupName}"</h2>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <aside className="hidden sm:block w-52 shrink-0 border-r border-border bg-surface px-4 py-4 overflow-y-auto space-y-4">
            <div>
              <p className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide mb-1">What's included</p>
              <p className="text-[11px] text-text-primary leading-snug">
                Sub-folders, connections, and their stored credentials.
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide mb-1">Viewer</p>
              <p className="text-[11px] text-text-primary leading-snug">Can connect and view contents.</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide mb-1">Editor</p>
              <p className="text-[11px] text-text-primary leading-snug">
                Can also add, edit, and delete items inside — never this folder itself or its sharing.
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide mb-1">Exception</p>
              <p className="text-[11px] text-text-primary leading-snug">
                Private Credential Library entries stay hidden unless shared separately.
              </p>
            </div>
          </aside>

          <div className="flex-1 min-w-0 overflow-y-auto px-5 py-4 space-y-3">
            {loading ? (
              <p className="text-xs text-text-secondary">Loading…</p>
            ) : (
              <>
                <div>
                  <label className="block text-[10px] font-medium text-text-secondary mb-1">Share with roles</label>
                  <div className="space-y-1">
                    {shareRoles.map(r => (
                      <div key={r.id} className="flex items-center gap-2">
                        <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                          <input
                            type="checkbox"
                            checked={r.id in roleCapabilities}
                            onChange={() => toggleShare('role', r.id)}
                            className="accent-accent"
                          />
                          <span className="text-xs text-text-primary truncate">{r.name}</span>
                        </label>
                        {r.id in roleCapabilities && (
                          <CapabilityToggle value={roleCapabilities[r.id]} onChange={(cap) => setCapability('role', r.id, cap)} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-medium text-text-secondary mb-1">Share with users</label>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {shareUsers.map(u => (
                      <div key={u.id} className="flex items-center gap-2">
                        <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                          <input
                            type="checkbox"
                            checked={u.id in userCapabilities}
                            onChange={() => toggleShare('user', u.id)}
                            className="accent-accent"
                          />
                          <span className="text-xs text-text-primary truncate">{u.username}</span>
                        </label>
                        {u.id in userCapabilities && (
                          <CapabilityToggle value={userCapabilities[u.id]} onChange={(cap) => setCapability('user', u.id, cap)} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {warnings && warnings.length > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                  {warnings.length} connection{warnings.length === 1 ? '' : 's'} won't work for recipients:
                </p>
                <ul className="mt-1 text-xs text-text-secondary list-disc list-inside">
                  {warnings.map(w => <li key={w.connectionId}>{w.connectionName}</li>)}
                </ul>
                <p className="mt-1 text-[11px] text-text-secondary">
                  They use a private credential from your Credential Library — mark it as shared, or recipients will see no credentials at all.
                </p>
              </div>
            )}

            {error && <p className="text-red-500 text-xs">{error}</p>}
          </div>
        </div>

        <div className="flex gap-2 px-5 pb-4 pt-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-1.5 text-sm border border-border rounded text-text-secondary hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="flex-1 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 font-medium"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
