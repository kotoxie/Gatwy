import { useCallback, useEffect, useRef, useState } from 'react';
import { DisconnectOverlay } from './DisconnectOverlay';
import { MoonlightPairModal } from './MoonlightPairModal';

type SessionStatus = 'connecting' | 'pairing' | 'streaming' | 'disconnected';

interface MoonlightSessionProps {
  connectionId: string;
  connectionName: string;
  isActive: boolean;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void;
  onClose?: () => void;
}

interface StatusResponse {
  available: boolean;
  paired: boolean;
  hostId: number;
  host: string;
  appName?: string;
  apps?: { appId: number; title: string }[];
  error?: string;
  runtimeWarning?: string;
}

interface SessionResponse {
  sessionId: string;
  hostId: number;
  appId: number;
  appTitle: string;
  streamPath: string;
  bitrateKbps: number;
  fps: number;
  needsPairing?: boolean;
  error?: string;
}

function mapStatus(s: SessionStatus): 'connecting' | 'connected' | 'disconnected' {
  if (s === 'streaming') return 'connected';
  if (s === 'disconnected') return 'disconnected';
  return 'connecting';
}

/** moonlight-web reads mlSettings from localStorage before painting the HUD. */
function applyMoonlightChrome(): void {
  try {
    const raw = localStorage.getItem('mlSettings');
    const settings = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    settings.dataTransport = 'websocket';
    settings.sidebarEdge = 'right';
    localStorage.setItem('mlSettings', JSON.stringify(settings));
  } catch { /* ignore */ }
}

export function MoonlightSession({
  connectionId,
  connectionName,
  isActive,
  onStatusChange,
  onClose,
}: MoonlightSessionProps) {
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [status, setStatus] = useState<SessionStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [pin, setPin] = useState<string | null>(null);
  const [showPairModal, setShowPairModal] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [hostLabel, setHostLabel] = useState(connectionName);
  const [bitrate, setBitrate] = useState(20000);
  const [fps, setFps] = useState(60);
  const [reconnectCount, setReconnectCount] = useState(0);

  function setAndNotify(s: SessionStatus) {
    setStatus(s);
    onStatusChange?.(mapStatus(s));
  }

  const auditDisconnect = useCallback(async () => {
    try {
      await fetch(`/api/v1/moonlight/${connectionId}/disconnect-audit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current }),
      });
    } catch { /* ignore */ }
  }, [connectionId]);

  const handleDisconnect = useCallback(() => {
    abortRef.current?.abort();
    void auditDisconnect();
    setStreamUrl(null);
    onClose?.();
  }, [auditDisconnect, onClose]);

  const startPairing = useCallback(async (signal: AbortSignal) => {
    setShowPairModal(true);
    setAndNotify('pairing');
    setPin(null);
    setErrorMsg('');

    const res = await fetch(`/api/v1/moonlight/${connectionId}/pair`, {
      method: 'POST',
      credentials: 'include',
      signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `Pairing failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let paired = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as {
          pin?: string;
          paired?: boolean;
          error?: string;
          alreadyPaired?: boolean;
        };
        if (obj.pin) setPin(obj.pin);
        if (obj.error) throw new Error(obj.error);
        if (obj.paired) paired = true;
      }
    }

    if (!paired) throw new Error('Pairing did not complete');
    setShowPairModal(false);
    setPin(null);
  }, [connectionId]);

  const startStream = useCallback(async (signal: AbortSignal) => {
    applyMoonlightChrome();
    const res = await fetch(`/api/v1/moonlight/${connectionId}/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrateKbps: bitrate, fps }),
      signal,
    });
    const data = await res.json() as SessionResponse;
    if (res.status === 409 || data.needsPairing) {
      return 'needs-pairing' as const;
    }
    if (!res.ok) throw new Error(data.error || `Failed to start stream (${res.status})`);

    sessionIdRef.current = data.sessionId;
    setBitrate(data.bitrateKbps);
    setFps(data.fps);
    setStreamUrl(data.streamPath);
    setAndNotify('streaming');
    return 'streaming' as const;
  }, [bitrate, connectionId, fps]);

  useEffect(() => {
    if (!isActive) return;

    const abort = new AbortController();
    abortRef.current = abort;
    let cancelled = false;

    async function run() {
      try {
        setAndNotify('connecting');
        setErrorMsg('');
        setStreamUrl(null);
        setShowPairModal(false);

        const statusRes = await fetch(`/api/v1/moonlight/${connectionId}/status`, {
          credentials: 'include',
          signal: abort.signal,
        });
        const st = await statusRes.json() as StatusResponse;
        if (!statusRes.ok) throw new Error(st.error || 'Failed to query Moonlight status');
        if (!st.available) throw new Error(st.error || 'Moonlight runtime is not available');
        if (st.runtimeWarning) console.warn('[Moonlight]', st.runtimeWarning);

        setHostLabel(st.host || connectionName);

        if (!st.paired) {
          await startPairing(abort.signal);
          if (cancelled) return;
        }

        const result = await startStream(abort.signal);
        if (result === 'needs-pairing') {
          await startPairing(abort.signal);
          if (cancelled) return;
          await startStream(abort.signal);
        }
      } catch (err) {
        if (cancelled || abort.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Connection failed';
        setErrorMsg(msg);
        setShowPairModal((open) => open || msg.toLowerCase().includes('pair'));
        setAndNotify('disconnected');
      }
    }

    void run();

    return () => {
      cancelled = true;
      abort.abort();
      if (sessionIdRef.current) {
        void auditDisconnect();
        sessionIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, isActive, reconnectCount]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source === 'gatwy-mlw' && data.type === 'exit') {
        handleDisconnect();
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleDisconnect]);

  return (
    <div className="absolute inset-0 bg-black overflow-hidden">
      {streamUrl && status === 'streaming' ? (
        <iframe
          title={`Moonlight ${connectionName}`}
          src={streamUrl}
          className="absolute inset-0 w-full h-full border-0"
          allow="fullscreen; autoplay; clipboard-read; clipboard-write; gamepad"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-text-secondary">
          {status === 'pairing' ? 'Waiting for Sunshine PIN confirmation…' : 'Preparing Moonlight stream…'}
        </div>
      )}

      {showPairModal && (
        <MoonlightPairModal
          pin={pin}
          hostLabel={hostLabel}
          error={status === 'disconnected' ? errorMsg : undefined}
          onCancel={handleDisconnect}
          onRetry={() => {
            setErrorMsg('');
            setReconnectCount((n) => n + 1);
          }}
        />
      )}

      <DisconnectOverlay
        show={status === 'disconnected' && !showPairModal}
        message={errorMsg}
        onExit={() => onClose?.()}
        onReconnect={() => {
          setErrorMsg('');
          setReconnectCount((n) => n + 1);
        }}
      />
    </div>
  );
}
