import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailProvider } from '../src/notifications/email.js';
import { telegramText } from '../src/notifications/format.js';
import type { NotificationMessage } from '../src/notifications/provider.js';
import { summarizeDeliveries } from '../src/notifications/notification-service.js';
import { isPrivateAddress } from '../src/notifications/safe-http.js';
import { TelegramProvider } from '../src/notifications/telegram.js';
import { WebhookProvider } from '../src/notifications/webhook.js';
import { createHarness, okReading, snmpOk, type Harness } from './helpers/harness.js';

let h: Harness;
let channelId: string;
beforeAll(async () => {
  h = await createHarness();
  channelId = (await h.channels.create({ name: 'tg', type: 'telegram', config: { chatId: '42' }, credentialId: h.tgCred.id, enabled: true })).id;
});
afterAll(async () => h.close());

async function openIncident(name: string, channelIds: string[]) {
  const dev = await h.newDevice({ name });
  await h.rules.create({ name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 10, severity: 'critical', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds, deviceId: dev.id });
  h.snmp.result = snmpOk({ cpu: okReading(95) });
  await h.pollAndAdvance(dev.id);
  const [incident] = (await h.incidents.list({ deviceId: dev.id })).items;
  return { dev, incident: incident! };
}
const rows = (incidentId: string) => h.notifications.listForIncident(incidentId);

describe('delivery worker', () => {
  beforeEach(() => {
    h.telegram.sent = [];
    h.telegram.outcome = () => ({ kind: 'sent', responseStatus: 200 });
  });

  it('a delivery is PENDING until the worker sends it, then SENT with a timestamp', async () => {
    const { incident } = await openIncident('n-ok', [channelId]);
    let [d] = await rows(incident.id);
    expect(d).toMatchObject({ status: 'PENDING', attempt: 1, event: 'triggered', channelType: 'telegram' });
    expect(d!.sentAt).toBeNull();

    expect(await h.notifications.processDue()).toBe(1);
    [d] = await rows(incident.id);
    expect(d).toMatchObject({ status: 'SENT', attempt: 1, error: null, responseStatus: 200 });
    expect(d!.sentAt).not.toBeNull();
    expect(h.telegram.sent).toHaveLength(1);
    expect(h.telegram.sent[0]!.channel.secret).toEqual({ botToken: '123456:ABC-secret-token' }); // decrypted only in memory
    expect(h.telegram.sent[0]!.message.deviceName).toBe('n-ok');
  });

  it('nothing is sent twice: an already-processed delivery is not picked up again', async () => {
    await openIncident('n-once', [channelId]);
    await h.notifications.processDue();
    const before = h.telegram.sent.length;
    expect(await h.notifications.processDue()).toBe(0);
    expect(h.telegram.sent.length).toBe(before);
  });

  it('a failed attempt is recorded as FAILED with the real error, and a retry is scheduled with backoff', async () => {
    h.telegram.outcome = () => ({ kind: 'failed', code: 'HTTP_502', error: 'Bad gateway', retryable: true, responseStatus: 502 });
    const { incident } = await openIncident('n-retry', [channelId]);

    await h.notifications.processDue();
    let all = await rows(incident.id);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ status: 'FAILED', attempt: 1, errorCode: 'HTTP_502', error: 'Bad gateway', responseStatus: 502 });
    expect(all[1]).toMatchObject({ status: 'PENDING', attempt: 2 });
    expect(all[1]!.scheduledAt.getTime() - h.clock.now()).toBeGreaterThanOrEqual(29_000); // base backoff 30 s

    // not due yet
    expect(await h.notifications.processDue()).toBe(0);

    // becomes due, succeeds
    h.telegram.outcome = () => ({ kind: 'sent', responseStatus: 200 });
    h.clock.advance(31);
    expect(await h.notifications.processDue()).toBe(1);
    all = await rows(incident.id);
    expect(all.map((d) => `${d.attempt}:${d.status}`)).toEqual(['1:FAILED', '2:SENT']);
  });

  it('gives up after maxAttempts and leaves the last attempt FAILED (no fake success)', async () => {
    h.telegram.outcome = () => ({ kind: 'failed', code: 'NETWORK', error: 'connection reset', retryable: true });
    const { incident } = await openIncident('n-giveup', [channelId]);
    for (let i = 0; i < 6; i++) {
      await h.notifications.processDue();
      h.clock.advance(3600);
    }
    const all = await rows(incident.id);
    expect(all.map((d) => `${d.attempt}:${d.status}`)).toEqual(['1:FAILED', '2:FAILED', '3:FAILED']); // maxAttempts = 3
    expect(all.some((d) => d.status === 'SENT')).toBe(false);
    expect(all.some((d) => d.status === 'PENDING')).toBe(false);
  });

  it('a non-retryable failure is not retried', async () => {
    h.telegram.outcome = () => ({ kind: 'failed', code: 'HTTP_401', error: 'Unauthorized', retryable: false, responseStatus: 401 });
    const { incident } = await openIncident('n-noretry', [channelId]);
    await h.notifications.processDue();
    const all = await rows(incident.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'FAILED', errorCode: 'HTTP_401' });
  });

  it('email is NOT_IMPLEMENTED and is never reported as sent', async () => {
    const email = await h.channels.create({ name: 'mail', type: 'email', config: { recipients: ['noc@example.com'] }, enabled: true });
    expect(email.implemented).toBe(false);
    const { incident } = await openIncident('n-email', [email.id]);

    const worker = new (h.notifications.constructor as typeof import('../src/notifications/notification-service.js').NotificationService)(
      h.db, h.credentials, [new EmailProvider()], { maxAttempts: 3, backoffBaseSec: 30, workerIntervalMs: 1000 }, (await import('../src/util/logger.js')).silentLogger(), h.clock,
    );
    await worker.processDue();
    const all = await rows(incident.id);
    expect(all).toHaveLength(1); // not retried
    expect(all[0]).toMatchObject({ status: 'FAILED', errorCode: 'NOT_IMPLEMENTED', channelType: 'email' });
    expect(all[0]!.error).toMatch(/NOT_IMPLEMENTED/);
    expect(all[0]!.sentAt).toBeNull();
  });

  it('a deleted channel yields a FAILED CHANNEL_UNAVAILABLE delivery, not a crash', async () => {
    const tmp = await h.channels.create({ name: 'tmp', type: 'webhook', config: { url: 'https://example.com/hook' }, enabled: true });
    const { incident } = await openIncident('n-gone', [tmp.id]);
    await h.channels.remove(tmp.id);
    await h.notifications.processDue();
    const [d] = await rows(incident.id);
    expect(d).toMatchObject({ status: 'FAILED', errorCode: 'CHANNEL_UNAVAILABLE', channelId: null });
  });

  it('a disabled channel is skipped when incidents are announced', async () => {
    const off = await h.channels.create({ name: 'off', type: 'webhook', config: { url: 'https://example.com/off' }, enabled: false });
    const { incident } = await openIncident('n-disabled', [off.id]);
    expect(await rows(incident.id)).toHaveLength(0);
  });

  it('a rule without channels still creates incidents, just no deliveries', async () => {
    const { incident } = await openIncident('n-nochan', []);
    expect(incident.status).toBe('OPEN');
    expect(await rows(incident.id)).toHaveLength(0);
  });

  it('a provider that throws does not wedge the worker; the row ends FAILED', async () => {
    h.telegram.outcome = () => {
      throw new Error('provider exploded');
    };
    const { incident } = await openIncident('n-throw', [channelId]);
    await h.notifications.processDue();
    const [d] = await rows(incident.id);
    expect(d).toMatchObject({ status: 'FAILED', errorCode: 'INTERNAL' });
    // and the worker is still usable
    h.telegram.outcome = () => ({ kind: 'sent' });
    await openIncident('n-after-throw', [channelId]);
    expect(await h.notifications.processDue()).toBeGreaterThan(0);
  });

  it('sendTest reports the real outcome without creating incident deliveries', async () => {
    h.telegram.outcome = () => ({ kind: 'failed', code: 'HTTP_400', error: 'chat not found', retryable: false });
    const out = await h.notifications.sendTest(channelId);
    expect(out).toMatchObject({ kind: 'failed', code: 'HTTP_400' });
  });
});

// ------------------------------------------------------------------------------------------------------------------
// real HTTP providers against a local server
// ------------------------------------------------------------------------------------------------------------------
interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startServer(handler: (req: Captured, res: http.ServerResponse) => void) {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const c = { url: req.url ?? '', headers: req.headers, body };
      captured.push(c);
      handler(c, res);
    });
  });
  return new Promise<{ base: string; captured: Captured[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, captured, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const msg = (over: Partial<NotificationMessage['incident']> = {}): NotificationMessage => ({
  event: 'triggered',
  deliveryId: 'del-1',
  deviceName: 'core-rtr',
  incident: {
    id: 'inc-1', ruleId: 'r1', ruleName: 'High CPU', deviceId: 'dev-1', interfaceId: null, subjectKey: '', severity: 'critical',
    status: 'OPEN', title: 'High CPU: core-rtr', metric: 'cpu_pct', value: 95.123, threshold: 80, error: null,
    triggeredAt: new Date('2026-03-01T00:00:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null,
    resolutionReason: null, lastSeenAt: new Date('2026-03-01T00:00:00Z'), ...over,
  },
});

describe('Telegram provider (real HTTP)', () => {
  const channel = { id: 'c', name: 'tg', type: 'telegram' as const, config: { chatId: '-100777' }, secret: { botToken: '999:SUPER-SECRET' } };

  it('posts to the bot API and reports SENT on ok', async () => {
    const srv = await startServer((_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    try {
      const tg = new TelegramProvider({ apiBase: srv.base, timeoutMs: 2000, allowPrivate: true });
      expect(await tg.send(channel, msg())).toEqual({ kind: 'sent', responseStatus: 200 });
      expect(srv.captured[0]!.url).toBe('/bot999:SUPER-SECRET/sendMessage');
      const body = JSON.parse(srv.captured[0]!.body);
      expect(body).toMatchObject({ chat_id: '-100777', parse_mode: 'HTML' });
      expect(body.text).toContain('[CRITICAL]');
      expect(body.text).toContain('cpu_pct = 95.12');
    } finally {
      await srv.close();
    }
  });

  it('401 is a non-retryable failure and never echoes the bot token', async () => {
    const srv = await startServer((_r, res) => res.writeHead(401).end('{"ok":false,"description":"Unauthorized"}'));
    try {
      const out = await new TelegramProvider({ apiBase: srv.base, timeoutMs: 2000, allowPrivate: true }).send(channel, msg());
      expect(out).toMatchObject({ kind: 'failed', code: 'HTTP_401', retryable: false });
      expect(JSON.stringify(out)).not.toContain('SUPER-SECRET');
    } finally {
      await srv.close();
    }
  });

  it('5xx and 429 are retryable', async () => {
    for (const status of [429, 500, 503]) {
      const srv = await startServer((_r, res) => res.writeHead(status).end('{}'));
      try {
        const out = await new TelegramProvider({ apiBase: srv.base, timeoutMs: 2000, allowPrivate: true }).send(channel, msg());
        expect(out).toMatchObject({ kind: 'failed', retryable: true, responseStatus: status });
      } finally {
        await srv.close();
      }
    }
  });

  it('an unreachable API is a retryable NETWORK failure that does not leak the token', async () => {
    const out = await new TelegramProvider({ apiBase: 'http://127.0.0.1:1', timeoutMs: 800, allowPrivate: true }).send(channel, msg());
    expect(out).toMatchObject({ kind: 'failed', code: 'NETWORK', retryable: true });
    expect(JSON.stringify(out)).not.toContain('SUPER-SECRET');
  });

  it('escapes HTML in untrusted names', () => {
    const t = telegramText(msg({ title: '<b>x</b> & <script>' }));
    expect(t).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &lt;script&gt;');
    expect(t).not.toContain('<script>');
  });

  it('missing configuration fails clearly without any network call', async () => {
    const out = await new TelegramProvider({ timeoutMs: 500 }).send({ ...channel, secret: null }, msg());
    expect(out).toMatchObject({ kind: 'failed', code: 'NOT_CONFIGURED', retryable: false });
  });
});

describe('Webhook provider (real HTTP)', () => {
  const channel = (url: string, secret?: string) => ({ id: 'c', name: 'wh', type: 'webhook' as const, config: { url }, secret: secret ? { secret } : null });

  it('delivers a signed JSON payload; the HMAC verifies with the shared secret', async () => {
    const srv = await startServer((_r, res) => res.writeHead(204).end());
    try {
      const out = await new WebhookProvider({ timeoutMs: 2000, allowPrivate: true }).send(channel(`${srv.base}/hook`, 'topsecret-value'), msg());
      expect(out).toEqual({ kind: 'sent', responseStatus: 204 });
      const req = srv.captured[0]!;
      const expected = createHmac('sha256', 'topsecret-value').update(`${req.headers['x-nms-timestamp']}.${req.body}`).digest('hex');
      expect(req.headers['x-nms-signature']).toBe(`sha256=${expected}`);
      expect(req.headers['x-nms-event']).toBe('incident.triggered');
      expect(JSON.parse(req.body)).toMatchObject({ event: 'incident.triggered', incident: { id: 'inc-1', severity: 'critical', value: 95.123 } });
    } finally {
      await srv.close();
    }
  });

  it('HTTP 500 is a retryable failure; HTTP 404 is not', async () => {
    const srv = await startServer((r, res) => res.writeHead(r.url === '/gone' ? 404 : 500).end());
    try {
      const wh = new WebhookProvider({ timeoutMs: 2000, allowPrivate: true });
      expect(await wh.send(channel(`${srv.base}/x`), msg())).toMatchObject({ kind: 'failed', retryable: true, code: 'HTTP_500' });
      expect(await wh.send(channel(`${srv.base}/gone`), msg())).toMatchObject({ kind: 'failed', retryable: false, code: 'HTTP_404' });
    } finally {
      await srv.close();
    }
  });

  it('redirects are not followed (would bypass the address check)', async () => {
    const srv = await startServer((_r, res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end());
    try {
      const out = await new WebhookProvider({ timeoutMs: 2000, allowPrivate: true }).send(channel(`${srv.base}/r`), msg());
      expect(out).toMatchObject({ kind: 'failed', code: 'HTTP_302', retryable: false });
    } finally {
      await srv.close();
    }
  });

  it('blocks loopback / private / metadata targets by default (SSRF), including hostnames that resolve to them', async () => {
    const wh = new WebhookProvider({ timeoutMs: 1000, allowPrivate: false });
    for (const url of ['http://127.0.0.1:8080/x', 'http://10.1.2.3/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://localhost:8080/x']) {
      const out = await wh.send(channel(url), msg());
      expect(out, url).toMatchObject({ kind: 'failed', code: 'TARGET_NOT_ALLOWED', retryable: false });
    }
  });

  it('only http(s) schemes are allowed', async () => {
    const out = await new WebhookProvider({ timeoutMs: 500, allowPrivate: true }).send(channel('file:///etc/passwd'), msg());
    expect(out).toMatchObject({ kind: 'failed', code: 'TARGET_NOT_ALLOWED' });
  });
});

describe('address classification', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1'])(
    'private: %s', (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '203.0.113.9', '2606:4700:4700::1111'])('public: %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

// ------------------------------------------------------------------------------------------------------------------
// notification phases: what the database / API can tell an operator about one notification
// ------------------------------------------------------------------------------------------------------------------
describe('delivery phases (requested / retrying / sent / failed)', () => {
  const phaseOf = async (incidentId: string) => summarizeDeliveries(await h.notifications.listForIncident(incidentId));

  it('REQUESTED -> RETRYING -> SENT, with the failed attempt kept as history and no premature "delivered"', async () => {
    h.telegram.outcome = () => ({ kind: 'failed', code: 'HTTP_502', error: 'Bad gateway', retryable: true, responseStatus: 502 });
    const { incident } = await openIncident('ph-retry', [channelId]);

    expect(await phaseOf(incident.id)).toMatchObject([{ phase: 'REQUESTED', attempts: 0, sentAt: null, lastError: null }]);

    await h.notifications.processDue();
    const mid = await phaseOf(incident.id);
    expect(mid).toHaveLength(1);
    expect(mid[0]).toMatchObject({ phase: 'RETRYING', attempts: 1, lastErrorCode: 'HTTP_502', lastError: 'Bad gateway', sentAt: null });
    expect(mid[0]!.nextAttemptAt).not.toBeNull();

    h.telegram.outcome = () => ({ kind: 'sent', responseStatus: 200 });
    h.clock.advance(31);
    await h.notifications.processDue();
    const done = await phaseOf(incident.id);
    expect(done[0]).toMatchObject({ phase: 'SENT', attempts: 2, nextAttemptAt: null });
    expect(done[0]!.sentAt).not.toBeNull();
    expect(done[0]!.lastError).toBe('Bad gateway'); // the earlier failure is still visible
  });

  it('FAILED only after attempts are exhausted; the phase never claims delivery', async () => {
    h.telegram.outcome = () => ({ kind: 'failed', code: 'NETWORK', error: 'connection reset', retryable: true });
    const { incident } = await openIncident('ph-exhaust', [channelId]);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await h.notifications.processDue();
      seen.push((await phaseOf(incident.id))[0]!.phase);
      h.clock.advance(3600);
    }
    expect(seen.slice(0, 3)).toEqual(['RETRYING', 'RETRYING', 'FAILED']); // maxAttempts = 3
    expect(seen.at(-1)).toBe('FAILED');
    const s = (await phaseOf(incident.id))[0]!;
    expect(s).toMatchObject({ attempts: 3, sentAt: null, nextAttemptAt: null });
    const rows = await h.notifications.listForIncident(incident.id);
    expect(rows.every((r) => r.status !== 'SENT')).toBe(true);
  });

  it('a non-retryable failure is FAILED immediately (1 attempt)', async () => {
    h.telegram.outcome = () => ({ kind: 'failed', code: 'HTTP_401', error: 'Unauthorized', retryable: false, responseStatus: 401 });
    const { incident } = await openIncident('ph-401', [channelId]);
    await h.notifications.processDue();
    expect((await phaseOf(incident.id))[0]).toMatchObject({ phase: 'FAILED', attempts: 1, lastErrorCode: 'HTTP_401' });
  });

  it('recovery notifications are tracked separately from the trigger notification', async () => {
    h.telegram.outcome = () => ({ kind: 'sent', responseStatus: 200 });
    const dev = await h.newDevice({ name: 'ph-recovery' });
    await h.rules.create({ name: 'CPU', conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 50, severity: 'critical', triggerAfter: 1, clearAfter: 1, cooldownSec: 0, notifyOnRecovery: true, enabled: true, channelIds: [channelId], deviceId: dev.id });
    h.snmp.result = snmpOk({ cpu: okReading(90) });
    await h.pollAndAdvance(dev.id);
    h.snmp.result = snmpOk({ cpu: okReading(5) });
    await h.pollAndAdvance(dev.id);
    const [incident] = (await h.incidents.list({ deviceId: dev.id })).items;
    await h.notifications.processDue();
    const s = await phaseOf(incident!.id);
    expect(s.map((x) => `${x.event}:${x.phase}`).sort()).toEqual(['recovered:SENT', 'triggered:SENT']);
  });

  it('email is reported FAILED / NOT_IMPLEMENTED, never SENT', async () => {
    const mail = await h.channels.create({ name: 'mail-phase', type: 'email', config: { recipients: ['ops@example.com'] }, enabled: true });
    const { incident } = await openIncident('ph-mail', [mail.id]);
    const { NotificationService } = await import('../src/notifications/notification-service.js');
    const { silentLogger } = await import('../src/util/logger.js');
    const worker = new NotificationService(h.db, h.credentials, [new EmailProvider()], { maxAttempts: 3, backoffBaseSec: 30, workerIntervalMs: 1000 }, silentLogger(), h.clock);
    await worker.processDue();
    expect((await phaseOf(incident.id))[0]).toMatchObject({ phase: 'FAILED', lastErrorCode: 'NOT_IMPLEMENTED', sentAt: null, attempts: 1 });
  });
});
