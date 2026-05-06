import { useRef, useState, useEffect, type ReactNode, type FormEvent } from 'react';
import { type Protocol } from '../types/protocol.js';
interface Connection {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  groupId: string | null;
  shared?: number;
}

interface FlatGroup {
  id: string;
  name: string;
}

export interface ConnectionPrefill {
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  groupId: string | null;
  shared: boolean;
  smbShare: string;
  smbDomain: string;
  tunnels: TunnelDef[];
}

interface ConnectionModalProps {
  connection: Connection | null;
  groups: FlatGroup[];
  onClose: () => void;
  onSaved: () => void;
  /** Pre-fill fields for duplicate/copy mode (connection must be null) */
  prefill?: ConnectionPrefill;
}

interface TunnelDef { id: string; localPort: string; remoteHost: string; remotePort: string; }

const defaultPorts: Record<string, number> = {
  ssh: 22,
  rdp: 3389,
  smb: 445,
  vnc: 5900,
  sftp: 22,
  ftp: 21,
  telnet: 23,
  postgres: 5432,
  mysql: 3306,
};

type ProtocolCategory = 'remote-control' | 'terminal' | 'file-browser' | 'db';

function getCategoryForProtocol(p: Protocol): ProtocolCategory {
  if (p === 'rdp' || p === 'vnc') return 'remote-control';
  if (p === 'ssh' || p === 'telnet') return 'terminal';
  if (p === 'smb' || p === 'sftp' || p === 'ftp') return 'file-browser';
  return 'db';
}

const PROTOCOL_CATEGORIES: { id: ProtocolCategory; label: string; headerIcon: ReactNode; protocols: { id: Protocol; label: string; icon: ReactNode }[] }[] = [
  {
    id: 'remote-control',
    label: 'Remote Control',
    headerIcon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
    protocols: [
      { id: 'rdp', label: 'RDP', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )},
      { id: 'vnc', label: 'VNC', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <circle cx="12" cy="10" r="3" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )},
    ],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    headerIcon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
    protocols: [
      { id: 'ssh', label: 'SSH', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      )},
      { id: 'telnet', label: 'Telnet', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="5" x2="20" y2="5" />
          <line x1="12" y1="12" x2="20" y2="12" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      )},
    ],
  },
  {
    id: 'file-browser',
    label: 'File Browser',
    headerIcon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
    protocols: [
      { id: 'smb', label: 'SMB', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      )},
      { id: 'sftp', label: 'SFTP', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <polyline points="9 14 12 17 15 14" />
        </svg>
      )},
      { id: 'ftp', label: 'FTP', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="12" x2="12" y2="18" />
          <polyline points="9 15 12 18 15 15" />
        </svg>
      )},
    ],
  },
  {
    id: 'db',
    label: 'DB',
    headerIcon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
        <path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4" />
      </svg>
    ),
    protocols: [
      { id: 'postgres', label: 'PostgreSQL', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <ellipse cx="12" cy="6" rx="8" ry="3" />
          <path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
          <path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4" />
        </svg>
      )},
      { id: 'mysql', label: 'MySQL', icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <ellipse cx="12" cy="6" rx="8" ry="3" />
          <path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
          <path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4" />
          <line x1="20" y1="14" x2="20" y2="20" />
        </svg>
      )},
    ],
  },
];

export function ConnectionModal({ connection, groups, onClose, onSaved, prefill }: ConnectionModalProps) {

  const [name, setName] = useState(prefill?.name ?? connection?.name ?? '');
  const [protocol, setProtocol] = useState<Protocol>(prefill?.protocol ?? connection?.protocol ?? 'rdp');
  const [host, setHost] = useState(prefill?.host ?? connection?.host ?? '');
  const [port, setPort] = useState(prefill?.port ?? connection?.port ?? 3389);
  const [username, setUsername] = useState(prefill?.username ?? '');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [groupId, setGroupId] = useState<string>(prefill?.groupId ?? connection?.groupId ?? '');
  const [shared, setShared] = useState<boolean>(
    prefill ? prefill.shared : connection ? (connection.shared === 1) : false,
  );
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [localGroups, setLocalGroups] = useState<FlatGroup[]>(groups);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [tunnels, setTunnels] = useState<TunnelDef[]>(prefill?.tunnels ?? []);
  const [smbShare, setSmbShare] = useState(prefill?.smbShare ?? '');
  const [smbDomain, setSmbDomain] = useState(prefill?.smbDomain ?? '');
  // DB-specific fields
  const [dbDatabase, setDbDatabase] = useState('');
  const [dbSslMode, setDbSslMode] = useState<'disable' | 'require' | 'verify-ca' | 'verify-full'>('disable');
  const [dbRowLimit, setDbRowLimit] = useState('');
  const [dbQueryTimeout, setDbQueryTimeout] = useState('');
  const [dbIdleTimeout, setDbIdleTimeout] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [sharingOpen, setSharingOpen] = useState(false);
  const [shareRoles, setShareRoles] = useState<{ id: string; name: string }[]>([]);
  const [shareUsers, setShareUsers] = useState<{ id: string; username: string }[]>([]);
  const [selectedShareRoles, setSelectedShareRoles] = useState<string[]>([]);
  const [selectedShareUsers, setSelectedShareUsers] = useState<string[]>([]);
  const [skipCertValidation, setSkipCertValidation] = useState(true);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // Load full details when editing an existing connection
  useEffect(() => {
    if (!connection?.id) return;
    fetch(`/api/v1/connections/${connection.id}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (d.username) setUsername(d.username);
        if (d.tunnels) setTunnels(d.tunnels.map((t: Omit<TunnelDef, 'id'> & { localPort: number; remotePort: number }) => ({
          id: crypto.randomUUID(),
          localPort: String(t.localPort),
          remoteHost: t.remoteHost,
          remotePort: String(t.remotePort),
        })));
        if (d.extraConfig?.share) setSmbShare(d.extraConfig.share as string);
        if (d.extraConfig?.domain) setSmbDomain(d.extraConfig.domain as string);
        if (d.extraConfig?.defaultDatabase) setDbDatabase(d.extraConfig.defaultDatabase as string);
        if (d.extraConfig?.sslMode) setDbSslMode(d.extraConfig.sslMode as typeof dbSslMode);
        if (d.extraConfig?.rowLimit) setDbRowLimit(String(d.extraConfig.rowLimit));
        if (d.extraConfig?.queryTimeout) setDbQueryTimeout(String(d.extraConfig.queryTimeout));
        if (d.extraConfig?.idleTimeoutMinutes) setDbIdleTimeout(String(d.extraConfig.idleTimeoutMinutes));
        if (d.tags && Array.isArray(d.tags)) setTags(d.tags);
        if (d.skipCertValidation !== undefined) setSkipCertValidation(!!d.skipCertValidation);
        if (d.shares && Array.isArray(d.shares)) {
          setSelectedShareRoles(d.shares.filter((s: { shareType: string }) => s.shareType === 'role').map((s: { targetId: string }) => s.targetId));
          setSelectedShareUsers(d.shares.filter((s: { shareType: string }) => s.shareType === 'user').map((s: { targetId: string }) => s.targetId));
          if (d.shares.length > 0) setSharingOpen(true);
        }
      })
      .catch(() => {});
  }, [connection?.id]);

  // Load roles and users for sharing dropdowns
  useEffect(() => {
    fetch('/api/v1/roles', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setShareRoles(d.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))); })
      .catch(() => {});
    fetch('/api/v1/users', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d?.users && Array.isArray(d.users)) setShareUsers(d.users.map((u: { id: string; username: string }) => ({ id: u.id, username: u.username }))); })
      .catch(() => {});
  }, []);

  function handleProtocolChange(p: Protocol) {
    setProtocol(p);
    if (!connection) setPort(defaultPorts[p]);
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/v1/connections/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const newGroup: FlatGroup = { id: data.id, name: data.name };
      setLocalGroups((prev) => [...prev, newGroup]);
      setGroupId(data.id);
      setNewFolderName('');
      setShowNewFolder(false);
    } catch { /* ignore */ }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const tunnelsClean = tunnels.filter((t) => t.localPort && t.remoteHost && t.remotePort);
      const body: Record<string, unknown> = {
        name,
        protocol,
        host,
        port,
        username,
        groupId: groupId || null,
        shared,
        ...(protocol === 'ssh' && privateKey ? { privateKey } : {}),
      };
      // Only include password if the user typed one
      if (password) body.password = password;
      if (protocol === 'ssh') {
        body.tunnels = tunnelsClean.map(({ localPort, remoteHost, remotePort }) => ({
          localPort: parseInt(localPort, 10),
          remoteHost,
          remotePort: parseInt(remotePort, 10),
        }));
      }
      if (protocol === 'smb') {
        body.extraConfig = { share: smbShare.trim(), ...(smbDomain.trim() ? { domain: smbDomain.trim() } : {}) };
      }
      if (protocol === 'postgres' || protocol === 'mysql') {
        if (!dbDatabase.trim()) { setError('Default Database is required for database connections'); setSaving(false); return; }
        const dbCfg: Record<string, unknown> = { defaultDatabase: dbDatabase.trim() };
        if (dbSslMode !== 'disable') dbCfg.sslMode = dbSslMode;
        if (dbRowLimit.trim()) dbCfg.rowLimit = parseInt(dbRowLimit, 10);
        if (dbQueryTimeout.trim()) dbCfg.queryTimeout = parseInt(dbQueryTimeout, 10);
        if (dbIdleTimeout.trim()) dbCfg.idleTimeoutMinutes = parseInt(dbIdleTimeout, 10);
        body.extraConfig = dbCfg;
      }
      if (protocol === 'rdp') {
        body.skipCertValidation = skipCertValidation;
      }
      if (tags.length > 0) body.tags = tags;
      const url = connection ? `/api/v1/connections/${connection.id}` : '/api/v1/connections';
      const method = connection ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      let resultData: Record<string, unknown> = {};
      if (!res.ok) {
        let errMsg = `Server error (${res.status})`;
        try {
          const data = await res.json();
          errMsg = data.error || errMsg;
        } catch { /* server returned non-JSON (e.g. HTML error page) */ }
        throw new Error(errMsg);
      } else {
        try { resultData = await res.json(); } catch { /* ignore */ }
      }

      // Save shares if any were configured
      const connId = connection?.id || resultData.id as string;
      if (connId && (selectedShareRoles.length > 0 || selectedShareUsers.length > 0)) {
        const shares = [
          ...selectedShareRoles.map(id => ({ shareType: 'role', targetId: id })),
          ...selectedShareUsers.map(id => ({ shareType: 'user', targetId: id })),
        ];
        await fetch(`/api/v1/connections/${connId}/shares`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ shares }),
        });
      } else if (connId && connection) {
        await fetch(`/api/v1/connections/${connId}/shares`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ shares: [] }),
        });
      }

      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Track whether the mousedown started on the backdrop (not inside the modal).
  // This prevents the modal closing when the user selects text inside and releases outside.
  const backdropMouseDownRef = useRef(false);

  const isCopy = !connection && !!prefill && !!prefill.name;
  const title = connection ? 'Edit Connection' : isCopy ? `New Connection — copy of "${prefill!.name.replace(/ - copy$/, '')}"` : 'New Connection';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { backdropMouseDownRef.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (backdropMouseDownRef.current && e.target === e.currentTarget) onClose(); backdropMouseDownRef.current = false; }}
    >
      <div
        className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="flex flex-1 min-h-0">
          {/* Protocol sidebar */}
          <div className="w-44 flex-shrink-0 bg-surface border-r border-border rounded-l-lg py-3 overflow-y-auto">
            <p className="px-3 mb-1 text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Protocol</p>
            {PROTOCOL_CATEGORIES.map((cat) => (
              <div key={cat.id} className="mb-1">
                <div className="flex items-center gap-1.5 px-3 py-1.5">
                  <span className="text-text-secondary">{cat.headerIcon}</span>
                  <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">{cat.label}</span>
                </div>
                {cat.protocols.map(({ id: p, label, icon }) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handleProtocolChange(p)}
                    className={`w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-xs transition-colors ${
                      protocol === p
                        ? 'bg-accent/10 text-accent font-medium border-r-2 border-accent'
                        : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                    }`}
                  >
                    <span className="flex-shrink-0">{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Form content */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div className="px-5 pt-4 pb-2 border-b border-border">
              <h2 className="text-base font-bold text-text-primary">{title}</h2>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="My Server"
              className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-xs font-medium text-text-secondary mb-1">Host</label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                required
                placeholder="192.168.1.100"
                className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
              />
            </div>
            <div className="w-20">
              <label className="block text-xs font-medium text-text-secondary mb-1">Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                required
                className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-xs font-medium text-text-secondary mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="user"
                className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-text-secondary mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={connection ? '(unchanged)' : ''}
                className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>

          {protocol === 'ssh' && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Private Key <span className="font-normal">(optional, overrides password)</span>
              </label>
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                rows={3}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent font-mono text-xs resize-none"
              />
            </div>
          )}

          {protocol === 'rdp' && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">TLS Certificate</label>
              <div
                className={`flex items-center gap-2.5 px-3 py-2 rounded border cursor-pointer transition-colors ${
                  skipCertValidation
                    ? 'border-border bg-surface hover:bg-surface-hover'
                    : 'border-green-500/40 bg-green-500/5'
                }`}
                onClick={() => setSkipCertValidation(!skipCertValidation)}
              >
                <div className={`relative w-8 h-[18px] rounded-full transition-colors ${skipCertValidation ? 'bg-zinc-600' : 'bg-green-500'}`}>
                  <div className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${skipCertValidation ? 'left-[2px]' : 'left-[16px]'}`} />
                </div>
                <div className="flex-1">
                  <span className="text-xs font-medium text-text-primary">
                    {skipCertValidation ? 'Certificate validation disabled' : 'Certificate validation enabled'}
                  </span>
                  <p className="text-[11px] text-text-secondary mt-0.5 leading-tight">
                    {skipCertValidation
                      ? 'Accepts any certificate — suitable for self-signed certs in trusted networks.'
                      : 'Only connects if the server has a valid, trusted TLS certificate.'}
                  </p>
                </div>
                {skipCertValidation && (
                  <span className="text-amber-400 text-sm" title="Certificate validation is off">⚠</span>
                )}
                {!skipCertValidation && (
                  <span className="text-green-400 text-sm" title="Certificate validation is on">🔒</span>
                )}
              </div>
            </div>
          )}

          {protocol === 'ssh' && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Port Forwards <span className="font-normal">(local→remote)</span>
              </label>
              <div className="space-y-1">
                {tunnels.map((t) => (
                  <div key={t.id} className="flex gap-1 items-center">
                    <input
                      type="number"
                      placeholder="Local"
                      value={t.localPort}
                      onChange={(e) => setTunnels((prev) => prev.map((x) => x.id === t.id ? { ...x, localPort: e.target.value } : x))}
                      className="w-16 px-2 py-1 bg-surface border border-border rounded text-text-primary text-xs focus:outline-hidden focus:ring-1 focus:ring-accent"
                    />
                    <span className="text-text-secondary text-xs">→</span>
                    <input
                      type="text"
                      placeholder="Remote host"
                      value={t.remoteHost}
                      onChange={(e) => setTunnels((prev) => prev.map((x) => x.id === t.id ? { ...x, remoteHost: e.target.value } : x))}
                      className="flex-1 px-2 py-1 bg-surface border border-border rounded text-text-primary text-xs focus:outline-hidden focus:ring-1 focus:ring-accent"
                    />
                    <span className="text-text-secondary text-xs">:</span>
                    <input
                      type="number"
                      placeholder="Port"
                      value={t.remotePort}
                      onChange={(e) => setTunnels((prev) => prev.map((x) => x.id === t.id ? { ...x, remotePort: e.target.value } : x))}
                      className="w-14 px-2 py-1 bg-surface border border-border rounded text-text-primary text-xs focus:outline-hidden focus:ring-1 focus:ring-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setTunnels((prev) => prev.filter((x) => x.id !== t.id))}
                      className="p-1 text-text-secondary hover:text-red-400"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setTunnels((prev) => [...prev, { id: crypto.randomUUID(), localPort: '', remoteHost: '', remotePort: '' }])}
                  className="text-xs text-accent hover:text-accent-hover"
                >
                  + Add tunnel
                </button>
              </div>
            </div>
          )}

          {/* Folder selector */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Folder</label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
            >
              <option value="">No Folder</option>
              {localGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>

            {showNewFolder ? (
              <div className="flex gap-1 mt-1">
                <input
                  ref={newFolderInputRef}
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleCreateFolder(); }
                    if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); }
                  }}
                  placeholder="Folder name"
                  className="flex-1 min-w-0 px-2 py-1 text-sm bg-surface border border-border rounded text-text-primary focus:outline-hidden focus:ring-1 focus:ring-accent"
                />
                <button
                  type="button"
                  onClick={handleCreateFolder}
                  className="px-2 py-1 text-sm bg-accent text-white rounded hover:bg-accent-hover"
                >
                  ✓
                </button>
                <button
                  type="button"
                  onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}
                  className="px-2 py-1 text-sm border border-border rounded text-text-secondary hover:bg-surface-hover"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowNewFolder(true)}
                className="mt-1 text-xs text-accent hover:text-accent-hover"
              >
                + Create new folder
              </button>
            )}
          </div>

          {protocol === 'smb' && (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  Share <span className="font-normal text-xs">(e.g. <code className="font-mono">Documents</code>)</span>
                </label>
                <input
                  type="text"
                  value={smbShare}
                  onChange={(e) => setSmbShare(e.target.value)}
                  placeholder="share"
                  required
                  className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent font-mono"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  Domain <span className="font-normal text-xs">(optional)</span>
                </label>
                <input
                  type="text"
                  value={smbDomain}
                  onChange={(e) => setSmbDomain(e.target.value)}
                  placeholder="WORKGROUP"
                  className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent font-mono"
                />
              </div>
            </div>
          )}

          {(protocol === 'postgres' || protocol === 'mysql') && (
            <div className="space-y-2.5">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  Default Database <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={dbDatabase}
                  onChange={(e) => setDbDatabase(e.target.value)}
                  placeholder={protocol === 'postgres' ? 'postgres' : 'mydb'}
                  required
                  className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent font-mono"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-text-secondary mb-1">SSL Mode</label>
                  <select
                    value={dbSslMode}
                    onChange={(e) => setDbSslMode(e.target.value as typeof dbSslMode)}
                    className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
                  >
                    <option value="disable">Disable</option>
                    <option value="require">Require</option>
                    <option value="verify-ca">Verify CA</option>
                    <option value="verify-full">Verify Full</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-text-secondary mb-1">Row Limit <span className="font-normal">(default 1000)</span></label>
                  <input
                    type="number"
                    value={dbRowLimit}
                    onChange={(e) => setDbRowLimit(e.target.value)}
                    placeholder="1000"
                    min={1}
                    className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-text-secondary mb-1">Query Timeout ms <span className="font-normal">(default 30000)</span></label>
                  <input
                    type="number"
                    value={dbQueryTimeout}
                    onChange={(e) => setDbQueryTimeout(e.target.value)}
                    placeholder="30000"
                    min={1000}
                    className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-text-secondary mb-1">Idle Timeout min <span className="font-normal">(default 10)</span></label>
                  <input
                    type="number"
                    value={dbIdleTimeout}
                    onChange={(e) => setDbIdleTimeout(e.target.value)}
                    placeholder="10"
                    min={1}
                    className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tags */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Tags</label>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/15 text-accent text-xs">
                  {tag}
                  <button type="button" onClick={() => setTags(tags.filter((t) => t !== tag))} className="hover:text-red-400 text-[10px] leading-none">×</button>
                </span>
              ))}
            </div>
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  const val = tagInput.trim().toLowerCase();
                  if (val && !tags.includes(val)) setTags([...tags, val]);
                  setTagInput('');
                } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                  setTags(tags.slice(0, -1));
                }
              }}
              placeholder="Type and press Enter to add tags..."
              className="w-full px-2 py-1 text-xs rounded bg-surface border border-border text-text-primary"
            />
          </div>

          {/* Sharing — collapsible */}
          <div className="border border-border rounded overflow-hidden">
            <button
              type="button"
              onClick={() => setSharingOpen(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-hover"
            >
              <span className="flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                Sharing
              </span>
              <span className="flex items-center gap-1.5">
                {(shared || selectedShareRoles.length > 0 || selectedShareUsers.length > 0) && (
                  <span className="px-1.5 py-0.5 bg-accent/15 text-accent rounded text-[10px]">
                    {shared ? 'All users' : `${selectedShareRoles.length + selectedShareUsers.length} target${selectedShareRoles.length + selectedShareUsers.length !== 1 ? 's' : ''}`}
                  </span>
                )}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={`transform transition-transform ${sharingOpen ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </button>
            {sharingOpen && (
              <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
                {/* Share with all users toggle */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShared(v => !v)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      shared ? 'bg-accent' : 'bg-surface-hover border border-border'
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${shared ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                  <span className="text-xs text-text-secondary">Share with all users</span>
                </div>

                {!shared && (
                  <>
                    {/* Share with roles */}
                    <div>
                      <label className="block text-[10px] font-medium text-text-secondary mb-1">Share with roles</label>
                      <div className="space-y-1">
                        {shareRoles.map(r => (
                          <label key={r.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedShareRoles.includes(r.id)}
                              onChange={() => setSelectedShareRoles(prev =>
                                prev.includes(r.id) ? prev.filter(x => x !== r.id) : [...prev, r.id]
                              )}
                              className="accent-accent"
                            />
                            <span className="text-xs text-text-primary">{r.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Share with users */}
                    <div>
                      <label className="block text-[10px] font-medium text-text-secondary mb-1">Share with users</label>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {shareUsers.map(u => (
                          <label key={u.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedShareUsers.includes(u.id)}
                              onChange={() => setSelectedShareUsers(prev =>
                                prev.includes(u.id) ? prev.filter(x => x !== u.id) : [...prev, u.id]
                              )}
                              className="accent-accent"
                            />
                            <span className="text-xs text-text-primary">{u.username}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-red-500 text-xs">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-1.5 text-sm border border-border rounded text-text-secondary hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 font-medium"
            >
              {saving ? 'Saving...' : connection ? 'Update' : 'Create'}
            </button>
          </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
