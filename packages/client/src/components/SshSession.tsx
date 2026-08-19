import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { DisconnectOverlay } from './DisconnectOverlay';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Tab } from '../pages/MainLayout';
import { useAuth } from '../hooks/useAuth';
import { useSshPrefs } from '../hooks/useSshPrefs';
import { SSH_THEMES } from '../lib/sshThemes';
import { getWsTicket } from '../lib/wsTicket';

interface SshSessionProps {
  tab: Tab;
  isActive: boolean;
  /** Pixel width of the pane rect — passed from SessionsLayer so fit() is driven by React state */
  paneWidth: number;
  /** Pixel height of the pane rect */
  paneHeight: number;
  onStatusChange: (tabId: string, status: Tab['status']) => void;
  onClose: (tabId: string) => void;
}

interface TunnelInfo {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  status: 'listening' | 'failed';
  error?: string;
}

export function SshSession({ tab, isActive, paneWidth, paneHeight, onStatusChange, onClose }: SshSessionProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { token } = useAuth();
  const sshPrefs = useSshPrefs();
  const [disconnected, setDisconnected] = useState(false);
  const [disconnectMessage, setDisconnectMessage] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);
  const [activeTunnels, setActiveTunnels] = useState<TunnelInfo[]>([]);
  const [promptState, setPromptState] = useState<'loading' | 'needed' | 'ready'>('loading');
  const [promptInput, setPromptInput] = useState('');
  const promptOnConnectRef = useRef(false);
  const oneTimePasswordRef = useRef('');

  // Destructure per-user SSH prefs (fetched from /api/v1/profile/ssh-prefs)
  const { fontSize: sshFontSize, fontFamily: sshFontFamily, scrollback: sshScrollback,
          cursorStyle: sshCursorStyle, cursorBlink: sshCursorBlink, theme: sshThemeName,
          loading: sshPrefsLoading } = sshPrefs;
  const sshTheme = SSH_THEMES[sshThemeName] ?? SSH_THEMES['vscode-dark'];

  const handleReconnect = useCallback(() => {
    setDisconnected(false);
    setDisconnectMessage('');
    setActiveTunnels([]);
    if (promptOnConnectRef.current) {
      oneTimePasswordRef.current = '';
      setPromptInput('');
      setPromptState('needed');
    }
    setReconnectCount((n) => n + 1);
  }, []);

  // Fetch connection config once to check promptOnConnect flag
  useEffect(() => {
    fetch(`/api/v1/connections/${tab.connectionId}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { extraConfig?: { promptOnConnect?: boolean } }) => {
        if (d.extraConfig?.promptOnConnect) {
          promptOnConnectRef.current = true;
          setPromptState('needed');
        } else {
          setPromptState('ready');
        }
      })
      .catch(() => setPromptState('ready'));
  }, [tab.connectionId]);

  const handlePromptSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    oneTimePasswordRef.current = promptInput;
    setPromptInput('');
    setPromptState('ready');
  }, [promptInput]);

  // Re-fit when the pane rect changes (sidebar drag, window resize, split pane resize).
  // paneWidth/paneHeight come directly from React state (leafRects), so this fires
  // synchronously in the React commit cycle — more reliable than a ResizeObserver chain.
  useEffect(() => {
    if (paneWidth === 0 || paneHeight === 0) return;
    const fit = fitAddonRef.current;
    const term = terminalRef.current;
    const ws = wsRef.current;
    if (!fit || !term) return;
    fit.fit();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }, [paneWidth, paneHeight]);

  // Re-fit + focus terminal when this tab becomes active (was hidden before)
  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(() => {
      const fit = fitAddonRef.current;
      const term = terminalRef.current;
      const ws = wsRef.current;
      if (!fit || !term) return;
      fit.fit();
      term.focus();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [isActive]);

  useEffect(() => {
    if (!termRef.current || !token || sshPrefsLoading || promptState !== 'ready') return;
    let cancelled = false;

    const term = new Terminal({
      cursorBlink: sshCursorBlink,
      fontSize: sshFontSize,
      fontFamily: sshFontFamily,
      cursorStyle: sshCursorStyle,
      theme: {
        background: sshTheme.bg,
        foreground: sshTheme.fg,
        cursor: sshTheme.cursor,
        selectionBackground: sshTheme.selection,
        black: sshTheme.black,
        red: sshTheme.red,
        green: sshTheme.green,
        yellow: sshTheme.yellow,
        blue: sshTheme.blue,
        magenta: sshTheme.magenta,
        cyan: sshTheme.cyan,
        white: sshTheme.white,
        brightBlack: sshTheme.brightBlack,
        brightRed: sshTheme.brightRed,
        brightGreen: sshTheme.brightGreen,
        brightYellow: sshTheme.brightYellow,
        brightBlue: sshTheme.brightBlue,
        brightMagenta: sshTheme.brightMagenta,
        brightCyan: sshTheme.brightCyan,
        brightWhite: sshTheme.brightWhite,
      },
      allowTransparency: false,
      scrollback: sshScrollback,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fit synchronously — the flex container is already laid out when this effect
    // runs (paneWidth/paneHeight are non-zero). This ensures term.cols/rows are
    // correct BEFORE the WebSocket opens and sends the initial resize message.
    fitAddon.fit();

    // Mutable slots accessible by both the async IIFE and the cleanup function
    let dataDispose: ReturnType<typeof term.onData> | null = null;

    (async () => {
      let ticket: string;
      try {
        ticket = await getWsTicket();
        if (cancelled) return;
      } catch {
        if (!cancelled) term.write('\r\nFailed to obtain session ticket.\r\n');
        return;
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws/ssh?ticket=${encodeURIComponent(ticket)}&connectionId=${encodeURIComponent(tab.connectionId)}&sessionId=${encodeURIComponent(tab.clientSessionId)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (oneTimePasswordRef.current) {
          ws.send(JSON.stringify({ type: 'auth', password: oneTimePasswordRef.current }));
        }
        // By the time the WebSocket handshake completes the fit has run
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'status' && (msg.message === 'Connected' || msg.message === 'Reattached')) {
              onStatusChange(tab.id, 'connected');
              term.focus();
              // Re-send current dimensions now that the server is ready to accept resize
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
              }
            } else if (msg.type === 'error') {
              if (!cancelled) { setDisconnectMessage(msg.message); setDisconnected(true); onStatusChange(tab.id, 'disconnected'); }
            } else if (msg.type === 'tunnels') {
              setActiveTunnels(msg.tunnels || []);
            }
            return;
          } catch { /* not JSON — write as terminal data */ }
          term.write(e.data);
        } else {
          term.write(new Uint8Array(e.data as ArrayBuffer));
        }
      };

      const handleClose = (reason: string) => {
        if (!cancelled) { setDisconnected(true); setDisconnectMessage(reason); onStatusChange(tab.id, 'disconnected'); }
      };
      ws.onclose = (e) => { if (e.code === 4001) return; handleClose(e.reason || 'Disconnected'); };
      ws.onerror = () => handleClose('Connection error');

      dataDispose = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
      });

      // Left-click after selection → copy to clipboard
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => { /* ignore */ });
      });
    })();

    return () => {
      cancelled = true;
      dataDispose?.dispose();
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
  }, [tab.id, tab.connectionId, token, onStatusChange, reconnectCount, promptState, sshFontSize, sshFontFamily, sshScrollback, sshCursorStyle, sshCursorBlink, sshThemeName, sshPrefsLoading]);

  // Re-fit when the tunnels bar appears or disappears so xterm recalculates
  // its available height (flex-1 container shrinks/grows accordingly).
  useEffect(() => {
    const fit = fitAddonRef.current;
    const term = terminalRef.current;
    const ws = wsRef.current;
    if (!fit || !term) return;
    const id = requestAnimationFrame(() => {
      fit.fit();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [activeTunnels.length]);

  return (
    <div
      className="absolute inset-0 bg-[#0d0d0d] flex flex-col"
      onContextMenu={async (e) => {
        e.preventDefault();
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          const text = await navigator.clipboard.readText();
          if (text) ws.send(JSON.stringify({ type: 'data', data: text }));
        } catch { /* clipboard access denied */ }
      }}
    >
      <div ref={termRef} className="flex-1 min-h-0" />

      {promptState === 'needed' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80">
          <form
            onSubmit={handlePromptSubmit}
            className="bg-surface border border-border rounded-lg p-5 w-72 flex flex-col gap-3 shadow-xl"
          >
            <div>
              <p className="text-sm font-semibold text-text-primary mb-0.5">Password required</p>
              <p className="text-xs text-text-secondary truncate">{tab.name}</p>
            </div>
            <input
              type="password"
              autoFocus
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              placeholder="Enter password"
              className="w-full px-2.5 py-1.5 bg-[#1a1a1a] border border-border rounded text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                className="flex-1 px-3 py-1.5 text-xs border border-border text-text-secondary rounded hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!promptInput}
                className="flex-1 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Connect
              </button>
            </div>
          </form>
        </div>
      )}

      {activeTunnels.length > 0 && (
        <div className="shrink-0 bg-black/80 border-t border-border/30 px-3 py-1.5 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-text-secondary shrink-0">Tunnels:</span>
          {activeTunnels.map((t, i) => (
            <span
              key={i}
              title={t.status === 'failed' ? (t.error ?? 'Failed to bind port') : `Forwarding localhost:${t.localPort} → ${t.remoteHost}:${t.remotePort}`}
              className={`text-xs font-mono px-2 py-0.5 rounded flex items-center gap-1.5 ${
                t.status === 'failed'
                  ? 'bg-red-500/15 text-red-400'
                  : 'bg-surface-hover/50 text-accent'
              }`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${t.status === 'failed' ? 'bg-red-400' : 'bg-green-400'}`} />
              :{t.localPort} → {t.remoteHost}:{t.remotePort}
              {t.status === 'failed' && <span className="text-red-400 ml-0.5">✕</span>}
            </span>
          ))}
        </div>
      )}

      <DisconnectOverlay
        show={disconnected}
        message={disconnectMessage}
        onExit={() => onClose(tab.id)}
        onReconnect={handleReconnect}
      />
    </div>
  );
}
