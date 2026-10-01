import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './useAuth';

type Settings = Record<string, string>;

const DEFAULTS: Settings = {
  'app.name': 'Gatwy',
  'app.timezone': 'UTC',
  'ssh.font_size': '14',
  'ssh.font_family': '"Fira Code", monospace',
  'ssh.scrollback': '5000',
  'ssh.cursor_style': 'block',
};

let cache: Settings | null = null;
const subs = new Set<() => void>();

export function invalidateSettings() {
  cache = null;
  subs.forEach((f) => f());
}

export function useSettings() {
  const { token, user } = useAuth();
  const [settings, setSettings] = useState<Settings>(cache ?? DEFAULTS);
  const [loading, setLoading] = useState(!cache);

  const fetch_ = useCallback(async () => {
    if (!token) return;
    try {
      // Users with settings.manage get full settings; all others use the public endpoint
      const hasSettingsPerm = user?.permissions?.includes('settings.manage');
      const endpoint = hasSettingsPerm ? '/api/v1/settings' : '/api/v1/settings/public';
      const res = await fetch(endpoint, { credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        cache = d.settings;
        setSettings(d.settings);
      }
    } finally {
      setLoading(false);
    }
  }, [token, user?.role]);

  useEffect(() => {
    if (!cache) fetch_();
    else setSettings(cache);
    subs.add(fetch_);
    return () => {
      subs.delete(fetch_);
    };
  }, [fetch_]);

  return { settings, loading, refresh: fetch_ };
}
