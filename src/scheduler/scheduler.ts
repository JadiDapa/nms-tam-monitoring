import { createHash } from 'node:crypto';
import type { Clock } from '../util/clock.js';
import { errorMessage, type Logger } from '../util/logger.js';
import type { WorkerPool } from './worker-pool.js';

export interface ScheduleEntry {
  deviceId: string;
  intervalSec: number;
}

export interface PollSummary {
  deviceId: string;
  ok: boolean;
  durationMs: number;
  /** set when the poll itself failed (as opposed to the device being unreachable) */
  error?: string;
}

export interface SchedulerOptions {
  pool: WorkerPool;
  clock: Clock;
  logger: Logger;
  /** current set of devices that should be polled + their intervals (called on start and on every sync) */
  loadSchedule: () => Promise<ScheduleEntry[]>;
  /** performs one poll; honours `signal` (aborted on hard timeout / shutdown) */
  runPoll: (deviceId: string, signal: AbortSignal) => Promise<PollSummary>;
  tickMs?: number;
  syncIntervalSec?: number;
  /** a poll running longer than this is abandoned (its result is discarded) and the device becomes schedulable again */
  hardTimeoutMs?: number;
  /** spread first polls over the interval so hundreds of devices do not all fire in the same second */
  jitter?: boolean;
}

interface Entry {
  deviceId: string;
  intervalMs: number;
  nextRunAt: number;
}

/**
 * One 1-second tick, but every device has its OWN next-due time (this is not a "poll everything every N seconds" loop).
 *
 * Semantics
 *  - a device is polled when `now >= nextRunAt`, and never while one of its polls is still running (exactly one
 *    active poll per device, also across manual and scheduled polls)
 *  - while a poll runs the device is not schedulable; `nextRunAt` is (re)computed when the poll FINISHES:
 *        poll took <  interval : nextRunAt = pollStart  + interval   (steady cadence, no drift)
 *        poll took >= interval : nextRunAt = pollFinish + interval   (missed slots are SKIPPED, never caught up)
 *    so a slow poll can never be followed by an immediate back-to-back poll or a burst of catch-up polls
 *  - the first poll of each device is spread over its interval by a deterministic hash (no thundering herd)
 *  - concurrency is bounded by the WorkerPool; jobs waiting in the pool do not count as "started"
 *  - a poll exceeding hardTimeoutMs is aborted (collectors stop, results are discarded); the device becomes
 *    schedulable again one interval later
 *  - a failing poll never stops the scheduler
 */
export class Scheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, { promise: Promise<PollSummary>; abort: AbortController }>();
  private tickTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private syncing = false;

  private readonly tickMs: number;
  private readonly syncIntervalMs: number;
  private readonly hardTimeoutMs: number;
  private readonly jitter: boolean;

  constructor(private readonly o: SchedulerOptions) {
    this.tickMs = o.tickMs ?? 1000;
    this.syncIntervalMs = (o.syncIntervalSec ?? 30) * 1000;
    this.hardTimeoutMs = o.hardTimeoutMs ?? 60_000;
    this.jitter = o.jitter ?? true;
  }

  async start(): Promise<void> {
    await this.sync();
    this.tickTimer = setInterval(() => void this.tick(), this.tickMs);
    this.syncTimer = setInterval(() => void this.sync(), this.syncIntervalMs);
    this.o.logger.info({ event: 'scheduler_started', devices: this.entries.size, concurrency: this.o.pool.concurrency });
  }

  /** Reload the schedule from the database. New devices appear, removed/disabled ones vanish, intervals update. */
  async sync(): Promise<void> {
    if (this.syncing || this.stopping) return;
    this.syncing = true;
    try {
      const wanted = await this.o.loadSchedule();
      const now = this.o.clock.now();
      const seen = new Set<string>();
      for (const w of wanted) {
        seen.add(w.deviceId);
        const intervalMs = w.intervalSec * 1000;
        const existing = this.entries.get(w.deviceId);
        if (!existing) {
          this.entries.set(w.deviceId, { deviceId: w.deviceId, intervalMs, nextRunAt: now + this.firstDelay(w) });
        } else if (existing.intervalMs !== intervalMs) {
          existing.intervalMs = intervalMs;
          existing.nextRunAt = Math.min(existing.nextRunAt, now + intervalMs);
        }
      }
      for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.entries.delete(id);
    } catch (err) {
      this.o.logger.error({ event: 'scheduler_error', phase: 'sync', error: errorMessage(err) });
    } finally {
      this.syncing = false;
    }
  }

  private firstDelay(w: ScheduleEntry): number {
    if (!this.jitter) return 0;
    const h = createHash('sha1').update(w.deviceId).digest().readUInt32BE(0);
    return h % (w.intervalSec * 1000);
  }

  /** Start every poll that is due. Public so tests (and manual triggers) can drive time deterministically. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.o.clock.now();
    for (const e of this.entries.values()) {
      if (e.nextRunAt > now || this.inFlight.has(e.deviceId)) continue;
      const lagMs = now - e.nextRunAt;
      if (lagMs > e.intervalMs) {
        this.o.logger.warn({ event: 'scheduler_lag', deviceId: e.deviceId, lagMs, hint: 'increase SCHEDULER_CONCURRENCY' });
      }
      // Not due again until this poll finishes; the real next slot is computed in reschedule().
      e.nextRunAt = Number.POSITIVE_INFINITY;
      void this.launch(e.deviceId);
    }
  }

  private launch(deviceId: string): Promise<PollSummary> {
    const existing = this.inFlight.get(deviceId);
    if (existing) return existing.promise;

    const abort = new AbortController();
    const startedAt = this.o.clock.now();
    let executionStartedAt: number | null = null; // set when a worker actually starts (queue wait excluded)
    const log = this.o.logger;

    const job = this.o.pool
      .submit(async (): Promise<PollSummary> => {
        executionStartedAt = this.o.clock.now();
        log.debug({ event: 'poll_started', deviceId });
        let timer: NodeJS.Timeout | undefined;
        const hardTimeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error(`poll exceeded hard timeout of ${this.hardTimeoutMs} ms`));
          }, this.hardTimeoutMs);
        });
        try {
          return await Promise.race([this.o.runPoll(deviceId, abort.signal), hardTimeout]);
        } finally {
          clearTimeout(timer);
        }
      })
      .catch((err): PollSummary => {
        // The scheduler survives every individual poll failure.
        log.error({ event: 'poll_failed', deviceId, protocol: 'scheduler', error: errorMessage(err), durationMs: this.o.clock.now() - startedAt });
        return { deviceId, ok: false, durationMs: this.o.clock.now() - startedAt, error: errorMessage(err) };
      })
      .finally(() => {
        this.inFlight.delete(deviceId);
        this.reschedule(deviceId, executionStartedAt ?? startedAt);
      });

    this.inFlight.set(deviceId, { promise: job, abort });
    return job;
  }

  /** Compute the next due time after a poll finished (success, failure or timeout alike). */
  private reschedule(deviceId: string, pollStartedAt: number): void {
    const e = this.entries.get(deviceId);
    if (!e) return;
    const finishedAt = this.o.clock.now();
    const tookMs = finishedAt - pollStartedAt;
    e.nextRunAt = tookMs < e.intervalMs ? pollStartedAt + e.intervalMs : finishedAt + e.intervalMs;
    if (tookMs >= e.intervalMs) {
      this.o.logger.warn({
        event: 'poll_overran_interval',
        deviceId,
        tookMs,
        intervalMs: e.intervalMs,
        nextPollInMs: e.intervalMs,
        hint: 'missed slots are skipped, not caught up',
      });
    }
  }

  /** Poll now (manual trigger). If a poll for this device is already running, its result is shared. */
  runNow(deviceId: string): Promise<PollSummary> {
    if (this.stopping) return Promise.reject(new Error('Scheduler is shutting down'));
    return this.launch(deviceId);
  }

  stats() {
    return {
      scheduledDevices: this.entries.size,
      inFlight: this.inFlight.size,
      workersActive: this.o.pool.active,
      queued: this.o.pool.queued,
      concurrency: this.o.pool.concurrency,
    };
  }

  /** Graceful shutdown: stop scheduling, let running polls finish (up to timeoutMs), then abort what is left. */
  async stop(timeoutMs = 30_000): Promise<{ clean: boolean }> {
    this.stopping = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.tickTimer = this.syncTimer = null;
    this.o.pool.close(true);

    const pending = [...this.inFlight.values()].map((j) => j.promise);
    let budgetTimer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        budgetTimer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(budgetTimer); // otherwise this timer would keep the process alive for up to timeoutMs after a clean stop
    if (!finished) for (const j of this.inFlight.values()) j.abort.abort();
    this.o.logger.info({ event: 'scheduler_stopped', clean: finished });
    return { clean: finished };
  }
}
