import type { Queryable } from '../database/db.js';
import type { Incident, NotificationEnqueuer, NotificationEvent } from './incident-manager.js';

/** Swallows notifications instead of enqueuing them. Used when incidents are backfilled/simulated and must not page anyone. */
export class NoopNotifier implements NotificationEnqueuer {
  async enqueue(_tx: Queryable, _incident: Incident, _event: NotificationEvent, _ruleId: string | null): Promise<number> {
    return 0;
  }
}
