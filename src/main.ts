import { loadConfig, type Config } from './config/env.js';
import { loadDotEnv } from './config/load-env.js';
import { createPgDatabase } from './database/db.js';
import { runMigrations } from './database/migrate.js';
import { createEngine, type Engine } from './engine.js';
import { installShutdownHandlers } from './lifecycle.js';
import { createLogger, errorMessage } from './util/logger.js';

loadDotEnv();

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // Logger needs config for its level; print the (secret-free) validation message and stop.
  console.error(errorMessage(err));
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL, { pretty: config.NODE_ENV !== 'production' });
const db = createPgDatabase({ connectionString: config.DATABASE_URL, schema: config.DATABASE_SCHEMA, poolMax: config.DB_POOL_MAX });

let engine: Engine | null = null;
const { shutdown } = installShutdownHandlers({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  stop: async () => void (await engine?.stop()),
  closeDb: () => db.close(),
});

try {
  if (config.AUTO_MIGRATE) await runMigrations(db, { schema: config.DATABASE_SCHEMA, logger });
  engine = await createEngine({ config, db, logger });
  await engine.start();
} catch (err) {
  logger.fatal({ event: 'startup_failed', error: errorMessage(err) });
  await shutdown('startup_failed', 1);
}
