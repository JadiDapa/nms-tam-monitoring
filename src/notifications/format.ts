import type { NotificationMessage } from './provider.js';

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SEVERITY_ICON = { critical: '🔴', warning: '🟠', info: '🔵' } as const;

/**
 * Telegram HTML text. Every dynamic value is escaped: device names, interface names and SNMP-supplied strings
 * are untrusted input and must not be able to inject markup.
 */
export function telegramText(m: NotificationMessage): string {
  const i = m.incident;
  const head =
    m.event === 'triggered'
      ? `${SEVERITY_ICON[i.severity]} <b>[${i.severity.toUpperCase()}]</b> ${escapeHtml(i.title)}`
      : `✅ <b>RESOLVED</b> ${escapeHtml(i.title)}`;
  const lines = [head, '', `<b>Device:</b> ${escapeHtml(m.deviceName)}`, `<b>Rule:</b> ${escapeHtml(i.ruleName)}`];
  if (i.metric && i.value !== null) {
    const thr = i.threshold !== null ? ` (threshold ${i.threshold})` : '';
    lines.push(`<b>Value:</b> ${escapeHtml(i.metric)} = ${Math.round(i.value * 100) / 100}${thr}`);
  }
  if (i.error) lines.push(`<b>Detail:</b> ${escapeHtml(i.error)}`);
  lines.push(`<b>Triggered:</b> ${i.triggeredAt.toISOString()}`);
  if (m.event === 'recovered' && i.resolvedAt) lines.push(`<b>Resolved:</b> ${i.resolvedAt.toISOString()}`);
  return lines.join('\n');
}

export function webhookPayload(m: NotificationMessage) {
  const i = m.incident;
  return {
    event: `incident.${m.event}`,
    deliveryId: m.deliveryId,
    timestamp: new Date().toISOString(),
    device: { id: i.deviceId, name: m.deviceName },
    incident: {
      id: i.id,
      ruleId: i.ruleId,
      ruleName: i.ruleName,
      severity: i.severity,
      status: i.status,
      title: i.title,
      interfaceId: i.interfaceId,
      metric: i.metric,
      value: i.value,
      threshold: i.threshold,
      error: i.error,
      triggeredAt: i.triggeredAt.toISOString(),
      acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
    },
  };
}
