import type { Clock } from './clock.js';

/** A settable clock, used to replay historical timestamps through code that is normally driven by real time. */
export class FakeClock implements Clock {
  constructor(private t: number) {}

  now(): number {
    return this.t;
  }

  set(t: number): void {
    this.t = t;
  }
}
