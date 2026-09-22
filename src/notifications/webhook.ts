import { createHmac } from 'node:crypto';
import { webhookPayload } from './format.js';
import type { ChannelRuntime, DeliveryOutcome, NotificationMessage, NotificationProvider } from './provider.js';
import { findBlockedError, safePost } from './safe-http.js';

export interface WebhookOptions {
  timeoutMs: number;
  allowPrivate: boolean;
}

export class WebhookProvider implements NotificationProvider {
  readonly type = 'webhook' as const;

  constructor(private readonly o: WebhookOptions) {}

  async send(channel: ChannelRuntime, message: NotificationMessage): Promise<DeliveryOutcome> {
    const url = String(channel.config.url ?? '');
    if (!url) return { kind: 'failed', code: 'NOT_CONFIGURED', error: 'Webhook channel has no url', retryable: false };

    const body = JSON.stringify(webhookPayload(message));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'nms-monitoring/1.0',
      'x-nms-event': `incident.${message.event}`,
      'x-nms-delivery': message.deliveryId,
      'x-nms-timestamp': timestamp,
    };
    const secret = channel.secret?.secret;
    if (typeof secret === 'string' && secret) {
      // signature covers timestamp + body so a captured request cannot be replayed indefinitely
      headers['x-nms-signature'] = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
    }

    try {
      const res = await safePost(url, { headers, body, timeoutMs: this.o.timeoutMs, allowPrivate: this.o.allowPrivate });
      if (res.ok) return { kind: 'sent', responseStatus: res.status };
      const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
      return {
        kind: 'failed',
        code: `HTTP_${res.status}`,
        error: `Webhook endpoint answered HTTP ${res.status}`,
        retryable,
        responseStatus: res.status,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const blocked = findBlockedError(err);
      if (blocked) return { kind: 'failed', code: blocked.code, error: blocked.message, retryable: false };
      // Node wraps the real cause ("connect ECONNREFUSED ...") in `cause`
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
      return { kind: 'failed', code: 'NETWORK', error: `Webhook request failed: ${msg}${cause}`.slice(0, 500), retryable: true };
    }
  }
}
