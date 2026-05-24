import { useEffect, useState, type FormEvent } from 'react';
import type React from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTimezone } from '../../hooks/useTimezone';
import { formatDate } from '../../utils/formatDate';

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-yellow-500',
  'bg-red-500', 'bg-pink-500', 'bg-indigo-500', 'bg-teal-500',
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function getAvatarColor(username: string) {
  return AVATAR_COLORS[hashStr(username) % AVATAR_COLORS.length];
}

function initials(displayName: string) {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

function MfaShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline-block">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  mfaEnabled: boolean;
  mfaMethod: string | null;
  passkeyCount: number;
}

export function UsersSettings() {
  const { user: currentUser } = useAuth();
  const timezone = useTimezone();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create user form
  const [showCreate, setShowCreate] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState('user');
  const [createMsg, setCreateMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);

  // Per-row messages
  const [rowMsgs, setRowMsgs] = useState<Record<string, { type: 'success' | 'error'; text: string }>>({});

  // Delete confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; username: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Edit user modal state
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('user');
  const [editMsg, setEditMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  function openEdit(u: UserRow) {
    setEditUser(u);
    setEditDisplayName(u.displayName);
    setEditEmail(u.email ?? '');
    setEditRole(u.role);
    setEditMsg(null);
  }

  function closeEdit() {
    setEditUser(null);
    setEditMsg(null);
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setSaving(true);
    setEditMsg(null);
    try {
      const res = await fetch(`/api/v1/users/${editUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          displayName: editDisplayName.trim(),
          email: editEmail.trim() || null,
          role: editRole,
        }),
      });
      const d = await res.json() as { error?: string };
      if (res.ok) {
        setUsers((prev) => prev.map((u) => u.id === editUser.id
          ? { ...u, displayName: editDisplayName.trim(), email: editEmail.trim() || null, role: editRole }
          : u));
        setEditMsg({ type: 'success', text: 'Saved.' });
        setTimeout(closeEdit, 900);
      } else {
        setEditMsg({ type: 'error', text: d.error || 'Failed to save.' });
      }
    } catch {
      setEditMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSaving(false);
    }
  }

  // Reset password state
  const [resetPasswordUserId, setResetPasswordUserId] = useState<string | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordMsg, setResetPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [resettingPassword, setResettingPassword] = useState(false);

  // Passkey reset state
  const [passkeyResetUserId, setPasskeyResetUserId] = useState<string | null>(null);
  const [passkeyResetReason, setPasskeyResetReason] = useState('');
  const [passkeyResetMsg, setPasskeyResetMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [resettingPasskeys, setResettingPasskeys] = useState(false);

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/users', { credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        setUsers(d.users);
      } else {
        setError('Failed to load users.');
      }
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadUsers(); }, []);

  // Load available roles for the role selector
  const [availableRoles, setAvailableRoles] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/v1/roles', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setAvailableRoles(d.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))); })
      .catch(() => {});
  }, []);

  function setRowMsg(id: string, msg: { type: 'success' | 'error'; text: string }) {
    setRowMsgs((prev) => ({ ...prev, [id]: msg }));
    setTimeout(() => setRowMsgs((prev) => { const n = { ...prev }; delete n[id]; return n; }), 3000);
  }

  async function handleRoleChange(userId: string, newRole: string) {
    const res = await fetch(`/api/v1/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role: newRole } : u));
      setRowMsg(userId, { type: 'success', text: 'Role updated.' });
    } else {
      const d = await res.json();
      setRowMsg(userId, { type: 'error', text: d.error || 'Failed.' });
    }
  }

  async function handleUnlock(userId: string) {
    const res = await fetch(`/api/v1/users/${userId}/unlock`, {
      method: 'POST',
      credentials: 'include',
    });
    if (res.ok) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, lockedUntil: null, failedLoginCount: 0 } : u));
      setRowMsg(userId, { type: 'success', text: 'User unlocked.' });
    } else {
      const d = await res.json();
      setRowMsg(userId, { type: 'error', text: d.error || 'Failed.' });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { id: userId } = deleteTarget;
    try {
      const res = await fetch(`/api/v1/users/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setUsers((prev) => prev.filter((u) => u.id !== userId));
        setDeleteTarget(null);
      } else {
        const d = await res.json();
        setRowMsg(userId, { type: 'error', text: d.error || 'Failed.' });
        setDeleteTarget(null);
      }
    } catch {
      setRowMsg(userId, { type: 'error', text: 'Network error.' });
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleResetPassword(userId: string) {
    if (!resetPasswordValue) return;
    setResettingPassword(true);
    setResetPasswordMsg(null);
    try {
      const res = await fetch(`/api/v1/users/${userId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newPassword: resetPasswordValue }),
      });
      const d = await res.json();
      if (res.ok) {
        setResetPasswordMsg({ type: 'success', text: 'Password reset.' });
        setTimeout(() => { setResetPasswordUserId(null); setResetPasswordValue(''); setResetPasswordMsg(null); }, 1500);
      } else {
        setResetPasswordMsg({ type: 'error', text: d.error || 'Failed.' });
      }
    } catch {
      setResetPasswordMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setResettingPassword(false);
    }
  }

  async function handleResetPasskeys(userId: string) {
    if (!passkeyResetReason || passkeyResetReason.trim().length < 5) {
      setPasskeyResetMsg({ type: 'error', text: 'Reason must be at least 5 characters.' });
      return;
    }
    setResettingPasskeys(true);
    setPasskeyResetMsg(null);
    try {
      const res = await fetch(`/api/v1/users/${userId}/passkeys/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason: passkeyResetReason.trim() }),
      });
      const d = await res.json() as { success?: boolean; passkeysDisabled?: number; error?: string };
      if (res.ok) {
        setPasskeyResetMsg({ type: 'success', text: `${d.passkeysDisabled || 0} passkey(s) disabled.` });
        setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, passkeyCount: 0, mfaMethod: null, mfaEnabled: false } : u));
        setTimeout(() => { setPasskeyResetUserId(null); setPasskeyResetReason(''); setPasskeyResetMsg(null); }, 1500);
      } else {
        setPasskeyResetMsg({ type: 'error', text: d.error || 'Failed.' });
      }
    } catch {
      setPasskeyResetMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setResettingPasskeys(false);
    }
  }

  async function handleCreateUser(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateMsg(null);
    try {
      const res = await fetch('/api/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: createUsername,
          password: createPassword,
          displayName: createDisplayName,
          email: createEmail || null,
          role: createRole,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        setUsers((prev) => [...prev, d]);
        setCreateMsg({ type: 'success', text: 'User created.' });
        setCreateUsername('');
        setCreateDisplayName('');
        setCreateEmail('');
        setCreatePassword('');
        setCreateRole('user');
        setShowCreate(false);
      } else {
        const d = await res.json();
        setCreateMsg({ type: 'error', text: d.error || 'Failed to create user.' });
      }
    } catch {
      setCreateMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <p className="text-text-secondary text-sm">Loading users...</p>;
  if (error) return <p className="text-red-500 text-sm">{error}</p>;

  function isLocked(u: UserRow) {
    return !!u.lockedUntil && new Date(u.lockedUntil) > new Date();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Users</h2>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="px-3 py-1.5 bg-accent text-white rounded hover:bg-accent-hover text-sm font-medium"
        >
          {showCreate ? 'Cancel' : '+ Create User'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreateUser} className="bg-surface-alt border border-border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">New User</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Username</label>
              <input type="text" required value={createUsername} onChange={(e) => setCreateUsername(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Display Name</label>
              <input type="text" required value={createDisplayName} onChange={(e) => setCreateDisplayName(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Email</label>
              <input type="email" value={createEmail} onChange={(e) => setCreateEmail(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Password</label>
              <input type="password" required value={createPassword} onChange={(e) => setCreatePassword(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Role</label>
              <select value={createRole} onChange={(e) => setCreateRole(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm">
                {availableRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>
          {createMsg && <p className={`text-sm ${createMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>{createMsg.text}</p>}
          <button type="submit" disabled={creating}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium">
            {creating ? 'Creating...' : 'Create User'}
          </button>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 text-text-secondary font-medium">User</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Email</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Role</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Status</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">MFA</th>
              <th className="pb-2 pr-4 text-text-secondary font-medium">Last Login</th>
              <th className="pb-2 text-text-secondary font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const locked = isLocked(u);
              const isSelf = u.id === currentUser?.id;
              const rowMsg = rowMsgs[u.id];
              return (
                <tr key={u.id} className="border-b border-border last:border-b-0">
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <div className={`w-7 h-7 rounded-full ${getAvatarColor(u.username)} flex items-center justify-center text-white text-xs font-bold shrink-0`}>
                        {initials(u.displayName)}
                      </div>
                      <div>
                        <div className="text-text-primary font-medium">{u.displayName}</div>
                        <div className="text-text-secondary text-xs">{u.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-text-secondary">{u.email ?? '—'}</td>
                  <td className="py-3 pr-4">
                    <select
                      value={u.role}
                      disabled={isSelf}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      className="px-2 py-1 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {availableRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </td>
                  <td className="py-3 pr-4">
                    {locked ? (
                      <span className="px-2 py-0.5 rounded text-xs bg-red-500/15 text-red-400 font-medium">Locked</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-xs bg-green-500/15 text-green-400 font-medium">Active</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {u.mfaEnabled ? (
                      <span className="flex items-center gap-1 text-green-400 text-xs font-medium">
                        <MfaShieldIcon /> {u.mfaMethod === 'passkey' ? `Passkey (${u.passkeyCount})` : 'TOTP'}
                      </span>
                    ) : (
                      <span className="text-text-secondary text-xs">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-text-secondary text-xs">{formatDate(u.lastLoginAt, timezone)}</td>
                  <td className="py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {rowMsg && (
                        <span className={`text-xs ${rowMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                          {rowMsg.text}
                        </span>
                      )}
                      {locked && (
                        <button
                          onClick={() => handleUnlock(u.id)}
                          className="px-2 py-1 text-xs bg-surface-hover border border-border rounded hover:bg-surface text-text-primary"
                        >
                          Unlock
                        </button>
                      )}
                      {resetPasswordUserId === u.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="password"
                            value={resetPasswordValue}
                            onChange={(e) => setResetPasswordValue(e.target.value)}
                            placeholder="New password"
                            className="px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-28"
                            autoFocus
                          />
                          <button
                            onClick={() => handleResetPassword(u.id)}
                            disabled={resettingPassword || !resetPasswordValue}
                            className="px-2 py-1 text-xs bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50"
                          >
                            {resettingPassword ? '...' : '✓'}
                          </button>
                          <button
                            onClick={() => { setResetPasswordUserId(null); setResetPasswordValue(''); setResetPasswordMsg(null); }}
                            className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
                          >
                            ✕
                          </button>
                          {resetPasswordMsg && (
                            <span className={`text-xs ${resetPasswordMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                              {resetPasswordMsg.text}
                            </span>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => { setResetPasswordUserId(u.id); setResetPasswordValue(''); }}
                          className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
                        >
                          Reset Password
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(u)}
                        className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover flex items-center gap-1"
                        title="Edit user"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        Edit
                      </button>
                      {u.passkeyCount > 0 && passkeyResetUserId !== u.id && (
                        <button
                          onClick={() => { setPasskeyResetUserId(u.id); setPasskeyResetReason(''); setPasskeyResetMsg(null); }}
                          className="px-2 py-1 text-xs border border-yellow-500/30 rounded text-yellow-400 hover:bg-yellow-500/10"
                          title="Reset passkeys"
                        >
                          Reset Passkeys
                        </button>
                      )}
                      {passkeyResetUserId === u.id && (
                        <div className="flex items-center gap-1 flex-wrap">
                          <input
                            type="text"
                            value={passkeyResetReason}
                            onChange={(e) => setPasskeyResetReason(e.target.value)}
                            placeholder="Reason (min 5 chars)"
                            className="px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-36"
                            autoFocus
                          />
                          <button
                            onClick={() => handleResetPasskeys(u.id)}
                            disabled={resettingPasskeys || passkeyResetReason.trim().length < 5}
                            className="px-2 py-1 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600 disabled:opacity-50"
                          >
                            {resettingPasskeys ? '...' : '✓'}
                          </button>
                          <button
                            onClick={() => { setPasskeyResetUserId(null); setPasskeyResetReason(''); setPasskeyResetMsg(null); }}
                            className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
                          >
                            ✕
                          </button>
                          {passkeyResetMsg && (
                            <span className={`text-xs ${passkeyResetMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                              {passkeyResetMsg.text}
                            </span>
                          )}
                        </div>
                      )}
                      <button
                        onClick={() => setDeleteTarget({ id: u.id, username: u.username })}
                        disabled={isSelf}
                        className="px-2 py-1 text-xs border border-red-500/30 rounded text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {users.length === 0 && <p className="text-text-secondary text-sm py-4 text-center">No users found.</p>}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </div>
              <div>
                <h3 className="text-base font-semibold text-text-primary">Delete user?</h3>
                <p className="text-sm text-text-secondary mt-1">
                  Are you sure you want to delete <strong className="text-text-primary">{deleteTarget.username}</strong>?
                  This action <strong className="text-red-400">cannot be undone</strong> and will remove all data associated with this user.
                </p>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 py-2 px-4 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 font-medium text-sm"
              >
                {deleting ? 'Deleting…' : 'Yes, delete user'}
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) closeEdit(); }}>
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-text-primary">Edit User — {editUser.username}</h3>
              <button onClick={closeEdit} className="p-1 rounded hover:bg-surface-hover text-text-secondary hover:text-text-primary">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleEditSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Display Name</label>
                <input
                  type="text"
                  required
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Email</label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Role</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  disabled={editUser.id === currentUser?.id}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {availableRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                {editUser.id === currentUser?.id && (
                  <p className="text-xs text-text-secondary mt-1">You cannot change your own role.</p>
                )}
              </div>

              {editMsg && (
                <p className={`text-sm ${editMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                  {editMsg.text}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-2 px-4 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 font-medium text-sm"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={closeEdit}
                  className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
