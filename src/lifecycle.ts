import type { Logger } from './util/logger.js';
import { errorMessage } from './util/logger.js';

export interface LifecycleOptions {
  logger: Logger;
  /** stop the engine (HTTP server, scheduler, notification worker) */
  stop: () => Promise<void>;
  /** release external resources (database pool) */
  closeDb: () => Promise<void>;
  /** engine stop budget; the process is force-exited 5 s after it */
  timeoutMs: number;
  /** injectable for tests; defaults to process.exit */
  exit?: (code: number) => never | void;
}

/**
 * Signals that request a graceful shutdown.
 *
 *  SIGINT    Ctrl+C (all platforms)
 *  SIGTERM   process managers / `kill` (POSIX only: Windows cannot deliver it, a Windows "kill" is a hard TerminateProcess)
 *  SIGBREAK  Ctrl+Break and console-window close on Windows
 *  SIGHUP    terminal closed (POSIX; also delivered on Windows when the console window is closed)
 */
export const SHUTDOWN_SIGNALS: NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Count of still-active libuv resources by type, e.g. { TCPServerWrap: 1, Timeout: 2 } (diagnostic for leak detection). */
export function activeResourceSummary(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) out[r] = (out[r] ?? 0) + 1;
  return out;
}

/**
 * Installs signal + fatal-error handlers and returns the shutdown function.
 *
 * Shutdown order: stop taking API calls -> scheduler stops creating polls and gives running polls up to `timeoutMs`
 * (then aborts them: pings killed, SNMP/TCP closed) -> notification worker stops -> database pool closes -> exit.
 * A second signal while shutting down is ignored. Exit code: 0 for a requested shutdown, 1 for fatal errors or a
 * shutdown step that failed.
 */
export function installShutdownHandlers(o: LifecycleOptions): { shutdown: (reason: string, code?: number) => Promise<void> } {
  let shuttingDown = false;
  const exit = o.exit ?? ((code: number) => process.exit(code));

  async function shutdown(reason: string, code = 0): Promise<void> {
    if (shuttingDown) {
      o.logger.info({ event: 'shutdown_already_in_progress', reason });
      return;
    }
    shuttingDown = true;
    const startedAt = Date.now();
    o.logger.info({ event: 'shutdown_requested', reason });

    const force = setTimeout(() => {
      o.logger.error({ event: 'shutdown_forced', hint: 'graceful shutdown timed out' });
      exit(1);
    }, o.timeoutMs + 5000);
    force.unref();

    try {
      await o.stop();
      await o.closeDb();
    } catch (err) {
      o.logger.error({ event: 'shutdown_error', error: errorMessage(err) });
      code = 1;
    }
    clearTimeout(force);
    // Handles that were just closed (HTTP server, sockets) finish closing on the next event-loop turns: wait for them,
    // otherwise the report below would list resources that are already on their way out.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    // Anything listed here (other than stdio) is a resource that shutdown failed to release.
    o.logger.info({ event: 'shutdown_complete', reason, exitCode: code, durationMs: Date.now() - startedAt, activeResources: activeResourceSummary() });
    exit(code);
  }

  for (const sig of SHUTDOWN_SIGNALS) process.on(sig, () => void shutdown(sig));
  process.on('unhandledRejection', (err) => {
    o.logger.fatal({ event: 'unhandled_rejection', error: errorMessage(err) });
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    o.logger.fatal({ event: 'uncaught_exception', error: errorMessage(err) });
    void shutdown('uncaughtException', 1);
  });

  return { shutdown };
}
