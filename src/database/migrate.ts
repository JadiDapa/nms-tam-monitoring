import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './db.js';
import type { Logger } from '../util/logger.js';

// src/database or dist/database -> project root is two levels up in both layouts.
const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const LOCK_KEY = 727_274_001;

export interface MigrateOptions {
  /** Create this schema first (PostgreSQL). Leave undefined for embedded test databases. */
  schema?: string;
  dir?: string;
  logger?: Logger;
}

export async function runMigrations(db: Database, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? DEFAULT_DIR;
  if (opts.schema) await db.exec(`create schema if not exists "${opts.schema}"`);
  await db.exec(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const done = await db.query('select 1 from schema_migrations where name = $1', [file]);
    if (done.rowCount > 0) continue;

    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
      // Re-check under the lock: another instance may have applied it while we waited.
      const again = await tx.query('select 1 from schema_migrations where name = $1', [file]);
      if (again.rowCount > 0) return;
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
      applied.push(file);
    });
    opts.logger?.info({ event: 'migration_applied', file });
  }
  return applied;
}
