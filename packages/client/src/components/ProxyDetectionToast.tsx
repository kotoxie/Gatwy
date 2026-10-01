import { useState, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useSettings, invalidateSettings } from '../hooks/useSettings';

export function ProxyDetectionToast() {
  const { user, proxyIp, clearProxyIp } = useAuth();
  const { settings, refresh } = useSettings();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const isAdmin = user?.role === 'admin';

  const handleAdd = useCallback(async () => {
    if (!proxyIp) return;
    setSaving(true);
    try {
      const current = settings['security.trusted_proxies']?.trim() ?? '';
      const updated = current ? `${current}, ${proxyIp}` : proxyIp;
      const res = await fetch('/api/v1/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'security.trusted_proxies': updated }),
      });
      if (res.ok) {
        await refresh();
        invalidateSettings();
        clearProxyIp();
      }
    } catch { /* network error */ }
    setSaving(false);
    setConfirming(false);
  }, [proxyIp, settings, refresh, clearProxyIp]);

  if (!proxyIp) return null;

  return (
    <>
      {/* Toast notification */}
      <div className="fixed bottom-6 left-6 z-[200] max-w-sm w-full animate-[fadeIn_0.2s_ease-out]">
        <div className="bg-surface-alt border border-border rounded-lg shadow-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="shrink-0 mt-0.5 text-amber-400">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary mb-1">Proxy detected</p>
              <p className="text-xs text-text-secondary">
                Your connection is being forwarded through{' '}
                <span className="font-mono text-text-primary">{proxyIp}</span>
                {' '}which is not in the trusted proxies list.
              </p>
              {isAdmin && (
                <p className="text-xs text-text-secondary mt-1">
                  Add it to trusted proxies so client IPs are resolved correctly.
                </p>
              )}
            </div>
            <button
              onClick={clearProxyIp}
              className="shrink-0 text-text-secondary hover:text-text-primary"
              title="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          {isAdmin && (
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => setConfirming(true)}
                className="px-3 py-1.5 bg-accent text-white rounded text-xs font-medium hover:bg-accent-hover"
              >
                Add to trusted proxies
              </button>
              <button
                onClick={clearProxyIp}
                className="px-3 py-1.5 border border-border rounded text-xs text-text-secondary hover:bg-surface-hover"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation dialog */}
      {confirming && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-xs">
          <div className="bg-surface-alt border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <div className="text-center">
              <div className="text-3xl mb-3">🛡️</div>
              <h2 className="text-lg font-semibold text-text-primary mb-2">Add trusted proxy?</h2>
              <p className="text-sm text-text-secondary mb-1">
                This will add <span className="font-mono font-medium text-text-primary">{proxyIp}</span> to your trusted proxies list.
              </p>
              <p className="text-xs text-text-secondary mb-4">
                Trusted proxies are allowed to set the X-Forwarded-For header so Gatwy can identify real client IP addresses.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleAdd}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover text-sm font-medium disabled:opacity-50"
              >
                {saving ? 'Adding...' : 'Confirm'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={saving}
                className="flex-1 px-4 py-2 border border-border rounded-lg text-text-secondary hover:bg-surface-hover text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
