/**
 * Test-only entrypoint: the REAL engine (createEngine + the production shutdown wiring from src/lifecycle.ts) in its
 * own OS process, backed by an embedded PostgreSQL so no external database is needed. The shutdown tests start this as
 * a child process and deliver real OS signals to it.
 *
 * env: PORT (required), LOG_LEVEL, SHUTDOWN_TIMEOUT_MS, SCHEDULER_TICK_MS
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config/env.js';
import { createEngine } from '../../src/engine.js';
import { installShutdownHandlers } from '../../src/lifecycle.js';
import { createLogger } from '../../src/util/logger.js';
import { createTestDb } from './test-db.js';

const config = loadConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: process.env.PORT ?? '18088',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  DATABASE_URL: 'embedded',
  ENGINE_API_KEYS: process.env.ENGINE_API_KEYS ?? 'shutdown-test-api-key-0123456789abcdef',
  ENGINE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SHUTDOWN_TIMEOUT_MS: process.env.SHUTDOWN_TIMEOUT_MS ?? '10000',
  SCHEDULER_TICK_MS: process.env.SCHEDULER_TICK_MS ?? '200',
  SCHEDULER_SYNC_INTERVAL_SEC: '5',
  NOTIFICATION_WORKER_INTERVAL_MS: '500',
  RETENTION_INTERVAL_MIN: '60',
});

const logger = createLogger(config.LOG_LEVEL);
const db = await createTestDb();
const engine = await createEngine({ config, db, logger });

installShutdownHandlers({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  stop: () => engine.stop(),
  closeDb: () => db.close(),
});

await engine.start();
