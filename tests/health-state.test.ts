import { describe, expect, it } from 'vitest';
import {
  initialHealth,
  isOutage,
  isRecovery,
  nextHealth,
  type HealthSnapshot,
  type Thresholds,
  type Transition,
} from '../src/devices/health-state.js';

const T: Thresholds = { failureThreshold: 3, recoveryThreshold: 2 };
const now = new Date('2026-01-01T00:00:00Z');

/** feed a sequence of polls, returning every transition that happened */
function run(seq: boolean[], t: Thresholds = T, start: HealthSnapshot = initialHealth()) {
  let s = start;
  const transitions: Transition[] = [];
  for (const ok of seq) {
    const r = nextHealth(s, ok, t, now);
    s = r.next;
    if (r.transition) transitions.push(r.transition);
  }
  return { state: s, transitions };
}
const path = (ts: Transition[]) => ts.map((t) => `${t.from}>${t.to}`);

describe('device health state machine', () => {
  it('first success: UNKNOWN -> UP', () => {
    expect(path(run([true]).transitions)).toEqual(['UNKNOWN>UP']);
  });

  it('ONE transient failure never makes a device DOWN (UP -> DEGRADED -> UP)', () => {
    const { transitions, state } = run([true, false, true]);
    expect(path(transitions)).toEqual(['UNKNOWN>UP', 'UP>DEGRADED', 'DEGRADED>UP']);
    expect(state.state).toBe('UP');
    expect(transitions.some(isOutage)).toBe(false);
  });

  it('two failures with failureThreshold 3 are still not DOWN', () => {
    const { state, transitions } = run([true, false, false]);
    expect(state.state).toBe('DEGRADED');
    expect(transitions.some(isOutage)).toBe(false);
  });

  it('DEGRADED -> DOWN only when consecutive failures reach the threshold', () => {
    const { state, transitions } = run([true, false, false, false]);
    expect(state.state).toBe('DOWN');
    expect(path(transitions)).toEqual(['UNKNOWN>UP', 'UP>DEGRADED', 'DEGRADED>DOWN']);
    expect(isOutage(transitions.at(-1)!)).toBe(true);
  });

  it('a success in between resets the failure count (must be CONSECUTIVE)', () => {
    const { state } = run([true, false, false, true, false, false]);
    expect(state.state).toBe('DEGRADED'); // 2 consecutive again, not 4 total
  });

  it('DOWN -> RECOVERING -> UP needs recoveryThreshold consecutive successes', () => {
    const { transitions, state } = run([true, false, false, false, true, true]);
    expect(path(transitions.slice(-2))).toEqual(['DOWN>RECOVERING', 'RECOVERING>UP']);
    expect(state.state).toBe('UP');
    expect(isRecovery(transitions.at(-1)!)).toBe(true);
    expect(transitions.at(-1)!.reason).toBe('recovered');
  });

  it('one success after DOWN is not yet a recovery', () => {
    const { state, transitions } = run([true, false, false, false, true]);
    expect(state.state).toBe('RECOVERING');
    expect(isRecovery(transitions.at(-1)!)).toBe(false);
  });

  it('a failure while RECOVERING drops back to DOWN', () => {
    const { state, transitions } = run([true, false, false, false, true, false]);
    expect(state.state).toBe('DOWN');
    expect(transitions.at(-1)).toMatchObject({ from: 'RECOVERING', to: 'DOWN', reason: 'recovery_failed' });
  });

  it('failureThreshold 1 goes DOWN immediately; recoveryThreshold 1 recovers immediately', () => {
    const t = { failureThreshold: 1, recoveryThreshold: 1 };
    expect(path(run([true, false, true], t).transitions)).toEqual(['UNKNOWN>UP', 'UP>DOWN', 'DOWN>UP']);
  });

  it('device that is down from the very first poll', () => {
    const { state, transitions } = run([false, false, false]);
    expect(state.state).toBe('DOWN');
    expect(path(transitions)).toEqual(['UNKNOWN>DEGRADED', 'DEGRADED>DOWN']);
  });

  it('staying DOWN produces no repeated transitions', () => {
    const { transitions } = run([false, false, false, false, false, false]);
    expect(transitions).toHaveLength(2);
  });

  it('records when the current state began', () => {
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-01-01T00:05:00Z');
    const a = nextHealth(initialHealth(), true, T, t1);
    const b = nextHealth(a.next, true, T, t2);
    expect(b.next.since).toEqual(t1); // unchanged state keeps its original start
    const c = nextHealth(b.next, false, T, t2);
    expect(c.next.since).toEqual(t2);
  });
});
