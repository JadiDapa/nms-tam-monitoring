import { PGlite } from '@electric-sql/pglite';
import type { Database, Queryable, QueryResult } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';

type Runner = Pick<PGlite, 'query' | 'exec'>;

function wrap(r: Runner): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await r.query<T>(sql, params as unknown[] | undefined);
      return { rows: res.rows, rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0) };
    },
    async exec(sql: string) {
      await r.exec(sql);
    },
  };
}

/** Isolated in-memory PostgreSQL (PGlite) with NO migrations applied. Tests only. */
export async function createBareDb(): Promise<Database & { raw: PGlite }> {
  const raw = new PGlite();
  await raw.waitReady;
  return {
    raw,
    ...wrap(raw),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return raw.transaction(async (tx) => fn(wrap(tx as unknown as Runner)));
    },
    async close() {
      await raw.close();
    },
  };
}

/** Isolated in-memory PostgreSQL (PGlite) with the real migrations applied. Tests only. */
export async function createTestDb(): Promise<Database & { raw: PGlite }> {
  const db = await createBareDb();
  await runMigrations(db);
  return db;
}
