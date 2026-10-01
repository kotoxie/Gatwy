import { useCallback, useEffect, useState } from 'react';

interface Role {
  id: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

interface PermGroup {
  label: string;
  permissions: { key: string; label: string }[];
}

export function RolesSettings() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [permGroups, setPermGroups] = useState<Record<string, PermGroup>>({});
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Role | null>(null);

  const loadRoles = useCallback(async () => {
    const res = await fetch('/api/v1/roles', { credentials: 'include' });
    if (res.ok) { const d = await res.json(); setRoles(d); }
  }, []);

  const loadPermGroups = useCallback(async () => {
    const res = await fetch('/api/v1/roles/permissions', { credentials: 'include' });
    if (res.ok) { const d = await res.json(); setPermGroups(d); }
  }, []);

  useEffect(() => { loadRoles(); loadPermGroups(); }, [loadRoles, loadPermGroups]);

  function openCreate() {
    setEditing(null);
    setCreating(true);
    setName('');
    setDescription('');
    setSelectedPerms(new Set());
    setError('');
  }

  function openEdit(role: Role) {
    setCreating(false);
    setEditing(role);
    setName(role.name);
    setDescription(role.description);
    setSelectedPerms(new Set(role.permissions));
    setError('');
  }

  function close() {
    setEditing(null);
    setCreating(false);
    setError('');
    setResetConfirm(false);
  }

  function togglePerm(key: string) {
    setSelectedPerms(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleGroup(groupKey: string) {
    const group = permGroups[groupKey];
    if (!group) return;
    const allSelected = group.permissions.every(p => selectedPerms.has(p.key));
    setSelectedPerms(prev => {
      const next = new Set(prev);
      for (const p of group.permissions) {
        if (allSelected) next.delete(p.key); else next.add(p.key);
      }
      return next;
    });
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const body = { name: name.trim(), description: description.trim(), permissions: [...selectedPerms] };
      const url = editing ? `/api/v1/roles/${editing.id}` : '/api/v1/roles';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || 'Save failed'); return; }
      close();
      loadRoles();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(role: Role) {
    setDeleteConfirm(null);
    const res = await fetch(`/api/v1/roles/${role.id}`, { method: 'DELETE', credentials: 'include' });
    if (!res.ok) { const d = await res.json(); setError(d.error || 'Delete failed'); return; }
    loadRoles();
  }

  async function handleReset() {
    if (!editing?.isBuiltin) return;
    setSaving(true);
    setError('');
    setResetConfirm(false);
    try {
      const res = await fetch(`/api/v1/roles/${editing.id}/reset`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || 'Reset failed'); return; }
      const updated = await res.json() as Role;
      setSelectedPerms(new Set(updated.permissions));
      loadRoles();
    } finally {
      setSaving(false);
    }
  }

  const isEditorOpen = editing || creating;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Roles & Permissions</h2>
          <p className="text-xs text-text-secondary mt-0.5">Define roles with granular permissions. Built-in roles cannot be deleted but their permissions can be customized.</p>
        </div>
        <button
          onClick={openCreate}
          className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded text-xs font-medium"
        >
          + New Role
        </button>
      </div>

      {/* Role List */}
      <div className="space-y-2">
        {roles.map(role => (
          <div
            key={role.id}
            className={`border rounded-lg p-4 transition-colors cursor-pointer hover:border-accent/40 ${
              editing?.id === role.id ? 'border-accent bg-accent/5' : 'border-border bg-surface-alt'
            }`}
            onClick={() => openEdit(role)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{role.name}</span>
                {role.isBuiltin && (
                  <span className="px-1.5 py-0.5 bg-accent/15 text-accent text-[10px] rounded font-medium">Built-in</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-secondary">{role.permissions.length} permissions</span>
                {!role.isBuiltin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteConfirm(role); }}
                    className="p-1 rounded text-text-secondary hover:text-red-400 hover:bg-surface"
                    title="Delete role"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14H7L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {role.description && (
              <p className="text-xs text-text-secondary mt-1">{role.description}</p>
            )}
          </div>
        ))}
      </div>

      {/* Editor */}
      {isEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="bg-surface-alt border border-border rounded-lg shadow-xl w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-text-primary">
              {creating ? 'New Role' : `Edit: ${editing!.name}`}
              {editing?.isBuiltin && <span className="text-xs font-normal text-text-secondary ml-2">(permissions only)</span>}
            </h3>
            <button onClick={close} className="p-1 rounded hover:bg-surface-hover text-text-secondary hover:text-text-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {error && <div className="text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</div>}

          {/* Name + Description (not editable for builtin) */}
          {!(editing?.isBuiltin) && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Name</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="e.g. Operator"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Description</label>
                <input
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-surface border border-border rounded text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="Optional description"
                />
              </div>
            </div>
          )}

          {/* Permission checkboxes grouped */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-2">Permissions</label>
            <div className="grid grid-cols-2 gap-4">
              {Object.entries(permGroups).map(([groupKey, group]) => {
                const allChecked = group.permissions.every(p => selectedPerms.has(p.key));
                const someChecked = group.permissions.some(p => selectedPerms.has(p.key));
                return (
                  <div key={groupKey} className="border border-border rounded p-3 bg-surface">
                    <label className="flex items-center gap-2 mb-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }}
                        onChange={() => toggleGroup(groupKey)}
                        className="accent-accent"
                      />
                      <span className="text-xs font-semibold text-text-primary">{group.label}</span>
                    </label>
                    <div className="space-y-1 ml-5">
                      {group.permissions.map(p => (
                        <label key={p.key} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedPerms.has(p.key)}
                            onChange={() => togglePerm(p.key)}
                            className="accent-accent"
                          />
                          <span className="text-xs text-text-secondary">{p.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 justify-end pt-2">
            {editing?.isBuiltin && !resetConfirm && (
              <button
                onClick={() => setResetConfirm(true)}
                disabled={saving}
                className="px-3 py-1.5 text-xs border border-yellow-500/40 text-yellow-400 rounded hover:bg-yellow-500/10 font-medium disabled:opacity-50 mr-auto"
              >
                Reset to Default
              </button>
            )}
            {editing?.isBuiltin && resetConfirm && (
              <div className="flex items-center gap-2 mr-auto bg-yellow-500/10 border border-yellow-500/30 rounded px-3 py-1.5">
                <span className="text-xs text-yellow-400">Reset "{editing.name}" to default permissions?</span>
                <button
                  onClick={handleReset}
                  disabled={saving}
                  className="px-2 py-0.5 text-xs bg-yellow-500 hover:bg-yellow-600 text-black rounded font-medium disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setResetConfirm(false)}
                  className="px-2 py-0.5 text-xs border border-yellow-500/40 text-yellow-400 rounded hover:bg-yellow-500/10"
                >
                  Cancel
                </button>
              </div>
            )}
            <button onClick={close} className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : creating ? 'Create Role' : 'Save Changes'}
            </button>
          </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface border border-border rounded-lg p-5 max-w-sm w-full shadow-xl space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">Delete Role</h3>
            <p className="text-xs text-text-secondary">
              Delete role "<span className="text-text-primary font-medium">{deleteConfirm.name}</span>"? Users assigned to this role will need to be reassigned.
            </p>
            {error && <div className="text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</div>}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setDeleteConfirm(null); setError(''); }}
                className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="px-3 py-1.5 text-xs bg-red-500 hover:bg-red-600 text-white rounded font-medium"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
