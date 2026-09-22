import { telegramText } from './format.js';
import type { ChannelRuntime, DeliveryOutcome, NotificationMessage, NotificationProvider } from './provider.js';
import { findBlockedError, safePost } from './safe-http.js';

export interface TelegramOptions {
  apiBase?: string;
  timeoutMs: number;
  /** tests point the provider at a local HTTP server */
  allowPrivate?: boolean;
}

export class TelegramProvider implements NotificationProvider {
  readonly type = 'telegram' as const;
  private readonly apiBase: string;

  constructor(private readonly o: TelegramOptions) {
    this.apiBase = (o.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
  }

  async send(channel: ChannelRuntime, message: NotificationMessage): Promise<DeliveryOutcome> {
    const token = String(channel.secret?.botToken ?? '');
    const chatId = String(channel.config.chatId ?? '');
    if (!token || !chatId) {
      return { kind: 'failed', code: 'NOT_CONFIGURED', error: 'Telegram channel needs a bot token and a chatId', retryable: false };
    }
    try {
      const res = await safePost(`${this.apiBase}/bot${token}/sendMessage`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: telegramText(message), parse_mode: 'HTML', disable_web_page_preview: true }),
        timeoutMs: this.o.timeoutMs,
        allowPrivate: this.o.allowPrivate ?? false,
      });
      if (res.ok) return { kind: 'sent', responseStatus: res.status };

      // Telegram explains itself in the JSON body; never echo the token.
      let detail = res.snippet;
      try {
        detail = (JSON.parse(res.snippet) as { description?: string }).description ?? res.snippet;
      } catch {
        // keep raw snippet
      }
      const retryable = res.status === 429 || res.status >= 500;
      return { kind: 'failed', code: `HTTP_${res.status}`, error: `Telegram rejected the message: ${detail}`.slice(0, 500), retryable, responseStatus: res.status };
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split(token).join('[REDACTED]');
      const blocked = findBlockedError(err);
      if (blocked) return { kind: 'failed', code: blocked.code, error: blocked.message, retryable: false };
      return { kind: 'failed', code: 'NETWORK', error: `Could not reach Telegram: ${msg}`.slice(0, 500), retryable: true };
    }
  }
}
