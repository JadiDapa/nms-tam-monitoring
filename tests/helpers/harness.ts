import { randomBytes } from 'node:crypto';
import { AlertEvaluator } from '../../src/alerts/evaluator.js';
import { IncidentManager } from '../../src/alerts/incident-manager.js';
import { RuleService } from '../../src/alerts/rules.js';
import type { IcmpOptions, IcmpProbe, IcmpResult } from '../../src/collectors/icmp/types.js';
import type { SnmpInterfaceRow, SnmpOptions, SnmpPollResult, SnmpProbe, SnmpTarget } from '../../src/collectors/snmp/types.js';
import type { TcpOptions, TcpPortResult, TcpProbe } from '../../src/collectors/tcp/tcp-probe.js';
import { CredentialService } from '../../src/credentials/credential-service.js';
import { SecretBox } from '../../src/credentials/secret-box.js';
import { DeviceService } from '../../src/devices/device-service.js';
import { PollService } from '../../src/devices/poll-service.js';
import { PostgresMetricRepository } from '../../src/metrics/postgres-repository.js';
import { ChannelService } from '../../src/notifications/channel-service.js';
import { NotificationService } from '../../src/notifications/notification-service.js';
import type { ChannelRuntime, DeliveryOutcome, NotificationMessage, NotificationProvider } from '../../src/notifications/provider.js';
import { silentLogger } from '../../src/util/logger.js';
import { createTestDb } from './test-db.js';

export class FakeClock {
  t = Date.parse('2026-03-01T00:00:00Z');
  now = () => this.t;
  advance(sec: number) {
    this.t += sec * 1000;
  }
}

export const icmpOk = (avgMs = 4.2, loss = 0): IcmpResult => ({
  status: 'ok', reachable: true, sent: 3, received: 3 - Math.round(loss / 33.3), packetLossPct: loss,
  minMs: avgMs, avgMs, maxMs: avgMs, error: null, durationMs: 20,
});
export const icmpDown = (): IcmpResult => ({
  status: 'unavailable', reachable: false, sent: 3, received: 0, packetLossPct: 100,
  minMs: null, avgMs: null, maxMs: null, error: 'No echo reply (timeout or unreachable)', durationMs: 3000,
});

export class ScriptedIcmp implements IcmpProbe {
  result: IcmpResult = icmpOk();
  /** results returned first, one per call, before falling back to `result` */
  queue: IcmpResult[] = [];
  calls = 0;
  /** when set, ping() waits for it (and honours the abort signal like the real probe) */
  gate: Promise<void> | null = null;
  async ping(_host: string, opts: IcmpOptions): Promise<IcmpResult> {
    this.calls++;
    if (this.gate) {
      await Promise.race([this.gate, new Promise<void>((r) => opts.signal?.addEventListener('abort', () => r(), { once: true }))]);
      if (opts.signal?.aborted) return { ...icmpDown(), status: 'error', packetLossPct: null, error: 'Aborted' };
    }
    return this.queue.shift() ?? this.result;
  }
}

export class ScriptedTcp implements TcpProbe {
  result: (port: number) => TcpPortResult = (port) => ({ port, status: 'open', latencyMs: 2, error: null });
  async check(_h: string, ports: number[], _o: TcpOptions): Promise<TcpPortResult[]> {
    return ports.map(this.result);
  }
}

export const okReading = (value: number) => ({ status: 'ok' as const, value, error: null });

export const ifRow = (ifIndex: number, over: Partial<SnmpInterfaceRow> = {}): SnmpInterfaceRow => ({
  ifIndex, name: `ether${ifIndex}`, alias: null, typeNum: 6, typeName: 'ethernetCsmacd', speedBps: 1_000_000_000,
  adminStatus: 'up', operStatus: 'up', inOctets: 0n, outOctets: 0n, counterBits: 64,
  inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n, ...over,
});

export const snmpOk = (over: Partial<SnmpPollResult> = {}): SnmpPollResult => ({
  status: 'ok', error: null, responseMs: 6, durationMs: 40,
  system: { sysName: 'core-rtr', sysDescr: 'RouterOS CCR2116', sysObjectId: '1.3.6.1.4.1.14988.1', uptimeTicks: 500_000 },
  profileId: 'standard', cpu: okReading(12), memory: okReading(40),
  interfaces: { status: 'ok', error: null, rows: [ifRow(1)] },
  timings: { systemMs: 6, cpuMs: 5, memoryMs: 5, interfacesMs: 24 },
  retransmits: 0,
  timeouts: 0,
  ...over,
});

export const snmpTimeout = (): SnmpPollResult => ({
  status: 'unavailable', error: 'SNMP request timed out', responseMs: null, durationMs: 3000, system: null, profileId: null,
  cpu: { status: 'unavailable', value: null, error: 'SNMP request timed out' },
  memory: { status: 'unavailable', value: null, error: 'SNMP request timed out' },
  interfaces: { status: 'unavailable', error: 'SNMP request timed out', rows: [] },
  timings: { systemMs: 3000, cpuMs: null, memoryMs: null, interfacesMs: null },
  retransmits: 1,
  timeouts: 1,
});

export class ScriptedSnmp implements SnmpProbe {
  result: SnmpPollResult = snmpOk();
  lastTarget: SnmpTarget | null = null;
  lastOptions: SnmpOptions | null = null;
  async poll(target: SnmpTarget, o: SnmpOptions): Promise<SnmpPollResult> {
    this.lastTarget = target;
    this.lastOptions = o;
    return this.result;
  }
}

export class RecordingProvider implements NotificationProvider {
  sent: Array<{ channel: ChannelRuntime; message: NotificationMessage }> = [];
  outcome: () => DeliveryOutcome = () => ({ kind: 'sent', responseStatus: 200 });
  constructor(readonly type: 'telegram' | 'webhook' | 'email') {}
  async send(channel: ChannelRuntime, message: NotificationMessage): Promise<DeliveryOutcome> {
    this.sent.push({ channel, message });
    return this.outcome();
  }
}

export async function createHarness() {
  const db = await createTestDb();
  const clock = new FakeClock();
  const logger = silentLogger();
  const box = new SecretBox({ activeKeyId: 'k1', activeKey: randomBytes(32).toString('base64') });
  const credentials = new CredentialService(db, box);
  const metrics = new PostgresMetricRepository(db);
  const devices = new DeviceService(db, metrics);

  const icmp = new ScriptedIcmp();
  const tcp = new ScriptedTcp();
  const snmp = new ScriptedSnmp();

  const telegram = new RecordingProvider('telegram');
  const webhook = new RecordingProvider('webhook');
  const notifications = new NotificationService(
    db, credentials, [telegram, webhook], { maxAttempts: 3, backoffBaseSec: 30, workerIntervalMs: 1000 }, logger, clock,
  );
  const incidents = new IncidentManager(db, notifications, logger, clock);
  const rules = new RuleService(db);
  rules.setRetireHandler(async (id, reason) => void (await incidents.resolveForRule(id, reason)));
  const evaluator = new AlertEvaluator(db, rules, incidents, logger);
  const channels = new ChannelService(db, credentials);
  const polls = new PollService({ db, metrics, devices, icmp, tcp, snmp, logger, clock, listeners: [evaluator] });

  const tgCred = await credentials.create({ name: 'tg', type: 'telegram_bot', secret: { botToken: '123456:ABC-secret-token' } });

  const newDevice = (over: Record<string, unknown> = {}) =>
    devices.create({
      name: 'core-rtr', host: '10.0.0.1', deviceType: 'router', enabled: true, icmpEnabled: true, tcpPorts: [],
      snmpEnabled: true, snmpAuth: { version: 'v2c', community: 'public-secret-123' }, snmpPort: 161,
      polling: { pollIntervalSec: 30, timeoutMs: 1000, retryCount: 0, failureThreshold: 3, recoveryThreshold: 2, icmpCount: 3 },
      ...over,
    } as never);

  /** poll and move the clock forward like the scheduler would */
  const pollAndAdvance = async (deviceId: string, advanceSec = 30) => {
    const r = await polls.poll(deviceId);
    clock.advance(advanceSec);
    return r;
  };

  return {
    db, clock, box, credentials, metrics, devices, icmp, tcp, snmp, telegram, webhook, notifications, incidents, rules,
    evaluator, channels, polls, tgCred, newDevice, pollAndAdvance,
    async close() {
      await db.close();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Same wiring as createHarness() but with the REAL collectors: real ICMP (OS ping to loopback), real TCP sockets and
 * real SNMP against a FakeSnmpDevice. Only the clock is fake, so rates and debouncing stay deterministic.
 */
export async function createRealHarness() {
  const { SystemPingProbe } = await import('../../src/collectors/icmp/system-ping.js');
  const { NetTcpProbe } = await import('../../src/collectors/tcp/tcp-probe.js');
  const { SnmpCollector } = await import('../../src/collectors/snmp/collector.js');

  const db = await createTestDb();
  const clock = new FakeClock();
  const logger = silentLogger();
  const box = new SecretBox({ activeKeyId: 'k1', activeKey: randomBytes(32).toString('base64') });
  const credentials = new CredentialService(db, box);
  const metrics = new PostgresMetricRepository(db);
  const devices = new DeviceService(db, metrics);

  const webhook = new RecordingProvider('webhook');
  const notifications = new NotificationService(db, credentials, [webhook], { maxAttempts: 3, backoffBaseSec: 30, workerIntervalMs: 1000 }, logger, clock);
  const incidents = new IncidentManager(db, notifications, logger, clock);
  const rules = new RuleService(db);
  rules.setRetireHandler(async (id, reason) => void (await incidents.resolveForRule(id, reason)));
  const evaluator = new AlertEvaluator(db, rules, incidents, logger);
  const channels = new ChannelService(db, credentials);
  const polls = new PollService({
    db, metrics, devices, icmp: new SystemPingProbe(), tcp: new NetTcpProbe(), snmp: new SnmpCollector(), logger, clock, listeners: [evaluator],
  });

  const newDevice = (snmpPort: number, over: Record<string, unknown> = {}) =>
    devices.create({
      name: 'real-dev', host: '127.0.0.1', deviceType: 'router', enabled: true, icmpEnabled: true, tcpPorts: [],
      snmpEnabled: true, snmpAuth: { version: 'v2c', community: 'public' }, snmpPort,
      polling: { pollIntervalSec: 30, timeoutMs: 400, retryCount: 0, failureThreshold: 3, recoveryThreshold: 2, snmpFailureThreshold: 2, snmpRecoveryThreshold: 2, icmpCount: 1 },
      ...over,
    } as never);

  const pollAndAdvance = async (deviceId: string, advanceSec = 10) => {
    const r = await polls.poll(deviceId);
    clock.advance(advanceSec);
    return r;
  };

  return {
    db, clock, credentials, metrics, devices, notifications, incidents, rules, channels, polls, webhook, newDevice, pollAndAdvance,
    async close() {
      await db.close();
    },
  };
}
export type RealHarness = Awaited<ReturnType<typeof createRealHarness>>;
