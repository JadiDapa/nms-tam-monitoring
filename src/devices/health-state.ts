/**
 * Health state machine (pure). The same machine is used twice per device:
 *   - "reachability": can we reach the device at all (ICMP / TCP / SNMP evidence)?
 *   - "snmp":         is the SNMP agent answering?
 * so "reachable but SNMP unavailable" is representable.
 *
 *            failure                   failures >= failureThreshold
 *   UP ─────────────────► DEGRADED ─────────────────────────────────► DOWN
 *    ▲                       │ success                                  │ success
 *    │  (transient cleared)  ▼                                          ▼
 *    └────────────────────  UP                                    RECOVERING ── failure ──► DOWN
 *    ▲                                                                  │ successes >= recoveryThreshold
 *    └──────────────────────────────── (recovered) ─────────────────────┘
 *
 * One failed poll only moves UP -> DEGRADED (unless failureThreshold = 1). DOWN needs `failureThreshold`
 * CONSECUTIVE failures; leaving DOWN needs `recoveryThreshold` consecutive successes.
 */
export type HealthState = 'UNKNOWN' | 'UP' | 'DEGRADED' | 'DOWN' | 'RECOVERING';

export interface HealthSnapshot {
  state: HealthState;
  failures: number;
  successes: number;
  since: Date | null;
}

export interface Thresholds {
  failureThreshold: number;
  recoveryThreshold: number;
}

export interface Transition {
  from: HealthState;
  to: HealthState;
  reason: string;
}

export const initialHealth = (): HealthSnapshot => ({ state: 'UNKNOWN', failures: 0, successes: 0, since: null });

const MAX_COUNT = 1_000_000;

export function nextHealth(
  prev: HealthSnapshot,
  success: boolean,
  t: Thresholds,
  now: Date,
): { next: HealthSnapshot; transition: Transition | null } {
  const go = (state: HealthState, failures: number, successes: number, reason: string) => ({
    next: { state, failures, successes, since: now } satisfies HealthSnapshot,
    transition: { from: prev.state, to: state, reason } satisfies Transition,
  });
  const stay = (failures: number, successes: number) => ({
    next: { state: prev.state, failures, successes, since: prev.since ?? now } satisfies HealthSnapshot,
    transition: null,
  });

  if (success) {
    switch (prev.state) {
      case 'UNKNOWN':
        return go('UP', 0, 0, 'first_success');
      case 'UP':
        return stay(0, 0);
      case 'DEGRADED':
        return go('UP', 0, 0, 'transient_failure_cleared');
      case 'DOWN': {
        if (t.recoveryThreshold <= 1) return go('UP', 0, 0, 'recovered');
        return go('RECOVERING', 0, 1, 'recovery_started');
      }
      case 'RECOVERING': {
        const successes = prev.successes + 1;
        if (successes >= t.recoveryThreshold) return go('UP', 0, 0, 'recovered');
        return stay(0, successes);
      }
    }
  }

  // failure
  switch (prev.state) {
    case 'UNKNOWN':
    case 'UP': {
      if (t.failureThreshold <= 1) return go('DOWN', 1, 0, 'failure_threshold_reached');
      return go('DEGRADED', 1, 0, 'first_failure');
    }
    case 'DEGRADED': {
      const failures = prev.failures + 1;
      if (failures >= t.failureThreshold) return go('DOWN', failures, 0, 'failure_threshold_reached');
      return stay(failures, 0);
    }
    case 'DOWN':
      return stay(Math.min(prev.failures + 1, MAX_COUNT), 0);
    case 'RECOVERING':
      return go('DOWN', Math.max(t.failureThreshold, prev.failures), 0, 'recovery_failed');
  }
}

export const isRecovery = (tr: Transition | null): boolean =>
  tr !== null && tr.to === 'UP' && (tr.from === 'DOWN' || tr.from === 'RECOVERING');

export const isOutage = (tr: Transition | null): boolean => tr !== null && tr.to === 'DOWN';
