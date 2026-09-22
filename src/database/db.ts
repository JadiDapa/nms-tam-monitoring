import pg from 'pg';

/**
 * Minimal database abstraction. The engine talks to PostgreSQL through this interface only,
 * which keeps repositories testable (embedded Postgres in tests) and swappable.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a multi-statement script (no parameters). Used by migrations. */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgOptions {
  connectionString: string;
  schema: string;
  poolMax?: number;
}

export function createPgDatabase(opts: PgOptions): Database {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.poolMax ?? 10,
    // Every engine table lives in its own schema so it can share a database with other applications.
    options: `-c search_path=${opts.schema},public`,
    application_name: 'nms-monitoring',
  });
  // An idle client erroring (e.g. server restart) must not crash the process.
  pool.on('error', () => undefined);

  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  });

  const base = wrap(pool);
  return {
    ...base,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Helpers for reading values PostgreSQL returns as strings (int8 / numeric) */
export const toBigInt = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
export const toNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
