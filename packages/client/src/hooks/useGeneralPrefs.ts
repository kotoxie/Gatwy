import { useEffect, useState } from 'react';
import { useAuth } from './useAuth';

export interface GeneralPrefs {
  commandPaletteShortcut: boolean;
}

const DEFAULTS: GeneralPrefs = {
  commandPaletteShortcut: true,
};

let cache: GeneralPrefs | null = null;
const subs = new Set<() => void>();

/** Called by GeneralSettings after saving so other mounted consumers (e.g. MainLayout) pick up the change. */
export function invalidateGeneralPrefs() {
  cache = null;
  subs.forEach((f) => f());
}

export function useGeneralPrefs(): GeneralPrefs & { loading: boolean } {
  const { token } = useAuth();
  const [prefs, setPrefs] = useState<GeneralPrefs>(cache ?? DEFAULTS);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    if (!token) return;
    const load = () => {
      fetch('/api/v1/profile/general-prefs', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: Record<string, unknown> | null) => {
          if (!data) return;
          const next: GeneralPrefs = {
            commandPaletteShortcut: data.commandPaletteShortcut !== false,
          };
          cache = next;
          setPrefs(next);
        })
        .catch(() => {/* keep defaults on network error */})
        .finally(() => setLoading(false));
    };
    if (!cache) load(); else setPrefs(cache);
    subs.add(load);
    return () => { subs.delete(load); };
  }, [token]);

  return { ...prefs, loading };
}
