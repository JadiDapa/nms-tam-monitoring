import { z } from 'zod';
import type { Database } from '../database/db.js';
import { ALL_THRESHOLD_METRICS, INTERFACE_THRESHOLD_METRICS } from '../metrics/names.js';
import { badRequest, notFound } from '../util/errors.js';

export const CONDITION_TYPES = ['metric_threshold', 'device_down', 'snmp_unavailable', 'interface_down'] as const;
export const OPERATORS = ['>', '>=', '<', '<=', '==', '!='] as const;
export const SEVERITIES = ['info', 'warning', 'critical'] as const;

export type ConditionType = (typeof CONDITION_TYPES)[number];
export type Operator = (typeof OPERATORS)[number];
export type Severity = (typeof SEVERITIES)[number];

export interface AlertRule {
  id: string;
  name: string;
  /** null = applies to every device */
  deviceId: string | null;
  conditionType: ConditionType;
  metric: string | null;
  operator: Operator | null;
  threshold: number | null;
  /** severity comes from the rule and ONLY from the rule */
  severity: Severity;
  /** consecutive breaching evaluations needed to open an incident */
  triggerAfter: number;
  /** consecutive healthy evaluations needed to resolve it */
  clearAfter: number;
  /** after an incident resolves, the same condition may not open a new one for this long (anti-flap) */
  cooldownSec: number;
  notifyOnRecovery: boolean;
  enabled: boolean;
  channelIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const base = z.object({
  name: z.string().trim().min(1).max(200),
  deviceId: z.uuid().nullish(),
  conditionType: z.enum(CONDITION_TYPES),
  metric: z.string().optional(),
  operator: z.enum(OPERATORS).optional(),
  threshold: z.number().finite().optional(),
  severity: z.enum(SEVERITIES),
  triggerAfter: z.number().int().min(1).max(1000).optional(),
  clearAfter: z.number().int().min(1).max(1000).optional(),
  cooldownSec: z.number().int().min(0).max(86400 * 7).default(0),
  notifyOnRecovery: z.boolean().default(true),
  enabled: z.boolean().default(true),
  channelIds: z.array(z.uuid()).max(50).default([]),
});

const check = (v: z.infer<typeof base>, ctx: z.RefinementCtx) => {
  if (v.conditionType === 'metric_threshold') {
    if (!v.metric || !ALL_THRESHOLD_METRICS.includes(v.metric)) {
      ctx.addIssue({ code: 'custom', path: ['metric'], message: `metric must be one of: ${ALL_THRESHOLD_METRICS.join(', ')}` });
    }
    if (!v.operator) ctx.addIssue({ code: 'custom', path: ['operator'], message: 'operator is required' });
    if (v.threshold === undefined) ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'threshold is required' });
  } else if (v.metric || v.operator || v.threshold !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['conditionType'], message: `${v.conditionType} rules take no metric/operator/threshold` });
  }
};

export const createRuleSchema = base.strict().superRefine(check);
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = base
  .partial()
  .strict()
  .superRefine((v, ctx) => {
    if (v.metric && !ALL_THRESHOLD_METRICS.includes(v.metric)) {
      ctx.addIssue({ code: 'custom', path: ['metric'], message: `metric must be one of: ${ALL_THRESHOLD_METRICS.join(', ')}` });
    }
  });
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

interface Row {
  id: string;
  name: string;
  device_id: string | null;
  condition_type: ConditionType;
  metric: string | null;
  operator: Operator | null;
  threshold: number | null;
  severity: Severity;
  trigger_after: number;
  clear_after: number;
  cooldown_sec: number;
  notify_on_recovery: boolean;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  channel_ids: string[] | null;
}

const SELECT = `select r.*, coalesce((select array_agg(c.channel_id::text) from alert_rule_channels c where c.rule_id = r.id), '{}') as channel_ids
  from alert_rules r`;

export const mapRule = (r: Row): AlertRule => ({
  id: r.id,
  name: r.name,
  deviceId: r.device_id,
  conditionType: r.condition_type,
  metric: r.metric,
  operator: r.operator,
  threshold: r.threshold === null ? null : Number(r.threshold),
  severity: r.severity,
  triggerAfter: r.trigger_after,
  clearAfter: r.clear_after,
  cooldownSec: r.cooldown_sec,
  notifyOnRecovery: r.notify_on_recovery,
  enabled: r.enabled,
  channelIds: r.channel_ids ?? [],
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

/** Sensible debounce defaults: metric thresholds need persistence, state-based rules are already debounced. */
/**
 * device_down / snmp_unavailable are already debounced by the health state machines (1). interface_down has no other
 * debounce, so it needs 2 consecutive DOWN observations to open and 2 consecutive UP observations to resolve.
 */
const defaultTrigger = (t: ConditionType) => (t === 'metric_threshold' ? 3 : t === 'interface_down' ? 2 : 1);
const defaultClear = (t: ConditionType) => (t === 'metric_threshold' || t === 'interface_down' ? 2 : 1);

export class RuleService {
  /** called when a rule is disabled/deleted so its open incidents do not linger */
  private onRuleRetired: (ruleId: string, reason: string) => Promise<void> = async () => undefined;

  constructor(private readonly db: Database) {}

  setRetireHandler(fn: (ruleId: string, reason: string) => Promise<void>): void {
    this.onRuleRetired = fn;
  }

  private async assertRefs(deviceId: string | null | undefined, channelIds: string[]): Promise<void> {
    if (deviceId) {
      const d = await this.db.query('select 1 from devices where id = $1', [deviceId]);
      if (d.rowCount === 0) throw badRequest(`deviceId ${deviceId} does not exist`);
    }
    if (channelIds.length > 0) {
      const c = await this.db.query<{ id: string }>('select id from notification_channels where id = any($1::uuid[])', [channelIds]);
      const missing = channelIds.filter((id) => !c.rows.some((r) => r.id === id));
      if (missing.length > 0) throw badRequest(`Unknown channelIds: ${missing.join(', ')}`);
    }
  }

  async create(input: CreateRuleInput): Promise<AlertRule> {
    await this.assertRefs(input.deviceId, input.channelIds);
    const id = await this.db.transaction(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into alert_rules (name, device_id, condition_type, metric, operator, threshold, severity, trigger_after,
           clear_after, cooldown_sec, notify_on_recovery, enabled)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [
          input.name, input.deviceId ?? null, input.conditionType, input.metric ?? null, input.operator ?? null,
          input.threshold ?? null, input.severity, input.triggerAfter ?? defaultTrigger(input.conditionType),
          input.clearAfter ?? defaultClear(input.conditionType), input.cooldownSec, input.notifyOnRecovery, input.enabled,
        ],
      );
      const ruleId = r.rows[0]!.id;
      for (const ch of input.channelIds) {
        await tx.query('insert into alert_rule_channels (rule_id, channel_id) values ($1, $2)', [ruleId, ch]);
      }
      return ruleId;
    });
    return this.get(id);
  }

  async get(id: string): Promise<AlertRule> {
    const r = await this.db.query<Row>(`${SELECT} where r.id = $1`, [id]);
    if (r.rowCount === 0) throw notFound('Alert rule', id);
    return mapRule(r.rows[0]!);
  }

  async list(ids?: string[]): Promise<Array<AlertRule & { activeIncidents: number }>> {
    const r = await this.db.query<Row & { active: string }>(
      `select r.*, coalesce((select array_agg(c.channel_id::text) from alert_rule_channels c where c.rule_id = r.id), '{}') as channel_ids,
              (select count(*)::text from incidents i where i.rule_id = r.id and i.status <> 'RESOLVED') as active
       from alert_rules r ${ids === undefined ? '' : 'where r.id = any($1::uuid[])'} order by r.name, r.id`,
      ids === undefined ? [] : [ids],
    );
    return r.rows.map((x) => ({ ...mapRule(x), activeIncidents: Number(x.active) }));
  }

  async enabledFor(db: { query: Database['query'] }, deviceId: string): Promise<AlertRule[]> {
    const r = await db.query<Row>(`${SELECT} where r.enabled and (r.device_id is null or r.device_id = $1)`, [deviceId]);
    return r.rows.map(mapRule);
  }

  async update(id: string, patch: UpdateRuleInput): Promise<AlertRule> {
    const current = await this.get(id);
    await this.assertRefs(patch.deviceId, patch.channelIds ?? []);

    const merged = {
      conditionType: patch.conditionType ?? current.conditionType,
      metric: patch.metric ?? current.metric,
      operator: patch.operator ?? current.operator,
      threshold: patch.threshold ?? current.threshold,
    };
    if (merged.conditionType === 'metric_threshold') {
      if (!merged.metric || !merged.operator || merged.threshold === null) {
        throw badRequest('metric_threshold rules need metric, operator and threshold');
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.deviceId !== undefined) set('device_id', patch.deviceId ?? null);
    if (patch.conditionType !== undefined) set('condition_type', patch.conditionType);
    if (patch.metric !== undefined) set('metric', patch.metric);
    if (patch.operator !== undefined) set('operator', patch.operator);
    if (patch.threshold !== undefined) set('threshold', patch.threshold);
    if (patch.severity !== undefined) set('severity', patch.severity);
    if (patch.triggerAfter !== undefined) set('trigger_after', patch.triggerAfter);
    if (patch.clearAfter !== undefined) set('clear_after', patch.clearAfter);
    if (patch.cooldownSec !== undefined) set('cooldown_sec', patch.cooldownSec);
    if (patch.notifyOnRecovery !== undefined) set('notify_on_recovery', patch.notifyOnRecovery);
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    sets.push('updated_at = now()');

    await this.db.transaction(async (tx) => {
      await tx.query(`update alert_rules set ${sets.join(', ')} where id = $1`, params);
      if (patch.channelIds) {
        await tx.query('delete from alert_rule_channels where rule_id = $1', [id]);
        for (const ch of patch.channelIds) await tx.query('insert into alert_rule_channels (rule_id, channel_id) values ($1, $2)', [id, ch]);
      }
      // A changed condition invalidates accumulated debounce counters.
      if (patch.conditionType || patch.metric || patch.operator || patch.threshold !== undefined) {
        await tx.query('delete from alert_condition_state where rule_id = $1', [id]);
      }
    });

    if (patch.enabled === false && current.enabled) await this.onRuleRetired(id, 'rule_disabled');
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.onRuleRetired(id, 'rule_deleted');
    await this.db.query('delete from alert_rules where id = $1', [id]);
  }
}

export const isInterfaceMetric = (metric: string | null): boolean =>
  metric !== null && (INTERFACE_THRESHOLD_METRICS as readonly string[]).includes(metric);
