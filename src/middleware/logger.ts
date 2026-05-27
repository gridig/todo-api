import pino from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV !== 'production';
const isTest = env.NODE_ENV === 'test';

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
    paths: [
      'password',
      'token',
      'authorization',
      'email',
      '*.password',
      '*.token',
      '*.email',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
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
