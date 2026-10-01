import { useState, useEffect, useCallback } from 'react';

interface SchemaNode {
  name: string;
  type: 'database' | 'schema' | 'table' | 'view' | 'column';
  expanded?: boolean;
  children?: SchemaNode[];
  colType?: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
}

interface SchemaTreeProps {
  connectionId: string;
  protocol: 'postgres' | 'mysql';
  defaultDatabase: string;
  rowLimit: number;
  onTableClick: (sql: string) => void;
}

function ChevronRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronDown({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function NodeIcon({ type, isPk }: { type: SchemaNode['type']; isPk?: boolean }) {
  if (type === 'database' || type === 'schema') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-accent shrink-0">
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
        <path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4" />
      </svg>
    );
  }
  if (type === 'table') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-text-secondary shrink-0">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    );
  }
  if (type === 'view') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-text-secondary/60 shrink-0">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  if (type === 'column') {
    return (
      <span className={`text-[9px] font-bold shrink-0 ${isPk ? 'text-yellow-500' : 'text-text-secondary/50'}`}>
        {isPk ? 'PK' : '·'}
      </span>
    );
  }
  return null;
}

export function SchemaTree({ connectionId, protocol, defaultDatabase, rowLimit, onTableClick }: SchemaTreeProps) {
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, Array<{ name: string; type: string }>>>({});
  const [columnsByTable, setColumnsByTable] = useState<Record<string, Array<{ name: string; type: string; nullable: boolean; isPrimaryKey: boolean }>>>({});

  const fetchSchemas = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/v1/db/${connectionId}/schemas`, { credentials: 'include' });
      const d = await r.json() as { schemas?: string[] };
      if (Array.isArray(d.schemas)) {
        setSchemas(d.schemas);
        // Auto-expand the default database/schema
        const key = `schema:${defaultDatabase}`;
        setExpanded(prev => ({ ...prev, [key]: true }));
        fetchTables(defaultDatabase);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [connectionId, defaultDatabase]);

  const fetchTables = useCallback(async (schema: string) => {
    try {
      const r = await fetch(`/api/v1/db/${connectionId}/tables?schema=${encodeURIComponent(schema)}`, { credentials: 'include' });
      const d = await r.json() as { tables?: Array<{ name: string; type: string }> };
      if (Array.isArray(d.tables)) {
        setTablesBySchema(prev => ({ ...prev, [schema]: d.tables! }));
      }
    } catch { /* ignore */ }
  }, [connectionId]);

  const fetchColumns = useCallback(async (schema: string, table: string) => {
    const key = `${schema}/${table}`;
    try {
      const r = await fetch(`/api/v1/db/${connectionId}/table/${encodeURIComponent(table)}?schema=${encodeURIComponent(schema)}`, { credentials: 'include' });
      const d = await r.json() as { columns?: Array<{ name: string; type: string; nullable: boolean; isPrimaryKey: boolean }> };
      if (Array.isArray(d.columns)) {
        setColumnsByTable(prev => ({ ...prev, [key]: d.columns! }));
      }
    } catch { /* ignore */ }
  }, [connectionId]);

  useEffect(() => { fetchSchemas(); }, [fetchSchemas]);

  const toggleSchema = (schema: string) => {
    const key = `schema:${schema}`;
    const next = !expanded[key];
    setExpanded(prev => ({ ...prev, [key]: next }));
    if (next && !tablesBySchema[schema]) fetchTables(schema);
  };

  const toggleTable = (schema: string, table: string) => {
    const key = `table:${schema}/${table}`;
    const next = !expanded[key];
    setExpanded(prev => ({ ...prev, [key]: next }));
    if (next && !columnsByTable[`${schema}/${table}`]) fetchColumns(schema, table);
  };

  const handleTableDoubleClick = (schema: string, table: string) => {
    // No LIMIT here — the server injects LIMIT/OFFSET automatically and runs COUNT(*) for totals
    const sql = protocol === 'postgres'
      ? `SELECT * FROM "${schema}"."${table}";`
      : `SELECT * FROM \`${table}\`;`;
    onTableClick(sql);
  };

  const filteredSchemas = search
    ? schemas.filter(s => s.toLowerCase().includes(search.toLowerCase()) ||
        (tablesBySchema[s] ?? []).some(t => t.name.toLowerCase().includes(search.toLowerCase())))
    : schemas;

  return (
    <div className="flex flex-col h-full bg-surface border-r border-border min-w-0">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border shrink-0">
        <span className="text-xs font-medium text-text-secondary">Schema</span>
        <button
          onClick={fetchSchemas}
          title="Refresh"
          className="text-text-secondary hover:text-text-primary"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter…"
          className="w-full px-2 py-0.5 text-xs bg-surface border border-border rounded text-text-primary outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 py-1 text-xs">
        {loading && <p className="text-text-secondary text-center py-3">Loading…</p>}
        {filteredSchemas.map(schema => {
          const schemaKey = `schema:${schema}`;
          const isSchemaExpanded = !!expanded[schemaKey];
          const tables = tablesBySchema[schema] ?? [];
          const filteredTables = search
            ? tables.filter(t => t.name.toLowerCase().includes(search.toLowerCase()))
            : tables;

          return (
            <div key={schema}>
              <button
                className="w-full flex items-center gap-1.5 px-2 py-0.5 hover:bg-surface-hover text-text-primary text-left"
                onClick={() => toggleSchema(schema)}
              >
                <span className="text-text-secondary/50 shrink-0">
                  {isSchemaExpanded ? <ChevronDown /> : <ChevronRight />}
                </span>
                <NodeIcon type="schema" />
                <span className="truncate">{schema}</span>
              </button>

              {isSchemaExpanded && filteredTables.map(tbl => {
                const tableKey = `table:${schema}/${tbl.name}`;
                const isTableExpanded = !!expanded[tableKey];
                const cols = columnsByTable[`${schema}/${tbl.name}`];

                return (
                  <div key={tbl.name}>
                    <button
                      className="w-full flex items-center gap-1.5 pl-5 pr-2 py-0.5 hover:bg-surface-hover text-text-primary text-left"
                      onClick={() => toggleTable(schema, tbl.name)}
                      onDoubleClick={() => handleTableDoubleClick(schema, tbl.name)}
                      title="Double-click to query"
                    >
                      <span className="text-text-secondary/50 shrink-0">
                        {isTableExpanded ? <ChevronDown /> : <ChevronRight />}
                      </span>
                      <NodeIcon type={tbl.type === 'view' ? 'view' : 'table'} />
                      <span className="truncate">{tbl.name}</span>
                    </button>

                    {isTableExpanded && (
                      <div>
                        {!cols && (
                          <div className="pl-12 py-0.5 text-text-secondary/60">Loading…</div>
                        )}
                        {cols?.map(col => (
                          <div key={col.name} className="flex items-center gap-1.5 pl-12 pr-2 py-0.5 text-text-secondary/80">
                            <NodeIcon type="column" isPk={col.isPrimaryKey} />
                            <span className="truncate">{col.name}</span>
                            <span className="ml-auto text-[10px] text-text-secondary/40 shrink-0">{col.type}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
