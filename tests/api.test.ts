import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { createEngine, type Engine } from '../src/engine.js';
import { createLogger } from '../src/util/logger.js';
import { deadPort, FakeSnmpDevice } from './helpers/fake-snmp-device.js';
import { RecordingProvider } from './helpers/harness.js';
import { createTestDb } from './helpers/test-db.js';

const API_KEY = 'test-api-key-0123456789-abcdefghij';
const COMMUNITY = 'very-secret-community-9876';

let engine: Engine;
let snmpDevice: FakeSnmpDevice;
let db: Awaited<ReturnType<typeof createTestDb>>;
const logLines: string[] = [];
const webhook = new RecordingProvider('webhook');
const telegram = new RecordingProvider('telegram');

const auth = { authorization: `Bearer ${API_KEY}` };
const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = auth) => {
  const res = await engine.app.inject({ method, url, headers, payload: payload as never });
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
};

beforeAll(async () => {
  snmpDevice = await new FakeSnmpDevice({
    sysName: 'lab-rtr',
    sysDescr: 'Lab Router 9000',
    cpuLoads: [20, 40],
    memory: [{ descr: 'main memory', type: '1.3.6.1.2.1.25.2.1.2', size: 1000, used: 300 }],
    community: COMMUNITY,
    interfaces: [
      { index: 1, name: 'ether1', speedMbps: 1000, inHc: 18_000_000_000_000_000_000n, outHc: 5n },
      { index: 2, name: 'ether2', oper: 2 },
    ],
  }).start();

  db = await createTestDb();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'unused',
    ENGINE_API_KEYS: API_KEY,
    ENGINE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SCHEDULER_ENABLED: 'false',
  });
  engine = await createEngine({ config, db, logger: createLogger("debug", { destination: { write: (c: string) => logLines.push(c) } }), providers: [webhook, telegram] });
});

afterAll(async () => {
  await engine.stop();
  await snmpDevice.stop();
  await db.close();
});

describe('authentication', () => {
  it('/health is public and reveals nothing sensitive', async () => {
    const r = await call('GET', '/health', undefined, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', database: 'ok', version: '0.1.0' });
    expect(JSON.stringify(r.body)).not.toMatch(/key|secret|password/i);
  });

  it('everything else requires an API key', async () => {
    for (const [m, u] of [['GET', '/devices'], ['GET', '/incidents'], ['GET', '/alerts'], ['GET', '/credentials'], ['POST', '/devices/test'], ['GET', '/channels']] as const) {
      const r = await call(m, u, undefined, {});
      expect(r.status, `${m} ${u}`).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects a wrong key, accepts Bearer and X-API-Key', async () => {
    expect((await call('GET', '/devices', undefined, { authorization: 'Bearer nope-nope-nope-nope-nope-nope' })).status).toBe(401);
    expect((await call('GET', '/devices', undefined, { 'x-api-key': 'nope' })).status).toBe(401);
    expect((await call('GET', '/devices', undefined, { authorization: `Bearer ${API_KEY}` })).status).toBe(200);
    expect((await call('GET', '/devices', undefined, { 'x-api-key': API_KEY })).status).toBe(200);
  });

  it('unknown routes are 404 JSON, still behind auth', async () => {
    expect((await call('GET', '/nope', undefined, {})).status).toBe(401);
    const r = await call('GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('credentials are write-only', () => {
  it('never returns the secret, in any response', async () => {
    const created = await call('POST', '/credentials', { name: 'lab-snmp', type: 'snmp_v2c', secret: { community: COMMUNITY } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'lab-snmp', type: 'snmp_v2c', hasSecret: true, keyId: 'k1' });
    expect(created.raw).not.toContain(COMMUNITY);

    const list = await call('GET', '/credentials');
    const one = await call('GET', `/credentials/${created.body.id}`);
    expect(list.raw).not.toContain(COMMUNITY);
    expect(one.raw).not.toContain(COMMUNITY);
    expect(Object.keys(one.body)).not.toContain('secret');

    // and it is really encrypted at rest
    const row = await db.query<{ secret_encrypted: string }>('select secret_encrypted from credentials where id = $1', [created.body.id]);
    expect(row.rows[0]!.secret_encrypted).not.toContain(COMMUNITY);
    expect(row.rows[0]!.secret_encrypted.startsWith('v1.k1.')).toBe(true);
  });

  it('validation errors do not echo submitted secrets', async () => {
    const r = await call('POST', '/credentials', { name: 'bad', type: 'snmp_v3', secret: { username: 'u', authProtocol: 'SHA', authKey: 'short' } });
    expect(r.status).toBe(400);
    expect(r.raw).not.toContain('"short"');
    expect(r.body.error.code).toBe('INVALID_SECRET');
  });

  it('refuses to delete a credential that is in use', async () => {
    const cred = (await call('POST', '/credentials', { name: 'in-use', type: 'snmp_v2c', secret: { community: 'abc-def-ghi' } })).body;
    await call('POST', '/devices', { name: 'uses-cred', host: '127.0.0.1', snmpEnabled: true, snmpCredentialId: cred.id });
    const del = await call('DELETE', `/credentials/${cred.id}`);
    expect(del.status).toBe(409);
  });
});

describe('request validation', () => {
  it('malformed input is a 400 with field details', async () => {
    const r = await call('POST', '/devices', { name: '', host: 'bad host!!', pollIntervalSec: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details.length).toBeGreaterThan(0);
  });

  it('non-UUID ids are 400, unknown ids are 404', async () => {
    expect((await call('GET', '/devices/not-a-uuid')).status).toBe(400);
    expect((await call('GET', '/devices/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await call('GET', '/incidents/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('polling interval below the floor is rejected', async () => {
    const r = await call('POST', '/devices', { name: 'x', host: '127.0.0.1', polling: { pollIntervalSec: 1 } });
    expect(r.status).toBe(400);
  });
});

describe('POST /devices/test (stateless)', () => {
  let credId: string;
  beforeAll(async () => {
    credId = (await call('POST', '/credentials', { name: 'test-cred', type: 'snmp_v2c', secret: { community: COMMUNITY } })).body.id;
  });

  it('returns REAL results from a real SNMP agent + real ICMP, and saves nothing', async () => {
    const before = await db.query<{ n: string }>('select (select count(*) from devices)::text || \'/\' || (select count(*) from device_metric_samples)::text as n');
    const r = await call('POST', '/devices/test', {
      host: '127.0.0.1', icmp: true, icmpCount: 1, tcpPorts: [], timeoutMs: 800,
      snmp: { communityCredentialId: credId, port: snmpDevice.port },
    });
    expect(r.status).toBe(200);
    expect(r.body.reachable).toBe(true);
    expect(r.body.latencyMs).not.toBeNull();
    expect(r.body.icmp).toMatchObject({ status: 'ok', reachable: true, packetLossPct: 0 });
    expect(r.body.snmp).toMatchObject({ success: true, status: 'ok', profile: 'standard' });
    expect(r.body.snmp.system).toMatchObject({ sysName: 'lab-rtr', sysDescr: 'Lab Router 9000' });
    expect(r.body.snmp.cpu).toEqual({ status: 'ok', value: 30, error: null });
    expect(r.body.snmp.memory).toEqual({ status: 'ok', value: 30, error: null });
    expect(r.body.snmp.interfaces.count).toBe(2);
    expect(r.body.snmp.interfaces.items.map((i: any) => i.name)).toEqual(['ether1', 'ether2']);
    expect(r.raw).not.toContain(COMMUNITY);

    const after = await db.query<{ n: string }>('select (select count(*) from devices)::text || \'/\' || (select count(*) from device_metric_samples)::text as n');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('reports the actual failure for an unreachable SNMP agent (nothing invented)', async () => {
    const r = await call('POST', '/devices/test', {
      host: '127.0.0.1', icmp: false, timeoutMs: 400, snmp: { credentialId: credId, port: await deadPort() },
    });
    expect(r.status).toBe(200);
    expect(r.body.reachable).toBe(false);
    expect(r.body.latencyMs).toBeNull();
    expect(r.body.icmp).toBeNull();
    expect(r.body.snmp).toMatchObject({ success: false, status: 'unavailable', system: null });
    expect(r.body.snmp.error).toMatch(/timed out/i);
    expect(r.body.snmp.cpu).toMatchObject({ status: 'unavailable', value: null });
  });

  it('an ICMP-only test of a silent address says so', async () => {
    const r = await call('POST', '/devices/test', { host: '192.0.2.77', icmp: true, icmpCount: 1, timeoutMs: 400 });
    expect(r.body.reachable).toBe(false);
    expect(r.body.latencyMs).toBeNull();
    expect(r.body.icmp).toMatchObject({ status: 'unavailable', packetLossPct: 100, avgMs: null });
  });

  it('rejects a test that checks nothing, and unknown credentials', async () => {
    expect((await call('POST', '/devices/test', { host: '127.0.0.1', icmp: false })).status).toBe(400);
    expect((await call('POST', '/devices/test', { host: '127.0.0.1', snmp: { credentialId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
  });

  it('cannot be pointed at arbitrary flags / commands', async () => {
    expect((await call('POST', '/devices/test', { host: '-c 100000 127.0.0.1' })).status).toBe(400);
    expect((await call('POST', '/devices/test', { host: '127.0.0.1; whoami' })).status).toBe(400);
  });
});

describe('device lifecycle, polling and history through the API', () => {
  let deviceId: string;
  let credId: string;

  beforeAll(async () => {
    credId = (await call('POST', '/credentials', { name: 'dev-cred', type: 'snmp_v2c', secret: { community: COMMUNITY } })).body.id;
  });

  it('creates a device; identity fields are null until the device reports them', async () => {
    const r = await call('POST', '/devices', {
      name: 'lab-rtr', host: '127.0.0.1', deviceType: 'router', snmpEnabled: true, snmpCredentialId: credId, snmpPort: snmpDevice.port,
      icmpEnabled: true, polling: { pollIntervalSec: 15, timeoutMs: 800, retryCount: 0, failureThreshold: 2, recoveryThreshold: 1, icmpCount: 1 },
    });
    expect(r.status).toBe(201);
    deviceId = r.body.id;
    expect(r.body).toMatchObject({ sysName: null, sysDescr: null, polling: { pollIntervalSec: 15, failureThreshold: 2 }, snmpCredentialId: credId });
    expect(r.raw).not.toContain(COMMUNITY);
  });

  it('POST /devices/:id/test uses the stored configuration and writes nothing', async () => {
    const r = await call('POST', `/devices/${deviceId}/test`);
    expect(r.status).toBe(200);
    expect(r.body.snmp.success).toBe(true);
    expect((await call('GET', `/devices/${deviceId}/metrics`)).body.count).toBe(0);
  });

  it('POST /devices/:id/poll runs a real poll and returns the full report', async () => {
    const r = await call('POST', `/devices/${deviceId}/poll`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      deviceId, reachable: true, state: { reachability: 'UP', snmp: 'UP' },
      icmp: { status: 'ok' }, snmp: { status: 'ok', profile: 'standard' },
    });
    expect(r.body.snmp.cpu.value).toBe(30);
    expect(r.body.metricsWritten).toBeGreaterThan(5);
    expect(r.raw).not.toContain(COMMUNITY);
  });

  it('GET /devices/:id/status shows state, real identity and latest metrics', async () => {
    const r = await call('GET', `/devices/${deviceId}/status`);
    expect(r.status).toBe(200);
    expect(r.body.device).toMatchObject({ sysName: 'lab-rtr', sysDescr: 'Lab Router 9000', snmpProfile: 'standard' });
    expect(r.body.state.reachability.state).toBe('UP');
    const cpu = r.body.latestMetrics.find((m: any) => m.metric === 'cpu_pct');
    expect(cpu).toMatchObject({ value: 30, status: 'ok' });
  });

  it('GET /devices/:id/metrics filters by metric and range', async () => {
    const r = await call('GET', `/devices/${deviceId}/metrics?metric=cpu_pct&limit=5`);
    expect(r.status).toBe(200);
    expect(r.body.items.every((m: any) => m.metric === 'cpu_pct')).toBe(true);
    const future = await call('GET', `/devices/${deviceId}/metrics?from=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`);
    expect(future.body.count).toBe(0);
    expect((await call('GET', `/devices/${deviceId}/metrics?limit=0`)).status).toBe(400);
  });

  it('GET /devices/:id/interfaces lists per-interface data; 64-bit counters are exact decimal strings', async () => {
    const r = await call('GET', `/devices/${deviceId}/interfaces`);
    expect(r.status).toBe(200);
    const [e1, e2] = r.body.items;
    expect(e1).toMatchObject({ name: 'ether1', speedBps: 1_000_000_000, adminStatus: 'up', operStatus: 'up', monitored: true });
    expect(e1.latest.inOctets).toBe('18000000000000000000'); // > 2^53, exact
    expect(e1.latest).toMatchObject({ outOctets: '5', inBps: null, rateNote: 'first_sample', counterBits: 64 });
    expect(e2).toMatchObject({ name: 'ether2', operStatus: 'down' });
  });

  it('a second poll derives a real rate from the first sample', async () => {
    snmpDevice.setCounters(1, { inHc: 18_000_000_000_000_000_000n + 1_000_000n, outHc: 5n });
    await new Promise((r) => setTimeout(r, 1100));
    await call('POST', `/devices/${deviceId}/poll`);
    const r = await call('GET', `/devices/${deviceId}/interfaces`);
    const e1 = r.body.items[0];
    expect(e1.latest.rateNote).toBeNull();
    expect(e1.latest.inBps).toBeGreaterThan(0); // (1,000,000 octets * 8) / ~1.1s ≈ 7 Mbit/s
    expect(e1.latest.inBps).toBeLessThan(10_000_000);
    expect(e1.latest.outBps).toBe(0);
  });

  it('PATCH /devices/:id/interfaces/:id toggles monitoring', async () => {
    const ifs = (await call('GET', `/devices/${deviceId}/interfaces`)).body.items;
    const r = await call('PATCH', `/devices/${deviceId}/interfaces/${ifs[1].id}`, { monitored: false });
    expect(r.body).toEqual({ id: ifs[1].id, monitored: false });
    const hist = await call('GET', `/devices/${deviceId}/interfaces/${ifs[0].id}/metrics`);
    expect(hist.body.count).toBe(2);
  });

  it('PATCH /devices/:id changes polling config', async () => {
    const r = await call('PATCH', `/devices/${deviceId}`, { polling: { pollIntervalSec: 60 }, location: 'Rack 4' });
    expect(r.body).toMatchObject({ location: 'Rack 4', polling: { pollIntervalSec: 60, timeoutMs: 800 } });
  });

  it('DELETE removes the device and its history', async () => {
    const tmp = (await call('POST', '/devices', { name: 'tmp', host: '127.0.0.1' })).body;
    expect((await call('DELETE', `/devices/${tmp.id}`)).status).toBe(204);
    expect((await call('GET', `/devices/${tmp.id}`)).status).toBe(404);
  });
});

describe('alerts, incidents and notifications through the API', () => {
  let deviceId: string;
  let channelId: string;
  let ruleId: string;

  beforeAll(async () => {
    const cred = (await call('POST', '/credentials', { name: 'inc-cred', type: 'snmp_v2c', secret: { community: COMMUNITY } })).body.id;
    deviceId = (
      await call('POST', '/devices', {
        name: 'inc-dev', host: '127.0.0.1', icmpEnabled: false, snmpEnabled: true, snmpCredentialId: cred, snmpPort: snmpDevice.port,
        polling: { pollIntervalSec: 15, timeoutMs: 800, retryCount: 0 },
      })
    ).body.id;
    channelId = (await call('POST', '/channels', { name: 'hook', type: 'webhook', config: { url: 'https://hooks.example.com/nms' } })).body.id;
  });

  it('manages rules; GET /alerts lists them with active incident counts', async () => {
    const created = await call('POST', '/alerts', {
      name: 'High CPU', deviceId, conditionType: 'metric_threshold', metric: 'cpu_pct', operator: '>', threshold: 25,
      severity: 'critical', triggerAfter: 1, clearAfter: 1, channelIds: [channelId],
    });
    expect(created.status).toBe(201);
    ruleId = created.body.id;
    expect(created.body).toMatchObject({ severity: 'critical', triggerAfter: 1, channelIds: [channelId], enabled: true });

    const list = await call('GET', '/alerts');
    expect(list.body.items.find((r: any) => r.id === ruleId)).toMatchObject({ name: 'High CPU', activeIncidents: 0 });
  });

  it('a breach opens an incident; it can be listed, read, acknowledged; deliveries are recorded honestly', async () => {
    await call('POST', `/devices/${deviceId}/poll`); // cpu = 30 > 25

    const open = await call('GET', '/incidents?status=OPEN');
    const incident = open.body.items.find((i: any) => i.deviceId === deviceId);
    expect(incident).toMatchObject({ severity: 'critical', status: 'OPEN', metric: 'cpu_pct', value: 30, threshold: 25 });
    expect((await call('GET', '/alerts')).body.items.find((r: any) => r.id === ruleId).activeIncidents).toBe(1);

    const detail = await call('GET', `/incidents/${incident.id}`);
    expect(detail.body.incident.id).toBe(incident.id);
    expect(detail.body.notifications).toHaveLength(1);
    expect(detail.body.notifications[0]).toMatchObject({ status: 'PENDING', channelType: 'webhook', event: 'triggered', attempt: 1 });

    // worker delivers through the (recording) provider
    await engine.services.notifications.processDue();
    const after = await call('GET', `/incidents/${incident.id}`);
    expect(after.body.notifications[0]).toMatchObject({ status: 'SENT', responseStatus: 200 });
    expect(webhook.sent).toHaveLength(1);

    const ack = await call('POST', `/incidents/${incident.id}/acknowledge`, { by: 'daffa' });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'daffa' });
    expect((await call('GET', '/incidents?status=ACTIVE')).body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('a polled breach that continues does not create a duplicate incident', async () => {
    await call('POST', `/devices/${deviceId}/poll`);
    await call('POST', `/devices/${deviceId}/poll`);
    const all = await call('GET', `/incidents?deviceId=${deviceId}`);
    expect(all.body.total).toBe(1);
  });

  it('disabling the rule resolves its incident', async () => {
    const r = await call('PATCH', `/alerts/${ruleId}`, { enabled: false });
    expect(r.body.enabled).toBe(false);
    const resolved = await call('GET', `/incidents?deviceId=${deviceId}&status=RESOLVED`);
    expect(resolved.body.items[0]).toMatchObject({ status: 'RESOLVED', resolutionReason: 'rule_disabled' });
    expect((await call('POST', `/incidents/${resolved.body.items[0].id}/acknowledge`, {})).status).toBe(409);
  });

  it('channel test reports the real outcome (email is NOT_IMPLEMENTED)', async () => {
    const email = (await call('POST', '/channels', { name: 'mail', type: 'email', config: { recipients: ['noc@example.com'] } })).body;
    expect(email.implemented).toBe(false);
    webhook.outcome = () => ({ kind: 'failed', code: 'HTTP_500', error: 'boom', retryable: true, responseStatus: 500 });
    const t = await call('POST', `/channels/${channelId}/test`);
    expect(t.body).toMatchObject({ delivered: false, outcome: { kind: 'failed', code: 'HTTP_500' } });
  });

  it('channel configuration is validated', async () => {
    expect((await call('POST', '/channels', { name: 'x', type: 'webhook', config: { url: 'ftp://nope' } })).status).toBe(400);
    expect((await call('POST', '/channels', { name: 'y', type: 'telegram', config: { chatId: '1' } })).status).toBe(400); // needs a bot credential
  });

  it('unknown routes for incidents and rules', async () => {
    expect((await call('POST', '/incidents/00000000-0000-4000-8000-000000000000/acknowledge', {})).status).toBe(404);
    expect((await call('DELETE', '/alerts/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('logs never contain secrets', () => {
  it('after credentials, polls, incidents and failed auth, no log line holds a community string or an API key', async () => {
    // provoke an auth failure with a distinctive (wrong) key so it would show up if it were ever logged
    await call('GET', '/devices', undefined, { authorization: 'Bearer wrong-key-DISTINCTIVE-0123456789' });
    const all = logLines.join('');
    expect(all.length).toBeGreaterThan(500); // the engine really did log
    expect(all).toContain('"event":"poll_completed"');
    expect(all).toContain('"event":"auth_failed"');
    for (const secret of [COMMUNITY, API_KEY, 'wrong-key-DISTINCTIVE', 'very-secret-community']) {
      expect(all, secret).not.toContain(secret);
    }
  });
});
