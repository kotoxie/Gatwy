import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { TabBarItem } from '../pages/MainLayout';

interface TabBarProps {
  tabs: TabBarItem[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onClose: (id: string) => void;
  onSplitH: (tabId: string) => void;
  onSplitV: (tabId: string) => void;
  canSplit: boolean;
  onCloseAll?: () => void;
  onReorder?: (ids: string[]) => void;
  onMergeInto?: (draggedId: string, targetId: string) => void;
}

const protocolIcons: Record<string, string> = {
  ssh: '> _',
  rdp: '🖥',
  smb: '📁',
  vnc: '🖱',
  moonlight: '☾',
  sftp: '📂',
  ftp: '🗂',
  telnet: '⌨',
  split: '⊞',
};

const statusColors: Record<string, string> = {
  connecting: 'bg-yellow-500',
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
};

interface ContextMenu {
  x: number;
  y: number;
  tab: TabBarItem;
}

// Drag drop zones per tab:
//   left 25%  → insert before
//   center 50% → merge (split into target)
//   right 25% → insert after
type DropZone = 'before' | 'merge' | 'after';

function getDropZone(e: React.DragEvent, el: HTMLElement): DropZone {
  const rect = el.getBoundingClientRect();
  const rel = (e.clientX - rect.left) / rect.width;
  if (rel < 0.25) return 'before';
  if (rel > 0.75) return 'after';
  return 'merge';
}

export function TabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onClose,
  onSplitH,
  onSplitV,
  canSplit,
  onCloseAll,
  onReorder,
  onMergeInto,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Drag state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // insertBefore: id = indicator before that tab, 'END' = indicator at end, null = none
  const [insertBefore, setInsertBefore] = useState<string | null>(null);
  // mergeTargetId: id of tab showing the merge overlay
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setContextMenu(null);
    }
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [contextMenu]);

  if (tabs.length === 0) return null;

  function handleContextMenu(e: React.MouseEvent, tab: TabBarItem) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tab });
  }

  function handleDragStart(e: React.DragEvent, id: string) {
    setDraggingId(id);
    setInsertBefore(null);
    setMergeTargetId(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);

    // Rotated ghost image
    const el = e.currentTarget as HTMLElement;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.style.cssText = `
      position:fixed;top:-9999px;left:-9999px;
      opacity:0.95;transform:rotate(3deg) scale(1.06);
      background:var(--color-surface-alt,#1e1e2e);
      border:1px solid var(--color-accent,#7c3aed);
      border-radius:6px;padding:4px 12px;
      font-size:13px;color:var(--color-text-primary,#cdd6f4);
      box-shadow:0 8px 24px rgba(0,0,0,0.5);
      pointer-events:none;white-space:nowrap;
    `;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, el.offsetWidth / 2, el.offsetHeight / 2);
    requestAnimationFrame(() => {
      if (document.body.contains(ghost)) document.body.removeChild(ghost);
    });
  }

  function clearDropState() {
    setInsertBefore(null);
    setMergeTargetId(null);
  }

  function handleDragOverTab(e: React.DragEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!draggingId || draggingId === id) { clearDropState(); return; }

    const zone = getDropZone(e, e.currentTarget as HTMLElement);

    if (zone === 'merge') {
      setMergeTargetId(id);
      setInsertBefore(null);
    } else {
      setMergeTargetId(null);
      if (zone === 'before') {
        setInsertBefore(id);
      } else {
        // after → insert before the next tab
        const idx = tabs.findIndex((t) => t.id === id);
        const next = tabs[idx + 1];
        setInsertBefore(next ? next.id : 'END');
      }
    }
  }

  function handleDragEnterTab(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  }

  function handleDragOverBar(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggingId) { setInsertBefore('END'); setMergeTargetId(null); }
  }

  function handleDrop(e: React.DragEvent, targetId?: string) {
    e.preventDefault();
    e.stopPropagation();
    const srcId = e.dataTransfer.getData('text/plain') || draggingId;
    if (!srcId) { clearDropState(); setDraggingId(null); return; }

    if (targetId && targetId !== srcId && mergeTargetId === targetId && onMergeInto) {
      // Drop in center → merge/split
      onMergeInto(srcId, targetId);
    } else if (onReorder) {
      // Reorder
      const currentIds = tabs.map((t) => t.id);
      const reordered = currentIds.filter((id) => id !== srcId);
      let toIdx: number;
      if (insertBefore === 'END' || insertBefore === null) {
        toIdx = reordered.length;
      } else {
        toIdx = reordered.indexOf(insertBefore);
        if (toIdx === -1) toIdx = reordered.length;
      }
      reordered.splice(toIdx, 0, srcId);
      if (reordered.join(',') !== currentIds.join(',')) onReorder(reordered);
    }

    setDraggingId(null);
    clearDropState();
  }

  function handleDragEnd() {
    setDraggingId(null);
    clearDropState();
  }

  return (
    <>
      <div className="flex items-center h-9 bg-surface-alt border-b border-border shrink-0">
        <div
          className="flex items-center h-full overflow-x-auto flex-1 min-w-0"
          onDragOver={handleDragOverBar}
          onDragEnter={(e) => e.preventDefault()}
          onDrop={(e) => handleDrop(e)}
        >
          {tabs.map((tab) => {
            const isDraggingThis = tab.id === draggingId;
            const showInsertBefore = insertBefore === tab.id && !isDraggingThis;
            const isMergeTarget = mergeTargetId === tab.id && !isDraggingThis;

            return (
              <div
                key={tab.id}
                className="relative flex items-center h-full shrink-0"
              >
                {/* Left insertion indicator */}
                {showInsertBefore && (
                  <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded-full z-10 shadow-[0_0_8px_2px_rgba(124,58,237,0.7)]" />
                )}

                <div
                  draggable
                  onDragStart={(e) => handleDragStart(e, tab.id)}
                  onDragOver={(e) => handleDragOverTab(e, tab.id)}
                  onDragEnter={handleDragEnterTab}
                  onDrop={(e) => handleDrop(e, tab.id)}
                  onDragEnd={handleDragEnd}
                  className={clsx(
                    'relative flex items-center gap-2 px-3 h-full text-sm border-r border-border select-none transition-all duration-100',
                    isDraggingThis ? 'opacity-30 cursor-grabbing' : 'cursor-grab',
                    tab.id === activeTabId
                      ? 'bg-surface text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover',
                    isMergeTarget && 'ring-1 ring-inset ring-accent',
                  )}
                  onClick={() => !draggingId && onTabSelect(tab.id)}
                  onContextMenu={(e) => handleContextMenu(e, tab)}
                >
                  {/* Merge overlay */}
                  {isMergeTarget && (
                    <div className="absolute inset-0 bg-accent/15 flex items-center justify-center pointer-events-none z-10 rounded-xs">
                      <span className="text-accent text-base leading-none">⊞</span>
                    </div>
                  )}

                  <span className={clsx('w-2 h-2 rounded-full shrink-0', statusColors[tab.status])} />
                  <span className="text-xs opacity-60">{protocolIcons[tab.protocol] ?? tab.protocol}</span>
                  <span className="max-w-[120px] truncate">{tab.label}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                    className="ml-1 p-0.5 rounded hover:bg-surface-hover text-text-secondary hover:text-text-primary"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}

          {/* End-of-list insertion indicator */}
          {insertBefore === 'END' && draggingId && (
            <div className="flex items-center px-1 h-full shrink-0">
              <div className="w-0.5 h-6 bg-accent rounded-full shadow-[0_0_8px_2px_rgba(124,58,237,0.7)]" />
            </div>
          )}
        </div>

        {onCloseAll && tabs.length > 0 && (
          <button
            onClick={onCloseAll}
            className="flex items-center gap-1.5 px-3 h-full text-xs text-text-secondary hover:text-red-400 hover:bg-surface-hover border-l border-border shrink-0 transition-colors"
            title="Close all sessions"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Close All
          </button>
        )}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-surface-alt border border-border rounded shadow-lg py-1 text-sm min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className={clsx(
              'w-full px-4 py-1.5 text-left flex items-center gap-2',
              canSplit
                ? 'text-text-primary hover:bg-surface-hover'
                : 'text-text-secondary/40 cursor-not-allowed',
            )}
            disabled={!canSplit}
            onClick={() => {
              if (!canSplit) return;
              onSplitH(contextMenu.tab.id);
              setContextMenu(null);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="1" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
            Split Right
          </button>
          <button
            className={clsx(
              'w-full px-4 py-1.5 text-left flex items-center gap-2',
              canSplit
                ? 'text-text-primary hover:bg-surface-hover'
                : 'text-text-secondary/40 cursor-not-allowed',
            )}
            disabled={!canSplit}
            onClick={() => {
              if (!canSplit) return;
              onSplitV(contextMenu.tab.id);
              setContextMenu(null);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="1" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            Split Down
          </button>
          <div className="my-1 h-px bg-border mx-1" />
          <button
            className="w-full px-4 py-1.5 text-left hover:bg-surface-hover text-red-400 flex items-center gap-2"
            onClick={() => { onClose(contextMenu.tab.id); setContextMenu(null); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Close Tab
          </button>
        </div>
      )}
    </>
  );
}

