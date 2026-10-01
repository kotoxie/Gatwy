import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { showToast } from '../hooks/useToast';
import type { CredentialSummary, CredentialType } from '../lib/credentials';

const inputCls = 'w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm';

export interface CredentialInUseInfo {
  name: string;
  connections: { id: string; name: string }[];
  otherCount: number;
  message: string;
}

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

interface CredentialFormModalProps {
  /** Credential being edited, or null to create a new one. */
  editing: CredentialSummary | null;
  canShare: boolean;
  onClose: () => void;
  /** Called with the created/updated credential right before the modal closes. */
  onSaved: (cred: CredentialSummary) => void;
  /** Called instead of onSaved when a PUT is rejected because the credential is in use. */
  onConflict?: (info: CredentialInUseInfo) => void;
}

/** Create/edit form for a library credential — shared by Settings → Credentials and the connection picker's "+ New" action. */
export function CredentialFormModal({ editing, canShare, onClose, onSaved, onConflict }: CredentialFormModalProps) {
  const [name, setName] = useState(editing?.name ?? '');
  const [type, setType] = useState<CredentialType>(editing?.type ?? 'password');
  const [username, setUsername] = useState(editing?.username ?? '');
  const [domain, setDomain] = useState(editing?.domain ?? '');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [clearPassphrase, setClearPassphrase] = useState(false);
  const [shared, setShared] = useState(editing?.shared ?? false);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    // React re-bubbles portal events through the React tree (not the DOM tree), so without this
    // a caller rendering this modal from inside its own <form> (e.g. ConnectionModal) would also submit that form.
    e.stopPropagation();
    setFormError('');
    if (!editing && type === 'key' && !privateKey.trim()) { setFormError('Private key is required'); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name, username };
      if (!editing) body.type = type;
      if (type === 'password') body.domain = domain;
      if (type === 'password' && password) body.password = password;
      if (type === 'key') {
        if (privateKey.trim()) body.privateKey = privateKey;
        if (passphrase) body.passphrase = passphrase;
        else if (clearPassphrase) body.clearPassphrase = true;
      }
      if (canShare) body.shared = shared;

      const res = await fetch(editing ? `/api/v1/credentials/${editing.id}` : '/api/v1/credentials', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && editing) {
        onClose();
        onConflict?.({
          name: editing.name,
          connections: data.connections ?? [],
          otherCount: data.otherCount ?? 0,
          message: data.error ?? 'Credential is in use',
        });
        return;
      }
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      showToast(editing ? 'Credential updated' : 'Credential created');
      onSaved(data as CredentialSummary);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Rendered via portal so this form is never a DOM descendant of a caller's own <form> (e.g. ConnectionModal),
  // which would otherwise let its submit event bubble up and also trigger the outer form's submit handler.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">
            {editing ? `Edit Credential — ${editing.name}` : 'New Credential'}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-hover text-text-secondary hover:text-text-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Name</label>
            <input type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Homelab root key" className={inputCls} />
          </div>

          <div>
            <label className="block text-xs text-text-secondary mb-1">Type</label>
            <div className="flex gap-2">
              {(['password', 'key'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={!!editing}
                  onClick={() => setType(t)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border transition-colors disabled:cursor-not-allowed ${
                    type === t
                      ? 'border-accent bg-accent/10 text-accent font-medium'
                      : 'border-border text-text-secondary hover:bg-surface-hover disabled:opacity-40'
                  }`}
                >
                  {t === 'key' ? <KeyGlyph /> : <LockGlyph />}
                  {t === 'key' ? 'Username + SSH key' : 'Username + password'}
                </button>
              ))}
            </div>
            {type === 'key' && (
              <p className="text-[11px] text-text-secondary mt-1">
                SSH keys work with SSH and SFTP connections. OpenSSH, PEM and PKCS#8 keys (RSA, ECDSA, Ed25519) are accepted.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs text-text-secondary mb-1">Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
              placeholder="user" autoComplete="off" className={inputCls} />
          </div>

          {type === 'password' ? (
            <>
              <div>
                <label className="block text-xs text-text-secondary mb-1">Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder={editing?.hasPassword ? '(unchanged)' : ''} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  Domain <span className="font-normal">(optional)</span>
                </label>
                <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)}
                  placeholder="WORKGROUP" autoComplete="off" className={inputCls} />
                <p className="text-[11px] text-text-secondary mt-1">Used for SMB connections instead of retyping it per connection.</p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs text-text-secondary mb-1">Private Key</label>
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={5}
                  placeholder={editing ? '(unchanged — paste a new key to replace)' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                  className={`${inputCls} font-mono text-xs resize-none`}
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  Key Passphrase <span className="font-normal">(optional)</span>
                </label>
                <input type="password" value={passphrase}
                  onChange={(e) => { setPassphrase(e.target.value); if (e.target.value) setClearPassphrase(false); }}
                  autoComplete="new-password"
                  placeholder={editing?.hasPassphrase && !clearPassphrase ? '(unchanged)' : ''} className={inputCls} />
                {editing?.hasPassphrase && !passphrase && (
                  <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
                    <input type="checkbox" checked={clearPassphrase} onChange={(e) => setClearPassphrase(e.target.checked)} className="accent-accent" />
                    <span className="text-xs text-text-secondary">Remove stored passphrase</span>
                  </label>
                )}
              </div>
            </>
          )}

          {canShare && (
            <div className="flex items-start gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShared((v) => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                  shared ? 'bg-accent' : 'bg-surface-hover border border-border'
                }`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${shared ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
              <div>
                <span className="text-xs text-text-primary">Shared credential</span>
                <p className="text-[11px] text-text-secondary leading-tight mt-0.5">
                  Can be used by shared connections, and by users allowed to use shared credentials.
                  The secret is never shown, but anyone who can use it can connect with it.
                </p>
              </div>
            </div>
          )}

          {formError && <p className="text-red-500 text-xs">{formError}</p>}

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={saving}
              className="flex-1 py-2 px-4 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 font-medium text-sm">
              {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Credential'}
            </button>
            <button type="button" onClick={onClose}
              className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
