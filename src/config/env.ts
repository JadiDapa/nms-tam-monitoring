import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8088),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'DATABASE_SCHEMA must be a simple lowercase identifier')
    .default('nms_monitoring'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  // Comma separated list. Several keys allow rotating without downtime.
  ENGINE_API_KEYS: z.string().min(1, 'ENGINE_API_KEYS is required'),

  // Active encryption key (base64, 32 bytes) + its id. Old keys stay decryptable via ENGINE_ENCRYPTION_OLD_KEYS
  // ("id:base64,id:base64").
  ENGINE_ENCRYPTION_KEY: z.string().min(1, 'ENGINE_ENCRYPTION_KEY is required'),
  ENGINE_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('k1'),
  ENGINE_ENCRYPTION_OLD_KEYS: z.string().default(''),

  AUTO_MIGRATE: bool.default(true),

  SCHEDULER_ENABLED: bool.default(true),
  SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(20),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).max(10_000).default(1000),
  SCHEDULER_SYNC_INTERVAL_SEC: z.coerce.number().int().min(5).max(3600).default(30),
  POLL_HARD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),

  NOTIFICATION_WORKER_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2000),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  NOTIFICATION_BACKOFF_BASE_SEC: z.coerce.number().int().min(1).max(3600).default(30),
  NOTIFICATION_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),
  WEBHOOK_ALLOW_PRIVATE_TARGETS: bool.default(false),

  METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(60),

  TEST_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
});

export type Config = Omit<
  z.infer<typeof schema>,
  'ENGINE_API_KEYS' | 'ENGINE_ENCRYPTION_OLD_KEYS'
> & {
  apiKeys: string[];
  oldEncryptionKeys: Record<string, string>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const { ENGINE_API_KEYS, ENGINE_ENCRYPTION_OLD_KEYS, ...rest } = parsed.data;

  const apiKeys = ENGINE_API_KEYS.split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) throw new Error('Invalid configuration: ENGINE_API_KEYS has no keys');
  const weak = apiKeys.filter((k) => k.length < 24);
  if (weak.length > 0) {
    throw new Error('Invalid configuration: every ENGINE_API_KEYS entry must be at least 24 characters');
  }

  const oldEncryptionKeys: Record<string, string> = {};
  for (const part of ENGINE_ENCRYPTION_OLD_KEYS.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx <= 0) throw new Error('Invalid configuration: ENGINE_ENCRYPTION_OLD_KEYS must look like "id:base64,id:base64"');
    oldEncryptionKeys[part.slice(0, idx)] = part.slice(idx + 1);
  }

  return { ...rest, apiKeys, oldEncryptionKeys };
}
