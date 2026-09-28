import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, icmpDown, icmpOk, ifRow, snmpOk, snmpTimeout, okReading, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const stateOf = async (id: string) => h.devices.getState(id);

describe('poll pipeline (real data only)', () => {
  it('records real metrics, real device identity and marks a healthy device UP', async () => {
    const dev = await h.newDevice({ name: 'healthy' });
    h.icmp.result = icmpOk(4.2);
    h.snmp.result = snmpOk({ cpu: okReading(33.5), memory: okReading(61) });

    const report = await h.polls.poll(dev.id);

    expect(report.reachable).toBe(true);
    expect(report.state).toEqual({ reachability: 'UP', snmp: 'UP' });

    const latest = Object.fromEntries((await h.metrics.latestDeviceMetrics(dev.id)).map((m) => [m.metric, m]));
    expect(latest.icmp_latency_ms).toMatchObject({ value: 4.2, status: 'ok', error: null });
    expect(latest.icmp_packet_loss_pct).toMatchObject({ value: 0, status: 'ok' });
    expect(latest.cpu_pct).toMatchObject({ value: 33.5, status: 'ok' });
    expect(latest.memory_pct).toMatchObject({ value: 61, status: 'ok' });
    expect(latest.sys_uptime_seconds).toMatchObject({ value: 5000, status: 'ok' }); // 500000 ticks / 100
    expect(latest.snmp_response_ms).toMatchObject({ value: 6, status: 'ok' });

    // identity comes from the device, not from placeholders
    const after = await h.devices.get(dev.id);
    expect(after).toMatchObject({ sysName: 'core-rtr', sysDescr: 'RouterOS CCR2116', snmpProfile: 'standard' });
    expect(after.infoUpdatedAt).not.toBeNull();
  });

  it('a device that reports nothing has NULL identity (no placeholders)', async () => {
    const dev = await h.newDevice({ name: 'never-polled' });
    expect(dev).toMatchObject({ sysName: null, sysDescr: null, sysObjectId: null, snmpProfile: null, infoUpdatedAt: null });
  });

  it('SNMP timeout with a reachable device: unavailable metrics (null + real error), device stays reachable', async () => {
    const dev = await h.newDevice({ name: 'snmp-dead' });
    h.icmp.result = icmpOk();
    h.snmp.result = snmpTimeout();

    const report = await h.polls.poll(dev.id);
    expect(report.reachable).toBe(true); // ICMP answers
    expect(report.state.reachability).toBe('UP');
    expect(report.state.snmp).toBe('DEGRADED'); // SNMP has its own state machine

    const latest = Object.fromEntries((await h.metrics.latestDeviceMetrics(dev.id)).map((m) => [m.metric, m]));
    for (const metric of ['cpu_pct', 'memory_pct', 'snmp_response_ms', 'sys_uptime_seconds', 'snmp_interface_count']) {
      expect(latest[metric], metric).toMatchObject({ value: null, status: 'unavailable' });
      expect(latest[metric]!.error).toMatch(/timed out/i);
    }
    expect(latest.icmp_latency_ms).toMatchObject({ status: 'ok' }); // ICMP data is still real
  });

  it('ICMP failure: 100% loss is real, latency is unavailable (not zero, not invented)', async () => {
    const dev = await h.newDevice({ name: 'icmp-dead', snmpEnabled: false, snmpAuth: null });
    h.icmp.result = icmpDown();
    await h.polls.poll(dev.id);
    const latest = Object.fromEntries((await h.metrics.latestDeviceMetrics(dev.id)).map((m) => [m.metric, m]));
    expect(latest.icmp_packet_loss_pct).toMatchObject({ value: 100, status: 'ok' });
    expect(latest.icmp_latency_ms).toMatchObject({ value: null, status: 'unavailable' });
  });

  it('INVARIANT: a sample carries a value only if its status is ok', async () => {
    const r = await h.db.query<{ n: string }>(
      `select count(*)::text n from device_metric_samples where (status <> 'ok' and value is not null) or (status = 'ok' and value is null)`,
    );
    expect(r.rows[0]!.n).toBe('0');
    const r2 = await h.db.query<{ n: string }>(
      `select count(*)::text n from interface_samples where status <> 'ok' and (in_bps is not null or out_bps is not null)`,
    );
    expect(r2.rows[0]!.n).toBe('0');
  });

  it('a single failed poll does NOT take a device DOWN; three consecutive do; two successes recover it', async () => {
    const dev = await h.newDevice({ name: 'flappy', snmpEnabled: false, snmpAuth: null });
    h.icmp.result = icmpOk();
    await h.polls.poll(dev.id);
    expect((await stateOf(dev.id)).reachability.state).toBe('UP');

    h.icmp.result = icmpDown();
    await h.polls.poll(dev.id);
    expect((await stateOf(dev.id)).reachability.state).toBe('DEGRADED');
    await h.polls.poll(dev.id);
    expect((await stateOf(dev.id)).reachability.state).toBe('DEGRADED');
    const third = await h.polls.poll(dev.id);
    expect((await stateOf(dev.id)).reachability.state).toBe('DOWN');
    expect(third.transitions).toEqual([{ kind: 'reachability', from: 'DEGRADED', to: 'DOWN', reason: 'failure_threshold_reached' }]);

    h.icmp.result = icmpOk();
    await h.polls.poll(dev.id);
    expect((await stateOf(dev.id)).reachability.state).toBe('RECOVERING');
    await h.polls.poll(dev.id);
    expect((await stateOf(dev.id)).reachability.state).toBe('UP');

    const status = await h.devices.status(dev.id);
    expect(status.stateHistory.map((x) => `${x.from}>${x.to}`).reverse()).toEqual([
      'UNKNOWN>UP', 'UP>DEGRADED', 'DEGRADED>DOWN', 'DOWN>RECOVERING', 'RECOVERING>UP',
    ]);
  });

  it('the SNMP state machine is independent from reachability', async () => {
    const dev = await h.newDevice({ name: 'split-brain' });
    h.icmp.result = icmpOk();
    h.snmp.result = snmpTimeout();
    for (let i = 0; i < 3; i++) await h.polls.poll(dev.id);
    const s = await stateOf(dev.id);
    expect(s.reachability.state).toBe('UP'); // still pingable
    expect(s.snmp.state).toBe('DOWN'); // agent silent for 3 polls
  });

  it('records the poll error text for operators', async () => {
    const dev = await h.newDevice({ name: 'err-text', snmpEnabled: false, snmpAuth: null });
    h.icmp.result = icmpDown();
    await h.polls.poll(dev.id);
    expect((await stateOf(dev.id)).lastError).toMatch(/icmp: No echo reply/);
  });

  it('tcp-only device: open/closed ports count as alive, timeouts as unavailable', async () => {
    const dev = await h.newDevice({ name: 'tcp-only', icmpEnabled: false, snmpEnabled: false, snmpAuth: null, tcpPorts: [22, 443] });
    h.tcp.result = (port) =>
      port === 22
        ? { port, status: 'open', latencyMs: 3.1, error: null }
        : { port, status: 'timeout', latencyMs: null, error: 'Connection timed out' };
    const r = await h.polls.poll(dev.id);
    expect(r.reachable).toBe(true);
    const m = await h.metrics.queryDeviceMetrics({ deviceId: dev.id, metric: 'tcp_port_open' });
    const by = Object.fromEntries(m.map((x) => [x.dimension, x]));
    expect(by['22']).toMatchObject({ value: 1, status: 'ok' });
    expect(by['443']).toMatchObject({ value: null, status: 'unavailable' });
  });

  it('a refused TCP connection proves the host is alive, but the port closed (value 0)', async () => {
    const dev = await h.newDevice({ name: 'refused', icmpEnabled: false, snmpEnabled: false, snmpAuth: null, tcpPorts: [8080] });
    h.tcp.result = (port) => ({ port, status: 'closed', latencyMs: 1, error: 'Connection refused' });
    const r = await h.polls.poll(dev.id);
    expect(r.reachable).toBe(true);
    const [m] = await h.metrics.queryDeviceMetrics({ deviceId: dev.id, metric: 'tcp_port_open' });
    expect(m).toMatchObject({ value: 0, status: 'ok' });
  });

  it('SNMP evidence alone can prove reachability when ICMP is filtered', async () => {
    const dev = await h.newDevice({ name: 'icmp-filtered' });
    h.icmp.result = icmpDown();
    h.snmp.result = snmpOk();
    const r = await h.polls.poll(dev.id);
    expect(r.reachable).toBe(true);
  });
});

describe('interface traffic', () => {
  it('first sample has NO rate, later samples derive real rates per interface (never a router-wide sum)', async () => {
    const dev = await h.newDevice({ name: 'traffic' });
    h.icmp.result = icmpOk();

    // poll 1: counters at 0 -> no previous sample
    h.snmp.result = snmpOk({
      interfaces: { status: 'ok', error: null, rows: [ifRow(1, { inOctets: 0n, outOctets: 0n }), ifRow(2, { inOctets: 1_000n, outOctets: 1_000n })] },
    });
    await h.pollAndAdvance(dev.id, 10);

    // poll 2 (10 s later): ether1 +1.25 MB in / +2.5 MB out ; ether2 idle
    h.snmp.result = snmpOk({
      system: { sysName: 'core-rtr', sysDescr: 'x', sysObjectId: null, uptimeTicks: 501_000 },
      interfaces: {
        status: 'ok', error: null,
        rows: [ifRow(1, { inOctets: 1_250_000n, outOctets: 2_500_000n }), ifRow(2, { inOctets: 1_000n, outOctets: 1_000n })],
      },
    });
    await h.pollAndAdvance(dev.id, 10);

    const ifs = await h.db.query<{ id: string; name: string }>('select id, name from interfaces where device_id = $1 order by if_index', [dev.id]);
    expect(ifs.rowCount).toBe(2);
    const s1 = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: ifs.rows[0]!.id, order: 'asc' });
    const s2 = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: ifs.rows[1]!.id, order: 'asc' });

    expect(s1).toHaveLength(2);
    expect(s1[0]).toMatchObject({ inBps: null, outBps: null, rateNote: 'first_sample', inOctets: 0n });
    expect(s1[1]!.inBps).toBeCloseTo(1_000_000);
    expect(s1[1]!.outBps).toBeCloseTo(2_000_000);
    expect(s1[1]).toMatchObject({ rateNote: null, counterBits: 64, inOctets: 1_250_000n, outOctets: 2_500_000n });
    expect(s2[1]).toMatchObject({ inBps: 0, outBps: 0 }); // idle interface is a real 0, not null
  });

  it('device reboot (sysUpTime went backwards) produces no rate, then rates resume', async () => {
    const dev = await h.newDevice({ name: 'reboot' });
    const withUptime = (ticks: number, inO: bigint) =>
      snmpOk({
        system: { sysName: 'r', sysDescr: 'x', sysObjectId: null, uptimeTicks: ticks },
        interfaces: { status: 'ok', error: null, rows: [ifRow(1, { inOctets: inO, outOctets: inO })] },
      });
    h.snmp.result = withUptime(900_000, 9_000_000n);
    await h.pollAndAdvance(dev.id, 10);
    h.snmp.result = withUptime(1_000, 500n); // rebooted: counters restarted
    await h.pollAndAdvance(dev.id, 10);
    h.snmp.result = withUptime(2_000, 1_250_500n);
    await h.pollAndAdvance(dev.id, 10);

    const [iface] = (await h.db.query<{ id: string }>('select id from interfaces where device_id = $1', [dev.id])).rows;
    const s = await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: iface!.id, order: 'asc' });
    expect(s.map((x) => x.rateNote)).toEqual(['first_sample', 'device_reboot', null]);
    expect(s[1]!.inBps).toBeNull();
    expect(s[2]!.inBps).toBeCloseTo(1_000_000); // (1,250,500 - 500) * 8 / 10
  });

  it('interfaces marked monitored=false keep their inventory but store no samples', async () => {
    const dev = await h.newDevice({ name: 'partial' });
    h.snmp.result = snmpOk({ interfaces: { status: 'ok', error: null, rows: [ifRow(1), ifRow(2)] } });
    await h.pollAndAdvance(dev.id);
    const ifs = (await h.db.query<{ id: string; if_index: number }>('select id, if_index from interfaces where device_id = $1 order by if_index', [dev.id])).rows;
    await h.db.query('update interfaces set monitored = false where id = $1', [ifs[1]!.id]);
    await h.pollAndAdvance(dev.id);

    expect(await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: ifs[0]!.id })).toHaveLength(2);
    expect(await h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: ifs[1]!.id })).toHaveLength(1); // only the poll before the toggle
    const inv = await h.db.query<{ last_seen_at: Date }>('select last_seen_at from interfaces where id = $1', [ifs[1]!.id]);
    expect(inv.rowCount).toBe(1); // inventory row still refreshed
  });

  it('loopback interfaces are not monitored by default; the operator choice survives polling', async () => {
    const dev = await h.newDevice({ name: 'lo' });
    h.snmp.result = snmpOk({ interfaces: { status: 'ok', error: null, rows: [ifRow(1), ifRow(2, { name: 'lo', typeNum: 24, typeName: 'softwareLoopback' })] } });
    await h.pollAndAdvance(dev.id);
    const rows = (await h.db.query<{ name: string; monitored: boolean }>('select name, monitored from interfaces where device_id = $1 order by if_index', [dev.id])).rows;
    expect(rows).toEqual([{ name: 'ether1', monitored: true }, { name: 'lo', monitored: false }]);
  });

  it('interface table failure is recorded honestly and existing counters are untouched', async () => {
    const dev = await h.newDevice({ name: 'if-broken' });
    h.snmp.result = snmpOk({ interfaces: { status: 'ok', error: null, rows: [ifRow(1, { inOctets: 100n, outOctets: 100n })] } });
    await h.pollAndAdvance(dev.id);
    h.snmp.result = snmpOk({ interfaces: { status: 'error', error: 'IF-MIB rows were present but could not be parsed', rows: [] } });
    await h.pollAndAdvance(dev.id);
    const count = await h.metrics.queryDeviceMetrics({ deviceId: dev.id, metric: 'snmp_interface_count', order: 'asc' });
    expect(count.map((c) => c.status)).toEqual(['ok', 'error']);
    expect(count[1]).toMatchObject({ value: null });
    expect(count[1]!.error).toMatch(/could not be parsed/);
  });
});

describe('device configuration rules', () => {
  it('refuses SNMP monitoring without SNMP auth', async () => {
    await expect(h.newDevice({ name: 'x', snmpAuth: null })).rejects.toThrow(/snmpAuth/);
  });

  it('refuses a device with nothing to check', async () => {
    await expect(h.newDevice({ name: 'x', icmpEnabled: false, snmpEnabled: false, snmpAuth: null, tcpPorts: [] })).rejects.toThrow(/at least one check/i);
  });

  it('per-device intervals reach the scheduler', async () => {
    const a = await h.newDevice({ name: 'sched-a', polling: { pollIntervalSec: 15 } });
    const b = await h.newDevice({ name: 'sched-b', polling: { pollIntervalSec: 60 } });
    const off = await h.newDevice({ name: 'sched-off', enabled: false });
    const sched = await h.devices.schedule();
    expect(sched.find((s) => s.deviceId === a.id)?.intervalSec).toBe(15);
    expect(sched.find((s) => s.deviceId === b.id)?.intervalSec).toBe(60);
    expect(sched.find((s) => s.deviceId === off.id)).toBeUndefined();
  });

  it('the SNMP credential reaches the collector decrypted, and never appears in poll output', async () => {
    const dev = await h.newDevice({ name: 'secret-check' });
    const report = await h.polls.poll(dev.id);
    expect(h.snmp.lastTarget?.auth).toEqual({ version: 'v2c', community: 'public-secret-123' });
    expect(JSON.stringify(report)).not.toContain('public-secret-123');
  });
});
