import { useRef, useState, useCallback, type RefObject } from 'react';
import { useIsCoarsePointer } from '../hooks/useIsCoarsePointer';

type RFBInstance = import('@novnc/novnc').default;

interface VncMobileKeyboardProps {
  rfbRef: RefObject<RFBInstance | null>;
  status: 'connecting' | 'connected' | 'disconnected';
}

// Keysym constants
const XK_BackSpace  = 0xff08;
const XK_Tab        = 0xff09;
const XK_Return     = 0xff0d;
const XK_Escape     = 0xff1b;
const XK_Delete     = 0xffff;
const XK_Home       = 0xff50;
const XK_Left       = 0xff51;
const XK_Up         = 0xff52;
const XK_Right      = 0xff53;
const XK_Down       = 0xff54;
const XK_End        = 0xff57;
const XK_Insert     = 0xff63;
const XK_F1         = 0xffbe;

// Map KeyboardEvent.key → X11 keysym for named keys.
// Returns null for printable characters (handled via codePoint instead).
function namedKeyToKeysym(key: string): number | null {
  switch (key) {
    case 'Backspace': return XK_BackSpace;
    case 'Tab':       return XK_Tab;
    case 'Enter':     return XK_Return;
    case 'Escape':    return XK_Escape;
    case 'Delete':    return XK_Delete;
    case 'Home':      return XK_Home;
    case 'End':       return XK_End;
    case 'Insert':    return XK_Insert;
    case 'ArrowLeft':  return XK_Left;
    case 'ArrowUp':    return XK_Up;
    case 'ArrowRight': return XK_Right;
    case 'ArrowDown':  return XK_Down;
    default:
      // Function keys F1–F12
      if (/^F(\d+)$/.test(key)) {
        const n = parseInt(key.slice(1), 10);
        if (n >= 1 && n <= 12) return XK_F1 + n - 1;
      }
      return null;
  }
}

// Convert a printable character to an X11 keysym.
// Latin-1: codePoint directly. Unicode > U+00FF: 0x01000000 | codePoint.
function charToKeysym(char: string): number {
  const cp = char.codePointAt(0)!;
  return cp > 0xff ? (0x01000000 | cp) : cp;
}

// ─── Keyboard icon ────────────────────────────────────────────────────────────

function IconKeyboard() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" ry="2" />
      <line x1="6" y1="10" x2="6" y2="10" strokeWidth="3" />
      <line x1="10" y1="10" x2="10" y2="10" strokeWidth="3" />
      <line x1="14" y1="10" x2="14" y2="10" strokeWidth="3" />
      <line x1="18" y1="10" x2="18" y2="10" strokeWidth="3" />
      <line x1="6" y1="14" x2="6" y2="14" strokeWidth="3" />
      <line x1="18" y1="14" x2="18" y2="14" strokeWidth="3" />
      <line x1="10" y1="14" x2="14" y2="14" strokeWidth="3" />
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

// The sentinel value kept in the textarea at all times.
// It must be a printable char so we can detect backspace by length decrease.
const SENTINEL = 'x';

export function VncMobileKeyboard({ rfbRef, status }: VncMobileKeyboardProps) {
  // Same coarse+no-hover check as Sidebar and VNC Touch Input (not maxTouchPoints).
  const isTouch = useIsCoarsePointer();
  const [active, setActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const connected = status === 'connected';

  if (!isTouch) return null;

  // ── Key forwarding ─────────────────────────────────────────────────────────

  const sendKeysym = useCallback((keysym: number) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.sendKey(keysym, '', true);
    rfb.sendKey(keysym, '', false);
  }, [rfbRef]);

  // keydown: catch named keys (backspace, enter, arrows, etc.).
  // On mobile, regular printable characters usually don't fire keydown
  // reliably, so we handle those in the `input` handler instead.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const keysym = namedKeyToKeysym(e.key);
    if (keysym !== null) {
      e.preventDefault();
      sendKeysym(keysym);
      // Restore sentinel after backspace so the next backspace is detectable
      if (e.key === 'Backspace' && textareaRef.current) {
        textareaRef.current.value = SENTINEL;
      }
    }
    // Printable characters fall through to `input` event
  }, [sendKeysym]);

  // input: fired for every character including IME/predictive text completions.
  // We compare the new textarea value against the sentinel to find what was typed.
  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    const current = el.value;

    if (current.length < SENTINEL.length) {
      // User deleted beyond the sentinel → send backspace
      sendKeysym(XK_BackSpace);
    } else if (current.length > SENTINEL.length) {
      // Extract characters added after the sentinel
      const added = current.slice(SENTINEL.length);
      for (const char of added) {
        const cp = char.codePointAt(0)!;
        if (cp === 0x0a || cp === 0x0d) {
          sendKeysym(XK_Return);
        } else {
          sendKeysym(charToKeysym(char));
        }
      }
    }

    // Always reset to sentinel so the next keystroke is detectable
    el.value = SENTINEL;
    // Keep cursor at end
    el.setSelectionRange(SENTINEL.length, SENTINEL.length);
  }, [sendKeysym]);

  // ── Toggle keyboard ────────────────────────────────────────────────────────

  const toggleKeyboard = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    if (active) {
      el.blur();
      setActive(false);
    } else {
      el.value = SENTINEL;
      el.focus();
      el.setSelectionRange(SENTINEL.length, SENTINEL.length);
      setActive(true);
    }
  }, [active]);

  // Track when keyboard is dismissed by the OS (e.g. user taps Done/away)
  const handleBlur = useCallback(() => {
    setActive(false);
  }, []);

  return (
    <>
      {/*
        Hidden-but-in-viewport textarea.
        - Must NOT be display:none or visibility:hidden (focus() won't work)
        - Must be within the visible viewport — iOS Safari won't open the soft
          keyboard for elements positioned off-screen (e.g. left:-9999px)
        - font-size:16px prevents iOS from auto-zooming the page on focus
        - pointer-events:none is fine; we focus() programmatically
      */}
      <textarea
        ref={textareaRef}
        defaultValue={SENTINEL}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onBlur={handleBlur}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '1px',
          height: '1px',
          opacity: 0,
          fontSize: '16px', // prevents iOS auto-zoom on focus
          border: 'none',
          outline: 'none',
          padding: 0,
          pointerEvents: 'none',
        }}
      />

      {/* Floating action button — always rendered, useful on any touch device */}
      <button
        onClick={toggleKeyboard}
        disabled={!connected}
        title={active ? 'Hide keyboard' : 'Show keyboard'}
        aria-label={active ? 'Hide keyboard' : 'Show keyboard'}
        className={`
          absolute bottom-4 left-1/2 -translate-x-1/2
          flex items-center justify-center
          w-12 h-12 rounded-full shadow-lg z-10
          transition-colors duration-150
          disabled:opacity-30 disabled:pointer-events-none
          ${active
            ? 'bg-accent text-white ring-2 ring-accent/50'
            : 'bg-black/60 text-gray-300 hover:bg-black/80 hover:text-white'}
        `}
      >
        <IconKeyboard />
      </button>
    </>
  );
}
