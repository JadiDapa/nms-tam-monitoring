import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS, portIsOpen, processesMatching, startEngineProcess, type EngineProcess, type LogLine } from './helpers/engine-process.js';

/**
 * Graceful shutdown of the REAL engine, in its own OS process, with a REAL OS signal:
 *   Windows : Ctrl+C (SIGINT) and Ctrl+Break (SIGBREAK) delivered to the engine's console. SIGTERM does not exist on
 *             Windows: a "kill" is TerminateProcess and gives the process no chance to clean up.
 *   POSIX   : SIGINT / SIGTERM / SIGHUP via kill(2).
 * The engine under test is the production createEngine() + src/lifecycle.ts with an embedded database.
 */

/** A UDP endpoint that receives everything and answers nothing (a device that never responds), and counts datagrams. */
async function blackhole() {
  const sock = dgram.createSocket('udp4');
  const times: number[] = [];
  sock.on('message', () => times.push(Date.now()));
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  return {
    port: sock.address().port,
    count: () => times.length,
    lastAt: () => times.at(-1) ?? 0,
    close: () => new Promise<void>((r) => sock.close(() => r())),
  };
}

const procs: EngineProcess[] = [];
const holes: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const p of procs.splice(0)) p.cleanup();
  for (const h of holes.splice(0)) await h.close();
});
const start = async (env: Record<string, string> = {}) => {
  const p = await startEngineProcess(env);
  procs.push(p);
  return p;
};

const events = (l: LogLine[]) => l.map((x) => x.event);
const idx = (l: LogLine[], name: string) => l.findIndex((x) => x.event === name);
/** Resource types that are allowed to remain: the process's own stdout/stderr. Anything else is a leak. */
const STDIO = new Set(['PipeWrap', 'TTYWrap', 'FileHandle', 'FSReqCallback']);

function expectCleanShutdown(log: LogLine[], stderr: string) {
  const order = ['shutdown_requested', 'engine_stopping', 'scheduler_stopped', 'engine_stopped', 'shutdown_complete'].map((e) => idx(log, e));
  expect(order.every((i) => i >= 0), `missing lifecycle events: ${events(log).join(', ')}`).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order); // in this order
  const done = log.find((l) => l.event === 'shutdown_complete')!;
  expect(done.exitCode).toBe(0);
  // nothing fatal was logged and nothing was written to stderr
  expect(events(log).filter((e) => ['unhandled_rejection', 'uncaught_exception', 'shutdown_error', 'shutdown_forced'].includes(e!))).toEqual([]);
  expect(stderr.trim()).toBe('');
  // no resource other than stdio is still active (no timers, servers, sockets, child processes)
  const leftover = Object.keys((done.activeResources ?? {}) as Record<string, number>).filter((k) => !STDIO.has(k));
  expect(leftover, `resources still active after shutdown: ${JSON.stringify(done.activeResources)}`).toEqual([]);
}

describe('graceful shutdown of the real engine process', () => {
  it(IS_WINDOWS ? 'Ctrl+C (SIGINT): exits 0, closes HTTP, stops every worker, leaves no resources' : 'SIGINT: exits 0, closes HTTP, stops every worker, leaves no resources', async () => {
    const e = await start();
    expect((await e.api('GET', '/health')).status).toBe(200);
    expect(await portIsOpen(e.port)).toBe(true);

    const r = await e.shutdown('sigint');
    expect(r).toMatchObject({ exited: true, exitCode: 0 });
    expect(r.ms).toBeLessThan(8000);
    expect(e.isAlive()).toBe(false);
    expect(await portIsOpen(e.port)).toBe(false); // HTTP server closed
    expectCleanShutdown(e.log(), e.stderr());
    expect(e.log().find((l) => l.event === 'scheduler_stopped')).toMatchObject({ clean: true });
  }, 90_000);

  it.runIf(IS_WINDOWS)('Ctrl+Break (SIGBREAK, also console-window close): same clean shutdown', async () => {
    const e = await start();
    const r = await e.shutdown('sigbreak');
    expect(r).toMatchObject({ exited: true, exitCode: 0 });
    expect(e.log().find((l) => l.event === 'shutdown_requested')).toMatchObject({ reason: 'SIGBREAK' });
    expectCleanShutdown(e.log(), e.stderr());
  }, 90_000);

  it.skipIf(IS_WINDOWS)('SIGTERM (process managers / systemd): same clean shutdown', async () => {
    const e = await start();
    const r = await e.shutdown('sigterm');
    expect(r).toMatchObject({ exited: true, exitCode: 0 });
    expect(e.log().find((l) => l.event === 'shutdown_requested')).toMatchObject({ reason: 'SIGTERM' });
    expectCleanShutdown(e.log(), e.stderr());
  }, 90_000);

  it('POLICY 1: a running poll that finishes inside SHUTDOWN_TIMEOUT_MS is ALLOWED TO FINISH; nothing new is started', async () => {
    const hole = await blackhole();
    holes.push(hole);
    const e = await start({ SHUTDOWN_TIMEOUT_MS: '30000', LOG_LEVEL: 'debug' });
    const cred = (await e.api('POST', '/credentials', { name: 'c', type: 'snmp_v2c', secret: { community: 'public' } })).body;
    const dev = (
      await e.api('POST', '/devices', {
        name: 'slow-snmp', host: '127.0.0.1', icmpEnabled: false, snmpEnabled: true, snmpCredentialId: cred.id, snmpPort: hole.port,
        polling: { pollIntervalSec: 5, timeoutMs: 8000, retryCount: 0 },
      })
    ).body;

    // start a poll that will take ~8 s (one SNMP timeout; signal delivery on Windows itself takes 1-2 s), then shut down while it runs
    const pending = e.api('POST', `/devices/${dev.id}/poll`).catch((err) => ({ status: 0, body: String(err) }));
    const t0 = Date.now();
    while (hole.count() === 0 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
    expect(hole.count()).toBeGreaterThan(0); // the poll really is in flight

    const r = await e.shutdown('sigint');
    expect(r).toMatchObject({ exited: true, exitCode: 0 });

    const log = e.log();
    const requestedAt = idx(log, 'shutdown_requested');
    const completedPolls = log.map((l, i) => ({ l, i })).filter(({ l }) => l.event === 'poll_completed' && l.deviceId === dev.id);
    expect(completedPolls.length, 'the in-flight poll should have completed').toBeGreaterThanOrEqual(1);
    expect(completedPolls.every(({ i }) => i > requestedAt), 'the poll finished AFTER the shutdown request (it was allowed to finish)').toBe(true);
    // the scheduler waited for it, did not abort it, and started no further poll
    expect(log.find((l) => l.event === 'scheduler_stopped')).toMatchObject({ clean: true });
    expect(log.slice(requestedAt).filter((l) => l.event === 'poll_started')).toEqual([]);
    expect(events(log)).not.toContain('poll_failed');
    // the client that triggered the poll still got its answer (the HTTP server drained instead of cutting it off)
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(answered.body.snmp).toMatchObject({ status: 'unavailable' });
    expectCleanShutdown(log, e.stderr());
  }, 90_000);

  it('POLICY 2: polls still running after SHUTDOWN_TIMEOUT_MS are ABORTED: SNMP stops retransmitting, ping is killed, TCP is closed', async () => {
    const hole = await blackhole();
    holes.push(hole);
    const ICMP_HOST = '192.0.2.44'; // TEST-NET-1: never answers
    const e = await start({ SHUTDOWN_TIMEOUT_MS: '1000' });
    const cred = (await e.api('POST', '/credentials', { name: 'c', type: 'snmp_v2c', secret: { community: 'public' } })).body;
    // a) SNMP against a device that never answers; would keep retransmitting for ~18 s
    const snmpDev = (
      await e.api('POST', '/devices', {
        name: 'snmp-hang', host: '127.0.0.1', icmpEnabled: false, snmpEnabled: true, snmpCredentialId: cred.id, snmpPort: hole.port,
        polling: { pollIntervalSec: 5, timeoutMs: 3000, retryCount: 5 }, // up to 6 x 3 s = 18 s of retransmissions
      })
    ).body;
    // b) ICMP + TCP against an address that never answers; would wait 20 s per echo / connect
    const netDev = (
      await e.api('POST', '/devices', {
        name: 'icmp-tcp-hang', host: ICMP_HOST, icmpEnabled: true, tcpPorts: [22], snmpEnabled: false,
        polling: { pollIntervalSec: 5, timeoutMs: 20000, retryCount: 0, icmpCount: 5 },
      })
    ).body;
    const p1 = e.api('POST', `/devices/${snmpDev.id}/poll`).catch(() => ({ status: 0, body: null }));
    const p2 = e.api('POST', `/devices/${netDev.id}/poll`).catch(() => ({ status: 0, body: null }));

    const t0 = Date.now();
    while ((hole.count() < 1 || processesMatching(ICMP_HOST).length === 0) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    expect(hole.count(), 'the SNMP poll is in flight').toBeGreaterThanOrEqual(1);
    expect(processesMatching(ICMP_HOST).length, 'a ping process is running').toBeGreaterThan(0);

    const r = await e.shutdown('sigint');
    expect(r).toMatchObject({ exited: true, exitCode: 0 });
    expect(r.ms, 'exit must be bounded by the shutdown budget, not by the 20 s probe timeouts').toBeLessThan(10_000);
    // the clients that were waiting for those polls get a real answer (502 POLL_FAILED), not a dropped connection
    const [a1, a2] = await Promise.all([p1, p2]);
    expect([a1.status, a2.status]).toEqual([502, 502]);
    expect(a1.body.error.code).toBe('POLL_FAILED');

    const log = e.log();
    expect(log.find((l) => l.event === 'scheduler_stopped')).toMatchObject({ clean: false }); // budget exceeded -> aborted
    expect(events(log)).not.toContain('shutdown_forced'); // the graceful path completed; the safety net never fired

    // SNMP: no request is sent after the process is gone (and the retransmit timer was cancelled, not just the process killed)
    const before = hole.count();
    await new Promise((res) => setTimeout(res, 3500)); // longer than one SNMP timeout: a surviving retransmit timer would fire
    expect(hole.count()).toBe(before);
    // ICMP: the ping child process was killed, not orphaned
    expect(processesMatching(ICMP_HOST)).toEqual([]);
    // TCP / UDP sockets, timers, child processes: nothing left active
    expectCleanShutdown(log, e.stderr());
    expect(await portIsOpen(e.port)).toBe(false);
  }, 120_000);
});
