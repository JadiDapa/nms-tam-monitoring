import { describe, expect, it, vi } from 'vitest';
import { Scheduler, type PollSummary, type ScheduleEntry } from '../src/scheduler/scheduler.js';
import { WorkerPool } from '../src/scheduler/worker-pool.js';
import { silentLogger } from '../src/util/logger.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

class FakeClock {
  t = 1_000_000;
  now = () => this.t;
  advance(sec: number) {
    this.t += sec * 1000;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function build(entries: ScheduleEntry[], runPoll: (id: string, signal: AbortSignal) => Promise<PollSummary>, opts: { concurrency?: number; hardTimeoutMs?: number } = {}) {
  const clock = new FakeClock();
  const pool = new WorkerPool(opts.concurrency ?? 10);
  const scheduler = new Scheduler({
    pool,
    clock,
    logger: silentLogger(),
    loadSchedule: async () => entries,
    runPoll,
    jitter: false,
    hardTimeoutMs: opts.hardTimeoutMs ?? 60_000,
  });
  return { clock, pool, scheduler };
}
const done = (deviceId: string): PollSummary => ({ deviceId, ok: true, durationMs: 1 });

describe('scheduler', () => {
  it('polls each device on its OWN interval', async () => {
    const calls: Record<string, number> = { a: 0, b: 0, c: 0 };
    const { scheduler, clock } = build(
      [
        { deviceId: 'a', intervalSec: 15 },
        { deviceId: 'b', intervalSec: 30 },
        { deviceId: 'c', intervalSec: 60 },
      ],
      async (id) => {
        calls[id]!++;
        return done(id);
      },
    );
    await scheduler.sync();

    // simulate 60 seconds in 1 s ticks
    for (let s = 0; s <= 60; s++) {
      await scheduler.tick();
      await flush();
      clock.advance(1);
    }
    // t = 0,15,30,45,60 -> 5 ; 0,30,60 -> 3 ; 0,60 -> 2
    expect(calls).toEqual({ a: 5, b: 3, c: 2 });
  });

  it('never runs two polls of the same device at once, even if a poll outlasts its interval', async () => {
    const gate = deferred();
    let started = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const { scheduler, clock } = build([{ deviceId: 'slow', intervalSec: 5 }], async (id) => {
      started++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate.promise;
      concurrent--;
      return done(id);
    });
    await scheduler.sync();

    await scheduler.tick();
    await flush();
    for (let i = 0; i < 6; i++) {
      clock.advance(5); // way past the interval while the first poll is still running
      await scheduler.tick();
      await flush();
    }
    expect(started).toBe(1);
    expect(maxConcurrent).toBe(1);

    gate.resolve();
    await flush();
    clock.advance(5);
    await scheduler.tick();
    await flush();
    expect(started).toBe(2); // schedulable again once the previous poll finished
  });

  it('never exceeds the concurrency limit', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
    let concurrent = 0;
    let max = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const { scheduler } = build(
      ids.map((deviceId) => ({ deviceId, intervalSec: 30 })),
      async (id) => {
        concurrent++;
        max = Math.max(max, concurrent);
        const g = deferred();
        gates.set(id, g);
        await g.promise;
        concurrent--;
        return done(id);
      },
      { concurrency: 3 },
    );
    await scheduler.sync();
    await scheduler.tick();
    await flush();

    expect(concurrent).toBe(3);
    expect(scheduler.stats().queued).toBe(9);

    // release everything, one by one, until the queue drains
    for (let guard = 0; guard < 50 && (concurrent > 0 || scheduler.stats().queued > 0); guard++) {
      for (const g of gates.values()) g.resolve();
      await flush();
    }
    expect(max).toBe(3);
  });

  it('a failing poll does not stop the scheduler or other devices', async () => {
    const calls: Record<string, number> = { bad: 0, good: 0 };
    const { scheduler, clock } = build(
      [
        { deviceId: 'bad', intervalSec: 10 },
        { deviceId: 'good', intervalSec: 10 },
      ],
      async (id) => {
        calls[id]!++;
        if (id === 'bad') throw new Error('boom');
        return done(id);
      },
    );
    await scheduler.sync();
    for (let i = 0; i < 3; i++) {
      await scheduler.tick();
      await flush();
      clock.advance(10);
    }
    expect(calls.good).toBe(3);
    expect(calls.bad).toBe(3); // kept being retried on schedule despite throwing every time
  });

  it('abandons a poll that exceeds the hard timeout, aborts it, and reschedules the device', async () => {
    let signal: AbortSignal | undefined;
    let calls = 0;
    const { scheduler, clock } = build(
      [{ deviceId: 'stuck', intervalSec: 5 }],
      async (_id, s) => {
        calls++;
        signal = s;
        return new Promise<PollSummary>(() => undefined); // never resolves
      },
      { hardTimeoutMs: 40 },
    );
    await scheduler.sync();
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 120));

    expect(signal?.aborted).toBe(true);
    expect(scheduler.stats().inFlight).toBe(0);

    clock.advance(5);
    await scheduler.tick();
    await flush();
    expect(calls).toBe(2);
  });

  it('runNow shares an in-flight poll instead of starting a second one', async () => {
    const gate = deferred();
    let calls = 0;
    const { scheduler } = build([], async (id) => {
      calls++;
      await gate.promise;
      return done(id);
    });
    const a = scheduler.runNow('x');
    const b = scheduler.runNow('x');
    await flush();
    expect(calls).toBe(1);
    gate.resolve();
    expect(await a).toEqual(await b);
  });

  it('sync adds new devices, drops removed ones and applies interval changes', async () => {
    let entries: ScheduleEntry[] = [{ deviceId: 'a', intervalSec: 30 }];
    const clock = new FakeClock();
    const scheduler = new Scheduler({
      pool: new WorkerPool(5),
      clock,
      logger: silentLogger(),
      loadSchedule: async () => entries,
      runPoll: async (id) => done(id),
      jitter: false,
    });
    await scheduler.sync();
    expect(scheduler.stats().scheduledDevices).toBe(1);
    entries = [
      { deviceId: 'a', intervalSec: 10 },
      { deviceId: 'b', intervalSec: 10 },
    ];
    await scheduler.sync();
    expect(scheduler.stats().scheduledDevices).toBe(2);
    entries = [{ deviceId: 'b', intervalSec: 10 }];
    await scheduler.sync();
    expect(scheduler.stats().scheduledDevices).toBe(1);
  });

  it('survives a failing schedule reload', async () => {
    const clock = new FakeClock();
    let fail = false;
    const scheduler = new Scheduler({
      pool: new WorkerPool(2),
      clock,
      logger: silentLogger(),
      loadSchedule: async () => {
        if (fail) throw new Error('db down');
        return [{ deviceId: 'a', intervalSec: 10 }];
      },
      runPoll: async (id) => done(id),
      jitter: false,
    });
    await scheduler.sync();
    fail = true;
    await expect(scheduler.sync()).resolves.toBeUndefined();
    expect(scheduler.stats().scheduledDevices).toBe(1); // keeps the last known schedule
  });

  it('graceful stop waits for running polls, then refuses new work', async () => {
    const gate = deferred();
    let finished = false;
    const { scheduler } = build([{ deviceId: 'a', intervalSec: 10 }], async (id) => {
      await gate.promise;
      finished = true;
      return done(id);
    });
    await scheduler.sync();
    await scheduler.tick();
    await flush();

    const stopping = scheduler.stop(2000);
    await flush();
    expect(finished).toBe(false);
    gate.resolve();
    expect(await stopping).toEqual({ clean: true });
    expect(finished).toBe(true);
    await expect(scheduler.runNow('a')).rejects.toThrow(/shutting down/);
  });

  it('stop aborts polls that do not finish within the shutdown timeout', async () => {
    let signal: AbortSignal | undefined;
    const { scheduler } = build([{ deviceId: 'a', intervalSec: 10 }], async (_id, s) => {
      signal = s;
      return new Promise<PollSummary>(() => undefined);
    });
    await scheduler.sync();
    await scheduler.tick();
    await flush();
    const r = await scheduler.stop(50);
    expect(r.clean).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
});

describe('worker pool', () => {
  it('runs queued tasks FIFO as slots free up', async () => {
    const pool = new WorkerPool(1);
    const order: number[] = [];
    const g1 = deferred();
    const p1 = pool.submit(async () => {
      await g1.promise;
      order.push(1);
    });
    const p2 = pool.submit(async () => void order.push(2));
    const p3 = pool.submit(async () => void order.push(3));
    expect(pool.active).toBe(1);
    expect(pool.queued).toBe(2);
    g1.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a throwing task releases its slot', async () => {
    const pool = new WorkerPool(1);
    await expect(pool.submit(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(pool.submit(async () => 'ok')).resolves.toBe('ok');
    expect(pool.active).toBe(0);
  });

  it('a task that throws synchronously also releases its slot', async () => {
    const pool = new WorkerPool(1);
    await expect(
      pool.submit((() => {
        throw new Error('sync');
      }) as () => Promise<never>),
    ).rejects.toThrow('sync');
    expect(pool.active).toBe(0);
  });

  it('rejects submissions after close', async () => {
    const pool = new WorkerPool(1);
    pool.close();
    await expect(pool.submit(async () => 1)).rejects.toThrow(/closed/);
  });

  it('onIdle resolves true when drained and false on timeout', async () => {
    const pool = new WorkerPool(1);
    expect(await pool.onIdle(10)).toBe(true);
    const g = deferred();
    void pool.submit(() => g.promise);
    expect(await pool.onIdle(20)).toBe(false);
    g.resolve();
    expect(await pool.onIdle(500)).toBe(true);
  });

  it('rejects an invalid concurrency', () => {
    expect(() => new WorkerPool(0)).toThrow();
    expect(() => vi.fn()(new WorkerPool(1.5))).toThrow();
  });
});
