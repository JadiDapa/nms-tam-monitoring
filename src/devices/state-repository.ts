import type { Queryable } from '../database/db.js';
import { toNumber } from '../database/db.js';
import type { HealthSnapshot, HealthState, Transition } from './health-state.js';
import { initialHealth } from './health-state.js';
import type { DeviceStateRecord } from './types.js';

interface Row {
  device_id: string;
  reachability_state: HealthState;
  reachability_failures: number;
  reachability_successes: number;
  reachability_since: Date | null;
  snmp_state: HealthState;
  snmp_failures: number;
  snmp_successes: number;
  snmp_since: Date | null;
  last_poll_at: Date | null;
  last_poll_duration_ms: number | null;
  last_success_at: Date | null;
  last_error: string | null;
  last_uptime_ticks: string | null;
}

const snap = (state: HealthState, failures: number, successes: number, since: Date | null): HealthSnapshot => ({
  state,
  failures,
  successes,
  since: since ? new Date(since) : null,
});

const map = (r: Row): DeviceStateRecord => ({
  deviceId: r.device_id,
  reachability: snap(r.reachability_state, r.reachability_failures, r.reachability_successes, r.reachability_since),
  snmp: snap(r.snmp_state, r.snmp_failures, r.snmp_successes, r.snmp_since),
  lastPollAt: r.last_poll_at ? new Date(r.last_poll_at) : null,
  lastPollDurationMs: r.last_poll_duration_ms,
  lastSuccessAt: r.last_success_at ? new Date(r.last_success_at) : null,
  lastError: r.last_error,
  lastUptimeTicks: toNumber(r.last_uptime_ticks),
});

export const emptyState = (deviceId: string): DeviceStateRecord => ({
  deviceId,
  reachability: initialHealth(),
  snmp: initialHealth(),
  lastPollAt: null,
  lastPollDurationMs: null,
  lastSuccessAt: null,
  lastError: null,
  lastUptimeTicks: null,
});

export class StateRepository {
  async get(db: Queryable, deviceId: string): Promise<DeviceStateRecord> {
    const r = await db.query<Row>(
      `select device_id, reachability_state, reachability_failures, reachability_successes, reachability_since,
              snmp_state, snmp_failures, snmp_successes, snmp_since, last_poll_at, last_poll_duration_ms,
              last_success_at, last_error, last_uptime_ticks::text as last_uptime_ticks
       from device_state where device_id = $1`,
      [deviceId],
    );
    return r.rowCount === 0 ? emptyState(deviceId) : map(r.rows[0]!);
  }

  async save(db: Queryable, s: DeviceStateRecord): Promise<void> {
    await db.query(
      `insert into device_state (device_id, reachability_state, reachability_failures, reachability_successes, reachability_since,
         snmp_state, snmp_failures, snmp_successes, snmp_since, last_poll_at, last_poll_duration_ms, last_success_at,
         last_error, last_uptime_ticks)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (device_id) do update set
         reachability_state = excluded.reachability_state, reachability_failures = excluded.reachability_failures,
         reachability_successes = excluded.reachability_successes, reachability_since = excluded.reachability_since,
         snmp_state = excluded.snmp_state, snmp_failures = excluded.snmp_failures,
         snmp_successes = excluded.snmp_successes, snmp_since = excluded.snmp_since,
         last_poll_at = excluded.last_poll_at, last_poll_duration_ms = excluded.last_poll_duration_ms,
         last_success_at = excluded.last_success_at, last_error = excluded.last_error,
         last_uptime_ticks = excluded.last_uptime_ticks`,
      [
        s.deviceId,
        s.reachability.state, s.reachability.failures, s.reachability.successes, s.reachability.since,
        s.snmp.state, s.snmp.failures, s.snmp.successes, s.snmp.since,
        s.lastPollAt, s.lastPollDurationMs, s.lastSuccessAt, s.lastError,
        s.lastUptimeTicks === null ? null : String(s.lastUptimeTicks),
      ],
    );
  }

  async addHistory(db: Queryable, deviceId: string, kind: 'reachability' | 'snmp', tr: Transition, at: Date): Promise<void> {
    await db.query(
      `insert into device_state_history (device_id, kind, from_state, to_state, reason, at) values ($1, $2, $3, $4, $5, $6)`,
      [deviceId, kind, tr.from, tr.to, tr.reason, at],
    );
  }

  async history(db: Queryable, deviceId: string, limit = 50) {
    const r = await db.query<{ kind: string; from_state: string; to_state: string; reason: string | null; at: Date }>(
      `select kind, from_state, to_state, reason, at from device_state_history where device_id = $1 order by at desc, id desc limit $2`,
      [deviceId, limit],
    );
    return r.rows.map((x) => ({ kind: x.kind, from: x.from_state, to: x.to_state, reason: x.reason, at: new Date(x.at) }));
  }
}
