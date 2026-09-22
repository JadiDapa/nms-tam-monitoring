import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

// Anything that could carry a secret is redacted no matter where it appears in a log object.
const REDACT_PATHS = [
  'password',
  'secret',
  'community',
  'authKey',
  'privKey',
  'botToken',
  'token',
  'apiKey',
  '*.password',
  '*.secret',
  '*.community',
  '*.authKey',
  '*.privKey',
  '*.botToken',
  '*.token',
  '*.apiKey',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
];

export function createLogger(level: string = 'info', opts: { pretty?: boolean; destination?: { write(chunk: string): unknown } } = {}): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: 'nms-monitoring' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  if (opts.destination) return pino(options, opts.destination as never);
  if (opts.pretty) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } },
    });
  }
  return pino(options);
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** Turn an unknown thrown value into a loggable/serialisable message without leaking stack noise. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
