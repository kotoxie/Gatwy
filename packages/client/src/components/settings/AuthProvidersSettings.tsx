import { useState, useEffect } from 'react';
import { useAuth } from '../../hooks/useAuth.js';
import { invalidateSettings } from '../../hooks/useSettings.js';
import { showToast } from '../../hooks/useToast';
import { BASE_PATH } from '../../lib/basePath';

interface AuthSettings {
  'auth.local_enabled': string;
  'auth.ldap_enabled': string;
  'auth.ldap_url': string;
  'auth.ldap_bind_dn': string;
  'auth.ldap_search_base': string;
  'auth.ldap_user_filter': string;
  'auth.ldap_username_attr': string;
  'auth.ldap_email_attr': string;
  'auth.ldap_display_name_attr': string;
  'auth.ldap_admin_group_dn': string;
  'auth.ldap_tls_reject_unauthorized': string;
  'auth.oidc_enabled': string;
  'auth.oidc_provider_url': string;
  'auth.oidc_client_id': string;
  'auth.oidc_redirect_uri': string;
  'auth.oidc_scope': string;
  'auth.oidc_display_name_claim': string;
  'auth.oidc_username_claim': string;
  'auth.oidc_admin_group_claim': string;
  'auth.oidc_admin_group_value': string;
  'auth.oidc_button_label': string;
  'auth.oidc_token_auth_method': string;
}

const DEFAULTS: AuthSettings = {
  'auth.local_enabled': 'true',
  'auth.ldap_enabled': 'false',
  'auth.ldap_url': '',
  'auth.ldap_bind_dn': '',
  'auth.ldap_search_base': '',
  'auth.ldap_user_filter': '(uid={username})',
  'auth.ldap_username_attr': 'uid',
  'auth.ldap_email_attr': 'mail',
  'auth.ldap_display_name_attr': 'cn',
  'auth.ldap_admin_group_dn': '',
  'auth.ldap_tls_reject_unauthorized': 'true',
  'auth.oidc_enabled': 'false',
  'auth.oidc_provider_url': '',
  'auth.oidc_client_id': '',
  'auth.oidc_redirect_uri': '',
  'auth.oidc_scope': 'openid email profile',
  'auth.oidc_display_name_claim': 'name',
  'auth.oidc_username_claim': 'preferred_username',
  'auth.oidc_admin_group_claim': '',
  'auth.oidc_admin_group_value': '',
  'auth.oidc_button_label': 'Sign in with SSO',
  'auth.oidc_token_auth_method': 'client_secret_basic',
};

export function AuthProvidersSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AuthSettings>(DEFAULTS);
  const [ldapPassword, setLdapPassword] = useState('');
  const [oidcSecret, setOidcSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testingLdap, setTestingLdap] = useState(false);
  const [ldapTestResult, setLdapTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    fetch('/api/v1/settings', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { settings: Record<string, string> }) => {
        const merged = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS) as (keyof AuthSettings)[]) {
          if (d.settings[key] !== undefined) merged[key] = d.settings[key];
        }
        setSettings(merged);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user?.role]);

  const set = (key: keyof AuthSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const toggle = (key: keyof AuthSettings) => {
    setSettings((prev) => ({ ...prev, [key]: prev[key] === 'true' ? 'false' : 'true' }));
  };

  const handleSave = async () => {
    setSaving(true);

    const updates: Record<string, string> = { ...settings };
    updates['auth.ldap_bind_password'] = ldapPassword || '__unchanged__';
    updates['auth.oidc_client_secret'] = oidcSecret || '__unchanged__';

    try {
      const res = await fetch('/api/v1/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const d = await res.json() as { error: string };
        showToast(d.error || 'Save failed', 'error');
      } else {
        showToast('Settings saved successfully.', 'success');
        setLdapPassword('');
        setOidcSecret('');
        invalidateSettings();
      }
    } catch {
      showToast('Network error', 'error');
    } finally {
      setSaving(false);
    }
  };

  const testLdapConnection = async () => {
    setTestingLdap(true);
    setLdapTestResult(null);
    try {
      const res = await fetch('/api/v1/auth/ldap/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: settings['auth.ldap_url'],
          bindDn: settings['auth.ldap_bind_dn'],
          bindPassword: ldapPassword || undefined,
          searchBase: settings['auth.ldap_search_base'],
        }),
      });
      const d = await res.json() as { success: boolean; error?: string };
      setLdapTestResult(d.success ? '✅ Connection successful' : `❌ ${d.error ?? 'Connection failed'}`);
    } catch {
      setLdapTestResult('❌ Network error');
    } finally {
      setTestingLdap(false);
    }
  };

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const localEnabled = settings['auth.local_enabled'] === 'true';
  const ldapEnabled = settings['auth.ldap_enabled'] === 'true';
  const oidcEnabled = settings['auth.oidc_enabled'] === 'true';

  return (
    <div className="space-y-8 max-w-2xl">
      {/* Local Authentication */}
      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Local Authentication</h3>
          <p className="text-sm text-muted-foreground">Allow users to log in with a username and password stored locally.</p>
        </div>
        <div className="flex items-center justify-between p-4 border rounded-lg">
          <div>
            <p className="font-medium">Enable local login</p>
            <p className="text-sm text-muted-foreground">Users can sign in with their Gatwy username and password</p>
          </div>
          <button
            onClick={() => toggle('auth.local_enabled')}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${localEnabled ? 'bg-accent' : 'bg-surface-hover'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${localEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        {!localEnabled && (
          <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-sm text-yellow-600 dark:text-yellow-400">
            <span>⚠️</span>
            <span>Local authentication is disabled. Ensure at least one SSO provider is configured so administrators can still access the system.</span>
          </div>
        )}
      </section>

      {/* LDAP */}
      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">LDAP / Active Directory</h3>
          <p className="text-sm text-muted-foreground">Authenticate users against an LDAP directory or Active Directory.</p>
        </div>
        <div className="flex items-center justify-between p-4 border rounded-lg">
          <div>
            <p className="font-medium">Enable LDAP authentication</p>
            <p className="text-sm text-muted-foreground">Users can sign in with their directory credentials</p>
          </div>
          <button
            onClick={() => toggle('auth.ldap_enabled')}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${ldapEnabled ? 'bg-accent' : 'bg-surface-hover'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${ldapEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {ldapEnabled && (
          <div className="space-y-4 p-4 border rounded-lg bg-surface-alt">
            <div className="grid grid-cols-1 gap-4">
              <Field label="LDAP Server URL" hint="e.g. ldap://dc.example.com or ldaps://dc.example.com:636">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_url']} onChange={(e) => set('auth.ldap_url', e.target.value)} placeholder="ldap://dc.example.com" />
              </Field>
              <Field label="Bind DN" hint="Service account DN used to search the directory">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_bind_dn']} onChange={(e) => set('auth.ldap_bind_dn', e.target.value)} placeholder="cn=service,ou=users,dc=example,dc=com" />
              </Field>
              <Field label="Bind Password" hint="Leave blank to keep existing password">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" type="password" value={ldapPassword} onChange={(e) => setLdapPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
              </Field>
              <Field label="Search Base" hint="The base DN to search for users">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_search_base']} onChange={(e) => set('auth.ldap_search_base', e.target.value)} placeholder="ou=users,dc=example,dc=com" />
              </Field>
              <Field label="User Search Filter" hint="Use {username} as placeholder for the entered username">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_user_filter']} onChange={(e) => set('auth.ldap_user_filter', e.target.value)} placeholder="(uid={username})" />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <Field label="Username Attribute">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_username_attr']} onChange={(e) => set('auth.ldap_username_attr', e.target.value)} placeholder="uid" />
              </Field>
              <Field label="Email Attribute">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_email_attr']} onChange={(e) => set('auth.ldap_email_attr', e.target.value)} placeholder="mail" />
              </Field>
              <Field label="Display Name Attribute">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_display_name_attr']} onChange={(e) => set('auth.ldap_display_name_attr', e.target.value)} placeholder="cn" />
              </Field>
            </div>

            <Field label="Admin Group DN" hint="Optional: DN of group whose members are granted admin role">
              <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.ldap_admin_group_dn']} onChange={(e) => set('auth.ldap_admin_group_dn', e.target.value)} placeholder="cn=gatwy-admins,ou=groups,dc=example,dc=com" />
            </Field>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">Verify TLS Certificate</p>
                <p className="text-xs text-text-secondary">Disable only for self-signed certs in development</p>
              </div>
              <button
                onClick={() => toggle('auth.ldap_tls_reject_unauthorized')}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings['auth.ldap_tls_reject_unauthorized'] === 'true' ? 'bg-accent' : 'bg-surface-hover'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings['auth.ldap_tls_reject_unauthorized'] === 'true' ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={testLdapConnection}
                disabled={testingLdap || !settings['auth.ldap_url'] || !settings['auth.ldap_search_base']}
                className="px-3 py-1.5 border border-border rounded text-sm text-text-primary hover:bg-surface-hover disabled:opacity-50"
              >
                {testingLdap ? 'Testing...' : 'Test Connection'}
              </button>
              {ldapTestResult && <span className="text-sm text-text-secondary">{ldapTestResult}</span>}
            </div>
          </div>
        )}
      </section>

      {/* OIDC */}
      <section className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">OpenID Connect (SSO)</h3>
          <p className="text-sm text-muted-foreground">Allow users to sign in via an identity provider like Azure AD, Okta, Google, or Keycloak.</p>
        </div>
        <div className="flex items-center justify-between p-4 border rounded-lg">
          <div>
            <p className="font-medium">Enable SSO</p>
            <p className="text-sm text-muted-foreground">Show SSO sign-in button on the login page</p>
          </div>
          <button
            onClick={() => toggle('auth.oidc_enabled')}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${oidcEnabled ? 'bg-accent' : 'bg-surface-hover'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${oidcEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {oidcEnabled && (
          <div className="space-y-4 p-4 border rounded-lg bg-surface-alt">
            <div className="grid grid-cols-1 gap-4">
              <Field label="Provider URL (Issuer)" hint="Base URL of your identity provider (discovery doc will be fetched from /.well-known/openid-configuration)">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_provider_url']} onChange={(e) => set('auth.oidc_provider_url', e.target.value)} placeholder="https://login.microsoftonline.com/tenant-id/v2.0" />
              </Field>
              <Field label="Client ID">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_client_id']} onChange={(e) => set('auth.oidc_client_id', e.target.value)} placeholder="your-client-id" />
              </Field>
              <Field label="Client Secret" hint="Leave blank to keep existing secret">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" type="password" value={oidcSecret} onChange={(e) => setOidcSecret(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
              </Field>
              <Field label="Redirect URI" hint={`Must be registered in your identity provider. Use: ${window.location.origin}${BASE_PATH}/api/v1/auth/oidc/callback`}>
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_redirect_uri']} onChange={(e) => set('auth.oidc_redirect_uri', e.target.value)} placeholder={`${window.location.origin}${BASE_PATH}/api/v1/auth/oidc/callback`} />
              </Field>
              <Field label="Scope" hint="Space-separated OIDC scopes">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_scope']} onChange={(e) => set('auth.oidc_scope', e.target.value)} placeholder="openid email profile" />
              </Field>
              <Field label="Token Endpoint Auth Method" hint="Must match your identity provider. Env OIDC_TOKEN_AUTH_METHOD overrides this.">
                <select
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                  value={settings['auth.oidc_token_auth_method'] || 'client_secret_basic'}
                  onChange={(e) => set('auth.oidc_token_auth_method', e.target.value)}
                >
                  <option value="client_secret_basic">client_secret_basic (HTTP Basic)</option>
                  <option value="client_secret_post">client_secret_post (form body)</option>
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Username Claim" hint="JWT claim to use as username">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_username_claim']} onChange={(e) => set('auth.oidc_username_claim', e.target.value)} placeholder="preferred_username" />
              </Field>
              <Field label="Display Name Claim">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_display_name_claim']} onChange={(e) => set('auth.oidc_display_name_claim', e.target.value)} placeholder="name" />
              </Field>
              <Field label="Admin Group Claim" hint="Claim name that contains group memberships">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_admin_group_claim']} onChange={(e) => set('auth.oidc_admin_group_claim', e.target.value)} placeholder="groups" />
              </Field>
              <Field label="Admin Group Value" hint="Value in the claim that grants admin role">
                <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_admin_group_value']} onChange={(e) => set('auth.oidc_admin_group_value', e.target.value)} placeholder="gatwy-admins" />
              </Field>
            </div>

            <Field label="Login Button Label" hint="Text shown on the SSO button on the login page">
              <input className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm" value={settings['auth.oidc_button_label']} onChange={(e) => set('auth.oidc_button_label', e.target.value)} placeholder="Sign in with SSO" />
            </Field>
          </div>
        )}
      </section>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="py-2 px-4 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 font-medium text-sm"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-text-primary">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}
