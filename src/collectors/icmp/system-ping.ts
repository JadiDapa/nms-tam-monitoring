import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import type { IcmpOptions, IcmpProbe, IcmpResult } from './types.js';
import { parsePingOutput, summarizeLatency } from './parse.js';

const HOSTNAME = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export function isValidTarget(host: string): boolean {
  return net.isIP(host) !== 0 || HOSTNAME.test(host);
}

function buildArgs(platform: NodeJS.Platform, ip: string, opts: IcmpOptions): string[] {
  const count = String(opts.count);
  if (platform === 'win32') return ['-n', count, '-w', String(opts.timeoutMs), ip];
  if (platform === 'darwin') return ['-n', '-c', count, '-W', String(opts.timeoutMs), ip];
  // Linux (iputils): -W is in whole seconds
  return ['-n', '-c', count, '-W', String(Math.max(1, Math.ceil(opts.timeoutMs / 1000))), ip];
}

/**
 * ICMP through the operating system's `ping` (no raw-socket privileges needed).
 * Safety: the host is validated, resolved by us, and passed as a single argv element (no shell involved),
 * so it cannot inject flags or commands.
 */
export class SystemPingProbe implements IcmpProbe {
  constructor(private readonly platform: NodeJS.Platform = os.platform()) {}

  async ping(host: string, opts: IcmpOptions): Promise<IcmpResult> {
    const started = performance.now();
    const fail = (error: string, status: 'error' | 'unavailable' = 'error', received = 0): IcmpResult => ({
      status,
      reachable: false,
      sent: opts.count,
      received,
      packetLossPct: status === 'unavailable' ? 100 : null,
      minMs: null,
      avgMs: null,
      maxMs: null,
      error,
      durationMs: Math.round(performance.now() - started),
    });

    if (!isValidTarget(host)) return fail('Invalid host');
    if (opts.signal?.aborted) return fail('Aborted');

    let ip = host;
    if (net.isIP(host) === 0) {
      try {
        ip = (await dns.lookup(host)).address;
      } catch (err) {
        return fail(`DNS resolution failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      }
    }

    const args = buildArgs(this.platform, ip, opts);
    const hardLimitMs = opts.count * (opts.timeoutMs + 1000) + 2000;

    return new Promise<IcmpResult>((resolve) => {
      let stdout = '';
      let settled = false;
      const child = spawn(this.platform === 'win32' ? 'ping.exe' : 'ping', args, { windowsHide: true });

      const finish = (result: IcmpResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(fail('Aborted'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(fail(`ping did not finish within ${hardLimitMs} ms`));
      }, hardLimitMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.on('error', (err) => finish(fail(`ping executable could not be run: ${err.message}`)));
      child.on('close', () => {
        const { received, latenciesMs } = parsePingOutput(stdout, opts.count);
        const durationMs = Math.round(performance.now() - started);
        const lossPct = Math.round(((opts.count - received) / opts.count) * 10000) / 100;
        if (received === 0) {
          finish({
            status: 'unavailable',
            reachable: false,
            sent: opts.count,
            received: 0,
            packetLossPct: 100,
            minMs: null,
            avgMs: null,
            maxMs: null,
            error: 'No echo reply (timeout or unreachable)',
            durationMs,
          });
          return;
        }
        const lat = summarizeLatency(latenciesMs);
        finish({
          status: 'ok',
          reachable: true,
          sent: opts.count,
          received,
          packetLossPct: lossPct,
          minMs: lat.min,
          avgMs: lat.avg,
          maxMs: lat.max,
          error: null,
          durationMs,
        });
      });
    });
  }
}
