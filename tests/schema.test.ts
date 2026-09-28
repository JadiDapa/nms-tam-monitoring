import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/database/db.js';
import { createTestDb } from './helpers/test-db.js';

describe('schema', () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('applies all migrations and records them', async () => {
    const r = await db.query<{ name: string }>('select name from schema_migrations order by name');
    expect(r.rows.map((x) => x.name)).toContain('001_init.sql');
  });

  it('refuses a device that has no way of being checked', async () => {
    await expect(
      db.query(`insert into devices (name, host, icmp_enabled, snmp_enabled) values ('x', '10.0.0.1', false, false)`),
    ).rejects.toThrow();
  });

  it('refuses SNMP monitoring without SNMP auth', async () => {
    await expect(
      db.query(`insert into devices (name, host, snmp_enabled) values ('x', '10.0.0.1', true)`),
    ).rejects.toThrow();
  });

  it('enforces a single active incident per rule/device/subject at database level', async () => {
    const dev = await db.query<{ id: string }>(`insert into devices (name, host) values ('d', '10.0.0.2') returning id`);
    const rule = await db.query<{ id: string }>(
      `insert into alert_rules (name, condition_type, severity) values ('r', 'device_down', 'critical') returning id`,
    );
    const ins = () =>
      db.query(
        `insert into incidents (rule_id, rule_name, device_id, severity, title) values ($1, 'r', $2, 'critical', 't')`,
        [rule.rows[0]!.id, dev.rows[0]!.id],
      );
    await ins();
    await expect(ins()).rejects.toThrow();
    await db.query(`update incidents set status = 'RESOLVED', resolved_at = now()`);
    await expect(ins()).resolves.toBeDefined(); // allowed again once the previous one is resolved
  });
});
