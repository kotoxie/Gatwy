import type { Tab, ViewData } from '../pages/MainLayout';
import type { PaneRect } from '../types/panes';
import { RdpSession } from './RdpSession';
import { SshSession } from './SshSession';
import { SmbSession } from './SmbSession';
import { VncSession } from './VncSession';
import { SftpSession } from './SftpSession';
import { FtpSession } from './FtpSession';
import { TelnetSession } from './TelnetSession';
import { DbSession } from './db/DbSession';
import { MoonlightSession } from './MoonlightSession';

interface SessionsLayerProps {
  tabs: Tab[];
  views: ViewData[];
  activeViewId: string | null;
  leafRects: Record<string, PaneRect>; // rects for the active view only
  activePaneId: string | null;
  onStatusChange: (tabId: string, status: Tab['status']) => void;
  onClose: (tabId: string) => void;
}

export function SessionsLayer({
  tabs,
  views,
  activeViewId,
  leafRects,
  activePaneId,
  onStatusChange,
  onClose,
}: SessionsLayerProps) {
  // Build map: tabId -> { viewId, paneId }
  const tabLocation: Record<string, { viewId: string; paneId: string }> = {};
  for (const view of views) {
    for (const [paneId, tabId] of Object.entries(view.paneTabMap)) {
      if (tabId) tabLocation[tabId] = { viewId: view.id, paneId };
    }
  }

  return (
    <div className="absolute inset-0 z-0">
      {tabs.map((tab) => {
        const location = tabLocation[tab.id];

        // Determine visibility and position
        let style: React.CSSProperties;
        let isActive = false;
        let paneW = 0;
        let paneH = 0;

        if (!location) {
          // Tab not assigned to any pane
          style = { position: 'absolute', display: 'none' };
        } else if (location.viewId !== activeViewId) {
          // Tab belongs to a background view — keep mounted but hidden
          style = { position: 'absolute', display: 'none' };
        } else {
          // Tab belongs to the active view — position it using leafRects
          const rect = leafRects[location.paneId];
          if (!rect) {
            style = { position: 'absolute', display: 'none' };
          } else {
            isActive = location.paneId === activePaneId;
            paneW = rect.w;
            paneH = rect.h;
            style = {
              position: 'absolute',
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              // Active pane receives pointer events; inactive panes are blocked by PaneOverlay
              pointerEvents: isActive ? 'auto' : 'none',
              zIndex: isActive ? 1 : 0,
            };
          }
        }

        return (
          <div key={tab.id} style={style}>
            {tab.protocol === 'rdp' && (
              <RdpSession tab={tab} onStatusChange={onStatusChange} onClose={onClose} />
            )}
            {tab.protocol === 'ssh' && (
              <SshSession
                tab={tab}
                isActive={isActive}
                paneWidth={paneW}
                paneHeight={paneH}
                onStatusChange={onStatusChange}
                onClose={onClose}
              />
            )}
            {tab.protocol === 'smb' && (
              <SmbSession
                connectionId={tab.connectionId}
                connectionName={tab.name}
                isActive={isActive}
                onStatusChange={(status) => onStatusChange(tab.id, status)}
              />
            )}
            {tab.protocol === 'vnc' && (
              <VncSession
                connectionId={tab.connectionId}
                connectionName={tab.name}
                isActive={isActive}
                onStatusChange={(status) => onStatusChange(tab.id, status)}
                onClose={() => onClose(tab.id)}
              />
            )}
            {tab.protocol === 'moonlight' && (
              <MoonlightSession
                connectionId={tab.connectionId}
                connectionName={tab.name}
                isActive={isActive}
                onStatusChange={(status) => onStatusChange(tab.id, status)}
                onClose={() => onClose(tab.id)}
              />
            )}
            {tab.protocol === 'sftp' && (
              <SftpSession
                connectionId={tab.connectionId}
                connectionName={tab.name}
                isActive={isActive}
                onStatusChange={(status) => onStatusChange(tab.id, status)}
              />
            )}
            {tab.protocol === 'ftp' && (
              <FtpSession
                connectionId={tab.connectionId}
                connectionName={tab.name}
                isActive={isActive}
                onStatusChange={(status) => onStatusChange(tab.id, status)}
              />
            )}
            {tab.protocol === 'telnet' && (
              <TelnetSession
                tab={tab}
                isActive={isActive}
                paneWidth={paneW}
                paneHeight={paneH}
                onStatusChange={onStatusChange}
                onClose={onClose}
              />
            )}
            {(tab.protocol === 'postgres' || tab.protocol === 'mysql') && (
              <DbSession
                connectionId={tab.connectionId}
                connectionName={tab.name}
                isActive={isActive}
                onStatusChange={(status) => onStatusChange(tab.id, status)}
                onClose={() => onClose(tab.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
