import { loadDotEnv } from '../config/load-env.js';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { createPgDatabase } from './db.js';
import { runMigrations } from './migrate.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, { pretty: config.NODE_ENV !== 'production' });
const db = createPgDatabase({
  connectionString: config.DATABASE_URL,
  schema: config.DATABASE_SCHEMA,
  poolMax: 2,
});

try {
  const applied = await runMigrations(db, { schema: config.DATABASE_SCHEMA, logger });
  logger.info({ event: 'migrations_complete', applied });
} finally {
  await db.close();
}
