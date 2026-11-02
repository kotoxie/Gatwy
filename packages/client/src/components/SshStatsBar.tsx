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
type IconName = 'host' | 'cpu' | 'ram' | 'up' | 'down' | 'clock' | 'disk';

const ICON_PATHS: Record<IconName, string> = {
  host: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  ram: 'M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M19 8v8M6 16v3M18 16v3',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  disk: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
};

function Icon({ name, className = 'text-text-secondary/70' }: { name: IconName; className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function Section({ icon, iconClass, title, children }: { icon: IconName; iconClass?: string; title: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 px-3 whitespace-nowrap" title={title}>
      <Icon name={icon} className={iconClass} />
      {children}
    </span>
  );
}

function Divider() {
  return <span aria-hidden="true" className="w-px h-4 shrink-0 bg-linear-to-b from-transparent via-border to-transparent" />;
}

export function SshStatsBar({ stats }: { stats: SshStats }) {
  const value = 'text-text-primary';
  const sections = [
    stats.hostname && (
      <Section key="host" icon="host" title="Hostname">
        <span className={`${value} font-semibold`}>{stats.hostname}</span>
      </Section>
    ),
    <Section key="cpu" icon="cpu" title="CPU usage (graph: last 2 minutes)">
      <span className={`${value} w-9 text-right`}>{stats.cpuPercent === null ? '–' : `${stats.cpuPercent}%`}</span>
      <CpuGraph history={stats.cpuHistory} />
    </Section>,
    <Section key="ram" icon="ram" title="Memory used / total">
      <span className={value}>{kbToGb(stats.memUsedKb)}</span> / {kbToGb(stats.memTotalKb)} GB
    </Section>,
    <Section key="up" icon="up" iconClass="text-green-400" title="Upstream (sent by the host)">
      <span className={value}>{formatRate(stats.txBytesPerSec)}</span>
    </Section>,
    <Section key="down" icon="down" iconClass="text-blue-400" title="Downstream (received by the host)">
      <span className={value}>{formatRate(stats.rxBytesPerSec)}</span>
    </Section>,
    <Section key="uptime" icon="clock" title="Uptime">
      <span className={value}>{formatUptime(stats.uptimeSeconds)}</span>
    </Section>,
    stats.diskPercent !== null && (
      <Section key="disk" icon="disk" title="Disk usage of /">
        <span className={value}>/: {stats.diskPercent}%</span>
      </Section>
    ),
  ].filter(Boolean);

  return (
    <div className="shrink-0 bg-linear-to-b from-black/70 to-black/90 border-t border-border/30 py-1.5 flex items-center text-xs font-mono text-text-secondary overflow-x-auto">
      {sections.map((section, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && <Divider />}
          {section}
        </span>
      ))}
    </div>
  );
}