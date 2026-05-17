import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Header, type SidebarMode } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { TabBar } from '../components/TabBar';
import { SessionsLayer } from '../components/SessionsLayer';
import { PaneOverlay } from '../components/PaneOverlay';
import { SettingsPanel } from '../components/settings/SettingsPanel';
import { useSettings } from '../hooks/useSettings';
import { useAuth } from '../hooks/useAuth';
import type { PaneNode } from '../types/panes';
import { type Protocol, type SessionProtocol } from '../types/protocol.js';
import {
  addSplit,
  removeLeaf,
  countLeaves,
  getLeafIds,
  computeLeafRects,
  updateRatio,
} from '../utils/panes';

function IdleMonitor() {
  const { settings } = useSettings();
  const { logout } = useAuth();
  const lastActivity = useRef(Date.now());
  const idleMs = parseInt(settings['security.idle_timeout_minutes'] ?? '0', 10) * 60 * 1000;

  useEffect(() => {
    if (idleMs <= 0) return;
    const resetTimer = () => { lastActivity.current = Date.now(); };
    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('keydown', resetTimer);
    window.addEventListener('click', resetTimer);
    window.addEventListener('scroll', resetTimer, true);
    const interval = setInterval(() => {
      if (Date.now() - lastActivity.current > idleMs) logout();
    }, 30_000);
    return () => {
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.removeEventListener('click', resetTimer);
      window.removeEventListener('scroll', resetTimer, true);
      clearInterval(interval);
    };
  }, [idleMs, logout]);

  return null;
}

export interface Tab {
  id: string;
  connectionId: string;
  name: string;
  protocol: Protocol;
  status: 'connecting' | 'connected' | 'disconnected';
  /** Stable across page refreshes — used to reattach SSH sessions without reconnecting. */
  clientSessionId: string;
}

export interface ViewData {
  id: string;
  paneRoot: PaneNode;
  paneTabMap: Record<string, string | null>;
  activePaneId: string;
}

export interface TabBarItem {
  id: string;
  label: string;
  protocol: SessionProtocol;
  status: 'connecting' | 'connected' | 'disconnected';
}

const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 240;
const AUTO_BACKUP_WELCOME_VERSION = '0.16.0';
const AUTO_BACKUP_WELCOME_KEY = 'welcome_autobackup_0_16_0';

function buildPaneTree(paneIds: string[]): PaneNode {
  if (paneIds.length === 1) {
    return { type: 'leaf', id: paneIds[0] };
  }
  const mid = Math.ceil(paneIds.length / 2);
  return {
    type: 'split',
    id: crypto.randomUUID(),
    dir: 'h',
    ratio: 0.5,
    a: buildPaneTree(paneIds.slice(0, mid)),
    b: buildPaneTree(paneIds.slice(mid)),
  };
}

function deriveTabBarItems(views: ViewData[], tabs: Tab[]): TabBarItem[] {
  return views.map((view) => {
    const paneCount = countLeaves(view.paneRoot);
    const isSplit = paneCount > 1;

    const tabIds = Object.values(view.paneTabMap).filter(Boolean) as string[];
    const viewTabs = tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean) as Tab[];

    let label: string;
    let protocol: TabBarItem['protocol'];
    if (isSplit) {
      label = 'Split';
      protocol = 'split';
    } else {
      const tab = viewTabs[0];
      label = tab?.name ?? 'Empty';
      protocol = tab?.protocol ?? 'ssh';
    }

    let status: Tab['status'] = 'connected';
    if (viewTabs.some((t) => t.status === 'disconnected')) status = 'disconnected';
    else if (viewTabs.some((t) => t.status === 'connecting')) status = 'connecting';

    return { id: view.id, label, protocol, status };
  });
}

export function MainLayout() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [views, setViews] = useState<ViewData[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const sessionsContainerRef = useRef<HTMLDivElement>(null);

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    if (isMobile) return 'hide';
    const saved = localStorage.getItem('gatwy-sidebar-mode') as SidebarMode | null;
    return saved ?? 'open';
  });
  const [hiddenSidebarOpen, setHiddenSidebarOpen] = useState(false);
  const hideSidebarCloseTimerRef = useRef<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);

  const { user, refreshUser } = useAuth();
  const { settings } = useSettings();
  const insecureKey = settings['system.insecure_key'] === 'true';
  const permanentlyDismissed = user?.dismissedWarnings?.includes('insecure_key') ?? false;
  const autoBackupWelcomeDismissed = user?.dismissedWarnings?.includes(AUTO_BACKUP_WELCOME_KEY) ?? false;
  const showAutoBackupWelcome = __APP_VERSION__ === AUTO_BACKUP_WELCOME_VERSION && !autoBackupWelcomeDismissed;
  // Read directly from sessionStorage each render so logout (which clears the key) is reflected immediately
  const remindLater = sessionStorage.getItem('gatwy-key-warn-later') === '1';
  const [, forceUpdate] = useState(0);
  const showKeyBanner = insecureKey && !permanentlyDismissed && !remindLater;

  const dismissKeyForever = async () => {
    await fetch('/api/v1/profile/dismiss-warning', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warning: 'insecure_key' }),
    }).catch(() => { /* ignore */ });
    await refreshUser();
  };

  const remindKeyLater = () => {
    sessionStorage.setItem('gatwy-key-warn-later', '1');
    forceUpdate((n) => n + 1);
  };

  const dismissAutoBackupWelcome = async () => {
    await fetch('/api/v1/profile/dismiss-warning', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warning: AUTO_BACKUP_WELCOME_KEY }),
    }).catch(() => { /* ignore */ });
    await refreshUser();
  };

  const hasRestoredRef = useRef(false);

  const cycleSidebarMode = useCallback(() => {
    setSidebarMode((prev) => {
      const next: SidebarMode = prev === 'open' ? 'hide' : prev === 'hide' ? 'closed' : 'open';
      localStorage.setItem('gatwy-sidebar-mode', next);
      return next;
    });
  }, []);

  const clearHideSidebarCloseTimer = useCallback(() => {
    if (hideSidebarCloseTimerRef.current !== null) {
      window.clearTimeout(hideSidebarCloseTimerRef.current);
      hideSidebarCloseTimerRef.current = null;
    }
  }, []);

  const scheduleHideSidebarClose = useCallback(() => {
    clearHideSidebarCloseTimer();
    hideSidebarCloseTimerRef.current = window.setTimeout(() => {
      setHiddenSidebarOpen(false);
      hideSidebarCloseTimerRef.current = null;
    }, 250);
  }, [clearHideSidebarCloseTimer]);

  const showHiddenSidebar = sidebarMode === 'hide' && hiddenSidebarOpen;

  useEffect(() => {
    return () => {
      clearHideSidebarCloseTimer();
    };
  }, [clearHideSidebarCloseTimer]);

  useEffect(() => {
    if (sidebarMode !== 'hide') {
      setHiddenSidebarOpen(false);
      clearHideSidebarCloseTimer();
    }
  }, [sidebarMode, clearHideSidebarCloseTimer]);

  const onOpenSettings = useCallback((section?: string) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  // Ctrl+` keyboard shortcut to cycle sidebar mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        cycleSidebarMode();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cycleSidebarMode]);

  // Refs for synchronous reads inside event-triggered callbacks
  const viewsRef = useRef<ViewData[]>(views);
  const activeViewIdRef = useRef<string | null>(activeViewId);
  useEffect(() => { viewsRef.current = views; }, [views]);
  useEffect(() => { activeViewIdRef.current = activeViewId; }, [activeViewId]);

  // Measure sessions container for pane rect computation
  useEffect(() => {
    const el = sessionsContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sidebar drag
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - dragStartX.current;
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragStartWidth.current + delta)));
    };
    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setIsDraggingSidebar(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const onDragStart = (e: React.MouseEvent) => {
    isDragging.current = true;
    setIsDraggingSidebar(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    e.preventDefault();
  };

  // ---------- openTab ----------
  // Opens a session from the sidebar.
  // Rule: if active view has an empty pane, fill it; otherwise create a new view.

  const openTab = useCallback(
    (connection: { id: string; name: string; protocol: Protocol }) => {
      const currentViews = viewsRef.current;
      const currentActiveViewId = activeViewIdRef.current;
      const activeView = currentActiveViewId
        ? currentViews.find((v) => v.id === currentActiveViewId) ?? null
        : null;

      const newTab: Tab = {
        id: crypto.randomUUID(),
        connectionId: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        status: 'connecting',
        clientSessionId: crypto.randomUUID(),
      };

      // Case 1: active view has an empty pane — fill it
      if (activeView) {
        const emptyPaneEntry = Object.entries(activeView.paneTabMap).find(
          ([, tId]) => tId === null,
        );
        if (emptyPaneEntry) {
          const [emptyPaneId] = emptyPaneEntry;
          setTabs((prev) => [...prev, newTab]);
          setViews((prev) =>
            prev.map((v) =>
              v.id === activeView.id
                ? {
                    ...v,
                    paneTabMap: { ...v.paneTabMap, [emptyPaneId]: newTab.id },
                    activePaneId: emptyPaneId,
                  }
                : v,
            ),
          );
          return;
        }
      }

      // Case 2: create a new view
      const newPaneId = crypto.randomUUID();
      const newView: ViewData = {
        id: crypto.randomUUID(),
        paneRoot: { type: 'leaf', id: newPaneId },
        paneTabMap: { [newPaneId]: newTab.id },
        activePaneId: newPaneId,
      };
      setTabs((prev) => [...prev, newTab]);
      setViews((prev) => [...prev, newView]);
      setActiveViewId(newView.id);
    },
    [],
  );

  // ---------- openMultipleTabs ----------
  // Opens multiple connections as separate views atomically (used for "Connect All").

  const openMultipleTabs = useCallback(
    (connections: Array<{ id: string; name: string; protocol: Protocol }>) => {
      if (connections.length === 0) return;
      const newTabs: Tab[] = connections.map((conn) => ({
        id: crypto.randomUUID(),
        connectionId: conn.id,
        name: conn.name,
        protocol: conn.protocol,
        status: 'connecting' as const,
        clientSessionId: crypto.randomUUID(),
      }));
      const newViews: ViewData[] = connections.map((_, i) => {
        const paneId = crypto.randomUUID();
        return {
          id: crypto.randomUUID(),
          paneRoot: { type: 'leaf', id: paneId } as PaneNode,
          paneTabMap: { [paneId]: newTabs[i].id },
          activePaneId: paneId,
        };
      });
      setTabs((prev) => [...prev, ...newTabs]);
      setViews((prev) => [...prev, ...newViews]);
      setActiveViewId(newViews[0].id);
    },
    [],
  );

  const handleSidebarConnect = useCallback(
    (connection: { id: string; name: string; protocol: Protocol }) => {
      openTab(connection);
      if (sidebarMode === 'hide') {
        setHiddenSidebarOpen(false);
      }
    },
    [openTab, sidebarMode],
  );

  const handleSidebarConnectMultiple = useCallback(
    (connections: Array<{ id: string; name: string; protocol: Protocol }>) => {
      openMultipleTabs(connections);
      if (sidebarMode === 'hide') {
        setHiddenSidebarOpen(false);
      }
    },
    [openMultipleTabs, sidebarMode],
  );

  // ---------- splitView ----------
  // Adds a new empty pane to the specified view's pane tree alongside activePaneId.

  const splitView = useCallback((viewId: string, dir: 'h' | 'v') => {
    setViews((prev) =>
      prev.map((v) => {
        if (v.id !== viewId) return v;
        if (countLeaves(v.paneRoot) >= 4) return v;

        const newPaneId = crypto.randomUUID();
        const newRoot = addSplit(v.paneRoot, v.activePaneId, dir, newPaneId);
        return {
          ...v,
          paneRoot: newRoot,
          paneTabMap: { ...v.paneTabMap, [newPaneId]: null },
          activePaneId: newPaneId,
        };
      }),
    );
  }, []);

  // ---------- closePaneInView ----------
  // Closes the session in a pane and removes that pane from the view's layout.
  // If it was the last pane, removes the entire view.

  const closePaneInView = useCallback((paneId: string) => {
    const currentViews = viewsRef.current;
    const currentActiveViewId = activeViewIdRef.current;

    const ownerView = currentViews.find((v) => paneId in v.paneTabMap);
    if (!ownerView) return;

    const tabIdInPane = ownerView.paneTabMap[paneId] ?? null;
    const paneCount = countLeaves(ownerView.paneRoot);

    if (paneCount <= 1) {
      // Last pane — close the entire view
      if (tabIdInPane) {
        setTabs((prev) => prev.filter((t) => t.id !== tabIdInPane));
      }
      setViews((prev) => prev.filter((v) => v.id !== ownerView.id));
      if (currentActiveViewId === ownerView.id) {
        const remaining = currentViews.filter((v) => v.id !== ownerView.id);
        setActiveViewId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
      }
      return;
    }

    // Multiple panes: remove this pane from layout and close its tab
    if (tabIdInPane) {
      setTabs((prev) => prev.filter((t) => t.id !== tabIdInPane));
    }
    setViews((prev) =>
      prev.map((v) => {
        if (v.id !== ownerView.id) return v;
        const newRoot = removeLeaf(v.paneRoot, paneId);
        if (!newRoot) return v;
        const newPaneTabMap = { ...v.paneTabMap };
        delete newPaneTabMap[paneId];
        const newActivePaneId =
          v.activePaneId === paneId
            ? (getLeafIds(newRoot)[0] ?? v.activePaneId)
            : v.activePaneId;
        return {
          ...v,
          paneRoot: newRoot,
          paneTabMap: newPaneTabMap,
          activePaneId: newActivePaneId,
        };
      }),
    );
  }, []);

  // ---------- closeTabCallback ----------
  // Called from SessionsLayer when a session closes itself (passes tabId).
  // Finds which pane holds the tab and delegates to closePaneInView.

  const closeTabCallback = useCallback(
    (tabId: string) => {
      const currentViews = viewsRef.current;
      for (const v of currentViews) {
        for (const [paneId, tId] of Object.entries(v.paneTabMap)) {
          if (tId === tabId) {
            closePaneInView(paneId);
            return;
          }
        }
      }
      // Fallback: tab not in any pane map — just remove from tabs list
      setTabs((prev) => prev.filter((t) => t.id !== tabId));
    },
    [closePaneInView],
  );

  // ---------- closeView ----------
  // Closes all sessions in a view and removes it from the bar.

  // ---------- closeAllViews ----------

  const closeAllViews = useCallback(() => {
    setTabs([]);
    setViews([]);
    setActiveViewId(null);
  }, []);

  const closeView = useCallback((viewId: string) => {
    const currentViews = viewsRef.current;
    const currentActiveViewId = activeViewIdRef.current;

    const view = currentViews.find((v) => v.id === viewId);
    if (!view) return;

    const tabIdsInView = Object.values(view.paneTabMap).filter(Boolean) as string[];
    setTabs((prev) => prev.filter((t) => !tabIdsInView.includes(t.id)));
    setViews((prev) => prev.filter((v) => v.id !== viewId));

    if (currentActiveViewId === viewId) {
      const remaining = currentViews.filter((v) => v.id !== viewId);
      setActiveViewId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  }, []);

  // ---------- mergeViewIntoView ----------
  // Drops dragged view's tab into target view as a new horizontal split pane,
  // then removes the dragged view. Only works for single-pane dragged views.

  const mergeViewIntoView = useCallback((draggedViewId: string, targetViewId: string) => {
    if (draggedViewId === targetViewId) return;
    setViews((prev) => {
      const draggedView = prev.find((v) => v.id === draggedViewId);
      const targetView = prev.find((v) => v.id === targetViewId);
      if (!draggedView || !targetView) return prev;
      if (countLeaves(targetView.paneRoot) >= 4) return prev;

      // Take the first tab from the dragged view
      const draggedTabId = Object.values(draggedView.paneTabMap).find(Boolean) ?? null;
      const newPaneId = crypto.randomUUID();
      const newRoot = addSplit(targetView.paneRoot, targetView.activePaneId, 'h', newPaneId);

      return prev
        .filter((v) => v.id !== draggedViewId)
        .map((v) => {
          if (v.id !== targetViewId) return v;
          return {
            ...v,
            paneRoot: newRoot,
            paneTabMap: { ...v.paneTabMap, [newPaneId]: draggedTabId },
            activePaneId: newPaneId,
          };
        });
    });
    setActiveViewId(targetViewId);
  }, []);

  // ---------- focusPaneInView ----------

  const focusPaneInView = useCallback((paneId: string) => {
    setViews((prev) =>
      prev.map((v) => {
        if (!(paneId in v.paneTabMap)) return v;
        return { ...v, activePaneId: paneId };
      }),
    );
  }, []);

  // ---------- updateRatioInView ----------

  const updateRatioInView = useCallback((splitId: string, ratio: number) => {
    const currentActiveViewId = activeViewIdRef.current;
    setViews((prev) =>
      prev.map((v) => {
        if (v.id !== currentActiveViewId) return v;
        return { ...v, paneRoot: updateRatio(v.paneRoot, splitId, ratio) };
      }),
    );
  }, []);

  // ---------- updateTabStatus ----------

  const updateTabStatus = useCallback((tabId: string, status: Tab['status']) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, status } : t)));
  }, []);

  // ---------- Session persistence ----------

  // Restore sessions from localStorage on first authenticated load
  useEffect(() => {
    if (!user || hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    const saved = localStorage.getItem('gatwy-sessions');
    if (!saved) return;

    try {
      const savedViews: Array<Array<{ connectionId: string; name: string; protocol: Tab['protocol']; clientSessionId: string }>> =
        JSON.parse(saved);
      if (!savedViews.length) return;

      const allNewTabs: Tab[] = [];
      const allNewViews: ViewData[] = [];

      for (const connList of savedViews) {
        if (!connList.length) continue;
        const connTabs: Tab[] = connList.map((c) => ({
          id: crypto.randomUUID(),
          connectionId: c.connectionId,
          name: c.name,
          protocol: c.protocol,
          status: 'connecting' as const,
          clientSessionId: c.clientSessionId || crypto.randomUUID(),
        }));
        const paneIds = connTabs.map(() => crypto.randomUUID());
        const view: ViewData = {
          id: crypto.randomUUID(),
          paneRoot: buildPaneTree(paneIds),
          paneTabMap: Object.fromEntries(paneIds.map((pid, i) => [pid, connTabs[i].id])),
          activePaneId: paneIds[0],
        };
        allNewTabs.push(...connTabs);
        allNewViews.push(view);
      }

      if (allNewViews.length > 0) {
        setTabs(allNewTabs);
        setViews(allNewViews);
        setActiveViewId(allNewViews[allNewViews.length - 1].id);
      }
    } catch {
      localStorage.removeItem('gatwy-sessions');
    }
  }, [user]);

  // Save sessions to localStorage whenever views/tabs change
  useEffect(() => {
    if (!hasRestoredRef.current) return;
    if (views.length === 0) {
      localStorage.removeItem('gatwy-sessions');
      return;
    }
    const saved = views
      .map((view) =>
        getLeafIds(view.paneRoot)
          .map((paneId) => {
            const tabId = view.paneTabMap[paneId];
            if (!tabId) return null;
            const tab = tabs.find((t) => t.id === tabId);
            if (!tab) return null;
            return { connectionId: tab.connectionId, name: tab.name, protocol: tab.protocol, clientSessionId: tab.clientSessionId };
          })
          .filter(Boolean),
      )
      .filter((group) => group.length > 0);

    if (saved.length > 0) {
      localStorage.setItem('gatwy-sessions', JSON.stringify(saved));
    } else {
      localStorage.removeItem('gatwy-sessions');
    }
  }, [views, tabs]);

  // ---------- Derived values ----------

  const activeView = useMemo(
    () => views.find((v) => v.id === activeViewId) ?? null,
    [views, activeViewId],
  );

  const leafRects = useMemo(() => {
    if (!activeView || containerSize.w === 0) return {};
    return computeLeafRects(activeView.paneRoot, 0, 0, containerSize.w, containerSize.h);
  }, [activeView, containerSize]);

  const tabBarItems = useMemo(() => deriveTabBarItems(views, tabs), [views, tabs]);

  const canSplit = useMemo(
    () => (activeView ? countLeaves(activeView.paneRoot) < 4 : false),
    [activeView],
  );

  return (
    <div className="flex flex-col h-screen bg-surface select-none">
      <IdleMonitor />
      <Header
        sidebarMode={sidebarMode}
        onCycleSidebarMode={cycleSidebarMode}
        onSidebarButtonHoverStart={() => {
          clearHideSidebarCloseTimer();
          setHiddenSidebarOpen(true);
        }}
        onSidebarButtonHoverEnd={() => {
          scheduleHideSidebarClose();
        }}
        onOpenSettings={onOpenSettings}
      />
      {showAutoBackupWelcome && (
        <div className="flex items-start gap-3 bg-accent/90 text-white px-4 py-2.5 text-sm shadow-md shrink-0">
          <span className="text-lg shrink-0 mt-0.5">✨</span>
          <div className="flex-1">
            <span className="font-bold">New in 0.16.0: </span>
            Scheduled Auto Backup is now available.
            Configure daily or weekly encrypted SMB backups from Settings.
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onOpenSettings('backup')}
              className="px-2.5 py-1 rounded border border-white/40 text-white/90 hover:bg-white/10 text-xs whitespace-nowrap"
            >
              Open Backup Settings
            </button>
            <button
              onClick={dismissAutoBackupWelcome}
              className="px-2.5 py-1 rounded bg-white/20 hover:bg-white/30 text-white text-xs whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {showKeyBanner && (
        <div className="flex items-start gap-3 bg-red-700 text-white px-4 py-2.5 text-sm shadow-md shrink-0">
          <span className="text-lg shrink-0 mt-0.5">⚠</span>
          <div className="flex-1">
            <span className="font-bold">Security Warning: </span>
            <code className="bg-red-800 px-1 rounded text-xs">GATWY_ENCRYPTION_KEY</code> is not set — the encryption key is stored alongside your data.
            Set this environment variable before going to production.{' '}
            <a
              href="https://docs.gatwy.dev/configuration#encryption-key"
              target="_blank"
              rel="noreferrer"
              className="underline opacity-80 hover:opacity-100"
            >
              Learn more ↗
            </a>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={remindKeyLater}
              className="px-2.5 py-1 rounded border border-white/40 text-white/80 hover:bg-white/10 text-xs whitespace-nowrap"
            >
              Remind me later
            </button>
            <button
              onClick={dismissKeyForever}
              className="px-2.5 py-1 rounded bg-white/20 hover:bg-white/30 text-white text-xs whitespace-nowrap"
            >
              Never show again
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Open mode: sidebar always visible, pushes layout */}
        {sidebarMode === 'open' && (
          <>
            <Sidebar onConnect={handleSidebarConnect} onConnectMultiple={handleSidebarConnectMultiple} width={sidebarWidth} />
            <div
              className="w-1 cursor-col-resize bg-border hover:bg-accent/60 active:bg-accent transition-colors shrink-0"
              onMouseDown={onDragStart}
            />
          </>
        )}
        {/* Hide mode: sidebar overlays content on hover */}
        {sidebarMode === 'hide' && (
          <div
            className="absolute left-0 top-0 bottom-0 z-30 flex h-full min-h-0"
            style={{ width: showHiddenSidebar ? sidebarWidth : 0 }}
            onMouseEnter={() => {
              clearHideSidebarCloseTimer();
              setHiddenSidebarOpen(true);
            }}
            onMouseLeave={() => {
              scheduleHideSidebarClose();
            }}
          >
            {/* Sidebar slides in */}
            <div
              className="h-full min-h-0 overflow-hidden transition-[width] duration-[250ms] ease-in-out shadow-xl"
              style={{ width: showHiddenSidebar ? sidebarWidth : 0 }}
            >
              <div className="h-full min-h-0" style={{ width: sidebarWidth }}>
                <Sidebar onConnect={handleSidebarConnect} onConnectMultiple={handleSidebarConnectMultiple} width={sidebarWidth} />
              </div>
            </div>
          </div>
        )}
        {/* No left offset in hide mode because opening is controlled by header button hover */}
        <div
          className="flex flex-col flex-1 overflow-hidden relative transition-[padding-left] duration-[250ms]"
          style={{ paddingLeft: 0 }}
        >
          <TabBar
            tabs={tabBarItems}
            activeTabId={activeViewId}
            onTabSelect={setActiveViewId}
            onClose={closeView}
            onSplitH={(viewId) => splitView(viewId, 'h')}
            onSplitV={(viewId) => splitView(viewId, 'v')}
            canSplit={canSplit}
            onCloseAll={closeAllViews}
            onReorder={(ids) => setViews((prev) => ids.map((id) => prev.find((v) => v.id === id)!).filter(Boolean))}
            onMergeInto={mergeViewIntoView}
          />

          {/* Sessions container: relative parent for both layers */}
          <div
            ref={sessionsContainerRef}
            className="flex-1 relative overflow-hidden"
          >
            <SessionsLayer
              tabs={tabs}
              views={views}
              activeViewId={activeViewId}
              leafRects={leafRects}
              activePaneId={activeView?.activePaneId ?? null}
              onStatusChange={updateTabStatus}
              onClose={closeTabCallback}
            />

            {activeView && (
              <PaneOverlay
                paneRoot={activeView.paneRoot}
                leafRects={leafRects}
                paneTabMap={activeView.paneTabMap}
                activePaneId={activeView.activePaneId}
                tabs={tabs}
                onFocusPane={focusPaneInView}
                onClosePane={closePaneInView}
                onUpdateRatio={updateRatioInView}
                containerW={containerSize.w}
                containerH={containerSize.h}
              />
            )}

            {/* No views: full empty state */}
            {views.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface pointer-events-none">
                <div className="text-center text-text-secondary">
                  <p className="text-lg">No active session</p>
                  <p className="text-sm mt-1">Select a connection from the sidebar to begin</p>
                </div>
              </div>
            )}

            {/* Sidebar drag overlay: blocks mouse reaching session canvas */}
            {isDraggingSidebar && (
              <div className="absolute inset-0 z-50 cursor-col-resize" />
            )}
          </div>
        </div>
      </div>

      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection={settingsSection}
      />
    </div>
  );
}
