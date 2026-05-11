import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { useSettings } from '../hooks/useSettings';
import { useVersionCheck } from '../hooks/useVersionCheck';

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

function autoInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

export type SidebarMode = 'open' | 'closed' | 'hide';

interface HeaderProps {
  sidebarMode: SidebarMode;
  onCycleSidebarMode: () => void;
  onOpenSettings: (section?: string) => void;
}

export function Header({ sidebarMode, onCycleSidebarMode, onOpenSettings }: HeaderProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { settings } = useSettings();
  const { current: appVersion, updateAvailable, latest, releaseUrl, fetchError, checking, refresh: refreshVersion } = useVersionCheck();
  const [upToDate, setUpToDate] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'warn' } | null>(null);
  const wasManualCheck = useRef(false);

  const showToast = useCallback((msg: string, type: 'success' | 'error' | 'warn' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Show "Up to date" flash only when check completed, got a response, and no update found
  useEffect(() => {
    if (!checking && latest !== null && !updateAvailable) {
      setUpToDate(true);
      const t = setTimeout(() => setUpToDate(false), 2500);
      return () => clearTimeout(t);
    } else if (updateAvailable) {
      setUpToDate(false);
    }
  }, [checking, latest, updateAvailable]);

  // Show toast after a manual check completes (respects version.toast_feedback setting)
  useEffect(() => {
    if (checking || !wasManualCheck.current) return;
    if (settings['version.toast_feedback'] === 'false') { wasManualCheck.current = false; return; }
    wasManualCheck.current = false;
    if (fetchError) {
      showToast(`Update check failed: ${fetchError}`, 'error');
    } else if (updateAvailable && latest) {
      showToast(`v${latest} is available!`, 'warn');
    } else if (latest) {
      showToast('You\'re on the latest version', 'success');
    }
  }, [checking, fetchError, updateAvailable, latest, settings, showToast]);

  async function handleVersionClick() {
    setUpToDate(false);
    wasManualCheck.current = true;
    await refreshVersion();
  }

  const appName = settings['app.name'] ?? 'Gatwy';
  const appLogo = settings['app.logo'] ?? '';
  const username = user?.username ?? '';
  const displayName = user?.displayName ?? username;
  const initials = autoInitials(displayName || username);
  const avatarColor = getAvatarColor(username);

  // Sync browser tab title with app name
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  return (
    <>
    <header className="flex items-center justify-between h-12 px-4 bg-surface-alt border-b border-border shrink-0">
      <div className="flex items-center gap-3">
        <button
          onClick={onCycleSidebarMode}
          className={`p-1.5 rounded hover:bg-surface-hover transition-colors ${
            sidebarMode === 'open'
              ? 'text-accent bg-accent/10'
              : sidebarMode === 'hide'
              ? 'text-accent/70 bg-accent/5'
              : 'text-text-secondary'
          }`}
          title={`Sidebar: ${sidebarMode} — click to cycle (Ctrl+\`)`}
        >
          {sidebarMode === 'open' && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          )}
          {sidebarMode === 'hide' && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" strokeDasharray="3 2" />
            </svg>
          )}
          {sidebarMode === 'closed' && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" strokeOpacity="0.25" />
            </svg>
          )}
        </button>
        {appLogo ? (
          <img src={appLogo} alt={appName} className="h-7 w-auto max-w-[140px] object-contain" />
        ) : (
          <span className="text-lg font-bold text-text-primary tracking-tight">{appName}</span>
        )}
        <button
          onClick={handleVersionClick}
          disabled={checking}
          className="flex items-center gap-1 text-xs text-text-secondary opacity-60 font-mono hover:opacity-100 transition-opacity disabled:cursor-wait"
          title="Check for updates"
        >
          {checking && (
            <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          )}
          v{appVersion}
        </button>

        {/* GitHub icon with hover popover */}
        <div className="relative group">
          <button
            className="flex items-center opacity-40 hover:opacity-100 transition-opacity text-text-secondary"
            title="GitHub"
            tabIndex={0}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
          </button>
          {/* Popover */}
          <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 hidden group-hover:flex group-focus-within:flex flex-col bg-surface-alt border border-border rounded shadow-lg py-1 min-w-[160px]">
            <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-surface-alt border-l border-t border-border rotate-45" />
            <a
              href="https://github.com/kotoxie/gatwy"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              View Project
            </a>
            <a
              href="https://github.com/kotoxie/Gatwy/issues/new/choose"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              Report an Issue
            </a>
          </div>
        </div>
        {/* Website link */}
        <a
          href="https://gatwy.dev"
          target="_blank"
          rel="noreferrer"
          className="flex items-center opacity-40 hover:opacity-100 transition-opacity text-text-secondary"
          title="Gatwy website"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </a>
        {/* Documentation link */}
        <a
          href="https://docs.gatwy.dev"
          target="_blank"
          rel="noreferrer"
          className="flex items-center opacity-40 hover:opacity-100 transition-opacity text-text-secondary"
          title="Gatwy documentation"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
        </a>
        {updateAvailable && releaseUrl ? (
          <a
            href={releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors"
            title={`New version available: v${latest}`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12l7-7 7 7" />
            </svg>
            v{latest} available
          </a>
        ) : upToDate && !checking ? (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 text-xs font-medium">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Up to date
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded hover:bg-surface-hover text-text-secondary"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        {/* Gear / settings button */}
        <button
          onClick={() => onOpenSettings()}
          className="p-1.5 rounded hover:bg-surface-hover text-text-secondary"
          title="Settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        {/* Avatar — opens profile section */}
        <button
          onClick={() => onOpenSettings('profile')}
          className={`w-7 h-7 rounded-full ${avatarColor} flex items-center justify-center text-white text-xs font-bold shrink-0 hover:opacity-80 transition-opacity`}
          title={`${displayName} — Profile`}
        >
          {initials}
        </button>

        <div className="flex items-center gap-1 text-sm">
          <span className="text-text-secondary">{displayName}</span>
          <button
            onClick={logout}
            className="px-2 py-1 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded text-sm"
          >
            Sign Out
          </button>
        </div>
      </div>
    </header>

    {/* Version check toast */}
    {toast && (
      <div className={`fixed bottom-6 right-6 z-[100] flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-[fadeIn_0.2s_ease-out] ${
        toast.type === 'success' ? 'bg-green-500 text-white'
        : toast.type === 'warn' ? 'bg-accent text-white'
        : 'bg-red-500 text-white'
      }`}>
        {toast.type === 'success' && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        )}
        {toast.type === 'warn' && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12l7-7 7 7"/></svg>
        )}
        {toast.type === 'error' && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        )}
        {toast.msg}
      </div>
    )}
    </>
  );
}
