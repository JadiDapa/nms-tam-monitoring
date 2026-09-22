import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/** true for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (v4 + v6) */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }
  return true; // not an IP at all: refuse
}

export class BlockedTargetError extends Error {
  readonly code = 'TARGET_NOT_ALLOWED';
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * DNS lookup used by the actual TCP connection. Validating here (instead of resolving once beforehand)
 * closes the DNS-rebinding window: the address that is validated is the address that is connected to.
 */
function safeLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [];
      const allowed = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (allowed.length === 0) {
        return callback(new BlockedTargetError(`Target ${hostname} resolves to a non-public address`) as NodeJS.ErrnoException);
      }
      if (options.all) return callback(null, allowed);
      return callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
}

export interface SafePostOptions {
  headers?: Record<string, string>;
  body: string;
  timeoutMs: number;
  allowPrivate: boolean;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  /** first 2 KB of the body, for diagnostics only */
  snippet: string;
}

export async function safePost(rawUrl: string, o: SafePostOptions): Promise<SafeResponse> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedTargetError('Only http and https targets are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals never go through DNS lookup, so check them explicitly.
  if (!o.allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
    throw new BlockedTargetError('Target is a non-public IP address');
  }

  const dispatcher = new Agent({
    connect: { lookup: safeLookup(o.allowPrivate) as never },
    headersTimeout: o.timeoutMs,
    bodyTimeout: o.timeoutMs,
  });
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: o.headers,
      body: o.body,
      dispatcher,
      redirect: 'manual', // a redirect could bounce us to an internal address
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 2048);
    } catch {
      // body is only diagnostic
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, snippet };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

/** fetch() wraps connection-level errors in `cause`; find our block error wherever it is nested. */
export function findBlockedError(err: unknown): BlockedTargetError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (cur instanceof BlockedTargetError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}
