import type { FastifyInstance } from 'fastify';
import { SimulationService } from './admin/simulate.js';
import { AlertEvaluator } from './alerts/evaluator.js';
import { IncidentManager } from './alerts/incident-manager.js';
import { RuleService } from './alerts/rules.js';
import { buildApp } from './api/app.js';
import { SystemPingProbe } from './collectors/icmp/system-ping.js';
import type { IcmpProbe } from './collectors/icmp/types.js';
import { SnmpCollector } from './collectors/snmp/collector.js';
import type { SnmpProbe } from './collectors/snmp/types.js';
import { NetTcpProbe, type TcpProbe } from './collectors/tcp/tcp-probe.js';
import type { Config } from './config/env.js';
import { CredentialService } from './credentials/credential-service.js';
import { SecretBox } from './credentials/secret-box.js';
import type { Database } from './database/db.js';
import { DeviceService } from './devices/device-service.js';
import { DeviceTester } from './devices/device-tester.js';
import { InterfaceRepository } from './devices/interface-repository.js';
import { PollService } from './devices/poll-service.js';
import { PostgresMetricRepository } from './metrics/postgres-repository.js';
import type { MetricRepository } from './metrics/repository.js';
import { ChannelService } from './notifications/channel-service.js';
import { EmailProvider } from './notifications/email.js';
import { NotificationService } from './notifications/notification-service.js';
import type { NotificationProvider } from './notifications/provider.js';
import { TelegramProvider } from './notifications/telegram.js';
import { WebhookProvider } from './notifications/webhook.js';
import { Scheduler } from './scheduler/scheduler.js';
import { WorkerPool } from './scheduler/worker-pool.js';
import { systemClock, type Clock } from './util/clock.js';
import { errorMessage, type Logger } from './util/logger.js';
import { VERSION } from './version.js';

export interface EngineOptions {
  config: Config;
  db: Database;
  logger: Logger;
  // Injection points (production defaults are the real implementations)
  icmp?: IcmpProbe;
  tcp?: TcpProbe;
  snmp?: SnmpProbe;
  metrics?: MetricRepository;
  providers?: NotificationProvider[];
  clock?: Clock;
}

export interface Engine {
  app: FastifyInstance;
  scheduler: Scheduler;
  services: {
    devices: DeviceService;
    polls: PollService;
    credentials: CredentialService;
    channels: ChannelService;
    notifications: NotificationService;
    rules: RuleService;
    incidents: IncidentManager;
    metrics: MetricRepository;
    simulation: SimulationService;
  };
  /** Start background work (scheduler, notification worker, retention) and listen for HTTP. */
  start(): Promise<void>;
  /** Graceful shutdown. Does not close the database (the caller owns it). */
  stop(): Promise<void>;
}

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const { config, db, logger } = o;
  const clock = o.clock ?? systemClock;

  const box = new SecretBox({
    activeKeyId: config.ENGINE_ENCRYPTION_KEY_ID,
    activeKey: config.ENGINE_ENCRYPTION_KEY,
    oldKeys: config.oldEncryptionKeys,
  });
  const credentials = new CredentialService(db, box);
  const metrics = o.metrics ?? new PostgresMetricRepository(db);
  const devices = new DeviceService(db, metrics);
  const interfaces = new InterfaceRepository();

  const icmp = o.icmp ?? new SystemPingProbe();
  const tcp = o.tcp ?? new NetTcpProbe();
  const snmp = o.snmp ?? new SnmpCollector();

  const providers = o.providers ?? [
    new TelegramProvider({ timeoutMs: config.NOTIFICATION_REQUEST_TIMEOUT_MS }),
    new WebhookProvider({ timeoutMs: config.NOTIFICATION_REQUEST_TIMEOUT_MS, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE_TARGETS }),
    new EmailProvider(),
  ];
  const notifications = new NotificationService(
    db,
    credentials,
    providers,
    {
      maxAttempts: config.NOTIFICATION_MAX_ATTEMPTS,
      backoffBaseSec: config.NOTIFICATION_BACKOFF_BASE_SEC,
      workerIntervalMs: config.NOTIFICATION_WORKER_INTERVAL_MS,
    },
    logger,
    clock,
  );
  const incidents = new IncidentManager(db, notifications, logger, clock);
  const rules = new RuleService(db);
  rules.setRetireHandler(async (ruleId, reason) => void (await incidents.resolveForRule(ruleId, reason)));
  const evaluator = new AlertEvaluator(db, rules, incidents, logger);
  const channels = new ChannelService(db, credentials);

  const simulation = new SimulationService({ db, logger, devices, interfaces, metrics });

  const polls = new PollService({ db, metrics, devices, icmp, tcp, snmp, logger, clock, listeners: [evaluator] });
  const deviceTester = new DeviceTester(icmp, tcp, snmp, config.TEST_MAX_CONCURRENCY);

  const pool = new WorkerPool(config.SCHEDULER_CONCURRENCY);
  const scheduler = new Scheduler({
    pool,
    clock,
    logger,
    loadSchedule: () => devices.schedule(),
    runPoll: (deviceId, signal) => polls.runForScheduler(deviceId, signal),
    tickMs: config.SCHEDULER_TICK_MS,
    syncIntervalSec: config.SCHEDULER_SYNC_INTERVAL_SEC,
    hardTimeoutMs: config.POLL_HARD_TIMEOUT_MS,
  });
  // Config changes reach the scheduler immediately instead of waiting for the next periodic sync.
  devices.setChangeListener(() => void scheduler.sync());

  const startedAt = Date.now();
  const app = await buildApp({
    config,
    logger,
    db,
    devices,
    deviceTester,
    polls,
    scheduler: config.SCHEDULER_ENABLED ? scheduler : null,
    runPollNow: async (id) => {
      const s = await scheduler.runNow(id);
      return { ok: s.ok, error: s.error };
    },
    interfaces,
    metrics,
    credentials,
    channels,
    notifications,
    rules,
    incidents,
    simulation,
    version: VERSION,
    startedAt,
  });

  let retentionTimer: NodeJS.Timeout | null = null;
  const runRetention = async () => {
    try {
      const cutoff = new Date(clock.now() - config.METRICS_RETENTION_DAYS * 86_400_000);
      const purged = await metrics.purgeOlderThan(cutoff);
      if (purged.deviceMetrics + purged.interfaceSamples > 0) logger.info({ event: 'retention_purged', cutoff: cutoff.toISOString(), ...purged });
    } catch (err) {
      logger.error({ event: 'scheduler_error', phase: 'retention', error: errorMessage(err) });
    }
  };

  return {
    app,
    scheduler,
    services: { devices, polls, credentials, channels, notifications, rules, incidents, metrics, simulation },

    async start() {
      if (config.SCHEDULER_ENABLED) await scheduler.start();
      else logger.warn({ event: 'scheduler_disabled', hint: 'SCHEDULER_ENABLED=false: only on-demand polls will run' });
      notifications.start();
      retentionTimer = setInterval(() => void runRetention(), config.RETENTION_INTERVAL_MIN * 60_000);
      await app.listen({ host: config.HOST, port: config.PORT });
      logger.info({ event: 'engine_started', version: VERSION, host: config.HOST, port: config.PORT });
    },

    async stop() {
      logger.info({ event: 'engine_stopping' });
      if (retentionTimer) clearInterval(retentionTimer);
      // 1. Stop accepting new connections/requests immediately, but do NOT wait for in-flight requests yet: a manual
      //    POST /devices/:id/poll is waiting for a poll, and that poll may only end through the scheduler stop below
      //    (finish within the budget, or be aborted). Waiting first would deadlock until the force-exit safety net.
      const httpClosed = app.close();
      httpClosed.catch(() => undefined); // surfaced below; avoids an unhandled rejection if the scheduler stop throws first
      // 2. Running polls finish or, after SHUTDOWN_TIMEOUT_MS, are aborted (pings killed, SNMP/TCP closed).
      await scheduler.stop(config.SHUTDOWN_TIMEOUT_MS);
      // 3. Requests that were waiting for those polls now have their answers; wait for the HTTP server to drain.
      //    A keep-alive connection that was busy when close() began stays open (Fastify's default keep-alive is 72 s)
      //    once its response is sent, and would hold the server open. Keep closing connections that have gone idle,
      //    and force-close whatever is still open after a short grace period.
      const idleSweep = setInterval(() => app.server.closeIdleConnections(), 50);
      const hardClose = setTimeout(() => app.server.closeAllConnections(), 3000);
      try {
        await httpClosed;
      } finally {
        clearInterval(idleSweep);
        clearTimeout(hardClose);
      }
      await notifications.stop();
      logger.info({ event: 'engine_stopped' });
    },
  };
}
