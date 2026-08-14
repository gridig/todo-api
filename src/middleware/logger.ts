import pino from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV !== 'production';
const isTest = env.NODE_ENV === 'test';

// Pino wildcards match exactly one path segment and leaf names must match
// exactly — `*.password` does NOT cover `body.currentPassword`. Every
// sensitive FIELD NAME accepted by a request schema (middleware/validation.ts)
// must be listed here explicitly, at top level and one level deep, because
// errorHandler logs `body: req.body` on every thrown error. Exported so
// __tests__/unit/middleware/loggerRedaction.test.ts can assert coverage.
export const REDACT_PATHS = [
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'refreshToken',
  'authorization',
  'email',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.refreshToken',
  '*.email',
  'req.headers.authorization',
  'req.headers.cookie',
];

const logger = pino({
  // Silent logs during tests to avoid noise
  level: isTest ? 'silent' : env.LOG_LEVEL || (isDev ? 'debug' : 'info'),

  // Pretty print in development, raw JSON to stdout in production/test
  ...(isDev && !isTest
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
            errorLikeObjectKeys: ['err', 'error'],
            errorProps: 'message,type,code',
          },
        },
      }
    : {}),

  // String levels for readability
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
  },

  // ISO timestamps
  timestamp: pino.stdTimeFunctions.isoTime,

  // Redact sensitive information. `email` is treated as PII (per ROADMAP
  // cross-cutting concerns) so it does not surface in errorHandler's body log.
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },

  // Base context
  base: {
    env: env.NODE_ENV,
    service: 'todo-api',
  },

  // Serialize errors
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export default logger;
