import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';

type RFBInstance = import('@novnc/novnc').default;

interface VncControlPanelProps {
  rfbRef: RefObject<RFBInstance | null>;
  status: 'connecting' | 'connected' | 'disconnected';
  /** The outermost session container — used for the Fullscreen API. */
  sessionRef: RefObject<HTMLDivElement | null>;
  onDisconnect: () => void;
  touchMode: 'touchscreen' | 'touchpad';
  onTouchModeChange: (mode: 'touchscreen' | 'touchpad') => void;
  /** Finger-primary devices only. Desktop never mounts the touch overlays. */
  showTouch?: boolean;
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconSliders() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconChevronLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
function IconChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function IconFullscreen() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
function IconExitFullscreen() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="8 3 3 3 3 8" />
      <polyline points="21 8 21 3 16 3" />
      <polyline points="3 16 3 21 8 21" />
      <polyline points="16 21 21 21 21 16" />
    </svg>
  );
}
function IconPower() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

// ─── Toggle row ───────────────────────────────────────────────────────────────

function Toggle({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 cursor-pointer select-none ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <span className="text-xs text-text-primary">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 focus:outline-none ${checked ? 'bg-accent' : 'bg-border'}`}
      >
        <span className={`inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}

// ─── Slider row ───────────────────────────────────────────────────────────────

function SliderRow({ label, value, min, max, onChange, disabled }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-primary">{label}</span>
        <span className="text-xs text-text-secondary tabular-nums w-4 text-right">{value}</span>
      </div>
      <input type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full accent-accent cursor-pointer" />
    </div>
  );
}

// ─── Section heading ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">{title}</span>
      {children}
    </div>
  );
}

// ─── Clipboard send area ──────────────────────────────────────────────────────
// Uses a plain textarea so the user pastes with Ctrl+V — no clipboard-read
// permission required (unlike navigator.clipboard.readText which browsers
// block or prompt for, and Firefox doesn't support at all).

function ClipboardArea({ rfbRef, disabled }: { rfbRef: RefObject<RFBInstance | null>; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(() => {
    if (!rfbRef.current || !text) return;
    const rfb = rfbRef.current;

    // Also set the server clipboard so the user can Ctrl+V later manually.
    rfb.clipboardPasteFrom(text);

    // Type the text character-by-character using sendKey keysyms.
    // This bypasses the clipboard exchange entirely — no timing dependency,
    // works on all VNC servers regardless of extended clipboard support.
    // Keysym encoding: printable Latin-1 → codePoint directly;
    //                  Unicode > U+00FF  → 0x01000000 | codePoint;
    //                  special keys mapped explicitly.
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      let keysym: number;
      if (cp === 0x0a || cp === 0x0d) {
        keysym = 0xff0d; // XK_Return
      } else if (cp === 0x09) {
        keysym = 0xff09; // XK_Tab
      } else if (cp > 0xff) {
        keysym = 0x01000000 | cp; // Unicode keysym encoding
      } else {
        keysym = cp;
      }
      rfb.sendKey(keysym, '', true);
      rfb.sendKey(keysym, '', false);
    }

    setText('');
    setFeedback('Sent!');
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(''), 1500);
  }, [rfbRef, text]);

  // Send on Ctrl+Enter inside the textarea
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  }, [send]);

  return (
    <div className={`flex flex-col gap-1.5 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Paste text here (Ctrl+V), then Send"
        rows={3}
        className="w-full text-xs bg-surface border border-border rounded-md px-2 py-1.5 text-text-primary placeholder:text-text-secondary resize-none focus:outline-none focus:border-accent"
      />
      <button
        onClick={send}
        disabled={!text}
        className="flex items-center justify-center gap-1.5 text-xs bg-accent hover:bg-accent-hover text-white px-2 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <IconSend />
        <span>{feedback || 'Send to remote'}</span>
      </button>
      <span className="text-[10px] text-text-secondary">or Ctrl+Enter</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VncControlPanel({ rfbRef, status, sessionRef, onDisconnect, touchMode, onTouchModeChange, showTouch = false }: VncControlPanelProps) {
  const [open, setOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [scaleViewport, setScaleViewport] = useState(true);
  const [resizeSession, setResizeSessionState] = useState(false);
  const [clipViewport, setClipViewport] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [qualityLevel, setQualityLevel] = useState(4);
  const [compressionLevel, setCompressionLevel] = useState(2);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const connected = status === 'connected';

  // Sync local state from RFB when panel opens or connection changes
  useEffect(() => {
    if (!open || !rfbRef.current) return;
    const r = rfbRef.current;
    setScaleViewport(r.scaleViewport);
    setResizeSessionState(r.resizeSession);
    setClipViewport(r.clipViewport);
    setViewOnly(r.viewOnly);
    setQualityLevel(r.qualityLevel);
    setCompressionLevel(r.compressionLevel);
  }, [open, rfbRef, status]);

  // Track fullscreen state changes (e.g. user presses Esc)
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  // ── RFB setters ─────────────────────────────────────────────────────────────

  const setScale = useCallback((v: boolean) => {
    setScaleViewport(v);
    if (rfbRef.current) rfbRef.current.scaleViewport = v;
  }, [rfbRef]);

  const setResize = useCallback((v: boolean) => {
    setResizeSessionState(v);
    if (rfbRef.current) rfbRef.current.resizeSession = v;
  }, [rfbRef]);

  const setClip = useCallback((v: boolean) => {
    setClipViewport(v);
    if (rfbRef.current) rfbRef.current.clipViewport = v;
  }, [rfbRef]);

  const setViewOnlyMode = useCallback((v: boolean) => {
    setViewOnly(v);
    if (rfbRef.current) rfbRef.current.viewOnly = v;
  }, [rfbRef]);

  const setQuality = useCallback((v: number) => {
    setQualityLevel(v);
    if (rfbRef.current) rfbRef.current.qualityLevel = v;
  }, [rfbRef]);

  const setCompression = useCallback((v: number) => {
    setCompressionLevel(v);
    if (rfbRef.current) rfbRef.current.compressionLevel = v;
  }, [rfbRef]);

  const handleFullscreen = useCallback(() => {
    const el = sessionRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, [sessionRef]);

  const handleCtrlAltDel = useCallback(() => {
    rfbRef.current?.sendCtrlAltDel();
  }, [rfbRef]);

  return (
    // Flex-row child alongside the canvas — opening the panel genuinely shrinks
    // the canvas div so noVNC's internal ResizeObserver fires and rescales.
    <div ref={wrapperRef} className="flex flex-row h-full shrink-0">

      {/* Tab handle — always visible, matches RDP style */}
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Close controls' : 'Session controls'}
        className="flex flex-col items-center justify-center gap-2 w-7 h-full bg-black/50 hover:bg-black/70 text-gray-400 hover:text-white transition-colors border-l border-white/10"
      >
        <IconSliders />
        {open ? <IconChevronRight /> : <IconChevronLeft />}
      </button>

      {/* Slide-out panel content */}
      <div
        className={`flex flex-col gap-5 overflow-y-auto overflow-x-hidden bg-surface-alt/95 backdrop-blur-sm border-l border-border transition-all duration-200 ease-in-out ${open ? 'w-56 px-4 py-5 opacity-100' : 'w-0 px-0 py-0 opacity-0'}`}
        aria-hidden={!open}
      >
        {open && (
          <>
            <Section title="Display">
              <Toggle label="Scale to fit" checked={scaleViewport} onChange={setScale} disabled={!connected} />
              <Toggle label="Clip viewport" checked={clipViewport} onChange={setClip} disabled={!connected} />
              <Toggle label="Match server resolution" checked={resizeSession} onChange={setResize} disabled={!connected} />
            </Section>

            <div className="border-t border-border" />

            <Section title="Quality">
              <SliderRow label="Video quality" value={qualityLevel} min={0} max={9} onChange={setQuality} disabled={!connected} />
              <SliderRow label="Compression" value={compressionLevel} min={0} max={9} onChange={setCompression} disabled={!connected} />
            </Section>

            <div className="border-t border-border" />

            <Section title="Input">
              {showTouch && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-text-primary">Touch</span>
                <div className="flex rounded-md border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => onTouchModeChange('touchscreen')}
                    className={`flex-1 px-2 py-1.5 text-[11px] transition-colors ${
                      touchMode === 'touchscreen'
                        ? 'bg-accent text-white'
                        : 'text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    Touchscreen
                  </button>
                  <button
                    type="button"
                    onClick={() => onTouchModeChange('touchpad')}
                    className={`flex-1 px-2 py-1.5 text-[11px] transition-colors ${
                      touchMode === 'touchpad'
                        ? 'bg-accent text-white'
                        : 'text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    Touchpad
                  </button>
                </div>
                <p className="text-[11px] text-text-secondary leading-tight">
                  {touchMode === 'touchpad'
                    ? 'Move like a laptop trackpad. Tap to click. Hold then drag, or tap then drag, to move windows. Aim with one finger, then tap a second finger for right-click (cursor stays put). Two-finger drag scrolls.'
                    : 'Tap the picture where you want to click, like a real touchscreen.'}
                </p>
              </div>
              )}
              <Toggle label="View only" checked={viewOnly} onChange={setViewOnlyMode} disabled={!connected} />
              <button
                onClick={handleCtrlAltDel}
                disabled={!connected}
                className="flex items-center gap-2 text-xs text-text-primary px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                <span className="font-mono text-[11px] text-text-secondary">⌨</span>
                <span>Ctrl+Alt+Del</span>
              </button>
            </Section>

            <div className="border-t border-border" />

            <Section title="Clipboard">
              <ClipboardArea rfbRef={rfbRef} disabled={!connected} />
            </Section>

            <div className="border-t border-border" />

            <Section title="Window">
              <button
                onClick={handleFullscreen}
                className="flex items-center gap-2 text-xs text-text-primary px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
              >
                {isFullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
                <span>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
              </button>
            </Section>

            <div className="mt-auto border-t border-border pt-4">
              <button
                onClick={onDisconnect}
                className="flex items-center gap-2 text-xs text-red-400 px-2 py-1.5 rounded-md hover:bg-red-500/10 transition-colors w-full"
              >
                <IconPower />
                <span>Disconnect</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
