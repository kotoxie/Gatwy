import { useEffect, useState, type FormEvent } from 'react';
import { useSettings, invalidateSettings } from '../../hooks/useSettings';

interface IpRule {
  id: string;
  type: 'allow' | 'deny';
  cidr: string;
  description: string;
}

function ipToNum(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) + parseInt(o, 10)) >>> 0, 0) >>> 0;
}

function matchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return cidr === ip;
  try {
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipToNum(ip) & mask) === (ipToNum(range) & mask);
  } catch {
    return false;
  }
}

export function SecuritySettings() {
  const { settings, refresh } = useSettings();

  // Session timeout state
  const [idleTimeout, setIdleTimeout] = useState('0');
  const [maxSessionMinutes, setMaxSessionMinutes] = useState('0');
  const [sessionMsg, setSessionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingSession, setSavingSession] = useState(false);

  // Login lockout state
  const [maxFailed, setMaxFailed] = useState('5');
  const [lockoutMinutes, setLockoutMinutes] = useState('30');
  const [lockoutMsg, setLockoutMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingLockout, setSavingLockout] = useState(false);

  // IP rules state
  const [ipRulesEnabled, setIpRulesEnabled] = useState(false);
  const [ipRulesMode, setIpRulesMode] = useState<'allowlist' | 'denylist'>('allowlist');
  const [ipRules, setIpRules] = useState<IpRule[]>([]);
  const [newRuleCidr, setNewRuleCidr] = useState('');
  const [newRuleType, setNewRuleType] = useState<'allow' | 'deny'>('allow');
  const [newRuleDesc, setNewRuleDesc] = useState('');
  const [ipMsg, setIpMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingIp, setSavingIp] = useState(false);
  const [currentIp, setCurrentIp] = useState<string>('');
  const [ipBlockWarning, setIpBlockWarning] = useState<string | null>(null);

  // Connection limits
  const [maxConnPerUser, setMaxConnPerUser] = useState('10');
  const [connMsg, setConnMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingConn, setSavingConn] = useState(false);

  // Trusted proxies
  const [trustedProxies, setTrustedProxies] = useState('');
  const [proxyDetectionEnabled, setProxyDetectionEnabled] = useState(true);
  const [proxyMsg, setProxyMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingProxy, setSavingProxy] = useState(false);

  // Passkey settings
  const [passkeyEnabled, setPasskeyEnabled] = useState(true);
  const [passkeyInactiveDays, setPasskeyInactiveDays] = useState('90');
  const [passkeyMsg, setPasskeyMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingPasskey, setSavingPasskey] = useState(false);

  useEffect(() => {
    setIdleTimeout(settings['security.idle_timeout_minutes'] ?? '0');
    setMaxSessionMinutes(settings['security.max_session_minutes'] ?? '0');
    setMaxFailed(settings['security.max_failed_logins'] ?? '5');
    setLockoutMinutes(settings['security.lockout_minutes'] ?? '30');
    setIpRulesEnabled(settings['security.ip_rules_enabled'] === 'true');
    setIpRulesMode((settings['security.ip_rules_mode'] as 'allowlist' | 'denylist') ?? 'allowlist');
    setMaxConnPerUser(settings['security.max_connections_per_user'] ?? '10');
    setTrustedProxies(settings['security.trusted_proxies'] ?? '');
    setProxyDetectionEnabled(settings['security.proxy_detection_enabled'] !== 'false');
    setPasskeyEnabled(settings['security.passkey_enabled'] !== 'false');
    setPasskeyInactiveDays(settings['security.passkey_inactive_days'] ?? '90');

  }, [settings]);

  useEffect(() => {
    fetch('/api/v1/settings/ip-rules', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { enabled: boolean; mode: 'allowlist' | 'denylist'; currentIp: string; rules: IpRule[] } | null) => {
        if (!d) return;
        setIpRulesEnabled(d.enabled);
        setIpRulesMode(d.mode);
        setCurrentIp(d.currentIp);
        setIpRules(Array.isArray(d.rules) ? d.rules : []);
      })
      .catch(() => {});
  }, []);

  async function saveSetting(updates: Record<string, string>, onSuccess: () => void, onError: (msg: string) => void) {
    const res = await fetch('/api/v1/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      await refresh();
      invalidateSettings();
      onSuccess();
    } else {
      const d = await res.json();
      onError(d.error || 'Failed to save.');
    }
  }

  async function handleSessionSave(e: FormEvent) {
    e.preventDefault();
    setSavingSession(true);
    setSessionMsg(null);
    try {
      await saveSetting(
        {
          'security.idle_timeout_minutes': idleTimeout,
          'security.max_session_minutes': maxSessionMinutes,
        },
        () => setSessionMsg({ type: 'success', text: 'Saved.' }),
        (msg) => setSessionMsg({ type: 'error', text: msg }),
      );
    } catch {
      setSessionMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingSession(false);
    }
  }

  async function handleLockoutSave(e: FormEvent) {
    e.preventDefault();
    setSavingLockout(true);
    setLockoutMsg(null);
    try {
      await saveSetting(
        {
          'security.max_failed_logins': maxFailed,
          'security.lockout_minutes': lockoutMinutes,
        },
        () => setLockoutMsg({ type: 'success', text: 'Saved.' }),
        (msg) => setLockoutMsg({ type: 'error', text: msg }),
      );
    } catch {
      setLockoutMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingLockout(false);
    }
  }

  function addIpRule() {
    if (!newRuleCidr.trim()) return;
    const rule: IpRule = {
      id: crypto.randomUUID(),
      type: newRuleType,
      cidr: newRuleCidr.trim(),
      description: newRuleDesc.trim(),
    };
    setIpRules((prev) => [...prev, rule]);
    setNewRuleCidr('');
    setNewRuleDesc('');
  }

  function removeIpRule(id: string) {
    setIpRules((prev) => prev.filter((r) => r.id !== id));
  }

  function wouldCurrentIpBeBlocked(): boolean {
    if (!ipRulesEnabled || !currentIp) return false;

    const blockedByAllowlist = ipRulesMode === 'allowlist' && !ipRules
      .filter((r) => r.type === 'allow')
      .some((r) => matchesCidr(currentIp, r.cidr));
    const blockedByDenylist = ipRulesMode === 'denylist' && ipRules
      .filter((r) => r.type === 'deny')
      .some((r) => matchesCidr(currentIp, r.cidr));

    return blockedByAllowlist || blockedByDenylist;
  }

  async function persistIpRules() {
    const res = await fetch('/api/v1/settings/ip-rules', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: ipRulesEnabled, mode: ipRulesMode, rules: ipRules }),
    });

    if (res.ok) {
      await refresh();
      invalidateSettings();
      setIpMsg({ type: 'success', text: 'IP rules saved.' });
      return;
    }

    const d = await res.json();
    setIpMsg({ type: 'error', text: d.error || 'Failed to save.' });
  }

  async function handleIpSave(e: FormEvent) {
    e.preventDefault();
    setSavingIp(true);
    setIpMsg(null);
    setIpBlockWarning(null);
    try {
      if (wouldCurrentIpBeBlocked()) {
        setIpBlockWarning(`Your current IP (${currentIp}) will be blocked by these rules.`);
        return;
      }

      await persistIpRules();
    } catch {
      setIpMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingIp(false);
    }
  }

  async function handleConnSave(e: FormEvent) {
    e.preventDefault();
    setSavingConn(true);
    setConnMsg(null);
    try {
      await saveSetting(
        { 'security.max_connections_per_user': maxConnPerUser },
        () => setConnMsg({ type: 'success', text: 'Saved.' }),
        (msg) => setConnMsg({ type: 'error', text: msg }),
      );
    } catch {
      setConnMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingConn(false);
    }
  }

  async function handleProxySave(e: FormEvent) {
    e.preventDefault();
    setSavingProxy(true);
    setProxyMsg(null);
    try {
      await saveSetting(
        {
          'security.trusted_proxies': trustedProxies,
          'security.proxy_detection_enabled': String(proxyDetectionEnabled),
        },
        () => setProxyMsg({ type: 'success', text: 'Saved.' }),
        (msg) => setProxyMsg({ type: 'error', text: msg }),
      );
    } catch {
      setProxyMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingProxy(false);
    }
  }

  async function handlePasskeySave(e: FormEvent) {
    e.preventDefault();
    setSavingPasskey(true);
    setPasskeyMsg(null);
    try {
      await saveSetting(
        {
          'security.passkey_enabled': String(passkeyEnabled),
          'security.passkey_inactive_days': passkeyInactiveDays,
        },
        () => setPasskeyMsg({ type: 'success', text: 'Saved.' }),
        (msg) => setPasskeyMsg({ type: 'error', text: msg }),
      );
    } catch {
      setPasskeyMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSavingPasskey(false);
    }
  }

  return (
    <div className="max-w-lg space-y-8">
      {/* Session Timeouts */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">Session Timeouts</h2>
        <p className="text-sm text-text-secondary mb-4">Control how long sessions remain active. Set to 0 to disable.</p>
        <form onSubmit={handleSessionSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Idle timeout (minutes) <span className="font-normal">— 0 = disabled</span>
            </label>
            <p className="text-xs text-text-secondary mb-1">Automatically revokes a session after this many minutes of inactivity. Any API request resets the clock.</p>
            <input
              type="number"
              min="0"
              value={idleTimeout}
              onChange={(e) => setIdleTimeout(e.target.value)}
              className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Max session time (minutes) <span className="font-normal">— 0 = no limit</span>
            </label>
            <p className="text-xs text-text-secondary mb-1">Hard limit on session lifetime regardless of activity. The JWT token expires after this many minutes and the user must log in again.</p>
            <input
              type="number"
              min="0"
              value={maxSessionMinutes}
              onChange={(e) => setMaxSessionMinutes(e.target.value)}
              className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>
          {sessionMsg && (
            <p className={`text-sm ${sessionMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {sessionMsg.text}
            </p>
          )}
          <button
            type="submit"
            disabled={savingSession}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingSession ? 'Saving...' : 'Save'}
          </button>
        </form>
      </section>

      <hr className="border-border" />

      {/* Passkeys */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">Passkeys (WebAuthn)</h2>
        <p className="text-sm text-text-secondary mb-4">Configure passwordless two-factor authentication using passkeys.</p>
        <form onSubmit={handlePasskeySave} className="space-y-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPasskeyEnabled((v) => !v)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                passkeyEnabled ? 'bg-accent' : 'bg-surface-hover border border-border'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  passkeyEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <div>
              <span className="text-sm text-text-secondary">Enable passkeys</span>
              <p className="text-xs text-text-secondary">Allow users to register passkeys for two-factor authentication.</p>
            </div>
          </div>
          {passkeyEnabled && (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Auto-disable inactive passkeys after (days) <span className="font-normal">— 0 = never</span>
              </label>
              <p className="text-xs text-text-secondary mb-1">
                Passkeys that haven't been used within this period will be automatically disabled for security.
              </p>
              <input
                type="number"
                min="0"
                value={passkeyInactiveDays}
                onChange={(e) => setPasskeyInactiveDays(e.target.value)}
                className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
            </div>
          )}
          {passkeyMsg && (
            <p className={`text-sm ${passkeyMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {passkeyMsg.text}
            </p>
          )}
          <button
            type="submit"
            disabled={savingPasskey}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingPasskey ? 'Saving...' : 'Save'}
          </button>
        </form>
      </section>

      <hr className="border-border" />

      {/* Login & Lockout */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">Login &amp; Lockout</h2>
        <p className="text-sm text-text-secondary mb-4">Configure brute-force protection and account lockout thresholds.</p>
        <form onSubmit={handleLockoutSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Max failed logins before lockout
            </label>
            <input
              type="number"
              min="1"
              value={maxFailed}
              onChange={(e) => setMaxFailed(e.target.value)}
              className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Lockout duration (minutes)
            </label>
            <input
              type="number"
              min="1"
              value={lockoutMinutes}
              onChange={(e) => setLockoutMinutes(e.target.value)}
              className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
          </div>
          {lockoutMsg && (
            <p className={`text-sm ${lockoutMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {lockoutMsg.text}
            </p>
          )}
          <button
            type="submit"
            disabled={savingLockout}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingLockout ? 'Saving...' : 'Save'}
          </button>
        </form>
      </section>

      <hr className="border-border" />

      {/* IP Rules */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">IP Rules</h2>
        <p className="text-sm text-text-secondary mb-4">Restrict access by IP address or CIDR range.</p>
        {currentIp && (
          <p className="text-xs text-text-secondary mb-2">Current client IP: <span className="font-mono text-text-primary">{currentIp}</span></p>
        )}
        <form onSubmit={handleIpSave} className="space-y-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIpRulesEnabled((v) => !v)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                ipRulesEnabled ? 'bg-accent' : 'bg-surface-hover border border-border'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  ipRulesEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span className="text-sm text-text-secondary">Enable IP rules</span>

            {ipRulesEnabled && (
              <select
                value={ipRulesMode}
                onChange={(e) => setIpRulesMode(e.target.value as 'allowlist' | 'denylist')}
                className="ml-4 px-2 py-1 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              >
                <option value="allowlist">Allowlist (permit listed IPs only)</option>
                <option value="denylist">Denylist (block listed IPs)</option>
              </select>
            )}
          </div>

          {/* Existing rules */}
          {ipRules.length > 0 && (
            <div className="border border-border rounded overflow-hidden">
              {ipRules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 bg-surface text-sm">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${rule.type === 'allow' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
                    {rule.type}
                  </span>
                  <span className="font-mono text-text-primary flex-1">{rule.cidr}</span>
                  {rule.description && <span className="text-text-secondary truncate max-w-[150px]">{rule.description}</span>}
                  <button
                    type="button"
                    onClick={() => removeIpRule(rule.id)}
                    className="text-text-secondary hover:text-red-400 shrink-0"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add rule */}
          <div className="flex gap-2 items-end flex-wrap">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Type</label>
              <select
                value={newRuleType}
                onChange={(e) => setNewRuleType(e.target.value as 'allow' | 'deny')}
                className="px-2 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              >
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs text-text-secondary mb-1">CIDR</label>
              <input
                type="text"
                value={newRuleCidr}
                onChange={(e) => setNewRuleCidr(e.target.value)}
                placeholder="192.168.1.0/24"
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm font-mono"
              />
            </div>
            <div className="flex-1 min-w-[120px]">
              <label className="block text-xs text-text-secondary mb-1">Description (optional)</label>
              <input
                type="text"
                value={newRuleDesc}
                onChange={(e) => setNewRuleDesc(e.target.value)}
                placeholder="Office network"
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
            </div>
            <button
              type="button"
              onClick={addIpRule}
              className="px-3 py-2 bg-surface-hover border border-border rounded text-sm text-text-primary hover:bg-surface"
            >
              + Add
            </button>
          </div>

          {ipMsg && (
            <p className={`text-sm ${ipMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {ipMsg.text}
            </p>
          )}
          {ipBlockWarning && (
            <div className="rounded border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-300 space-y-2">
              <p>{ipBlockWarning}</p>
              <p>Saving these rules may immediately block your current session and prevent future logins from this IP.</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    setSavingIp(true);
                    setIpMsg(null);
                    try {
                      await persistIpRules();
                      setIpBlockWarning(null);
                    } catch {
                      setIpMsg({ type: 'error', text: 'Network error.' });
                    } finally {
                      setSavingIp(false);
                    }
                  }}
                  className="px-3 py-1.5 rounded bg-yellow-500 text-black text-xs font-semibold hover:bg-yellow-400 disabled:opacity-60"
                  disabled={savingIp}
                >
                  {savingIp ? 'Saving...' : 'Save anyway'}
                </button>
                <button
                  type="button"
                  onClick={() => setIpBlockWarning(null)}
                  className="px-3 py-1.5 rounded border border-yellow-500/50 text-yellow-200 text-xs hover:bg-yellow-500/10"
                  disabled={savingIp}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <button
            type="submit"
            disabled={savingIp}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingIp ? 'Saving...' : 'Save IP Rules'}
          </button>
        </form>
      </section>

      <hr className="border-border" />

      {/* Connection Limits */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">Connection Limits</h2>
        <p className="text-sm text-text-secondary mb-4">Maximum number of concurrent sessions allowed per user.</p>
        <form onSubmit={handleConnSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Max concurrent connections per user
            </label>
            <select
              value={maxConnPerUser}
              onChange={(e) => setMaxConnPerUser(e.target.value)}
              className="w-40 px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            >
              <option value="10">10 (default)</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
          {maxConnPerUser !== '10' && (
            <div className="flex items-start gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-yellow-400 text-sm">
              <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>
                Increasing beyond the default (10) may expose the server to resource exhaustion. Only raise this limit if you trust your users.
              </span>
            </div>
          )}
          {connMsg && (
            <p className={`text-sm ${connMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {connMsg.text}
            </p>
          )}
          <button
            type="submit"
            disabled={savingConn}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingConn ? 'Saving...' : 'Save'}
          </button>
        </form>
      </section>

      <hr className="border-border" />

      {/* Trusted Proxies */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">Trusted Proxies</h2>
        <p className="text-sm text-text-secondary mb-4">Comma-separated list of trusted proxy IP addresses.</p>
        <form onSubmit={handleProxySave} className="space-y-4">
          <div>
            <input
              type="text"
              value={trustedProxies}
              onChange={(e) => setTrustedProxies(e.target.value)}
              placeholder="10.0.0.1, 10.0.0.2"
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm font-mono"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setProxyDetectionEnabled((v) => !v)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                proxyDetectionEnabled ? 'bg-accent' : 'bg-surface-hover border border-border'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  proxyDetectionEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <div>
              <span className="text-sm text-text-secondary">Proxy detection notifications</span>
              <p className="text-xs text-text-secondary">When enabled, users are notified at login if their connection arrives via an untrusted proxy.</p>
            </div>
          </div>
          {proxyMsg && (
            <p className={`text-sm ${proxyMsg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
              {proxyMsg.text}
            </p>
          )}
          <button
            type="submit"
            disabled={savingProxy}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
          >
            {savingProxy ? 'Saving...' : 'Save'}
          </button>
        </form>
      </section>
    </div>
  );
}
