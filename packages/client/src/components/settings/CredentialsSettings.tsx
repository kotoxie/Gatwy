import { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { showToast } from '../../hooks/useToast';
import { fetchCredentials, type CredentialSummary } from '../../lib/credentials';
import { CredentialFormModal, type CredentialInUseInfo } from '../CredentialFormModal';

function KeyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function CredentialsSettings() {
  const { user } = useAuth();
  const canShare = !!user?.permissions.includes('credentials.share');

  const [creds, setCreds] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create / edit form (editing === null + formOpen → create)
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CredentialSummary | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<CredentialSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [inUse, setInUse] = useState<CredentialInUseInfo | null>(null);

  function load() {
    fetchCredentials()
      .then((c) => { setCreds(c); setError(''); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(c: CredentialSummary) {
    setEditing(c);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
  }

  function readInUse(data: { error?: string; connections?: { id: string; name: string }[]; otherCount?: number }, credName: string) {
    setInUse({
      name: credName,
      connections: data.connections ?? [],
      otherCount: data.otherCount ?? 0,
      message: data.error ?? 'Credential is in use',
    });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/credentials/${deleteTarget.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { readInUse(data, deleteTarget.name); setDeleteTarget(null); return; }
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      showToast('Credential deleted');
      setDeleteTarget(null);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <p className="text-text-secondary text-sm">Loading…</p>;
  if (error) return <p className="text-red-500 text-sm">{error}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Credential Library</h2>
          <p className="text-xs text-text-secondary mt-0.5">
            Save usernames with passwords or SSH keys once, then pick them when creating connections.
            Updating a credential updates every connection that uses it.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="px-3 py-1.5 bg-accent text-white rounded hover:bg-accent-hover text-sm font-medium shrink-0"
        >
          + New Credential
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 text-text-secondary font-medium">Name</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Type</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Username</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Visibility</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Used by</th>
              <th className="pb-2 text-text-secondary font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {creds.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-b-0">
                <td className="py-3 pr-4 text-text-primary font-medium">{c.name}</td>
                <td className="py-3 pr-4">
                  <span className="inline-flex items-center gap-1.5 text-text-secondary text-xs">
                    {c.type === 'key' ? <KeyGlyph /> : <LockGlyph />}
                    {c.type === 'key' ? `SSH key${c.hasPassphrase ? ' + passphrase' : ''}` : 'Password'}
                  </span>
                </td>
                <td className="py-3 pr-4 text-text-secondary font-mono text-xs">{c.username || '—'}</td>
                <td className="py-3 pr-4">
                  {c.shared ? (
                    <span className="px-2 py-0.5 rounded text-xs bg-accent/15 text-accent font-medium">
                      Shared{!c.isOwner && c.ownerUsername ? ` · ${c.ownerUsername}` : ''}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-xs bg-surface-hover text-text-secondary">Private</span>
                  )}
                </td>
                <td className="py-3 pr-4 text-text-secondary text-xs">
                  {c.usageCount === 0 ? '—' : `${c.usageCount} connection${c.usageCount !== 1 ? 's' : ''}`}
                </td>
                <td className="py-3">
                  {c.canEdit ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEdit(c)}
                        className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setDeleteTarget(c)}
                        className="px-2 py-1 text-xs border border-red-500/30 rounded text-red-400 hover:bg-red-500/10"
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <span className="text-text-secondary text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {creds.length === 0 && (
          <p className="text-text-secondary text-sm py-6 text-center">No saved credentials yet.</p>
        )}
      </div>

      {/* Create / Edit modal */}
      {formOpen && (
        <CredentialFormModal
          editing={editing}
          canShare={canShare}
          onClose={closeForm}
          onSaved={load}
          onConflict={setInUse}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-text-primary">Delete credential?</h3>
              <p className="text-sm text-text-secondary mt-1">
                Delete <strong className="text-text-primary">{deleteTarget.name}</strong>? This cannot be undone.
              </p>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={confirmDelete} disabled={deleting}
                className="flex-1 py-2 px-4 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 font-medium text-sm">
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Blocked because connections still depend on the credential */}
      {inUse && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setInUse(null); }}>
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-text-primary">“{inUse.name}” is in use</h3>
              <p className="text-sm text-text-secondary mt-1">
                {inUse.message}. Switch these connections to another credential first:
              </p>
            </div>
            <ul className="text-sm text-text-primary space-y-1 max-h-48 overflow-y-auto">
              {inUse.connections.map((c) => <li key={c.id}>• {c.name}</li>)}
              {inUse.otherCount > 0 && (
                <li className="text-text-secondary">
                  • {inUse.otherCount} connection{inUse.otherCount !== 1 ? 's' : ''} owned by other users
                </li>
              )}
            </ul>
            <button onClick={() => setInUse(null)}
              className="w-full py-2 px-4 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm">
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
