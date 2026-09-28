import type { IcmpProbe, IcmpResult } from '../collectors/icmp/types.js';
import type { SnmpPollResult, SnmpProbe } from '../collectors/snmp/types.js';
import { tcpShowsHostAlive, type TcpPortResult, type TcpProbe } from '../collectors/tcp/tcp-probe.js';
import { errorReading, type CollectStatus, type Reading } from '../collectors/types.js';
import type { Database } from '../database/db.js';
import { Metric } from '../metrics/names.js';
import type { DeviceMetricSample, InterfaceSample, MetricRepository } from '../metrics/repository.js';
import { computeRate, deviceRebooted } from '../metrics/traffic.js';
import type { PollSummary } from '../scheduler/scheduler.js';
import type { Clock } from '../util/clock.js';
import { errorMessage, type Logger } from '../util/logger.js';
import type { DeviceService } from './device-service.js';
import { isRecovery, nextHealth, type HealthState, type Thresholds, type Transition } from './health-state.js';
import { InterfaceRepository } from './interface-repository.js';
import { StateRepository } from './state-repository.js';
import type { DeviceConfig, PollListener, PollSnapshot } from './types.js';

export interface PollDeps {
  db: Database;
  metrics: MetricRepository;
  devices: DeviceService;
  icmp: IcmpProbe;
  tcp: TcpProbe;
  snmp: SnmpProbe;
  logger: Logger;
  clock: Clock;
  listeners?: PollListener[];
}

export interface SnmpReport {
  status: SnmpPollResult['status'];
  error: string | null;
  responseMs: number | null;
  /** wall-clock per SNMP step, to locate slow operations */
  timings: SnmpPollResult['timings'];
  /** packets re-sent after a per-request timeout during this poll */
  retransmits: number;
  /** operations that timed out after all retries */
  timeouts: number;
  system: SnmpPollResult['system'];
  profile: string | null;
  cpu: Reading;
  memory: Reading;
  interfaces: { status: CollectStatus; error: string | null; count: number };
}

export interface PollReport {
  deviceId: string;
  startedAt: string;
  durationMs: number;
  reachable: boolean;
  icmp: IcmpResult | null;
  tcp: TcpPortResult[] | null;
  snmp: SnmpReport | null;
  state: { reachability: HealthState; snmp: HealthState | null };
  transitions: Array<{ kind: 'reachability' | 'snmp'; from: HealthState; to: HealthState; reason: string }>;
  metricsWritten: number;
  interfaceSamplesWritten: number;
  errors: string[];
}

const failedSnmp = (status: 'unavailable' | 'error', error: string): SnmpPollResult => ({
  status,
  error,
  responseMs: null,
  durationMs: 0,
  system: null,
  profileId: null,
  cpu: { status, value: null, error },
  memory: { status, value: null, error },
  interfaces: { status, error, rows: [] },
  timings: { systemMs: null, cpuMs: null, memoryMs: null, interfacesMs: null },
  retransmits: 0,
  timeouts: 0,
});

export class PollService {
  private readonly ifaces = new InterfaceRepository();
  private readonly states = new StateRepository();
  private readonly listeners: PollListener[];

  constructor(private readonly d: PollDeps) {
    this.listeners = d.listeners ?? [];
  }

  addListener(l: PollListener): void {
    this.listeners.push(l);
  }

  private readonly lastReports = new Map<string, PollReport>();

  /** Most recent full report of a device (kept in memory so POST /devices/:id/poll can return it). */
  lastReport(deviceId: string): PollReport | undefined {
    return this.lastReports.get(deviceId);
  }

  forgetDevice(deviceId: string): void {
    this.lastReports.delete(deviceId);
  }

  /** Adapter for the scheduler. */
  async runForScheduler(deviceId: string, signal: AbortSignal): Promise<PollSummary> {
    const report = await this.poll(deviceId, signal);
    this.lastReports.set(deviceId, report);
    return { deviceId, ok: report.reachable, durationMs: report.durationMs };
  }

  async poll(deviceId: string, signal?: AbortSignal): Promise<PollReport> {
    const { logger: log, clock } = this.d;
    const t0 = performance.now();
    const startedAt = new Date(clock.now());
    const device = await this.d.devices.get(deviceId);
    log.debug({ event: 'poll_started', deviceId, host: device.host });

    const [icmp, tcp, snmp] = await Promise.all([this.runIcmp(device, signal), this.runTcp(device, signal), this.runSnmp(device, signal)]);
    if (signal?.aborted) throw new Error('poll aborted');
    const collectMs = Math.round(performance.now() - t0);

    const at = new Date(clock.now());
    const errors: string[] = [];

    // ---- per-protocol failure logging (structured, no secrets) --------------------------------------------------
    if (icmp && icmp.status !== 'ok') {
      errors.push(`icmp: ${icmp.error}`);
      log.warn({ event: 'poll_failed', deviceId, protocol: 'icmp', error: icmp.error, durationMs: icmp.durationMs });
    }
    if (tcp) {
      for (const r of tcp.filter((x) => !tcpShowsHostAlive(x))) {
        errors.push(`tcp/${r.port}: ${r.error}`);
        log.warn({ event: 'poll_failed', deviceId, protocol: 'tcp', port: r.port, error: r.error });
      }
    }
    if (snmp && snmp.status !== 'ok') {
      errors.push(`snmp: ${snmp.error}`);
      log.warn({
        event: snmp.status === 'unavailable' ? 'snmp_timeout' : 'poll_failed',
        deviceId,
        protocol: 'snmp',
        error: snmp.error,
        durationMs: snmp.durationMs,
      });
    }

    // ---- reachability: any positive evidence from an enabled check ----------------------------------------------
    const evidence: boolean[] = [];
    if (icmp) evidence.push(icmp.reachable);
    if (tcp) evidence.push(tcp.some(tcpShowsHostAlive));
    if (snmp) evidence.push(snmp.status === 'ok');
    const reachable = evidence.some(Boolean);

    // ---- metric samples ------------------------------------------------------------------------------------------
    const deviceSamples = [
      ...this.icmpSamples(device.id, at, icmp),
      ...this.tcpSamples(device.id, at, tcp),
      ...this.snmpSamples(device.id, at, snmp),
      ...this.diagnosticSamples(device.id, at, collectMs, snmp),
    ];

    // ---- one transaction: state machines, interfaces, device info -------------------------------------------------
    const reachThresholds: Thresholds = {
      failureThreshold: device.polling.failureThreshold,
      recoveryThreshold: device.polling.recoveryThreshold,
    };
    const snmpThresholds: Thresholds = {
      failureThreshold: device.polling.snmpFailureThreshold,
      recoveryThreshold: device.polling.snmpRecoveryThreshold,
    };

    const persisted = await this.d.db.transaction(async (tx) => {
      const prev = await this.states.get(tx, device.id);

      // interfaces + traffic rates
      const ifaceSamples: InterfaceSample[] = [];
      const snapshotInterfaces: PollSnapshot['interfaces'] = [];
      let interfacesCollected = false;
      if (snmp && snmp.status === 'ok' && snmp.interfaces.status === 'ok') {
        interfacesCollected = true;
        const previous = new Map((await this.ifaces.listForDevice(tx, device.id)).map((i) => [i.ifIndex, i]));
        const ids = await this.ifaces.upsertFromPoll(tx, device.id, snmp.interfaces.rows, at);
        // The walk was complete: interfaces that were known and active but are no longer reported become INACTIVE
        // (never deleted). Dynamic PPP/L2TP interfaces come and go; that is not a device failure.
        const gone = await this.ifaces.markMissingInactive(tx, device.id, snmp.interfaces.rows.map((r) => r.ifIndex), at);
        for (const g of gone) log.info({ event: 'interface_inactive', deviceId, interfaceId: g.id, ifIndex: g.ifIndex, name: g.name });
        const rebooted = deviceRebooted(prev.lastUptimeTicks, snmp.system?.uptimeTicks ?? null);

        for (const row of snmp.interfaces.rows) {
          const meta = ids.get(row.ifIndex);
          if (!meta) continue;
          const before = previous.get(row.ifIndex);
          const monitored = before ? before.monitored : meta.monitored;
          if (before && !before.active) {
            log.info({ event: 'interface_reactivated', deviceId, interfaceId: meta.id, ifIndex: row.ifIndex, name: row.name });
          }

          snapshotInterfaces.push({
            interfaceId: meta.id,
            ifIndex: row.ifIndex,
            name: row.name,
            monitored,
            // "ever up" = seen up in an earlier poll, or up right now
            everUp: (before?.lastOperUpAt ?? null) !== null || row.operStatus === 'up',
            adminStatus: row.adminStatus,
            operStatus: row.operStatus,
            inBps: null,
            outBps: null,
          });
          if (!monitored) continue;

          const haveCounters = row.inOctets !== null && row.outOctets !== null && row.counterBits !== null;
          const rate = haveCounters
            ? computeRate(
                before?.active === false ? null : (before?.lastCounters ?? null),
                { inOctets: row.inOctets!, outOctets: row.outOctets!, at: at.getTime(), bits: row.counterBits! },
                { deviceRebooted: rebooted, speedBps: row.speedBps },
              )
            : { inBps: null, outBps: null, note: null };

          snapshotInterfaces[snapshotInterfaces.length - 1]!.inBps = rate.inBps;
          snapshotInterfaces[snapshotInterfaces.length - 1]!.outBps = rate.outBps;

          ifaceSamples.push({
            time: at,
            deviceId: device.id,
            interfaceId: meta.id,
            inOctets: row.inOctets,
            outOctets: row.outOctets,
            inErrors: row.inErrors,
            outErrors: row.outErrors,
            inDiscards: row.inDiscards,
            outDiscards: row.outDiscards,
            inBps: rate.inBps,
            outBps: rate.outBps,
            rateNote: rate.note,
            counterBits: row.counterBits,
            adminStatus: row.adminStatus,
            operStatus: row.operStatus,
            status: haveCounters ? 'ok' : 'not_supported',
            error: haveCounters ? null : 'device did not report octet counters for this interface',
          });
        }
      }

      // health state machines
      const reach = nextHealth(prev.reachability, reachable, reachThresholds, at);
      const snmpHealth = device.snmpEnabled && snmp ? nextHealth(prev.snmp, snmp.status === 'ok', snmpThresholds, at) : null;

      const transitions: Array<{ kind: 'reachability' | 'snmp'; t: Transition }> = [];
      if (reach.transition) transitions.push({ kind: 'reachability', t: reach.transition });
      if (snmpHealth?.transition) transitions.push({ kind: 'snmp', t: snmpHealth.transition });
      for (const x of transitions) await this.states.addHistory(tx, device.id, x.kind, x.t, at);

      const uptime = snmp?.system?.uptimeTicks ?? null;
      await this.states.save(tx, {
        deviceId: device.id,
        reachability: reach.next,
        snmp: snmpHealth ? snmpHealth.next : prev.snmp,
        lastPollAt: at,
        lastPollDurationMs: Math.round(performance.now() - t0),
        lastSuccessAt: reachable ? at : prev.lastSuccessAt,
        lastError: errors.length > 0 ? errors.join('; ').slice(0, 1000) : null,
        lastUptimeTicks: uptime ?? prev.lastUptimeTicks,
      });

      // real device identity, when the device told us
      if (snmp && snmp.status === 'ok' && snmp.system) {
        await tx.query(
          `update devices set sys_name = coalesce($2, sys_name), sys_descr = coalesce($3, sys_descr),
             sys_object_id = coalesce($4, sys_object_id), snmp_profile = coalesce($5, snmp_profile), info_updated_at = $6
           where id = $1`,
          [device.id, snmp.system.sysName, snmp.system.sysDescr, snmp.system.sysObjectId, snmp.profileId, at],
        );
      }

      return { ifaceSamples, snapshotInterfaces, interfacesCollected, reach, snmpHealth, transitions };
    });

    // ---- append metrics (a storage failure must not hide the device health we already computed) -------------------
    let metricsWritten = 0;
    let interfaceSamplesWritten = 0;
    try {
      await this.d.metrics.writeDeviceMetrics(deviceSamples);
      metricsWritten = deviceSamples.length;
      await this.d.metrics.writeInterfaceSamples(persisted.ifaceSamples);
      interfaceSamplesWritten = persisted.ifaceSamples.length;
    } catch (err) {
      errors.push(`metrics store: ${errorMessage(err)}`);
      log.error({ event: 'metrics_write_failed', deviceId, error: errorMessage(err) });
    }

    for (const x of persisted.transitions) {
      log.info({
        event: 'device_state_changed',
        deviceId,
        deviceName: device.name,
        kind: x.kind,
        from: x.t.from,
        to: x.t.to,
        reason: x.t.reason,
        recovered: isRecovery(x.t),
      });
    }

    // ---- hand real observations to alert evaluation --------------------------------------------------------------
    const snapshot: PollSnapshot = {
      deviceId: device.id,
      deviceName: device.name,
      at,
      reachability: { state: persisted.reach.next.state, transition: persisted.reach.transition },
      snmp: persisted.snmpHealth ? { state: persisted.snmpHealth.next.state, transition: persisted.snmpHealth.transition } : null,
      metrics: Object.fromEntries(
        deviceSamples.filter((s) => s.dimension === null).map((s) => [s.metric, { value: s.value, status: s.status, error: s.error }]),
      ),
      interfaces: persisted.snapshotInterfaces,
      interfacesCollected: persisted.interfacesCollected,
    };
    for (const l of this.listeners) {
      try {
        await l.onPollCompleted(snapshot);
      } catch (err) {
        errors.push(`alerting: ${errorMessage(err)}`);
        log.error({ event: 'alert_evaluation_failed', deviceId, error: errorMessage(err) });
      }
    }

    const durationMs = Math.round(performance.now() - t0);
    log.info({
      event: 'poll_completed',
      deviceId,
      reachable,
      state: persisted.reach.next.state,
      snmpState: persisted.snmpHealth?.next.state ?? null,
      durationMs,
      collectMs,
      icmpAttempts: icmp?.attempts ?? null,
      snmpRetransmits: snmp?.retransmits ?? null,
      snmpTimeouts: snmp?.timeouts ?? null,
      snmpTimingsMs: snmp?.timings ?? null,
    });

    return {
      deviceId: device.id,
      startedAt: startedAt.toISOString(),
      durationMs,
      reachable,
      icmp,
      tcp,
      snmp: snmp
        ? {
            status: snmp.status,
            error: snmp.error,
            responseMs: snmp.responseMs,
            timings: snmp.timings,
            retransmits: snmp.retransmits,
            timeouts: snmp.timeouts,
            system: snmp.system,
            profile: snmp.profileId,
            cpu: snmp.cpu,
            memory: snmp.memory,
            interfaces: { status: snmp.interfaces.status, error: snmp.interfaces.error, count: snmp.interfaces.rows.length },
          }
        : null,
      state: { reachability: persisted.reach.next.state, snmp: persisted.snmpHealth?.next.state ?? null },
      transitions: persisted.transitions.map((x) => ({ kind: x.kind, from: x.t.from, to: x.t.to, reason: x.t.reason })),
      metricsWritten,
      interfaceSamplesWritten,
      errors,
    };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // collectors with retry semantics (retryCount = extra attempts after a failed attempt)
  // ------------------------------------------------------------------------------------------------------------------
  private async runIcmp(device: DeviceConfig, signal?: AbortSignal): Promise<IcmpResult | null> {
    if (!device.icmpEnabled) return null;
    const opts = { count: device.polling.icmpCount, timeoutMs: device.polling.timeoutMs, signal };
    let attempts = 1;
    let r = await this.d.icmp.ping(device.host, opts);
    // Only a burst with ZERO replies is retried (a partly lost burst is a real measurement, not a failure).
    for (let i = 0; i < device.polling.retryCount && r.status !== 'ok' && !signal?.aborted; i++) {
      attempts += 1;
      r = await this.d.icmp.ping(device.host, opts);
    }
    return { ...r, attempts };
  }

  private async runTcp(device: DeviceConfig, signal?: AbortSignal): Promise<TcpPortResult[] | null> {
    if (device.tcpPorts.length === 0) return null;
    return this.d.tcp.check(device.host, device.tcpPorts, { timeoutMs: device.polling.timeoutMs, retries: device.polling.retryCount, signal });
  }

  private async runSnmp(device: DeviceConfig, signal?: AbortSignal): Promise<SnmpPollResult | null> {
    if (!device.snmpEnabled) return null;
    if (!device.snmpAuth) return failedSnmp('error', 'SNMP is enabled but no SNMP auth is configured');
    try {
      return await this.d.snmp.poll(
        { host: device.host, port: device.snmpPort, auth: device.snmpAuth },
        { timeoutMs: device.polling.timeoutMs, retries: device.polling.retryCount, signal },
      );
    } catch (err) {
      return failedSnmp('error', errorMessage(err));
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // result -> metric samples. Only real values get status 'ok'.
  // ------------------------------------------------------------------------------------------------------------------
  private sample(deviceId: string, time: Date, metric: string, dimension: string | null, r: Reading): DeviceMetricSample {
    return { time, deviceId, metric, dimension, value: r.status === 'ok' ? r.value : null, status: r.status, error: r.error };
  }

  private icmpSamples(deviceId: string, time: Date, icmp: IcmpResult | null): DeviceMetricSample[] {
    if (!icmp) return [];
    const failStatus: CollectStatus = icmp.status === 'error' ? 'error' : 'unavailable';
    const latency: Reading =
      icmp.status === 'ok' && icmp.avgMs !== null
        ? { status: 'ok', value: icmp.avgMs, error: null }
        : { status: failStatus, value: null, error: icmp.error ?? 'no latency measured' };
    // 100 % loss is a genuine measurement; only a probe that could not run has no loss figure.
    const loss: Reading =
      icmp.packetLossPct !== null
        ? { status: 'ok', value: icmp.packetLossPct, error: null }
        : errorReading(icmp.error ?? 'ICMP probe could not run');
    return [
      this.sample(deviceId, time, Metric.IcmpLatencyMs, null, latency),
      this.sample(deviceId, time, Metric.IcmpPacketLossPct, null, loss),
    ];
  }

  private tcpSamples(deviceId: string, time: Date, tcp: TcpPortResult[] | null): DeviceMetricSample[] {
    if (!tcp) return [];
    const out: DeviceMetricSample[] = [];
    for (const r of tcp) {
      const dim = String(r.port);
      if (r.status === 'open') {
        out.push(this.sample(deviceId, time, Metric.TcpPortOpen, dim, { status: 'ok', value: 1, error: null }));
        if (r.latencyMs !== null) out.push(this.sample(deviceId, time, Metric.TcpConnectMs, dim, { status: 'ok', value: r.latencyMs, error: null }));
      } else if (r.status === 'closed') {
        out.push(this.sample(deviceId, time, Metric.TcpPortOpen, dim, { status: 'ok', value: 0, error: null }));
      } else {
        out.push(
          this.sample(deviceId, time, Metric.TcpPortOpen, dim, {
            status: r.status === 'timeout' ? 'unavailable' : 'error',
            value: null,
            error: r.error,
          }),
        );
      }
    }
    return out;
  }

  /**
   * Real measurements about the poll itself (how long collection took, how many SNMP packets had to be re-sent,
   * how long each SNMP step took). They let an operator see WHY a poll was slow without reading logs.
   */
  private diagnosticSamples(deviceId: string, time: Date, collectMs: number, snmp: SnmpPollResult | null): DeviceMetricSample[] {
    const ok = (value: number): Reading => ({ status: 'ok', value, error: null });
    const out = [this.sample(deviceId, time, Metric.PollCollectMs, null, ok(collectMs))];
    if (snmp) {
      out.push(this.sample(deviceId, time, Metric.SnmpRetransmits, null, ok(snmp.retransmits)));
      for (const [step, ms] of Object.entries(snmp.timings) as Array<[string, number | null]>) {
        if (ms !== null) out.push(this.sample(deviceId, time, Metric.SnmpStepMs, step.replace(/Ms$/, ''), ok(ms)));
      }
    }
    return out;
  }

  private snmpSamples(deviceId: string, time: Date, snmp: SnmpPollResult | null): DeviceMetricSample[] {
    if (!snmp) return [];
    const agentDown = snmp.status !== 'ok';
    const down: Reading = { status: snmp.status === 'ok' ? 'unavailable' : snmp.status, value: null, error: snmp.error };
    const ticks = snmp.system?.uptimeTicks ?? null;
    const uptime: Reading = agentDown
      ? down
      : ticks !== null
        ? { status: 'ok', value: ticks / 100, error: null }
        : { status: 'not_supported', value: null, error: 'device did not report sysUpTime' };
    const ifCount: Reading = agentDown
      ? down
      : snmp.interfaces.status === 'ok'
        ? { status: 'ok', value: snmp.interfaces.rows.length, error: null }
        : { status: snmp.interfaces.status, value: null, error: snmp.interfaces.error };
    const response: Reading =
      !agentDown && snmp.responseMs !== null ? { status: 'ok', value: snmp.responseMs, error: null } : down;

    return [
      this.sample(deviceId, time, Metric.SnmpResponseMs, null, response),
      this.sample(deviceId, time, Metric.CpuPct, null, snmp.cpu),
      this.sample(deviceId, time, Metric.MemoryPct, null, snmp.memory),
      this.sample(deviceId, time, Metric.SysUptimeSeconds, null, uptime),
      this.sample(deviceId, time, Metric.SnmpInterfaceCount, null, ifCount),
    ];
  }
}
