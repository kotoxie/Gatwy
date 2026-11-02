export interface SshStats {
  hostname: string;
  cpuPercent: number;
  cpuHistory: number[];
  memUsedKb: number;
  memTotalKb: number;
  uptimeSeconds: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  diskPercent: number | null;
}

const HISTORY_POINTS = 60;
const GRAPH_WIDTH = 90;
const GRAPH_HEIGHT = 16;
const MIN_BAR = 2;

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours >= 1 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatRate(bytesPerSec: number): string {
  return `${((bytesPerSec * 8) / 1_000_000).toFixed(2)} Mb/s`;
}

const kbToGb = (kb: number) => (kb / 1024 / 1024).toFixed(2);

function CpuGraph({ history }: { history: number[] }) {
  // A single sample is drawn as a flat run so the graph shows up as soon as there is any data.
  const values = history.length === 1 ? [history[0]!, history[0]!] : history;
  const step = GRAPH_WIDTH / (HISTORY_POINTS - 1);
  const offset = GRAPH_WIDTH - (values.length - 1) * step;
  // Reserve a baseline strip so 0% still draws a visible line.
  const y = (v: number) => GRAPH_HEIGHT - MIN_BAR - (v / 100) * (GRAPH_HEIGHT - MIN_BAR);
  const line = values.map((v, i) => `${(offset + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${offset.toFixed(1)},${GRAPH_HEIGHT} ${line} ${GRAPH_WIDTH},${GRAPH_HEIGHT}`;
  return (
    <svg width={GRAPH_WIDTH} height={GRAPH_HEIGHT} className="bg-black border border-border/40 shrink-0" aria-label="CPU, last 2 minutes">
      {values.length > 1 && (
        <>
          <polygon points={area} fill="#4ade80" fillOpacity="0.35" />
          <polyline points={line} fill="none" stroke="#4ade80" strokeWidth="1" />
        </>
      )}
    </svg>
  );
}
export function SshStatsBar({ stats }: { stats: SshStats }) {
  const item = 'flex items-center gap-1.5 px-2.5 border-r border-border/30 last:border-r-0 whitespace-nowrap';
  return (
    <div className="shrink-0 bg-black/80 border-t border-border/30 py-1 flex items-center text-xs font-mono text-text-secondary overflow-x-auto">
      {stats.hostname && <span className={`${item} text-text-primary`} title="Hostname">{stats.hostname}</span>}
      <span className={item} title="CPU usage (graph: last 2 minutes)">
        <span className="text-text-primary w-9 text-right">{stats.cpuPercent === null ? '–' : `${stats.cpuPercent}%`}</span>
        <CpuGraph history={stats.cpuHistory} />
      </span>
      <span className={item} title="Memory used / total">
        {kbToGb(stats.memUsedKb)} GB / {kbToGb(stats.memTotalKb)} GB
      </span>
      <span className={item} title="Upstream (sent by the host)">
        <span className="text-green-400">↑</span> {formatRate(stats.txBytesPerSec)}
      </span>
      <span className={item} title="Downstream (received by the host)">
        <span className="text-blue-400">↓</span> {formatRate(stats.rxBytesPerSec)}
      </span>
      <span className={item} title="Uptime">{formatUptime(stats.uptimeSeconds)}</span>
      {stats.diskPercent !== null && <span className={item} title="Disk usage of /">/: {stats.diskPercent}%</span>}
    </div>
  );
}
