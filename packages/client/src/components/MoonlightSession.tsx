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

function preferWebsocketTransport(): void {
  try {
    const raw = localStorage.getItem('mlSettings');
    const settings = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    if (settings.dataTransport !== 'websocket' && settings.dataTransport !== 'webrtc') {
      settings.dataTransport = 'websocket';
      localStorage.setItem('mlSettings', JSON.stringify(settings));
    }
  } catch { /* ignore */ }
}

export function MoonlightSession({
  connectionId,
  connectionName,
  isActive,
  onStatusChange,
  onClose,
}: MoonlightSessionProps) {
  const sessionRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [status, setStatus] = useState<SessionStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [pin, setPin] = useState<string | null>(null);
  const [showPairModal, setShowPairModal] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [appTitle, setAppTitle] = useState('Desktop');
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

  const handleFullscreen = useCallback(() => {
    const el = sessionRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen().catch(() => undefined);
    }
  }, []);

  const forgetPairing = useCallback(async () => {
    try {
      await fetch(`/api/v1/moonlight/${connectionId}/pairing`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch { /* ignore */ }
    setStreamUrl(null);
    setPin(null);
    setReconnectCount((n) => n + 1);
  }, [connectionId]);

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
    preferWebsocketTransport();
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
    setAppTitle(data.appTitle);
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

  return (
    <div ref={sessionRef} className="absolute inset-0 bg-black flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-alt border-b border-border/40 shrink-0 text-xs text-text-secondary">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            status === 'streaming'
              ? 'bg-green-500'
              : status === 'disconnected'
              ? 'bg-red-500'
              : 'bg-yellow-500'
          }`}
        />
        <span className="font-medium text-text-primary">{connectionName}</span>
        <span className="opacity-50">Moonlight</span>
        {appTitle && status === 'streaming' && <span className="opacity-50">{appTitle}</span>}
        {status === 'connecting' && <span className="opacity-50">Connecting…</span>}
        {status === 'pairing' && <span className="opacity-50">Waiting for PIN…</span>}
        {status === 'streaming' && (
          <span className="opacity-50">{Math.round(bitrate / 1000)} Mbps · {fps} fps</span>
        )}
        {errorMsg && !showPairModal && <span className="text-red-400 ml-auto truncate max-w-[40%]">{errorMsg}</span>}
        <div className={`flex items-center gap-1 ${errorMsg && !showPairModal ? '' : 'ml-auto'}`}>
          <label className="flex items-center gap-1 opacity-70">
            <span>Mbps</span>
            <input
              type="number"
              min={1}
              max={150}
              value={Math.round(bitrate / 1000)}
              onChange={(e) => setBitrate(Math.max(1, parseInt(e.target.value, 10) || 20) * 1000)}
              className="w-12 bg-surface border border-border rounded px-1 py-0.5 text-[11px]"
              title="Bitrate (applies on reconnect)"
            />
          </label>
          <label className="flex items-center gap-1 opacity-70">
            <span>FPS</span>
            <input
              type="number"
              min={15}
              max={240}
              value={fps}
              onChange={(e) => setFps(Math.max(15, parseInt(e.target.value, 10) || 60))}
              className="w-12 bg-surface border border-border rounded px-1 py-0.5 text-[11px]"
              title="FPS (applies on reconnect)"
            />
          </label>
          <button
            type="button"
            onClick={handleFullscreen}
            className="px-2 py-1 rounded border border-border/60 hover:bg-surface"
            title="Fullscreen"
          >
            Fullscreen
          </button>
          <button
            type="button"
            onClick={() => void forgetPairing()}
            className="px-2 py-1 rounded border border-border/60 hover:bg-surface"
            title="Forget pairing and re-pair"
          >
            Forget pairing
          </button>
          <button
            type="button"
            onClick={handleDisconnect}
            className="px-2 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10"
          >
            Disconnect
          </button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden bg-black">
        {streamUrl && status === 'streaming' ? (
          <iframe
            ref={iframeRef}
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
      </div>

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
