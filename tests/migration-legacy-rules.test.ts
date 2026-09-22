import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { createBareDb } from './helpers/test-db.js';

/**
 * Migration 003: legacy interface_down rules (created before 002, still on the OLD default debounce 1/1) move to the
 * new default 2/2. Explicitly customised rules must NOT be touched.
 *
 * The test stages a database exactly as it would exist before 003: migrations 001 + 002 applied, rules created with the
 * old defaults, then 003 is applied on top.
 */

const MIGRATIONS = path.resolve(import.meta.dirname, '../migrations');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nms-mig-'));
const before = path.join(tmp, 'before'); // 001 + 002 only
mkdirSync(before);
for (const f of ['001_init.sql', '002_hardening.sql']) copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));

let db: Awaited<ReturnType<typeof createBareDb>>;
const ids: Record<string, string> = {};

async function rule(key: string, type: string, trigger: number, clear: number, createdAt: string, extra = { metric: null as string | null, operator: null as string | null, threshold: null as number | null }) {
  const r = await db.query<{ id: string }>(
    `insert into alert_rules (name, condition_type, metric, operator, threshold, severity, trigger_after, clear_after, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'critical', $6, $7, $8::timestamptz, $8::timestamptz) returning id`,
    [key, type, extra.metric, extra.operator, extra.threshold, trigger, clear, createdAt],
  );
  ids[key] = r.rows[0]!.id;
}
const get = async (key: string) => (await db.query<{ trigger_after: number; clear_after: number; updated_at: Date }>('select trigger_after, clear_after, updated_at from alert_rules where id = $1', [ids[key]!])).rows[0]!;

beforeAll(async () => {
  db = await createBareDb();
  await runMigrations(db, { dir: before }); // the state the user's database is in today
  const applied002 = (await db.query<{ applied_at: Date }>(`select applied_at from schema_migrations where name = '002_hardening.sql'`)).rows[0]!.applied_at;
  const past = new Date(applied002.getTime() - 3_600_000).toISOString(); // created BEFORE 002
  const future = new Date(applied002.getTime() + 3_600_000).toISOString(); // created AFTER 002

  // legacy rules created before 002
  await rule('legacy-if-default', 'interface_down', 1, 1, past); //          old default          -> converted
  await rule('legacy-if-custom-3-4', 'interface_down', 3, 4, past); //      deliberately custom  -> untouched
  await rule('legacy-if-custom-1-3', 'interface_down', 1, 3, past); //      partially custom     -> untouched
  await rule('legacy-if-custom-2-1', 'interface_down', 2, 1, past); //      custom               -> untouched
  await rule('legacy-device-down', 'device_down', 1, 1, past); //           1/1 is intended here (state machine)
  await rule('legacy-snmp-unavail', 'snmp_unavailable', 1, 1, past); //     same
  await rule('legacy-metric-default', 'metric_threshold', 3, 2, past, { metric: 'cpu_pct', operator: '>', threshold: 80 });
  await rule('legacy-metric-explicit-1-1', 'metric_threshold', 1, 1, past, { metric: 'cpu_pct', operator: '>', threshold: 90 });
  // created after 002: the API default is already 2/2, so a 1/1 here was chosen on purpose
  await rule('new-if-explicit-1-1', 'interface_down', 1, 1, future);

  // debounce counters that accumulated under the old thresholds
  const dev = (await db.query<{ id: string }>(`insert into devices (name, host) values ('d', '10.0.0.1') returning id`)).rows[0]!.id;
  for (const key of ['legacy-if-default', 'legacy-if-custom-3-4']) {
    await db.query(`insert into alert_condition_state (rule_id, device_id, subject_key, consecutive_breaches, consecutive_ok) values ($1, $2, 'if-1', 1, 0)`, [ids[key]!, dev]);
  }
  // an OPEN incident on the legacy rule must survive the migration untouched
  await db.query(`insert into incidents (rule_id, rule_name, device_id, subject_key, severity, title) values ($1, 'legacy-if-default', $2, 'if-1', 'critical', 't')`, [ids['legacy-if-default']!, dev]);
});
afterAll(async () => {
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('migration 003: legacy interface_down debounce', () => {
  it('starting point: every legacy rule has the values it was created with', async () => {
    expect(await get('legacy-if-default')).toMatchObject({ trigger_after: 1, clear_after: 1 });
    expect((await db.query(`select 1 from schema_migrations where name = '003_legacy_interface_down_debounce.sql'`)).rowCount).toBe(0);
  });

  it('applies exactly the 003 migration on top', async () => {
    const applied = await runMigrations(db); // default dir: 001 + 002 already applied, so only 003 runs
    expect(applied).toEqual(['003_legacy_interface_down_debounce.sql']);
  });

  it('converts ONLY the legacy interface_down rule that still had the old 1/1 default', async () => {
    expect(await get('legacy-if-default')).toMatchObject({ trigger_after: 2, clear_after: 2 });
  });

  it('does NOT overwrite explicitly customised interface_down rules', async () => {
    expect(await get('legacy-if-custom-3-4')).toMatchObject({ trigger_after: 3, clear_after: 4 });
    expect(await get('legacy-if-custom-1-3')).toMatchObject({ trigger_after: 1, clear_after: 3 });
    expect(await get('legacy-if-custom-2-1')).toMatchObject({ trigger_after: 2, clear_after: 1 });
  });

  it('does NOT touch a 1/1 chosen after 002 (that was an explicit choice, the default is already 2/2)', async () => {
    expect(await get('new-if-explicit-1-1')).toMatchObject({ trigger_after: 1, clear_after: 1 });
  });

  it('does NOT touch other rule types (device_down / snmp_unavailable 1/1 is intentional; metric rules keep their values)', async () => {
    expect(await get('legacy-device-down')).toMatchObject({ trigger_after: 1, clear_after: 1 });
    expect(await get('legacy-snmp-unavail')).toMatchObject({ trigger_after: 1, clear_after: 1 });
    expect(await get('legacy-metric-default')).toMatchObject({ trigger_after: 3, clear_after: 2 });
    expect(await get('legacy-metric-explicit-1-1')).toMatchObject({ trigger_after: 1, clear_after: 1 });
  });

  it('resets the stale debounce counters of the CONVERTED rule only, and leaves open incidents alone', async () => {
    const counters = await db.query<{ rule_id: string }>('select rule_id from alert_condition_state');
    expect(counters.rows.map((r) => r.rule_id)).toEqual([ids['legacy-if-custom-3-4']]); // the converted rule's counters are gone
    const inc = await db.query<{ status: string }>('select status from incidents where rule_id = $1', [ids['legacy-if-default']!]);
    expect(inc.rows).toEqual([{ status: 'OPEN' }]);
  });

  it('is applied once: running the migrations again changes nothing, and a later 1/1 chosen via PATCH stays 1/1', async () => {
    expect(await runMigrations(db)).toEqual([]);
    await db.query(`update alert_rules set trigger_after = 1, clear_after = 1 where id = $1`, [ids['legacy-if-default']!]); // an operator re-applies 1/1
    expect(await runMigrations(db)).toEqual([]);
    expect(await get('legacy-if-default')).toMatchObject({ trigger_after: 1, clear_after: 1 });
  });

  it('a fresh installation (no rules yet) migrates cleanly and new interface_down rules default to 2/2', async () => {
    const fresh = await createBareDb();
    try {
      expect((await runMigrations(fresh)).length).toBe(3);
      const r = await fresh.query(`select count(*)::int as n from alert_rules`);
      expect((r.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
