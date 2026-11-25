export const FOLDER_SIZE_MAX_ENTRIES = 100_000;
export const FOLDER_SIZE_TIMEOUT_MS = 60_000;
// Guards against symlink/junction loops on protocols that can't flag links (SMB)
export const FOLDER_SIZE_MAX_DEPTH = 64;

export interface FolderSizeEntry {
  name: string;
  isDirectory: boolean;
  // Symlinks are counted as a single entry and never followed
  isSymlink?: boolean;
  size?: number;
}

export interface FolderSizeResult {
  size: number;
  files: number;
  folders: number;
  // True when a limit was hit or the scan was cancelled; the totals are then a lower bound
  truncated: boolean;
}

export interface FolderSizeOptions {
  listDir: (dirPath: string) => Promise<FolderSizeEntry[]>;
  joinPath: (dir: string, name: string) => string;
  signal?: AbortSignal;
  maxEntries?: number;
  timeoutMs?: number;
  maxDepth?: number;
  now?: () => number;
}

export async function computeFolderSize(root: string, opts: FolderSizeOptions): Promise<FolderSizeResult> {
  const maxEntries = opts.maxEntries ?? FOLDER_SIZE_MAX_ENTRIES;
  const timeoutMs = opts.timeoutMs ?? FOLDER_SIZE_TIMEOUT_MS;
  const maxDepth = opts.maxDepth ?? FOLDER_SIZE_MAX_DEPTH;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;

  const result: FolderSizeResult = { size: 0, files: 0, folders: 0, truncated: false };
  const stack: { path: string; depth: number }[] = [{ path: root, depth: 0 }];

  while (stack.length > 0) {
    if (opts.signal?.aborted || now() > deadline) { result.truncated = true; break; }
    const { path, depth } = stack.pop()!;

    let entries: FolderSizeEntry[];
    try {
      entries = await opts.listDir(path);
    } catch (err) {
      // An unreadable root is an error; an unreadable subfolder just makes the total partial
      if (path === root) throw err;
      result.truncated = true;
      continue;
    }

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (result.files + result.folders >= maxEntries) { result.truncated = true; return result; }

      if (entry.isDirectory && !entry.isSymlink) {
        result.folders++;
        if (depth + 1 >= maxDepth) { result.truncated = true; continue; }
        stack.push({ path: opts.joinPath(path, entry.name), depth: depth + 1 });
      } else {
        result.files++;
        if (typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size > 0) result.size += entry.size;
      }
    }
  }

  return result;
}
