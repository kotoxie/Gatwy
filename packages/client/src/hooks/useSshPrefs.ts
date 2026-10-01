import { useState, useEffect } from 'react';
import { useAuth } from './useAuth';
import { DEFAULT_THEME, type SshThemeName } from '../lib/sshThemes';

export interface SshPrefs {
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  theme: SshThemeName;
}

const DEFAULTS: SshPrefs = {
  fontFamily: '"Fira Code", monospace',
  fontSize: 14,
  scrollback: 5000,
  cursorStyle: 'block',
  cursorBlink: true,
  theme: DEFAULT_THEME as SshThemeName,
};

/**
 * Fetches the current user's SSH terminal preferences from /api/v1/profile/ssh-prefs.
 * The server merges global defaults with per-user overrides, so this always returns
 * a complete set of values ready to pass directly into xterm.js.
 */
export function useSshPrefs(): SshPrefs & { loading: boolean } {
  const { token } = useAuth();
  const [prefs, setPrefs] = useState<SshPrefs>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    fetch('/api/v1/profile/ssh-prefs', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (!data) return;
        setPrefs({
          fontFamily: (data.fontFamily as string) || DEFAULTS.fontFamily,
          fontSize: Number(data.fontSize) || DEFAULTS.fontSize,
          scrollback: Number(data.scrollback) || DEFAULTS.scrollback,
          cursorStyle: (['block', 'bar', 'underline'].includes(data.cursorStyle as string)
            ? data.cursorStyle
            : DEFAULTS.cursorStyle) as SshPrefs['cursorStyle'],
          cursorBlink: typeof data.cursorBlink === 'boolean'
            ? data.cursorBlink
            : data.cursorBlink !== 'false',
          theme: (data.theme as SshThemeName) || DEFAULTS.theme,
        });
      })
      .catch(() => {/* keep defaults on network error */})
      .finally(() => setLoading(false));
  }, [token]);

  return { ...prefs, loading };
}
