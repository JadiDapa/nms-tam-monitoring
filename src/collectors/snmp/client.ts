import net from 'node:net';
import * as snmp from 'net-snmp';
import type { SnmpAuth } from '../../devices/snmp-auth.js';
import type { CollectStatus } from '../types.js';
import { isNoValue } from './codec.js';
import type { SnmpOptions, SnmpTarget } from './types.js';

/**
 * kind -> how it surfaces to callers:
 *   timeout      agent did not answer (down, filtered, or wrong v1/v2c community)   -> unavailable
 *   auth         SNMPv3 authentication / decryption failed                          -> error
 *   unsupported  agent answered but does not implement the requested object         -> not_supported
 *   protocol     malformed / unexpected response                                    -> error
 */
export type SnmpErrorKind = 'timeout' | 'auth' | 'unsupported' | 'protocol' | 'aborted';

export class SnmpError extends Error {
  constructor(
    public readonly kind: SnmpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SnmpError';
  }
  get status(): CollectStatus {
    switch (this.kind) {
      case 'timeout':
      case 'aborted':
        return 'unavailable';
      case 'unsupported':
        return 'not_supported';
      default:
        return 'error';
    }
  }
}

const AUTH_HINTS = /(authentication|unknown user|wrong digest|decrypt|unsupported security level|not in time window|usmStats)/i;

export function mapSnmpError(err: unknown): SnmpError {
  if (err instanceof SnmpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // net-snmp's typings do not export RequestTimedOutError, so match by name / message.
  if ((err instanceof Error && err.name === 'RequestTimedOutError') || /timed out/i.test(message)) {
    return new SnmpError('timeout', 'SNMP request timed out');
  }
  if (AUTH_HINTS.test(message)) return new SnmpError('auth', `SNMP authentication failed: ${message}`);
  if (/^(NoSuchObject|NoSuchInstance|EndOfMibView)\b/i.test(message) || /nosuchname|no such (name|object)/i.test(message)) {
    return new SnmpError('unsupported', message);
  }
  return new SnmpError('protocol', message);
}

const AUTH_PROTO = {
  MD5: snmp.AuthProtocols.md5,
  SHA: snmp.AuthProtocols.sha,
  SHA224: snmp.AuthProtocols.sha224,
  SHA256: snmp.AuthProtocols.sha256,
  SHA384: snmp.AuthProtocols.sha384,
  SHA512: snmp.AuthProtocols.sha512,
} as const;

const PRIV_PROTO = {
  DES: snmp.PrivProtocols.des,
  AES: snmp.PrivProtocols.aes,
  AES256B: snmp.PrivProtocols.aes256b,
  AES256R: snmp.PrivProtocols.aes256r,
} as const;

export function createSession(target: SnmpTarget, opts: SnmpOptions): snmp.Session {
  const common = {
    port: target.port,
    retries: opts.retries,
    timeout: opts.timeoutMs,
    transport: net.isIPv6(target.host) ? ('udp6' as const) : ('udp4' as const),
  };
  const auth: SnmpAuth = target.auth;

  if (auth.version === 'v3') {
    const user: snmp.User = { name: auth.username, level: snmp.SecurityLevel.noAuthNoPriv };
    if (auth.authProtocol && auth.authKey) {
      user.level = auth.privProtocol && auth.privKey ? snmp.SecurityLevel.authPriv : snmp.SecurityLevel.authNoPriv;
      user.authProtocol = AUTH_PROTO[auth.authProtocol];
      user.authKey = auth.authKey;
      if (auth.privProtocol && auth.privKey) {
        user.privProtocol = PRIV_PROTO[auth.privProtocol];
        user.privKey = auth.privKey;
      }
    }
    return snmp.createV3Session(target.host, user, { ...common, version: snmp.Version3 });
  }

  return snmp.createSession(target.host, auth.community, {
    ...common,
    version: auth.version === 'v1' ? snmp.Version1 : snmp.Version2c,
  });
}

export interface GetResult {
  oid: string;
  value: unknown | null;
  /** agent answered with noSuchObject / noSuchInstance / endOfMibView */
  noValue: boolean;
}

/** Promise wrapper around one net-snmp session. One client per poll; always close() it. */
export class SnmpClient {
  private closed = false;

  /** observable facts about this session, for diagnosing slow polls */
  readonly stats = { retransmits: 0, timeouts: 0 };

  constructor(
    private readonly session: snmp.Session,
    private readonly maxRepetitions: number,
    /** hard upper bound for multi-request operations (walk / table) so nothing can ever hang a poll */
    private readonly opDeadlineMs: number = 20_000,
    private readonly signal?: AbortSignal,
  ) {
    // Socket-level errors are reported through requests; an unhandled 'error' event must never crash the engine.
    this.session.on('error', () => undefined);

    // net-snmp re-sends a request through the same send() after its per-request timeout. A request that is already
    // registered is therefore a retransmission: count them (real observations, not estimates).
    const raw = this.session as unknown as {
      send: (req: { getId(): number }, noWait?: boolean) => unknown;
      reqs?: Record<number, unknown>;
    };
    const originalSend = raw.send;
    raw.send = (req, noWait) => {
      if (raw.reqs?.[req.getId()]) this.stats.retransmits += 1;
      return originalSend.call(this.session, req, noWait);
    };
    signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  static open(target: SnmpTarget, opts: SnmpOptions): SnmpClient {
    const deadline = Math.max(5_000, opts.timeoutMs * (opts.retries + 1) * 4);
    return new SnmpClient(createSession(target, opts), opts.maxRepetitions ?? 20, deadline, opts.signal);
  }

  /** Fail immediately when the poll is aborted, and count operations that ended in a timeout. */
  private track<T>(op: Promise<T>): Promise<T> {
    const signal = this.signal;
    const wrapped = new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new SnmpError('aborted', 'SNMP poll aborted'));
      const onAbort = () => reject(new SnmpError('aborted', 'SNMP poll aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      op.then(
        (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
    return wrapped.catch((e) => {
      if (e instanceof SnmpError && e.kind === 'timeout') this.stats.timeouts += 1;
      throw e;
    });
  }

  get(oids: string[]): Promise<GetResult[]> {
    return this.track(this.rawGet(oids));
  }

  private rawGet(oids: string[]): Promise<GetResult[]> {
    return new Promise((resolve, reject) => {
      this.session.get(oids, (error, varbinds) => {
        if (error) return reject(mapSnmpError(error));
        const out: GetResult[] = [];
        for (const vb of varbinds ?? []) {
          if (snmp.isVarbindError(vb) && !isNoValue(vb)) {
            return reject(mapSnmpError(new Error(snmp.varbindError(vb))));
          }
          out.push({ oid: vb.oid, value: isNoValue(vb) ? null : vb.value, noValue: isNoValue(vb) });
        }
        resolve(out);
      });
    });
  }

  /** Walk a subtree with GETBULK/GETNEXT. Errors are propagated (partial data is never presented as complete). */
  walk(oid: string): Promise<Array<{ oid: string; value: unknown }>> {
    return this.track(this.rawWalk(oid));
  }

  private rawWalk(oid: string): Promise<Array<{ oid: string; value: unknown }>> {
    return this.withDeadline(
      new Promise((resolve, reject) => {
        const rows: Array<{ oid: string; value: unknown }> = [];
        this.session.subtree(
          oid,
          this.maxRepetitions,
          (varbinds) => {
            for (const vb of varbinds) {
              // noSuchObject / endOfMibView: the subtree is exhausted (or absent). Returning true stops the walk;
              // continuing would loop forever against agents that keep answering "no such object".
              if (snmp.isVarbindError(vb)) return true;
              rows.push({ oid: vb.oid, value: vb.value });
            }
            return undefined as unknown as true;
          },
          (error) => (error ? reject(mapSnmpError(error)) : resolve(rows)),
        );
      }),
      `walk ${oid}`,
    );
  }

  /** Read selected columns of a table. Result: rowIndex -> columnNumber -> raw value. Empty object = no rows. */
  tableColumns(tableOid: string, columns: number[]): Promise<Record<string, Record<string, unknown>>> {
    return this.track(this.rawTable(tableOid, columns));
  }

  private rawTable(tableOid: string, columns: number[]): Promise<Record<string, Record<string, unknown>>> {
    return this.withDeadline(
      new Promise((resolve, reject) => {
        this.session.tableColumns(tableOid, columns as unknown as string[], this.maxRepetitions, (error, table) => {
          if (error) return reject(mapSnmpError(error));
          resolve((table ?? {}) as unknown as Record<string, Record<string, unknown>>);
        });
      }),
      `table ${tableOid}`,
    );
  }

  private withDeadline<T>(op: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SnmpError('timeout', `SNMP ${what} exceeded ${this.opDeadlineMs} ms`)),
        this.opDeadlineMs,
      );
    });
    return Promise.race([op, deadline]).finally(() => clearTimeout(timer));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.close();
    } catch {
      // already closed
    }
  }
}
