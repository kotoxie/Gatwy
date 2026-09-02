import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../hooks/useAuth';
import { type Protocol } from '../types/protocol.js';

interface ApiConnection {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  tags?: string[];
}

interface ApiGroup {
  id: string;
  name: string;
  children: ApiGroup[];
  connections: ApiConnection[];
}

interface PaletteEntry {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  tags: string[];
  folderPath: string;
  shared: boolean;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: { id: string; name: string; protocol: Protocol }) => void;
}

const MAX_RESULTS = 60;

const PROTOCOL_ICONS: Record<Protocol, string> = {
  ssh: '>_',
  rdp: '🖥',
  smb: '📁',
  vnc: '🖱',
  moonlight: '☾',
  sftp: '📂',
  ftp: '🗂',
  telnet: '⌨',
  postgres: '🐘',
  mysql: '🐬',
};

/** Extra searchable aliases so "postgres"/"psql" both find a postgres connection. */
const PROTOCOL_ALIASES: Record<Protocol, string> = {
  ssh: 'ssh shell terminal',
  rdp: 'rdp remote desktop windows',
  smb: 'smb cifs share windows',
  vnc: 'vnc',
  moonlight: 'moonlight sunshine stream',
  sftp: 'sftp files',
  ftp: 'ftp files',
  telnet: 'telnet',
  postgres: 'postgres postgresql psql database sql',
  mysql: 'mysql mariadb database sql',
};

const WORD_BOUNDARY = /[\s\-_./:@]/;

/**
 * Subsequence fuzzy match. Returns a score (higher is better) or null when the
 * query is not a subsequence of the text. Contiguous and word-start matches
 * score higher so "wsrv" ranks web-srv above w-e-s-t-e-r-v-ille.
 */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  if (!text) return null;
  const t = text.toLowerCase();

  const idx = t.indexOf(query);
  if (idx === 0) return 200 + query.length * 2;
  if (idx > 0) {
    const atWordStart = WORD_BOUNDARY.test(t[idx - 1]);
    return 120 + query.length * 2 + (atWordStart ? 20 : 0) - Math.min(idx, 30);
  }

  let cursor = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatch = -2;

  for (const ch of query) {
    let found = -1;
    while (cursor < t.length) {
      if (t[cursor] === ch) {
        found = cursor;
        break;
      }
      cursor++;
    }
    if (found === -1) return null;

    consecutive = found === prevMatch + 1 ? consecutive + 1 : 0;
    const atWordStart = found === 0 || WORD_BOUNDARY.test(t[found - 1]);
    score += 1 + consecutive * 2 + (atWordStart ? 4 : 0);
    prevMatch = found;
    cursor++;
  }
  return score;
}

/** Weighted fields searched per connection — name matches outrank tag matches. */
function entryFields(entry: PaletteEntry): Array<[string, number]> {
  return [
    [entry.name, 1],
    [entry.host, 0.85],
    [`${entry.host}:${entry.port}`, 0.8],
    [entry.tags.join(' '), 0.7],
    [PROTOCOL_ALIASES[entry.protocol] ?? entry.protocol, 0.6],
    [entry.folderPath, 0.5],
  ];
}

/** Every token must match at least one field; the score is the sum of best hits. */
function scoreEntry(entry: PaletteEntry, tokens: string[]): number | null {
  const fields = entryFields(entry);
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    for (const [text, weight] of fields) {
      const raw = fuzzyScore(token, text);
      if (raw === null) continue;
      const weighted = raw * weight;
      if (best === null || weighted > best) best = weighted;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

function highlight(text: string, tokens: string[]): ReactNode {
  if (tokens.length === 0) return text;
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];

  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(token, from);
      if (i === -1) break;
      ranges.push([i, i + token.length]);
      from = i + token.length;
    }
  }
  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const out: ReactNode[] = [];
  let pos = 0;
  merged.forEach(([start, end], i) => {
    if (start > pos) out.push(text.slice(pos, start));
    out.push(
      <mark key={i} className="bg-accent/30 text-inherit rounded-[2px]">
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function flattenGroups(groups: ApiGroup[], prefix: string, out: PaletteEntry[]) {
  for (const group of groups) {
    const path = prefix ? `${prefix} / ${group.name}` : group.name;
    for (const conn of group.connections) out.push(toEntry(conn, path, false));
    flattenGroups(group.children, path, out);
  }
}

function toEntry(conn: ApiConnection, folderPath: string, shared: boolean): PaletteEntry {
  return {
    id: conn.id,
    name: conn.name,
    protocol: conn.protocol,
    host: conn.host,
    port: conn.port,
    tags: conn.tags ?? [],
    folderPath,
    shared,
  };
}

const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const Key = ({ children }: { children: ReactNode }) => (
  <kbd className="px-1.5 py-0.5 rounded border border-border bg-surface-alt font-sans text-[10px] leading-none">
    {children}
  </kbd>
);

export function CommandPalette({ isOpen, onClose, onConnect }: CommandPaletteProps) {
  const { features } = useAuth();
  const [entries, setEntries] = useState<PaletteEntry[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelected(0);
    setLoading(true);

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/v1/connections', {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          groups?: ApiGroup[];
          ungrouped?: ApiConnection[];
          sharedConnections?: ApiConnection[];
        };
        const flat: PaletteEntry[] = [];
        flattenGroups(data.groups ?? [], '', flat);
        for (const conn of data.ungrouped ?? []) flat.push(toEntry(conn, '', false));
        for (const conn of data.sharedConnections ?? []) flat.push(toEntry(conn, 'Shared with me', true));
        setEntries(features.moonlight ? flat : flat.filter((e) => e.protocol !== 'moonlight'));
      } catch {
        /* aborted or offline — keep whatever we already have */
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [isOpen, features.moonlight]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const results = useMemo(() => {
    if (tokens.length === 0) return entries.slice(0, MAX_RESULTS);
    return entries
      .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
      .filter((r): r is { entry: PaletteEntry; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, MAX_RESULTS)
      .map((r) => r.entry);
  }, [entries, tokens]);

  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected, results.length]);

  const choose = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return;
      onConnect({ id: entry.id, name: entry.name, protocol: entry.protocol });
      onClose();
    },
    [onConnect, onClose],
  );

  if (!isOpen) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSelected(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSelected(Math.max(0, results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[selected]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-start justify-center bg-black/50 backdrop-blur-xs pt-[12vh] px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border text-text-secondary">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search connections by name, host, tag or protocol…"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-secondary/70"
          />
          <span className="text-[10px] text-text-secondary/70 tabular-nums shrink-0">
            {loading ? '…' : `${results.length}`}
          </span>
        </div>

        <ul ref={listRef} className="overflow-y-auto flex-1 py-1">
          {results.map((entry, i) => (
            <li key={entry.id}>
              <button
                type="button"
                onMouseMove={() => setSelected(i)}
                onClick={() => choose(entry)}
                className={clsx(
                  'w-full flex items-center gap-3 px-3 py-2 text-left',
                  i === selected ? 'bg-accent/20' : 'hover:bg-surface-hover',
                )}
              >
                <span className="text-xs font-mono opacity-60 w-6 text-center shrink-0 select-none">
                  {PROTOCOL_ICONS[entry.protocol] ?? entry.protocol}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-text-primary truncate">
                    {highlight(entry.name, tokens)}
                  </span>
                  <span className="block text-[11px] text-text-secondary truncate">
                    {highlight(`${entry.host}:${entry.port}`, tokens)}
                    {entry.folderPath && <span className="opacity-60"> · {entry.folderPath}</span>}
                  </span>
                </span>
                {entry.tags.length > 0 && (
                  <span className="hidden sm:flex items-center gap-1 shrink-0 max-w-[40%] overflow-hidden">
                    {entry.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 rounded bg-surface-alt border border-border text-[10px] text-text-secondary whitespace-nowrap"
                      >
                        {highlight(tag, tokens)}
                      </span>
                    ))}
                  </span>
                )}
                {entry.shared && (
                  <span className="text-[10px] text-text-secondary/70 shrink-0">shared</span>
                )}
              </button>
            </li>
          ))}

          {!loading && results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-text-secondary">
              {entries.length === 0 ? 'No connections available.' : 'No connections match your search.'}
            </li>
          )}
        </ul>

        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border text-[10px] text-text-secondary">
          <span className="flex items-center gap-1"><Key>↑</Key><Key>↓</Key> navigate</span>
          <span className="flex items-center gap-1"><Key>Enter</Key> connect</span>
          <span className="flex items-center gap-1"><Key>Esc</Key> close</span>
        </div>
      </div>
    </div>
  );
}
