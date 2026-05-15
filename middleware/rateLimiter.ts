import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';
import type { Request, Response, NextFunction } from 'express';
import logger from './logger.js';
import { env } from '../config/env.js';
import { rateLimitHitsTotal } from './metrics.js';

// Create module-specific logger
const rateLimitLogger = logger.child({ module: 'rate-limiter' });

// Type for the rate limit handler function
type RateLimitHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  options: Options,
) => void;

const isRateLimitDisabled =
  env.NODE_ENV === 'test' || env.DISABLE_RATE_LIMIT === true;

// Optional Redis client for distributed rate limiting across multiple instances.
// Falls back to in-memory when REDIS_URL is not set (single-instance deployments).
let redisClient: ReturnType<typeof createClient> | null = null;

if (env.REDIS_URL) {
  redisClient = createClient({ url: env.REDIS_URL });
  redisClient.on('error', (err) => {
    rateLimitLogger.error({ err }, 'Redis client error');
  });
  redisClient.connect().catch((err) => {
    rateLimitLogger.error(
      { err },
      'Redis connect failed — using in-memory rate limiting',
    );
    redisClient = null;
  });
}

export { redisClient };

// Returns { store: RedisStore } when Redis is available, or {} to omit the
// property entirely — required by exactOptionalPropertyTypes.
const storeFor = (prefix: string): { store: RedisStore } | Record<string, never> =>
  redisClient
    ? {
        store: new RedisStore({
          sendCommand: (...args: string[]) => redisClient!.sendCommand(args),
          prefix: `rl:${prefix}:`,
        }),
      }
    : {};

// Custom handler to log rate limit events
export const logRateLimitHandler = (limitType: string): RateLimitHandler => {
  return (
    req: Request,
    res: Response,
    _next: NextFunction,
    options: Options,
  ): void => {
    rateLimitHitsTotal.inc({ limiter_type: limitType });

    // Use req.log if available (has request ID), otherwise use module logger
    const log = req.log || rateLimitLogger;

    log.warn(
      {
        userId: req.userId,
        ip: req.ip,
        path: req.path,
        limitType,
        userAgent: req.get('user-agent'),
      },
      `Rate limit exceeded - ${limitType}`,
    );

    // Send 429 Too Many Requests response
    res.status(429).json(options.message);
  };
};

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    error: 'Too many login attempts, please try again later.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skipFailedRequests: false,
  skip: (_req: Request) => isRateLimitDisabled,
  ...storeFor('auth'),
  handler: logRateLimitHandler('auth'),
});

export const writeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: {
    error: 'Too many requests. Please slow down.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (_req: Request) => isRateLimitDisabled,
  ...storeFor('write'),
  handler: logRateLimitHandler('write'),
});

export const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests. Please slow down.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (_req: Request) => isRateLimitDisabled,
  ...storeFor('read'),
  handler: logRateLimitHandler('read'),
});

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: {
    error: 'Too many requests. Please try again later.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (_req: Request) => isRateLimitDisabled,
  ...storeFor('global'),
  handler: logRateLimitHandler('global'),
});

// Protects /health/ready (which executes a DB round-trip) from abuse without
// throttling legitimate orchestrator probes. ALBs/K8s typically probe every
// 5–30s; 60/min/IP comfortably accommodates that even with multiple LBs.
export const healthLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: {
    error: 'Too many readiness probes. Please slow down.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (_req: Request) => isRateLimitDisabled,
  ...storeFor('health'),
  handler: logRateLimitHandler('health'),
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 2,
  message: {
    error: 'Too many accounts created. Please try again later.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (_req: Request) => isRateLimitDisabled,
  ...storeFor('register'),
  handler: logRateLimitHandler('register'),
});
