import { randomUUID } from 'node:crypto';
import type { Incident, NotificationEnqueuer, NotificationEvent } from '../alerts/incident-manager.js';
import { mapIncident } from '../alerts/incident-manager.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { Database, Queryable } from '../database/db.js';
import type { Clock } from '../util/clock.js';
import { notFound } from '../util/errors.js';
import { errorMessage, type Logger } from '../util/logger.js';
import type { ChannelRuntime, ChannelType, DeliveryOutcome, NotificationProvider } from './provider.js';

export interface NotificationSettings {
  maxAttempts: number;
  backoffBaseSec: number;
  workerIntervalMs: number;
}

export interface DeliveryRecord {
  id: string;
  incidentId: string;
  channelId: string | null;
  channelType: string;
  event: NotificationEvent;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempt: number;
  scheduledAt: Date;
  attemptedAt: Date | null;
  sentAt: Date | null;
  errorCode: string | null;
  error: string | null;
  responseStatus: number | null;
}

interface DeliveryRow {
  id: string;
  incident_id: string;
  channel_id: string | null;
  channel_type: string;
  event: NotificationEvent;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempt: number;
  scheduled_at: Date;
  attempted_at: Date | null;
  sent_at: Date | null;
  error_code: string | null;
  error: string | null;
  response_status: number | null;
}

const mapDelivery = (r: DeliveryRow): DeliveryRecord => ({
  id: r.id,
  incidentId: r.incident_id,
  channelId: r.channel_id,
  channelType: r.channel_type,
  event: r.event,
  status: r.status,
  attempt: r.attempt,
  scheduledAt: new Date(r.scheduled_at),
  attemptedAt: r.attempted_at ? new Date(r.attempted_at) : null,
  sentAt: r.sent_at ? new Date(r.sent_at) : null,
  errorCode: r.error_code,
  error: r.error,
  responseStatus: r.response_status,
});

/**
 * What an operator wants to know about one notification (one channel, one event of one incident):
 *   REQUESTED  queued, first attempt not made yet
 *   SENT       the destination accepted it (the ONLY state that means delivered)
 *   RETRYING   at least one attempt failed and another is scheduled
 *   FAILED     gave up (non-retryable error, NOT_IMPLEMENTED, or attempts exhausted)
 */
export type DeliveryPhase = 'REQUESTED' | 'SENT' | 'RETRYING' | 'FAILED';

export interface DeliverySummary {
  channelId: string | null;
  channelType: string;
  event: NotificationEvent;
  phase: DeliveryPhase;
  attempts: number;
  lastError: string | null;
  lastErrorCode: string | null;
  sentAt: Date | null;
  nextAttemptAt: Date | null;
}

/** Collapse the per-attempt rows into one summary per (channel, event). Pure function. */
export function summarizeDeliveries(rows: DeliveryRecord[]): DeliverySummary[] {
  const groups = new Map<string, DeliveryRecord[]>();
  for (const r of rows) {
    const key = `${r.channelId ?? r.channelType}|${r.event}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const attemptsSorted = g.slice().sort((a, b) => a.attempt - b.attempt);
    const last = attemptsSorted[attemptsSorted.length - 1]!;
    const lastFailure = attemptsSorted.filter((a) => a.status === 'FAILED').at(-1) ?? null;
    const phase: DeliveryPhase =
      last.status === 'SENT' ? 'SENT' : last.status === 'FAILED' ? 'FAILED' : last.attempt > 1 ? 'RETRYING' : 'REQUESTED';
    return {
      channelId: last.channelId,
      channelType: last.channelType,
      event: last.event,
      phase,
      attempts: attemptsSorted.filter((a) => a.status !== 'PENDING').length,
      lastError: lastFailure?.error ?? null,
      lastErrorCode: lastFailure?.errorCode ?? null,
      sentAt: last.sentAt,
      nextAttemptAt: last.status === 'PENDING' ? last.scheduledAt : null,
    };
  });
}

const LOCK_MS = 60_000;
const MAX_BACKOFF_SEC = 3600;

export class NotificationService implements NotificationEnqueuer {
  private readonly providers = new Map<ChannelType, NotificationProvider>();
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;

  constructor(
    private readonly db: Database,
    private readonly credentials: CredentialService,
    providers: NotificationProvider[],
    private readonly settings: NotificationSettings,
    private readonly logger: Logger,
    private readonly clock: Clock,
  ) {
    for (const p of providers) this.providers.set(p.type, p);
  }

  /** Called inside the incident transaction: one PENDING delivery per enabled channel of the rule. */
  async enqueue(tx: Queryable, incident: Incident, event: NotificationEvent, ruleId: string | null): Promise<number> {
    if (!ruleId) return 0;
    const channels = await tx.query<{ id: string; type: string }>(
      `select c.id, c.type from alert_rule_channels rc join notification_channels c on c.id = rc.channel_id
       where rc.rule_id = $1 and c.enabled`,
      [ruleId],
    );
    const now = new Date(this.clock.now());
    for (const c of channels.rows) {
      await tx.query(
        `insert into notification_deliveries (incident_id, channel_id, channel_type, event, status, attempt, scheduled_at)
         values ($1, $2, $3, $4, 'PENDING', 1, $5)`,
        [incident.id, c.id, c.type, event, now],
      );
    }
    return channels.rowCount;
  }

  private async loadChannel(id: string): Promise<ChannelRuntime | null> {
    const r = await this.db.query<{ id: string; name: string; type: ChannelType; config: Record<string, unknown>; credential_id: string | null; enabled: boolean }>(
      'select id, name, type, config, credential_id, enabled from notification_channels where id = $1',
      [id],
    );
    const row = r.rows[0];
    if (!row || !row.enabled) return null;
    const secret = row.credential_id ? await this.credentials.getSecret(row.credential_id) : null;
    return { id: row.id, name: row.name, type: row.type, config: row.config ?? {}, secret };
  }

  /** Claim due deliveries and attempt them. Returns how many were attempted. */
  async processDue(limit = 20): Promise<number> {
    const now = new Date(this.clock.now());
    const claimed = await this.db.query<DeliveryRow>(
      `update notification_deliveries set locked_until = $2
       where id in (
         select id from notification_deliveries
         where status = 'PENDING' and scheduled_at <= $1 and (locked_until is null or locked_until < $1)
         order by scheduled_at limit $3 for update skip locked)
       returning *`,
      [now, new Date(now.getTime() + LOCK_MS), limit],
    );

    for (const row of claimed.rows) {
      try {
        await this.attempt(mapDelivery(row));
      } catch (err) {
        // An unexpected crash must not leave the row locked forever or stop the batch.
        this.logger.error({ event: 'notification_failed', deliveryId: row.id, error: errorMessage(err) });
        await this.record(row.id, { status: 'FAILED', code: 'INTERNAL', error: errorMessage(err), responseStatus: null }, now);
      }
    }
    return claimed.rowCount;
  }

  private async attempt(d: DeliveryRecord): Promise<void> {
    const now = new Date(this.clock.now());
    const done = (o: DeliveryOutcome) => this.finish(d, o, now);

    const inc = await this.db.query<Parameters<typeof mapIncident>[0] & { device_name: string }>(
      `select i.*, dv.name as device_name from incidents i join devices dv on dv.id = i.device_id where i.id = $1`,
      [d.incidentId],
    );
    if (inc.rowCount === 0) return done({ kind: 'failed', code: 'INCIDENT_GONE', error: 'Incident no longer exists', retryable: false });

    const provider = this.providers.get(d.channelType as ChannelType);
    if (!provider) return done({ kind: 'failed', code: 'NO_PROVIDER', error: `No provider for channel type ${d.channelType}`, retryable: false });

    let channel: ChannelRuntime | null;
    try {
      channel = d.channelId ? await this.loadChannel(d.channelId) : null;
    } catch (err) {
      return done({ kind: 'failed', code: 'SECRET_UNAVAILABLE', error: `Channel secret could not be loaded: ${errorMessage(err)}`, retryable: false });
    }
    if (!channel) return done({ kind: 'failed', code: 'CHANNEL_UNAVAILABLE', error: 'Channel was deleted or disabled', retryable: false });

    const row = inc.rows[0]!;
    const outcome = await provider.send(channel, {
      event: d.event,
      deliveryId: d.id,
      incident: mapIncident(row),
      deviceName: row.device_name,
    });
    await done(outcome);
  }

  private async finish(d: DeliveryRecord, outcome: DeliveryOutcome, now: Date): Promise<void> {
    if (outcome.kind === 'sent') {
      await this.record(d.id, { status: 'SENT', code: null, error: null, responseStatus: outcome.responseStatus ?? null }, now);
      this.logger.info({ event: 'notification_sent', deliveryId: d.id, incidentId: d.incidentId, channel: d.channelType, attempt: d.attempt });
      return;
    }

    const failure =
      outcome.kind === 'not_implemented'
        ? { code: 'NOT_IMPLEMENTED', error: outcome.error, retryable: false, responseStatus: null as number | null }
        : { code: outcome.code, error: outcome.error, retryable: outcome.retryable, responseStatus: outcome.responseStatus ?? null };

    await this.record(d.id, { status: 'FAILED', code: failure.code, error: failure.error, responseStatus: failure.responseStatus }, now);
    this.logger.warn({
      event: 'notification_failed', deliveryId: d.id, incidentId: d.incidentId, channel: d.channelType,
      attempt: d.attempt, code: failure.code, error: failure.error, willRetry: failure.retryable && d.attempt < this.settings.maxAttempts,
    });

    // Each attempt is its own row: history stays honest, the retry is a fresh PENDING row.
    if (failure.retryable && d.attempt < this.settings.maxAttempts) {
      const delaySec = Math.min(this.settings.backoffBaseSec * 2 ** (d.attempt - 1), MAX_BACKOFF_SEC);
      await this.db.query(
        `insert into notification_deliveries (incident_id, channel_id, channel_type, event, status, attempt, scheduled_at)
         values ($1, $2, $3, $4, 'PENDING', $5, $6)`,
        [d.incidentId, d.channelId, d.channelType, d.event, d.attempt + 1, new Date(now.getTime() + delaySec * 1000)],
      );
    }
  }

  private async record(
    id: string,
    r: { status: 'SENT' | 'FAILED'; code: string | null; error: string | null; responseStatus: number | null },
    at: Date,
  ): Promise<void> {
    await this.db.query(
      `update notification_deliveries set status = $2, attempted_at = $3, sent_at = $4, error_code = $5, error = $6,
         response_status = $7, locked_until = null where id = $1`,
      [id, r.status, at, r.status === 'SENT' ? at : null, r.code, r.error, r.responseStatus],
    );
  }

  /** Sends one message through a channel right now (POST /channels/:id/test). Not tied to any incident. */
  async sendTest(channelId: string): Promise<DeliveryOutcome> {
    const exists = await this.db.query('select 1 from notification_channels where id = $1', [channelId]);
    if (exists.rowCount === 0) throw notFound('Notification channel', channelId);
    const channel = await this.loadChannel(channelId);
    if (!channel) return { kind: 'failed', code: 'CHANNEL_DISABLED', error: 'Channel is disabled', retryable: false };
    const provider = this.providers.get(channel.type);
    if (!provider) return { kind: 'failed', code: 'NO_PROVIDER', error: `No provider for ${channel.type}`, retryable: false };

    const now = new Date(this.clock.now());
    const incident: Incident = {
      id: randomUUID(), ruleId: null, ruleName: 'Test notification', deviceId: randomUUID(), interfaceId: null, subjectKey: '',
      severity: 'info', status: 'OPEN', title: 'Test notification from nms-monitoring', metric: null, value: null, threshold: null,
      error: null, triggeredAt: now, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolutionReason: null, lastSeenAt: now,
    };
    return provider.send(channel, { event: 'triggered', deliveryId: randomUUID(), incident, deviceName: 'nms-monitoring' });
  }

  async listForIncident(incidentId: string): Promise<DeliveryRecord[]> {
    const r = await this.db.query<DeliveryRow>(
      'select * from notification_deliveries where incident_id = $1 order by created_at, attempt',
      [incidentId],
    );
    return r.rows.map(mapDelivery);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = this.processDue()
        .catch((err) => this.logger.error({ event: 'scheduler_error', phase: 'notification_worker', error: errorMessage(err) }))
        .finally(() => {
          this.busy = null;
        });
    }, this.settings.workerIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy;
  }
}
