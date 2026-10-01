import { useState, useEffect, useCallback } from 'react';
import type React from 'react';
import { showToast } from '../../../hooks/useToast';

interface ChannelData {
  id: string;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
}

const API = '/api/v1/notifications';

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(API + path, { credentials: 'include', ...opts });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// ─── Field helpers ────────────────────────────────────────────────────────────

function Field({
  label, name, value, onChange, type = 'text', placeholder,
}: {
  label: string; name: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-text-secondary">{label}</label>
      <input
        type={type}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full px-3 py-1.5 text-sm rounded border border-border bg-surface text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
      />
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-hover border border-border'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

// ─── Channel logos ────────────────────────────────────────────────────────────

function SmtpLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-400 shrink-0">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 7L12 13 2 7" />
    </svg>
  );
}

function TelegramLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-sky-400 shrink-0">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 14.4l-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.888.159z"/>
    </svg>
  );
}

function SlackLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-purple-400 shrink-0">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  );
}

function WebhookLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-orange-400 shrink-0">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  );
}

const CHANNEL_LOGOS: Record<string, React.ReactNode> = {
  smtp:     <SmtpLogo />,
  telegram: <TelegramLogo />,
  slack:    <SlackLogo />,
  webhook:  <WebhookLogo />,
};

// ─── Provider Card ────────────────────────────────────────────────────────────

function ProviderCard({
  title, channelId, channel, onSaved,
  children,
}: {
  title: string;
  channelId: string;
  channel: ChannelData;
  onSaved: () => void;
  children: (cfg: Record<string, string>, setCfg: (k: string, v: string) => void) => React.ReactNode;
}) {
  const [enabled, setEnabled] = useState(channel.enabled);
  const [cfg, setCfgState] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(channel.config).map(([k, v]) => [k, String(v)])),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [open, setOpen] = useState(false);

  const setCfg = useCallback((k: string, v: string) => setCfgState((p) => ({ ...p, [k]: v })), []);

  async function save() {
    setSaving(true);
    const { ok, data } = await apiFetch(`/channels/${channelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, config: cfg }),
    });
    setSaving(false);
    showToast(ok ? 'Saved.' : (data.error ?? 'Save failed'), ok ? 'success' : 'error');
    if (ok) onSaved();
  }

  async function test() {
    setTesting(true);
    // Build test overrides depending on channel
    let overrides: Record<string, string> = {};
    if (channelId === 'smtp') overrides = { to: cfg.smtp_from ?? '' };
    const { ok, data } = await apiFetch(`/channels/${channelId}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides),
    });
    setTesting(false);
    showToast(ok ? 'Test message sent!' : (data.error ?? 'Test failed'), ok ? 'success' : 'error');
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-alt hover:bg-surface-hover text-left transition-colors"
      >
        <div className="flex items-center gap-3">
          {CHANNEL_LOGOS[channelId] ?? null}
          <span className="text-sm font-medium text-text-primary">{title}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${enabled ? 'bg-green-500/15 text-green-500' : 'bg-surface-hover text-text-secondary'}`}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="p-4 space-y-4 border-t border-border">
          <div className="flex items-center gap-3">
            <Toggle checked={enabled} onChange={setEnabled} />
            <span className="text-sm text-text-secondary">Enable this channel</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {children(cfg, setCfg)}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={test}
              disabled={testing || !enabled}
              className="px-3 py-1.5 text-sm border border-border rounded hover:bg-surface-hover text-text-primary disabled:opacity-50 transition-colors"
            >
              {testing ? 'Sending…' : 'Test'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────

export function NotifConfigTab() {
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { ok, data } = await apiFetch('/channels');
    if (ok) setChannels(data.channels as ChannelData[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading…</p>;

  const ch = (id: string): ChannelData =>
    channels.find((c) => c.id === id) ?? { id, enabled: false, config: {} };

  return (
    <div className="space-y-3">
      {/* SMTP */}
      <ProviderCard title="Email (SMTP)" channelId="smtp" channel={ch('smtp')} onSaved={load}>
        {(cfg, set) => (<>
          <Field label="Host" name="smtp_host" value={cfg.smtp_host ?? ''} onChange={(v) => set('smtp_host', v)} placeholder="smtp.example.com" />
          <Field label="Port" name="smtp_port" value={cfg.smtp_port ?? '587'} onChange={(v) => set('smtp_port', v)} placeholder="587" />
          <Field label="Username" name="smtp_user" value={cfg.smtp_user ?? ''} onChange={(v) => set('smtp_user', v)} />
          <Field label="Password" name="smtp_password" type="password" value={cfg.smtp_password ?? ''} onChange={(v) => set('smtp_password', v)} />
          <Field label="From address" name="smtp_from" value={cfg.smtp_from ?? ''} onChange={(v) => set('smtp_from', v)} placeholder="alerts@example.com" />
          <div className="flex items-center gap-2 col-span-full">
            <input type="checkbox" id="smtp_secure" checked={cfg.smtp_secure === 'true'} onChange={(e) => set('smtp_secure', String(e.target.checked))} className="accent-accent" />
            <label htmlFor="smtp_secure" className="text-xs text-text-secondary">Use TLS (port 465)</label>
          </div>
          <div className="col-span-full space-y-1">
            <label className="block text-xs font-medium text-text-secondary">Default subject template</label>
            <input type="text" value={cfg.smtp_default_subject ?? '{{severity}} [{{app_name}}] {{rule}} — {{event}}'} onChange={(e) => set('smtp_default_subject', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent" />
            <p className="text-[11px] text-text-secondary/70">Variables: {'{{severity}} {{app_name}} {{event}} {{user}} {{ip}} {{timestamp}} {{rule}} {{target}} {{details}}'}</p>
          </div>
          <div className="col-span-full space-y-1">
            <label className="block text-xs font-medium text-text-secondary">Default body template</label>
            <textarea rows={5} value={cfg.smtp_default_body ?? '{{severity}} [{{app_name}}] Security Alert\n━━━━━━━━━━━━━━━━━━━━━\nRule:      {{rule}}\nEvent:     {{event}}\nUser:      {{user}}\nIP:        {{ip}}\nTarget:    {{target}}\nTime:      {{timestamp}}\n━━━━━━━━━━━━━━━━━━━━━\nThis is an automated alert from {{app_name}}.'}
              onChange={(e) => set('smtp_default_body', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent resize-none" />
          </div>
        </>)}
      </ProviderCard>

      {/* Telegram */}
      <ProviderCard title="Telegram" channelId="telegram" channel={ch('telegram')} onSaved={load}>
        {(cfg, set) => (<>
          <Field label="Bot Token" name="telegram_bot_token" type="password" value={cfg.telegram_bot_token ?? ''} onChange={(v) => set('telegram_bot_token', v)} placeholder="123456:ABC-DEF…" />
          <Field label="Default Chat ID" name="telegram_chat_id" value={cfg.telegram_chat_id ?? ''} onChange={(v) => set('telegram_chat_id', v)} placeholder="-1001234567890" />
          <div className="col-span-full space-y-1">
            <label className="block text-xs font-medium text-text-secondary">Default message template (Markdown)</label>
            <textarea rows={5} value={cfg.telegram_default_template ?? '{{severity}} *[{{app_name}}]* {{rule}}\n`{{event}}`\n\n👤 User: `{{user}}`\n🌐 IP: `{{ip}}`\n🎯 Target: `{{target}}`\n🕐 Time: `{{timestamp}}`\n\n_Automated alert from {{app_name}}_'}
              onChange={(e) => set('telegram_default_template', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent resize-none font-mono text-xs" />
            <p className="text-[11px] text-text-secondary/70">Variables: {'{{severity}} {{app_name}} {{event}} {{user}} {{ip}} {{timestamp}} {{rule}} {{target}} {{details}}'}</p>
          </div>
        </>)}
      </ProviderCard>

      {/* Slack */}
      <ProviderCard title="Slack" channelId="slack" channel={ch('slack')} onSaved={load}>
        {(cfg, set) => (<>
          <div className="col-span-full">
            <Field label="Incoming Webhook URL" name="slack_webhook_url" type="password" value={cfg.slack_webhook_url ?? ''} onChange={(v) => set('slack_webhook_url', v)} placeholder="https://hooks.slack.com/services/…" />
          </div>
          <div className="col-span-full space-y-1">
            <label className="block text-xs font-medium text-text-secondary">Default message template</label>
            <textarea rows={4} value={cfg.slack_default_template ?? '{{severity}} *[{{app_name}}]* {{rule}}\n*Event:* `{{event}}` | *User:* `{{user}}` | *IP:* `{{ip}}`\n*Target:* `{{target}}` | *Time:* `{{timestamp}}`\n_Automated alert from {{app_name}}_'}
              onChange={(e) => set('slack_default_template', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent resize-none font-mono text-xs" />
            <p className="text-[11px] text-text-secondary/70">Variables: {'{{severity}} {{app_name}} {{event}} {{user}} {{ip}} {{timestamp}} {{rule}} {{target}} {{details}}'}</p>
          </div>
        </>)}
      </ProviderCard>

      {/* Webhook */}
      <ProviderCard title="Webhook (HTTP)" channelId="webhook" channel={ch('webhook')} onSaved={load}>
        {(cfg, set) => (<>
          <div className="col-span-full">
            <Field label="URL" name="webhook_url" value={cfg.webhook_url ?? ''} onChange={(v) => set('webhook_url', v)} placeholder="https://your-server.com/webhook" />
          </div>
          <Field label="Method" name="webhook_method" value={cfg.webhook_method ?? 'POST'} onChange={(v) => set('webhook_method', v)} placeholder="POST" />
          <Field label="Custom Headers (JSON)" name="webhook_headers" value={cfg.webhook_headers ?? ''} onChange={(v) => set('webhook_headers', v)} placeholder='{"X-Token":"secret"}' />
          <div className="col-span-full space-y-1">
            <label className="block text-xs font-medium text-text-secondary">Body template (leave empty for JSON payload)</label>
            <textarea rows={3} value={cfg.webhook_default_template ?? ''}
              onChange={(e) => set('webhook_default_template', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent resize-none font-mono text-xs"
              placeholder='{"event":"{{event}}","user":"{{user}}"}' />
            <p className="text-[11px] text-text-secondary/70">Variables: {'{{severity}} {{app_name}} {{event}} {{user}} {{ip}} {{timestamp}} {{rule}} {{target}} {{details}}'}</p>
          </div>
        </>)}
      </ProviderCard>
    </div>
  );
}
