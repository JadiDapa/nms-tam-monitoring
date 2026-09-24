import { evaluateRule } from '../alerts/evaluate.js';
import type { IncidentManager } from '../alerts/incident-manager.js';
import type { AlertRule, RuleService } from '../alerts/rules.js';
import type { Database } from '../database/db.js';
import type { DeviceService } from '../devices/device-service.js';
import type { DeviceConfig, PollSnapshot } from '../devices/types.js';
import { DEVICE_THRESHOLD_METRICS } from '../metrics/names.js';
import type { MetricRepository, DeviceMetricSample } from '../metrics/repository.js';
import { badRequest } from '../util/errors.js';
import type { FakeClock } from '../util/fake-clock.js';
import type { Logger } from '../util/logger.js';

export interface SimulateRequest {
  deviceIds: string[] | 'all';
  startAt: Date;
  durationSec: number;
  targetAlertCount: number;
}

export interface SimulateResult {
  devicesProcessed: number;
  samplesWritten: number;
  incidentsCreated: number;
  timeRange: { from: string; to: string };
}

/** Healthy baseline ranges. Chosen to sit comfortably below the breach floors so the two never overlap. */
const HEALTHY_RANGES: Record<string, [number, number]> = {
  cpu_pct: [5, 55],
  memory_pct: [20, 70],
  icmp_latency_ms: [1, 60],
  icmp_packet_loss_pct: [0, 2],
};

/** Breach ranges, mirroring the values nms-tam/scripts/demo-alerts.ts uses for the same metrics. */
const BREACH_RANGES: Record<string, [number, number]> = {
  cpu_pct: [91, 99],
  memory_pct: [91, 97],
  icmp_latency_ms: [510, 1410],
  icmp_packet_loss_pct: [8, 58],
};

/** Hard cap on total samples (device-ticks * 4 metrics) a single request may generate. */
const MAX_SAMPLES = 100_000;

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

interface Episode {
  /** index into the device's tick series where the breach run starts */
  startIndex: number;
  length: number;
  metric: string;
}

interface DevicePlan {
  device: DeviceConfig;
  ticks: number[]; // ms epoch, chronological
  rules: AlertRule[]; // enabled metric_threshold rules for this device
  episodes: Episode[]; // breach windows assigned to this device, one metric each
}

export interface SimulationServiceOptions {
  db: Database;
  logger: Logger;
  devices: DeviceService;
  rules: RuleService;
  metrics: MetricRepository;
  incidents: IncidentManager;
  clock: FakeClock;
}

/**
 * Backfills device_metric_samples and (optionally) incidents for a historical window, driven by an admin request.
 * Reuses the real evaluateRule/IncidentManager pipeline (via an injected FakeClock and a no-op notifier held by
 * `incidents`) so simulated alerts behave exactly like real ones would have, without paging anyone.
 */
export class SimulationService {
  constructor(private readonly o: SimulationServiceOptions) {}

  async run(req: SimulateRequest): Promise<SimulateResult> {
    if (req.durationSec <= 0) throw badRequest('durationSec must be positive');
    const endAt = new Date(req.startAt.getTime() + req.durationSec * 1000);

    const deviceList =
      req.deviceIds === 'all'
        ? (await this.o.devices.list({})).items
        : await Promise.all(req.deviceIds.map((id) => this.o.devices.get(id)));
    if (deviceList.length === 0) throw badRequest('No devices resolved for this simulation');

    const plans: DevicePlan[] = [];
    let totalSamples = 0;
    for (const device of deviceList) {
      const ticks = this.buildTicks(req.startAt, req.durationSec, device.polling.pollIntervalSec);
      const rules = (await this.o.rules.enabledFor(this.o.db, device.id)).filter((r) => r.conditionType === 'metric_threshold');
      totalSamples += ticks.length * DEVICE_THRESHOLD_METRICS.length;
      plans.push({ device, ticks, rules, episodes: [] });
    }
    if (totalSamples > MAX_SAMPLES) {
      throw badRequest(`This simulation would produce ${totalSamples} samples; reduce devices/duration (limit ${MAX_SAMPLES})`);
    }

    this.assignEpisodes(plans, req.targetAlertCount);

    const before = await this.o.db.query<{ n: string }>('select count(*)::text as n from incidents');
    const beforeCount = Number(before.rows[0]?.n ?? 0);

    let samplesWritten = 0;
    for (const plan of plans) {
      const values = this.generateValues(plan);
      samplesWritten += await this.writeSamples(plan, values, req.startAt, endAt);
      await this.runAlertPipeline(plan, values);
    }

    const after = await this.o.db.query<{ n: string }>('select count(*)::text as n from incidents');
    const afterCount = Number(after.rows[0]?.n ?? 0);

    return {
      devicesProcessed: plans.length,
      samplesWritten,
      // A request-scoped delta, not a stored flag (no synthetic marker is kept on rows by design). A concurrent real
      // poll opening/resolving incidents during the run would skew this slightly; acceptable for an admin tool.
      incidentsCreated: Math.max(0, afterCount - beforeCount),
      timeRange: { from: req.startAt.toISOString(), to: endAt.toISOString() },
    };
  }

  private buildTicks(startAt: Date, durationSec: number, pollIntervalSec: number): number[] {
    const interval = Math.max(1, pollIntervalSec);
    const n = Math.floor(durationSec / interval) + 1;
    const startMs = startAt.getTime();
    return Array.from({ length: n }, (_, i) => startMs + i * interval * 1000);
  }

  /** Distributes the target alert count round-robin across (device, rule) pairs as non-overlapping breach episodes. */
  private assignEpisodes(plans: DevicePlan[], targetAlertCount: number): void {
    if (targetAlertCount <= 0) return;

    const candidates = plans.flatMap((plan) => plan.rules.filter((r) => r.metric).map((rule) => ({ plan, rule })));
    if (candidates.length === 0) return;

    const per = Math.floor(targetAlertCount / candidates.length);
    const remainder = targetAlertCount % candidates.length;

    candidates.forEach(({ plan, rule }, i) => {
      const episodeCount = per + (i < remainder ? 1 : 0);
      if (episodeCount === 0) return;
      const episodeLen = Math.max(1, rule.triggerAfter);
      // Space episodes apart so each has a chance to resolve (clearAfter) and clear any cooldown before the next starts.
      const gapTicks = Math.max(rule.clearAfter + 2, Math.ceil(rule.cooldownSec / Math.max(1, this.tickIntervalSec(plan))));
      const span = episodeLen + gapTicks;
      const maxFit = Math.floor(plan.ticks.length / span);
      const actual = Math.min(episodeCount, Math.max(0, maxFit));
      if (actual < episodeCount) {
        this.o.logger.warn({
          event: 'simulate_episodes_clamped',
          deviceId: plan.device.id,
          ruleId: rule.id,
          requested: episodeCount,
          fitted: actual,
        });
      }
      for (let e = 0; e < actual; e++) {
        const startIndex = e * span;
        plan.episodes.push({ startIndex, length: episodeLen, metric: rule.metric! });
      }
    });
  }

  private tickIntervalSec(plan: DevicePlan): number {
    return plan.ticks.length > 1 ? (plan.ticks[1]! - plan.ticks[0]!) / 1000 : plan.device.polling.pollIntervalSec;
  }

  private isBreachTick(plan: DevicePlan, tickIndex: number, metric: string): boolean {
    return plan.episodes.some((ep) => ep.metric === metric && tickIndex >= ep.startIndex && tickIndex < ep.startIndex + ep.length);
  }

  /** One value per (tick, metric), generated once and reused for both the written samples and the alert pipeline. */
  private generateValues(plan: DevicePlan): number[][] {
    return plan.ticks.map((_, i) =>
      DEVICE_THRESHOLD_METRICS.map((metric) => {
        const [lo, hi] = (this.isBreachTick(plan, i, metric) ? BREACH_RANGES : HEALTHY_RANGES)[metric]!;
        return rand(lo, hi);
      }),
    );
  }

  private async writeSamples(plan: DevicePlan, values: number[][], from: Date, to: Date): Promise<number> {
    const samples: DeviceMetricSample[] = [];
    for (let i = 0; i < plan.ticks.length; i++) {
      const time = new Date(plan.ticks[i]!);
      DEVICE_THRESHOLD_METRICS.forEach((metric, m) => {
        samples.push({ time, deviceId: plan.device.id, metric, dimension: null, value: values[i]![m]!, status: 'ok', error: null });
      });
    }

    // Overwrite: device_metric_samples has no unique constraint, so "same timestamp wins" means delete first.
    // This is a deliberate, documented exception to MetricRepository's append-only contract — done directly against
    // the database rather than through the repository interface, which intentionally has no delete/overwrite method.
    await this.o.db.query('delete from device_metric_samples where device_id = $1 and time >= $2 and time <= $3', [plan.device.id, from, to]);
    await this.o.metrics.writeDeviceMetrics(samples);
    return samples.length;
  }

  private async runAlertPipeline(plan: DevicePlan, values: number[][]): Promise<void> {
    if (plan.rules.length === 0) return;
    const device = { id: plan.device.id, name: plan.device.name };

    for (let i = 0; i < plan.ticks.length; i++) {
      const at = plan.ticks[i]!;
      const snap: PollSnapshot = {
        deviceId: plan.device.id,
        deviceName: plan.device.name,
        at: new Date(at),
        reachability: { state: 'UP', transition: null },
        snmp: plan.device.snmpEnabled ? { state: 'UP', transition: null } : null,
        metrics: Object.fromEntries(
          DEVICE_THRESHOLD_METRICS.map((metric, m) => [metric, { value: values[i]![m]!, status: 'ok' as const, error: null }]),
        ),
        interfaces: [],
        interfacesCollected: false,
      };

      this.o.clock.set(at);
      for (const rule of plan.rules) {
        try {
          const evaluation = evaluateRule(rule, snap);
          for (const subject of evaluation.subjects) await this.o.incidents.processSubject(rule, device, subject);
        } catch (err) {
          this.o.logger.error({ event: 'simulate_rule_failed', deviceId: device.id, ruleId: rule.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
}
