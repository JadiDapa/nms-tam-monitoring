import type { CollectStatus } from '../collectors/types.js';
import type { HealthSnapshot, HealthState, Transition } from './health-state.js';

export const DEVICE_TYPES = ['router', 'switch', 'firewall', 'server', 'access_point', 'gateway', 'unknown'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export interface PollingConfig {
  pollIntervalSec: number;
  timeoutMs: number;
  retryCount: number;
  /** reachability state machine */
  failureThreshold: number;
  recoveryThreshold: number;
  /** SNMP-availability state machine (independent of reachability) */
  snmpFailureThreshold: number;
  snmpRecoveryThreshold: number;
  icmpCount: number;
}

export const DEFAULT_POLLING: PollingConfig = {
  pollIntervalSec: 30,
  timeoutMs: 3000,
  retryCount: 1,
  failureThreshold: 3,
  recoveryThreshold: 2,
  snmpFailureThreshold: 3,
  snmpRecoveryThreshold: 2,
  icmpCount: 3,
};

export interface DeviceConfig {
  id: string;
  name: string;
  host: string;
  deviceType: DeviceType;
  vendor: string | null;
  model: string | null;
  location: string | null;
  enabled: boolean;
  icmpEnabled: boolean;
  tcpPorts: number[];
  snmpEnabled: boolean;
  snmpCredentialId: string | null;
  snmpPort: number;
  /** discovered from the device itself (null until the first successful SNMP poll) */
  sysName: string | null;
  sysDescr: string | null;
  sysObjectId: string | null;
  snmpProfile: string | null;
  infoUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  polling: PollingConfig;
}

export interface DeviceStateRecord {
  deviceId: string;
  reachability: HealthSnapshot;
  snmp: HealthSnapshot;
  lastPollAt: Date | null;
  lastPollDurationMs: number | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastUptimeTicks: number | null;
}

/** What the alert evaluator receives after every poll. Contains only real observations. */
export interface PollSnapshot {
  deviceId: string;
  deviceName: string;
  at: Date;
  reachability: { state: HealthState; transition: Transition | null };
  /** null when SNMP monitoring is not configured for the device */
  snmp: { state: HealthState; transition: Transition | null } | null;
  /** device metrics by name; value is null unless status = 'ok' */
  metrics: Record<string, { value: number | null; status: CollectStatus; error: string | null }>;
  interfaces: Array<{
    interfaceId: string;
    ifIndex: number;
    name: string;
    monitored: boolean;
    /** true if the interface was ever observed operationally UP (before or during this poll) */
    everUp: boolean;
    adminStatus: string | null;
    operStatus: string | null;
    inBps: number | null;
    outBps: number | null;
  }>;
  /** false when the interface table could not be read: interface rules must not be evaluated */
  interfacesCollected: boolean;
}

export interface PollListener {
  onPollCompleted(snapshot: PollSnapshot): Promise<void>;
}
