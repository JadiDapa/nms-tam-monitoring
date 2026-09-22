import type { Reading } from '../../types.js';
import type { SnmpClient } from '../client.js';
import type { SnmpSystemInfo } from '../types.js';

export interface SnmpContext {
  client: SnmpClient;
  system: SnmpSystemInfo;
}

/**
 * A vendor profile customises HOW device-level metrics are read (CPU/memory OIDs differ per vendor) without
 * touching the generic polling logic. Anything a profile does not implement falls back to the standard MIBs.
 *
 * To add a vendor: create `profiles/<vendor>.ts` exporting an SnmpProfile whose `matches()` looks at sysObjectID /
 * sysDescr, then register it in `profiles/registry.ts`.
 */
export interface SnmpProfile {
  id: string;
  matches(system: SnmpSystemInfo): boolean;
  collectCpu?(ctx: SnmpContext): Promise<Reading>;
  collectMemory?(ctx: SnmpContext): Promise<Reading>;
}

export interface StandardCollectors {
  collectCpu(ctx: SnmpContext): Promise<Reading>;
  collectMemory(ctx: SnmpContext): Promise<Reading>;
}
