import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { createEngine, type Engine } from '../src/engine.js';
import { createLogger } from '../src/util/logger.js';
import { FakeSnmpDevice } from './helpers/fake-snmp-device.js';
import { RecordingProvider } from './helpers/harness.js';
import { createTestDb } from './helpers/test-db.js';

/**
 * The web app owns "which objects belong to which client" and asks the engine for exactly those objects (?ids=...).
 * These tests pin down that contract: a filter never leaks other objects, and an EMPTY filter matches nothing.
 */
const API_KEY = 'test-api-key-0123456789-abcdefghij';
const COMMUNITY = 'scoping-community-1234';
const auth = { authorization: `Bearer ${API_KEY}` };

let engine: Engine;
let snmpDevice: FakeSnmpDevice;
let db: Awaited<ReturnType<typeof createTestDb>>;

const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await engine.app.inject({ method, url, headers: auth, payload: payload as never });
  const body = res.body ? JSON.parse(res.body) : null;
  return { status: res.statusCode, body };
};

let credId: string;
let devA: string;
let devB: string;

beforeAll(async () => {
  snmpDevice = await new FakeSnmpDevice({
    sysName: 'lab',
    sysDescr: 'Lab',
    cpuLoads: [20, 40],
    memory: [{ descr: 'main memory', type: '1.3.6.1.2.1.25.2.1.2', size: 1000, used: 300 }],
    community: COMMUNITY,
    interfaces: [{ index: 1, name: 'ether1', speedMbps: 1000, inHc: 1000n, outHc: 500n }],
  }).start();
  db = await createTestDb();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'unused',
    ENGINE_API_KEYS: API_KEY,
    ENGINE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SCHEDULER_ENABLED: 'false',
  });
  engine = await createEngine({ config, db, logger: createLogger('silent'), providers: [new RecordingProvider('webhook')] });

  credId = (await call('POST', '/credentials', { name: 'scope-cred', type: 'webhook_secret', secret: { secret: COMMUNITY } })).body.id;
  const mk = async (name: string) =>
    (await call('POST', '/devices', { name, host: '127.0.0.1', icmpEnabled: false, snmpEnabled: true, snmpAuth: { version: 'v2c', community: COMMUNITY }, snmpPort: snmpDevice.port, polling: { timeoutMs: 800, retryCount: 0 } })).body.id as string;
  devA = await mk('scope-a');
  devB = await mk('scope-b');
});

afterAll(async () => {
  await engine.stop();
  await snmpDevice.stop();
  await db.close();
});

describe('?ids= filters', () => {
  it('devices: only the requested ids come back; empty matches nothing; absent means all', async () => {
    const one = await call('GET', `/devices?ids=${devA}`);
    expect(one.body.items.map((d: { id: string }) => d.id)).toEqual([devA]);
    expect(one.body.total).toBe(1);

    const both = await call('GET', `/devices?ids=${devA},${devB}`);
    expect(both.body.total).toBe(2);

    const none = await call('GET', '/devices?ids=');
    expect(none.body.items).toEqual([]);
    expect(none.body.total).toBe(0);

    expect((await call('GET', '/devices')).body.total).toBeGreaterThanOrEqual(2);
    expect((await call('GET', '/devices?ids=not-a-uuid')).status).toBe(400);
  });

  it('credentials, channels and alert rules honour ids', async () => {
    const otherCred = (await call('POST', '/credentials', { name: 'scope-other', type: 'webhook_secret', secret: { secret: 'other-secret-99' } })).body.id;
    const creds = await call('GET', `/credentials?ids=${credId}`);
    expect(creds.body.items.map((c: { id: string }) => c.id)).toEqual([credId]);
    expect((await call('GET', '/credentials?ids=')).body.items).toEqual([]);
    expect((await call('GET', `/credentials?ids=${otherCred}`)).body.items).toHaveLength(1);

    const ch = (await call('POST', '/channels', { name: 'scope-hook', type: 'webhook', config: { url: 'https://example.com/hook' } })).body.id;
    await call('POST', '/channels', { name: 'scope-hook-2', type: 'webhook', config: { url: 'https://example.com/hook2' } });
    expect((await call('GET', `/channels?ids=${ch}`)).body.items.map((c: { id: string }) => c.id)).toEqual([ch]);
    expect((await call('GET', '/channels?ids=')).body.items).toEqual([]);

    const rule = (await call('POST', '/alerts', { name: 'scope-rule', deviceId: devA, conditionType: 'device_down', severity: 'critical' })).body.id;
    await call('POST', '/alerts', { name: 'scope-rule-2', deviceId: devB, conditionType: 'device_down', severity: 'critical' });
    expect((await call('GET', `/alerts?ids=${rule}`)).body.items.map((r: { id: string }) => r.id)).toEqual([rule]);
    expect((await call('GET', '/alerts?ids=')).body.items).toEqual([]);
  });

  it('incidents can be limited to a set of devices', async () => {
    const now = new Date().toISOString();
    for (const deviceId of [devA, devB]) {
      await db.query(
        `insert into incidents (device_id, rule_name, subject_key, severity, status, title, triggered_at, last_seen_at)
         values ($1, 'r', $2, 'critical', 'OPEN', 't', $3, $3)`,
        [deviceId, `scope:${deviceId}`, now],
      );
    }
    const a = await call('GET', `/incidents?deviceIds=${devA}`);
    expect(a.body.items).toHaveLength(1);
    expect(a.body.items[0].deviceId).toBe(devA);
    expect((await call('GET', '/incidents?deviceIds=')).body.items).toEqual([]);
    expect((await call('GET', `/incidents?deviceIds=${devA},${devB}`)).body.total).toBe(2);
  });
});

describe('GET /fleet', () => {
  it('summarises health, active incidents and the latest real metrics of exactly the requested devices', async () => {
    await call('POST', `/devices/${devA}/poll`);

    const r = await call('GET', `/fleet?ids=${devA}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const item = r.body.items[0];
    expect(item).toMatchObject({ deviceId: devA, name: 'scope-a', enabled: true, snmp: 'UP', activeIncidents: 1 });
    expect(item.lastPollAt).not.toBeNull();
    expect(typeof item.cpuPct).toBe('number');
    expect(typeof item.memoryPct).toBe('number');

    // a device that was never polled reports nulls, not invented numbers
    const b = (await call('GET', `/fleet?ids=${devB}`)).body.items[0];
    expect(b).toMatchObject({ deviceId: devB, reachability: 'UNKNOWN', cpuPct: null, memoryPct: null, latencyMs: null });

    expect((await call('GET', '/fleet?ids=')).body.items).toEqual([]);
  });
});

describe('bucketSec (downsampling)', () => {
  it('aggregates only successful samples into time buckets', async () => {
    await call('POST', `/devices/${devA}/poll`);
    await call('POST', `/devices/${devA}/poll`);

    const raw = await call('GET', `/devices/${devA}/metrics?metric=cpu_pct`);
    expect(raw.body.items.length).toBeGreaterThanOrEqual(3);

    const bucketed = await call('GET', `/devices/${devA}/metrics?metric=cpu_pct&bucketSec=3600`);
    expect(bucketed.status).toBe(200);
    expect(bucketed.body.bucketSec).toBe(3600);
    const total = bucketed.body.items.reduce((n: number, b: { samples: number }) => n + b.samples, 0);
    expect(total).toBe(raw.body.items.filter((s: { status: string }) => s.status === 'ok').length);
    expect(bucketed.body.items[0]).toMatchObject({ metric: 'cpu_pct' });
    expect(bucketed.body.items[0].avg).toBeGreaterThan(0);
    expect(bucketed.body.items[0].max).toBeGreaterThanOrEqual(bucketed.body.items[0].avg);

    expect((await call('GET', `/devices/${devA}/metrics?bucketSec=1`)).status).toBe(400);
  });

  it('interface rates are bucketed per interface and never count unavailable rates', async () => {
    const ifaces = (await call('GET', `/devices/${devA}/interfaces`)).body.items;
    expect(ifaces.length).toBeGreaterThan(0);
    const r = await call('GET', `/devices/${devA}/interfaces/${ifaces[0].id}/metrics?bucketSec=3600`);
    expect(r.status).toBe(200);
    expect(r.body.bucketSec).toBe(3600);
    for (const b of r.body.items) {
      expect(b.interfaceId).toBe(ifaces[0].id);
      expect(b.samples).toBeGreaterThan(0);
    }
  });
});
