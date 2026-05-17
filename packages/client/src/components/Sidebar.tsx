import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import { clsx } from 'clsx';
import { useSettings } from '../hooks/useSettings';
import { ConnectionModal, type ConnectionPrefill } from './ConnectionModal';
import { type Protocol } from '../types/protocol.js';

interface ConnectionGroup {
  id: string;
  name: string;
  parentId: string | null;
  children: ConnectionGroup[];
  connections: Connection[];
}

interface Connection {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  groupId: string | null;
  isShared?: boolean;
  tags?: string[];
}

interface FlatGroup {
  id: string;
  name: string;
}

interface SidebarProps {
  onConnect: (conn: { id: string; name: string; protocol: Protocol }) => void;
  onConnectMultiple?: (conns: Array<{ id: string; name: string; protocol: Protocol }>) => void;
  width?: number;
}

interface ContextMenu {
  x: number;
  y: number;
  conn: Connection;
}

interface FolderContextMenu {
  x: number;
  y: number;
  group: ConnectionGroup;
}

function flattenGroups(groups: ConnectionGroup[], prefix = ''): FlatGroup[] {
  const result: FlatGroup[] = [];
  for (const g of groups) {
    result.push({ id: g.id, name: prefix + g.name });
    result.push(...flattenGroups(g.children, prefix + '\u00a0\u00a0'));
  }
  return result;
}

function getAllConnectionsInGroup(group: ConnectionGroup): Connection[] {
  return [
    ...group.connections,
    ...group.children.flatMap(getAllConnectionsInGroup),
  ];
}

const PROTOCOL_ICONS: Record<string, string> = {
  ssh: '>_',
  rdp: '🖥',
  smb: '📁',
  vnc: '🖱',
  sftp: '📂',
  ftp: '🗂',
  telnet: '⌨',
  postgres: '🐘',
  mysql: '🐬',
};

const ProtocolBadge = ({ protocol }: { protocol: string }) => (
  <span className="text-[10px] font-mono opacity-50 w-5 text-center shrink-0 select-none">
    {PROTOCOL_ICONS[protocol] ?? protocol}
  </span>
);

const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const TrashIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

const FolderIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

const PlugIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M7 17l9.2-9.2M14 6l3.5-3.5a2.121 2.121 0 0 1 3 3L17 9" />
    <path d="M11 19l-1 1a3 3 0 0 1-4.24-4.24L12 10" />
    <path d="M14.5 9.5L9.5 14.5" />
  </svg>
);

const SubfolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="13" x2="12" y2="17" />
    <line x1="10" y1="15" x2="14" y2="15" />
  </svg>
);

const PenIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

const PROTOCOL_SUBMENU: Array<{ protocol: Protocol; label: string; icon: React.ReactNode }> = [
  { protocol: 'rdp', label: 'RDP', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )},
  { protocol: 'ssh', label: 'SSH', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )},
  { protocol: 'vnc', label: 'VNC', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <circle cx="12" cy="10" r="3" />
      <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )},
  { protocol: 'telnet', label: 'Telnet', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="5" x2="20" y2="5" /><line x1="12" y1="12" x2="20" y2="12" /><line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )},
  { protocol: 'smb', label: 'SMB', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )},
  { protocol: 'ftp', label: 'FTP', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" /><polyline points="9 15 12 18 15 15" />
    </svg>
  )},
  { protocol: 'postgres', label: 'PostgreSQL', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4" />
    </svg>
  )},
  { protocol: 'mysql', label: 'MySQL', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4" />
      <line x1="20" y1="14" x2="20" y2="20" />
    </svg>
  )},
];

function ProtocolSubmenuItems({ groupId: _groupId, onSelect }: { groupId: string | null; onSelect: (p: Protocol) => void }) {
  return (
    <>
      {PROTOCOL_SUBMENU.map(({ protocol, label, icon }) => (
        <button
          key={protocol}
          className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2.5 whitespace-nowrap"
          onClick={() => onSelect(protocol)}
        >
          <span className="text-text-secondary shrink-0">{icon}</span>
          <span className="text-sm">{label}</span>
        </button>
      ))}
    </>
  );
}

export function Sidebar({ onConnect, onConnectMultiple, width }: SidebarProps) {
  const { settings } = useSettings();
  const healthMonitorEnabled = settings['health_monitor.enabled'] !== 'false';
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [ungrouped, setUngrouped] = useState<Connection[]>([]);
  const [sharedConnections, setSharedConnections] = useState<Connection[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('gatwy-expanded-groups');
      return stored ? new Set<string>(JSON.parse(stored) as string[]) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [showModal, setShowModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(null);
  const [inlineNewGroup, setInlineNewGroup] = useState<{ parentId: string | null; name: string } | null>(null);
  const [draggingConnId, setDraggingConnId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Fine-grained indicator for folder reorder drags: before/after = insert line, inside = nest
  const [dropIndicator, setDropIndicator] = useState<{ id: string; position: 'before' | 'after' | 'inside' } | null>(null);
  const [connDropIndicator, setConnDropIndicator] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenu | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showNewConnSubmenu, setShowNewConnSubmenu] = useState(false);
  const [duplicatePrefill, setDuplicatePrefill] = useState<ConnectionPrefill | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, 'checking' | 'up' | 'down'>>({});
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newConnGroupId, setNewConnGroupId] = useState<string | null>(null);
  const [newConnProtocol, setNewConnProtocol] = useState<Protocol>('rdp');
  const [deleteFolderConfirm, setDeleteFolderConfirm] = useState<{ group: ConnectionGroup; connCount: number } | null>(null);
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [importResult, setImportResult] = useState<{ connectionsCreated: number; groupsCreated: number } | { error: string } | null>(null);
  const inlineNewGroupInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const bgMenuRef = useRef<HTMLDivElement>(null);
  const skipHealthCheckRef = useRef(false);

  const VIEWPORT_PADDING = 8;

  function getClampedMenuPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
    if (typeof window === 'undefined') return { x, y };
    const maxX = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
    const maxY = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
    return {
      x: Math.min(Math.max(x, VIEWPORT_PADDING), maxX),
      y: Math.min(Math.max(y, VIEWPORT_PADDING), maxY),
    };
  }

  // Close connection context menu on outside click / Escape
  useEffect(() => {
    if (!contextMenu && !folderContextMenu && !bgContextMenu) return;
    function onDown(e: MouseEvent) {
      const refs = [menuRef, folderMenuRef, bgMenuRef];
      if (refs.every(r => !r.current?.contains(e.target as Node))) {
        setContextMenu(null);
        setFolderContextMenu(null);
        setBgContextMenu(null);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setFolderContextMenu(null);
        setBgContextMenu(null);
      }
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [contextMenu, folderContextMenu, bgContextMenu]);

  // Close tag dropdown on outside click
  useEffect(() => {
    if (!showTagDropdown) return;
    function onDown(e: MouseEvent) {
      if (!tagDropdownRef.current?.contains(e.target as Node)) {
        setShowTagDropdown(false);
      }
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [showTagDropdown]);

  const checkHealth = useCallback(async () => {
    if (!healthMonitorEnabled) return;
    const allConns: { id: string; host: string; port: number }[] = [];
    function collectFromGroup(g: ConnectionGroup) {
      g.connections.forEach((c) => allConns.push({ id: c.id, host: c.host, port: c.port }));
      g.children.forEach(collectFromGroup);
    }
    groups.forEach(collectFromGroup);
    ungrouped.forEach((c) => allConns.push({ id: c.id, host: c.host, port: c.port }));
    sharedConnections.forEach((c) => allConns.push({ id: c.id, host: c.host, port: c.port }));
    if (allConns.length === 0) return;

    // Only mark as 'checking' on first load (no prior status).
    // Re-polls keep the previous green/red dot visible until results return.
    setHealthMap((prev) => {
      const next = { ...prev };
      allConns.forEach((c) => { if (!prev[c.id]) next[c.id] = 'checking'; });
      return next;
    });

    try {
      const res = await fetch('/api/v1/connections/health-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ checks: allConns }),
      });
      if (!res.ok) return;
      const data = await res.json() as { results: { id: string; reachable: boolean }[] };
      setHealthMap((prev) => {
        const next = { ...prev };
        data.results.forEach((r) => { next[r.id] = r.reachable ? 'up' : 'down'; });
        return next;
      });
    } catch { /* ignore */ }
  }, [groups, ungrouped, sharedConnections, healthMonitorEnabled]);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/connections', {
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = await res.json();
      setGroups(data.groups || []);
      setUngrouped(data.ungrouped || []);
      setSharedConnections(data.sharedConnections || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchConnections(); }, [fetchConnections]);

  useEffect(() => {
    if (!healthMonitorEnabled) { setHealthMap({}); return; }
    if (groups.length > 0 || ungrouped.length > 0 || sharedConnections.length > 0) {
      if (skipHealthCheckRef.current) {
        skipHealthCheckRef.current = false;
      } else {
        checkHealth();
      }
    }
  }, [groups, ungrouped, sharedConnections, checkHealth, healthMonitorEnabled]);

  useEffect(() => {
    if (!healthMonitorEnabled) return;
    const t = setInterval(checkHealth, 60_000);
    return () => clearInterval(t);
  }, [checkHealth, healthMonitorEnabled]);

  useEffect(() => {
    if (inlineNewGroup !== null) {
      setTimeout(() => inlineNewGroupInputRef.current?.focus(), 30);
    }
  }, [inlineNewGroup]);

  function persistExpandedGroups(next: Set<string>) {
    try { localStorage.setItem('gatwy-expanded-groups', JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  }

  function toggleGroup(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return persistExpandedGroups(next);
    });
  }

  async function deleteConnection(id: string) {
    await fetch(`/api/v1/connections/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    fetchConnections();
  }

  function requestDeleteGroup(group: ConnectionGroup) {
    // Count all connections recursively
    const count = (g: ConnectionGroup): number =>
      g.connections.length + g.children.reduce((s, c) => s + count(c), 0);
    const connCount = count(group);
    if (connCount > 0) {
      setDeleteFolderConfirm({ group, connCount });
    } else {
      void confirmDeleteGroup(group.id);
    }
  }

  async function confirmDeleteGroup(id: string) {
    await fetch(`/api/v1/connections/groups/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    setDeleteFolderConfirm(null);
    fetchConnections();
  }

  async function renameGroup(id: string, newName: string) {
    if (!newName.trim()) return;
    await fetch(`/api/v1/connections/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: newName.trim() }),
    });
    setRenamingGroupId(null);
    fetchConnections();
  }

  function startInlineNewFolder(parentId: string | null) {
    if (parentId !== null) {
      setExpandedGroups(prev => persistExpandedGroups(new Set([...prev, parentId])));
    }
    setInlineNewGroup({ parentId, name: '' });
  }

  async function commitInlineNewFolder() {
    if (!inlineNewGroup) return;
    const name = inlineNewGroup.name.trim();
    if (!name) { setInlineNewGroup(null); return; }
    await fetch('/api/v1/connections/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, parentId: inlineNewGroup.parentId }),
    });
    if (inlineNewGroup.parentId) {
      setExpandedGroups(prev => persistExpandedGroups(new Set([...prev, inlineNewGroup.parentId!])));
    }
    setInlineNewGroup(null);
    fetchConnections();
  }

  function cancelInlineNewFolder() {
    setInlineNewGroup(null);
  }

  function openNewConnectionInFolder(groupId: string | null, protocol: Protocol = 'rdp') {
    setNewConnGroupId(groupId);
    setNewConnProtocol(protocol);
    setEditingConnection(null);
    setShowModal(true);
  }

  async function handleDuplicate(conn: Connection) {
    try {
      const res = await fetch(`/api/v1/connections/${conn.id}`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const d = await res.json();
      const prefill: ConnectionPrefill = {
        name: `${conn.name} - copy`,
        protocol: conn.protocol,
        host: conn.host,
        port: conn.port,
        username: d.username ?? '',
        groupId: conn.groupId,
        shared: d.shared === 1,
        smbShare: d.extraConfig?.share ?? '',
        smbDomain: d.extraConfig?.domain ?? '',
        tunnels: (d.tunnels ?? []).map((t: { localPort: number; remoteHost: string; remotePort: number }) => ({
          id: crypto.randomUUID(),
          localPort: String(t.localPort),
          remoteHost: t.remoteHost,
          remotePort: String(t.remotePort),
        })),
      };
      setDuplicatePrefill(prefill);
      setShowModal(true);
    } catch { /* ignore */ }
  }

  async function moveConnection(connId: string, targetGroupId: string | null) {
    skipHealthCheckRef.current = true;
    await fetch(`/api/v1/connections/${connId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ groupId: targetGroupId }),
    });
    fetchConnections();
  }

  async function reorderConnection(draggedId: string, targetId: string, position: 'before' | 'after') {
    if (draggedId === targetId) return;

    // Find connections list containing targetId
    function findConnsInGroup(groupList: ConnectionGroup[], connId: string): Connection[] | null {
      for (const g of groupList) {
        if (g.connections.some(c => c.id === connId)) return g.connections;
        const found = findConnsInGroup(g.children, connId);
        if (found) return found;
      }
      return null;
    }

    let siblings = findConnsInGroup(groups, targetId);
    if (!siblings && ungrouped.some(c => c.id === targetId)) siblings = ungrouped;
    if (!siblings) return;

    // If dragged conn is in a different group, move it first
    const draggedInSameGroup = siblings.some(c => c.id === draggedId);
    if (!draggedInSameGroup) {
      // Find target's groupId
      let targetGroupId: string | null = null;
      function findGroupId(groupList: ConnectionGroup[], connId: string): string | null {
        for (const g of groupList) {
          if (g.connections.some(c => c.id === connId)) return g.id;
          const found = findGroupId(g.children, connId);
          if (found) return found;
        }
        return null;
      }
      targetGroupId = findGroupId(groups, targetId);

      await fetch(`/api/v1/connections/${draggedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ groupId: targetGroupId }),
      });
    }

    // Build reordered list
    const withoutDragged = siblings.filter(c => c.id !== draggedId);
    const targetIdx = withoutDragged.findIndex(c => c.id === targetId);
    const insertIdx = targetIdx === -1 ? withoutDragged.length : position === 'before' ? targetIdx : targetIdx + 1;
    const reordered = [...withoutDragged.slice(0, insertIdx), { id: draggedId } as Connection, ...withoutDragged.slice(insertIdx)];

    const items = reordered.map((c, i) => ({ id: c.id, sortOrder: i * 10 }));
    await fetch('/api/v1/connections/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ items }),
    });
    fetchConnections();
  }

  async function handleExport() {
    const res = await fetch('/api/v1/connections/export', { credentials: 'include' });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gatwy-connections-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await fetch('/api/v1/connections/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(json),
      });
      const data = await res.json() as { groupsCreated?: number; connectionsCreated?: number; newGroupIds?: string[]; error?: string };
      if (res.ok) {
        await fetchConnections();
        if (data.newGroupIds?.length) {
          setExpandedGroups(prev => persistExpandedGroups(new Set([...prev, ...data.newGroupIds!])));
        }
        setImportResult({ connectionsCreated: data.connectionsCreated ?? 0, groupsCreated: data.groupsCreated ?? 0 });
      } else {
        setImportResult({ error: data.error || 'Import failed. You may not have permission to import connections.' });
      }
    } catch {
      setImportResult({ error: 'Failed to read or parse the file. Make sure it is a valid Gatwy export file.' });
    }
    // Reset so same file can be imported again
    e.target.value = '';
  }

  function handleDragStart(e: React.DragEvent, connId: string) {
    setDraggingConnId(connId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragEnd() {
    setDraggingConnId(null);
    setDraggingGroupId(null);
    setDragOverId(null);
    setDropIndicator(null);
    setConnDropIndicator(null);
  }

  function isAncestorOrSelf(candidateId: string, dragged: string, list: ConnectionGroup[]): boolean {
    function findSubtree(id: string, nodes: ConnectionGroup[]): ConnectionGroup | null {
      for (const n of nodes) {
        if (n.id === id) return n;
        const f = findSubtree(id, n.children);
        if (f) return f;
      }
      return null;
    }
    function containsId(id: string, nodes: ConnectionGroup[]): boolean {
      for (const n of nodes) {
        if (n.id === id) return true;
        if (containsId(id, n.children)) return true;
      }
      return false;
    }
    if (candidateId === dragged) return true;
    const draggedNode = findSubtree(dragged, list);
    if (!draggedNode) return false;
    return containsId(candidateId, draggedNode.children);
  }

  async function moveGroup(groupId: string, targetParentId: string | null) {
    await fetch(`/api/v1/connections/groups/${groupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ parentId: targetParentId }),
    });
    if (targetParentId) {
      setExpandedGroups(prev => persistExpandedGroups(new Set([...prev, targetParentId])));
    }
    fetchConnections();
  }

  // Return siblings (groups at the same level) for a given group id
  function getGroupSiblings(groupId: string, list: ConnectionGroup[]): ConnectionGroup[] {
    // Root level?
    if (list.some(g => g.id === groupId)) return list;
    for (const g of list) {
      if (g.children.some(c => c.id === groupId)) return g.children;
      const found = getGroupSiblings(groupId, g.children);
      if (found.length > 0) return found;
    }
    return [];
  }

  // Get the parentId of a group (null = root, undefined = not found)
  function getGroupParentId(groupId: string, list: ConnectionGroup[], parentId: string | null = null): string | null | undefined {
    for (const g of list) {
      if (g.id === groupId) return parentId;
      const found = getGroupParentId(groupId, g.children, g.id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async function reorderGroup(draggedId: string, targetId: string, position: 'before' | 'after') {
    if (draggedId === targetId) return;
    const siblings = getGroupSiblings(draggedId, groups);
    const targetParentId = getGroupParentId(targetId, groups);
    const draggedParentId = getGroupParentId(draggedId, groups);

    // If they're at different levels, first reparent then reorder
    let workingSiblings = siblings;
    if (draggedParentId !== targetParentId) {
      // Reparent first (synchronously by optimistic update)
      await fetch(`/api/v1/connections/groups/${draggedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ parentId: targetParentId ?? null }),
      });
      // Treat target's siblings as working set for ordering
      workingSiblings = getGroupSiblings(targetId, groups);
    }

    // Build reordered array: remove dragged, insert at correct position relative to target
    const withoutDragged = workingSiblings.filter(g => g.id !== draggedId);
    const targetIdx = withoutDragged.findIndex(g => g.id === targetId);
    const insertIdx = targetIdx === -1 ? withoutDragged.length : position === 'before' ? targetIdx : targetIdx + 1;
    const draggedGroup = workingSiblings.find(g => g.id === draggedId) ?? { id: draggedId } as ConnectionGroup;
    const reordered = [...withoutDragged.slice(0, insertIdx), draggedGroup, ...withoutDragged.slice(insertIdx)];

    const items = reordered.map((g, i) => ({ id: g.id, sortOrder: i * 10 }));
    await fetch('/api/v1/connections/groups/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ items }),
    });
    fetchConnections();
  }

  function getDropPosition(e: React.DragEvent): 'before' | 'after' | 'inside' {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    // Use 40% zones so before/after are easier to hit without needing to aim precisely
    if (y < h * 0.40) return 'before';
    if (y > h * 0.60) return 'after';
    return 'inside';
  }

  function handleGroupDrop(e: React.DragEvent, groupId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (draggingConnId) {
      moveConnection(draggingConnId, groupId);
      setExpandedGroups((prev) => persistExpandedGroups(new Set([...prev, groupId])));
    } else if (draggingGroupId && draggingGroupId !== groupId) {
      if (!isAncestorOrSelf(groupId, draggingGroupId, groups)) {
        const pos = dropIndicator?.id === groupId ? dropIndicator.position : 'inside';
        if (pos === 'inside') {
          void moveGroup(draggingGroupId, groupId);
        } else {
          void reorderGroup(draggingGroupId, groupId, pos);
        }
      }
    }
    setDraggingConnId(null);
    setDraggingGroupId(null);
    setDragOverId(null);
    setDropIndicator(null);
    setConnDropIndicator(null);
  }

  function handleUngroupedDrop(e: React.DragEvent) {
    e.preventDefault();
    if (draggingConnId) moveConnection(draggingConnId, null);
    else if (draggingGroupId) void moveGroup(draggingGroupId, null);
    setDraggingConnId(null);
    setDraggingGroupId(null);
    setDragOverId(null);
    setDropIndicator(null);
    setConnDropIndicator(null);
  }

  function handleConnContextMenu(e: RMouseEvent, conn: Connection) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, conn });
  }

  function renderConnection(conn: Connection) {
    const status = healthMap[conn.id];
    const indicator = connDropIndicator?.id === conn.id ? connDropIndicator.position : null;
    return (
      <div
        key={conn.id}
        draggable
        onDragStart={(e) => handleDragStart(e, conn.id)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => {
          if (!draggingConnId || draggingConnId === conn.id) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = e.clientY - rect.top;
          const pos = y < rect.height / 2 ? 'before' : 'after';
          setConnDropIndicator({ id: conn.id, position: pos });
          setDragOverId(null);
        }}
        onDragLeave={() => {
          if (connDropIndicator?.id === conn.id) setConnDropIndicator(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (draggingConnId && draggingConnId !== conn.id) {
            const pos = connDropIndicator?.id === conn.id ? connDropIndicator.position : 'after';
            reorderConnection(draggingConnId, conn.id, pos);
          }
          setDraggingConnId(null);
          setConnDropIndicator(null);
        }}
        onClick={() => onConnect(conn)}
        onContextMenu={(e) => handleConnContextMenu(e, conn)}
        className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-surface-hover rounded mx-1 group/conn relative ${
          indicator ? 'z-10' : ''
        }`}
      >
        {indicator === 'before' && (
          <div className="absolute -top-px left-2 right-2 h-0.5 bg-accent rounded-full pointer-events-none" />
        )}
        {indicator === 'after' && (
          <div className="absolute -bottom-px left-2 right-2 h-0.5 bg-accent rounded-full pointer-events-none" />
        )}
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            status === 'up' ? 'bg-green-500' :
            status === 'down' ? 'bg-red-500' :
            'bg-border'
          }`}
          title={status === 'up' ? 'Reachable' : status === 'down' ? 'Unreachable' : healthMonitorEnabled ? 'Checking...' : ''}
        />
        <ProtocolBadge protocol={conn.protocol} />
        <span className="truncate flex-1 text-text-primary">{conn.name}</span>
        {conn.tags && conn.tags.length > 0 && (
          <span className="flex gap-0.5 shrink-0">
            {conn.tags.slice(0, 2).map((t) => (
              <span key={t} className="px-1 py-px rounded bg-accent/10 text-accent text-[9px] leading-tight">{t}</span>
            ))}
            {conn.tags.length > 2 && <span className="text-[9px] text-text-secondary">+{conn.tags.length - 2}</span>}
          </span>
        )}
        <div className="hidden group-hover/conn:flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setEditingConnection(conn); setShowModal(true); }}
            title="Edit"
            className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface"
          >
            <EditIcon />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); deleteConnection(conn.id); }}
            title="Delete"
            className="p-1 rounded text-text-secondary hover:text-red-400 hover:bg-surface"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    );
  }

  function countConnections(group: ConnectionGroup): number {
    return group.connections.length + group.children.reduce((s, c) => s + countConnections(c), 0);
  }

  // Search filter helpers
  const q = searchQuery.trim().toLowerCase();
  const hasTagFilter = selectedTags.size > 0;

  // Collect all unique tags across all connections for the tag filter UI
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    const addTags = (conns: Connection[]) => conns.forEach((c) => c.tags?.forEach((t) => tagSet.add(t)));
    const walkGroups = (gs: ConnectionGroup[]) => gs.forEach((g) => { addTags(g.connections); walkGroups(g.children); });
    walkGroups(groups);
    addTags(ungrouped);
    addTags(sharedConnections);
    return Array.from(tagSet).sort();
  }, [groups, ungrouped, sharedConnections]);

  function connMatchesFilter(conn: Connection): boolean {
    if (q && !conn.name.toLowerCase().includes(q) && !(conn.host || '').toLowerCase().includes(q)) return false;
    if (hasTagFilter && !conn.tags?.some((t) => selectedTags.has(t))) return false;
    return true;
  }

  function filterGroup(group: ConnectionGroup): ConnectionGroup | null {
    if (!q && !hasTagFilter) return group;
    const filteredConns = group.connections.filter(connMatchesFilter);
    const filteredChildren = group.children.map(filterGroup).filter(Boolean) as ConnectionGroup[];
    if (filteredConns.length === 0 && filteredChildren.length === 0) return null;
    return { ...group, connections: filteredConns, children: filteredChildren };
  }

  const isFiltering = !!q || hasTagFilter;
  const filteredGroups = isFiltering ? groups.map(filterGroup).filter(Boolean) as ConnectionGroup[] : groups;
  const filteredUngrouped = ungrouped.filter(connMatchesFilter);
  const filteredShared = sharedConnections.filter(connMatchesFilter);

  function renderInlineNewFolder() {
    return (
      <div className="flex items-center gap-1 px-2 py-1 mx-1 my-0.5 rounded bg-surface border border-accent/50">
        <FolderIcon size={12} />
        <input
          ref={inlineNewGroupInputRef}
          value={inlineNewGroup?.name ?? ''}
          onChange={e => setInlineNewGroup(prev => prev ? { ...prev, name: e.target.value } : null)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); void commitInlineNewFolder(); }
            if (e.key === 'Escape') cancelInlineNewFolder();
          }}
          placeholder="Folder name…"
          className="flex-1 min-w-0 px-1 py-0 text-sm bg-transparent text-text-primary focus:outline-hidden"
        />
        <button
          onMouseDown={e => { e.preventDefault(); void commitInlineNewFolder(); }}
          className="p-0.5 rounded text-green-500 hover:bg-surface-hover"
          title="Create (Enter)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
        <button
          onMouseDown={e => { e.preventDefault(); cancelInlineNewFolder(); }}
          className="p-0.5 rounded text-text-secondary hover:bg-surface-hover hover:text-red-400"
          title="Cancel (Esc)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    );
  }

  function renderGroup(group: ConnectionGroup, depth = 0) {
    const expanded = isFiltering ? true : expandedGroups.has(group.id);
    const isDraggingThisGroup = draggingGroupId === group.id;
    const isInvalidDropTarget = draggingGroupId !== null &&
      isAncestorOrSelf(group.id, draggingGroupId, groups);
    const indicator = dropIndicator?.id === group.id && !isInvalidDropTarget ? dropIndicator.position : null;
    // Legacy connection-drag highlight
    const isConnDropTarget = draggingConnId !== null && dragOverId === group.id;
    const totalCount = countConnections(group);

    return (
      // relative wrapper so absolute indicators don't shift layout (prevents jumping)
      <div key={group.id} className="relative" style={isDraggingThisGroup ? { opacity: 0.45 } : undefined}>
        {/* Insert-before: absolute so it has zero layout impact */}
        {indicator === 'before' && (
          <div className="absolute top-0 left-2 right-2 h-0.5 bg-accent rounded-full -translate-y-px z-20 pointer-events-none" />
        )}
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setDraggingGroupId(group.id);
            setDraggingConnId(null);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={handleDragEnd}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded mx-1 cursor-pointer group/folder',
            indicator === 'inside' || isConnDropTarget
              ? 'bg-accent/20 ring-1 ring-inset ring-accent/40'
              : 'hover:bg-surface-hover',
          )}
          onClick={() => toggleGroup(group.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setFolderContextMenu({ x: e.clientX, y: e.clientY, group });
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isInvalidDropTarget) {
              e.dataTransfer.dropEffect = 'move';
              if (draggingGroupId) {
                // For folder drags: compute before/after/inside from mouse position
                const pos = getDropPosition(e);
                setDropIndicator({ id: group.id, position: pos });
              } else {
                // For connection drags: always "inside"
                setDragOverId(group.id);
              }
            }
          }}
          onDragLeave={(e) => {
            e.stopPropagation();
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragOverId(null);
            setDropIndicator(null);
          }}
          onDrop={(e) => handleGroupDrop(e, group.id)}
        >
          <svg
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={clsx('text-text-secondary transition-transform shrink-0', expanded && 'rotate-90')}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <FolderIcon />
          {renamingGroupId === group.id ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') renameGroup(group.id, renameValue);
                if (e.key === 'Escape') setRenamingGroupId(null);
              }}
              onBlur={() => renameGroup(group.id, renameValue)}
              className="flex-1 px-1 py-0 text-sm bg-surface border border-accent rounded text-text-primary focus:outline-hidden"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="text-text-secondary font-medium truncate flex-1">{group.name}</span>
          )}
          <span className="text-xs text-text-secondary mr-1">{totalCount}</span>
          <button
            onClick={(e) => { e.stopPropagation(); requestDeleteGroup(group); }}
            title="Delete folder"
            className="hidden group-hover/folder:flex p-1 rounded text-text-secondary hover:text-red-400 hover:bg-surface"
          >
            <TrashIcon size={11} />
          </button>
        </div>
        {/* Insert-after: absolute so it has zero layout impact */}
        {indicator === 'after' && (
          <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent rounded-full translate-y-px z-20 pointer-events-none" />
        )}

        {expanded && (
          <div
            className="ml-3 border-l border-border/40 pl-1"
            onDragOver={(e) => {
              if (draggingConnId) {
                e.preventDefault();
                e.stopPropagation();
                setDragOverId(group.id);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setDragOverId(null);
            }}
            onDrop={(e) => {
              if (draggingConnId) handleGroupDrop(e, group.id);
            }}
          >
            {group.connections.map(renderConnection)}
            {group.children.map(g => renderGroup(g, depth + 1))}
            {inlineNewGroup?.parentId === group.id && renderInlineNewFolder()}
            {group.connections.length === 0 && group.children.length === 0 && !inlineNewGroup && (
              <p className="text-xs text-text-secondary px-3 py-1 italic">Empty folder</p>
            )}
          </div>
        )}
      </div>
    );
  }

  const contextMenuPos = contextMenu ? getClampedMenuPosition(contextMenu.x, contextMenu.y, 190, 280) : null;
  const bgMenuPos = bgContextMenu ? getClampedMenuPosition(bgContextMenu.x, bgContextMenu.y, 180, 120) : null;
  const folderMenuPos = folderContextMenu ? getClampedMenuPosition(folderContextMenu.x, folderContextMenu.y, 200, 320) : null;

  const bgSubmenuOpenLeft = !!bgMenuPos && typeof window !== 'undefined' && bgMenuPos.x + 180 + 150 + VIEWPORT_PADDING > window.innerWidth;
  const bgSubmenuOpenUp = !!bgMenuPos && typeof window !== 'undefined' && bgMenuPos.y + 300 + VIEWPORT_PADDING > window.innerHeight;

  const folderSubmenuOpenLeft = !!folderMenuPos && typeof window !== 'undefined' && folderMenuPos.x + 200 + 150 + VIEWPORT_PADDING > window.innerWidth;
  const folderSubmenuOpenUp = !!folderMenuPos && typeof window !== 'undefined' && folderMenuPos.y + 300 + VIEWPORT_PADDING > window.innerHeight;

  return (
    <>
      <aside
        className="bg-surface-alt border-r border-border flex flex-col shrink-0 overflow-hidden h-full min-h-0"
        style={width !== undefined ? { width } : { width: 240 }}
      >
        {/* Header */}
        <div className="p-2 border-b border-border space-y-1.5">
          <button
            onClick={() => { setEditingConnection(null); setNewConnGroupId(null); setShowModal(true); }}
            className="w-full py-1.5 px-3 text-sm bg-accent text-white rounded hover:bg-accent-hover font-medium"
          >
            + New Connection
          </button>

          <button
            onClick={() => startInlineNewFolder(null)}
            className="w-full py-1 px-3 text-sm border border-border rounded text-text-secondary hover:bg-surface-hover flex items-center gap-1.5"
          >
            <FolderIcon />
            + New Folder
          </button>

          {/* Import/Export row */}
          <div className="flex gap-1">
            <button
              onClick={() => setShowExportConfirm(true)}
              className="flex-1 py-1 px-2 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover flex items-center justify-center gap-1"
              title="Export connections to JSON"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export
            </button>
            <label className="flex-1 py-1 px-2 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover flex items-center justify-center gap-1 cursor-pointer">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import
              <input type="file" accept=".json" className="hidden" onChange={handleImport} />
            </label>
          </div>

          {/* Search bar + Tag filter button */}
          <div className="flex gap-1 items-center">
            <div className="relative flex-1">
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setSearchQuery(''); }}
                placeholder="Find connection..."
                className="w-full pl-7 pr-6 py-1 text-xs bg-surface border border-border rounded text-text-primary placeholder:text-text-secondary focus:outline-hidden focus:border-accent"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary"
                  tabIndex={-1}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>

            {/* Tag filter button — only shown when tags exist */}
            {allTags.length > 0 && (
              <div className="relative" ref={tagDropdownRef}>
                <button
                  type="button"
                  title="Filter by tag"
                  onClick={() => setShowTagDropdown(v => !v)}
                  className={`flex items-center gap-1 px-2 py-1 rounded border text-xs transition-colors ${
                    selectedTags.size > 0
                      ? 'bg-accent/15 border-accent/40 text-accent'
                      : 'bg-surface border-border text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                    <line x1="7" y1="7" x2="7.01" y2="7"/>
                  </svg>
                  {selectedTags.size > 0 && <span className="font-medium">{selectedTags.size}</span>}
                </button>

                {showTagDropdown && (
                  <div className="absolute right-0 top-full mt-1 z-50 bg-surface-alt border border-border rounded shadow-lg py-1 min-w-[140px] max-h-60 overflow-y-auto">
                    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary select-none">Filter by tag</div>
                    {allTags.map((tag) => {
                      const active = selectedTags.has(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setSelectedTags(prev => {
                            const next = new Set(prev);
                            if (next.has(tag)) next.delete(tag); else next.add(tag);
                            return next;
                          })}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface-hover"
                        >
                          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${active ? 'bg-accent border-accent' : 'border-border'}`}>
                            {active && <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5"><polyline points="2 6 5 9 10 3"/></svg>}
                          </span>
                          <span className={active ? 'text-text-primary' : 'text-text-secondary'}>{tag}</span>
                        </button>
                      );
                    })}
                    {selectedTags.size > 0 && (
                      <>
                        <div className="border-t border-border my-1" />
                        <button
                          type="button"
                          onClick={() => { setSelectedTags(new Set()); setShowTagDropdown(false); }}
                          className="w-full px-3 py-1.5 text-xs text-left text-red-400 hover:bg-surface-hover"
                        >
                          Clear all
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Connection list */}
        <div
          className={clsx(
            'flex-1 min-h-0 py-2 overflow-y-auto transition-colors',
            (draggingConnId || draggingGroupId) && dragOverId === 'ungrouped' && 'bg-accent/5',
          )}
          onDragOver={(e) => { e.preventDefault(); setDragOverId('ungrouped'); }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={handleUngroupedDrop}
          onContextMenu={(e) => {
            // Only trigger on the background, not on child connection/folder elements
            if (e.target === e.currentTarget) {
              e.preventDefault();
              setBgContextMenu({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          {inlineNewGroup?.parentId === null && renderInlineNewFolder()}
          {filteredGroups.map(g => renderGroup(g))}
          {filteredUngrouped.map(renderConnection)}

          {filteredShared.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-1.5 px-3 py-1 text-xs text-text-secondary font-medium uppercase tracking-wider">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                Shared
              </div>
              {filteredShared.map((conn) => (
                <div
                  key={conn.id}
                  onClick={() => onConnect(conn)}
                  onContextMenu={(e) => handleConnContextMenu(e, conn)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-surface-hover rounded mx-1"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      healthMap[conn.id] === 'up' ? 'bg-green-500' :
                      healthMap[conn.id] === 'down' ? 'bg-red-500' :
                      'bg-border'
                    }`}
                    title={healthMap[conn.id] === 'up' ? 'Reachable' : healthMap[conn.id] === 'down' ? 'Unreachable' : healthMonitorEnabled ? 'Checking...' : ''}
                  />
                  <ProtocolBadge protocol={conn.protocol} />
                  <span className="truncate flex-1 text-text-primary">{conn.name}</span>
                </div>
              ))}
            </div>
          )}

          {(draggingConnId || draggingGroupId) && (
            <p className="text-xs text-text-secondary text-center py-2 opacity-60">
              Drop here to remove from folder
            </p>
          )}

          {groups.length === 0 && ungrouped.length === 0 && sharedConnections.length === 0 && (
            <p className="text-xs text-text-secondary text-center px-4 mt-8 leading-relaxed">
              No connections yet.<br />
              Click "+ New Connection" to get started.
            </p>
          )}
          {isFiltering && filteredGroups.length === 0 && filteredUngrouped.length === 0 && filteredShared.length === 0 && (
            <p className="text-xs text-text-secondary text-center px-4 mt-8 leading-relaxed">
              No connections match the current filter.
            </p>
          )}
        </div>
      </aside>

      {showModal && (
        <ConnectionModal
          connection={editingConnection}
          groups={flattenGroups(groups)}
          prefill={duplicatePrefill ?? (!editingConnection ? {
            name: '',
            protocol: newConnProtocol,
            host: '',
            port: { rdp: 3389, ssh: 22, smb: 445, vnc: 5900, sftp: 22, ftp: 21, telnet: 23, postgres: 5432, mysql: 3306 }[newConnProtocol] ?? 3389,
            username: '',
            groupId: newConnGroupId,
            shared: false,
            smbShare: '',
            smbDomain: '',
            tunnels: [],
          } : undefined)}
          onClose={() => {
            setShowModal(false);
            setEditingConnection(null);
            setDuplicatePrefill(null);
            setNewConnGroupId(null);
            setNewConnProtocol('rdp');
          }}
          onSaved={() => {
            setShowModal(false);
            setEditingConnection(null);
            setDuplicatePrefill(null);
            setNewConnGroupId(null);
            setNewConnProtocol('rdp');
            fetchConnections();
          }}
        />
      )}

      {/* Export info popup */}
      {showExportConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl p-5 max-w-sm w-full mx-4">
            <div className="flex items-start gap-3 mb-4">
              <div className="shrink-0 w-9 h-9 rounded-full bg-accent/15 flex items-center justify-center text-accent">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary mb-1">Exporting connections</h3>
                <p className="text-xs text-text-secondary leading-relaxed">
                  This export only includes your <span className="font-medium text-text-primary">connection tree</span> (names, hosts, ports, usernames).
                  Passwords and private keys are <span className="font-medium text-text-primary">not included</span>.
                </p>
                <p className="text-xs text-text-secondary leading-relaxed mt-2">
                  If you need a full server backup including configuration, recordings and credentials, go to{' '}
                  <span className="font-medium text-accent">Settings → Backup &amp; Restore</span>.
                </p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowExportConfirm(false)}
                className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { setShowExportConfirm(false); handleExport(); }}
                className="px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded font-medium"
              >
                Export connections
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import result dialog */}
      {importResult && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl p-5 max-w-sm w-full mx-4">
            <div className="flex items-start gap-3 mb-4">
              {'error' in importResult ? (
                <div className="shrink-0 w-9 h-9 rounded-full bg-red-500/15 flex items-center justify-center text-red-400">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                </div>
              ) : (
                <div className="shrink-0 w-9 h-9 rounded-full bg-green-500/15 flex items-center justify-center text-green-400">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
              <div>
                {'error' in importResult ? (
                  <>
                    <h3 className="text-sm font-semibold text-text-primary mb-1">Import failed</h3>
                    <p className="text-xs text-text-secondary leading-relaxed">{importResult.error}</p>
                  </>
                ) : (
                  <>
                    <h3 className="text-sm font-semibold text-text-primary mb-1">Import successful</h3>
                    <p className="text-xs text-text-secondary leading-relaxed">
                      Imported <span className="font-medium text-text-primary">{importResult.connectionsCreated} connection{importResult.connectionsCreated !== 1 ? 's' : ''}</span>
                      {importResult.groupsCreated > 0 && <> in <span className="font-medium text-text-primary">{importResult.groupsCreated} folder{importResult.groupsCreated !== 1 ? 's' : ''}</span></>}.
                    </p>
                  </>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setImportResult(null)}
                className="px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded font-medium"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete folder confirmation dialog */}
      {deleteFolderConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl p-5 max-w-sm w-full mx-4">
            <div className="flex items-start gap-3 mb-4">
              <div className="shrink-0 w-9 h-9 rounded-full bg-red-500/15 flex items-center justify-center">
                <TrashIcon size={16} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary mb-1">Delete "{deleteFolderConfirm.group.name}"?</h3>
                <p className="text-xs text-text-secondary leading-relaxed">
                  This folder contains <span className="font-semibold text-red-400">{deleteFolderConfirm.connCount} connection{deleteFolderConfirm.connCount !== 1 ? 's' : ''}</span>.
                  Deleting this folder will permanently remove all connections inside it.
                  This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setDeleteFolderConfirm(null)}
                className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => confirmDeleteGroup(deleteFolderConfirm.group.id)}
                className="px-3 py-1.5 text-xs bg-red-500 hover:bg-red-600 text-white rounded font-medium"
              >
                Delete folder &amp; {deleteFolderConfirm.connCount} connection{deleteFolderConfirm.connCount !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connection right-click context menu */}
      {contextMenu && contextMenuPos && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-surface-alt border border-border rounded shadow-lg py-1 text-sm min-w-[160px]"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
        >
          <button
            className="w-full px-4 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
            onClick={() => { onConnect(contextMenu.conn); setContextMenu(null); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
            Connect
          </button>
          {contextMenu.conn.protocol === 'ssh' && (
            <button
              className="w-full px-4 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
              onClick={() => { onConnect({ ...contextMenu.conn, protocol: 'sftp' }); setContextMenu(null); }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <polyline points="9 14 12 17 15 14" />
              </svg>
              Open SFTP
            </button>
          )}
          <button
            className="w-full px-4 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
            onClick={() => { handleDuplicate(contextMenu.conn); setContextMenu(null); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Duplicate Configuration
          </button>
          {!contextMenu.conn.isShared && (
            <>
              <div className="border-t border-border my-1" />
              <button
                className="w-full px-4 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
                onClick={() => { setEditingConnection(contextMenu.conn); setShowModal(true); setContextMenu(null); }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Edit
              </button>
              <button
                className="w-full px-4 py-1.5 text-left hover:bg-surface-hover text-red-400 flex items-center gap-2"
                onClick={() => { deleteConnection(contextMenu.conn.id); setContextMenu(null); }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                Delete
              </button>
            </>
          )}
        </div>
      )}

      {/* Background right-click context menu */}
      {bgContextMenu && bgMenuPos && (
        <div
          ref={bgMenuRef}
          className="fixed z-50 bg-surface-alt border border-border rounded shadow-lg py-1 text-sm min-w-[170px]"
          style={{ left: bgMenuPos.x, top: bgMenuPos.y }}
          onMouseLeave={() => setShowNewConnSubmenu(false)}
        >
          {/* New Connection with flyout */}
          <div
            className="relative"
            onMouseEnter={() => setShowNewConnSubmenu(true)}
          >
            <button className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center justify-between gap-2">
              <span className="flex items-center gap-2"><PlugIcon />New Connection</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            {showNewConnSubmenu && (
              <div
                className={clsx(
                  'absolute bg-surface-alt border border-border rounded shadow-lg py-1 min-w-[130px] z-50',
                  bgSubmenuOpenLeft ? 'right-full mr-0.5' : 'left-full ml-0.5',
                  bgSubmenuOpenUp ? 'bottom-0' : 'top-0',
                )}
              >
                <ProtocolSubmenuItems groupId={null} onSelect={(p) => { openNewConnectionInFolder(null, p); setBgContextMenu(null); setShowNewConnSubmenu(false); }} />
              </div>
            )}
          </div>
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
            onClick={() => { startInlineNewFolder(null); setBgContextMenu(null); }}
          >
            <FolderIcon />
            New Folder
          </button>
        </div>
      )}

      {/* Folder right-click context menu */}
      {folderContextMenu && folderMenuPos && (
        <div
          ref={folderMenuRef}
          className="fixed z-50 bg-surface-alt border border-border rounded shadow-lg py-1 text-sm min-w-[180px]"
          style={{ left: folderMenuPos.x, top: folderMenuPos.y }}
          onMouseLeave={() => setShowNewConnSubmenu(false)}
        >
          {onConnectMultiple && (
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
              onClick={() => {
                const conns = getAllConnectionsInGroup(folderContextMenu.group);
                if (conns.length > 0) onConnectMultiple(conns);
                setFolderContextMenu(null);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Connect All ({getAllConnectionsInGroup(folderContextMenu.group).length})
            </button>
          )}
          {onConnectMultiple && <div className="border-t border-border my-1" />}
          {/* New Connection with flyout */}
          <div
            className="relative"
            onMouseEnter={() => setShowNewConnSubmenu(true)}
          >
            <button className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center justify-between gap-2">
              <span className="flex items-center gap-2"><PlugIcon />New Connection</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            {showNewConnSubmenu && (
              <div
                className={clsx(
                  'absolute bg-surface-alt border border-border rounded shadow-lg py-1 min-w-[130px] z-50',
                  folderSubmenuOpenLeft ? 'right-full mr-0.5' : 'left-full ml-0.5',
                  folderSubmenuOpenUp ? 'bottom-0' : 'top-0',
                )}
              >
                <ProtocolSubmenuItems groupId={folderContextMenu.group.id} onSelect={(p) => { openNewConnectionInFolder(folderContextMenu.group.id, p); setFolderContextMenu(null); setShowNewConnSubmenu(false); }} />
              </div>
            )}
          </div>
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
            onClick={() => { startInlineNewFolder(folderContextMenu.group.id); setFolderContextMenu(null); }}
          >
            <SubfolderIcon />
            New Subfolder
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-text-primary flex items-center gap-2"
            onClick={() => {
              setRenamingGroupId(folderContextMenu.group.id);
              setRenameValue(folderContextMenu.group.name);
              setExpandedGroups((prev) => persistExpandedGroups(new Set([...prev, folderContextMenu.group.id])));
              setFolderContextMenu(null);
            }}
          >
            <PenIcon />
            Rename
          </button>
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-surface-hover text-red-400 flex items-center gap-2"
            onClick={() => { requestDeleteGroup(folderContextMenu.group); setFolderContextMenu(null); }}
          >
            <TrashIcon size={13} />
            Delete Folder
          </button>
        </div>
      )}
    </>
  );
}
