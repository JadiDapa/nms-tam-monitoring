import { describe, expect, it } from 'vitest';
import { Scheduler, type PollSummary } from '../src/scheduler/scheduler.js';
import { WorkerPool } from '../src/scheduler/worker-pool.js';
import { systemClock } from '../src/util/clock.js';
import { silentLogger } from '../src/util/logger.js';
import { simulate } from './helpers/sched-sim.js';

/**
 * ACCEPTANCE: scheduler overrun. interval = 2 s.
 * Rule under test:  poll took < interval -> next = start + interval ;  poll took >= interval -> next = finish + interval.
 */

const idle = (r: { starts: number[]; finishes: number[] }) => r.starts.slice(1).map((s, i) => s - r.finishes[i]!);
const s2s = (r: { starts: number[] }) => r.starts.slice(1).map((s, i) => s - r.starts[i]!);

describe('interval = 2 s, deterministic fake clock', () => {
  it('poll < interval (1 s): steady cadence from the start of each poll', async () => {
    const r = await simulate({ intervalSec: 2, durations: 1, horizonSec: 12 });
    expect(r.starts).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(r.maxConcurrent).toBe(1);
  });

  it('poll == interval (2 s): next poll starts one full interval AFTER it finished', async () => {
    const r = await simulate({ intervalSec: 2, durations: 2, horizonSec: 20 });
    expect(r.starts).toEqual([0, 4, 8, 12, 16, 20]);
    expect(idle(r).every((g) => g === 2)).toBe(true);
    expect(r.maxConcurrent).toBe(1);
  });

  it('poll > interval (3 s)', async () => {
    const r = await simulate({ intervalSec: 2, durations: 3, horizonSec: 20 });
    expect(r.starts).toEqual([0, 5, 10, 15, 20]);
    expect(idle(r).every((g) => g === 2)).toBe(true);
  });

  it('THE EXAMPLE: interval 2 s, poll 5 s: one active poll, no overlap, no catch-up burst, start-to-start 7 s', async () => {
    const r = await simulate({ intervalSec: 2, durations: 5, horizonSec: 30 });
    expect(r.starts).toEqual([0, 7, 14, 21, 28]);
    expect(r.maxConcurrent).toBe(1); // only one poll active at any time
    expect(r.starts.every((s, i) => i === 0 || s >= r.finishes[i - 1]!)).toBe(true); // never started before the previous one ended
    expect(idle(r).every((g) => g === 2)).toBe(true); // exactly one interval of quiet, not zero (no catch-up)
    expect(s2s(r).every((d) => d === 7)).toBe(true); // sensible, constant start-to-start timing
    expect(r.starts.filter((s) => s > 0 && s < 7)).toEqual([]); // the slots at 2 and 4 were SKIPPED, not run late
  });

  it('poll > 2 x interval (10 s = 5 intervals): a single poll, then one interval of quiet; the missed slots are skipped', async () => {
    const r = await simulate({ intervalSec: 2, durations: 10, horizonSec: 40 });
    expect(r.starts).toEqual([0, 12, 24, 36]);
    expect(r.maxConcurrent).toBe(1);
    expect(r.polls).toBe(4); // NOT 4 plus a burst of catch-up polls per overrun
  });

  it('the scheduler continues normally afterwards: once polls are fast again the 2 s cadence returns', async () => {
    // 5 s, 5 s (two overruns), then fast polls
    const r = await simulate({ intervalSec: 2, durations: [5, 5, 0.5, 0.5, 0.5, 0.5, 0.5], horizonSec: 22, tickSec: 0.5 });
    expect(r.starts).toEqual([0, 7, 14, 16, 18, 20, 22]);
    const cadence = s2s({ starts: r.starts.slice(2) });
    expect(cadence.every((d) => d === 2)).toBe(true); // back on the 2 s cadence, with no leftover drift or backlog
    expect(r.maxConcurrent).toBe(1);
  });

  it('a slow poll in the middle of a run does not shift the polls after the recovery', async () => {
    const r = await simulate({ intervalSec: 2, durations: [0.5, 0.5, 6, 0.5, 0.5, 0.5], horizonSec: 20, tickSec: 0.5 });
    expect(r.starts).toEqual([0, 2, 4, 12, 14, 16, 18, 20]); // slow poll 4 -> 10, next at 12, cadence resumes
    expect(r.starts.filter((s) => s > 4 && s < 12)).toEqual([]); // nothing started while the 6 s poll ran, nothing "caught up" afterwards
  });
});

describe('interval = 2 s, poll = 5 s, REAL time (real timers, real clock)', () => {
  it('one poll at a time, next start 2 s after the previous poll ended, no burst', async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const t0 = Date.now();
    const scheduler = new Scheduler({
      pool: new WorkerPool(4),
      clock: systemClock,
      logger: silentLogger(),
      loadSchedule: async () => [{ deviceId: 'slow', intervalSec: 2 }],
      runPoll: async (id): Promise<PollSummary> => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        starts.push(Date.now() - t0);
        await new Promise((r) => setTimeout(r, 5000)); // the poll really takes 5 s
        ends.push(Date.now() - t0);
        concurrent--;
        return { deviceId: id, ok: true, durationMs: 5000 };
      },
      tickMs: 100,
      jitter: false,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 13_000));
    const stopped = await scheduler.stop(8000);
    expect(stopped.clean).toBe(true);

    expect(maxConcurrent).toBe(1);
    expect(starts.length).toBe(2); // t = 0 and t = 7 s within the 13 s window (a burst would show 3+)
    expect(starts[0]!).toBeLessThan(300);
    expect(starts[1]! - ends[0]!).toBeGreaterThanOrEqual(1900); // waited (about) one full interval after the poll ended
    expect(starts[1]! - ends[0]!).toBeLessThan(2600);
    expect(starts[1]! - starts[0]!).toBeGreaterThan(6800);
    expect(starts.filter((s) => s > 5300 && s < 6800)).toEqual([]); // no catch-up start right after the first poll ended
  }, 40_000);
});
