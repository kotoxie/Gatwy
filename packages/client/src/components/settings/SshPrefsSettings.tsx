import { useEffect, useState, type FormEvent } from 'react';
import { SSH_THEMES, THEME_NAMES, DEFAULT_THEME, type SshThemeName } from '../../lib/sshThemes';

const FONT_FAMILIES = [
  { key: 'monospace',       label: 'Monospace',       css: 'monospace' },
  { key: 'fira-code',       label: 'Fira Code',       css: '"Fira Code", monospace' },
  { key: 'source-code-pro', label: 'Source Code Pro', css: '"Source Code Pro", monospace' },
  { key: 'inconsolata',     label: 'Inconsolata',     css: '"Inconsolata", monospace' },
  { key: 'ubuntu-mono',     label: 'Ubuntu Mono',     css: '"Ubuntu Mono", monospace' },
  { key: 'roboto-mono',     label: 'Roboto Mono',     css: '"Roboto Mono", monospace' },
] as const;

type FontFamilyKey = (typeof FONT_FAMILIES)[number]['key'];

function fontKeyToCss(key: FontFamilyKey | string): string {
  return FONT_FAMILIES.find((f) => f.key === key)?.css ?? 'monospace';
}

function fontCssToKey(css: string): FontFamilyKey {
  return (FONT_FAMILIES.find((f) => f.css === css || f.key === css)?.key ?? 'monospace') as FontFamilyKey;
}

const FONT_SIZES = Array.from({ length: 23 }, (_, i) => i + 10); // 10..32

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        value ? 'bg-accent' : 'bg-surface-hover border border-border'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={`px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SshPreview({
  fontFamily,
  fontSize,
  cursorStyle,
  cursorBlink,
  theme,
}: {
  fontFamily: string;
  fontSize: string;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  theme: SshThemeName;
}) {
  const t = SSH_THEMES[theme];
  const [blink, setBlink] = useState(true);

  useEffect(() => {
    if (!cursorBlink) { setBlink(true); return; }
    const interval = setInterval(() => setBlink((v) => !v), 530);
    return () => clearInterval(interval);
  }, [cursorBlink]);

  const cursorEl =
    cursorStyle === 'block' ? (
      <span
        style={{
          display: 'inline-block',
          width: '0.6em',
          height: '1.2em',
          background: blink ? t.cursor : 'transparent',
          verticalAlign: 'text-bottom',
        }}
      />
    ) : cursorStyle === 'underline' ? (
      <span
        style={{
          display: 'inline-block',
          width: '0.6em',
          height: '2px',
          background: blink ? t.cursor : 'transparent',
          verticalAlign: 'baseline',
          marginBottom: '-1px',
        }}
      />
    ) : (
      <span
        style={{
          display: 'inline-block',
          width: '2px',
          height: '1.2em',
          background: blink ? t.cursor : 'transparent',
          verticalAlign: 'text-bottom',
        }}
      />
    );

  return (
    <div className="rounded overflow-hidden flex-1 min-h-0 flex flex-col">
      <div
        style={{ background: t.bg, borderBottom: `1px solid ${t.brightBlack}`, padding: '4px 16px', fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: t.brightBlack }}
      >
        {fontFamily} · {fontSize}px
      </div>
      <div
        style={{ background: t.bg, fontFamily, fontSize: `${fontSize}px`, lineHeight: 1.5, padding: '14px 16px', flex: 1 }}
      >
        <div>
          <span style={{ color: t.green }}>user@server</span>
          <span style={{ color: t.fg }}>:</span>
          <span style={{ color: t.blue }}>~</span>
          <span style={{ color: t.fg }}>$ </span>
          <span style={{ color: t.fg }}>ls -la /var/log</span>
        </div>
        <div>
          <span style={{ color: t.brightBlack }}># 0O1lI -&gt; =&gt; != {'{}'} [] ()</span>
        </div>
        <div>
          <span style={{ color: t.blue }}>drwxr-xr-x</span>
          <span style={{ color: t.fg }}> 2 root root </span>
          <span style={{ color: t.yellow }}>4096</span>
          <span style={{ color: t.fg }}> Mar 22 10:41 </span>
          <span style={{ color: t.cyan }}>syslog</span>
        </div>
        <div>
          <span style={{ color: t.blue }}>-rw-r--r--</span>
          <span style={{ color: t.fg }}> 1 root root </span>
          <span style={{ color: t.yellow }}>18234</span>
          <span style={{ color: t.fg }}> Mar 22 09:15 </span>
          <span style={{ color: t.fg }}>kern.log</span>
        </div>
        <div>
          <span style={{ color: t.green }}>user@server</span>
          <span style={{ color: t.fg }}>:</span>
          <span style={{ color: t.blue }}>~</span>
          <span style={{ color: t.fg }}>$ </span>
          {cursorEl}
        </div>
      </div>
    </div>
  );
}

interface SshPrefs {
  fontFamily: string;
  fontSize: string;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  theme: SshThemeName;
  scrollback: string;
}

export function SshPrefsSettings() {
  const [fontFamilyKey, setFontFamilyKey] = useState<FontFamilyKey>('fira-code');
  const [fontSize, setFontSize] = useState('14');
  const [cursorStyle, setCursorStyle] = useState<'block' | 'bar' | 'underline'>('block');
  const [cursorBlink, setCursorBlink] = useState(true);
  const [theme, setTheme] = useState<SshThemeName>(DEFAULT_THEME);
  const [scrollback, setScrollback] = useState('5000');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/v1/profile/ssh-prefs', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: SshPrefs) => {
        setFontFamilyKey(fontCssToKey(d.fontFamily ?? 'fira-code'));
        setFontSize(FONT_SIZES.includes(parseInt(d.fontSize ?? '14', 10)) ? String(d.fontSize) : '14');
        setCursorStyle((d.cursorStyle as 'block' | 'bar' | 'underline') ?? 'block');
        setCursorBlink(d.cursorBlink !== false);
        setTheme((d.theme as SshThemeName) ?? DEFAULT_THEME);
        setScrollback(d.scrollback ?? '5000');
      })
      .catch(() => {});
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/profile/ssh-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          fontFamily: fontKeyToCss(fontFamilyKey),
          fontSize,
          cursorStyle,
          cursorBlink,
          theme,
          scrollback,
        }),
      });
      if (res.ok) {
        setMsg({ type: 'success', text: 'Saved. New SSH sessions will use these settings.' });
      } else {
        const d = await res.json() as { error?: string };
        setMsg({ type: 'error', text: d.error || 'Failed to save.' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <form onSubmit={handleSave} className="flex gap-8 flex-1 min-h-0">
        {/* Left: controls */}
        <div className="flex flex-col gap-5 w-72 shrink-0 overflow-y-auto pr-2">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">Font</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Font Family</label>
                <select
                  value={fontFamilyKey}
                  onChange={(e) => setFontFamilyKey(e.target.value as FontFamilyKey)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                >
                  {FONT_FAMILIES.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Font Size</label>
                <Select
                  value={fontSize}
                  onChange={setFontSize}
                  options={FONT_SIZES.map((s) => ({ value: String(s), label: `${s}px` }))}
                  className="w-full"
                />
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">Cursor</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Cursor Style</label>
                <Select
                  value={cursorStyle}
                  onChange={setCursorStyle}
                  options={[
                    { value: 'block', label: 'Block' },
                    { value: 'underline', label: 'Underline' },
                    { value: 'bar', label: 'Bar' },
                  ]}
                  className="w-full"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">Cursor Blinking</span>
                <Toggle value={cursorBlink} onChange={setCursorBlink} />
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">Theme</h3>
            <Select
              value={theme}
              onChange={setTheme}
              options={THEME_NAMES.map((t) => ({ value: t.id, label: t.name }))}
              className="w-full"
            />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">Advanced</h3>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Scrollback Lines</label>
              <input
                type="number"
                min="100"
                max="100000"
                value={scrollback}
                onChange={(e) => setScrollback(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
            </div>
          </section>

          <div>
            {msg && (
              <p className={`text-sm mb-2 ${msg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                {msg.text}
              </p>
            )}
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 text-sm font-medium w-full"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setMsg(null);
                try {
                  await fetch('/api/v1/profile/ssh-prefs', {
                    method: 'DELETE',
                    credentials: 'include',
                  });
                  // Reload defaults from server
                  const res = await fetch('/api/v1/profile/ssh-prefs', {
                    credentials: 'include',
                  });
                  if (res.ok) {
                    const d = await res.json() as Record<string, string | boolean>;
                    setFontFamilyKey(fontCssToKey(String(d.fontFamily ?? 'monospace')));
                    setFontSize(String(d.fontSize ?? '14'));
                    setCursorStyle((d.cursorStyle as 'block' | 'bar' | 'underline') ?? 'block');
                    setCursorBlink(d.cursorBlink === true || d.cursorBlink === 'true');
                    setTheme((d.theme as SshThemeName) ?? DEFAULT_THEME);
                    setScrollback(String(d.scrollback ?? '5000'));
                  }
                  setMsg({ type: 'success', text: 'Reset to global defaults.' });
                } catch {
                  setMsg({ type: 'error', text: 'Network error.' });
                } finally {
                  setSaving(false);
                }
              }}
              className="px-4 py-2 bg-surface-hover border border-border text-text-secondary rounded hover:text-text-primary disabled:opacity-50 text-sm w-full mt-2"
            >
              Reset to Defaults
            </button>
          </div>
        </div>

        {/* Right: live preview */}
        <div className="flex-1 flex flex-col min-h-0">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3 shrink-0">
            Preview
          </h3>
          <SshPreview
            fontFamily={fontKeyToCss(fontFamilyKey)}
            fontSize={fontSize}
            cursorStyle={cursorStyle}
            cursorBlink={cursorBlink}
            theme={theme}
          />
        </div>
      </form>
    </div>
  );
}
