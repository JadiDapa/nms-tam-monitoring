import type { SnmpSystemInfo } from '../types.js';
import { standardCpu, standardMemory, standardProfile } from './standard.js';
import type { SnmpContext, SnmpProfile, StandardCollectors } from './profile.js';
import type { Reading } from '../../types.js';

export interface ResolvedProfile extends StandardCollectors {
  id: string;
}

/**
 * Picks the most specific profile for a device. Vendor profiles are registered ahead of the standard fallback.
 * Only standard-MIB monitoring ships today (see docs/ARCHITECTURE.md for how to add MikroTik/Cisco/... profiles).
 */
export class ProfileRegistry {
  private readonly vendor: SnmpProfile[] = [];

  register(profile: SnmpProfile): this {
    this.vendor.push(profile);
    return this;
  }

  resolve(system: SnmpSystemInfo): ResolvedProfile {
    const profile = this.vendor.find((p) => p.matches(system)) ?? standardProfile;
    return {
      id: profile.id,
      collectCpu: (ctx: SnmpContext): Promise<Reading> => (profile.collectCpu ?? standardCpu)(ctx),
      collectMemory: (ctx: SnmpContext): Promise<Reading> => (profile.collectMemory ?? standardMemory)(ctx),
    };
  }
}

export const defaultProfileRegistry = new ProfileRegistry();
