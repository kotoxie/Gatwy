import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';

export interface RdpFileTransferHandle {
  handleNativeDrop: (e: DragEvent) => Promise<void>;
}

interface FileInfo {
  name: string;
  size: number;
  lastModified?: number;
}

interface DroppedFileEntry {
  file: File | null;
  name: string;
  size: number;
}

interface TransferProgress {
  transferId: number;
  fileIndex: number;
  fileName: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}

interface TransferItem {
  transferId: number;
  fileName: string;
  totalBytes: number;
  bytesTransferred: number;
  percentage: number;
  direction: 'download' | 'upload';
  status: 'active' | 'pending' | 'complete' | 'error';
  errorMessage?: string;
}

function normalizePercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

interface RdpFileTransferProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any;
  visible: boolean;
  connectionId: string;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function logFileTransfer(connectionId: string, fileName: string, fileSize: number, direction: 'upload' | 'download') {
  fetch('/api/v1/sessions/rdp-file-transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, fileName, fileSize, direction }),
  }).catch(() => {});
}

const INFO_TEXT = `
**Uploading files to the remote desktop:**
1. Drop files anywhere on the RDP session, or click "Browse Files" to select them.
2. Files are queued — press Ctrl+V inside the remote desktop to start each batch.
3. Multiple queued batches are automatically merged into one Ctrl+V paste.

**Downloading files from the remote desktop:**
1. Copy files inside the remote desktop (Ctrl+C).
2. The files appear in the "Remote files available" list below.
3. Click "Download All" — your browser may ask permission to download multiple files.
`.trim();

export const RdpFileTransfer = forwardRef<RdpFileTransferHandle, RdpFileTransferProps>(
function RdpFileTransfer({ provider, visible, connectionId, onClose }: RdpFileTransferProps, ref) {
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [availableFiles, setAvailableFiles] = useState<FileInfo[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadHint, setUploadHint] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const queueUploadRef = useRef<((items: File[] | DroppedFileEntry[]) => void) | null>(null);
  // Each entry is a flat batch waiting for the current one to finish
  const uploadQueue = useRef<Array<Array<File | DroppedFileEntry>>>([]);
  const uploadBusy = useRef(false);
  // Counter for stable temporary IDs for pending items
  const tempIdCounter = useRef(-1);

  useImperativeHandle(ref, () => ({
    handleNativeDrop: async (e: DragEvent) => {
      if (!provider) return;
      try {
        const files = await provider.handleDrop(e);
        if (files.length > 0 && queueUploadRef.current) queueUploadRef.current(files as DroppedFileEntry[]);
      } catch {
        setUploadHint('Drop upload failed. Try using Browse Files.');
      }
    },
  }), [provider]);

  useEffect(() => {
    uploadQueue.current = [];
    uploadBusy.current = false;
    if (!provider) return;

    const onFilesAvailable = (files: FileInfo[]) => {
      setAvailableFiles(files);
    };

    const onDownloadProgress = (progress: TransferProgress) => {
      setTransfers(prev => {
        const existing = prev.find(t => t.transferId === progress.transferId);
        if (existing) {
          return prev.map(t => t.transferId === progress.transferId
            ? { ...t, bytesTransferred: progress.bytesTransferred, percentage: normalizePercentage(progress.percentage) }
            : t);
        }
        return [...prev, {
          transferId: progress.transferId,
          fileName: progress.fileName,
          totalBytes: progress.totalBytes,
          bytesTransferred: progress.bytesTransferred,
          percentage: normalizePercentage(progress.percentage),
          direction: 'download',
          status: 'active',
        }];
      });
    };

    const onUploadProgress = (progress: TransferProgress) => {
      setTransfers(prev => prev.map(t =>
        t.transferId === progress.transferId
          ? { ...t, status: 'active' as const, bytesTransferred: progress.bytesTransferred, percentage: normalizePercentage(progress.percentage) }
          : t,
      ));
    };

    const onDownloadComplete = (file: FileInfo, blob: Blob) => {
      setTransfers(prev => prev.map(t =>
        t.fileName === file.name && t.direction === 'download'
          ? { ...t, status: 'complete' as const, percentage: 100 }
          : t,
      ));
      logFileTransfer(connectionId, file.name, file.size, 'download');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    };

    const onError = (error: { message: string; fileName?: string }) => {
      if (error.fileName) {
        setTransfers(prev => prev.map(t =>
          t.fileName === error.fileName
            ? { ...t, status: 'error' as const, errorMessage: error.message }
            : t,
        ));
      }
    };

    const onUploadComplete = (file: File) => {
      setTransfers(prev => prev.map(t =>
        t.fileName === file.name && t.direction === 'upload'
          ? { ...t, status: 'complete' as const, percentage: 100 }
          : t,
      ));
      logFileTransfer(connectionId, file.name, file.size, 'upload');
    };

    provider.on('files-available', onFilesAvailable);
    provider.on('download-progress', onDownloadProgress);
    provider.on('upload-progress', onUploadProgress);
    provider.on('download-complete', onDownloadComplete);
    provider.on('upload-complete', onUploadComplete);
    provider.on('error', onError);

    return () => {
      provider.off('files-available', onFilesAvailable);
      provider.off('download-progress', onDownloadProgress);
      provider.off('upload-progress', onUploadProgress);
      provider.off('download-complete', onDownloadComplete);
      provider.off('upload-complete', onUploadComplete);
      provider.off('error', onError);
    };
  }, [provider, connectionId]);

  const handleDownloadAll = useCallback(async () => {
    if (!provider || availableFiles.length === 0) return;
    for (const file of availableFiles) {
      provider.downloadFile(file, availableFiles.indexOf(file));
    }
  }, [provider, availableFiles]);

  const queueUpload = useCallback((items: File[] | DroppedFileEntry[]) => {
    if (!provider || items.length === 0) return;

    const isDropped = (arr: typeof items) =>
      arr.length > 0 && typeof (arr[0] as DroppedFileEntry).file !== 'undefined';

    const itemMeta = (item: File | DroppedFileEntry, idx: number, dropped: boolean) => ({
      fileName: dropped
        ? ((item as DroppedFileEntry).name ?? (item as DroppedFileEntry).file?.name ?? `file-${idx}`)
        : (item as File).name,
      totalBytes: dropped
        ? ((item as DroppedFileEntry).size ?? (item as DroppedFileEntry).file?.size ?? 0)
        : (item as File).size,
    });

    const drainNext = (batch: Array<File | DroppedFileEntry>) => {
      uploadBusy.current = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handle = provider.uploadFiles(batch as any);
        const dropped = isDropped(batch as File[] | DroppedFileEntry[]);

        setTransfers(prev => {
          // Replace any 'pending' placeholders for files in this batch, then add real entries
          const withoutPending = prev.filter(t => t.status !== 'pending' || t.direction !== 'upload');
          const next = [...withoutPending];
          for (const [fileIndex, transferId] of handle.transferIds as Map<number, number>) {
            const item = batch[fileIndex];
            if (!item) continue;
            const { fileName, totalBytes } = itemMeta(item, fileIndex, dropped);
            if (next.some(t => t.transferId === transferId)) continue;
            next.push({ transferId, fileName, totalBytes, bytesTransferred: 0, percentage: 0, direction: 'upload', status: 'active' });
          }
          return next;
        });

        setUploadHint('Files queued. Paste in the remote desktop (Ctrl+V) to start upload.');
        handle.completion.finally(() => {
          // Merge ALL pending batches into one so the next Ctrl+V sends everything at once
          const pending = uploadQueue.current.splice(0);
          if (pending.length > 0) {
            drainNext(pending.flat());
          } else {
            uploadBusy.current = false;
            setUploadHint('');
          }
        });
      } catch {
        uploadBusy.current = false;
        setUploadHint('Upload failed to queue. Try again.');
      }
    };

    if (uploadBusy.current) {
      // Buffer and show as 'pending' in the list
      uploadQueue.current.push(items as Array<File | DroppedFileEntry>);
      const dropped = isDropped(items);
      setTransfers(prev => {
        const next = [...prev];
        (items as Array<File | DroppedFileEntry>).forEach((item, idx) => {
          const { fileName, totalBytes } = itemMeta(item, idx, dropped);
          const tempId = tempIdCounter.current--;
          next.push({ transferId: tempId, fileName, totalBytes, bytesTransferred: 0, percentage: 0, direction: 'upload', status: 'pending' });
        });
        return next;
      });
    } else {
      drainNext(items as Array<File | DroppedFileEntry>);
    }
  }, [provider]);

  // Keep ref in sync so useImperativeHandle can call the latest queueUpload without a dep cycle
  queueUploadRef.current = queueUpload;

  const clearQueue = useCallback(() => {
    uploadQueue.current = [];
    setTransfers(prev => prev.filter(t => t.status !== 'pending' && t.status !== 'active'));
  }, []);

  const clearTransfer = useCallback((transferId: number) => {
    setTransfers(prev => prev.filter(t => t.transferId !== transferId));
    if (transferId < 0) {
      uploadQueue.current = uploadQueue.current.filter((_, batchIdx) => {
        return true;
      });
    }
  }, []);

  const handleUpload = useCallback(async () => {
    if (!provider) return;
    try {
      const files = await provider.showFilePicker({ multiple: true });
      if (files.length > 0) queueUpload(files);
    } catch {
      setUploadHint('File picker was cancelled or blocked by the browser.');
    }
  }, [provider, queueUpload]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (!provider) return;
    try {
      const files = await provider.handleDrop(e.nativeEvent);
      if (files.length > 0) queueUpload(files as DroppedFileEntry[]);
    } catch {
      setUploadHint('Drop upload failed. Try using Browse Files.');
    }
  }, [provider, queueUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const clearCompleted = useCallback(() => {
    setTransfers(prev => prev.filter(t => t.status === 'active' || t.status === 'pending'));
  }, []);

  if (!visible) return null;

  const activeTransfers = transfers.filter(t => t.status === 'active' || t.status === 'pending');
  const completedTransfers = transfers.filter(t => t.status !== 'active' && t.status !== 'pending');

  return (
    <div className="absolute right-2 top-2 z-50 w-80 max-h-[32rem] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <span className="font-medium text-white">File Transfer</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowInfo(v => !v)}
            title="How to use file transfer"
            className={`w-5 h-5 rounded-full border text-[11px] font-bold flex items-center justify-center transition-colors ${
              showInfo ? 'border-blue-400 text-blue-400' : 'border-gray-500 text-gray-400 hover:border-gray-300 hover:text-gray-200'
            }`}
          >
            i
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
      </div>

      {/* Info panel */}
      {showInfo && (
        <div className="mx-3 mt-2 p-3 bg-gray-800 rounded text-[11px] text-gray-300 leading-relaxed border border-gray-700">
          {INFO_TEXT.split('\n').map((line, i) =>
            line.startsWith('**') ? (
              <p key={i} className="font-semibold text-white mt-2 first:mt-0">{line.replace(/\*\*/g, '')}</p>
            ) : line.match(/^\d\./) ? (
              <p key={i} className="ml-2 mt-0.5">{line}</p>
            ) : (
              <p key={i} className="mt-0.5">{line}</p>
            )
          )}
        </div>
      )}

      {/* Upload zone */}
      <div
        ref={dropRef}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`mx-3 mt-2 p-3 border-2 border-dashed rounded text-center text-xs transition-colors ${
          isDragOver ? 'border-blue-400 bg-blue-900/20 text-blue-300' : 'border-gray-600 text-gray-400'
        }`}
      >
        <p>Drop files here or</p>
        <button
          onClick={handleUpload}
          className="mt-1 px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs"
        >
          Browse Files
        </button>
      </div>
      {uploadHint && (
        <p className="mx-3 mt-2 text-[11px] text-yellow-300">{uploadHint}</p>
      )}

      {/* Available files from remote */}
      {availableFiles.length > 0 && (
        <div className="mx-3 mt-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">Remote files available</span>
            <div className="relative group">
              <button
                onClick={handleDownloadAll}
                className="text-xs px-2 py-0.5 bg-green-600 hover:bg-green-500 text-white rounded"
              >
                Download All
              </button>
              <div className="hidden group-hover:block absolute right-0 bottom-full mb-1.5 w-56 bg-gray-800 border border-gray-600 rounded p-2 text-[11px] text-gray-300 leading-snug shadow-lg z-10 pointer-events-none">
                Your browser may ask for permission to download multiple files — click <span className="text-white font-medium">Allow</span> when prompted in the address bar.
              </div>
            </div>
          </div>
          {availableFiles.map((f, i) => (
            <div key={i} className="flex items-center justify-between py-0.5 text-xs text-gray-300">
              <span className="truncate flex-1">{f.name}</span>
              <span className="text-gray-500 ml-2">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Active / pending transfers */}
      {activeTransfers.length > 0 && (
        <div className="mx-3 mt-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">Active transfers</span>
            <button onClick={clearQueue} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
              Clear all
            </button>
          </div>
          {activeTransfers.map(t => (
            <div key={t.transferId} className="mt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate flex-1 text-gray-300">
                  {t.direction === 'upload' ? '↑' : '↓'} {t.fileName}
                  {t.status === 'pending' && <span className="ml-1 text-gray-500 italic">(queued)</span>}
                </span>
                <div className="flex items-center gap-1 ml-1 shrink-0">
                  <span className="text-gray-500">{t.percentage}%</span>
                  <button
                    onClick={() => clearTransfer(t.transferId)}
                    className="text-gray-600 hover:text-red-400 text-[10px] leading-none"
                    title="Remove from list"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="w-full h-1 bg-gray-700 rounded mt-0.5">
                <div
                  className={`h-full rounded transition-all ${
                    t.status === 'pending' ? 'bg-gray-600' : t.direction === 'upload' ? 'bg-blue-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${t.percentage}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Completed / errored */}
      {completedTransfers.length > 0 && (
        <div className="mx-3 mt-2 mb-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">History</span>
            <button onClick={clearCompleted} className="text-xs text-gray-500 hover:text-gray-300">
              Clear
            </button>
          </div>
          {completedTransfers.slice(-10).map(t => (
            <div key={t.transferId} className="flex items-center text-xs py-0.5">
              <span className={t.status === 'error' ? 'text-red-400' : 'text-green-400'}>
                {t.status === 'error' ? '✗' : '✓'}
              </span>
              <span className="truncate flex-1 ml-1 text-gray-300">{t.fileName}</span>
              {t.status === 'error' && (
                <span className="text-red-400 ml-1 text-[10px]">{t.errorMessage}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {transfers.length === 0 && availableFiles.length === 0 && (
        <p className="text-xs text-gray-500 text-center py-3">No transfers yet</p>
      )}
    </div>
  );
});
