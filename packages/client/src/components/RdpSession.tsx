import { useEffect, useRef, useState, useCallback } from 'react';
import type { Tab } from '../pages/MainLayout';
import { getWsTicket } from '../lib/wsTicket';
import { DisconnectOverlay } from './DisconnectOverlay';
import { RdpMobileKeyboard } from './RdpMobileKeyboard';
import { RdpClipboardService } from '../services/rdpClipboard';

let rdpInitialized = false;
let Backend: Record<string, unknown> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let displayControl: ((enable: boolean) => any) | null = null;

async function initRdp() {
  if (rdpInitialized) return;
  const rdpModule = await import('@devolutions/iron-remote-desktop-rdp');
  await rdpModule.init('info');
  Backend = rdpModule.Backend as Record<string, unknown>;
  displayControl = rdpModule.displayControl;
  rdpInitialized = true;
}

// PS/2 Set-1 scancode → KeyboardEvent.code mapping
const SCANCODE_TO_CODE: Record<number, string> = {
  0x0001:'Escape',0x0002:'Digit1',0x0003:'Digit2',0x0004:'Digit3',0x0005:'Digit4',
  0x0006:'Digit5',0x0007:'Digit6',0x0008:'Digit7',0x0009:'Digit8',0x000A:'Digit9',
  0x000B:'Digit0',0x000C:'Minus',0x000D:'Equal',0x000E:'Backspace',0x000F:'Tab',
  0x0010:'KeyQ',0x0011:'KeyW',0x0012:'KeyE',0x0013:'KeyR',0x0014:'KeyT',
  0x0015:'KeyY',0x0016:'KeyU',0x0017:'KeyI',0x0018:'KeyO',0x0019:'KeyP',
  0x001A:'BracketLeft',0x001B:'BracketRight',0x001C:'Enter',0x001D:'ControlLeft',
  0x001E:'KeyA',0x001F:'KeyS',0x0020:'KeyD',0x0021:'KeyF',0x0022:'KeyG',
  0x0023:'KeyH',0x0024:'KeyJ',0x0025:'KeyK',0x0026:'KeyL',0x0027:'Semicolon',
  0x0028:'Quote',0x0029:'Backquote',0x002A:'ShiftLeft',0x002B:'Backslash',
  0x002C:'KeyZ',0x002D:'KeyX',0x002E:'KeyC',0x002F:'KeyV',0x0030:'KeyB',
  0x0031:'KeyN',0x0032:'KeyM',0x0033:'Comma',0x0034:'Period',0x0035:'Slash',
  0x0036:'ShiftRight',0x0037:'NumpadMultiply',0x0038:'AltLeft',0x0039:'Space',
  0x003A:'CapsLock',0x003B:'F1',0x003C:'F2',0x003D:'F3',0x003E:'F4',
  0x003F:'F5',0x0040:'F6',0x0041:'F7',0x0042:'F8',0x0043:'F9',0x0044:'F10',
  0x0045:'Pause',0x0046:'ScrollLock',0x0047:'Numpad7',0x0048:'Numpad8',
  0x0049:'Numpad9',0x004A:'NumpadSubtract',0x004B:'Numpad4',0x004C:'Numpad5',
  0x004D:'Numpad6',0x004E:'NumpadAdd',0x004F:'Numpad1',0x0050:'Numpad2',
  0x0051:'Numpad3',0x0052:'Numpad0',0x0053:'NumpadDecimal',0x0056:'IntlBackslash',
  0x0057:'F11',0x0058:'F12',0x0059:'NumpadEqual',
  0x0064:'F13',0x0065:'F14',0x0066:'F15',0x0067:'F16',0x0068:'F17',
  0x0069:'F18',0x006A:'F19',0x006B:'F20',0x006C:'F21',0x006D:'F22',
  0x006E:'F23',0x0070:'KanaMode',0x0071:'Lang2',0x0072:'Lang1',0x0073:'IntlRo',
  0x0076:'F24',0x0079:'Convert',0x007B:'NonConvert',0x007D:'IntlYen',0x007E:'NumpadComma',
  0xE010:'MediaTrackPrevious',0xE019:'MediaTrackNext',0xE01C:'NumpadEnter',
  0xE01D:'ControlRight',0xE022:'MediaPlayPause',0xE024:'MediaStop',
  0xE032:'BrowserHome',0xE035:'NumpadDivide',0xE037:'PrintScreen',
  0xE038:'AltRight',0xE045:'NumLock',0xE047:'Home',0xE048:'ArrowUp',
  0xE049:'PageUp',0xE04B:'ArrowLeft',0xE04D:'ArrowRight',0xE04F:'End',
  0xE050:'ArrowDown',0xE051:'PageDown',0xE052:'Insert',0xE053:'Delete',
  0xE05B:'MetaLeft',0xE05C:'MetaRight',0xE05D:'ContextMenu',
  0xE06C:'LaunchMail',0xE020:'AudioVolumeMute',0xE02E:'AudioVolumeDown',0xE030:'AudioVolumeUp',
};
const CODE_TO_SCANCODE: Record<string, number> = Object.fromEntries(
  Object.entries(SCANCODE_TO_CODE).map(([sc, code]) => [code, Number(sc)])
);

const RESIZE_DEBOUNCE_MS = 150;

// Keys locked via Keyboard Lock API when in fullscreen.
// This lets the browser forward shortcuts it would normally intercept
// (Ctrl+Tab, Ctrl+W, Ctrl+T, F11, etc.) to our keydown handler instead.
// OS-level shortcuts (Alt+Tab, Win+R, Win+D) remain with the OS regardless.
const KEYBOARD_LOCK_KEYS = [
  'Tab', 'Escape', 'MetaLeft', 'MetaRight',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
];

interface RdpSessionProps {
  tab: Tab;
  onStatusChange: (tabId: string, status: Tab['status']) => void;
  onClose: (tabId: string) => void;
}

export function RdpSession({ tab, onStatusChange, onClose }: RdpSessionProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const rdpSessionIdRef = useRef<string | null>(null);
  const pushEventRef = useRef<((type: 'click' | 'key' | 'move') => void) | null>(null);
  const flushEventsRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const [disconnected, setDisconnected] = useState(false);
  const [disconnectMessage, setDisconnectMessage] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fullscreen + Keyboard Lock ─────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      outerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    let fsResizeTimer: ReturnType<typeof setTimeout> | null = null;

    const onFsChange = () => {
      const inFs = !!document.fullscreenElement;
      setIsFullscreen(inFs);
      if (inFs) {
        // Lock browser-intercepted keys so they pass through to our keydown handler
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).keyboard?.lock(KEYBOARD_LOCK_KEYS).catch(() => {});
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).keyboard?.unlock?.();
      }
      // Resize after the browser finishes layout for the new fullscreen state.
      // rAF is not reliable here — fullscreenchange can fire before the element's
      // dimensions have settled. A 100 ms timeout ensures we read the correct size.
      if (fsResizeTimer) clearTimeout(fsResizeTimer);
      fsResizeTimer = setTimeout(() => {
        if (!sessionRef.current || !containerRef.current) return;
        const w = containerRef.current.clientWidth;
        const h = Math.max(containerRef.current.clientHeight, 1);
        if (w > 0 && h > 0) sessionRef.current.resize(w, h);
      }, 100);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      if (fsResizeTimer) clearTimeout(fsResizeTimer);
    };
  }, []);

  // ── Auto-open panel on connect, close after 3 s ────────────────────────────
  useEffect(() => {
    if (status === 'Connected') {
      setPanelOpen(true);
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
      autoCloseTimer.current = setTimeout(() => setPanelOpen(false), 3000);
    }
    return () => {
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
    };
  }, [status]);

  // ── Reconnect handler ──────────────────────────────────────────────────────
  const handleReconnect = useCallback(() => {
    setDisconnected(false);
    setDisconnectMessage('');
    setStatus('Initializing...');
    setReconnectCount((n) => n + 1);
  }, []);

  // ── RDP session ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let sessionRevoked = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let canvasStyleGuard: MutationObserver | null = null;

    // Suppress disconnect overlay when session is revoked (global handler redirects to login)
    const onRevoked = () => { sessionRevoked = true; };
    window.addEventListener('gatwy:unauthorized', onRevoked);

    const showDisconnect = (msg: string) => {
      if (sessionRevoked) return;
      setDisconnected(true);
      setDisconnectMessage(msg);
      onStatusChange(tab.id, 'disconnected');
    };

    const run = async () => {
      if (!containerRef.current) return;

      try {
        setStatus('Loading RDP module...');
        await initRdp();
        if (cancelled) return;

        setStatus('Fetching connection info...');
        const sessionRes = await fetch(`/api/v1/connections/${tab.connectionId}/session`, {
          credentials: 'include',
        });
        if (!sessionRes.ok) throw new Error('Failed to fetch connection credentials');
        const sessionInfo: { host: string; port: number; username: string; password: string } =
          await sessionRes.json();
        if (cancelled) return;

        const container = containerRef.current!;
        const canvas = document.createElement('canvas');
        // Use absolute positioning so the canvas always fills containerRef
        // regardless of canvas.height (intrinsic pixel height). Without this,
        // browsers may resolve height:100% against the canvas's intrinsic height
        // (set by IronRDP) rather than the flex-allocated container height.
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.tabIndex = 0;
        canvas.width = container.clientWidth || 1280;
        canvas.height = container.clientHeight || 720;
        container.innerHTML = '';
        container.appendChild(canvas);

        // ── Intercept getContext to force preserveDrawingBuffer=true ─────────
        // IronRDP calls canvas.getContext('webgl2'/'webgl') internally when
        // renderCanvas() is invoked. By default WebGL contexts clear their
        // framebuffer after compositing (preserveDrawingBuffer=false), which
        // makes captureStream() read an already-cleared buffer → blank video.
        // We override getContext before IronRDP can call it so the context is
        // created with preserveDrawingBuffer=true, letting captureStream() read
        // the actual rendered frame on the original canvas — no mirror needed.
        const origGetContext = canvas.getContext.bind(canvas);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (canvas as any).getContext = function(contextId: string, opts?: WebGLContextAttributes) {
          if (contextId === 'webgl2' || contextId === 'webgl') {
            opts = { ...opts, preserveDrawingBuffer: true };
          }
          return origGetContext(contextId as any, opts);
        };

        // IronRDP sets absolute pixel values on canvas.style.width/height during
        // resize (e.g. '1920px'/'1080px'). After fullscreen exit the container
        // shrinks but the canvas CSS stays at the fullscreen size, causing the
        // bottom of the desktop (taskbar) to be clipped by overflow-hidden.
        // Guard against this by resetting to 100%×100% whenever IronRDP changes
        // the style attribute. This is safe — IronRDP uses canvas.width/height
        // (pixel properties) for WebGL rendering, not the CSS style properties.
        canvasStyleGuard = new MutationObserver(() => {
          if (canvas.style.position !== 'absolute') canvas.style.position = 'absolute';
          if (canvas.style.top !== '0px') canvas.style.top = '0';
          if (canvas.style.left !== '0px') canvas.style.left = '0';
          if (canvas.style.width !== '100%') canvas.style.width = '100%';
          if (canvas.style.height !== '100%') canvas.style.height = '100%';
        });
        canvasStyleGuard.observe(canvas, { attributes: true, attributeFilter: ['style'] });

        const ticket = await getWsTicket();
        if (cancelled) return;

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/ws/rdp-raw?ticket=${encodeURIComponent(ticket)}&connectionId=${encodeURIComponent(tab.connectionId)}`;

        setStatus('Connecting...');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { SessionBuilder, DesktopSize, ClipboardData } = Backend as any;

        // ── Clipboard Service (replaces custom clipboard handling) ───────────
        const clipboardService = new RdpClipboardService({ ClipboardData });
        await clipboardService.init();

        // ── Software cursor state (for recording compositing) ────────────────
        // The CSS cursor is a hardware overlay and never appears in captureStream.
        // IronRDP provides the cursor as a data URL via setCursorStyleCallback;
        // we keep a decoded HTMLImageElement + hotspot + latest mouse position so
        // the recording compositor can draw the cursor onto each frame.
        // Initialized below to defaultArrowImg once that is built.
        let recCursorImg: HTMLImageElement | null = null; // reassigned after defaultArrowImg
        let recCursorHX = 0;
        let recCursorHY = 0;
        let recMouseX = 0;
        let recMouseY = 0;
        let recCursorVisible = true;

        // Pre-draw a fallback arrow cursor for when IronRDP reports kind='default'.
        // Without this, the cursor disappears whenever the remote desktop switches
        // to a system cursor (text, resize handles, etc.) — the CSS cursor shows
        // the OS arrow but the compositor sees null and draws nothing.
        const defaultArrowImg = (() => {
          const c = document.createElement('canvas');
          c.width = 14; c.height = 20;
          const cx = c.getContext('2d')!;
          cx.strokeStyle = '#000';
          cx.fillStyle = '#fff';
          cx.lineWidth = 1.5;
          cx.beginPath();
          cx.moveTo(1, 1);
          cx.lineTo(1, 15);
          cx.lineTo(4, 12);
          cx.lineTo(6.5, 18);
          cx.lineTo(8.5, 17);
          cx.lineTo(6, 11);
          cx.lineTo(10, 11);
          cx.closePath();
          cx.fill();
          cx.stroke();
          const img = new Image();
          img.src = c.toDataURL();
          return img;
        })();
        // Start with the fallback arrow so cursor is visible from the very first frame,
        // even before setCursorStyleCallback has fired.
        recCursorImg = defaultArrowImg;

        // ── Click ripple effect (for recording) ──────────────────────────────
        // Draws an expanding, fading circle on each mouse click so reviewers
        // can see exactly where and when clicks happened during playback.
        interface ClickRipple { x: number; y: number; t: number; color: string }
        const RIPPLE_DURATION = 400; // ms
        const RIPPLE_MAX_R = 28;     // max radius in canvas pixels
        const RIPPLE_COLORS: Record<number, string> = {
          0: 'rgba(59,130,246,A)',  // left  — blue
          1: 'rgba(156,163,175,A)', // middle — gray
          2: 'rgba(239,68,68,A)',   // right — red
        };
        const clickRipples: ClickRipple[] = [];

        const onRecMouseMove = (e: MouseEvent) => {
          const rect = canvas.getBoundingClientRect();
          const scaleX = canvas.width / rect.width;
          const scaleY = canvas.height / rect.height;
          recMouseX = (e.clientX - rect.left) * scaleX;
          recMouseY = (e.clientY - rect.top) * scaleY;
        };
        canvas.addEventListener('mousemove', onRecMouseMove);

        const session = await new SessionBuilder()
          .username(sessionInfo.username)
          .password(sessionInfo.password)
          .destination(`${sessionInfo.host}:${sessionInfo.port}`)
          .proxyAddress(wsUrl)
          .authToken(ticket)
          .desktopSize(new DesktopSize(canvas.width, canvas.height))
          .renderCanvas(canvas)
          .setCursorStyleCallbackContext(null)
          .setCursorStyleCallback(
            (kind: string, data: string | undefined, hx: number, hy: number) => {
              // Update CSS cursor for the live session
              if (kind === 'none') {
                canvas.style.cursor = 'none';
                recCursorVisible = false;
              } else if (kind === 'url' && data) {
                canvas.style.cursor = `url(${data}) ${hx} ${hy}, auto`;
                recCursorVisible = true;
                recCursorHX = hx;
                recCursorHY = hy;
                // Decode the cursor image for the recording compositor
                const img = new Image();
                img.src = data;
                recCursorImg = img;
              } else {
                canvas.style.cursor = 'default';
                recCursorVisible = true;
                recCursorHX = 0;
                recCursorHY = 0;
                recCursorImg = defaultArrowImg;
              }
            },
          )
          .remoteClipboardChangedCallback(clipboardService.onRemoteClipboardChanged)
          .forceClipboardUpdateCallback(clipboardService.onForceClipboardUpdate)
          .extension(displayControl!(true))
          .connect();

        if (cancelled) {
          session.shutdown();
          return;
        }

        sessionRef.current = session;
        setStatus('Connected');
        onStatusChange(tab.id, 'connected');

        // ── RDP recording via compositor canvas + MediaRecorder ──────────────
        // The CSS cursor is a hardware overlay invisible to captureStream.
        // We composite the WebGL frame + decoded cursor image onto a 2D canvas
        // each rAF tick and capture that compositor instead.
        try {
          const recRes = await fetch('/api/v1/sessions/rdp-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ connectionId: tab.connectionId }),
          });
          if (recRes.ok) {
            const recData = await recRes.json() as { sessionId: string | null; shouldRecord: boolean };
            if (recData.shouldRecord && recData.sessionId) {
              rdpSessionIdRef.current = recData.sessionId;
              const mimeType = MediaRecorder.isTypeSupported('video/webm; codecs=vp9')
                ? 'video/webm; codecs=vp9'
                : 'video/webm';

              // Compositor: 2D canvas that merges the WebGL frame + software cursor
              const compositor = document.createElement('canvas');
              compositor.width = canvas.width;
              compositor.height = canvas.height;
              const ctx2d = compositor.getContext('2d')!;

              // Keep compositor size in sync when IronRDP resizes the RDP canvas
              const compSizeObserver = new MutationObserver(() => {
                if (compositor.width !== canvas.width) compositor.width = canvas.width;
                if (compositor.height !== canvas.height) compositor.height = canvas.height;
              });
              compSizeObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });

              let recRafId = 0;
              function drawCompositeFrame() {
                // Copy RDP frame (preserveDrawingBuffer=true ensures it's readable)
                ctx2d.drawImage(canvas, 0, 0);
                // Draw click ripples
                const now = performance.now();
                for (let i = clickRipples.length - 1; i >= 0; i--) {
                  const r = clickRipples[i];
                  const elapsed = now - r.t;
                  if (elapsed > RIPPLE_DURATION) { clickRipples.splice(i, 1); continue; }
                  const progress = elapsed / RIPPLE_DURATION;
                  const radius = RIPPLE_MAX_R * progress;
                  const alpha = (1 - progress) * 0.6;
                  const color = r.color.replace('A', String(alpha));
                  ctx2d.beginPath();
                  ctx2d.arc(r.x, r.y, radius, 0, Math.PI * 2);
                  ctx2d.strokeStyle = color;
                  ctx2d.lineWidth = 2;
                  ctx2d.stroke();
                  // Small filled dot at center
                  ctx2d.beginPath();
                  ctx2d.arc(r.x, r.y, 3, 0, Math.PI * 2);
                  ctx2d.fillStyle = r.color.replace('A', String(alpha * 0.8));
                  ctx2d.fill();
                }
                // Draw software cursor on top
                if (recCursorVisible && recCursorImg?.complete && recCursorImg.naturalWidth > 0) {
                  ctx2d.drawImage(recCursorImg, recMouseX - recCursorHX, recMouseY - recCursorHY);
                }
                recRafId = requestAnimationFrame(drawCompositeFrame);
              }
              recRafId = requestAnimationFrame(drawCompositeFrame);

              const stream = compositor.captureStream(10);
              const mr = new MediaRecorder(stream, { mimeType });

              // Track the last chunk upload so finalize waits for it
              let lastChunkFetch: Promise<void> = Promise.resolve();

              mr.ondataavailable = (e) => {
                if (e.data.size > 0 && rdpSessionIdRef.current) {
                  lastChunkFetch = e.data.arrayBuffer().then((buf) => {
                    return fetch(`/api/v1/sessions/${rdpSessionIdRef.current}/recording/chunk`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/octet-stream' },
                      credentials: 'include',
                      body: buf,
                    }).then(() => {}).catch(() => {});
                  }).catch(() => {});
                }
              };

              // onstop fires after the last ondataavailable — wait for its upload then finalize
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (mr as any)._finalizeOnStop = (sessionId: string) => {
                mr.onstop = () => {
                  lastChunkFetch.finally(() => {
                    fetch(`/api/v1/sessions/${sessionId}/recording/finalize`, {
                      method: 'POST',
                      credentials: 'include',
                    }).catch(() => {});
                  });
                };
              };

              mr.start(5000);
              mediaRecorderRef.current = mr;

              // ── Activity event capture for playback heatmap ──────────
              const recStartTime = performance.now();
              let eventBuffer: { elapsed: number; type: string }[] = [];
              function pushEvent(type: 'click' | 'key' | 'move') {
                eventBuffer.push({ elapsed: (performance.now() - recStartTime) / 1000, type });
              }
              function flushEvents() {
                if (eventBuffer.length === 0 || !rdpSessionIdRef.current) return;
                const batch = eventBuffer;
                eventBuffer = [];
                fetch(`/api/v1/sessions/${rdpSessionIdRef.current}/recording/events`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify(batch),
                }).catch(() => {});
              }
              const eventFlushInterval = setInterval(flushEvents, 5000);

              // Store helpers in refs for input handlers to call
              pushEventRef.current = pushEvent;
              flushEventsRef.current = () => { clearInterval(eventFlushInterval); flushEvents(); };
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (mr as any)._flushAndStop = flushEventsRef.current;

              // Store cleanup refs on the mr object for teardown
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (mr as any)._recRafId = recRafId;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (mr as any)._compSizeObserver = compSizeObserver;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (mr as any)._stopRaf = () => { cancelAnimationFrame(recRafId); compSizeObserver.disconnect(); };
            }
          }
        } catch { /* recording unavailable — ignore */ }

        // Clean up the mousemove listener (used for cursor compositing)
        // when session.run() returns — do it in finally block via the session end path

        // ── Auto-resize (debounced) ────────────────────────────────────────
        resizeObserver = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (!sessionRef.current || !containerRef.current) return;
            const w = containerRef.current.clientWidth;
            const h = Math.max(containerRef.current.clientHeight, 1);
            if (w <= 0 || h <= 0) return;
            sessionRef.current.resize(w, h);
          }, RESIZE_DEBOUNCE_MS);
        });
        resizeObserver.observe(container);

        // ── Input event wiring ─────────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { InputTransaction, DeviceEvent } = Backend as any;

        let lastMoveEventTime = 0;

        const applyEvents = (...events: unknown[]) => {
          const tx = new InputTransaction();
          events.forEach((e) => tx.addEvent(e));
          session.applyInputs(tx);
        };

        const onMouseMove = (e: MouseEvent) => {
          const scaleX = canvas.width / canvas.clientWidth;
          const scaleY = canvas.height / canvas.clientHeight;
          applyEvents(DeviceEvent.mouseMove(Math.round(e.offsetX * scaleX), Math.round(e.offsetY * scaleY)));
          // Throttled activity tracking for heatmap (every 500ms)
          const now = performance.now();
          if (now - lastMoveEventTime > 500) {
            pushEventRef.current?.('move');
            lastMoveEventTime = now;
          }
        };

        const onMouseDown = (e: MouseEvent) => {
          canvas.focus();
          e.preventDefault();
          applyEvents(DeviceEvent.mouseButtonPressed(e.button));
          // Record click ripple for the compositor
          const colorTpl = RIPPLE_COLORS[e.button] ?? RIPPLE_COLORS[0];
          clickRipples.push({ x: recMouseX, y: recMouseY, t: performance.now(), color: colorTpl });
          pushEventRef.current?.('click');
        };
        const onMouseUp = (e: MouseEvent) => {
          e.preventDefault();
          applyEvents(DeviceEvent.mouseButtonReleased(e.button));
        };
        const onWheel = (e: WheelEvent) => {
          e.preventDefault();
          const isVertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
          const delta = isVertical ? e.deltaY : e.deltaX;
          applyEvents(DeviceEvent.wheelRotations(isVertical, -delta, 0));
        };

        // Keyboard — capture phase so our preventDefault fires before browser shortcuts.
        // Ctrl+C / Ctrl+V are excluded so browser copy/paste events still fire for
        // the clipboard bridge. OS-level shortcuts (Alt+Tab, Win+*) are unreachable
        // from JS; use fullscreen + Keyboard Lock for browser-level ones (Ctrl+Tab etc.).
        const onKey = (e: KeyboardEvent) => {
          // Don't capture keyboard when a text input elsewhere on the page has focus
          // (e.g. the connection modal, search boxes, etc.)
          const active = document.activeElement;
          if (
            active &&
            active !== canvas &&
            // Allow events through when the active element is our mobile keyboard
            // textarea (identified by data-mobile-keyboard attribute).
            (active as HTMLElement).getAttribute('data-mobile-keyboard') !== 'true' &&
            (active.tagName === 'INPUT' ||
              active.tagName === 'TEXTAREA' ||
              active.tagName === 'SELECT' ||
              (active as HTMLElement).isContentEditable)
          ) return;

          const isBrowserClipboard =
            (e.code === 'KeyC' || e.code === 'KeyV') && e.ctrlKey && !e.altKey && !e.metaKey;
          if (!isBrowserClipboard) e.preventDefault();

          const pressed = e.type === 'keydown';
          if (pressed) {
            pushEventRef.current?.('key');
          }
          const scancode = CODE_TO_SCANCODE[e.code];
          if (scancode !== undefined) {
            applyEvents(pressed ? DeviceEvent.keyPressed(scancode) : DeviceEvent.keyReleased(scancode));
          } else if (pressed && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            applyEvents(DeviceEvent.unicodePressed(e.key));
          } else if (!pressed && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            applyEvents(DeviceEvent.unicodeReleased(e.key));
          }
        };

        const onBlur = () => session.releaseAllInputs();
        const onContextMenu = (e: Event) => e.preventDefault();

        // Start clipboard monitoring now that session is ready
        clipboardService.setSession(session);
        clipboardService.startMonitoring();

        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('contextmenu', onContextMenu);
        // Capture phase: our handler runs before the browser acts on shortcuts
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onKey, true);
        window.addEventListener('blur', onBlur, false);

        await session.run();

        clipboardService.dispose();
        resizeObserver?.disconnect();
        if (resizeTimer) clearTimeout(resizeTimer);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mousedown', onMouseDown);
        canvas.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onContextMenu);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keyup', onKey, true);
        window.removeEventListener('blur', onBlur);

        if (!cancelled) showDisconnect('The remote session has ended.');
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = err as any;
          let msg: string;
          if (e && typeof e.kind === 'function') {
            const kindNum: number = e.kind();
            const kindNames: Record<number, string> = {
              0: 'General', 1: 'WrongPassword', 2: 'LogonFailure',
              3: 'AccessDenied', 4: 'RDCleanPath', 5: 'ProxyConnect', 6: 'NegotiationFailure',
            };
            const kindName = kindNames[kindNum] ?? `Unknown(${kindNum})`;
            const backtrace = typeof e.backtrace === 'function' ? e.backtrace() : '';

            // Translate internal error codes into user-friendly messages
            if (kindNum === 4 /* RDCleanPath */) {
              msg = 'Could not establish a secure connection to the remote host. '
                + 'This usually means the server\'s TLS certificate is self-signed or untrusted. '
                + 'Try editing the connection and disabling "Certificate validation".';
            } else if (kindNum === 1 /* WrongPassword */) {
              msg = 'Authentication failed — the username or password is incorrect.';
            } else if (kindNum === 2 /* LogonFailure */) {
              msg = 'Logon failed — check the credentials or verify the account is not locked.';
            } else if (kindNum === 3 /* AccessDenied */) {
              msg = 'Access denied — the account does not have permission to log on via RDP.';
            } else if (kindNum === 5 /* ProxyConnect */) {
              msg = 'Could not reach the remote host. Check that the hostname and port are correct and the server is online.';
            } else if (kindNum === 6 /* NegotiationFailure */) {
              msg = 'Protocol negotiation failed — the remote host may not support the required security level.';
            } else {
              msg = `Connection error [${kindName}]${backtrace ? ': ' + backtrace : ''}`;
            }
          } else {
            msg = err instanceof Error ? err.message : String(err);
          }
          console.error('[RDP] Session error:', err, msg);
          showDisconnect(msg);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      window.removeEventListener('gatwy:unauthorized', onRevoked);
      resizeObserver?.disconnect();
      canvasStyleGuard?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      // Stop the compositor rAF loop and size observer used for cursor recording
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediaRecorderRef.current as any)?._stopRaf?.();

      const capturedSessionId = rdpSessionIdRef.current;
      rdpSessionIdRef.current = null;

      const mr = mediaRecorderRef.current;
      mediaRecorderRef.current = null;

      // Flush remaining activity events before stopping
      flushEventsRef.current?.();
      pushEventRef.current = null;
      flushEventsRef.current = null;

      if (mr && mr.state !== 'inactive') {
        // Wire up onstop BEFORE calling stop() so it fires after the last chunk upload
        if (capturedSessionId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (mr as any)._finalizeOnStop?.(capturedSessionId);
        }
        mr.stop();
      } else if (capturedSessionId) {
        // Recorder never started (recording disabled) — still mark session ended
        fetch(`/api/v1/sessions/${capturedSessionId}/recording/finalize`, {
          method: 'POST',
          credentials: 'include',
        }).catch(() => {});
      }

      if (sessionRef.current) {
        try { sessionRef.current.shutdown(); } catch { /* ignore */ }
        sessionRef.current = null;
      }
    };
    // reconnectCount is intentionally included: incrementing it re-runs this effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.connectionId, onStatusChange, reconnectCount]);

  return (
    <div ref={outerRef} className="absolute inset-0 flex flex-col bg-black overflow-hidden">
      <div ref={containerRef} className="flex-1 w-full relative" />

      {/* Mobile soft-keyboard FAB — touch devices only */}
      <RdpMobileKeyboard connected={status === 'Connected'} />

      {/* Disconnect overlay */}
      <DisconnectOverlay
        show={disconnected}
        message={disconnectMessage}
        onExit={() => onClose(tab.id)}
        onReconnect={handleReconnect}
      />

      {/* Right-side flyout panel */}
      {/* Backdrop — closes panel when clicking the session canvas */}
      {panelOpen && (
        <div
          className="absolute inset-0 z-10"
          onClick={() => setPanelOpen(false)}
        />
      )}

      {/* Tab trigger — always visible on the right edge */}
      <button
        onClick={() => setPanelOpen((o) => !o)}
        title="Session controls"
        className="absolute right-0 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center justify-center gap-2 w-7 py-4 bg-black/60 hover:bg-black/80 text-gray-400 hover:text-white transition-colors rounded-l-md"
        style={{ writingMode: 'vertical-rl' }}
      >
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            disconnected ? 'bg-red-500' : status === 'Connected' ? 'bg-green-500' : 'bg-yellow-500'
          }`}
          style={{ writingMode: 'horizontal-tb' }}
        />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ writingMode: 'horizontal-tb' }} className={`transition-transform ${panelOpen ? 'rotate-180' : ''}`}>
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      {/* Flyout panel */}
      <div
        className={`absolute right-5 top-1/2 -translate-y-1/2 z-20 w-52 bg-surface/95 backdrop-blur-xs border border-border rounded-xl shadow-2xl flex flex-col gap-1 p-3 transition-all duration-200 ${
          panelOpen ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 translate-x-4 pointer-events-none'
        }`}
      >
        {/* Status */}
        <div className="flex items-center gap-2 px-1 py-1.5 border-b border-border mb-1">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              disconnected ? 'bg-red-500' : status === 'Connected' ? 'bg-green-500' : 'bg-yellow-500'
            }`}
          />
          <span className="text-sm text-text-primary font-medium truncate">
            {disconnected ? 'Disconnected' : status}
          </span>
        </div>

        {/* Connection name */}
        <div className="px-1 py-0.5">
          <p className="text-xs text-text-secondary truncate">{tab.name}</p>
        </div>

        {/* Fullscreen */}
        <button
          onClick={() => { toggleFullscreen(); setPanelOpen(false); }}
          className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-text-primary text-sm transition-colors text-left w-full"
        >
          {isFullscreen ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
              Exit Fullscreen
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
              Fullscreen
            </>
          )}
        </button>

        {/* Keyboard note */}
        {!isFullscreen && (
          <p className="text-xs text-text-secondary px-2 pb-1 leading-relaxed">
            Enter fullscreen to capture Ctrl+Tab, F-keys and other browser shortcuts.
          </p>
        )}
      </div>
    </div>
  );
}
