import type { Incident, NotificationEvent } from '../alerts/incident-manager.js';

export type ChannelType = 'telegram' | 'webhook' | 'email';

/** A channel with its secret already decrypted, only ever held in memory for the duration of one send. */
export interface ChannelRuntime {
  id: string;
  name: string;
  type: ChannelType;
  config: Record<string, unknown>;
  secret: Record<string, unknown> | null;
}

export interface NotificationMessage {
  event: NotificationEvent;
  deliveryId: string;
  incident: Incident;
  deviceName: string;
}

/**
 * The only three honest results of a delivery attempt.
 *  sent             the destination accepted the message (2xx / ok:true)
 *  failed           it did not; `retryable` says whether trying again can help
 *  not_implemented  this channel type cannot deliver at all (never reported as sent)
 */
export type DeliveryOutcome =
  | { kind: 'sent'; responseStatus?: number }
  | { kind: 'failed'; code: string; error: string; retryable: boolean; responseStatus?: number }
  | { kind: 'not_implemented'; error: string };

export interface NotificationProvider {
  readonly type: ChannelType;
  send(channel: ChannelRuntime, message: NotificationMessage): Promise<DeliveryOutcome>;
}
