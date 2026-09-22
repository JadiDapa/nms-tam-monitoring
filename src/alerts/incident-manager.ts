import type { Database, Queryable } from '../database/db.js';
import { toNumber } from '../database/db.js';
import type { Clock } from '../util/clock.js';
import { conflict, notFound } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { SubjectResult } from './evaluate.js';
import type { AlertRule, Severity } from './rules.js';

export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Incident {
  id: string;
  ruleId: string | null;
  ruleName: string;
  deviceId: string;
  interfaceId: string | null;
  subjectKey: string;
  severity: Severity;
  status: IncidentStatus;
  title: string;
  metric: string | null;
  value: number | null;
  threshold: number | null;
  error: string | null;
  triggeredAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  lastSeenAt: Date;
}

interface Row {
  id: string;
  rule_id: string | null;
  rule_name: string;
  device_id: string;
  interface_id: string | null;
  subject_key: string;
  severity: Severity;
  status: IncidentStatus;
  title: string;
  metric: string | null;
  value: number | null;
  threshold: number | null;
  error: string | null;
  triggered_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  last_seen_at: Date;
}

const d = (v: Date | null) => (v ? new Date(v) : null);

export const mapIncident = (r: Row): Incident => ({
  id: r.id,
  ruleId: r.rule_id,
  ruleName: r.rule_name,
  deviceId: r.device_id,
  interfaceId: r.interface_id,
  subjectKey: r.subject_key,
  severity: r.severity,
  status: r.status,
  title: r.title,
  metric: r.metric,
  value: toNumber(r.value),
  threshold: toNumber(r.threshold),
  error: r.error,
  triggeredAt: new Date(r.triggered_at),
  acknowledgedAt: d(r.acknowledged_at),
  acknowledgedBy: r.acknowledged_by,
  resolvedAt: d(r.resolved_at),
  resolutionReason: r.resolution_reason,
  lastSeenAt: new Date(r.last_seen_at),
});

export type NotificationEvent = 'triggered' | 'recovered';

/** Decouples incident logic from delivery: the manager only says "this needs to be announced". */
export interface NotificationEnqueuer {
  enqueue(tx: Queryable, incident: Incident, event: NotificationEvent, ruleId: string | null): Promise<number>;
}

export interface IncidentQuery {
  status?: IncidentStatus | 'ACTIVE';
  deviceId?: string;
  /** restrict to these devices (undefined = no restriction, [] = nothing) */
  deviceIds?: string[];
  ruleId?: string;
  severity?: Severity;
  limit?: number;
  offset?: number;
}

const ACTIVE = `('OPEN', 'ACKNOWLEDGED')`;

/**
 * Turns verdicts into persistent incidents.
 *
 * Guarantees:
 *  - at most one ACTIVE incident per (rule, device, subject): enforced by a partial unique index, not just by code
 *  - an incident opens only after `triggerAfter` consecutive breaches and resolves after `clearAfter` consecutive ok
 *  - "unknown" verdicts change nothing
 *  - after a resolution the same condition cannot re-open for `cooldownSec` (anti-flap)
 *  - every state change and the notifications it causes are written in ONE transaction
 */
export class IncidentManager {
  constructor(
    private readonly db: Database,
    private readonly notifier: NotificationEnqueuer,
    private readonly logger: Logger,
    private readonly clock: Clock,
  ) {}

  async processSubject(rule: AlertRule, device: { id: string; name: string }, s: SubjectResult): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date(this.clock.now());
      const st = await tx.query<{ consecutive_breaches: number; consecutive_ok: number }>(
        `select consecutive_breaches, consecutive_ok from alert_condition_state where rule_id = $1 and device_id = $2 and subject_key = $3`,
        [rule.id, device.id, s.subjectKey],
      );
      let breaches = st.rows[0]?.consecutive_breaches ?? 0;
      let oks = st.rows[0]?.consecutive_ok ?? 0;

      if (s.verdict === 'breach') {
        breaches += 1;
        oks = 0;
      } else if (s.verdict === 'ok') {
        oks += 1;
        breaches = 0;
      }
      // unknown: counters untouched

      await tx.query(
        `insert into alert_condition_state (rule_id, device_id, subject_key, consecutive_breaches, consecutive_ok, last_value, last_evaluated_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (rule_id, device_id, subject_key) do update set consecutive_breaches = excluded.consecutive_breaches,
           consecutive_ok = excluded.consecutive_ok, last_value = coalesce(excluded.last_value, alert_condition_state.last_value),
           last_evaluated_at = excluded.last_evaluated_at`,
        [rule.id, device.id, s.subjectKey, breaches, oks, s.value, now],
      );

      const active = await tx.query<Row>(
        `select * from incidents where rule_id = $1 and device_id = $2 and subject_key = $3 and status in ${ACTIVE}`,
        [rule.id, device.id, s.subjectKey],
      );
      const current = active.rows[0];

      if (s.verdict === 'breach') {
        if (current) {
          await tx.query(`update incidents set last_seen_at = $2, value = coalesce($3, value) where id = $1`, [current.id, now, s.value]);
          return;
        }
        if (breaches < rule.triggerAfter) return;

        if (rule.cooldownSec > 0) {
          const recent = await tx.query(
            `select 1 from incidents where rule_id = $1 and device_id = $2 and subject_key = $3 and status = 'RESOLVED' and resolved_at > $4 limit 1`,
            [rule.id, device.id, s.subjectKey, new Date(now.getTime() - rule.cooldownSec * 1000)],
          );
          if (recent.rowCount > 0) {
            this.logger.debug({ event: 'incident_suppressed_cooldown', ruleId: rule.id, deviceId: device.id, subject: s.subjectKey });
            return;
          }
        }

        const title = s.label ? `${rule.name}: ${device.name} [${s.label}]` : `${rule.name}: ${device.name}`;
        const ins = await tx.query<Row>(
          `insert into incidents (rule_id, rule_name, device_id, interface_id, subject_key, severity, status, title, metric, value, threshold, error, triggered_at, last_seen_at)
           values ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, $9, $10, $11, $12, $12)
           on conflict do nothing returning *`,
          [rule.id, rule.name, device.id, s.interfaceId, s.subjectKey, rule.severity, title, s.metric, s.value, s.threshold, s.error, now],
        );
        if (ins.rowCount === 0) return; // lost a race with another evaluator: the incident already exists
        const incident = mapIncident(ins.rows[0]!);
        await this.notifier.enqueue(tx, incident, 'triggered', rule.id);
        this.logger.warn({
          event: 'alert_triggered', incidentId: incident.id, ruleId: rule.id, deviceId: device.id,
          severity: incident.severity, metric: s.metric, value: s.value, threshold: s.threshold,
        });
        return;
      }

      if (s.verdict === 'ok' && current && oks >= rule.clearAfter) {
        const res = await tx.query<Row>(
          `update incidents set status = 'RESOLVED', resolved_at = $2, resolution_reason = 'condition_cleared', last_seen_at = $2 where id = $1 returning *`,
          [current.id, now],
        );
        const incident = mapIncident(res.rows[0]!);
        if (rule.notifyOnRecovery) await this.notifier.enqueue(tx, incident, 'recovered', rule.id);
        this.logger.info({ event: 'incident_resolved', incidentId: incident.id, ruleId: rule.id, deviceId: device.id, reason: 'condition_cleared' });
      }
    });
  }

  /** Resolve active incidents of a rule/device whose subject no longer exists (e.g. interface removed). */
  async resolveMissing(rule: AlertRule, device: { id: string }, presentKeys: Set<string>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const active = await tx.query<Row>(
        `select * from incidents where rule_id = $1 and device_id = $2 and status in ${ACTIVE}`,
        [rule.id, device.id],
      );
      const now = new Date(this.clock.now());
      for (const row of active.rows) {
        if (presentKeys.has(row.subject_key)) continue;
        const res = await tx.query<Row>(
          `update incidents set status = 'RESOLVED', resolved_at = $2, resolution_reason = 'subject_removed', last_seen_at = $2 where id = $1 returning *`,
          [row.id, now],
        );
        await tx.query('delete from alert_condition_state where rule_id = $1 and device_id = $2 and subject_key = $3', [rule.id, device.id, row.subject_key]);
        if (rule.notifyOnRecovery) await this.notifier.enqueue(tx, mapIncident(res.rows[0]!), 'recovered', rule.id);
        this.logger.info({ event: 'incident_resolved', incidentId: row.id, ruleId: rule.id, deviceId: device.id, reason: 'subject_removed' });
      }
    });
  }

  /** A rule was disabled or deleted: close everything it opened so nothing stays "open" forever. */
  async resolveForRule(ruleId: string, reason: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const now = new Date(this.clock.now());
      const res = await tx.query<Row>(
        `update incidents set status = 'RESOLVED', resolved_at = $2, resolution_reason = $3, last_seen_at = $2
         where rule_id = $1 and status in ${ACTIVE} returning *`,
        [ruleId, now, reason],
      );
      await tx.query('delete from alert_condition_state where rule_id = $1', [ruleId]);
      for (const row of res.rows) {
        this.logger.info({ event: 'incident_resolved', incidentId: row.id, ruleId, deviceId: row.device_id, reason });
      }
      return res.rowCount;
    });
  }

  async acknowledge(id: string, by: string | null): Promise<Incident> {
    const now = new Date(this.clock.now());
    const res = await this.db.query<Row>(
      `update incidents set status = 'ACKNOWLEDGED', acknowledged_at = $2, acknowledged_by = $3
       where id = $1 and status = 'OPEN' returning *`,
      [id, now, by],
    );
    if (res.rowCount > 0) {
      this.logger.info({ event: 'incident_acknowledged', incidentId: id, by });
      return mapIncident(res.rows[0]!);
    }
    const existing = await this.get(id); // throws 404 when missing
    if (existing.status === 'ACKNOWLEDGED') return existing; // idempotent
    throw conflict(`Incident is ${existing.status} and cannot be acknowledged`);
  }

  async get(id: string): Promise<Incident> {
    const r = await this.db.query<Row>('select * from incidents where id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Incident', id);
    return mapIncident(r.rows[0]!);
  }

  async list(q: IncidentQuery = {}): Promise<{ items: Incident[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status === 'ACTIVE') where.push(`status in ${ACTIVE}`);
    else if (q.status) add('status = ?', q.status);
    if (q.deviceId) add('device_id = ?', q.deviceId);
    if (q.deviceIds !== undefined) add('device_id = any(?::uuid[])', q.deviceIds);
    if (q.ruleId) add('rule_id = ?', q.ruleId);
    if (q.severity) add('severity = ?', q.severity);
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);
    const [rows, total] = await Promise.all([
      this.db.query<Row>(`select * from incidents ${clause} order by triggered_at desc, id limit ${limit} offset ${offset}`, params),
      this.db.query<{ n: string }>(`select count(*)::text as n from incidents ${clause}`, params),
    ]);
    return { items: rows.rows.map(mapIncident), total: toNumber(total.rows[0]!.n) ?? 0 };
  }
}
