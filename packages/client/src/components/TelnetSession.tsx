import { useEffect, useRef, useState, useCallback } from 'react';
import { DisconnectOverlay } from './DisconnectOverlay';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Tab } from '../pages/MainLayout';
import { useAuth } from '../hooks/useAuth';
import { getWsTicket } from '../lib/wsTicket';

interface TelnetSessionProps {
  tab: Tab;
  isActive: boolean;
  paneWidth: number;
  paneHeight: number;
  onStatusChange: (tabId: string, status: Tab['status']) => void;
  onClose: (tabId: string) => void;
}

export function TelnetSession({ tab, isActive, paneWidth, paneHeight, onStatusChange, onClose }: TelnetSessionProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { token } = useAuth();
  const [disconnected, setDisconnected] = useState(false);
  const [disconnectMessage, setDisconnectMessage] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);

  const handleReconnect = useCallback(() => {
    setDisconnected(false);
    setDisconnectMessage('');
    setReconnectCount((n) => n + 1);
  }, []);

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
    if (!termRef.current || !token) return;
    let cancelled = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorStyle: 'block',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
      allowTransparency: false,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    fitAddon.fit();

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
      const wsUrl = `${proto}//${window.location.host}/ws/telnet?ticket=${encodeURIComponent(ticket)}&connectionId=${encodeURIComponent(tab.connectionId)}&sessionId=${encodeURIComponent(tab.clientSessionId)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'status' && (msg.message === 'Connected' || msg.message === 'Reattached')) {
              onStatusChange(tab.id, 'connected');
              term.focus();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
              }
            } else if (msg.type === 'error') {
              if (!cancelled) { setDisconnectMessage(msg.message); setDisconnected(true); onStatusChange(tab.id, 'disconnected'); }
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
  }, [tab.id, tab.connectionId, token, onStatusChange, reconnectCount]);

  return (
    <div
      className="absolute inset-0 bg-[#1e1e1e]"
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
      <div ref={termRef} className="absolute inset-0" />
      <DisconnectOverlay
        show={disconnected}
        message={disconnectMessage}
        onExit={() => onClose(tab.id)}
        onReconnect={handleReconnect}
      />
    </div>
  );
}
