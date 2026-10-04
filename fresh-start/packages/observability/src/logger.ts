import pino from 'pino';
import { getCorrelationId } from './context';

export type Logger = pino.Logger;

export interface LoggerOptions {
  service: string;
  level?: string;
  environment?: string;
}

/**
 * Structured fields that must never reach logs (doc 11 §14). Redaction is defense in depth;
 * callers still must not pass sensitive values as log fields.
 */
const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'setCookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'signedUrl',
  '*.signedUrl',
  'bankAccount',
  '*.bankAccount',
  'otp',
  '*.otp',
  'recoveryCode',
  '*.recoveryCode',
];

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    level: opts.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: {
      service: opts.service,
      environment: opts.environment ?? process.env['NODE_ENV'] ?? 'development',
    },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    mixin() {
      const correlationId = getCorrelationId();
      return correlationId ? { correlationId } : {};
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
