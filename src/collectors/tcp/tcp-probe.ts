import net from 'node:net';

export interface TcpPortResult {
  port: number;
  /**
   * open     TCP handshake completed
   * closed   the host actively refused (RST): the host IS alive, the port is just not listening
   * timeout  no answer (filtered / host down)
   * error    anything else (network unreachable, DNS failure, ...)
   */
  status: 'open' | 'closed' | 'timeout' | 'error';
  latencyMs: number | null;
  error: string | null;
}

export interface TcpOptions {
  timeoutMs: number;
  /** extra attempts after a timeout/error (a definitive open/closed answer is never retried) */
  retries: number;
  signal?: AbortSignal;
}

export interface TcpProbe {
  check(host: string, ports: number[], opts: TcpOptions): Promise<TcpPortResult[]>;
}

function connectOnce(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<TcpPortResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ port, status: 'error', latencyMs: null, error: 'Aborted' });
    const started = performance.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (r: TcpPortResult) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(r);
    };
    const onAbort = () => finish({ port, status: 'error', latencyMs: null, error: 'Aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ port, status: 'open', latencyMs: elapsed(), error: null }));
    socket.once('timeout', () => finish({ port, status: 'timeout', latencyMs: null, error: 'Connection timed out' }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        finish({ port, status: 'closed', latencyMs: elapsed(), error: 'Connection refused' });
      } else {
        finish({ port, status: 'error', latencyMs: null, error: err.code ?? err.message });
      }
    });
    try {
      socket.connect(port, host);
    } catch (err) {
      finish({ port, status: 'error', latencyMs: null, error: (err as Error).message });
    }
  });
}

export class NetTcpProbe implements TcpProbe {
  async check(host: string, ports: number[], opts: TcpOptions): Promise<TcpPortResult[]> {
    return Promise.all(
      ports.map(async (port) => {
        let result = await connectOnce(host, port, opts.timeoutMs, opts.signal);
        for (let i = 0; i < opts.retries && !opts.signal?.aborted && (result.status === 'timeout' || result.status === 'error'); i++) {
          result = await connectOnce(host, port, opts.timeoutMs, opts.signal);
        }
        return result;
      }),
    );
  }
}

/** Positive proof that the host answered on the network layer (a refused connection counts: something replied). */
export const tcpShowsHostAlive = (r: TcpPortResult): boolean => r.status === 'open' || r.status === 'closed';
