import type { SnmpAuth } from '../../credentials/schemas.js';
import type { CollectStatus, Reading } from '../types.js';

export interface SnmpTarget {
  host: string;
  port: number;
  auth: SnmpAuth;
}

export interface SnmpOptions {
  /** per-attempt timeout */
  timeoutMs: number;
  /** extra attempts per request after a timeout */
  retries: number;
  /** GETBULK max-repetitions (SNMP v2c/v3) */
  maxRepetitions?: number;
  /** aborting fails every pending request immediately and closes the socket */
  signal?: AbortSignal;
}

/** Wall-clock time of each SNMP step of one poll (null = step was not run). Used to find slow operations. */
export interface SnmpTimings {
  systemMs: number | null;
  cpuMs: number | null;
  memoryMs: number | null;
  interfacesMs: number | null;
}

export interface SnmpSystemInfo {
  sysName: string | null;
  sysDescr: string | null;
  sysObjectId: string | null;
  /** TimeTicks: hundredths of a second since the agent (re)started */
  uptimeTicks: number | null;
}

export type IfStatus = 'up' | 'down' | 'testing' | 'unknown' | 'dormant' | 'notPresent' | 'lowerLayerDown';

export interface SnmpInterfaceRow {
  ifIndex: number;
  name: string;
  alias: string | null;
  typeNum: number | null;
  typeName: string | null;
  speedBps: number | null;
  adminStatus: IfStatus | null;
  operStatus: IfStatus | null;
  /** raw cumulative counters, kept as BigInt so 64-bit values never lose precision */
  inOctets: bigint | null;
  outOctets: bigint | null;
  /** 64 when ifHCInOctets/ifHCOutOctets were used, 32 for the legacy counters */
  counterBits: 32 | 64 | null;
  inErrors: bigint | null;
  outErrors: bigint | null;
  inDiscards: bigint | null;
  outDiscards: bigint | null;
}

export interface SnmpInterfacesResult {
  status: CollectStatus;
  error: string | null;
  rows: SnmpInterfaceRow[];
}

export interface SnmpPollResult {
  /** Did the SNMP agent answer at all? unavailable = timeout, error = auth/protocol failure. */
  status: 'ok' | 'unavailable' | 'error';
  error: string | null;
  /** round trip of the first (system) request */
  responseMs: number | null;
  durationMs: number;
  system: SnmpSystemInfo | null;
  profileId: string | null;
  cpu: Reading;
  memory: Reading;
  interfaces: SnmpInterfacesResult;
  timings: SnmpTimings;
  /**
   * Packets re-sent because a request got no answer within the per-request timeout. Every retransmit costs one full
   * timeout period, so retransmits x timeoutMs is the time lost to (probably) dropped UDP packets.
   */
  retransmits: number;
  /** operations that ended in a timeout after all retries were used */
  timeouts: number;
}

export interface SnmpProbe {
  poll(target: SnmpTarget, opts: SnmpOptions): Promise<SnmpPollResult>;
}
