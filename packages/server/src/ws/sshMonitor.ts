import type { Client as SshClient } from 'ssh2';
import { queryOne } from '../db/helpers.js';
import { getSetting } from '../services/settings.js';

export const MONITOR_INTERVAL_MS = 2000;
export const CPU_HISTORY_LENGTH = 60; // 2 minutes at MONITOR_INTERVAL_MS
const MAX_FAILURES = 3;
const MAX_OUTPUT_BYTES = 64 * 1024;
const EXEC_TIMEOUT_MS = 5000;

// Plain command list (no quoting or variables) so it runs under any login shell.
const MONITOR_COMMAND =
  'head -n 1 /proc/stat; echo "===mem"; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; ' +
  'echo "===up"; cut -d" " -f1 /proc/uptime; echo "===net"; cat /proc/net/dev; ' +
  'echo "===host"; hostname; echo "===disk"; df -P /';

export interface RawSample {
  cpuTotal: number;
  cpuIdle: number;
  memTotalKb: number;
  memAvailableKb: number;
  uptimeSeconds: number;
  rxBytes: number;
  txBytes: number;
  hostname: string;
  diskPercent: number | null;
}

export interface MonitorStats {
  type: 'stats';
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

export function parseSample(output: string): RawSample | null {
  const sections = new Map<string, string[]>();
  let current = 'cpu';
  sections.set(current, []);
  for (const line of output.split('\n')) {
    const marker = line.trim().match(/^===(\w+)$/);
    if (marker) { current = marker[1]!; sections.set(current, []); continue; }
    sections.get(current)!.push(line);
  }

  // Shell startup files may print before the command's own output.
  const cpuLine = (sections.get('cpu') ?? []).find((l) => /^cpu\s/.test(l)) ?? '';
  const cpuFields = cpuLine.trim().split(/\s+/);
  if (cpuFields[0] !== 'cpu') return null;
  const cpu = cpuFields.slice(1, 9).map(Number);
  if (cpu.length < 4 || cpu.some((n) => !Number.isFinite(n))) return null;
  const cpuTotal = cpu.reduce((a, b) => a + b, 0);
  const cpuIdle = cpu[3]! + (cpu[4] ?? 0);

  let memTotalKb = 0;
  let memAvailableKb = 0;
  for (const line of sections.get('mem') ?? []) {
    const m = line.match(/^(MemTotal|MemAvailable):\s+(\d+)/);
    if (!m) continue;
    if (m[1] === 'MemTotal') memTotalKb = Number(m[2]); else memAvailableKb = Number(m[2]);
  }
  if (memTotalKb <= 0) return null;

  const uptimeSeconds = parseFloat(sections.get('up')?.[0] ?? '');
  if (!Number.isFinite(uptimeSeconds)) return null;

  let rxBytes = 0;
  let txBytes = 0;
  for (const line of sections.get('net') ?? []) {
    const m = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m || m[1] === 'lo') continue;
    const cols = m[2]!.trim().split(/\s+/).map(Number);
    if (cols.length < 9 || !Number.isFinite(cols[0]) || !Number.isFinite(cols[8])) continue;
    rxBytes += cols[0]!;
    txBytes += cols[8]!;
  }

  const hostname = (sections.get('host')?.[0] ?? '').trim().slice(0, 64);

  let diskPercent: number | null = null;
  const dfLine = (sections.get('disk') ?? []).map((l) => l.trim()).filter(Boolean)[1];
  const pct = dfLine?.split(/\s+/)[4]?.match(/^(\d{1,3})%$/);
  if (pct) diskPercent = Number(pct[1]);

  return { cpuTotal, cpuIdle, memTotalKb, memAvailableKb, uptimeSeconds, rxBytes, txBytes, hostname, diskPercent };
}

const clampPercent = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

/** Turns consecutive raw samples into rates; counters that went backwards (reboot, wrap) yield 0. */
export class StatsCalculator {
  private prev: { sample: RawSample; at: number } | null = null;
  private history: number[] = [];

  next(sample: RawSample, now: number): MonitorStats | null {
    const prev = this.prev;
    this.prev = { sample, at: now };
    if (!prev) return null;

    const seconds = (now - prev.at) / 1000;
    const totalDelta = sample.cpuTotal - prev.sample.cpuTotal;
    const idleDelta = sample.cpuIdle - prev.sample.cpuIdle;
    const cpuPercent = totalDelta > 0 ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
    this.history.push(cpuPercent);
    if (this.history.length > CPU_HISTORY_LENGTH) this.history.shift();

    const rate = (cur: number, before: number) => (seconds > 0 && cur >= before ? (cur - before) / seconds : 0);
    return {
      type: 'stats',
      hostname: sample.hostname,
      cpuPercent,
      cpuHistory: [...this.history],
      memUsedKb: Math.max(0, sample.memTotalKb - sample.memAvailableKb),
      memTotalKb: sample.memTotalKb,
      uptimeSeconds: Math.floor(sample.uptimeSeconds),
      rxBytesPerSec: rate(sample.rxBytes, prev.sample.rxBytes),
      txBytesPerSec: rate(sample.txBytes, prev.sample.txBytes),
      diskPercent: sample.diskPercent,
    };
  }
}

/** Global default (`ssh.monitor_enabled`, on unless set to 'false'), overridden by the user's own preference. */
export function isMonitoringEnabled(userId: string): boolean {
  const row = queryOne<{ ssh_prefs_json: string | null }>('SELECT ssh_prefs_json FROM users WHERE id = ?', [userId]);
  if (row?.ssh_prefs_json) {
    try {
      const prefs = JSON.parse(row.ssh_prefs_json) as { monitorEnabled?: unknown };
      if (typeof prefs.monitorEnabled === 'boolean') return prefs.monitorEnabled;
    } catch { /* fall back to the global default */ }
  }
  return getSetting('ssh.monitor_enabled') !== 'false';
}

function runOnce(ssh: SshClient): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), EXEC_TIMEOUT_MS);
    const done = (fn: () => void) => { clearTimeout(timer); fn(); };
    ssh.exec(MONITOR_COMMAND, (err, stream) => {
      if (err) { done(() => reject(err)); return; }
      let out = '';
      stream.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT_BYTES) out += d.toString('utf8'); });
      stream.stderr.on('data', () => { /* ignore: a missing df or hostname must not fail the sample */ });
      stream.on('close', () => done(() => resolve(out)));
      stream.on('error', (e: Error) => done(() => reject(e)));
    });
  });
}

/**
 * Polls the remote host over a second channel of the existing SSH connection.
 * Stops by itself when the host is not Linux or the account may not run commands.
 */
export function startMonitor(ssh: SshClient, onStats: (stats: MonitorStats) => void): () => void {
  const calc = new StatsCalculator();
  let stopped = false;
  let inFlight = false;
  let failures = 0;

  const stop = () => { stopped = true; clearInterval(interval); };

  const poll = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const sample = parseSample(await runOnce(ssh));
      if (stopped) return;
      if (!sample) throw new Error('unsupported');
      failures = 0;
      const stats = calc.next(sample, Date.now());
      if (stats) onStats(stats);
    } catch {
      if (++failures >= MAX_FAILURES) stop();
    } finally {
      inFlight = false;
    }
  };

  const interval = setInterval(() => { void poll(); }, MONITOR_INTERVAL_MS);
  void poll();
  return stop;
}
