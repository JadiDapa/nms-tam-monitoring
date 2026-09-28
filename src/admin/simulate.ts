import { randomUUID } from 'node:crypto';
import type { Database } from '../database/db.js';
import type { DeviceService } from '../devices/device-service.js';
import type { InterfaceRepository } from '../devices/interface-repository.js';
import type { MetricRepository, InterfaceSample } from '../metrics/repository.js';
import { badRequest, notFound } from '../util/errors.js';
import { errorMessage, type Logger } from '../util/logger.js';

export interface SimulateWindow {
  /** 0 = Sunday .. 6 = Saturday (UTC), days of week this window applies on */
  weekdays: number[];
  /** seconds since UTC midnight, inclusive */
  dailyStartSec: number;
  /** seconds since UTC midnight, exclusive */
  dailyEndSec: number;
  trafficMinBps: number;
  trafficMaxBps: number;
}

export interface SimulateRequest {
  deviceIds: string[];
  startAt: Date;
  endAt: Date;
  /** Checked in order; the first window whose weekday + time-of-day covers a tick wins. */
  windows: SimulateWindow[];
  /** Applies to any tick no window matches. */
  defaultTrafficMinBps: number;
  defaultTrafficMaxBps: number;
}

export interface SimulateResult {
  devicesProcessed: number;
  interfacesProcessed: number;
  samplesWritten: number;
  timeRange: { from: string; to: string };
}

export interface SimulateJobStarted {
  jobId: string;
  totalSamples: number;
  devicesTotal: number;
}

export interface DeviceProgress {
  deviceId: string;
  deviceName: string;
  status: 'pending' | 'running' | 'done';
  interfacesTotal: number;
  interfacesDone: number;
  samplesTotal: number;
  samplesWritten: number;
}

export interface SimulateJobStatus {
  status: 'running' | 'done' | 'error';
  startedAt: string;
  totalSamples: number;
  samplesWritten: number;
  devicesTotal: number;
  devicesProcessed: number;
  interfacesProcessed: number;
  devices: DeviceProgress[];
  result: SimulateResult | null;
  error: string | null;
}

interface Job extends SimulateJobStatus {
  createdAt: number;
}

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** How long a finished (done/error) job stays queryable before being swept, so a slow last poll still sees it. */
const JOB_RETENTION_MS = 10 * 60_000;

/**
 * Real-time half-life for the traffic random walk to close the gap toward a new target range. Expressed in seconds
 * (not ticks) so the transition takes the same wall-clock time regardless of a device's poll interval: crossing a
 * window boundary eases the value toward the new range over several minutes instead of jumping on the next tick.
 */
const TRANSITION_HALF_LIFE_SEC = 10 * 60;
/** Per-tick jitter, as a fraction of the target range's half-width, layered on top of the walk toward the target. */
const NOISE_FRACTION = 0.06;
/** How far past [min, max] the walk is allowed to drift before being clamped back, as a fraction of the half-width. */
const OVERSHOOT_FRACTION = 0.15;

export interface SimulationServiceOptions {
  db: Database;
  logger: Logger;
  devices: DeviceService;
  interfaces: InterfaceRepository;
  metrics: MetricRepository;
}

type Plan = { deviceId: string; deviceName: string; ticks: number[]; interfaceIds: string[] };

/**
 * Backfills interface_samples (traffic: in/out bps) for a historical window, driven by an admin request.
 * Ticks are generated at each device's own poll interval across the whole range; each tick's target traffic range
 * comes from the first matching window config (by weekday + time-of-day), or the request's default range if none
 * match. Values follow a mean-reverting random walk toward that target rather than being sampled independently per
 * tick, so traffic looks natural and eases across window boundaries instead of jumping.
 *
 * Runs as a background job so the admin UI can poll for progress: `start()` validates the request and plans the
 * work (fast — just reads device/interface config), then kicks off the actual writing without waiting for it.
 * Job state lives in memory only; it does not survive an engine restart, and is swept a while after completion.
 */
export class SimulationService {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly o: SimulationServiceOptions) {}

  async start(req: SimulateRequest): Promise<SimulateJobStarted> {
    if (req.endAt.getTime() <= req.startAt.getTime()) throw badRequest('endAt must be after startAt');
    if (req.defaultTrafficMaxBps <= req.defaultTrafficMinBps) throw badRequest('default traffic max must be greater than default traffic min');
    if (req.deviceIds.length === 0) throw badRequest('No devices selected for this simulation');
    for (const w of req.windows) {
      if (w.weekdays.length === 0) throw badRequest('Each window needs at least one weekday');
      if (w.dailyEndSec <= w.dailyStartSec) throw badRequest('Each window\'s daily end time must be after its daily start time');
      if (w.trafficMaxBps <= w.trafficMinBps) throw badRequest('Each window\'s traffic max must be greater than its traffic min');
    }

    const plans: Plan[] = [];
    let totalSamples = 0;
    for (const deviceId of req.deviceIds) {
      const device = await this.o.devices.get(deviceId);
      const ticks = this.buildTicks(req, device.polling.pollIntervalSec);
      const interfaceRecords = await this.o.interfaces.listForDevice(this.o.db, deviceId);
      const interfaceIds = interfaceRecords.filter((i) => i.active && i.monitored).map((i) => i.id);
      totalSamples += ticks.length * interfaceIds.length;
      plans.push({ deviceId, deviceName: device.name, ticks, interfaceIds });
    }

    const jobId = randomUUID();
    const now = Date.now();
    this.jobs.set(jobId, {
      status: 'running',
      startedAt: new Date(now).toISOString(),
      totalSamples,
      samplesWritten: 0,
      devicesTotal: plans.length,
      devicesProcessed: 0,
      interfacesProcessed: 0,
      devices: plans.map((p) => ({
        deviceId: p.deviceId,
        deviceName: p.deviceName,
        status: 'pending',
        interfacesTotal: p.interfaceIds.length,
        interfacesDone: 0,
        samplesTotal: p.ticks.length * p.interfaceIds.length,
        samplesWritten: 0,
      })),
      result: null,
      error: null,
      createdAt: now,
    });

    void this.execute(jobId, req, plans);

    return { jobId, totalSamples, devicesTotal: plans.length };
  }

  getJob(jobId: string): SimulateJobStatus {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound('Simulation job', jobId);
    const { status, startedAt, totalSamples, samplesWritten, devicesTotal, devicesProcessed, interfacesProcessed, devices, result, error } = job;
    return { status, startedAt, totalSamples, samplesWritten, devicesTotal, devicesProcessed, interfacesProcessed, devices, result, error };
  }

  private async execute(jobId: string, req: SimulateRequest, plans: Plan[]): Promise<void> {
    const job = this.jobs.get(jobId)!;
    try {
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]!;
        const deviceProgress = job.devices[i]!;
        deviceProgress.status = 'running';
        for (const interfaceId of plan.interfaceIds) {
          const written = await this.writeInterfaceTraffic(plan.deviceId, interfaceId, plan.ticks, req);
          job.samplesWritten += written;
          job.interfacesProcessed += 1;
          deviceProgress.samplesWritten += written;
          deviceProgress.interfacesDone += 1;
        }
        deviceProgress.status = 'done';
        job.devicesProcessed += 1;
      }
      job.result = {
        devicesProcessed: plans.length,
        interfacesProcessed: job.interfacesProcessed,
        samplesWritten: job.samplesWritten,
        timeRange: { from: req.startAt.toISOString(), to: req.endAt.toISOString() },
      };
      job.status = 'done';
    } catch (err) {
      job.status = 'error';
      job.error = errorMessage(err);
      this.o.logger.error({ event: 'simulate_job_failed', jobId, error: job.error });
    } finally {
      setTimeout(() => this.jobs.delete(jobId), JOB_RETENTION_MS).unref();
    }
  }

  /** Every tick at the device's poll interval in [startAt, endAt) — every tick gets a value, via a window or the default. */
  private buildTicks(req: SimulateRequest, pollIntervalSec: number): number[] {
    const interval = Math.max(1, pollIntervalSec) * 1000;
    const ticks: number[] = [];
    for (let t = req.startAt.getTime(); t < req.endAt.getTime(); t += interval) ticks.push(t);
    return ticks;
  }

  /** The first window (in list order) whose weekday + time-of-day covers `t`, or the request's default range. */
  private resolveTarget(t: number, req: SimulateRequest): { min: number; max: number } {
    const d = new Date(t);
    const day = d.getUTCDay();
    const secOfDay = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    for (const w of req.windows) {
      if (w.weekdays.includes(day) && secOfDay >= w.dailyStartSec && secOfDay < w.dailyEndSec) {
        return { min: w.trafficMinBps, max: w.trafficMaxBps };
      }
    }
    return { min: req.defaultTrafficMinBps, max: req.defaultTrafficMaxBps };
  }

  /**
   * A mean-reverting random walk, one direction (in or out) at a time: each tick eases toward the midpoint of
   * whichever range applies "now" (a window's, or the default) plus small bounded jitter, instead of sampling each
   * tick independently. Crossing from one config's range into another's only moves the target the walk eases
   * toward, so the value glides across the boundary over several minutes rather than jumping on the next sample.
   */
  private walkSeries(ticks: number[], req: SimulateRequest): number[] {
    const series: number[] = [];
    let value: number | null = null;
    let prevT: number | null = null;
    for (const t of ticks) {
      const { min, max } = this.resolveTarget(t, req);
      const mid = (min + max) / 2;
      const halfRange = Math.max(1e-9, (max - min) / 2);
      if (value === null) {
        value = rand(min, max);
      } else {
        const dtSec = (t - prevT!) / 1000;
        const alpha = 1 - Math.pow(0.5, dtSec / TRANSITION_HALF_LIFE_SEC);
        const noise = rand(-halfRange * NOISE_FRACTION, halfRange * NOISE_FRACTION);
        value = clamp(value + alpha * (mid - value) + noise, min - halfRange * OVERSHOOT_FRACTION, max + halfRange * OVERSHOOT_FRACTION);
      }
      series.push(Math.max(0, value));
      prevT = t;
    }
    return series;
  }

  private async writeInterfaceTraffic(deviceId: string, interfaceId: string, ticks: number[], req: SimulateRequest): Promise<number> {
    if (ticks.length === 0) return 0;

    const inSeries = this.walkSeries(ticks, req);
    const outSeries = this.walkSeries(ticks, req);

    const samples: InterfaceSample[] = ticks.map((t, i) => ({
      time: new Date(t),
      deviceId,
      interfaceId,
      inOctets: null,
      outOctets: null,
      inErrors: null,
      outErrors: null,
      inDiscards: null,
      outDiscards: null,
      inBps: inSeries[i]!,
      outBps: outSeries[i]!,
      rateNote: null,
      counterBits: null,
      adminStatus: 'up',
      operStatus: 'up',
      status: 'ok',
      error: null,
    }));

    // Overwrite: interface_samples has no unique constraint, so "same timestamp wins" means deleting exactly the
    // timestamps being (re)written first.
    await this.o.db.query('delete from interface_samples where interface_id = $1 and time = any($2::timestamptz[])', [
      interfaceId,
      ticks.map((t) => new Date(t)),
    ]);
    await this.o.metrics.writeInterfaceSamples(samples);
    return samples.length;
  }
}
