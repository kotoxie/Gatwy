import { useState, useEffect, useCallback, useRef } from 'react';

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
  status: 'active' | 'complete' | 'error';
  errorMessage?: string;
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

export function RdpFileTransfer({ provider, visible, connectionId, onClose }: RdpFileTransferProps) {
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [availableFiles, setAvailableFiles] = useState<FileInfo[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadHint, setUploadHint] = useState('');
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!provider) return;

    const onFilesAvailable = (files: FileInfo[]) => {
      setAvailableFiles(files);
    };

    const onDownloadProgress = (progress: TransferProgress) => {
      setTransfers(prev => {
        const existing = prev.find(t => t.transferId === progress.transferId);
        if (existing) {
          return prev.map(t => t.transferId === progress.transferId
            ? { ...t, bytesTransferred: progress.bytesTransferred, percentage: progress.percentage }
            : t);
        }
        return [...prev, {
          transferId: progress.transferId,
          fileName: progress.fileName,
          totalBytes: progress.totalBytes,
          bytesTransferred: progress.bytesTransferred,
          percentage: progress.percentage,
          direction: 'download',
          status: 'active',
        }];
      });
    };

    const onUploadProgress = (progress: TransferProgress) => {
      setTransfers(prev => {
        const existing = prev.find(t => t.transferId === progress.transferId);
        if (existing) {
          return prev.map(t => t.transferId === progress.transferId
            ? { ...t, bytesTransferred: progress.bytesTransferred, percentage: progress.percentage }
            : t);
        }
        return [...prev, {
          transferId: progress.transferId,
          fileName: progress.fileName,
          totalBytes: progress.totalBytes,
          bytesTransferred: progress.bytesTransferred,
          percentage: progress.percentage,
          direction: 'upload',
          status: 'active',
        }];
      });
    };

    const onDownloadComplete = (file: FileInfo, blob: Blob) => {
      setTransfers(prev => prev.map(t =>
        t.fileName === file.name && t.direction === 'download'
          ? { ...t, status: 'complete' as const, percentage: 100 }
          : t,
      ));
      logFileTransfer(connectionId, file.name, file.size, 'download');
      // Auto-download the file
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
    try {
      const handle = provider.uploadFiles(items);
      setTransfers(prev => {
        const next = [...prev];
        const isDropped = typeof (items[0] as DroppedFileEntry).file !== 'undefined';
        for (const [fileIndex, transferId] of handle.transferIds as Map<number, number>) {
          const item = items[fileIndex];
          if (!item) continue;
          const fileName = isDropped
            ? ((item as DroppedFileEntry).name ?? (item as DroppedFileEntry).file?.name ?? `file-${fileIndex}`)
            : (item as File).name;
          const totalBytes = isDropped
            ? ((item as DroppedFileEntry).size ?? (item as DroppedFileEntry).file?.size ?? 0)
            : (item as File).size;
          if (next.some((t) => t.transferId === transferId)) continue;
          next.push({
            transferId,
            fileName,
            totalBytes,
            bytesTransferred: 0,
            percentage: 0,
            direction: 'upload',
            status: 'active',
          });
        }
        return next;
      });
      setUploadHint('Files queued. Paste in the remote desktop (Ctrl+V) to start upload.');
      handle.completion.finally(() => {
        setUploadHint('');
      });
    } catch {
      setUploadHint('Upload failed to queue. Try again.');
    }
  }, [provider]);

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
    setTransfers(prev => prev.filter(t => t.status === 'active'));
  }, []);

  if (!visible) return null;

  const activeTransfers = transfers.filter(t => t.status === 'active');
  const completedTransfers = transfers.filter(t => t.status !== 'active');

  return (
    <div className="absolute right-2 top-2 z-50 w-80 max-h-96 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <span className="font-medium text-white">File Transfer</span>
        <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
      </div>

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
            <button
              onClick={handleDownloadAll}
              className="text-xs px-2 py-0.5 bg-green-600 hover:bg-green-500 text-white rounded"
            >
              Download All
            </button>
          </div>
          {availableFiles.map((f, i) => (
            <div key={i} className="flex items-center justify-between py-0.5 text-xs text-gray-300">
              <span className="truncate flex-1">{f.name}</span>
              <span className="text-gray-500 ml-2">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Active transfers */}
      {activeTransfers.length > 0 && (
        <div className="mx-3 mt-2">
          <span className="text-xs text-gray-400">Active transfers</span>
          {activeTransfers.map(t => (
            <div key={t.transferId} className="mt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate flex-1 text-gray-300">
                  {t.direction === 'upload' ? '↑' : '↓'} {t.fileName}
                </span>
                <span className="text-gray-500 ml-1">{t.percentage}%</span>
              </div>
              <div className="w-full h-1 bg-gray-700 rounded mt-0.5">
                <div
                  className={`h-full rounded transition-all ${
                    t.direction === 'upload' ? 'bg-blue-500' : 'bg-green-500'
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
}
