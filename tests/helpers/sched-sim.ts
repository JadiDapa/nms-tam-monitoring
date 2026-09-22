import { Scheduler, type PollSummary } from '../../src/scheduler/scheduler.js';
import { WorkerPool } from '../../src/scheduler/worker-pool.js';
import { silentLogger } from '../../src/util/logger.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

export class SimClock {
  t = 0;
  now = () => this.t;
  advance(sec: number) {
    this.t += sec * 1000;
  }
}

export interface SimRun {
  starts: number[]; // seconds
  finishes: number[];
  maxConcurrent: number;
  polls: number;
}

/**
 * Deterministic scheduler simulation. A "poll" takes `durations[i]` (or the single number) of FAKE time: runPoll advances
 * the clock when it starts. The loop ticks every `tickSec` of fake time until `horizonSec`.
 */
export async function simulate(o: { intervalSec: number; durations: number | number[]; horizonSec: number; tickSec?: number; concurrency?: number }): Promise<SimRun> {
  const clock = new SimClock();
  const run: SimRun = { starts: [], finishes: [], maxConcurrent: 0, polls: 0 };
  let concurrent = 0;
  const durationFor = (i: number) => (Array.isArray(o.durations) ? (o.durations[i] ?? o.durations.at(-1)!) : o.durations);
  const scheduler = new Scheduler({
    pool: new WorkerPool(o.concurrency ?? 10),
    clock,
    logger: silentLogger(),
    loadSchedule: async () => [{ deviceId: 'dev', intervalSec: o.intervalSec }],
    runPoll: async (id): Promise<PollSummary> => {
      concurrent++;
      run.maxConcurrent = Math.max(run.maxConcurrent, concurrent);
      const i = run.polls++;
      run.starts.push(clock.t / 1000);
      clock.advance(durationFor(i));
      run.finishes.push(clock.t / 1000);
      concurrent--;
      return { deviceId: id, ok: true, durationMs: durationFor(i) * 1000 };
    },
    jitter: false,
  });
  await scheduler.sync();
  const tick = o.tickSec ?? 0.5;
  while (clock.t / 1000 <= o.horizonSec) {
    await scheduler.tick();
    await flush();
    clock.advance(tick);
  }
  return run;
}
