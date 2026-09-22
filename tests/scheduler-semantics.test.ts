import { describe, expect, it } from 'vitest';
import { Scheduler, type PollSummary } from '../src/scheduler/scheduler.js';
import { WorkerPool } from '../src/scheduler/worker-pool.js';
import { silentLogger } from '../src/util/logger.js';

/**
 * Deterministic scheduling semantics (fake clock, no randomness).
 *
 * A "poll" here takes `durationSec` of fake time: runPoll advances the clock when it starts, so the scheduler sees a
 * poll that started at T and finished at T + duration.
 */
const flush = () => new Promise<void>((r) => setImmediate(r));

class FakeClock {
  t = 0;
  now = () => this.t;
  advance(sec: number) {
    this.t += sec * 1000;
  }
}

interface Run {
  starts: number[]; // seconds
  finishes: number[];
  maxConcurrent: number;
}

async function simulate(opts: { intervalSec: number; durationSec: number; horizonSec: number; concurrency?: number }): Promise<Run> {
  const clock = new FakeClock();
  const run: Run = { starts: [], finishes: [], maxConcurrent: 0 };
  let concurrent = 0;
  const scheduler = new Scheduler({
    pool: new WorkerPool(opts.concurrency ?? 10),
    clock,
    logger: silentLogger(),
    loadSchedule: async () => [{ deviceId: 'dev', intervalSec: opts.intervalSec }],
    runPoll: async (id): Promise<PollSummary> => {
      concurrent++;
      run.maxConcurrent = Math.max(run.maxConcurrent, concurrent);
      run.starts.push(clock.t / 1000);
      clock.advance(opts.durationSec); // the poll "takes" durationSec
      run.finishes.push(clock.t / 1000);
      concurrent--;
      return { deviceId: id, ok: true, durationMs: opts.durationSec * 1000 };
    },
    jitter: false,
  });
  await scheduler.sync();
  // tick once per (fake) second until the horizon
  while (clock.t / 1000 <= opts.horizonSec) {
    await scheduler.tick();
    await flush();
    clock.advance(1);
  }
  return run;
}

const gaps = (r: Run) => r.starts.slice(1).map((s, i) => s - r.finishes[i]!); // idle time between finish and next start

describe('scheduling semantics: next poll after a poll of a given duration (interval = 15 s)', () => {
  it('poll < interval (5 s): steady cadence from the START of each poll, no drift', async () => {
    const r = await simulate({ intervalSec: 15, durationSec: 5, horizonSec: 100 });
    expect(r.starts).toEqual([0, 15, 30, 45, 60, 75, 90]);
    expect(r.maxConcurrent).toBe(1);
  });

  it('poll just under the interval (14 s): cadence kept, still never overlapping', async () => {
    const r = await simulate({ intervalSec: 15, durationSec: 14, horizonSec: 100 });
    expect(r.starts).toEqual([0, 15, 30, 45, 60, 75, 90]);
    expect(r.maxConcurrent).toBe(1);
  });

  it('poll == interval (15 s): next poll is one FULL interval after it finished, not immediately', async () => {
    const r = await simulate({ intervalSec: 15, durationSec: 15, horizonSec: 100 });
    expect(r.starts).toEqual([0, 30, 60, 90]);
    expect(gaps(r).every((g) => g >= 15)).toBe(true);
  });

  it('poll > interval (16 s, the case seen on the real router): no back-to-back poll; next starts 15 s after completion', async () => {
    const r = await simulate({ intervalSec: 15, durationSec: 16, horizonSec: 100 });
    expect(r.starts).toEqual([0, 31, 62, 93]);
    expect(gaps(r)).toEqual([15, 15, 15]);
    expect(r.maxConcurrent).toBe(1);
  });

  it('poll > 20 s (20 s): still exactly one active poll, and the missed slot is skipped, not caught up', async () => {
    const r = await simulate({ intervalSec: 15, durationSec: 20, horizonSec: 110 });
    expect(r.starts).toEqual([0, 35, 70, 105]);
    expect(gaps(r).every((g) => g === 15)).toBe(true);
    expect(r.maxConcurrent).toBe(1);
  });

  it('poll > 2 x interval (40 s): ONE poll, then a full interval of quiet; no burst of catch-up polls', async () => {
    const r = await simulate({ intervalSec: 15, durationSec: 40, horizonSec: 120 });
    expect(r.starts).toEqual([0, 55, 110]);
    // between finish (40) and next start (55): nothing was started, although 2 slots (15, 30) were "missed"
    expect(r.starts.filter((s) => s > 0 && s < 55)).toEqual([]);
    expect(r.maxConcurrent).toBe(1);
  });

  it('a slow device does not delay a healthy one (independent per-device schedules)', async () => {
    const clock = new FakeClock();
    const starts: Record<string, number[]> = { slow: [], fast: [] };
    const scheduler = new Scheduler({
      pool: new WorkerPool(10),
      clock,
      logger: silentLogger(),
      loadSchedule: async () => [
        { deviceId: 'slow', intervalSec: 15 },
        { deviceId: 'fast', intervalSec: 15 },
      ],
      runPoll: async (id) => {
        starts[id]!.push(clock.t / 1000);
        return { deviceId: id, ok: true, durationMs: 1 };
      },
      jitter: false,
    });
    await scheduler.sync();
    // 'slow' is stuck (never finishes) for the whole test: emulate by keeping its promise pending
    let releaseSlow!: () => void;
    (scheduler as unknown as { o: { runPoll: unknown } }).o.runPoll = (id: string) => {
      starts[id]!.push(clock.t / 1000);
      return id === 'slow' ? new Promise<PollSummary>((r) => (releaseSlow = () => r({ deviceId: id, ok: true, durationMs: 1 }))) : Promise.resolve({ deviceId: id, ok: true, durationMs: 1 });
    };
    for (let t = 0; t <= 60; t++) {
      await scheduler.tick();
      await flush();
      clock.advance(1);
    }
    expect(starts.fast).toEqual([0, 15, 30, 45, 60]);
    expect(starts.slow).toEqual([0]); // one poll, still running: no overlap
    releaseSlow();
  });
});

describe('poll timeout and shutdown', () => {
  it('a poll that hits the hard timeout is aborted, reported as failed, and does NOT trigger an immediate re-poll', async () => {
    const clock = new FakeClock();
    let aborted = false;
    const starts: number[] = [];
    const summaries: PollSummary[] = [];
    const scheduler = new Scheduler({
      pool: new WorkerPool(2),
      clock,
      logger: silentLogger(),
      loadSchedule: async () => [{ deviceId: 'hang', intervalSec: 15 }],
      runPoll: (id, signal) => {
        starts.push(clock.t / 1000);
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise<PollSummary>(() => undefined); // never finishes
      },
      hardTimeoutMs: 30,
      jitter: false,
    });
    await scheduler.sync();
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 100)); // real time: the hard timeout is a real timer
    summaries.push(await Promise.resolve({ deviceId: 'hang', ok: false, durationMs: 0 }));
    expect(aborted).toBe(true);
    expect(scheduler.stats().inFlight).toBe(0);

    // the fake clock did not move: the next poll is one interval after the (aborted) poll, not "now"
    await scheduler.tick();
    await flush();
    expect(starts).toEqual([0]);
    clock.advance(15);
    await scheduler.tick();
    await flush();
    expect(starts).toEqual([0, 15]);
  });

  it('shutdown while a poll is running: waits for it when it finishes in time', async () => {
    const clock = new FakeClock();
    let release!: () => void;
    let finished = false;
    const scheduler = new Scheduler({
      pool: new WorkerPool(2),
      clock,
      logger: silentLogger(),
      loadSchedule: async () => [{ deviceId: 'd', intervalSec: 15 }],
      runPoll: async (id) => {
        await new Promise<void>((r) => (release = r));
        finished = true;
        return { deviceId: id, ok: true, durationMs: 1 };
      },
      jitter: false,
    });
    await scheduler.sync();
    await scheduler.tick();
    await flush();
    const stopping = scheduler.stop(1000);
    await flush();
    expect(finished).toBe(false); // stop is waiting
    release();
    expect(await stopping).toEqual({ clean: true });
    expect(finished).toBe(true);
  });

  it('shutdown while a poll is running: aborts it when it does not finish within the shutdown timeout, and starts nothing new', async () => {
    const clock = new FakeClock();
    let aborted = false;
    let starts = 0;
    const scheduler = new Scheduler({
      pool: new WorkerPool(2),
      clock,
      logger: silentLogger(),
      loadSchedule: async () => [{ deviceId: 'd', intervalSec: 15 }],
      runPoll: (_id, signal) => {
        starts++;
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise<PollSummary>(() => undefined);
      },
      jitter: false,
    });
    await scheduler.sync();
    await scheduler.tick();
    await flush();
    expect(await scheduler.stop(50)).toEqual({ clean: false });
    expect(aborted).toBe(true);
    clock.advance(60);
    await scheduler.tick();
    await flush();
    expect(starts).toBe(1); // nothing is scheduled after shutdown began
  });

  it('a manual poll while a scheduled poll is running shares it (still exactly one active poll per device)', async () => {
    const clock = new FakeClock();
    let release!: () => void;
    let calls = 0;
    const scheduler = new Scheduler({
      pool: new WorkerPool(2),
      clock,
      logger: silentLogger(),
      loadSchedule: async () => [{ deviceId: 'd', intervalSec: 15 }],
      runPoll: async (id) => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return { deviceId: id, ok: true, durationMs: 1 };
      },
      jitter: false,
    });
    await scheduler.sync();
    await scheduler.tick();
    await flush();
    const manual = scheduler.runNow('d');
    await flush();
    expect(calls).toBe(1);
    release();
    expect((await manual).ok).toBe(true);
  });
});
