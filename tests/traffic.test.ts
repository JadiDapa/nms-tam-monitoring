import { describe, expect, it } from 'vitest';
import { computeRate, deviceRebooted, type CounterSample } from '../src/metrics/traffic.js';

const t0 = 1_700_000_000_000;
const sample = (inO: bigint, outO: bigint, secAfter: number, bits: 32 | 64 = 64): CounterSample => ({
  inOctets: inO,
  outOctets: outO,
  at: t0 + secAfter * 1000,
  bits,
});
const ctx = { deviceRebooted: false, speedBps: 1_000_000_000 as number | null };

describe('interface rate calculation', () => {
  it('first sample: rate is null, NOT a made up number', () => {
    expect(computeRate(null, sample(1000n, 2000n, 0), ctx)).toEqual({ inBps: null, outBps: null, note: 'first_sample' });
  });

  it('normal counter increase (64-bit)', () => {
    // +1,250,000 octets in 10 s = 1 Mbit/s ; +2,500,000 octets = 2 Mbit/s
    const r = computeRate(sample(0n, 0n, 0), sample(1_250_000n, 2_500_000n, 10), ctx);
    expect(r.inBps).toBeCloseTo(1_000_000);
    expect(r.outBps).toBeCloseTo(2_000_000);
    expect(r.note).toBeNull();
  });

  it('64-bit counters far above 2^53 still give exact deltas', () => {
    const base = 18_000_000_000_000_000_000n;
    const r = computeRate(sample(base, base, 0), sample(base + 125_000_000n, base + 250_000_000n, 1), ctx);
    expect(r.inBps).toBeCloseTo(1_000_000_000);
    expect(r.outBps).toBeCloseTo(2_000_000_000);
  });

  it('64-bit counter decrease is a reset, never a wrap', () => {
    const r = computeRate(sample(5_000_000n, 5_000_000n, 0), sample(100n, 100n, 10), ctx);
    expect(r).toEqual({ inBps: null, outBps: null, note: 'counter_reset' });
  });

  it('32-bit counter wrap is handled when the implied rate is plausible', () => {
    // prev is 1,000,000 below the 32-bit limit, curr is 1,000,000 after the wrap => 2,000,000 octets in 30 s
    const prev = sample(4_293_967_296n, 4_293_967_296n, 0, 32);
    const curr = sample(1_000_000n, 1_000_000n, 30, 32);
    const r = computeRate(prev, curr, ctx);
    expect(r.inBps).toBeCloseTo((2_000_000 * 8) / 30);
    expect(r.note).toBe('counter_wrap');
  });

  it('32-bit decrease with an impossible implied rate is treated as a counter reset', () => {
    // prev near the top, curr small, but a "wrap" would mean ~4 GB in 1 s on a 100 Mbit/s link
    const r = computeRate(sample(4_000_000_000n, 4_000_000_000n, 0, 32), sample(10n, 10n, 1, 32), {
      deviceRebooted: false,
      speedBps: 100_000_000,
    });
    expect(r).toEqual({ inBps: null, outBps: null, note: 'counter_reset' });
  });

  it('32-bit counters at line rate for too long are ambiguous (multiple wraps possible) -> null', () => {
    // 1 Gbit/s wraps a 32-bit counter every ~34 s; a 60 s gap cannot be diffed honestly
    const r = computeRate(sample(100n, 100n, 0, 32), sample(500n, 500n, 60, 32), ctx);
    expect(r).toEqual({ inBps: null, outBps: null, note: 'ambiguous_32bit' });
  });

  it('device reboot: no rate for that interval', () => {
    const r = computeRate(sample(9_000_000n, 9_000_000n, 0), sample(500n, 500n, 10), { ...ctx, deviceRebooted: true });
    expect(r).toEqual({ inBps: null, outBps: null, note: 'device_reboot' });
  });

  it('switching between 32-bit and 64-bit counters is not comparable', () => {
    const r = computeRate(sample(100n, 100n, 0, 32), sample(200n, 200n, 5, 64), ctx);
    expect(r.note).toBe('counter_source_changed');
    expect(r.inBps).toBeNull();
  });

  it('non-positive elapsed time is rejected', () => {
    expect(computeRate(sample(1n, 1n, 10), sample(2n, 2n, 10), ctx).note).toBe('clock_anomaly');
    expect(computeRate(sample(1n, 1n, 10), sample(2n, 2n, 5), ctx).note).toBe('clock_anomaly');
  });

  it('directions are independent: one counter can reset while the other is fine', () => {
    const r = computeRate(sample(1000n, 9_000_000n, 0), sample(2000n, 100n, 10), ctx);
    expect(r.inBps).toBeCloseTo((1000 * 8) / 10);
    expect(r.outBps).toBeNull();
    expect(r.note).toBe('counter_reset');
  });

  it('zero traffic is a real measurement of 0, not null', () => {
    const r = computeRate(sample(500n, 500n, 0), sample(500n, 500n, 10), ctx);
    expect(r).toEqual({ inBps: 0, outBps: 0, note: null });
  });
});

describe('device reboot detection from sysUpTime', () => {
  it('detects a decrease', () => expect(deviceRebooted(500_000, 1_000)).toBe(true));
  it('no reboot when uptime grows', () => expect(deviceRebooted(1_000, 2_000)).toBe(false));
  it('unknown uptime is never treated as a reboot', () => {
    expect(deviceRebooted(null, 5)).toBe(false);
    expect(deviceRebooted(5, null)).toBe(false);
  });
  it('the 497-day TimeTicks wrap is not a reboot', () => expect(deviceRebooted(0xffff_fff0, 20)).toBe(false));
});
