import type { Database } from '../database/db.js';
import type { PollListener, PollSnapshot } from '../devices/types.js';
import { errorMessage, type Logger } from '../util/logger.js';
import { evaluateRule } from './evaluate.js';
import type { IncidentManager } from './incident-manager.js';
import type { RuleService } from './rules.js';

/**
 * Runs after every poll. Completely separate from collection: it sees only the PollSnapshot (real observations),
 * decides verdicts per rule, and hands them to the incident manager.
 */
export class AlertEvaluator implements PollListener {
  constructor(
    private readonly db: Database,
    private readonly rules: RuleService,
    private readonly incidents: IncidentManager,
    private readonly logger: Logger,
  ) {}

  async onPollCompleted(snapshot: PollSnapshot): Promise<void> {
    const rules = await this.rules.enabledFor(this.db, snapshot.deviceId);
    const device = { id: snapshot.deviceId, name: snapshot.deviceName };

    for (const rule of rules) {
      // One broken rule must never prevent the others from being evaluated.
      try {
        const evaluation = evaluateRule(rule, snapshot);
        for (const subject of evaluation.subjects) await this.incidents.processSubject(rule, device, subject);
        if (evaluation.complete) {
          await this.incidents.resolveMissing(rule, device, new Set(evaluation.subjects.map((s) => s.subjectKey)));
        }
      } catch (err) {
        this.logger.error({ event: 'alert_evaluation_failed', ruleId: rule.id, deviceId: device.id, error: errorMessage(err) });
      }
    }
  }
}
