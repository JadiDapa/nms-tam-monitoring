import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { CredentialService } from '../src/credentials/credential-service.js';
import { SecretBox } from '../src/credentials/secret-box.js';
import { PostgresMetricRepository } from '../src/metrics/postgres-repository.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/test-db.js';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox (AES-256-GCM)', () => {
  it('round-trips and never stores plaintext', () => {
    const box = new SecretBox({ activeKeyId: 'k1', activeKey: key() });
    const { encrypted, keyId } = box.encrypt('super-secret-community', 'row-1');
    expect(keyId).toBe('k1');
    expect(encrypted).not.toContain('super-secret-community');
    expect(encrypted.startsWith('v1.k1.')).toBe(true);
    expect(box.decrypt(encrypted, 'row-1')).toBe('super-secret-community');
  });

  it('uses a fresh IV every time', () => {
    const box = new SecretBox({ activeKeyId: 'k1', activeKey: key() });
    expect(box.encrypt('same', 'a').encrypted).not.toBe(box.encrypt('same', 'a').encrypted);
  });

  it('a ciphertext copied to another row does not decrypt (bound to its row via AAD)', () => {
    const box = new SecretBox({ activeKeyId: 'k1', activeKey: key() });
    const { encrypted } = box.encrypt('secret', 'row-1');
    expect(() => box.decrypt(encrypted, 'row-2')).toThrow(/could not be decrypted/);
  });

  it('tampering is detected', () => {
    const box = new SecretBox({ activeKeyId: 'k1', activeKey: key() });
    const parts = box.encrypt('secret', 'r').encrypted.split('.');
    parts[4] = Buffer.from('tampered-bytes').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'r')).toThrow(/could not be decrypted/);
  });

  it('a wrong key cannot decrypt, and the error leaks nothing', () => {
    const a = new SecretBox({ activeKeyId: 'k1', activeKey: key() });
    const b = new SecretBox({ activeKeyId: 'k1', activeKey: key() });
    const { encrypted } = a.encrypt('secret', 'r');
    expect(() => b.decrypt(encrypted, 'r')).toThrow('Secret could not be decrypted (wrong key or corrupted data)');
  });

  it('key rotation: old keys still decrypt, new writes use the active key', () => {
    const oldKey = key();
    const before = new SecretBox({ activeKeyId: 'k1', activeKey: oldKey }).encrypt('secret', 'r').encrypted;
    const after = new SecretBox({ activeKeyId: 'k2', activeKey: key(), oldKeys: { k1: oldKey } });
    expect(after.decrypt(before, 'r')).toBe('secret');
    expect(after.encrypt('x', 'r').keyId).toBe('k2');
    expect(() => new SecretBox({ activeKeyId: 'k2', activeKey: key() }).decrypt(before, 'r')).toThrow(/not available/);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new SecretBox({ activeKeyId: 'k1', activeKey: Buffer.from('short').toString('base64') })).toThrow(/32 bytes/);
  });
});

describe('credential service', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let svc: CredentialService;
  const oldKey = key();
  beforeAll(async () => {
    db = await createTestDb();
    svc = new CredentialService(db, new SecretBox({ activeKeyId: 'k1', activeKey: oldKey }));
  });
  afterAll(async () => db.close());

  it('resolves SNMP v1/v2c/v3 credentials into collector auth', async () => {
    const v2 = await svc.create({ name: 'v2', type: 'snmp_v2c', secret: { community: 'c2' } });
    const v1 = await svc.create({ name: 'v1', type: 'snmp_v1', secret: { community: 'c1' } });
    const v3 = await svc.create({
      name: 'v3', type: 'snmp_v3', secret: { username: 'mon', authProtocol: 'SHA256', authKey: 'auth-key-123', privProtocol: 'AES', privKey: 'priv-key-123' },
    });
    expect(await svc.resolveSnmpAuth(v2.id)).toEqual({ version: 'v2c', community: 'c2' });
    expect(await svc.resolveSnmpAuth(v1.id)).toEqual({ version: 'v1', community: 'c1' });
    expect(await svc.resolveSnmpAuth(v3.id)).toEqual({
      version: 'v3', username: 'mon', authProtocol: 'SHA256', authKey: 'auth-key-123', privProtocol: 'AES', privKey: 'priv-key-123',
    });
  });

  it('validates SNMPv3 rules (key pairing, minimum length, priv needs auth)', async () => {
    const bad = (secret: object) => svc.create({ name: `bad-${randomUUID()}`, type: 'snmp_v3', secret });
    await expect(bad({ username: 'u', authProtocol: 'SHA' })).rejects.toThrow(/does not match/);
    await expect(bad({ username: 'u', authProtocol: 'SHA', authKey: 'short' })).rejects.toThrow(/does not match/);
    await expect(bad({ username: 'u', privProtocol: 'AES', privKey: 'priv-key-123' })).rejects.toThrow(/does not match/);
    await expect(svc.create({ name: 'noauth', type: 'snmp_v3', secret: { username: 'u' } })).resolves.toBeDefined(); // noAuthNoPriv is legal
  });

  it('metadata never contains the secret; duplicate names conflict', async () => {
    const m = await svc.create({ name: 'meta', type: 'telegram_bot', secret: { botToken: '123456:ABCDEFtoken' } });
    expect(JSON.stringify(m)).not.toContain('ABCDEF');
    await expect(svc.create({ name: 'meta', type: 'telegram_bot', secret: { botToken: '123456:ABCDEFtoken' } })).rejects.toThrow(/already exists/);
  });

  it('rotation replaces the secret; re-encryption moves rows to the active key', async () => {
    const c = await svc.create({ name: 'rot', type: 'snmp_v2c', secret: { community: 'first' } });
    await svc.rotateSecret(c.id, { community: 'second' });
    expect(await svc.resolveSnmpAuth(c.id)).toEqual({ version: 'v2c', community: 'second' });

    const rotated = new CredentialService(db, new SecretBox({ activeKeyId: 'k2', activeKey: key(), oldKeys: { k1: oldKey } }));
    expect(await rotated.resolveSnmpAuth(c.id)).toEqual({ version: 'v2c', community: 'second' }); // still readable
    const moved = await rotated.reencryptAll();
    expect(moved).toBeGreaterThan(0);
    expect((await rotated.get(c.id)).keyId).toBe('k2');
    expect(await rotated.resolveSnmpAuth(c.id)).toEqual({ version: 'v2c', community: 'second' });
  });

  it('a type mismatch is rejected', async () => {
    const tg = await svc.create({ name: 'tg2', type: 'telegram_bot', secret: { botToken: '123456:ABCDEFtoken' } });
    await expect(svc.resolveSnmpAuth(tg.id)).rejects.toThrow(/not an SNMP credential/);
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgresql://x', ENGINE_API_KEYS: 'a'.repeat(32), ENGINE_ENCRYPTION_KEY: key() };

  it('applies safe defaults (loopback bind, bounded concurrency, private webhook targets blocked)', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ HOST: '127.0.0.1', PORT: 8088, SCHEDULER_CONCURRENCY: 20, WEBHOOK_ALLOW_PRIVATE_TARGETS: false, DATABASE_SCHEMA: 'nms_monitoring' });
  });

  it('fails fast with readable messages and no secret values', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, ENGINE_API_KEYS: 'tooshort' })).toThrow(/at least 24 characters/);
    expect(() => loadConfig({ ...base, DATABASE_SCHEMA: 'bad;drop table' })).toThrow(/DATABASE_SCHEMA/);
    try {
      loadConfig({ ...base, ENGINE_API_KEYS: 'tooshort' });
    } catch (e) {
      expect(String(e)).not.toContain('tooshort');
    }
  });

  it('supports several API keys and old encryption keys', () => {
    const c = loadConfig({ ...base, ENGINE_API_KEYS: `${'a'.repeat(30)}, ${'b'.repeat(30)}`, ENGINE_ENCRYPTION_OLD_KEYS: `k0:${key()}` });
    expect(c.apiKeys).toHaveLength(2);
    expect(Object.keys(c.oldEncryptionKeys)).toEqual(['k0']);
  });
});

describe('logger', () => {
  it('redacts secrets wherever they appear', () => {
    const lines: string[] = [];
    const logger = createLogger('info', { destination: { write: (c: string) => lines.push(c) } });
    logger.info({
      event: 'x', community: 'PUBLIC-SECRET', snmp: { authKey: 'AUTH-SECRET', privKey: 'PRIV-SECRET' }, botToken: 'TG-SECRET',
      req: { headers: { authorization: 'Bearer API-SECRET', 'x-api-key': 'KEY-SECRET' } },
    });
    const out = lines.join('');
    for (const s of ['PUBLIC-SECRET', 'AUTH-SECRET', 'PRIV-SECRET', 'TG-SECRET', 'API-SECRET', 'KEY-SECRET']) expect(out).not.toContain(s);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"event":"x"'); // non-secret fields survive
  });
});

describe('metric repository (append-only, replaceable)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repo: PostgresMetricRepository;
  let deviceId: string;
  beforeAll(async () => {
    db = await createTestDb();
    repo = new PostgresMetricRepository(db);
    deviceId = (await db.query<{ id: string }>(`insert into devices (name, host) values ('d', '10.0.0.9') returning id`)).rows[0]!.id;
  });
  afterAll(async () => db.close());

  it('keeps every sample (history is never overwritten) and returns newest first', async () => {
    const t = (min: number) => new Date(Date.parse('2026-03-01T00:00:00Z') + min * 60_000);
    await repo.writeDeviceMetrics([
      { time: t(0), deviceId, metric: 'cpu_pct', dimension: null, value: 10, status: 'ok', error: null },
      { time: t(1), deviceId, metric: 'cpu_pct', dimension: null, value: 20, status: 'ok', error: null },
      { time: t(2), deviceId, metric: 'cpu_pct', dimension: null, value: null, status: 'unavailable', error: 'SNMP timeout' },
      { time: t(2), deviceId, metric: 'tcp_port_open', dimension: '22', value: 1, status: 'ok', error: null },
      { time: t(2), deviceId, metric: 'tcp_port_open', dimension: '443', value: 0, status: 'ok', error: null },
    ]);
    const cpu = await repo.queryDeviceMetrics({ deviceId, metric: 'cpu_pct' });
    expect(cpu.map((s) => s.value)).toEqual([null, 20, 10]);
    expect(cpu[0]).toMatchObject({ status: 'unavailable', error: 'SNMP timeout' });

    const range = await repo.queryDeviceMetrics({ deviceId, metric: 'cpu_pct', from: t(1), to: t(1), order: 'asc' });
    expect(range).toHaveLength(1);
    expect(range[0]!.value).toBe(20);

    const latest = await repo.latestDeviceMetrics(deviceId);
    const by = Object.fromEntries(latest.map((s) => [`${s.metric}:${s.dimension ?? ''}`, s]));
    expect(by['cpu_pct:']).toMatchObject({ value: null, status: 'unavailable' }); // latest attempt, honestly null
    expect(by['tcp_port_open:22']!.value).toBe(1);
    expect(by['tcp_port_open:443']!.value).toBe(0);
  });

  it('stores 64-bit counters without precision loss', async () => {
    const iface = (await db.query<{ id: string }>(`insert into interfaces (device_id, if_index, name) values ($1, 1, 'e1') returning id`, [deviceId])).rows[0]!.id;
    const big = 18_446_744_073_709_551_000n;
    await repo.writeInterfaceSamples([
      { time: new Date(), deviceId, interfaceId: iface, inOctets: big, outOctets: 1n, inErrors: 2n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n, inBps: null, outBps: null, rateNote: 'first_sample', counterBits: 64, adminStatus: 'up', operStatus: 'up', status: 'ok', error: null },
    ]);
    const [s] = await repo.queryInterfaceSamples({ deviceId, interfaceId: iface });
    expect(s!.inOctets).toBe(big);
    expect(s!.rateNote).toBe('first_sample');
    expect(s!.inBps).toBeNull();
  });

  it('writes large batches (chunked)', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      time: new Date(Date.parse('2026-04-01T00:00:00Z') + i * 1000), deviceId, metric: 'bulk', dimension: null, value: i, status: 'ok' as const, error: null,
    }));
    await repo.writeDeviceMetrics(rows);
    expect(await repo.queryDeviceMetrics({ deviceId, metric: 'bulk', limit: 5000 })).toHaveLength(1200);
  });

  it('retention purges only samples older than the cutoff', async () => {
    const purged = await repo.purgeOlderThan(new Date('2026-03-15T00:00:00Z'));
    expect(purged.deviceMetrics).toBe(5); // the five March-01 samples
    expect(await repo.queryDeviceMetrics({ deviceId, metric: 'cpu_pct' })).toHaveLength(0);
    expect(await repo.queryDeviceMetrics({ deviceId, metric: 'bulk', limit: 5000 })).toHaveLength(1200);
  });
});
