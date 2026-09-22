import type { CollectStatus } from '../collectors/types.js';

/**
 * One measurement attempt of a device-level metric.
 * value is non-null only when status = 'ok'. Anything else carries the real reason in `error`.
 */
export interface DeviceMetricSample {
  time: Date;
  deviceId: string;
  metric: string;
  /** distinguishes several series of one metric, e.g. the TCP port number */
  dimension: string | null;
  value: number | null;
  status: CollectStatus;
  error: string | null;
}

/** One reading of an interface: raw cumulative counters AND the rates derived from consecutive samples. */
export interface InterfaceSample {
  time: Date;
  deviceId: string;
  interfaceId: string;
  inOctets: bigint | null;
  outOctets: bigint | null;
  inErrors: bigint | null;
  outErrors: bigint | null;
  inDiscards: bigint | null;
  outDiscards: bigint | null;
  /** null unless computed from two real counter samples */
  inBps: number | null;
  outBps: number | null;
  /** why a rate is null (first_sample, counter_reset, device_reboot, ...) */
  rateNote: string | null;
  counterBits: 32 | 64 | null;
  adminStatus: string | null;
  operStatus: string | null;
  status: CollectStatus;
  error: string | null;
}

export interface DeviceMetricQuery {
  deviceId: string;
  metric?: string;
  dimension?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface InterfaceSampleQuery {
  deviceId: string;
  interfaceId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  order?: 'asc' | 'desc';
}

/** Aggregate of the successful samples of one (metric, dimension) inside one time bucket (for charts). */
export interface DeviceMetricBucket {
  time: Date;
  metric: string;
  dimension: string | null;
  avg: number | null;
  max: number | null;
  samples: number;
}

/** Aggregate of the derived rates of one interface inside one time bucket. Rates that were unavailable are not counted. */
export interface InterfaceBucket {
  time: Date;
  interfaceId: string;
  inBpsAvg: number | null;
  inBpsMax: number | null;
  outBpsAvg: number | null;
  outBpsMax: number | null;
  samples: number;
}

/**
 * Storage port for time-series style data. The polling / alerting code depends on THIS interface only.
 * Implementations: PostgresMetricRepository (default). A TimescaleDB / InfluxDB / ClickHouse implementation can be
 * dropped in without touching collectors, the scheduler, the state machine or alerting.
 *
 * Contract: append-only. Samples are never overwritten.
 */
export interface MetricRepository {
  writeDeviceMetrics(samples: DeviceMetricSample[]): Promise<void>;
  writeInterfaceSamples(samples: InterfaceSample[]): Promise<void>;

  queryDeviceMetrics(q: DeviceMetricQuery): Promise<DeviceMetricSample[]>;
  queryInterfaceSamples(q: InterfaceSampleQuery): Promise<InterfaceSample[]>;

  /** downsampled history: one row per (bucket, metric, dimension); only status = 'ok' samples are aggregated */
  queryDeviceMetricBuckets(q: DeviceMetricQuery & { bucketSec: number }): Promise<DeviceMetricBucket[]>;
  queryInterfaceBuckets(q: InterfaceSampleQuery & { bucketSec: number }): Promise<InterfaceBucket[]>;

  /** most recent sample of every (metric, dimension) of a device */
  latestDeviceMetrics(deviceId: string): Promise<DeviceMetricSample[]>;
  /** most recent sample of every interface of a device */
  latestInterfaceSamples(deviceId: string): Promise<InterfaceSample[]>;

  /** retention */
  purgeOlderThan(cutoff: Date): Promise<{ deviceMetrics: number; interfaceSamples: number }>;
}
