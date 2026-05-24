import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTimezone } from '../../hooks/useTimezone';
import { formatDate } from '../../utils/formatDate';
import { startRegistration } from '@simplewebauthn/browser';

const AVATAR_COLORS = [
  'bg-blue-500',
  'bg-purple-500',
  'bg-green-500',
  'bg-yellow-500',
  'bg-red-500',
  'bg-pink-500',
  'bg-indigo-500',
  'bg-teal-500',
];

function hashUsername(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) {
    h = (h * 31 + username.charCodeAt(i)) >>> 0;
  }
  return h;
}

function getAvatarColor(username: string): string {
  return AVATAR_COLORS[hashUsername(username) % AVATAR_COLORS.length];
}

function autoInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr.replace(' ', 'T') + 'Z');
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface MfaSetupData {
  secret: string;
  qrDataUrl: string;
}

interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  disabled: boolean;
  disabledReason: string | null;
}

function getBrowserIcon(browser: string) {
  const isMobile = browser === 'iOS' || browser === 'Android';
  if (isMobile) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </svg>
    );
  }
  // Default: monitor/desktop icon
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

interface ProfileData {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarText: string | null;
  role: string;
}

interface LoginSession {
  id: string;
  browser: string;
  os: string;
  ipAddress: string;
  createdAt: string;
  lastUsedAt: string;
  isCurrent: boolean;
}

export function ProfileSettings() {
  const { user } = useAuth();
  const timezone = useTimezone();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [avatarText, setAvatarText] = useState('');
  const [profileMsg, setProfileMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [showPwForm, setShowPwForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  const [sessions, setSessions] = useState<LoginSession[]>([]);

  // MFA state
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaMethod, setMfaMethod] = useState<'totp' | 'passkey' | null>(null);
  const [mfaSetupData, setMfaSetupData] = useState<MfaSetupData | null>(null);
  const [mfaVerifyCode, setMfaVerifyCode] = useState('');
  const [mfaDisableCode, setMfaDisableCode] = useState('');
  const [showMfaDisable, setShowMfaDisable] = useState(false);
  const [mfaMsg, setMfaMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mfaLoading, setMfaLoading] = useState(false);

  // Passkey state
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeyCanAdd, setPasskeyCanAdd] = useState(true);
  const [passkeyMaxCount, setPasskeyMaxCount] = useState(3);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showPasskeyRegister, setShowPasskeyRegister] = useState(false);
  const [newPasskeyName, setNewPasskeyName] = useState('');
  const [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null);
  const [editingPasskeyName, setEditingPasskeyName] = useState('');
  const [passkeyEnabled, setPasskeyEnabled] = useState(true);
  const [pendingPasskeyRemoval, setPendingPasskeyRemoval] = useState<{ id: string; name: string } | null>(null);

  async function loadSessions() {
    try {
      const res = await fetch('/api/v1/profile/login-sessions', {
        credentials: 'include',
      });
      if (res.ok) {
        const d = await res.json() as { sessions: LoginSession[] };
        setSessions(d.sessions);
      }
    } catch {
      // ignore
    }
  }

  async function loadMfaStatus() {
    try {
      const res = await fetch('/api/v1/profile/mfa/method', { credentials: 'include' });
      if (!res.ok) return;
      const d = await res.json() as { enabled: boolean; method: 'totp' | 'passkey' | null };
      setMfaEnabled(d.enabled);
      setMfaMethod(d.method);
    } catch {
      // ignore
    }
  }

  async function loadPasskeys() {
    try {
      const res = await fetch('/api/v1/profile/passkeys', {
        credentials: 'include',
      });
      if (res.ok) {
        const d = await res.json() as { passkeys: Passkey[]; canAdd: boolean; maxPasskeys: number };
        setPasskeys(d.passkeys);
        setPasskeyCanAdd(d.canAdd);
        setPasskeyMaxCount(d.maxPasskeys);
        setPasskeyEnabled(true);
      } else {
        const data = await res.json() as { error?: string };
        if (data.error === 'Passkeys are not enabled') {
          setPasskeyEnabled(false);
        }
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetch('/api/v1/profile', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: ProfileData) => {
        setProfile(d);
        setDisplayName(d.displayName ?? '');
        setEmail(d.email ?? '');
        setAvatarText(d.avatarText ?? '');
      })
      .catch(() => {});
    loadSessions();
    loadPasskeys();
    loadMfaStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const username = profile?.username ?? user?.username ?? '';
  const initials = avatarText || autoInitials(displayName || username);
  const avatarColor = getAvatarColor(username);

  async function handleProfileSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setProfileMsg(null);
    try {
      const res = await fetch('/api/v1/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ displayName, email: email || null, avatarText: avatarText || null }),
      });
      if (res.ok) {
        setProfileMsg({ type: 'success', text: 'Profile updated successfully.' });
      } else {
        const d = await res.json();
        setProfileMsg({ type: 'error', text: d.error || 'Failed to update profile.' });
      }
    } catch {
      setProfileMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSaving(false);
    }
  }

  async function handlePasswordSave(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwMsg({ type: 'error', text: 'Passwords do not match.' });
      return;
    }
    if (newPassword.length < 8) {
      setPwMsg({ type: 'error', text: 'New password must be at least 8 characters.' });
      return;
    }
    setSavingPw(true);
    setPwMsg(null);
    try {
      const res = await fetch('/api/v1/profile/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        setPwMsg({ type: 'success', text: 'Password changed successfully.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        // Auto-close the form after a short delay so the user sees the success message
        setTimeout(() => { setShowPwForm(false); setPwMsg(null); }, 1500);
      } else {
        const d = await res.json();
        setPwMsg({ type: 'error', text: d.error || 'Failed to change password.' });
      }
    } catch {
      setPwMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingPw(false);
    }
  }

  async function handleRevoke(id: string) {
    try {
      await fetch(`/api/v1/profile/login-sessions/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await loadSessions();
    } catch {
      // ignore
    }
  }

  async function handleMfaSetup() {
    setMfaLoading(true);
    setMfaMsg(null);
    try {
      const res = await fetch('/api/v1/profile/mfa/setup', {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        const d = await res.json() as MfaSetupData;
        setMfaSetupData(d);
        setMfaVerifyCode('');
      } else {
        const d = await res.json() as { error?: string };
        setMfaMsg({ type: 'error', text: d.error || 'Failed to start MFA setup.' });
      }
    } catch {
      setMfaMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleMfaVerify(e: FormEvent) {
    e.preventDefault();
    setMfaLoading(true);
    setMfaMsg(null);
    try {
      const res = await fetch('/api/v1/profile/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: mfaVerifyCode }),
      });
      if (res.ok) {
        setMfaEnabled(true);
        setMfaMethod('totp');
        setMfaSetupData(null);
        setMfaVerifyCode('');
        setMfaMsg({ type: 'success', text: 'Two-factor authentication enabled.' });
      } else {
        const d = await res.json() as { error?: string };
        setMfaMsg({ type: 'error', text: d.error || 'Invalid code.' });
      }
    } catch {
      setMfaMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleMfaDisable(e: FormEvent) {
    e.preventDefault();
    setMfaLoading(true);
    setMfaMsg(null);
    try {
      const res = await fetch('/api/v1/profile/mfa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: mfaDisableCode }),
      });
      if (res.ok) {
        setMfaEnabled(false);
        setMfaMethod(null);
        setShowMfaDisable(false);
        setMfaDisableCode('');
        setMfaMsg({ type: 'success', text: 'Two-factor authentication disabled.' });
      } else {
        const d = await res.json() as { error?: string };
        setMfaMsg({ type: 'error', text: d.error || 'Invalid code.' });
      }
    } catch {
      setMfaMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleRevokeAll() {
    try {
      await fetch('/api/v1/profile/login-sessions', {
        method: 'DELETE',
        credentials: 'include',
      });
      await loadSessions();
    } catch {
      // ignore
    }
  }

  async function handlePasskeyRegister(e: FormEvent) {
    e.preventDefault();
    if (!newPasskeyName.trim()) {
      setPasskeyMsg({ type: 'error', text: 'Please enter a name for your passkey.' });
      return;
    }
    setPasskeyLoading(true);
    setPasskeyMsg(null);

    try {
      // Get registration options from server
      const optionsRes = await fetch('/api/v1/profile/passkeys/register/options', {
        method: 'POST',
        credentials: 'include',
      });
      if (!optionsRes.ok) {
        const data = await optionsRes.json() as { error?: string };
        throw new Error(data.error || 'Failed to get registration options');
      }
      const { options, challengeId } = await optionsRes.json() as { options: unknown; challengeId: string };

      // Trigger browser's passkey registration
      const regResponse = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'] });

      // Verify with server
      const verifyRes = await fetch('/api/v1/profile/passkeys/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          challengeId,
          response: regResponse,
          name: newPasskeyName.trim(),
        }),
      });
      if (!verifyRes.ok) {
        const data = await verifyRes.json() as { error?: string };
        throw new Error(data.error || 'Failed to register passkey');
      }

      setPasskeyMsg({ type: 'success', text: 'Passkey registered successfully!' });
      setShowPasskeyRegister(false);
      setNewPasskeyName('');
      await loadPasskeys();
      await loadMfaStatus();
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          setPasskeyMsg({ type: 'error', text: 'Passkey registration was cancelled.' });
        } else {
          setPasskeyMsg({ type: 'error', text: err.message });
        }
      } else {
        setPasskeyMsg({ type: 'error', text: 'Failed to register passkey.' });
      }
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function handlePasskeyRename(id: string) {
    if (!editingPasskeyName.trim()) return;
    setPasskeyLoading(true);
    setPasskeyMsg(null);

    try {
      const res = await fetch(`/api/v1/profile/passkeys/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: editingPasskeyName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || 'Failed to rename passkey');
      }
      setEditingPasskeyId(null);
      setEditingPasskeyName('');
      await loadPasskeys();
    } catch (err: unknown) {
      setPasskeyMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to rename passkey' });
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function handlePasskeyRemove(id: string) {
    setPasskeyLoading(true);
    setPasskeyMsg(null);

    try {
      const res = await fetch(`/api/v1/profile/passkeys/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || 'Failed to remove passkey');
      }
      setPasskeyMsg({ type: 'success', text: 'Passkey removed.' });
      setPendingPasskeyRemoval(null);
      await loadPasskeys();
      await loadMfaStatus();
    } catch (err: unknown) {
      setPasskeyMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to remove passkey' });
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <div className="max-w-lg space-y-8">
      {/* Profile form */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-4">Profile</h2>
        <form onSubmit={handleProfileSave} className="space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className={`w-16 h-16 rounded-full ${avatarColor} flex items-center justify-center text-white text-xl font-bold select-none shrink-0`}>
              {initials}
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Avatar initials <span className="font-normal text-text-secondary">(1-3 characters)</span>
              </label>
              <input
                type="text"
                value={avatarText}
                onChange={(e) => setAvatarText(e.target.value.slice(0, 3).toUpperCase())}
                maxLength={3}
                placeholder={autoInitials(displayName || username)}
                className="w-32 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
              <p className="text-xs text-text-secondary mt-1">Leave empty to auto-generate from display name.</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Username</label>
            <input
              type="text"
              value={username}
              disabled
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text-secondary opacity-60 cursor-not-allowed text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>

          {profileMsg && (
            <p className={`text-sm ${profileMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {profileMsg.text}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {saving ? 'Saving...' : 'Save Profile'}
          </button>
        </form>
      </section>

      <hr className="border-border" />

      {/* Change Password */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Change Password</h2>
            {!showPwForm && (
              <p className="text-sm text-text-secondary mt-0.5">Update your account password.</p>
            )}
          </div>
          {!showPwForm && (
            <button
              type="button"
              onClick={() => { setShowPwForm(true); setPwMsg(null); }}
              className="px-4 py-2 bg-surface-hover border border-border rounded text-sm text-text-primary hover:bg-surface font-medium"
            >
              Change Password
            </button>
          )}
        </div>

        {showPwForm && (
          <form onSubmit={handlePasswordSave} className="space-y-4 mt-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoFocus
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Confirm New Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
            </div>

            {pwMsg && (
              <p className={`text-sm ${pwMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                {pwMsg.text}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={savingPw}
                className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
              >
                {savingPw ? 'Saving...' : 'Save Password'}
              </button>
              <button
                type="button"
                onClick={() => { setShowPwForm(false); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPwMsg(null); }}
                className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <hr className="border-border" />

      {/* Active Sessions */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-text-primary">Active Sessions</h2>
          {sessions.filter((s) => !s.isCurrent).length > 0 && (
            <button
              onClick={handleRevokeAll}
              className="text-xs px-3 py-1.5 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
            >
              Sign out all other sessions
            </button>
          )}
        </div>

        <div className="space-y-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center gap-3 p-3 rounded-lg border ${
                session.isCurrent ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface'
              }`}
            >
              {/* Browser/OS icon */}
              <div className="shrink-0 text-text-secondary">
                {getBrowserIcon(session.os)}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {session.browser} on {session.os}
                  </span>
                  {session.isCurrent && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent/20 text-accent font-medium">
                      Current
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-text-secondary font-mono">{session.ipAddress}</span>
                  <span className="text-xs text-text-secondary">·</span>
                  <span className="text-xs text-text-secondary">Last active {relativeTime(session.lastUsedAt)} · {formatDate(session.lastUsedAt, timezone)}</span>
                </div>
              </div>

              {/* Sign out button */}
              {!session.isCurrent && (
                <button
                  onClick={() => handleRevoke(session.id)}
                  className="shrink-0 text-xs px-2.5 py-1 rounded border border-border text-text-secondary hover:text-red-400 hover:border-red-400/40 transition-colors"
                >
                  Sign out
                </button>
              )}
            </div>
          ))}

          {sessions.length === 0 && (
            <p className="text-sm text-text-secondary italic">No active sessions found.</p>
          )}
        </div>
      </section>

      <hr className="border-border" />

      {/* Two-Factor Authentication */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-4">Two-Factor Authentication</h2>

        {mfaMsg && (
          <p className={`text-sm mb-3 ${mfaMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
            {mfaMsg.text}
          </p>
        )}

        {mfaEnabled ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full text-xs bg-green-500/15 text-green-400 font-medium">
                {mfaMethod === 'passkey'
                  ? 'Passkey-based two-factor authentication is enabled'
                  : 'Two-factor authentication is enabled'}
              </span>
            </div>
            {mfaMethod === 'passkey' ? (
              <p className="text-sm text-text-secondary">
                This account uses passkeys for MFA. Manage or remove passkeys in the section below.
              </p>
            ) : (
              <>
                {!showMfaDisable ? (
                  <button
                    onClick={() => { setShowMfaDisable(true); setMfaMsg(null); }}
                    className="px-4 py-2 border border-red-500/40 text-red-400 rounded hover:bg-red-500/10 text-sm font-medium"
                  >
                    Disable Two-Factor Authentication
                  </button>
                ) : (
                  <form onSubmit={handleMfaDisable} className="space-y-3">
                    <p className="text-sm text-text-secondary">Enter your account password to disable MFA:</p>
                    <input
                      type="password"
                      value={mfaDisableCode}
                      onChange={(e) => setMfaDisableCode(e.target.value)}
                      placeholder="Your password"
                      autoFocus
                      className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={mfaLoading || mfaDisableCode.length < 1}
                        className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 text-sm font-medium"
                      >
                        {mfaLoading ? 'Disabling...' : 'Confirm Disable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowMfaDisable(false); setMfaDisableCode(''); }}
                        className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              Add an extra layer of security using a time-based one-time password (TOTP) app like Google Authenticator or Authy.
            </p>
            {!mfaSetupData ? (
              <button
                onClick={handleMfaSetup}
                disabled={mfaLoading}
                className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
              >
                {mfaLoading ? 'Loading...' : 'Enable Two-Factor Authentication'}
              </button>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-text-primary mb-2">1. Scan this QR code with your authenticator app:</p>
                  <img src={mfaSetupData.qrDataUrl} alt="MFA QR Code" className="rounded border border-border" style={{ width: 200, height: 200 }} />
                </div>
                <div>
                  <p className="text-sm text-text-secondary mb-1">Or enter this key manually:</p>
                  <code className="text-xs bg-surface border border-border rounded px-2 py-1 font-mono text-text-primary break-all">
                    {mfaSetupData.secret}
                  </code>
                </div>
                <form onSubmit={handleMfaVerify} className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-text-primary mb-2">2. Enter the 6-digit code to verify:</p>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={mfaVerifyCode}
                      onChange={(e) => setMfaVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      autoFocus
                      className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm text-center tracking-widest"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={mfaLoading || mfaVerifyCode.length < 6}
                      className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
                    >
                      {mfaLoading ? 'Verifying...' : 'Verify & Enable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMfaSetupData(null); setMfaVerifyCode(''); setMfaMsg(null); }}
                      className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
      </section>

      {passkeyEnabled && (
        <>
          <hr className="border-border" />

          {/* Passkeys */}
          <section>
            <h2 className="text-base font-semibold text-text-primary mb-4">Passkeys</h2>
            <p className="text-sm text-text-secondary mb-4">
              Use passkeys (like Face ID, Touch ID, or Windows Hello) for passwordless two-factor authentication.
              {passkeyMaxCount > 0 && ` You can register up to ${passkeyMaxCount} passkeys.`}
            </p>

            {passkeyMsg && (
              <p className={`text-sm mb-3 ${passkeyMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                {passkeyMsg.text}
              </p>
            )}

            {pendingPasskeyRemoval && (
              <div className="mb-4 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
                <p className="text-sm text-text-primary mb-3">
                  Are you sure you want to remove <span className="font-medium">{pendingPasskeyRemoval.name}</span>? This cannot be undone.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handlePasskeyRemove(pendingPasskeyRemoval.id)}
                    disabled={passkeyLoading}
                    className="px-3 py-1.5 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 text-xs font-medium"
                  >
                    {passkeyLoading ? 'Removing...' : 'Yes, remove passkey'}
                  </button>
                  <button
                    onClick={() => setPendingPasskeyRemoval(null)}
                    disabled={passkeyLoading}
                    className="px-3 py-1.5 border border-border rounded text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Passkey list */}
            <div className="space-y-2 mb-4">
              {passkeys.map((pk) => (
                <div
                  key={pk.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${pk.disabled ? 'border-red-500/40 bg-red-500/5' : 'border-border bg-surface'}`}
                >
                  {/* Icon */}
                  <div className="shrink-0 text-text-secondary">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M15 7a3 3 0 11-6 0 3 3 0 016 0zM7 21v-2a4 4 0 014-4h2" />
                      <path d="M16 16l2.5 2.5M21 18.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
                    </svg>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    {editingPasskeyId === pk.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingPasskeyName}
                          onChange={(e) => setEditingPasskeyName(e.target.value)}
                          className="flex-1 px-2 py-1 bg-surface border border-border rounded text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handlePasskeyRename(pk.id);
                            if (e.key === 'Escape') { setEditingPasskeyId(null); setEditingPasskeyName(''); }
                          }}
                        />
                        <button
                          onClick={() => handlePasskeyRename(pk.id)}
                          disabled={passkeyLoading}
                          className="px-2 py-1 bg-accent text-white rounded text-xs hover:bg-accent-hover disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => { setEditingPasskeyId(null); setEditingPasskeyName(''); }}
                          className="px-2 py-1 border border-border rounded text-xs text-text-secondary hover:bg-surface-hover"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{pk.name}</span>
                          {pk.disabled && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 font-medium">
                              Disabled
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-xs text-text-secondary">
                            Created {relativeTime(pk.createdAt)}
                          </span>
                          {pk.lastUsedAt && (
                            <>
                              <span className="text-xs text-text-secondary">·</span>
                              <span className="text-xs text-text-secondary">
                                Last used {relativeTime(pk.lastUsedAt)}
                              </span>
                            </>
                          )}
                          {pk.disabled && pk.disabledReason && (
                            <>
                              <span className="text-xs text-text-secondary">·</span>
                              <span className="text-xs text-red-400">{pk.disabledReason}</span>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Actions */}
                  {!pk.disabled && editingPasskeyId !== pk.id && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { setEditingPasskeyId(pk.id); setEditingPasskeyName(pk.name); }}
                        className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded"
                        title="Rename"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setPendingPasskeyRemoval({ id: pk.id, name: pk.name })}
                        disabled={passkeyLoading}
                        className="p-1.5 text-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded"
                        title="Remove"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {passkeys.length === 0 && !showPasskeyRegister && (
                <p className="text-sm text-text-secondary italic py-2">No passkeys registered yet.</p>
              )}
            </div>

            {/* Register new passkey */}
            {showPasskeyRegister ? (
              <form onSubmit={handlePasskeyRegister} className="space-y-3 p-4 border border-border rounded-lg bg-surface">
                <p className="text-sm font-medium text-text-primary">Register a new passkey</p>
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    Passkey name <span className="text-text-secondary">(e.g., "MacBook Pro", "iPhone")</span>
                  </label>
                  <input
                    type="text"
                    value={newPasskeyName}
                    onChange={(e) => setNewPasskeyName(e.target.value)}
                    placeholder="My Device"
                    maxLength={50}
                    autoFocus
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={passkeyLoading || !newPasskeyName.trim()}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium flex items-center gap-2"
                  >
                    {passkeyLoading ? (
                      <>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Registering...
                      </>
                    ) : (
                      'Register Passkey'
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowPasskeyRegister(false); setNewPasskeyName(''); setPasskeyMsg(null); }}
                    className="px-4 py-2 border border-border rounded text-text-secondary hover:bg-surface-hover text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              passkeyCanAdd && (
                <button
                  onClick={() => { setShowPasskeyRegister(true); setPasskeyMsg(null); }}
                  className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover text-sm font-medium flex items-center gap-2"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Add Passkey
                </button>
              )
            )}
            {!passkeyCanAdd && passkeys.length > 0 && (
              <p className="text-xs text-text-secondary mt-2">
                Maximum passkeys ({passkeyMaxCount}) reached. Remove a passkey to add a new one.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
