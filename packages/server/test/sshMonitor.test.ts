import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-ssh-monitor-test-'));
process.env.JWT_SECRET = 'ssh-monitor-test-secret';

const { parseSample, StatsCalculator, CPU_HISTORY_LENGTH, startMonitor, MONITOR_INTERVAL_MS } = await import('../src/ws/sshMonitor.js');
const ssh2 = (await import('ssh2')).default;
const SshServer = ssh2.Server;
const SshClient = ssh2.Client;
type MonitorStats = import('../src/ws/sshMonitor.js').MonitorStats;

function output(opts: { cpu?: string; rx?: number; tx?: number; mem?: string } = {}): string {
  return [
    opts.cpu ?? 'cpu  100 0 100 800 0 0 0 0 0 0',
    '===mem',
    opts.mem ?? 'MemTotal:       16384000 kB\nMemAvailable:    8192000 kB',
    '===up',
    '90061.52',
    '===net',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 999999    10    0    0    0     0          0         0   999999    10    0    0    0     0       0          0',
    `  eth0: ${opts.rx ?? 1000}    10    0    0    0     0          0         0   ${opts.tx ?? 500}    10    0    0    0     0       0          0`,
    '===host',
    'ubu-srv1',
    '===disk',
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/sda1         50000000 17500000  32500000      35% /',
  ].join('\n');
}

describe('parseSample', () => {
  it('parses a Linux sample and ignores the loopback interface', () => {
    const s = parseSample(output())!;
    assert.equal(s.cpuTotal, 1000);
    assert.equal(s.cpuIdle, 800);
    assert.equal(s.memTotalKb, 16384000);
    assert.equal(s.memAvailableKb, 8192000);
    assert.equal(s.uptimeSeconds, 90061.52);
    assert.equal(s.rxBytes, 1000);
    assert.equal(s.txBytes, 500);
    assert.equal(s.hostname, 'ubu-srv1');
    assert.equal(s.diskPercent, 35);
  });

  it('returns null when the host is not Linux or the command failed', () => {
    assert.equal(parseSample(''), null);
    assert.equal(parseSample('head: cannot open /proc/stat\n===mem\n===up\n===net\n'), null);
  });

  it('returns null without memory info', () => {
    assert.equal(parseSample(output({ mem: '' })), null);
  });

  it('ignores text printed by shell startup files before the output', () => {
    assert.equal(parseSample(`Welcome back!\n${output()}`)!.cpuTotal, 1000);
  });
});

describe('StatsCalculator', () => {
  it('needs two samples and then computes CPU, memory and rates', () => {
    const calc = new StatsCalculator();
    assert.equal(calc.next(parseSample(output())!, 0), null);
    const stats = calc.next(parseSample(output({ cpu: 'cpu  150 0 150 900 0 0 0 0 0 0', rx: 3000, tx: 1500 }))!, 2000)!;
    assert.equal(stats.cpuPercent, 50); // 100 busy of 200 ticks
    assert.deepEqual(stats.cpuHistory, [50]);
    assert.equal(stats.memUsedKb, 8192000);
    assert.equal(stats.rxBytesPerSec, 1000);
    assert.equal(stats.txBytesPerSec, 500);
    assert.equal(stats.uptimeSeconds, 90061);
  });

  it('reports 0 for counters that went backwards', () => {
    const calc = new StatsCalculator();
    calc.next(parseSample(output({ rx: 5000, tx: 5000 }))!, 0);
    const stats = calc.next(parseSample(output({ rx: 10, tx: 10 }))!, 2000)!;
    assert.equal(stats.rxBytesPerSec, 0);
    assert.equal(stats.txBytesPerSec, 0);
  });

  it('keeps only the last two minutes of CPU history', () => {
    const calc = new StatsCalculator();
    let last = null;
    for (let i = 0; i < CPU_HISTORY_LENGTH + 10; i++) {
      last = calc.next(parseSample(output({ cpu: `cpu  ${i * 10} 0 0 ${i * 10} 0 0 0 0 0 0` }))!, i * 2000);
    }
    assert.equal(last!.cpuHistory.length, CPU_HISTORY_LENGTH);
  });
});

describe('startMonitor over a real SSH connection', () => {
  async function withServer(reply: (cmd: string, n: number) => string, run: (client: InstanceType<typeof SshClient>, execs: () => number) => Promise<void>) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
    let execCount = 0;
    const server = new SshServer({ hostKeys: [privateKey] }, (conn) => {
      conn.on('authentication', (ctx) => ctx.accept());
      conn.on('ready', () => {
        conn.on('session', (accept) => {
          accept().on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec();
            stream.write(reply(info.command, ++execCount));
            stream.exit(0);
            stream.end();
          });
        });
      });
      conn.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const client = new SshClient();
    await new Promise<void>((resolve, reject) => {
      client.on('ready', resolve).on('error', reject).connect({ host: '127.0.0.1', port, username: 'u', password: 'p' });
    });
    try { await run(client, () => execCount); } finally { client.end(); server.close(); }
  }

  it('delivers stats from the second sample on, with the expected command', async () => {
    const commands: string[] = [];
    await withServer((cmd, n) => { commands.push(cmd); return output({ rx: n * 2000, tx: n * 1000 }); }, async (client) => {
      const stats = await new Promise<MonitorStats>((resolve) => {
        const stop = startMonitor(client, (s) => { stop(); resolve(s); });
      });
      assert.equal(stats.type, 'stats');
      assert.equal(stats.hostname, 'ubu-srv1');
      assert.ok(stats.rxBytesPerSec > 0);
      assert.match(commands[0]!, /\/proc\/stat/);
    });
  });

  it('stops polling when the host is not Linux', async () => {
    await withServer(() => 'head: cannot open /proc/stat\n', async (client, execs) => {
      let got = 0;
      const stop = startMonitor(client, () => { got++; });
      await new Promise((r) => setTimeout(r, MONITOR_INTERVAL_MS * 3));
      stop();
      assert.equal(got, 0);
      assert.equal(execs(), 3);
    });
  });
});
