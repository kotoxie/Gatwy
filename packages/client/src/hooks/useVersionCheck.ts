import { useEffect, useState, useCallback } from 'react';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // re-check every 15 minutes

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  fetchError: string | null;
  checking: boolean;
  refresh: () => void;
}

export function useVersionCheck(): VersionInfo {
  const current = __APP_VERSION__;
  const [latest, setLatest] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [releaseUrl, setReleaseUrl] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async (force = false) => {
    try {
      const url = force ? '/api/v1/version?force=true' : '/api/v1/version';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as {
        current: string;
        latest: string | null;
        updateAvailable: boolean;
        releaseUrl: string | null;
        fetchError: string | null;
      };
      setLatest(data.latest);
      setUpdateAvailable(data.updateAvailable);
      setReleaseUrl(data.releaseUrl);
      setFetchError(data.fetchError ?? null);
    } catch {
      // network unavailable — silently ignore
    }
  }, []);

  const refresh = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    await check(true);
    setChecking(false);
  }, [check, checking]);

  useEffect(() => {
    check();
    const timer = setInterval(() => check(), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [check]);

  return { current, latest, updateAvailable, releaseUrl, fetchError, checking, refresh };
}
