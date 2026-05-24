import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface User {
  id: string;
  username: string;
  displayName: string;
  role: string;
  theme: string | null;
  permissions: string[];
  dismissedWarnings: string[];
}

interface LoginResult {
  mfaRequired?: boolean;
  mfaToken?: string;
  mfaMethod?: 'totp' | 'passkey';
  proxyIp?: string;
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  completeMfaLogin: (mfaToken: string, code: string, trustDevice?: boolean) => Promise<void>;
  logout: () => void;
  setup: (username: string, password: string, displayName: string) => Promise<void>;
  needsSetup: boolean | null;
  refreshUser: () => Promise<void>;
  proxyIp: string | null;
  clearProxyIp: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/** Idle warning shown N seconds before session expires due to inactivity */
const IDLE_WARN_SECONDS = 120;

function IdleWarningDialog({ secondsLeft, onStayActive }: { secondsLeft: number; onStayActive: () => void }) {
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs">
      <div className="bg-surface border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 text-center">
        <div className="text-4xl mb-3">⏱️</div>
        <h2 className="text-lg font-semibold text-text-primary mb-2">Session expiring soon</h2>
        <p className="text-sm text-text-secondary mb-4">
          You will be logged out in <span className="font-mono font-bold text-yellow-400">{label}</span> due to inactivity.
        </p>
        <button
          onClick={onStayActive}
          className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover text-sm font-medium"
        >
          Stay logged in
        </button>
      </div>
    </div>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [idleWarnSecondsLeft, setIdleWarnSecondsLeft] = useState<number | null>(null);
  const [proxyIp, setProxyIp] = useState<string | null>(() => sessionStorage.getItem('gatwy-proxy-ip'));

  const clearProxyIp = useCallback(() => {
    sessionStorage.removeItem('gatwy-proxy-ip');
    setProxyIp(null);
  }, []);

  /** Timestamp of the last detected user interaction */
  const lastActivityRef = useRef<number>(Date.now());
  /** Idle timeout setting fetched from public settings (0 = disabled) */
  const idleTimeoutMinutesRef = useRef<number>(0);

  useEffect(() => {
    (async () => {
      try {
        const { needsSetup: ns } = await apiFetch('/auth/status');
        setNeedsSetup(ns);
        if (!ns) {
          try {
            const { user: u } = await apiFetch('/auth/me');
            setUser(u);
            setToken('cookie');
          } catch {
            // Not authenticated — that's fine
          }
        }
      } catch {
        setToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Fetch the idle timeout setting from public settings so the client knows when to warn
  useEffect(() => {
    if (!token) return;
    fetch('/api/v1/settings/public', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        const mins = parseInt(d?.settings?.['security.idle_timeout_minutes'] ?? '0', 10);
        idleTimeoutMinutesRef.current = isNaN(mins) ? 0 : mins;
      })
      .catch(() => { /* ignore */ });
  }, [token]);

  // Track user activity — any mouse/keyboard/touch event resets the idle clock
  useEffect(() => {
    if (!token) return;
    const touch = () => { lastActivityRef.current = Date.now(); };
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener('mousemove', touch, opts);
    window.addEventListener('mousedown', touch, opts);
    window.addEventListener('keydown', touch, opts);
    window.addEventListener('touchstart', touch, opts);
    window.addEventListener('scroll', touch, opts);
    return () => {
      window.removeEventListener('mousemove', touch);
      window.removeEventListener('mousedown', touch);
      window.removeEventListener('keydown', touch);
      window.removeEventListener('touchstart', touch);
      window.removeEventListener('scroll', touch);
    };
  }, [token]);

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }) as { token?: string; user?: User; mfaRequired?: boolean; mfaToken?: string; mfaMethod?: 'totp' | 'passkey'; proxyIp?: string };

    if (data.mfaRequired) {
      return { mfaRequired: true, mfaToken: data.mfaToken, mfaMethod: data.mfaMethod };
    }

    if (data.proxyIp) {
      sessionStorage.setItem('gatwy-proxy-ip', data.proxyIp);
      setProxyIp(data.proxyIp);
    }

    const u = data.user!;
    setToken('cookie');
    setUser(u);
    setNeedsSetup(false);
    return { proxyIp: data.proxyIp };
  }, []);

  const completeMfaLogin = useCallback(async (mfaToken: string, code: string, trustDevice?: boolean) => {
    const data = await apiFetch('/auth/login/mfa', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code, trustDevice: !!trustDevice }),
    }) as { token: string; user: User; proxyIp?: string };

    if (data.proxyIp) {
      sessionStorage.setItem('gatwy-proxy-ip', data.proxyIp);
      setProxyIp(data.proxyIp);
    }

    setToken('cookie');
    setUser(data.user);
    setNeedsSetup(false);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('Gatwy-token');
    localStorage.removeItem('gatwy-sessions');
    sessionStorage.clear();
    setToken(null);
    setUser(null);
    setProxyIp(null);
    setIdleWarnSecondsLeft(null);
    // Revoke the session on the server (fire-and-forget — UI clears immediately)
    fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'include',
    }).catch(() => { /* ignore network errors on logout */ });
  }, []);

  // Kick the user out when any fetch returns 401 (e.g. session revoked remotely)
  useEffect(() => {
    if (!token) return;
    const handler = () => {
      // Only act if we still have a token (avoid double-logout)
      if (token) logout();
    };
    window.addEventListener('gatwy:unauthorized', handler);
    return () => window.removeEventListener('gatwy:unauthorized', handler);
  }, [token, logout]);

  // Heartbeat — runs every 30 s.
  // • If the user was active recently → normal /auth/me (touches last_used_at, resets idle clock).
  // • If the user is idle → /auth/me?heartbeat=1 (only checks revocation, does NOT reset idle clock).
  // • If idle_timeout is configured, tracks countdown and shows a warning dialog.
  useEffect(() => {
    if (!token) return;

    let warnInterval: ReturnType<typeof setInterval> | null = null;

    const check = async () => {
      const idleMinutes = idleTimeoutMinutesRef.current;
      const idleMs = Date.now() - lastActivityRef.current;
      const isIdle = idleMs > 60_000; // consider idle after 1 minute of no interaction

      const url = isIdle ? '/api/v1/auth/me?heartbeat=1' : '/api/v1/auth/me';
      try {
        await fetch(url, { credentials: 'include' });
        // 401 is handled by the global fetch interceptor below
      } catch { /* network error — ignore */ }

      // Manage the idle warning countdown
      if (idleMinutes > 0 && isIdle) {
        const idleSeconds = Math.floor(idleMs / 1000);
        const timeoutSeconds = idleMinutes * 60;
        const secondsLeft = timeoutSeconds - idleSeconds;

        if (secondsLeft <= IDLE_WARN_SECONDS && secondsLeft > 0) {
          setIdleWarnSecondsLeft(secondsLeft);
          // Start a 1-second countdown interval if not already running
          if (!warnInterval) {
            warnInterval = setInterval(() => {
              const remaining = Math.floor((idleMinutes * 60 * 1000 - (Date.now() - lastActivityRef.current)) / 1000);
              if (remaining <= 0) {
                setIdleWarnSecondsLeft(null);
                if (warnInterval) { clearInterval(warnInterval); warnInterval = null; }
              } else {
                setIdleWarnSecondsLeft(remaining);
              }
            }, 1000);
          }
        } else if (secondsLeft <= 0) {
          setIdleWarnSecondsLeft(null);
        } else {
          // Not yet in warning window — clear any stale warning
          if (idleWarnSecondsLeft !== null) setIdleWarnSecondsLeft(null);
          if (warnInterval) { clearInterval(warnInterval); warnInterval = null; }
        }
      } else {
        // User is active or idle timeout disabled — dismiss any warning
        if (idleWarnSecondsLeft !== null) setIdleWarnSecondsLeft(null);
        if (warnInterval) { clearInterval(warnInterval); warnInterval = null; }
      }
    };

    const id = setInterval(check, 30_000);
    return () => {
      clearInterval(id);
      if (warnInterval) clearInterval(warnInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** Called when the user clicks "Stay logged in" in the idle warning dialog */
  const handleStayActive = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIdleWarnSecondsLeft(null);
    // Make a real request to reset last_used_at on the server
    fetch('/api/v1/auth/me', { credentials: 'include' }).catch(() => { /* ignore */ });
  }, []);

  const setup = useCallback(async (username: string, password: string, displayName: string) => {
    const { user: u } = await apiFetch('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password, displayName }),
    });
    setToken('cookie');
    setUser(u);
    setNeedsSetup(false);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const { user: u } = await apiFetch('/auth/me') as { user: User };
      setUser(u);
    } catch { /* ignore */ }
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, completeMfaLogin, logout, setup, needsSetup, refreshUser, proxyIp, clearProxyIp }}>
      {children}
      {idleWarnSecondsLeft !== null && (
        <IdleWarningDialog secondsLeft={idleWarnSecondsLeft} onStayActive={handleStayActive} />
      )}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
