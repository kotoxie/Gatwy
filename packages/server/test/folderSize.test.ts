import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeFolderSize, type FolderSizeEntry } from '../src/services/folderSize.js';

const tree: Record<string, FolderSizeEntry[]> = {
  '/r': [
    { name: 'a.txt', isDirectory: false, size: 100 },
    { name: 'sub', isDirectory: true, size: 4096 },
    { name: 'link', isDirectory: true, isSymlink: true, size: 7 },
  ],
  '/r/sub': [
    { name: 'b.bin', isDirectory: false, size: 50 },
    { name: '..', isDirectory: true },
  ],
};

const base = {
  joinPath: (d: string, n: string) => `${d}/${n}`,
  listDir: async (p: string) => tree[p] ?? [],
};

describe('computeFolderSize', () => {
  it('sums files recursively, ignores directory entry sizes and does not follow symlinks', async () => {
    const r = await computeFolderSize('/r', base);
    assert.deepEqual(r, { size: 157, files: 3, folders: 1, truncated: false });
  });

  it('stops at the entry cap and reports a partial result', async () => {
    const r = await computeFolderSize('/r', { ...base, maxEntries: 2 });
    assert.equal(r.truncated, true);
    assert.equal(r.files + r.folders, 2);
  });

  it('stops when aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await computeFolderSize('/r', { ...base, signal: ctrl.signal });
    assert.equal(r.truncated, true);
    assert.equal(r.files, 0);
  });

  it('stops at the time limit', async () => {
    let t = 0;
    const r = await computeFolderSize('/r', { ...base, timeoutMs: 10, now: () => (t += 20) });
    assert.equal(r.truncated, true);
  });

  it('bounds depth so link loops terminate', async () => {
    const loop = { joinPath: base.joinPath, listDir: async () => [{ name: 'd', isDirectory: true } as FolderSizeEntry] };
    const r = await computeFolderSize('/x', { ...loop, maxDepth: 5 });
    assert.equal(r.truncated, true);
    assert.equal(r.folders, 5);
  });

  it('throws for an unreadable root but tolerates unreadable subfolders', async () => {
    await assert.rejects(computeFolderSize('/r', { ...base, listDir: async () => { throw new Error('denied'); } }));
    const r = await computeFolderSize('/r', {
      ...base,
      listDir: async (p) => { if (p === '/r/sub') throw new Error('denied'); return tree[p] ?? []; },
    });
    assert.equal(r.truncated, true);
    assert.equal(r.size, 107);
  });
});
