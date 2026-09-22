import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeSnmpDevice, type FakeInterface } from './helpers/fake-snmp-device.js';
import { createRealHarness, type RealHarness } from './helpers/harness.js';

/**
 * ACCEPTANCE against the REAL transport: a real SNMP agent (UDP), real ICMP to loopback, real collectors.
 * Only the clock is fake (so rates and debouncing are deterministic). Failures are produced by really stopping the agent
 * and really changing the interface tables it serves.
 */

let h: RealHarness;
beforeAll(async () => {
  h = await createRealHarness();
});

const agents: FakeSnmpDevice[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop().catch(() => undefined);
});
const agent = async (interfaces: FakeInterface[] = [], over: ConstructorParameters<typeof FakeSnmpDevice>[0] = {}) => {
  const a = await new FakeSnmpDevice({ community: 'public', cpuLoads: [20, 40], memory: [{ descr: 'main memory', type: '1.3.6.1.2.1.25.2.1.2', size: 1000, used: 250 }], interfaces, ...over }).start();
  agents.push(a);
  return a;
};
const incidents = async (deviceId: string, status?: 'ACTIVE' | 'RESOLVED') => (await h.incidents.list({ deviceId, status })).items;
const state = async (id: string) => h.devices.getState(id);

describe('SNMP DOWN while ICMP stays UP (real agent stopped, real ping to loopback)', () => {
  it('SNMP goes DOWN on its own thresholds, reachability stays UP, SNMP metrics are null, and it recovers when the agent returns', async () => {
    const a = await agent([{ index: 1, name: 'ether1', speedMbps: 1000, inHc: 1000n, outHc: 1000n }]);
    const dev = await h.newDevice(a.port);
    await h.rules.create({ name: 'SNMP unavailable', conditionType: 'snmp_unavailable', severity: 'warning', cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [], deviceId: dev.id });
    await h.rules.create({ name: 'Device unreachable', conditionType: 'device_down', severity: 'critical', cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [], deviceId: dev.id });

    // healthy, real data
    const first = await h.pollAndAdvance(dev.id);
    await h.pollAndAdvance(dev.id);
    expect(first.icmp).toMatchObject({ status: 'ok', reachable: true });
    expect(first.snmp).toMatchObject({ status: 'ok' });
    expect(first.snmp?.cpu).toEqual({ status: 'ok', value: 30, error: null }); // mean of the agent's 20 and 40
    expect(first.snmp?.memory).toEqual({ status: 'ok', value: 25, error: null });
    expect(await state(dev.id)).toMatchObject({ reachability: { state: 'UP' }, snmp: { state: 'UP' } });
    const ifBefore = (await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length;

    // the agent really stops
    const port = a.port;
    await a.stop();
    const t0 = Date.now();
    const o1 = await h.pollAndAdvance(dev.id);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350); // a genuine SNMP timeout (400 ms), not a shortcut
    expect(o1.icmp).toMatchObject({ status: 'ok', reachable: true }); // ICMP still answers
    expect(o1.snmp).toMatchObject({ status: 'unavailable' });
    expect(o1.snmp?.error).toMatch(/timed out/i);
    expect((await state(dev.id)).snmp.state).toBe('DEGRADED');
    expect(await incidents(dev.id)).toHaveLength(0);

    await h.pollAndAdvance(dev.id);
    expect((await state(dev.id)).snmp.state).toBe('DOWN'); // snmpFailureThreshold = 2
    expect((await state(dev.id)).reachability.state).toBe('UP'); // reachability threshold is 3 and ICMP is fine
    expect((await incidents(dev.id, 'ACTIVE')).map((i) => i.ruleName)).toEqual(['SNMP unavailable']);

    for (let i = 0; i < 3; i++) await h.pollAndAdvance(dev.id);
    expect((await state(dev.id)).reachability.state).toBe('UP');
    expect(await incidents(dev.id)).toHaveLength(1); // no duplicates, and NO "device unreachable"

    const latest = Object.fromEntries((await h.metrics.latestDeviceMetrics(dev.id)).map((m) => [m.metric, m]));
    for (const k of ['cpu_pct', 'memory_pct', 'sys_uptime_seconds', 'snmp_interface_count']) expect(latest[k], k).toMatchObject({ value: null, status: 'unavailable' });
    expect(latest.icmp_latency_ms).toMatchObject({ status: 'ok' });
    expect((await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length).toBe(ifBefore); // no interface data invented

    // the same device comes back on the same port
    await a.start(port);
    await h.pollAndAdvance(dev.id);
    expect((await state(dev.id)).snmp.state).toBe('RECOVERING');
    expect(await incidents(dev.id, 'ACTIVE')).toHaveLength(1);
    await h.pollAndAdvance(dev.id);
    expect((await state(dev.id)).snmp.state).toBe('UP');
    expect(await incidents(dev.id, 'ACTIVE')).toHaveLength(0);
    expect((await incidents(dev.id, 'RESOLVED'))[0]).toMatchObject({ ruleName: 'SNMP unavailable' });
    const cpu = (await h.metrics.latestDeviceMetrics(dev.id)).find((m) => m.metric === 'cpu_pct');
    expect(cpu).toMatchObject({ value: 30, status: 'ok' }); // real values are back
  });
});

describe('interface DOWN semantics against a real agent', () => {
  it('one DOWN poll: nothing. Sustained DOWN: exactly one incident. Restored: resolved. Never-up and admin-down interfaces: never.', async () => {
    const a = await agent([
      { index: 1, name: 'ether1', speedMbps: 1000 },
      { index: 2, name: 'ether2', speedMbps: 1000 },
      { index: 3, name: 'ether3-unused', speedMbps: 1000, oper: 2 }, // admin up, oper down from the very first observation
    ]);
    const dev = await h.newDevice(a.port);
    await h.rules.create({ name: 'Interface down', conditionType: 'interface_down', severity: 'critical', cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [], deviceId: dev.id });
    const rule = (await h.rules.list()).find((r) => r.deviceId === dev.id)!;
    expect(rule).toMatchObject({ triggerAfter: 2, clearAfter: 2 }); // configured recovery/failure confirmation = 2

    const titles = async (s?: 'ACTIVE' | 'RESOLVED') => (await incidents(dev.id, s)).map((i) => i.title);
    const OPER_UP = 1, OPER_DOWN = 2;

    // admin UP + oper UP
    await h.pollAndAdvance(dev.id);
    await h.pollAndAdvance(dev.id);
    expect(await titles()).toEqual([]);

    // admin UP + oper DOWN for ONE poll only -> no incident
    a.setOperStatus(2, OPER_DOWN);
    await h.pollAndAdvance(dev.id);
    expect(await titles()).toEqual([]);
    a.setOperStatus(2, OPER_UP);
    await h.pollAndAdvance(dev.id);
    a.setOperStatus(2, OPER_UP);
    await h.pollAndAdvance(dev.id);
    expect(await titles()).toEqual([]); // the transient blip left nothing behind

    // stays DOWN for the configured number of polls -> exactly one incident
    a.setOperStatus(2, OPER_DOWN);
    await h.pollAndAdvance(dev.id);
    expect(await titles('ACTIVE')).toEqual([]); // 1 of 2
    await h.pollAndAdvance(dev.id);
    expect(await titles('ACTIVE')).toEqual(['Interface down: real-dev [ether2]']); // 2 of 2
    const [inc] = await incidents(dev.id, 'ACTIVE');
    for (let i = 0; i < 3; i++) await h.pollAndAdvance(dev.id);
    expect(await incidents(dev.id)).toHaveLength(1); // still one
    expect((await incidents(dev.id, 'ACTIVE'))[0]!.id).toBe(inc!.id);

    // restored for the configured recovery threshold -> RESOLVED
    a.setOperStatus(2, OPER_UP);
    await h.pollAndAdvance(dev.id);
    expect(await titles('ACTIVE')).toHaveLength(1); // 1 of 2: still open
    await h.pollAndAdvance(dev.id);
    expect(await titles('ACTIVE')).toEqual([]);
    expect((await incidents(dev.id, 'RESOLVED'))[0]).toMatchObject({ id: inc!.id, status: 'RESOLVED', resolutionReason: 'condition_cleared' });

    // an interface that is admin UP + oper DOWN from its FIRST observation never alerts (it has never been seen up)
    expect((await incidents(dev.id)).every((i) => !i.title.includes('ether3-unused'))).toBe(true);
    // ... including one that shows up later already down
    a.addInterface({ index: 4, name: 'ether4-late', speedMbps: 1000, oper: 2 });
    for (let i = 0; i < 5; i++) await h.pollAndAdvance(dev.id);
    expect((await incidents(dev.id)).every((i) => !i.title.includes('ether4-late'))).toBe(true);
    const seenUp = await h.db.query<{ name: string; up: boolean }>('select name, last_oper_up_at is not null as up from interfaces where device_id = $1 order by if_index', [dev.id]);
    expect(seenUp.rows).toEqual([
      { name: 'ether1', up: true }, { name: 'ether2', up: true }, { name: 'ether3-unused', up: false }, { name: 'ether4-late', up: false },
    ]);

    // administratively disabled: not an incident, even for an interface that has been up
    a.setAdminStatus(1, 2);
    a.setOperStatus(1, OPER_DOWN);
    for (let i = 0; i < 4; i++) await h.pollAndAdvance(dev.id);
    expect((await incidents(dev.id)).filter((i) => i.title.includes('[ether1]'))).toEqual([]);
    expect((await incidents(dev.id)).length).toBe(1); // still only the one, resolved, ether2 incident
  });
});

describe('interface disappearance against a real agent', () => {
  it('disappears -> INACTIVE with history kept; reappears -> the SAME record ACTIVE again; no rate spans the gap', async () => {
    const a = await agent([
      { index: 1, name: 'ether1', speedMbps: 1000, inHc: 0n, outHc: 0n },
      { index: 2, name: 'l2tp-tunnel', speedMbps: 1000, type: 131, inHc: 1_000_000n, outHc: 1_000_000n },
    ]);
    const dev = await h.newDevice(a.port);
    const ifOf = async (idx: number) => (await h.db.query<{ id: string; name: string; active: boolean; inactive_since: Date | null }>('select id, name, active, inactive_since from interfaces where device_id = $1 and if_index = $2', [dev.id, idx])).rows[0]!;
    const samples = async (id: string) => h.metrics.queryInterfaceSamples({ deviceId: dev.id, interfaceId: id, order: 'asc' });

    // 1. exposed and collected: two samples, the second has a real rate (2.5 MB in 10 s = 2 Mbit/s)
    await h.pollAndAdvance(dev.id, 10);
    a.setCounters(2, { inHc: 3_500_000n, outHc: 3_500_000n });
    await h.pollAndAdvance(dev.id, 10);
    const original = await ifOf(2);
    const s1 = await samples(original.id);
    expect(s1).toHaveLength(2);
    expect(s1[1]!.inBps).toBeCloseTo(2_000_000);
    expect(original.active).toBe(true);

    // 2. removed from the walk
    a.removeInterface(2);
    await h.pollAndAdvance(dev.id, 10);
    await h.pollAndAdvance(dev.id, 10);
    const gone = await ifOf(2);
    expect(gone).toMatchObject({ id: original.id, active: false }); // still in the database, marked inactive
    expect(gone.inactive_since).not.toBeNull();
    expect(await samples(original.id)).toHaveLength(2); // history intact, and nothing new was invented for it
    expect((await samples((await ifOf(1)).id)).length).toBe(4); // the other interface kept being sampled
    expect((await state(dev.id)).reachability.state).toBe('UP'); // an interface vanishing is not a device failure
    expect((await state(dev.id)).snmp.state).toBe('UP');

    // 3. exposed again with a HIGHER counter: a naive diff over the 30 s gap would give (9.0M - 3.5M) * 8 / 30 = 1.47 Mbit/s
    a.addInterface({ index: 2, name: 'l2tp-tunnel', speedMbps: 1000, type: 131, inHc: 9_000_000n, outHc: 9_000_000n });
    await h.pollAndAdvance(dev.id, 10);
    const back = await ifOf(2);
    expect(back).toMatchObject({ id: original.id, active: true, inactive_since: null }); // the same record, reactivated
    const s2 = await samples(original.id);
    expect(s2).toHaveLength(3);
    expect(s2[2]).toMatchObject({ inBps: null, outBps: null, rateNote: 'first_sample' }); // NOT a rate across the gap

    // 4. from here on rates resume, computed only from the samples since it came back (+2.5 MB in 10 s)
    a.setCounters(2, { inHc: 11_500_000n, outHc: 11_500_000n });
    await h.pollAndAdvance(dev.id, 10);
    const s3 = await samples(original.id);
    expect(s3[3]!.inBps).toBeCloseTo(2_000_000);
    expect(s3[3]!.rateNote).toBeNull();
  });

  it('identity is (device, ifIndex): the same index is reused even if the name changed; a new index with the old name is a NEW interface', async () => {
    const a = await agent([{ index: 1, name: 'ether1' }, { index: 7, name: 'ppp-alpha', type: 23 }]);
    const dev = await h.newDevice(a.port);
    const row = async (idx: number) => (await h.db.query<{ id: string; name: string; active: boolean }>('select id, name, active from interfaces where device_id = $1 and if_index = $2', [dev.id, idx])).rows[0];
    await h.pollAndAdvance(dev.id);
    const original = (await row(7))!;

    a.removeInterface(7);
    await h.pollAndAdvance(dev.id);
    expect((await row(7))!.active).toBe(false);

    // same ifIndex, different name -> the record is reused and renamed (documented limitation: index reuse merges histories)
    a.addInterface({ index: 7, name: 'ppp-beta', type: 23 });
    await h.pollAndAdvance(dev.id);
    expect(await row(7)).toMatchObject({ id: original.id, name: 'ppp-beta', active: true });

    // a different ifIndex that happens to carry the old name is NOT silently merged: it is a new interface
    a.removeInterface(7);
    await h.pollAndAdvance(dev.id);
    a.addInterface({ index: 99, name: 'ppp-beta', type: 23 });
    await h.pollAndAdvance(dev.id);
    const fresh = (await row(99))!;
    expect(fresh.id).not.toBe(original.id);
    expect(fresh.active).toBe(true);
    expect((await row(7))!.active).toBe(false); // the old one stays inactive, history untouched
  });
});
