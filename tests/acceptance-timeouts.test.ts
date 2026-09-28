import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { SnmpCollector } from '../src/collectors/snmp/collector.js';
import type { SnmpAuth } from '../src/devices/snmp-auth.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { WorkerPool } from '../src/scheduler/worker-pool.js';
import { systemClock } from '../src/util/clock.js';
import { silentLogger } from '../src/util/logger.js';
import { createRealHarness } from './helpers/harness.js';

/**
 * ACCEPTANCE: a probe that never responds (a UDP socket that receives everything and answers nothing).
 *  1. the collector times out at the configured timeout, retries exactly as configured, and releases its socket
 *  2. as normal polls, an unresponsive device moves through the state machine on real timeouts, with NO invented values
 *  3. if a poll must be HARD-aborted: it stops at the deadline, nothing keeps running, nothing is written, the scheduler lives on
 */

const v2c: SnmpAuth = { version: 'v2c', community: 'public' };

async function blackhole() {
  const sock = dgram.createSocket('udp4');
  const at: number[] = [];
  sock.on('message', () => at.push(Date.now()));
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, count: () => at.length, close: () => new Promise<void>((r) => sock.close(() => r())) };
}
const resources = (type: string) => process.getActiveResourcesInfo().filter((r) => r === type).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('1. collector: timeout, retries and cleanup against a device that never answers', () => {
  it('times out at timeoutMs x (retries + 1), retransmits exactly `retries` times, then releases its socket', async () => {
    const hole = await blackhole();
    closers.push(hole.close);
    const udpBefore = resources('UDPWrap'); // includes the black hole's own socket

    const t0 = Date.now();
    const r = await new SnmpCollector().poll({ host: '127.0.0.1', port: hole.port, auth: v2c }, { timeoutMs: 300, retries: 2 });
    const elapsed = Date.now() - t0;

    expect(r.status).toBe('unavailable');
    expect(r.error).toMatch(/timed out/i);
    expect(elapsed).toBeGreaterThanOrEqual(850); // 3 attempts x 300 ms: it really waited the configured time, no shortcut
    expect(elapsed).toBeLessThan(1600);
    expect(r.retransmits).toBe(2); // retries behave as configured
    expect(r.timeouts).toBe(1);
    expect(hole.count()).toBe(3); // 1 original + 2 retransmissions actually reached the wire
    expect([r.cpu, r.memory].every((x) => x.status === 'unavailable' && x.value === null)).toBe(true);
    expect(r.timings.cpuMs).toBeNull(); // later steps were skipped, not stacked

    await sleep(80);
    expect(resources('UDPWrap')).toBe(udpBefore); // the SNMP session's UDP socket is closed
    const sent = hole.count();
    await sleep(700); // longer than the timeout: any surviving retransmit timer would fire now
    expect(hole.count()).toBe(sent);
  });

  it('retries = 0 sends exactly one request', async () => {
    const hole = await blackhole();
    closers.push(hole.close);
    const r = await new SnmpCollector().poll({ host: '127.0.0.1', port: hole.port, auth: v2c }, { timeoutMs: 250, retries: 0 });
    expect(r.retransmits).toBe(0);
    expect(hole.count()).toBe(1);
  });
});

describe('2. an unresponsive device through the whole pipeline (real timeouts, state machine, incidents)', () => {
  it('DEGRADED -> DEGRADED -> DOWN at the configured threshold; every metric is null/unavailable; one incident', async () => {
    const hole = await blackhole();
    closers.push(hole.close);
    const h = await createRealHarness();
    closers.push(() => h.close());
    // SNMP is the only check, so an unanswered SNMP request is the only evidence about reachability
    const dev = await h.newDevice(hole.port, { icmpEnabled: false, polling: { pollIntervalSec: 30, timeoutMs: 300, retryCount: 1, failureThreshold: 3, recoveryThreshold: 2, snmpFailureThreshold: 3, snmpRecoveryThreshold: 2 } });
    await h.rules.create({ name: 'Device unreachable', conditionType: 'device_down', severity: 'critical', cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [], deviceId: dev.id });

    const seen: string[] = [];
    const durations: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await h.pollAndAdvance(dev.id);
      durations.push(r.durationMs);
      seen.push((await h.devices.getState(dev.id)).reachability.state);
    }
    expect(seen).toEqual(['DEGRADED', 'DEGRADED', 'DOWN', 'DOWN', 'DOWN']);
    expect(durations.every((d) => d >= 550 && d < 1500)).toBe(true); // each poll took ~ timeout x (retry + 1) = 600 ms, no more

    expect((await h.incidents.list({ deviceId: dev.id })).total).toBe(1);
    const samples = await h.db.query<{ metric: string; value: number | null; status: string }>('select metric, value, status from device_metric_samples where device_id = $1', [dev.id]);
    const snmpMetrics = samples.rows.filter((s) => ['cpu_pct', 'memory_pct', 'snmp_interface_count', 'sys_uptime_seconds', 'snmp_response_ms'].includes(s.metric));
    expect(snmpMetrics.length).toBeGreaterThan(0);
    expect(snmpMetrics.every((s) => s.value === null && s.status === 'unavailable')).toBe(true); // nothing invented
    expect((await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length).toBe(0);
    expect((await h.devices.getState(dev.id)).lastError).toMatch(/timed out/i);
  }, 30_000);
});

describe('3. hard timeout: the poll is aborted at the deadline and nothing keeps running', () => {
  it('stops at hardTimeoutMs, cancels its SNMP retransmissions, writes nothing, frees its socket, and the scheduler carries on', async () => {
    const hole = await blackhole();
    closers.push(hole.close);
    const h = await createRealHarness();
    closers.push(() => h.close());
    // SNMP would retransmit every 200 ms, six attempts (1.2 s): longer than the 500 ms hard timeout below
    const dev = await h.newDevice(hole.port, { icmpEnabled: false, polling: { pollIntervalSec: 30, timeoutMs: 200, retryCount: 5, failureThreshold: 3, recoveryThreshold: 2 } });

    const udpBaseline = resources('UDPWrap');
    let maxLoopLag = 0;
    let lastBeat = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      maxLoopLag = Math.max(maxLoopLag, now - lastBeat - 25);
      lastBeat = now;
    }, 25);

    const scheduler = new Scheduler({
      pool: new WorkerPool(4),
      clock: systemClock,
      logger: silentLogger(),
      loadSchedule: async () => [{ deviceId: dev.id, intervalSec: 1 }],
      runPoll: (id, signal) => h.polls.runForScheduler(id, signal),
      hardTimeoutMs: 500,
      tickMs: 50,
      jitter: false,
    });
    const t0 = Date.now();
    await scheduler.start();

    // t = 0: poll #1 starts. t = 500 ms: hard timeout. t = 1000 ms: poll #2 is due.
    await sleep(700);
    expect(scheduler.stats().inFlight).toBe(0); // aborted, not still running in the background
    const afterAbort = hole.count();
    expect(afterAbort).toBeGreaterThanOrEqual(2); // it was retransmitting
    expect(afterAbort).toBeLessThanOrEqual(4);

    await sleep(250); // t ~ 950 ms: several 200 ms retransmit periods have passed since the abort, poll #2 not yet started
    expect(hole.count()).toBe(afterAbort); // the aborted poll's retransmissions really stopped

    await sleep(700); // t ~ 1650 ms: poll #2 has started, so the scheduler survived the timeout
    expect(hole.count()).toBeGreaterThan(afterAbort);

    await scheduler.stop(3000);
    clearInterval(heartbeat);

    // nothing partial and nothing fabricated reached the database
    const metricRows = await h.db.query<{ n: string }>('select count(*)::text n from device_metric_samples where device_id = $1', [dev.id]);
    expect(metricRows.rows[0]!.n).toBe('0');
    expect((await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length).toBe(0);
    const state = await h.devices.getState(dev.id);
    expect(state.lastPollAt).toBeNull(); // an aborted poll records no observation
    expect(state.reachability.state).toBe('UNKNOWN'); // ... so it does not move the state machine either (see docs)

    // the process is healthy: no leaked socket, event loop was never blocked
    await sleep(100);
    expect(resources('UDPWrap')).toBe(udpBaseline);
    expect(maxLoopLag).toBeLessThan(250);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 30_000);
});
