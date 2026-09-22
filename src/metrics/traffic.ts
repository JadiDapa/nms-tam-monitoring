/**
 * Interface traffic rate from two consecutive cumulative octet counters.
 *
 * Rule: a rate is either computed from real counter deltas or it is null with a reason. It is never estimated.
 */
export type RateNote =
  | 'first_sample' //          no previous sample to diff against
  | 'device_reboot' //         sysUpTime went backwards: counters restarted
  | 'counter_reset' //         counter decreased and it cannot be explained by a wrap
  | 'counter_wrap' //          32-bit counter wrapped once; the rate IS valid (informational)
  | 'counter_source_changed' // switched between 32-bit and 64-bit counters between samples
  | 'ambiguous_32bit' //       interval too long for a 32-bit counter at this line rate: wrap count unknowable
  | 'clock_anomaly'; //        non-positive elapsed time

export interface CounterSample {
  inOctets: bigint;
  outOctets: bigint;
  /** epoch milliseconds when the counters were read */
  at: number;
  bits: 32 | 64;
}

export interface RateContext {
  /** true when sysUpTime decreased since the previous poll */
  deviceRebooted: boolean;
  /** interface speed in bits/s when known; used only to sanity check 32-bit wraps */
  speedBps: number | null;
}

export interface RateResult {
  inBps: number | null;
  outBps: number | null;
  note: RateNote | null;
}

const WRAP_32 = 1n << 32n;
/** Assumed upper bound when the interface speed is unknown (32-bit counters are not used above this in practice). */
const DEFAULT_MAX_BPS = 10_000_000_000;
/** Allow measurement noise / burst accounting above nominal speed. */
const SPEED_HEADROOM = 1.25;

const NONE: RateResult = { inBps: null, outBps: null, note: null };

function directionalRate(
  prev: bigint,
  curr: bigint,
  elapsedSec: number,
  bits: 32 | 64,
  maxBps: number,
): { bps: number | null; note: RateNote | null } {
  if (curr >= prev) return { bps: (Number(curr - prev) * 8) / elapsedSec, note: null };

  // The counter went down.
  if (bits === 64) return { bps: null, note: 'counter_reset' }; // 64-bit counters do not wrap in practice

  // 32-bit: assume exactly one wrap, then verify the implied rate is physically possible.
  const delta = WRAP_32 - prev + curr;
  const bps = (Number(delta) * 8) / elapsedSec;
  if (bps > maxBps * SPEED_HEADROOM) return { bps: null, note: 'counter_reset' };
  return { bps, note: 'counter_wrap' };
}

export function computeRate(prev: CounterSample | null, curr: CounterSample, ctx: RateContext): RateResult {
  if (!prev) return { ...NONE, note: 'first_sample' };
  if (ctx.deviceRebooted) return { ...NONE, note: 'device_reboot' };

  const elapsedSec = (curr.at - prev.at) / 1000;
  if (!(elapsedSec > 0)) return { ...NONE, note: 'clock_anomaly' };
  if (prev.bits !== curr.bits) return { ...NONE, note: 'counter_source_changed' };

  const maxBps = ctx.speedBps ?? DEFAULT_MAX_BPS;

  // A 32-bit counter running at line rate can wrap more than once between two polls; then the diff is meaningless.
  if (curr.bits === 32 && ctx.speedBps !== null && (elapsedSec * ctx.speedBps) / 8 >= Number(WRAP_32)) {
    return { ...NONE, note: 'ambiguous_32bit' };
  }

  const rx = directionalRate(prev.inOctets, curr.inOctets, elapsedSec, curr.bits, maxBps);
  const tx = directionalRate(prev.outOctets, curr.outOctets, elapsedSec, curr.bits, maxBps);

  const note = rx.note === 'counter_reset' || tx.note === 'counter_reset' ? 'counter_reset' : (rx.note ?? tx.note);
  return { inBps: rx.bps, outBps: tx.bps, note };
}

/** sysUpTime is TimeTicks (uint32, wraps after ~497 days). A drop means a reboot unless the previous value was near the wrap point. */
export function deviceRebooted(prevTicks: number | null, currTicks: number | null): boolean {
  if (prevTicks === null || currTicks === null) return false;
  if (currTicks >= prevTicks) return false;
  const nearWrap = prevTicks > 0xffff_0000;
  return !nearWrap;
}
