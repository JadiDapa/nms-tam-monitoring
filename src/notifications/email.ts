import type { ChannelRuntime, DeliveryOutcome, NotificationMessage, NotificationProvider } from './provider.js';

/**
 * Placeholder for a future SMTP provider. It deliberately NEVER reports success: an email channel that cannot
 * send must show up as failed/NOT_IMPLEMENTED, not as "delivered".
 */
export class EmailProvider implements NotificationProvider {
  readonly type = 'email' as const;

  async send(_channel: ChannelRuntime, _message: NotificationMessage): Promise<DeliveryOutcome> {
    return { kind: 'not_implemented', error: 'NOT_IMPLEMENTED: email delivery is not available in this version' };
  }
}
