import type { PollSnapshot } from '../devices/types.js';
import { isInterfaceMetric, type AlertRule, type Operator } from './rules.js';

/**
 * Pure alert-condition evaluation: real observations in, verdicts out. No database, no notifications.
 *
 *  breach   the condition is currently true
 *  ok       the condition is currently false
 *  unknown  it cannot be decided (metric unavailable, agent silent). Unknown NEVER opens or closes an incident:
 *           "we could not measure" is not evidence of health or of a problem.
 */
export type Verdict = 'breach' | 'ok' | 'unknown';

export interface SubjectResult {
  /** '' for device-level conditions, the interface id for per-interface conditions */
  subjectKey: string;
  interfaceId: string | null;
  label: string | null;
  verdict: Verdict;
  metric: string | null;
  value: number | null;
  threshold: number | null;
  error: string | null;
}

export interface RuleEvaluation {
  subjects: SubjectResult[];
  /**
   * true when `subjects` is the complete list of things the rule applies to right now. Open incidents for a subject
   * that is no longer listed (e.g. an interface that was removed) are then resolved.
   */
  complete: boolean;
}

export function compare(op: Operator, value: number, threshold: number): boolean {
  switch (op) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '==':
      return value === threshold;
    case '!=':
      return value !== threshold;
  }
}

const deviceSubject = (over: Partial<SubjectResult> & Pick<SubjectResult, 'verdict'>): SubjectResult => ({
  subjectKey: '',
  interfaceId: null,
  label: null,
  metric: null,
  value: null,
  threshold: null,
  error: null,
  ...over,
});

const DOWN_LIKE = new Set(['down', 'lowerLayerDown', 'notPresent']);

export function evaluateRule(rule: AlertRule, snap: PollSnapshot): RuleEvaluation {
  switch (rule.conditionType) {
    case 'device_down': {
      const s = snap.reachability.state;
      const verdict = s === 'DOWN' || s === 'RECOVERING' ? 'breach' : s === 'UNKNOWN' ? 'unknown' : 'ok';
      return { complete: true, subjects: [deviceSubject({ verdict, metric: 'reachability' })] };
    }

    case 'snmp_unavailable': {
      // SNMP not configured => the condition cannot exist (and any old incident should close).
      if (!snap.snmp) return { complete: true, subjects: [deviceSubject({ verdict: 'ok', metric: 'snmp' })] };
      const s = snap.snmp.state;
      const verdict = s === 'DOWN' || s === 'RECOVERING' ? 'breach' : s === 'UNKNOWN' ? 'unknown' : 'ok';
      return { complete: true, subjects: [deviceSubject({ verdict, metric: 'snmp' })] };
    }

    case 'interface_down': {
      if (!snap.interfacesCollected) return { complete: false, subjects: [] };
      const subjects = snap.interfaces
        .filter((i) => i.monitored)
        .map<SubjectResult>((i) => {
          // An incident needs ALL of: administratively up, operationally down, and previously observed operationally
          // up. Administratively down is intentional; "never seen up" is an unused port / empty cage / unplugged NIC,
          // not an outage. (An interface first observed already down cannot be told apart from a never-used one.)
          const shouldBeUp = i.adminStatus === 'up';
          const oper = i.operStatus;
          const verdict: Verdict = !shouldBeUp
            ? 'ok'
            : oper === 'up'
              ? 'ok'
              : oper && DOWN_LIKE.has(oper)
                ? i.everUp
                  ? 'breach'
                  : 'ok'
                : 'unknown';
          return {
            subjectKey: i.interfaceId,
            interfaceId: i.interfaceId,
            label: i.name,
            verdict,
            metric: 'if_oper_status',
            value: null,
            threshold: null,
            error: null,
          };
        });
      return { complete: true, subjects };
    }

    case 'metric_threshold': {
      const metric = rule.metric!;
      const op = rule.operator!;
      const threshold = rule.threshold!;

      if (isInterfaceMetric(metric)) {
        if (!snap.interfacesCollected) return { complete: false, subjects: [] };
        const subjects = snap.interfaces
          .filter((i) => i.monitored)
          .map<SubjectResult>((i) => {
            const value = metric === 'if_in_bps' ? i.inBps : i.outBps;
            return {
              subjectKey: i.interfaceId,
              interfaceId: i.interfaceId,
              label: i.name,
              verdict: value === null ? 'unknown' : compare(op, value, threshold) ? 'breach' : 'ok',
              metric,
              value,
              threshold,
              error: value === null ? 'rate not available for this sample' : null,
            };
          });
        return { complete: true, subjects };
      }

      const m = snap.metrics[metric];
      if (!m || m.status !== 'ok' || m.value === null) {
        return {
          complete: true,
          subjects: [deviceSubject({ verdict: 'unknown', metric, threshold, error: m?.error ?? `${metric} was not collected` })],
        };
      }
      return {
        complete: true,
        subjects: [deviceSubject({ verdict: compare(op, m.value, threshold) ? 'breach' : 'ok', metric, value: m.value, threshold })],
      };
    }
  }
}
