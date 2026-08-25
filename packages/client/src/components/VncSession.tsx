import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { getWsTicket } from '../lib/wsTicket';
import { DisconnectOverlay } from './DisconnectOverlay';
import { VncControlPanel } from './VncControlPanel';
import { VncMobileKeyboard } from './VncMobileKeyboard';
import { applyVncPointerMap } from '../lib/vncPointerMap';

interface VncSessionProps {
  connectionId: string;
  connectionName: string;
  isActive: boolean;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void;
  onClose?: (connectionId: string) => void;
}

export function VncSession({ connectionId, connectionName, isActive, onStatusChange, onClose }: VncSessionProps) {
  const sessionRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<import('@novnc/novnc').default | null>(null);
  const { token } = useAuth();
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);

  function setAndNotify(s: 'connecting' | 'connected' | 'disconnected') {
    setStatus(s);
    onStatusChange?.(s);
  }

  const handleReconnect = useCallback(() => {
    setErrorMsg('');
    setReconnectCount((n) => n + 1);
  }, []);

  const handleDisconnect = useCallback(() => {
    if (rfbRef.current) {
      try { rfbRef.current.disconnect(); } catch { /* ignore */ }
    }
    onClose?.(connectionId);
  }, [connectionId, onClose]);

  useEffect(() => {
    if (!isActive) return;
    if (!containerRef.current || !token) return;

    let cancelled = false;
    let sessionRevoked = false;
    let rfb: import('@novnc/novnc').default | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const onRevoked = () => { sessionRevoked = true; };
    window.addEventListener('gatwy:unauthorized', onRevoked);

    async function connect() {
      try {
        // Fetch credentials from session endpoint (username required for macOS ARD / type 30)
        const res = await fetch(`/api/v1/connections/${connectionId}/session`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Failed to fetch connection credentials');
        const info: { username?: string; password?: string; extraConfig?: unknown } = await res.json();
        if (cancelled) return;

        // noVNC 1.7.0 ships as pure ESM so a direct dynamic import works
        // correctly.  We import via the novnc-rfb wrapper for abstraction.
        const { default: RFB } = await import('../lib/novnc-rfb');
        if (cancelled) return;

        const ticket = await getWsTicket();
        if (cancelled) return;

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/ws/vnc/${connectionId}?ticket=${encodeURIComponent(ticket)}`;

        const container = containerRef.current!;
        container.innerHTML = '';

        // noVNC's Websock.attach() validates the channel by checking
        //   Object.keys(channel) + Object.getOwnPropertyNames(Object.getPrototypeOf(channel))
        // In some browsers, native WebSocket properties (send, binaryType, onopen, etc.)
        // live deeper in the prototype chain and fail this check ("Raw channel missing
        // property: send"). Use a plain-object wrapper: all required props are own
        // enumerable properties that Object.keys() reliably finds.
        const nativeWs = new WebSocket(wsUrl);
        const channel = {
          send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => nativeWs.send(data as string),
          close: (code?: number, reason?: string) => nativeWs.close(code, reason),
          get binaryType(): BinaryType { return nativeWs.binaryType; },
          set binaryType(v: BinaryType) { nativeWs.binaryType = v; },
          get onerror() { return nativeWs.onerror; },
          set onerror(v: ((this: WebSocket, ev: Event) => unknown) | null) { nativeWs.onerror = v; },
          get onmessage() { return nativeWs.onmessage; },
          set onmessage(v: ((this: WebSocket, ev: MessageEvent) => unknown) | null) { nativeWs.onmessage = v; },
          get onopen() { return nativeWs.onopen; },
          set onopen(v: ((this: WebSocket, ev: Event) => unknown) | null) { nativeWs.onopen = v; },
          get onclose() { return nativeWs.onclose; },
          set onclose(v: ((this: WebSocket, ev: CloseEvent) => unknown) | null) { nativeWs.onclose = v; },
          get protocol(): string { return nativeWs.protocol; },
          get readyState(): number { return nativeWs.readyState; },
        };

        // Always pass username + password when available. macOS Screen Sharing
        // prefers Apple ARD auth (security type 30), which requires both. If we
        // only send password, noVNC fires credentialsrequired and waits forever
        // because Gatwy never handled that event (infinite "Connecting...").
        const username = info.username ?? '';
        const password = info.password ?? '';
        const hasCreds = Boolean(username || password);

        rfb = new RFB(container, channel as unknown as string, {
          credentials: hasCreds ? { username, password } : undefined,
        });

        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfbRef.current = rfb;

        // noVNC observes its own _screen element (100%×100% inside container).
        // When the control panel opens/closes, the container flex width changes
        // and noVNC's internal observer *should* fire — but CSS-transition-driven
        // reflows are sometimes missed in certain browser engines.  Add our own
        // ResizeObserver on containerRef to reliably poke _updateScale() by
        // re-assigning scaleViewport (the setter always calls _updateScale()).
        resizeObserver = new ResizeObserver(() => {
          if (rfbRef.current) {
            rfbRef.current.scaleViewport = rfbRef.current.scaleViewport;
          }
        });
        resizeObserver.observe(container);

        rfb.addEventListener('connect', () => {
          if (rfb) applyVncPointerMap(rfb, info.extraConfig);
          if (!cancelled) setAndNotify('connected');
        });

        rfb.addEventListener('disconnect', (e: Event) => {
          if (!cancelled && !sessionRevoked) {
            const detail = (e as CustomEvent).detail;
            if (detail?.clean === false) {
              setErrorMsg('Connection lost unexpectedly');
            }
            setAndNotify('disconnected');
          }
        });

        rfb.addEventListener('securityfailure', () => {
          if (!cancelled && !sessionRevoked) {
            setErrorMsg('VNC authentication failed');
            setAndNotify('disconnected');
          }
        });

        // noVNC pauses the handshake until sendCredentials() is called.
        // ARD / Unix logon / RA2 can request username+password mid-handshake.
        rfb.addEventListener('credentialsrequired', (e: Event) => {
          if (cancelled || sessionRevoked) return;
          const types = (e as CustomEvent<{ types?: string[] }>).detail?.types ?? [];
          if (types.includes('username') && !username) {
            setErrorMsg('VNC requires a username (e.g. macOS Screen Sharing / ARD). Set it on the connection and reconnect.');
            setAndNotify('disconnected');
            try { rfb?.disconnect(); } catch { /* ignore */ }
            return;
          }
          if (types.includes('password') && !password) {
            setErrorMsg('VNC requires a password. Set it on the connection and reconnect.');
            setAndNotify('disconnected');
            try { rfb?.disconnect(); } catch { /* ignore */ }
            return;
          }
          try {
            rfb?.sendCredentials({ username, password });
          } catch {
            setErrorMsg('Failed to supply VNC credentials');
            setAndNotify('disconnected');
          }
        });
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Connection failed');
          setAndNotify('disconnected');
        }
      }
    }

    setAndNotify('connecting');
    setErrorMsg('');
    connect();

    return () => {
      cancelled = true;
      window.removeEventListener('gatwy:unauthorized', onRevoked);
      resizeObserver?.disconnect();
      if (rfbRef.current) {
        try { rfbRef.current.disconnect(); } catch { /* ignore */ }
        rfbRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, token, isActive, reconnectCount]);

  return (
    <div ref={sessionRef} className="absolute inset-0 bg-black flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-alt border-b border-border/40 shrink-0 text-xs text-text-secondary">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            status === 'connected'
              ? 'bg-green-500'
              : status === 'connecting'
              ? 'bg-yellow-500'
              : 'bg-red-500'
          }`}
        />
        <span className="font-medium text-text-primary">{connectionName}</span>
        <span className="opacity-50">VNC</span>
        {status === 'connecting' && <span className="opacity-50">Connecting...</span>}
        {errorMsg && <span className="text-red-400 ml-auto">{errorMsg}</span>}
      </div>

      <div className="flex flex-row flex-1 overflow-hidden relative">
        <div ref={containerRef} className="flex-1 overflow-hidden" style={{ background: '#000' }} />
        <VncControlPanel
          rfbRef={rfbRef}
          status={status}
          sessionRef={sessionRef}
          onDisconnect={handleDisconnect}
        />
        <VncMobileKeyboard rfbRef={rfbRef} status={status} />
      </div>

      <DisconnectOverlay
        show={status === 'disconnected'}
        message={errorMsg}
        onExit={() => onClose?.(connectionId)}
        onReconnect={handleReconnect}
      />
    </div>
  );
}
