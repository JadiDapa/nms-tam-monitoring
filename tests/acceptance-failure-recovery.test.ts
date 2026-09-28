import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, icmpDown, icmpOk, okReading, snmpOk, snmpTimeout, type Harness } from './helpers/harness.js';

/**
 * ACCEPTANCE: failure and recovery, end to end through poll -> state machine -> incident -> notification.
 * (Scripted probes: each step of a sequence is one poll with a chosen outcome.)
 */

let h: Harness;
let channelId: string;
beforeAll(async () => {
  h = await createHarness();
  channelId = (await h.channels.create({ name: 'ops-hook', type: 'webhook', config: { url: 'https://hooks.example.com/nms' }, enabled: true })).id;
});
afterAll(async () => h.close());

const noSnmp = { snmpEnabled: false, snmpAuth: null };
const incidents = async (deviceId: string, status?: 'ACTIVE' | 'RESOLVED') => (await h.incidents.list({ deviceId, status })).items;
const reach = async (id: string) => (await h.devices.getState(id)).reachability.state;
const snmpState = async (id: string) => (await h.devices.getState(id)).snmp.state;
const deliveryRows = async (incidentId: string) => h.notifications.listForIncident(incidentId);
const deviceDownRule = (deviceId: string) =>
  h.rules.create({ name: 'Device unreachable', conditionType: 'device_down', severity: 'critical', cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId });

describe('reachability: UNKNOWN -> UP -> DEGRADED -> DOWN -> RECOVERING -> UP (thresholds 3 failures / 2 recoveries)', () => {
  it('the complete lifecycle, asserting the state and the incident count after EVERY poll', async () => {
    const dev = await h.newDevice({ name: 'lifecycle', ...noSnmp });
    await deviceDownRule(dev.id);

    const step = async (probe: 'ok' | 'fail', expectState: string, expectIncidents: { total: number; active: number }) => {
      h.icmp.result = probe === 'ok' ? icmpOk() : icmpDown();
      await h.pollAndAdvance(dev.id);
      const label = `after ${probe} -> ${expectState}`;
      expect(await reach(dev.id), label).toBe(expectState);
      expect((await incidents(dev.id)).length, `${label}: total incidents`).toBe(expectIncidents.total);
      expect((await incidents(dev.id, 'ACTIVE')).length, `${label}: active incidents`).toBe(expectIncidents.active);
    };

    expect(await reach(dev.id)).toBe('UNKNOWN'); // before any poll
    await step('ok', 'UP', { total: 0, active: 0 }); // UNKNOWN -> UP
    await step('fail', 'DEGRADED', { total: 0, active: 0 }); // UP -> transient failure: NO incident
    await step('ok', 'UP', { total: 0, active: 0 }); // transient failure cleared
    await step('fail', 'DEGRADED', { total: 0, active: 0 }); // consecutive failure #1
    await step('fail', 'DEGRADED', { total: 0, active: 0 }); // #2: still below the threshold of 3
    await step('fail', 'DOWN', { total: 1, active: 1 }); // #3: DOWN, exactly one incident

    const [incident] = await incidents(dev.id, 'ACTIVE');
    expect(incident).toMatchObject({ status: 'OPEN', severity: 'critical', metric: 'reachability' });

    // sustained outage: many more failures, still exactly ONE incident (no duplicate per poll)
    for (let i = 0; i < 12; i++) await step('fail', 'DOWN', { total: 1, active: 1 });
    expect((await incidents(dev.id))[0]!.id).toBe(incident!.id);
    expect((await deliveryRows(incident!.id)).filter((d) => d.event === 'triggered')).toHaveLength(1); // one alert, not thirteen

    await step('ok', 'RECOVERING', { total: 1, active: 1 }); // DOWN -> first success: NOT yet recovered
    await step('fail', 'DOWN', { total: 1, active: 1 }); // transient recovery collapses: back to DOWN, same incident
    expect((await incidents(dev.id, 'ACTIVE'))[0]!.id).toBe(incident!.id);
    await step('ok', 'RECOVERING', { total: 1, active: 1 });
    await step('ok', 'UP', { total: 1, active: 0 }); // 2 consecutive successes: UP, incident resolved

    const [resolved] = await incidents(dev.id, 'RESOLVED');
    expect(resolved).toMatchObject({ id: incident!.id, status: 'RESOLVED', resolutionReason: 'condition_cleared' });
    expect(resolved!.resolvedAt!.getTime()).toBeGreaterThan(resolved!.triggeredAt.getTime());
    expect((await deliveryRows(incident!.id)).map((d) => d.event).sort()).toEqual(['recovered', 'triggered']);

    const history = (await h.devices.status(dev.id)).stateHistory.filter((x) => x.kind === 'reachability').map((x) => `${x.from}>${x.to}`).reverse();
    expect(history).toEqual([
      'UNKNOWN>UP', 'UP>DEGRADED', 'DEGRADED>UP', 'UP>DEGRADED', 'DEGRADED>DOWN', 'DOWN>RECOVERING', 'RECOVERING>DOWN', 'DOWN>RECOVERING', 'RECOVERING>UP',
    ]);
  });

  it('a SINGLE failed probe never creates an incident, however often it happens in isolation', async () => {
    const dev = await h.newDevice({ name: 'isolated-failures', ...noSnmp });
    await deviceDownRule(dev.id);
    for (let i = 0; i < 10; i++) {
      h.icmp.result = i % 2 === 0 ? icmpOk() : icmpDown(); // ok, fail, ok, fail ...
      await h.pollAndAdvance(dev.id);
    }
    expect(await incidents(dev.id)).toHaveLength(0);
    expect(await reach(dev.id)).not.toBe('DOWN');
  });

  it('configured thresholds are respected on the way down AND on the way up (5 failures / 4 recoveries)', async () => {
    const dev = await h.newDevice({ name: 'custom-thresholds', ...noSnmp, polling: { failureThreshold: 5, recoveryThreshold: 4, timeoutMs: 1000, retryCount: 0 } });
    await deviceDownRule(dev.id);
    h.icmp.result = icmpOk();
    await h.pollAndAdvance(dev.id);

    h.icmp.result = icmpDown();
    const down: string[] = [];
    for (let i = 0; i < 5; i++) {
      await h.pollAndAdvance(dev.id);
      down.push(`${await reach(dev.id)}/${(await incidents(dev.id)).length}`);
    }
    expect(down).toEqual(['DEGRADED/0', 'DEGRADED/0', 'DEGRADED/0', 'DEGRADED/0', 'DOWN/1']); // DOWN exactly at failure #5

    h.icmp.result = icmpOk();
    const up: string[] = [];
    for (let i = 0; i < 4; i++) {
      await h.pollAndAdvance(dev.id);
      up.push(`${await reach(dev.id)}/${(await incidents(dev.id, 'ACTIVE')).length}`);
    }
    expect(up).toEqual(['RECOVERING/1', 'RECOVERING/1', 'RECOVERING/1', 'UP/0']); // UP exactly at recovery #4
  });

  it('a second outage after a recovery opens a NEW incident; the first stays resolved', async () => {
    const dev = await h.newDevice({ name: 'two-outages', ...noSnmp });
    await deviceDownRule(dev.id);
    const run = async (r: typeof icmpOk, n: number) => {
      for (let i = 0; i < n; i++) {
        h.icmp.result = r();
        await h.pollAndAdvance(dev.id);
      }
    };
    await run(icmpOk, 1);
    await run(icmpDown, 3);
    await run(icmpOk, 2);
    await run(icmpDown, 3);
    const all = await incidents(dev.id);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((i) => i.id)).size).toBe(2);
    expect((await incidents(dev.id, 'ACTIVE'))).toHaveLength(1);
    expect((await incidents(dev.id, 'RESOLVED'))).toHaveLength(1);
  });

  it('a device that is down from its very first poll goes UNKNOWN -> DEGRADED -> DOWN and raises one incident', async () => {
    const dev = await h.newDevice({ name: 'born-down', ...noSnmp });
    await deviceDownRule(dev.id);
    h.icmp.result = icmpDown();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await h.pollAndAdvance(dev.id);
      seen.push(await reach(dev.id));
    }
    expect(seen).toEqual(['DEGRADED', 'DEGRADED', 'DOWN', 'DOWN', 'DOWN', 'DOWN']);
    expect(await incidents(dev.id)).toHaveLength(1);
  });

  it('notifications stay truthful through an outage: nothing is SENT until a worker actually delivers it', async () => {
    const dev = await h.newDevice({ name: 'truthful', ...noSnmp });
    await deviceDownRule(dev.id);
    h.icmp.result = icmpOk();
    await h.pollAndAdvance(dev.id);
    h.icmp.result = icmpDown();
    for (let i = 0; i < 3; i++) await h.pollAndAdvance(dev.id);
    const [inc] = await incidents(dev.id);
    expect((await deliveryRows(inc!.id)).map((d) => d.status)).toEqual(['PENDING']); // requested, not delivered
    h.webhook.outcome = () => ({ kind: 'failed', code: 'HTTP_503', error: 'unavailable', retryable: true, responseStatus: 503 });
    await h.notifications.processDue();
    expect((await deliveryRows(inc!.id)).map((d) => d.status)).toEqual(['FAILED', 'PENDING']); // failed attempt recorded honestly
    h.webhook.outcome = () => ({ kind: 'sent', responseStatus: 200 });
  });
});

describe('SNMP DOWN while ICMP stays UP (snmp thresholds 2 / 2, reachability thresholds 3 / 2)', () => {
  const polling = { failureThreshold: 3, recoveryThreshold: 2, snmpFailureThreshold: 2, snmpRecoveryThreshold: 2, timeoutMs: 1000, retryCount: 0 };

  it('SNMP transitions independently, SNMP metrics become null (never invented), reachability stays UP, and it recovers', async () => {
    const dev = await h.newDevice({ name: 'snmp-outage', polling });
    await deviceDownRule(dev.id);
    await h.rules.create({ name: 'SNMP unavailable', conditionType: 'snmp_unavailable', severity: 'warning', cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId: dev.id });

    // healthy: real values
    h.icmp.result = icmpOk();
    h.snmp.result = snmpOk({ cpu: okReading(41), memory: okReading(63) });
    await h.pollAndAdvance(dev.id);
    await h.pollAndAdvance(dev.id);
    expect(await reach(dev.id)).toBe('UP');
    expect(await snmpState(dev.id)).toBe('UP');
    const ifSamplesBefore = (await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length;
    expect(ifSamplesBefore).toBeGreaterThan(0);

    // SNMP goes silent, ICMP keeps answering
    h.snmp.result = snmpTimeout();
    await h.pollAndAdvance(dev.id);
    expect(await snmpState(dev.id)).toBe('DEGRADED'); // failure #1 of 2
    expect(await incidents(dev.id)).toHaveLength(0);
    await h.pollAndAdvance(dev.id);
    expect(await snmpState(dev.id)).toBe('DOWN'); // failure #2 of 2: threshold respected (2, not the reachability 3)
    expect(await reach(dev.id)).toBe('UP'); // <- independent
    let active = await incidents(dev.id, 'ACTIVE');
    expect(active.map((i) => i.ruleName)).toEqual(['SNMP unavailable']); // and NOT "Device unreachable"

    for (let i = 0; i < 8; i++) await h.pollAndAdvance(dev.id);
    expect(await reach(dev.id)).toBe('UP'); // still UP after a long SNMP outage
    expect(await snmpState(dev.id)).toBe('DOWN');
    expect((await incidents(dev.id)).length).toBe(1); // no duplicates

    // nothing fabricated: every SNMP-derived metric of the outage polls is null + unavailable with a real error
    const latest = Object.fromEntries((await h.metrics.latestDeviceMetrics(dev.id)).map((m) => [m.metric, m]));
    for (const k of ['cpu_pct', 'memory_pct', 'sys_uptime_seconds', 'snmp_interface_count', 'snmp_response_ms']) {
      expect(latest[k], k).toMatchObject({ value: null, status: 'unavailable' });
      expect(latest[k]!.error).toMatch(/timed out/i);
    }
    expect(latest.icmp_latency_ms).toMatchObject({ status: 'ok' }); // ICMP data is still genuine
    const cpuHistory = await h.metrics.queryDeviceMetrics({ deviceId: dev.id, metric: 'cpu_pct', order: 'asc', limit: 100 });
    expect(cpuHistory.filter((m) => m.status === 'ok').map((m) => m.value)).toEqual([41, 41]); // only the two genuine samples
    expect(cpuHistory.filter((m) => m.status !== 'ok').every((m) => m.value === null)).toBe(true);
    expect((await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length).toBe(ifSamplesBefore); // no interface data invented

    // SNMP returns: needs 2 consecutive successes, then the incident resolves
    h.snmp.result = snmpOk({ cpu: okReading(44), memory: okReading(64) });
    await h.pollAndAdvance(dev.id);
    expect(await snmpState(dev.id)).toBe('RECOVERING');
    expect(await incidents(dev.id, 'ACTIVE')).toHaveLength(1); // not resolved yet
    await h.pollAndAdvance(dev.id);
    expect(await snmpState(dev.id)).toBe('UP');
    expect(await incidents(dev.id, 'ACTIVE')).toHaveLength(0);
    expect((await incidents(dev.id, 'RESOLVED'))[0]).toMatchObject({ ruleName: 'SNMP unavailable', resolutionReason: 'condition_cleared' });
    const cpuNow = (await h.metrics.latestDeviceMetrics(dev.id)).find((m) => m.metric === 'cpu_pct');
    expect(cpuNow).toMatchObject({ value: 44, status: 'ok' }); // real values again

    // the whole time, ICMP-based reachability never moved
    const hist = (await h.devices.status(dev.id)).stateHistory;
    expect(hist.filter((x) => x.kind === 'reachability').map((x) => `${x.from}>${x.to}`)).toEqual(['UNKNOWN>UP']);
    expect(hist.filter((x) => x.kind === 'snmp').map((x) => `${x.from}>${x.to}`).reverse()).toEqual(['UNKNOWN>UP', 'UP>DEGRADED', 'DEGRADED>DOWN', 'DOWN>RECOVERING', 'RECOVERING>UP']);
  });

  it('INVARIANT: across everything above, a sample has a value only when its status is ok', async () => {
    const bad = await h.db.query<{ n: string }>(
      `select count(*)::text n from device_metric_samples where (status <> 'ok' and value is not null) or (status = 'ok' and value is null)`,
    );
    expect(bad.rows[0]!.n).toBe('0');
    const badIf = await h.db.query<{ n: string }>(`select count(*)::text n from interface_samples where status <> 'ok' and (in_bps is not null or out_bps is not null)`);
    expect(badIf.rows[0]!.n).toBe('0');
  });

  it('when SNMP is not even configured, the snmp_unavailable rule cannot fire', async () => {
    const dev = await h.newDevice({ name: 'no-snmp-at-all', ...noSnmp });
    await h.rules.create({ name: 'SNMP unavailable', conditionType: 'snmp_unavailable', severity: 'warning', cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id });
    h.icmp.result = icmpOk();
    for (let i = 0; i < 5; i++) await h.pollAndAdvance(dev.id);
    expect(await incidents(dev.id)).toHaveLength(0);
  });
});
