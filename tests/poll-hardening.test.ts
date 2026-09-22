import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, icmpDown, icmpOk, ifRow, okReading, snmpOk, snmpTimeout, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const state = (id: string) => h.devices.getState(id);
const noSnmp = { snmpEnabled: false, snmpCredentialId: null };

describe('reachability state machine at poll level (thresholds default 3 / 2)', () => {
  it('UP, UP, timeout, UP => no DOWN and no incident-worthy state', async () => {
    const dev = await h.newDevice({ name: 'rs-transient', ...noSnmp });
    const seq = [icmpOk(), icmpOk(), icmpDown(), icmpOk()];
    const seen: string[] = [];
    for (const r of seq) {
      h.icmp.result = r;
      await h.polls.poll(dev.id);
      seen.push((await state(dev.id)).reachability.state);
    }
    expect(seen).toEqual(['UP', 'UP', 'DEGRADED', 'UP']);
  });

  it('UP, timeout, timeout, timeout => DOWN (exactly at the third consecutive failure)', async () => {
    const dev = await h.newDevice({ name: 'rs-down', ...noSnmp });
    const seen: string[] = [];
    for (const r of [icmpOk(), icmpDown(), icmpDown(), icmpDown()]) {
      h.icmp.result = r;
      await h.polls.poll(dev.id);
      seen.push((await state(dev.id)).reachability.state);
    }
    expect(seen).toEqual(['UP', 'DEGRADED', 'DEGRADED', 'DOWN']);
  });

  it('recovery needs the configured number of consecutive successes', async () => {
    const dev = await h.newDevice({ name: 'rs-recover', ...noSnmp, polling: { failureThreshold: 2, recoveryThreshold: 3, timeoutMs: 1000, retryCount: 0 } });
    const seen: string[] = [];
    for (const r of [icmpDown(), icmpDown(), icmpOk(), icmpOk(), icmpDown(), icmpOk(), icmpOk(), icmpOk()]) {
      h.icmp.result = r;
      await h.polls.poll(dev.id);
      seen.push((await state(dev.id)).reachability.state);
    }
    // 2 failures -> DOWN; 2 successes -> RECOVERING; a failure -> back to DOWN; 3 successes -> UP
    expect(seen).toEqual(['DEGRADED', 'DOWN', 'RECOVERING', 'RECOVERING', 'DOWN', 'RECOVERING', 'RECOVERING', 'UP']);
  });
});

describe('SNMP availability is a separate state machine with its own thresholds', () => {
  it('ICMP UP + SNMP DOWN is a valid state: metrics are null, the device is NOT marked down', async () => {
    const dev = await h.newDevice({ name: 'sn-split' });
    h.icmp.result = icmpOk();
    h.snmp.result = snmpTimeout();
    for (let i = 0; i < 10; i++) await h.polls.poll(dev.id);
    const s = await state(dev.id);
    expect(s.reachability.state).toBe('UP');
    expect(s.snmp.state).toBe('DOWN');

    const latest = Object.fromEntries((await h.metrics.latestDeviceMetrics(dev.id)).map((m) => [m.metric, m]));
    for (const k of ['cpu_pct', 'memory_pct', 'snmp_interface_count', 'sys_uptime_seconds']) {
      expect(latest[k], k).toMatchObject({ value: null, status: 'unavailable' });
    }
    expect(latest.icmp_latency_ms).toMatchObject({ status: 'ok' });
    // and no fabricated interface data
    expect((await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length).toBe(0);
  });

  it('snmpFailureThreshold / snmpRecoveryThreshold are independent of the reachability thresholds', async () => {
    const dev = await h.newDevice({
      name: 'sn-thresholds',
      polling: { failureThreshold: 5, recoveryThreshold: 5, snmpFailureThreshold: 2, snmpRecoveryThreshold: 3, timeoutMs: 1000, retryCount: 0 },
    });
    expect(dev.polling).toMatchObject({ failureThreshold: 5, snmpFailureThreshold: 2, snmpRecoveryThreshold: 3 });

    h.icmp.result = icmpOk();
    h.snmp.result = snmpOk();
    await h.polls.poll(dev.id);
    h.snmp.result = snmpTimeout();
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      await h.polls.poll(dev.id);
      seen.push((await state(dev.id)).snmp.state);
    }
    expect(seen).toEqual(['DEGRADED', 'DOWN']); // 2 failures, not 5

    h.snmp.result = snmpOk();
    const rec: string[] = [];
    for (let i = 0; i < 3; i++) {
      await h.polls.poll(dev.id);
      rec.push((await state(dev.id)).snmp.state);
    }
    expect(rec).toEqual(['RECOVERING', 'RECOVERING', 'UP']); // 3 successes, not 5
    expect((await state(dev.id)).reachability.state).toBe('UP');
  });

  it('thresholds are configurable through the API surface and default to 3 / 2 for both machines', async () => {
    const dev = await h.newDevice({ name: 'sn-defaults', polling: {} });
    expect(dev.polling).toMatchObject({ failureThreshold: 3, recoveryThreshold: 2, snmpFailureThreshold: 3, snmpRecoveryThreshold: 2 });
    const updated = await h.devices.update(dev.id, { polling: { snmpFailureThreshold: 4 } });
    expect(updated.polling).toMatchObject({ snmpFailureThreshold: 4, failureThreshold: 3 });
  });
});

describe('retry behaviour', () => {
  it('ICMP: a burst with zero replies is retried up to retryCount times', async () => {
    const dev = await h.newDevice({ name: 'retry-icmp', ...noSnmp, polling: { retryCount: 2, timeoutMs: 1000 } });
    const before = h.icmp.calls;
    h.icmp.queue = [icmpDown(), icmpDown(), icmpOk(7)];
    const r = await h.polls.poll(dev.id);
    expect(h.icmp.calls - before).toBe(3);
    expect(r.icmp).toMatchObject({ status: 'ok', attempts: 3 });
    expect(r.reachable).toBe(true);
  });

  it('ICMP: gives up after retryCount extra attempts and reports the real failure', async () => {
    const dev = await h.newDevice({ name: 'retry-icmp-fail', ...noSnmp, polling: { retryCount: 1, timeoutMs: 1000 } });
    const before = h.icmp.calls;
    h.icmp.result = icmpDown();
    const r = await h.polls.poll(dev.id);
    expect(h.icmp.calls - before).toBe(2); // 1 + retryCount
    expect(r.icmp).toMatchObject({ status: 'unavailable', attempts: 2, packetLossPct: 100 });
  });

  it('ICMP: a burst with SOME replies is a real measurement and is not retried', async () => {
    const dev = await h.newDevice({ name: 'retry-partial', ...noSnmp, polling: { retryCount: 3, timeoutMs: 1000 } });
    const before = h.icmp.calls;
    h.icmp.result = icmpOk(5, 33.3);
    const r = await h.polls.poll(dev.id);
    expect(h.icmp.calls - before).toBe(1);
    expect(r.icmp?.attempts).toBe(1);
    const [loss] = await h.metrics.queryDeviceMetrics({ deviceId: dev.id, metric: 'icmp_packet_loss_pct' });
    expect(loss).toMatchObject({ value: 33.3, status: 'ok' });
  });

  it('SNMP: the device timeout and retry settings are handed to the collector', async () => {
    const dev = await h.newDevice({ name: 'retry-snmp', polling: { retryCount: 2, timeoutMs: 1500 } });
    await h.polls.poll(dev.id);
    expect(h.snmp.lastOptions).toMatchObject({ timeoutMs: 1500, retries: 2 });
    expect(h.snmp.lastOptions?.signal).toBeUndefined(); // direct polls are not abortable; scheduled ones are (next test)
  });
});

describe('cancellation and diagnostics', () => {
  it('an aborted poll persists NOTHING: no state change, no metrics, no incidents', async () => {
    const dev = await h.newDevice({ name: 'aborted' });
    const gate = new Promise<void>(() => undefined); // never opens
    h.icmp.gate = gate;
    const ac = new AbortController();
    const pending = h.polls.poll(dev.id, ac.signal);
    setTimeout(() => ac.abort(), 30);
    await expect(pending).rejects.toThrow(/aborted/);
    h.icmp.gate = null;

    const s = await state(dev.id);
    expect(s.lastPollAt).toBeNull();
    expect(s.reachability.state).toBe('UNKNOWN');
    expect((await h.metrics.queryDeviceMetrics({ deviceId: dev.id })).length).toBe(0);
  });

  it('the abort signal reaches the SNMP collector when the poll is run by the scheduler', async () => {
    const dev = await h.newDevice({ name: 'signal-through' });
    const ac = new AbortController();
    await h.polls.poll(dev.id, ac.signal);
    expect(h.snmp.lastOptions?.signal).toBe(ac.signal);
  });

  it('every poll stores REAL diagnostics: collection time, SNMP retransmits and per-step timings', async () => {
    const dev = await h.newDevice({ name: 'diag' });
    h.icmp.result = icmpOk();
    h.snmp.result = snmpOk({ retransmits: 2, timings: { systemMs: 3010, cpuMs: 14, memoryMs: 9, interfacesMs: 61 } });
    const r = await h.polls.poll(dev.id);
    expect(r.snmp).toMatchObject({ retransmits: 2, timeouts: 0, timings: { systemMs: 3010, cpuMs: 14, memoryMs: 9, interfacesMs: 61 } });

    const latest = await h.metrics.latestDeviceMetrics(dev.id);
    const get = (metric: string, dim: string | null = null) => latest.find((m) => m.metric === metric && m.dimension === dim);
    expect(get('snmp_retransmits')).toMatchObject({ value: 2, status: 'ok' });
    expect(get('poll_collect_ms')?.status).toBe('ok');
    expect(get('snmp_step_ms', 'system')?.value).toBe(3010);
    expect(get('snmp_step_ms', 'interfaces')?.value).toBe(61);
  });

  it('steps that never ran (SNMP timed out early) have no timing sample instead of a made-up 0', async () => {
    const dev = await h.newDevice({ name: 'diag-timeout' });
    h.snmp.result = snmpTimeout();
    await h.polls.poll(dev.id);
    const steps = (await h.metrics.queryDeviceMetrics({ deviceId: dev.id, metric: 'snmp_step_ms' })).map((m) => m.dimension);
    expect(steps).toEqual(['system']); // only the step that actually ran
  });
});

describe('dynamic interfaces (lifecycle, never destroyed)', () => {
  const walk = (rows: Array<Parameters<typeof ifRow>>) => snmpOk({ interfaces: { status: 'ok', error: null, rows: rows.map((r) => ifRow(...r)) } });

  it('disappearing = INACTIVE, history kept; reappearing = same record ACTIVE again, counters restart (no rate across the gap)', async () => {
    const dev = await h.newDevice({ name: 'dyn' });
    const l2tp = (in_: bigint): Parameters<typeof ifRow> => [15910937, { name: '<l2tp-cctv>', typeNum: 131, typeName: 'tunnel', inOctets: in_, outOctets: in_, speedBps: null }];

    h.snmp.result = walk([[1, { inOctets: 0n, outOctets: 0n }], l2tp(1_000n)]);
    await h.pollAndAdvance(dev.id, 10);
    h.snmp.result = walk([[1, { inOctets: 10n, outOctets: 10n }], l2tp(1_251_000n)]);
    await h.pollAndAdvance(dev.id, 10);

    const idOf = async () => (await h.db.query<{ id: string; active: boolean; inactive_since: Date | null }>('select id, active, inactive_since from interfaces where device_id = $1 and if_index = 15910937', [dev.id])).rows[0]!;
    const first = await idOf();
    expect(first.active).toBe(true);
    const before = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: first.id, order: 'asc' });
    expect(before).toHaveLength(2);
    expect(before[1]!.inBps).toBeCloseTo(1_000_000); // (1,251,000 - 1,000) * 8 / 10

    // the tunnel goes away
    h.snmp.result = walk([[1, { inOctets: 20n, outOctets: 20n }]]);
    await h.pollAndAdvance(dev.id, 10);
    const gone = await idOf();
    expect(gone).toMatchObject({ id: first.id, active: false });
    expect(gone.inactive_since).not.toBeNull();
    expect(await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: first.id })).toHaveLength(2); // history intact
    expect((await h.devices.getState(dev.id)).reachability.state).toBe('UP'); // not a device failure
    expect((await h.devices.getState(dev.id)).snmp.state).toBe('UP');

    // several polls later it comes back with restarted counters
    for (let i = 0; i < 3; i++) {
      h.snmp.result = walk([[1, { inOctets: 30n, outOctets: 30n }]]);
      await h.pollAndAdvance(dev.id, 10);
    }
    h.snmp.result = walk([[1, { inOctets: 40n, outOctets: 40n }], l2tp(500n)]);
    await h.pollAndAdvance(dev.id, 10);

    const back = await idOf();
    expect(back).toMatchObject({ id: first.id, active: true, inactive_since: null }); // SAME record reactivated
    const after = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: first.id, order: 'asc' });
    expect(after).toHaveLength(3);
    expect(after[2]).toMatchObject({ inBps: null, rateNote: 'first_sample' }); // no rate across the outage
  });

  it('the interface API can list only active interfaces; inactive ones are marked, not hidden by default', async () => {
    const dev = await h.newDevice({ name: 'dyn-api' });
    h.snmp.result = walk([[1, {}], [2, {}]]);
    await h.pollAndAdvance(dev.id);
    h.snmp.result = walk([[1, {}]]);
    await h.pollAndAdvance(dev.id);
    const all = await h.db.query<{ if_index: number; active: boolean }>('select if_index, active from interfaces where device_id = $1 order by if_index', [dev.id]);
    expect(all.rows.map((r) => [Number(r.if_index), r.active])).toEqual([[1, true], [2, false]]);
  });

  it('an interface table failure does NOT mark interfaces inactive (only a complete walk can)', async () => {
    const dev = await h.newDevice({ name: 'dyn-partial' });
    h.snmp.result = walk([[1, {}], [2, {}]]);
    await h.pollAndAdvance(dev.id);
    h.snmp.result = snmpOk({ interfaces: { status: 'unavailable', error: 'timeout', rows: [] } });
    await h.pollAndAdvance(dev.id);
    h.snmp.result = snmpTimeout();
    await h.pollAndAdvance(dev.id);
    const rows = await h.db.query<{ active: boolean }>('select active from interfaces where device_id = $1', [dev.id]);
    expect(rows.rows.every((r) => r.active)).toBe(true);
  });
});

describe('traffic (per-interface only)', () => {
  it('32-bit counter fallback: a wrap yields a valid rate flagged counter_wrap; 64-bit decrease is a reset', async () => {
    const dev = await h.newDevice({ name: 'c32' });
    const rows = (a: bigint, bits: 32 | 64) => snmpOk({ interfaces: { status: 'ok', error: null, rows: [ifRow(1, { inOctets: a, outOctets: a, counterBits: bits, speedBps: 100_000_000 })] } });
    h.snmp.result = rows(4_293_967_296n, 32); // 1,000,000 below the 32-bit limit
    await h.pollAndAdvance(dev.id, 30);
    h.snmp.result = rows(1_000_000n, 32); // wrapped: 2,000,000 octets in 30 s
    await h.pollAndAdvance(dev.id, 30);
    const [iface] = (await h.db.query<{ id: string }>('select id from interfaces where device_id = $1', [dev.id])).rows;
    let samples = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: iface!.id, order: 'asc' });
    expect(samples[1]).toMatchObject({ rateNote: 'counter_wrap', counterBits: 32 });
    expect(samples[1]!.inBps).toBeCloseTo((2_000_000 * 8) / 30);

    // now the device starts reporting 64-bit counters: sources differ, so no rate for that interval
    h.snmp.result = rows(9_000_000n, 64);
    await h.pollAndAdvance(dev.id, 30);
    samples = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: iface!.id, order: 'asc' });
    expect(samples[2]).toMatchObject({ rateNote: 'counter_source_changed', inBps: null });

    // 64-bit decrease = reset
    h.snmp.result = rows(100n, 64);
    await h.pollAndAdvance(dev.id, 30);
    samples = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: iface!.id, order: 'asc' });
    expect(samples[3]).toMatchObject({ rateNote: 'counter_reset', inBps: null });
  });

  it('there is NO router-wide bandwidth metric: no aggregate is stored anywhere', async () => {
    const r = await h.db.query<{ metric: string }>(`select distinct metric from device_metric_samples`);
    const names = r.rows.map((x) => x.metric);
    expect(names.filter((n) => /bandwidth|total|aggregate|sum/i.test(n))).toEqual([]);
    // traffic exists only on interface_samples, per interface
    const perIf = await h.db.query<{ n: string }>(`select count(distinct interface_id)::text n from interface_samples`);
    expect(Number(perIf.rows[0]!.n)).toBeGreaterThan(0);
  });
});
