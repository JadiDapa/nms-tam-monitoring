import type { IncidentManager } from '../alerts/incident-manager.js';
import type { RuleService } from '../alerts/rules.js';
import type { Config } from '../config/env.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { Database } from '../database/db.js';
import type { DeviceService } from '../devices/device-service.js';
import type { DeviceTester } from '../devices/device-tester.js';
import type { InterfaceRepository } from '../devices/interface-repository.js';
import type { PollService } from '../devices/poll-service.js';
import type { MetricRepository } from '../metrics/repository.js';
import type { ChannelService } from '../notifications/channel-service.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Logger } from '../util/logger.js';

/** Everything the HTTP layer needs. Routes contain no business logic: they validate, delegate and serialise. */
export interface ApiDeps {
  config: Pick<Config, 'apiKeys' | 'NODE_ENV'>;
  logger: Logger;
  db: Database;
  devices: DeviceService;
  deviceTester: DeviceTester;
  polls: PollService;
  /** null when the scheduler is disabled (API-only mode) */
  scheduler: Scheduler | null;
  /** used for on-demand polls even when the background scheduler is disabled */
  runPollNow: (deviceId: string) => Promise<{ ok: boolean; error?: string }>;
  interfaces: InterfaceRepository;
  metrics: MetricRepository;
  credentials: CredentialService;
  channels: ChannelService;
  notifications: NotificationService;
  rules: RuleService;
  incidents: IncidentManager;
  version: string;
  startedAt: number;
}
