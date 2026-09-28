import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compare, evaluateRule } from '../src/alerts/evaluate.js';
import type { AlertRule } from '../src/alerts/rules.js';
import type { PollSnapshot } from '../src/devices/types.js';
import { createHarness, icmpDown, icmpOk, ifRow, okReading, snmpOk, snmpTimeout, type Harness } from './helpers/harness.js';

let h: Harness;
let channelId: string;
beforeAll(async () => {
  h = await createHarness();
  const ch = await h.channels.create({ name: 'ops-telegram', type: 'telegram', config: { chatId: '-100123' }, credentialId: h.tgCred.id, enabled: true });
  channelId = ch.id;
});
afterAll(async () => h.close());

const incidentsOf = async (deviceId: string, status?: 'ACTIVE' | 'RESOLVED') => (await h.incidents.list({ deviceId, status })).items;
const deliveries = async (incidentId: string) => h.notifications.listForIncident(incidentId);

describe('pure condition evaluation', () => {
  const rule = (over: Partial<AlertRule>): AlertRule => ({
    id: 'r', name: 'r', deviceId: null, conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 80,
    severity: 'critical', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [],
    createdAt: new Date(), updatedAt: new Date(), ...over,
  });
  const snap = (over: Partial<PollSnapshot> = {}): PollSnapshot => ({
    deviceId: 'd', deviceName: 'dev', at: new Date(), reachability: { state: 'UP', transition: null },
    snmp: { state: 'UP', transition: null }, metrics: {}, interfaces: [], interfacesCollected: true, ...over,
  });

  it('compares with every operator', () => {
    expect(compare('>', 81, 80)).toBe(true);
    expect(compare('>', 80, 80)).toBe(false);
    expect(compare('>=', 80, 80)).toBe(true);
    expect(compare('<', 79, 80)).toBe(true);
    expect(compare('<=', 80, 80)).toBe(true);
    expect(compare('==', 80, 80)).toBe(true);
    expect(compare('!=', 79, 80)).toBe(true);
  });

  it('an unavailable metric is UNKNOWN: neither a breach nor "healthy"', () => {
    const ev = evaluateRule(rule({}), snap({ metrics: { cpu_pct: { value: null, status: 'unavailable', error: 'SNMP timeout' } } }));
    expect(ev.subjects[0]).toMatchObject({ verdict: 'unknown', value: null, error: 'SNMP timeout' });
  });

  it('a missing metric is unknown too (e.g. device without SNMP)', () => {
    expect(evaluateRule(rule({}), snap()).subjects[0]!.verdict).toBe('unknown');
  });

  it('device_down: DOWN and RECOVERING are breaches; DEGRADED is not', () => {
    const r = rule({ conditionType: 'device_down', metric: null, operator: null, threshold: null });
    const v = (state: PollSnapshot['reachability']['state']) => evaluateRule(r, snap({ reachability: { state, transition: null } })).subjects[0]!.verdict;
    expect([v('DOWN'), v('RECOVERING'), v('DEGRADED'), v('UP'), v('UNKNOWN')]).toEqual(['breach', 'breach', 'ok', 'ok', 'unknown']);
  });

  it('interface_down ignores administratively-down interfaces', () => {
    const r = rule({ conditionType: 'interface_down', metric: null, operator: null, threshold: null });
    const mk = (adminStatus: string, operStatus: string, everUp = true) => ({
      interfaceId: 'i1', ifIndex: 1, name: 'ether1', monitored: true, everUp, adminStatus, operStatus, inBps: null, outBps: null,
    });
    expect(evaluateRule(r, snap({ interfaces: [mk('up', 'down')] })).subjects[0]!.verdict).toBe('breach');
    expect(evaluateRule(r, snap({ interfaces: [mk('up', 'notPresent')] })).subjects[0]!.verdict).toBe('breach');
    expect(evaluateRule(r, snap({ interfaces: [mk('down', 'down')] })).subjects[0]!.verdict).toBe('ok');
    expect(evaluateRule(r, snap({ interfaces: [mk('up', 'up')] })).subjects[0]!.verdict).toBe('ok');
    expect(evaluateRule(r, snap({ interfaces: [mk('up', 'dormant')] })).subjects[0]!.verdict).toBe('unknown');
    // admin up + oper down but NEVER seen up (unused port / empty SFP cage): not an incident
    expect(evaluateRule(r, snap({ interfaces: [mk('up', 'down', false)] })).subjects[0]!.verdict).toBe('ok');
    expect(evaluateRule(r, snap({ interfaces: [mk('up', 'notPresent', false)] })).subjects[0]!.verdict).toBe('ok');
    expect(evaluateRule(r, snap({ interfaces: [], interfacesCollected: false }))).toEqual({ subjects: [], complete: false });
  });
});

describe('incident lifecycle', () => {
  it('threshold trigger: opens only after N consecutive breaches, with severity taken from the RULE', async () => {
    const dev = await h.newDevice({ name: 'cpu-hot' });
    const rule = await h.rules.create({
      name: 'High CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 80,
      severity: 'warning', triggerAfter: 3, clearAfter: 2, cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId: dev.id,
    });
    h.icmp.result = icmpOk();

    h.snmp.result = snmpOk({ cpu: okReading(95) });
    await h.polls.poll(dev.id);
    await h.polls.poll(dev.id);
    expect(await incidentsOf(dev.id)).toHaveLength(0); // 2 breaches < triggerAfter 3

    await h.polls.poll(dev.id);
    const [inc] = await incidentsOf(dev.id, 'ACTIVE');
    expect(inc).toMatchObject({ status: 'OPEN', severity: 'warning', metric: 'cpu_pct', value: 95, threshold: 80, ruleId: rule.id });
    expect(inc!.title).toBe('High CPU: cpu-hot');

    // severity does not depend on unrelated metrics: even with latency 500ms it stays 'warning'
    h.icmp.result = icmpOk(500);
    await h.polls.poll(dev.id);
    expect((await incidentsOf(dev.id, 'ACTIVE'))[0]!.severity).toBe('warning');
  });

  it('NO duplicate incidents while the condition persists; the same incident keeps being refreshed', async () => {
    const dev = await h.newDevice({ name: 'no-dupes' });
    await h.rules.create({
      name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 50, severity: 'critical',
      triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId: dev.id,
    });
    h.snmp.result = snmpOk({ cpu: okReading(90) });
    for (let i = 0; i < 6; i++) await h.pollAndAdvance(dev.id);

    const all = await incidentsOf(dev.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.lastSeenAt.getTime()).toBeGreaterThan(all[0]!.triggeredAt.getTime());
    expect(await deliveries(all[0]!.id)).toHaveLength(1); // one "triggered" notification, not six
  });

  it('recovery: resolves after clearAfter healthy polls and announces it', async () => {
    const dev = await h.newDevice({ name: 'recovers' });
    await h.rules.create({
      name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 50, severity: 'critical',
      triggerAfter: 1, clearAfter: 2, cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId: dev.id,
    });
    h.snmp.result = snmpOk({ cpu: okReading(90) });
    await h.pollAndAdvance(dev.id);
    h.snmp.result = snmpOk({ cpu: okReading(10) });
    await h.pollAndAdvance(dev.id);
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1); // 1 healthy poll < clearAfter 2
    await h.pollAndAdvance(dev.id);

    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
    const [resolved] = await incidentsOf(dev.id, 'RESOLVED');
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolutionReason: 'condition_cleared' });
    expect(resolved!.resolvedAt).not.toBeNull();
    expect((await deliveries(resolved!.id)).map((d) => d.event)).toEqual(['triggered', 'recovered']);
  });

  it('unknown data does not close an incident (SNMP outage is not evidence of recovery)', async () => {
    const dev = await h.newDevice({ name: 'unknown-safe' });
    await h.rules.create({
      name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 50, severity: 'critical',
      triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id,
    });
    h.snmp.result = snmpOk({ cpu: okReading(90) });
    await h.pollAndAdvance(dev.id);
    h.snmp.result = snmpTimeout();
    for (let i = 0; i < 4; i++) await h.pollAndAdvance(dev.id);
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
  });

  it('unknown data does not open an incident either', async () => {
    const dev = await h.newDevice({ name: 'unknown-quiet' });
    await h.rules.create({
      name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 50, severity: 'critical',
      triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id,
    });
    h.snmp.result = snmpTimeout();
    for (let i = 0; i < 3; i++) await h.pollAndAdvance(dev.id);
    expect(await incidentsOf(dev.id)).toHaveLength(0);
  });

  it('cooldown: after resolving, the same condition cannot re-open an incident until the cooldown passed', async () => {
    const dev = await h.newDevice({ name: 'cooldown' });
    await h.rules.create({
      name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 50, severity: 'critical',
      triggerAfter: 1, clearAfter: 1, cooldownSec: 300, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id,
    });
    const hot = () => (h.snmp.result = snmpOk({ cpu: okReading(90) }));
    const cool = () => (h.snmp.result = snmpOk({ cpu: okReading(10) }));

    hot();
    await h.pollAndAdvance(dev.id, 30); // opens
    cool();
    await h.pollAndAdvance(dev.id, 30); // resolves
    hot();
    await h.pollAndAdvance(dev.id, 30); // 30 s after resolve: suppressed by cooldown
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
    expect(await incidentsOf(dev.id)).toHaveLength(1);

    h.clock.advance(400); // past the cooldown
    await h.pollAndAdvance(dev.id, 30);
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
    expect(await incidentsOf(dev.id)).toHaveLength(2);
  });

  it('acknowledge: OPEN -> ACKNOWLEDGED, idempotent, still deduplicated, resolvable', async () => {
    const dev = await h.newDevice({ name: 'ack' });
    await h.rules.create({
      name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 50, severity: 'critical',
      triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id,
    });
    h.snmp.result = snmpOk({ cpu: okReading(90) });
    await h.pollAndAdvance(dev.id);
    const [inc] = await incidentsOf(dev.id, 'ACTIVE');

    const acked = await h.incidents.acknowledge(inc!.id, 'daffa');
    expect(acked).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'daffa' });
    expect(acked.acknowledgedAt).not.toBeNull();
    expect((await h.incidents.acknowledge(inc!.id, 'someone-else')).acknowledgedBy).toBe('daffa'); // idempotent

    await h.pollAndAdvance(dev.id); // still breaching: no second incident
    expect(await incidentsOf(dev.id)).toHaveLength(1);

    h.snmp.result = snmpOk({ cpu: okReading(5) });
    await h.pollAndAdvance(dev.id);
    const [after] = await incidentsOf(dev.id);
    expect(after).toMatchObject({ status: 'RESOLVED', acknowledgedBy: 'daffa' });
    await expect(h.incidents.acknowledge(inc!.id, 'x')).rejects.toThrow(/RESOLVED/);
  });

  it('device_down incident opens only after the state machine says DOWN, and resolves when UP again', async () => {
    const dev = await h.newDevice({ name: 'down-rule', snmpEnabled: false, snmpAuth: null });
    await h.rules.create({
      name: 'Device unreachable', conditionType: 'device_down', severity: 'critical', triggerAfter: 1, clearAfter: 1,
      cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId: dev.id,
    });
    h.icmp.result = icmpOk();
    await h.pollAndAdvance(dev.id);

    h.icmp.result = icmpDown();
    await h.pollAndAdvance(dev.id);
    await h.pollAndAdvance(dev.id);
    expect(await incidentsOf(dev.id)).toHaveLength(0); // 2 failures: only DEGRADED, no incident (transient failure tolerance)

    await h.pollAndAdvance(dev.id);
    const [inc] = await incidentsOf(dev.id, 'ACTIVE');
    expect(inc).toMatchObject({ status: 'OPEN', severity: 'critical', metric: 'reachability' });

    h.icmp.result = icmpOk();
    await h.pollAndAdvance(dev.id); // RECOVERING: still an incident
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
    await h.pollAndAdvance(dev.id); // UP
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
    expect((await deliveries(inc!.id)).map((d) => d.event)).toEqual(['triggered', 'recovered']);
  });

  it('snmp_unavailable is separate from device_down (reachable, agent silent)', async () => {
    const dev = await h.newDevice({ name: 'snmp-rule' });
    await h.rules.create({ name: 'Device unreachable', conditionType: 'device_down', severity: 'critical', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id });
    await h.rules.create({ name: 'SNMP unavailable', conditionType: 'snmp_unavailable', severity: 'warning', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id });
    h.icmp.result = icmpOk();
    h.snmp.result = snmpTimeout();
    for (let i = 0; i < 3; i++) await h.pollAndAdvance(dev.id);
    const active = await incidentsOf(dev.id, 'ACTIVE');
    expect(active.map((i) => i.ruleName)).toEqual(['SNMP unavailable']);
  });

  // ---- interface_down semantics ------------------------------------------------------------------------------------
  // helper: one poll where each interface index maps to [admin, oper]
  type IfState = 'up' | 'down' | 'admin-down';
  const ifs = (state: Record<number, IfState>) => ({
    status: 'ok' as const,
    error: null,
    rows: Object.entries(state).map(([i, st]) =>
      ifRow(Number(i), st === 'up' ? { adminStatus: 'up', operStatus: 'up' } : st === 'down' ? { adminStatus: 'up', operStatus: 'down' } : { adminStatus: 'down', operStatus: 'down' }),
    ),
  });
  const interfaceRule = (deviceId: string) =>
    h.rules.create({ name: 'Interface down', conditionType: 'interface_down', severity: 'critical', cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId });
  const pollIf = async (deviceId: string, state: Record<number, IfState>) => {
    h.snmp.result = snmpOk({ interfaces: ifs(state) });
    await h.pollAndAdvance(deviceId);
  };

  it('interface_down defaults: 2 consecutive DOWN polls to open, 2 consecutive UP polls to resolve', async () => {
    const dev = await h.newDevice({ name: 'ifdefaults' });
    const rule = await interfaceRule(dev.id);
    expect(rule).toMatchObject({ triggerAfter: 2, clearAfter: 2 });
  });

  it('never-seen-up ports (admin up, oper down from the first poll) do NOT create incidents, however long they stay down', async () => {
    const dev = await h.newDevice({ name: 'unused-ports' });
    await interfaceRule(dev.id);
    for (let i = 0; i < 6; i++) await pollIf(dev.id, { 1: 'up', 2: 'down', 3: 'down', 4: 'admin-down' });
    expect(await incidentsOf(dev.id)).toHaveLength(0);
    const rows = (await h.db.query<{ name: string; last_oper_up_at: Date | null }>('select name, last_oper_up_at from interfaces where device_id = $1 order by if_index', [dev.id])).rows;
    expect(rows.map((r) => [r.name, r.last_oper_up_at !== null])).toEqual([['ether1', true], ['ether2', false], ['ether3', false], ['ether4', false]]);
  });

  it('UP, UP, DOWN, DOWN opens an incident; DOWN, DOWN again does not duplicate; UP, UP resolves it', async () => {
    const dev = await h.newDevice({ name: 'ifcycle' });
    await interfaceRule(dev.id);

    await pollIf(dev.id, { 1: 'up', 2: 'up' });
    await pollIf(dev.id, { 1: 'up', 2: 'up' });
    await pollIf(dev.id, { 1: 'up', 2: 'down' }); // first DOWN: unconfirmed
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
    await pollIf(dev.id, { 1: 'up', 2: 'down' }); // second consecutive DOWN: confirmed
    const [inc] = await incidentsOf(dev.id, 'ACTIVE');
    expect(inc).toMatchObject({ status: 'OPEN', severity: 'critical', metric: 'if_oper_status' });
    expect(inc!.title).toBe('Interface down: ifcycle [ether2]');
    expect(inc!.interfaceId).not.toBeNull();
    const openedAt = inc!.triggeredAt;

    for (let i = 0; i < 4; i++) await pollIf(dev.id, { 1: 'up', 2: 'down' }); // condition persists
    expect(await incidentsOf(dev.id)).toHaveLength(1); // still ONE incident
    expect((await incidentsOf(dev.id, 'ACTIVE'))[0]!.triggeredAt).toEqual(openedAt); // and it is the same one

    await pollIf(dev.id, { 1: 'up', 2: 'up' }); // first UP: not yet resolved
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
    await pollIf(dev.id, { 1: 'up', 2: 'up' }); // second consecutive UP: resolved
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
    const [resolved] = await incidentsOf(dev.id, 'RESOLVED');
    expect(resolved).toMatchObject({ id: inc!.id, status: 'RESOLVED', resolutionReason: 'condition_cleared' });
    expect(resolved!.resolvedAt!.getTime()).toBeGreaterThan(resolved!.triggeredAt.getTime());
    expect((await deliveries(inc!.id)).map((d) => d.event)).toEqual(['triggered', 'recovered']);
  });

  it('a transient one-poll DOWN never opens an incident', async () => {
    const dev = await h.newDevice({ name: 'iftransient' });
    await interfaceRule(dev.id);
    await pollIf(dev.id, { 1: 'up' });
    await pollIf(dev.id, { 1: 'up' });
    await pollIf(dev.id, { 1: 'down' });
    await pollIf(dev.id, { 1: 'up' });
    await pollIf(dev.id, { 1: 'down' });
    await pollIf(dev.id, { 1: 'up' });
    expect(await incidentsOf(dev.id)).toHaveLength(0); // never two DOWN polls in a row
  });

  it('an unused port that later comes up and then fails IS alerted (it has now been seen up)', async () => {
    const dev = await h.newDevice({ name: 'late-link' });
    await interfaceRule(dev.id);
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    expect(await incidentsOf(dev.id)).toHaveLength(0);
    await pollIf(dev.id, { 1: 'up', 2: 'up' }); // cable plugged in
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    expect((await incidentsOf(dev.id, 'ACTIVE')).map((i) => i.title)).toEqual(['Interface down: late-link [ether2]']);
  });

  it('administratively disabling an interface is intentional: it resolves the incident, it does not open one', async () => {
    const dev = await h.newDevice({ name: 'admin-off' });
    await interfaceRule(dev.id);
    await pollIf(dev.id, { 1: 'up', 2: 'up' });
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
    await pollIf(dev.id, { 1: 'up', 2: 'admin-down' });
    await pollIf(dev.id, { 1: 'up', 2: 'admin-down' });
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
  });

  it('an interface that disappears from the walk becomes INACTIVE (kept, with history) and its incident closes as subject_removed', async () => {
    const dev = await h.newDevice({ name: 'ifgone' });
    await interfaceRule(dev.id);
    await pollIf(dev.id, { 1: 'up', 2: 'up' });
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    await pollIf(dev.id, { 1: 'up', 2: 'down' });
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);

    await pollIf(dev.id, { 1: 'up' }); // ether2 no longer reported
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
    expect((await incidentsOf(dev.id, 'RESOLVED'))[0]!.resolutionReason).toBe('subject_removed');
    const row = (await h.db.query<{ active: boolean; inactive_since: Date | null }>('select active, inactive_since from interfaces where device_id = $1 and if_index = 2', [dev.id])).rows[0]!;
    expect(row.active).toBe(false);
    expect(row.inactive_since).not.toBeNull();
    // history is still there
    expect((await h.metrics.queryInterfaceSamples({ deviceId: dev.id })).length).toBeGreaterThan(3);
  });

  it('interface table unavailable neither opens nor closes interface incidents', async () => {
    const dev = await h.newDevice({ name: 'if-unknown' });
    await interfaceRule(dev.id);
    await pollIf(dev.id, { 1: 'up' });
    await pollIf(dev.id, { 1: 'down' });
    await pollIf(dev.id, { 1: 'down' });
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
    h.snmp.result = snmpOk({ interfaces: { status: 'unavailable', error: 'timeout', rows: [] } });
    for (let i = 0; i < 4; i++) await h.pollAndAdvance(dev.id);
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
  });

  it('interface traffic threshold uses per-interface rates', async () => {
    const dev = await h.newDevice({ name: 'bw' });
    await h.rules.create({
      name: 'Uplink saturated', conditionType: 'metric_threshold', metric: 'if_in_bps', operator: '>', threshold: 500_000_000,
      severity: 'warning', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id,
    });
    h.snmp.result = snmpOk({ interfaces: { status: 'ok', error: null, rows: [ifRow(1, { inOctets: 0n }), ifRow(2, { inOctets: 0n })] } });
    await h.pollAndAdvance(dev.id, 10);
    // ether1: +1 Gbit in 10 s = 100 Mbit/s * ... make it 1.25 GB => 1 Gbit/s ; ether2 quiet
    h.snmp.result = snmpOk({ interfaces: { status: 'ok', error: null, rows: [ifRow(1, { inOctets: 1_250_000_000n }), ifRow(2, { inOctets: 1_000n })] } });
    await h.pollAndAdvance(dev.id, 10);
    const active = await incidentsOf(dev.id, 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toContain('[ether1]');
    expect(active[0]!.value).toBeCloseTo(1_000_000_000);
  });

  it('disabling a rule resolves the incidents it opened; deleting does the same', async () => {
    const dev = await h.newDevice({ name: 'retire' });
    const rule = await h.rules.create({ name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 1, severity: 'info', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [], deviceId: dev.id });
    h.snmp.result = snmpOk({ cpu: okReading(50) });
    await h.pollAndAdvance(dev.id);
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);

    await h.rules.update(rule.id, { enabled: false });
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
    expect((await incidentsOf(dev.id, 'RESOLVED'))[0]!.resolutionReason).toBe('rule_disabled');

    await h.rules.update(rule.id, { enabled: true });
    await h.pollAndAdvance(dev.id);
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(1);
    await h.rules.remove(rule.id);
    expect(await incidentsOf(dev.id, 'ACTIVE')).toHaveLength(0);
  });

  it('rules without a device apply to every device', async () => {
    const a = await h.newDevice({ name: 'fleet-a' });
    const b = await h.newDevice({ name: 'fleet-b' });
    const rule = await h.rules.create({ name: 'Fleet CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 70, severity: 'warning', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: false, enabled: true, channelIds: [] });
    h.snmp.result = snmpOk({ cpu: okReading(99) });
    await h.pollAndAdvance(a.id);
    await h.pollAndAdvance(b.id);
    expect(await incidentsOf(a.id, 'ACTIVE')).toHaveLength(1);
    expect(await incidentsOf(b.id, 'ACTIVE')).toHaveLength(1);
    await h.rules.remove(rule.id);
  });

  it('validates rule definitions', async () => {
    const { createRuleSchema } = await import('../src/alerts/rules.js');
    expect(createRuleSchema.safeParse({ name: 'x', conditionType: 'metric_threshold', severity: 'info' }).success).toBe(false);
    expect(createRuleSchema.safeParse({ name: 'x', conditionType: 'metric_threshold', metric: 'nope', operator: '>', threshold: 1, severity: 'info' }).success).toBe(false);
    expect(createRuleSchema.safeParse({ name: 'x', conditionType: 'device_down', metric: 'cpu_pct', severity: 'info' }).success).toBe(false);
    expect(createRuleSchema.safeParse({ name: 'x', conditionType: 'device_down', severity: 'nope' }).success).toBe(false);
    expect(createRuleSchema.safeParse({ name: 'x', conditionType: 'device_down', severity: 'info' }).success).toBe(true);
  });
});
