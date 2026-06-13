import { useState, useEffect, useRef, useCallback } from 'react';
interface FileEntry {
  filename: string;
  fileAttributes: number;
  size?: number;
}

const ATTR_DIRECTORY = 0x10;

function isDir(f: FileEntry): boolean {
  return (f.fileAttributes & ATTR_DIRECTORY) !== 0;
}

function getFileExt(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

function getFileCategory(name: string): 'image' | 'video' | 'audio' | 'archive' | 'code' | 'other' {
  const ext = getFileExt(name);
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'ogg', 'aac'].includes(ext)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'archive';
  if (['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'html', 'css', 'log', 'conf', 'ini', 'toml'].includes(ext)) return 'code';
  return 'other';
}

function getTypeBadge(f: FileEntry): string {
  if (isDir(f)) return 'FOLDER';
  const ext = getFileExt(f.filename);
  return ext ? ext.toUpperCase() : 'FILE';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatPermissions(mode: number): string {
  const octal = '0' + (mode & 0o7777).toString(8);
  const rwx = (m: number): string => (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? 'x' : '-');
  return `${octal} ${rwx((mode >> 6) & 7)}${rwx((mode >> 3) & 7)}${rwx(mode & 7)}`;
}

function FolderIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className="text-amber-400 shrink-0">
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
    </svg>
  );
}

function FileIcon({ category, size = 20 }: { category: 'image' | 'video' | 'audio' | 'archive' | 'code' | 'other'; size?: number }) {
  const colorMap = {
    image: 'text-purple-400',
    video: 'text-pink-400',
    audio: 'text-green-400',
    archive: 'text-orange-400',
    code: 'text-blue-400',
    other: 'text-text-secondary',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className={`${colorMap[category]} shrink-0`}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

interface FileBrowserProps {
  connectionId: string;
  connectionName: string;
  isActive: boolean;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void;
  /** API path prefix, e.g. '/api/v1/sftp' */
  apiBase: string;
  /** Path separator: '/' for SFTP/FTP, '\\' for SMB */
  pathSep?: string;
  /** Unique session ID passed as X-File-Session-Id header for activity tracking */
  fileSessionId?: string;
}

export function FileBrowser({
  connectionId,
  connectionName,
  isActive,
  onStatusChange,
  apiBase,
  pathSep = '/',
  fileSessionId,
}: FileBrowserProps) {
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{ name: string; loaded: number; total: number } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ name: string; loaded: number; total: number | null } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'single'; name: string } | { type: 'multi'; count: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [clipboard, setClipboard] = useState<{ paths: string[]; operation: 'copy' | 'cut' } | null>(null);
  const [infoFile, setInfoFile] = useState<{ filename: string; stats: any } | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [chmodMode, setChmodMode] = useState('');
  const [sortCol, setSortCol] = useState<'name' | 'size' | 'type'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    if (!contextMenu) return;
    function handleMouseDown(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setContextMenu(null);
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!clipboard) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !contextMenu && !deleteConfirm && !renamingFile && !infoFile) {
        setClipboard(null);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [clipboard, contextMenu, deleteConfirm, renamingFile, infoFile]);

  // For SFTP/FTP (pathSep='/'), always produce absolute paths (no double slashes).
  // For SMB (pathSep='\\'), keep existing relative-join behaviour.
  const joinPath = (base: string, name: string) => {
    if (pathSep === '/') {
      const b = base.endsWith('/') ? base.slice(0, -1) : base;
      return b ? `${b}/${name}` : `/${name}`;
    }
    return base ? `${base}${pathSep}${name}` : name;
  };

  const listDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError('');
    setContextMenu(null);
    setSelectedFiles(new Set());
    setRenamingFile(null);
    const isInitialConnect = dirPath === '' || dirPath === '/';    try {
      const res = await fetch(`${apiBase}/${connectionId}/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(fileSessionId ? { 'X-File-Session-Id': fileSessionId } : {}) },
        credentials: 'include',
        body: JSON.stringify({ path: dirPath }),
      });
      let d: { files?: FileEntry[]; error?: string };
      try { d = await res.json(); } catch { throw new Error(`Server error (${res.status})`); }
      if (!res.ok) throw new Error(d.error || `Server error (${res.status})`);
      setFiles((d.files as FileEntry[]).filter((f) => f.filename !== '.' && f.filename !== '..'));
      setStatus('connected');
      setPath(dirPath);
      onStatusChange?.('connected');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error';
      setError(msg);
      // Only treat the initial connection failure as a full disconnect.
      // Errors navigating subfolders (permission denied, etc.) show an inline
      // error message but keep the session alive so the user can go back.
      if (isInitialConnect) {
        setStatus('error');
        onStatusChange?.('disconnected');
      } else {
        setStatus('connected');
      }
    } finally {
      setLoading(false);
    }
  }, [connectionId, apiBase, pathSep, onStatusChange, fileSessionId]);

  const pathRef = useRef(path);
  useEffect(() => { pathRef.current = path; }, [path]);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    if (!isActive) return;
    // If already connected and in a directory, reload the current path (don't reset to root on tab switch)
    // Only go to root on initial connect (path is empty) or after a disconnect
    const target = (statusRef.current === 'connected' && pathRef.current) ? pathRef.current : (pathSep === '/' ? '/' : '');
    listDir(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, isActive]);

  function navigateTo(name: string) {
    listDir(joinPath(path, name));
  }

  function navigateUp() {
    if (pathSep === '/') {
      const parts = path.split('/').filter(Boolean);
      parts.pop();
      listDir(parts.length ? `/${parts.join('/')}` : '/');
    } else {
      const parts = path.split(pathSep).filter(Boolean);
      parts.pop();
      listDir(parts.join(pathSep));
    }
  }

  async function downloadFile(name: string) {
    const filePath = joinPath(path, name);
    const knownSize = files.find((f) => f.filename === name)?.size ?? null;
    setDownloadProgress({ name, loaded: 0, total: knownSize });
    try {
      const sizeParam = knownSize !== null ? `&size=${knownSize}` : '';
      const res = await fetch(`${apiBase}/${connectionId}/download?path=${encodeURIComponent(filePath)}${sizeParam}`, {
        credentials: 'include',
        ...(fileSessionId ? { headers: { 'X-File-Session-Id': fileSessionId } } : {}),
      });
      if (!res.ok) {
        let msg = 'Download failed';
        try { const d = await res.json() as { error?: string }; msg = d.error || msg; } catch { /* ignore */ }
        setError(msg); return;
      }
      const contentLength = res.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : knownSize;
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        setDownloadProgress({ name, loaded, total });
      }
      const blob = new Blob(chunks as BlobPart[]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Download failed'); }
    finally { setDownloadProgress(null); }
  }

  async function deleteFile(name: string) {
    setDeleteConfirm(null);
    const filePath = joinPath(path, name);
    try {
      const res = await fetch(`${apiBase}/${connectionId}/file?path=${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
        credentials: 'include',
        ...(fileSessionId ? { headers: { 'X-File-Session-Id': fileSessionId } } : {}),
      });
      if (res.ok) { listDir(path); }
      else {
        let msg = 'Delete failed';
        try { const d = await res.json() as { error?: string }; msg = d.error || msg; } catch { /* non-JSON */ }
        // Refresh list first (to show partial progress), then show error after refresh completes
        await listDir(path);
        setError(`Delete "${name}": ${msg}`);
      }
    } catch (e) {
      setError(`Delete "${name}": ${e instanceof Error ? e.message : 'failed'}`);
    }
  }

  async function createFolder() {
    if (!newFolderName.trim()) return;
    const dirPath = joinPath(path, newFolderName.trim());
    const res = await fetch(`${apiBase}/${connectionId}/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(fileSessionId ? { 'X-File-Session-Id': fileSessionId } : {}) },
      credentials: 'include',
      body: JSON.stringify({ path: dirPath }),
    });
    if (res.ok) { setNewFolderMode(false); setNewFolderName(''); listDir(path); }
    else { const d = await res.json(); setError(d.error || 'Failed'); }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const filePath = joinPath(path, file.name);
    setUploadProgress({ name: file.name, loaded: 0, total: file.size });
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${apiBase}/${connectionId}/upload?path=${encodeURIComponent(filePath)}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (fileSessionId) xhr.setRequestHeader('X-File-Session-Id', fileSessionId);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setUploadProgress({ name: file.name, loaded: ev.loaded, total: ev.total });
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); }
          else {
            try { const d = JSON.parse(xhr.responseText) as { error?: string }; reject(new Error(d.error || 'Upload failed')); }
            catch { reject(new Error('Upload failed')); }
          }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.send(file);
      });
      listDir(path);
    } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed'); }
    setUploadProgress(null);
    e.target.value = '';
  }

  async function downloadSelected() {
    for (const name of selectedFiles) {
      const f = files.find((fi) => fi.filename === name);
      if (f && !isDir(f)) await downloadFile(name);
    }
  }

  async function deleteSelected() {
    setDeleteConfirm(null);
    const errors: string[] = [];
    for (const name of [...selectedFiles]) {
      const filePath = joinPath(path, name);
      try {
        const res = await fetch(`${apiBase}/${connectionId}/file?path=${encodeURIComponent(filePath)}`, {
          method: 'DELETE',
          credentials: 'include',
          ...(fileSessionId ? { headers: { 'X-File-Session-Id': fileSessionId } } : {}),
        });
        if (!res.ok) {
          let msg = name;
          try { const d = await res.json() as { error?: string }; msg = d.error || msg; } catch { /* non-JSON */ }
          errors.push(msg);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : name);
      }
    }
    setSelectedFiles(new Set());
    await listDir(path);
    if (errors.length) setError(`Delete failed: ${errors.join(', ')}`);
  }

  function toggleSelect(name: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function renameFileAction(oldName: string, newName: string) {
    if (!newName.trim() || newName === oldName) {
      setRenamingFile(null);
      setRenameValue('');
      return;
    }
    const oldPath = joinPath(path, oldName);
    const newPath = joinPath(path, newName.trim());
    try {
      const res = await fetch(`${apiBase}/${connectionId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(fileSessionId ? { 'X-File-Session-Id': fileSessionId } : {}) },
        credentials: 'include',
        body: JSON.stringify({ oldPath, newPath }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error || 'Rename failed');
      } else {
        listDir(path);
      }
    } catch {
      setError('Rename failed');
    }
    setRenamingFile(null);
    setRenameValue('');
  }

  function copyToClipboard(filenames: string[]) {
    setClipboard({ paths: filenames.map(name => joinPath(path, name)), operation: 'copy' });
  }

  function cutToClipboard(filenames: string[]) {
    setClipboard({ paths: filenames.map(name => joinPath(path, name)), operation: 'cut' });
  }

  async function pasteFromClipboard() {
    if (!clipboard) return;
    for (const srcPath of clipboard.paths) {
      const filename = srcPath.split(pathSep).filter(Boolean).pop() || srcPath.split('/').filter(Boolean).pop() || '';
      const destPath = joinPath(path, filename);
      if (clipboard.operation === 'copy') {
        try {
          const res = await fetch(`${apiBase}/${connectionId}/copy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(fileSessionId ? { 'X-File-Session-Id': fileSessionId } : {}) },
            credentials: 'include',
            body: JSON.stringify({ srcPath, destPath }),
          });
          if (!res.ok) {
            const d = await res.json();
            setError(d.error || 'Copy failed');
            return;
          }
        } catch {
          setError('Copy failed');
          return;
        }
      } else {
        try {
          const res = await fetch(`${apiBase}/${connectionId}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(fileSessionId ? { 'X-File-Session-Id': fileSessionId } : {}) },
            credentials: 'include',
            body: JSON.stringify({ oldPath: srcPath, newPath: destPath }),
          });
          if (!res.ok) {
            const d = await res.json();
            setError(d.error || 'Move failed');
            return;
          }
        } catch {
          setError('Move failed');
          return;
        }
      }
    }
    setClipboard(null);
    listDir(path);
  }

  async function fetchFileInfo(filename: string) {
    setInfoLoading(true);
    setInfoFile({ filename, stats: null });
    const filePath = joinPath(path, filename);
    try {
      const res = await fetch(`${apiBase}/${connectionId}/stat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(fileSessionId ? { 'X-File-Session-Id': fileSessionId } : {}) },
        credentials: 'include',
        body: JSON.stringify({ path: filePath }),
      });
      if (res.ok) {
        const stats = await res.json();
        setInfoFile({ filename, stats });
        setChmodMode(stats.mode != null ? '0' + (stats.mode & 0o7777).toString(8) : '');
      } else {
        let msg = 'Failed to get file info';
        try { const d = await res.json(); msg = d.error || msg; } catch { /* non-JSON response */ }
        setError(msg);
        setInfoFile(null);
      }
    } catch {
      setError('Failed to get file info');
      setInfoFile(null);
    }
    setInfoLoading(false);
  }

  async function applyChmod() {
    if (!infoFile) return;
    const mode = parseInt(chmodMode, 8);
    if (isNaN(mode)) { setError('Invalid permission mode'); return; }
    const filePath = joinPath(path, infoFile.filename);
    try {
      const res = await fetch(`${apiBase}/${connectionId}/chmod`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(fileSessionId ? { 'X-File-Session-Id': fileSessionId } : {}) },
        credentials: 'include',
        body: JSON.stringify({ path: filePath, mode }),
      });
      if (res.ok) {
        fetchFileInfo(infoFile.filename);
      } else {
        const d = await res.json();
        setError(d.error || 'chmod failed');
      }
    } catch {
      setError('chmod failed');
    }
  }

  function handleRowClick(f: FileEntry) {
    if (renamingFile) return;
    if (isDir(f)) navigateTo(f.filename);
  }

  function handleContextMenu(e: React.MouseEvent, f: FileEntry) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file: f });
  }

  function toggleSort(col: 'name' | 'size' | 'type') {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  const sortedFiles = [...files].sort((a, b) => {
    const aDir = isDir(a), bDir = isDir(b);
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    let cmp = 0;
    if (sortCol === 'name') {
      cmp = a.filename.localeCompare(b.filename);
    } else if (sortCol === 'size') {
      cmp = (a.size ?? 0) - (b.size ?? 0);
    } else {
      cmp = getTypeBadge(a).localeCompare(getTypeBadge(b));
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const pathParts = path ? path.split(pathSep).filter(Boolean) : [];
  const anySelected = selectedFiles.size > 0;
  const allSelected = sortedFiles.length > 0 && selectedFiles.size === sortedFiles.length;
  const someSelected = anySelected && !allSelected;
  const selectedFileCount = [...selectedFiles].filter((name) => {
    const f = files.find((fi) => fi.filename === name);
    return f && !isDir(f);
  }).length;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(sortedFiles.map((f) => f.filename)));
    }
  }

  return (
    <div className="absolute inset-0 bg-surface flex flex-col font-sans text-sm select-none">

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-alt shrink-0 border-b border-border/40">
        <div className="flex items-center gap-1 text-xs flex-1 min-w-0 overflow-x-auto">
          <span className="font-semibold text-text-primary shrink-0 mr-1">{connectionName}</span>
          <span className="text-text-secondary shrink-0">/</span>
          <button
            onClick={() => listDir(pathSep === '/' ? '/' : '')}
            className="text-text-secondary hover:text-text-primary transition-colors shrink-0 px-1"
          >
            Root
          </button>
          {pathParts.map((part, i) => (
            <span key={i} className="flex items-center gap-1 shrink-0">
              <span className="text-border">/</span>
              <button
                onClick={() => {
                  const joined = pathParts.slice(0, i + 1).join(pathSep);
                  listDir(pathSep === '/' ? `/${joined}` : joined);
                }}
                className={i === pathParts.length - 1
                  ? 'text-text-primary font-medium px-1'
                  : 'text-text-secondary hover:text-text-primary transition-colors px-1'}
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {path && (
            <button onClick={navigateUp} title="Go up"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <polyline points="18 15 12 9 6 15" />
              </svg>
              Up
            </button>
          )}
          <button onClick={() => listDir(path)} title="Refresh"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Refresh
          </button>
          <div className="w-px h-4 bg-border/40 mx-1" />
          <button onClick={() => setNewFolderMode(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            New Folder
          </button>
          <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-accent text-white hover:bg-accent-hover transition-colors cursor-pointer">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <polyline points="16 16 12 12 8 16" />
              <line x1="12" y1="12" x2="12" y2="21" />
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
            </svg>
            Upload
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </div>

      {newFolderMode && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-surface-alt shrink-0">
          <FolderIcon size={16} />
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createFolder();
              if (e.key === 'Escape') { setNewFolderMode(false); setNewFolderName(''); }
            }}
            placeholder="Folder name..."
            className="flex-1 px-2 py-1 text-sm bg-surface border border-border rounded-md text-text-primary placeholder-text-secondary/50 focus:outline-hidden focus:ring-1 focus:ring-accent"
          />
          <button onClick={createFolder} className="px-3 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent-hover transition-colors">Create</button>
          <button onClick={() => { setNewFolderMode(false); setNewFolderName(''); }}
            className="px-3 py-1 text-xs border border-border rounded-md text-text-secondary hover:bg-surface-hover transition-colors">Cancel</button>
        </div>
      )}

      {(error || uploadProgress || downloadProgress || status === 'connecting') && (
        <div className={`px-3 py-1.5 text-xs shrink-0 flex items-center gap-2 ${
          error ? 'bg-red-500/10 text-red-400 border-b border-red-500/20' : 'bg-accent/10 text-accent border-b border-accent/20'
        }`}>
          {error ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {error}
              <button onClick={() => setError('')} className="ml-auto hover:opacity-70">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          ) : downloadProgress ? (
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <svg className="animate-spin shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span className="truncate min-w-0">
                Downloading <span className="font-medium">{downloadProgress.name}</span>
                {' — '}
                {downloadProgress.total !== null
                  ? `${formatSize(downloadProgress.loaded)} / ${formatSize(downloadProgress.total)}`
                  : formatSize(downloadProgress.loaded)}
              </span>
              {downloadProgress.total !== null && (
                <div className="ml-auto shrink-0 flex items-center gap-2">
                  <span className="tabular-nums">
                    {Math.round((downloadProgress.loaded / downloadProgress.total) * 100)}%
                  </span>
                  <div className="w-24 h-1.5 bg-accent/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all"
                      style={{ width: `${Math.min(100, (downloadProgress.loaded / downloadProgress.total) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : uploadProgress ? (
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <svg className="animate-spin shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span className="truncate min-w-0">
                Uploading <span className="font-medium">{uploadProgress.name}</span>
                {' — '}
                {formatSize(uploadProgress.loaded)} / {formatSize(uploadProgress.total)}
              </span>
              <div className="ml-auto shrink-0 flex items-center gap-2">
                <span className="tabular-nums">
                  {Math.round((uploadProgress.loaded / uploadProgress.total) * 100)}%
                </span>
                <div className="w-24 h-1.5 bg-accent/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all"
                    style={{ width: `${Math.min(100, (uploadProgress.loaded / uploadProgress.total) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          ) : ('Connecting...')}
        </div>
      )}

      {anySelected && (
        <div className="flex items-center gap-3 px-3 py-2 bg-accent/8 border-b border-accent/20 shrink-0">
          <span className="inline-flex items-center gap-1.5 bg-accent/15 text-accent text-xs font-medium px-2 py-0.5 rounded-full">
            {selectedFiles.size} selected
          </span>
          <button onClick={toggleSelectAll} className="text-xs text-accent hover:text-accent-hover transition-colors">
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          <button onClick={() => setSelectedFiles(new Set())} className="text-xs text-text-secondary hover:text-text-primary transition-colors">Clear</button>
          <div className="flex-1" />
          {selectedFileCount > 0 && (
            <button onClick={downloadSelected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download {selectedFileCount} file{selectedFileCount !== 1 ? 's' : ''}
            </button>
          )}
          <button onClick={() => copyToClipboard([...selectedFiles])}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </button>
          <button onClick={() => cutToClipboard([...selectedFiles])}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              <line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" />
            </svg>
            Cut
          </button>
          <button onClick={() => setDeleteConfirm({ type: 'multi', count: selectedFiles.size })}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
            Delete {selectedFiles.size}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center h-24 text-text-secondary text-sm gap-2">
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Loading...
          </div>
        )}
        {!loading && files.length === 0 && status === 'connected' && (
          <div className="flex flex-col items-center justify-center h-24 gap-2 text-text-secondary text-sm">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Empty folder
          </div>
        )}
        {!loading && sortedFiles.length > 0 && (
          <div className="px-2 py-1.5">
            {/* Column header row with select-all and sort controls */}
            <div className="flex items-center gap-2 px-2 py-1 mb-0.5 border-b border-border/30">
              <div
                className={`flex items-center justify-center w-4 h-4 rounded border-2 transition-all shrink-0 cursor-pointer ${
                  allSelected
                    ? 'bg-accent border-accent text-white shadow-xs'
                    : someSelected
                      ? 'bg-accent/40 border-accent text-white'
                      : 'border-border/60 text-transparent hover:border-accent/70'
                }`}
                onClick={toggleSelectAll}
                title={allSelected ? 'Deselect all' : 'Select all'}
              >
                {(allSelected || someSelected) && <CheckIcon />}
              </div>
              {/* icon spacer */}
              <div className="w-5 shrink-0" />
              <button
                onClick={() => toggleSort('name')}
                className="flex-1 flex items-center gap-1 text-left text-[11px] font-semibold text-text-secondary hover:text-text-primary transition-colors select-none"
              >
                Name
                {sortCol === 'name' ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent">
                    {sortDir === 'asc'
                      ? <polyline points="18 15 12 9 6 15" />
                      : <polyline points="6 9 12 15 18 9" />}
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-30">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => toggleSort('size')}
                className="shrink-0 w-16 flex items-center justify-end gap-1 text-[11px] font-semibold text-text-secondary hover:text-text-primary transition-colors select-none"
              >
                {sortCol === 'size' ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent">
                    {sortDir === 'asc'
                      ? <polyline points="18 15 12 9 6 15" />
                      : <polyline points="6 9 12 15 18 9" />}
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-30">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                )}
                Size
              </button>
              <button
                onClick={() => toggleSort('type')}
                className="shrink-0 w-12 text-left text-[11px] font-semibold text-text-secondary hover:text-text-primary transition-colors select-none flex items-center gap-1"
              >
                Type
                {sortCol === 'type' ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent">
                    {sortDir === 'asc'
                      ? <polyline points="18 15 12 9 6 15" />
                      : <polyline points="6 9 12 15 18 9" />}
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-30">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                )}
              </button>
            </div>
            {sortedFiles.map((f) => {
              const isSelected = selectedFiles.has(f.filename);
              const category = isDir(f) ? 'other' : getFileCategory(f.filename);
              const badge = getTypeBadge(f);
              return (
                <div
                  key={f.filename}
                  className={`group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-accent/20 ring-1 ring-accent/40 hover:bg-accent/25'
                      : 'hover:bg-surface-hover'
                  }`}
                  onClick={() => handleRowClick(f)}
                  onDoubleClick={() => { if (!isDir(f)) downloadFile(f.filename); }}
                  onContextMenu={(e) => handleContextMenu(e, f)}
                >
                  <div
                    className={`flex items-center justify-center w-4 h-4 rounded border-2 transition-all shrink-0 ${
                      isSelected
                        ? 'bg-accent border-accent text-white shadow-xs'
                        : 'border-border/60 text-transparent hover:border-accent/70'
                    }`}
                    onClick={(e) => { e.stopPropagation(); toggleSelect(f.filename); }}
                  >
                    {isSelected && <CheckIcon />}
                  </div>
                  <div className="shrink-0">
                    {isDir(f) ? <FolderIcon size={20} /> : <FileIcon category={category} size={20} />}
                  </div>
                  {renamingFile === f.filename ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') renameFileAction(f.filename, renameValue);
                        if (e.key === 'Escape') { setRenamingFile(null); setRenameValue(''); }
                      }}
                      onBlur={() => renameFileAction(f.filename, renameValue)}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 px-1 py-0 text-sm bg-surface border border-accent rounded text-text-primary focus:outline-hidden focus:ring-1 focus:ring-accent"
                    />
                  ) : (
                    <span className="flex-1 text-text-primary truncate text-sm leading-none">{f.filename}</span>
                  )}
                  <span className="shrink-0 text-[11px] tabular-nums text-text-secondary/50 w-16 text-right">
                    {!isDir(f) && f.size != null ? formatSize(f.size) : ''}
                  </span>
                  <span className="shrink-0 text-[10px] font-medium text-text-secondary/60 tracking-wide uppercase px-1.5 py-0.5 rounded bg-surface-hover/0 group-hover:bg-surface">
                    {badge}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] py-1 bg-surface-alt border border-border/60 rounded-lg shadow-xl text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {isDir(contextMenu.file) ? (
            <button
              onClick={() => { navigateTo(contextMenu.file.filename); setContextMenu(null); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Open
            </button>
          ) : (
            <button
              onClick={() => { downloadFile(contextMenu.file.filename); setContextMenu(null); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
          )}
          <div className="my-1 border-t border-border/40" />
          <button
            onClick={() => { setRenamingFile(contextMenu.file.filename); setRenameValue(contextMenu.file.filename); setContextMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
            Rename
          </button>
          <button
            onClick={() => { copyToClipboard([contextMenu.file.filename]); setContextMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </button>
          <button
            onClick={() => { cutToClipboard([contextMenu.file.filename]); setContextMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              <line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" />
            </svg>
            Cut
          </button>
          {clipboard && (
            <button
              onClick={() => { pasteFromClipboard(); setContextMenu(null); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              </svg>
              Paste
            </button>
          )}
          <div className="my-1 border-t border-border/40" />
          <button
            onClick={() => { fetchFileInfo(contextMenu.file.filename); setContextMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            Info
          </button>
          <div className="my-1 border-t border-border/40" />
          <button
            onClick={() => { setDeleteConfirm({ type: 'single', name: contextMenu.file.filename }); setContextMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
            Delete
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface border border-border rounded-lg p-5 max-w-sm w-full shadow-xl space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">Confirm Delete</h3>
            <p className="text-xs text-text-secondary">
              {deleteConfirm.type === 'single'
                ? <>Delete "<span className="text-text-primary font-medium">{deleteConfirm.name}</span>"?</>
                : <>Delete <span className="text-text-primary font-medium">{deleteConfirm.count}</span> item(s)?</>}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteConfirm.type === 'single' ? deleteFile(deleteConfirm.name) : deleteSelected()}
                className="px-3 py-1.5 text-xs bg-red-500 hover:bg-red-600 text-white rounded font-medium"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Info dialog */}
      {infoFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setInfoFile(null)}>
          <div className="bg-surface border border-border rounded-lg p-5 max-w-md w-full shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary truncate">Info: {infoFile.filename}</h3>
              <button onClick={() => setInfoFile(null)} className="text-text-secondary hover:text-text-primary transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {infoLoading ? (
              <div className="flex items-center justify-center py-6 text-text-secondary text-sm gap-2">
                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Loading...
              </div>
            ) : infoFile.stats ? (
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b border-border/40">
                  <span className="text-text-secondary">Name</span>
                  <span className="text-text-primary font-medium truncate ml-4">{infoFile.filename}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-border/40">
                  <span className="text-text-secondary">Size</span>
                  <span className="text-text-primary">{formatSize(infoFile.stats.size ?? 0)}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-border/40">
                  <span className="text-text-secondary">Modified</span>
                  <span className="text-text-primary">
                    {infoFile.stats.mtime
                      ? new Date(typeof infoFile.stats.mtime === 'number' && infoFile.stats.mtime < 1e12 ? infoFile.stats.mtime * 1000 : infoFile.stats.mtime).toLocaleString()
                      : 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-border/40">
                  <span className="text-text-secondary">Directory</span>
                  <span className="text-text-primary">{infoFile.stats.isDirectory ? 'Yes' : 'No'}</span>
                </div>
                {apiBase.includes('sftp') && infoFile.stats.mode != null && (
                  <>
                    <div className="flex justify-between py-1 border-b border-border/40">
                      <span className="text-text-secondary">Permissions</span>
                      <span className="text-text-primary font-mono">{formatPermissions(infoFile.stats.mode)}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-border/40">
                      <span className="text-text-secondary">Owner</span>
                      <span className="text-text-primary">UID {infoFile.stats.uid ?? '?'} / GID {infoFile.stats.gid ?? '?'}</span>
                    </div>
                    <div className="flex items-center gap-2 pt-2">
                      <span className="text-text-secondary text-xs">chmod</span>
                      <input
                        value={chmodMode}
                        onChange={(e) => setChmodMode(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') applyChmod(); }}
                        placeholder="0755"
                        className="w-20 px-2 py-1 text-xs font-mono bg-surface-alt border border-border rounded text-text-primary focus:outline-hidden focus:ring-1 focus:ring-accent"
                      />
                      <button
                        onClick={applyChmod}
                        className="px-2.5 py-1 text-xs bg-accent text-white rounded hover:bg-accent-hover transition-colors"
                      >
                        Apply
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Clipboard bar */}
      {clipboard && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-alt border-t border-border/40 text-xs text-text-secondary shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          </svg>
          <span>
            {clipboard.paths.length} item{clipboard.paths.length !== 1 ? 's' : ''} {clipboard.operation === 'copy' ? 'copied' : 'cut'} — Paste here or press Escape to cancel
          </span>
          <div className="flex-1" />
          <button
            onClick={() => pasteFromClipboard()}
            className="px-2.5 py-1 text-xs bg-accent text-white rounded hover:bg-accent-hover transition-colors"
          >
            Paste
          </button>
          <button
            onClick={() => setClipboard(null)}
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
