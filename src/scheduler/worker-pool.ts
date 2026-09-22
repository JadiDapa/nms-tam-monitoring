/**
 * Bounded-concurrency executor. At most `concurrency` tasks run at once; the rest wait FIFO.
 * This is what keeps the engine from opening an unbounded number of SNMP sessions / ping processes.
 */
export class WorkerPool {
  private running = 0;
  private closed = false;
  private readonly queue: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(public readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  submit<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('WorkerPool is closed'));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running += 1;
        // A task that throws synchronously must not leak the slot.
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.running -= 1;
            this.pump();
          });
      };
      if (this.running < this.concurrency) start();
      else this.queue.push(start);
    });
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) this.queue.shift()!();
    if (this.running === 0 && this.queue.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Stop accepting work. Queued-but-not-started tasks are still executed unless `dropQueued` is set. */
  close(dropQueued = false): void {
    this.closed = true;
    if (dropQueued) this.queue.length = 0;
  }

  /** Resolves true when idle, false when `timeoutMs` elapsed first. */
  onIdle(timeoutMs: number): Promise<boolean> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
