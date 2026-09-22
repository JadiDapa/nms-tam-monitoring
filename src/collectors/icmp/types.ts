export interface IcmpOptions {
  /** number of echo requests per probe */
  count: number;
  /** per-echo timeout */
  timeoutMs: number;
  /** aborting kills the ping process immediately */
  signal?: AbortSignal;
}

export interface IcmpResult {
  /** ok: at least one reply. unavailable: probe ran, nothing answered. error: probe could not run. */
  status: 'ok' | 'unavailable' | 'error';
  reachable: boolean;
  sent: number;
  received: number;
  /** 0-100. A real measurement even when everything was lost (100). null only when the probe could not run. */
  packetLossPct: number | null;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  error: string | null;
  durationMs: number;
  /** how many ping bursts were run (1 = no retry needed) */
  attempts?: number;
}

/** Abstraction so the engine can swap the ICMP implementation (raw sockets, fping, ...) without touching callers. */
export interface IcmpProbe {
  ping(host: string, opts: IcmpOptions): Promise<IcmpResult>;
}
