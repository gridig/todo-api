import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
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

// Extract the login email for use in rate-limit keys. The validator runs
// after the limiter (we don't want to spend validation work on
// rate-limited traffic), so the limiter must canonicalize the email
// itself. NFC + lowercase + trim mirrors the Joi schema in
// middleware/validation.ts and the storage path in models/User.ts —
// keeping all three in lockstep prevents Unicode-variant evasion of the
// per-email cap (NFC vs NFD, full-width Latin, IDN homoglyphs).
// Returns '' when no parsable body is present (the empty-key bucket then
// catches malformed/empty-email floods globally — fine, that traffic is
// also a quasi-attack signal).
export const loginEmailKey = (req: Request): string => {
  const body = req.body as { email?: unknown } | undefined;
  if (body && typeof body.email === 'string') {
    return body.email.normalize('NFC').toLowerCase().trim();
  }
  return '';
};

// Compound (ip, email) key. Extracted as a named helper so the IPv4/IPv6
// fallback branch (`req.ip ?? 'unknown'`) can be unit-tested without
// enabling rate limiting in integration tests.
export const authLimiterKeyGenerator = (req: Request): string =>
  `${ipKeyGenerator(req.ip ?? 'unknown')}:${loginEmailKey(req)}`;

// Compound (ip, email) key. The previous IP-only key let an attacker on a
// single IP brute-force one account 3× per window then switch accounts
// (one valid login on attacker's own account previously reset the window
// because skipSuccessfulRequests: true — that flag is dropped below).
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    error: 'Too many login attempts, please try again later.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Intentionally NOT setting skipSuccessfulRequests — a successful login on
  // one account must not reset the counter for another account on the same IP.
  skipFailedRequests: false,
  skip: (_req: Request) => isRateLimitDisabled,
  // ipKeyGenerator collapses IPv6 /64 prefixes so a single attacker can't
  // walk a /64 to defeat per-IP limits. Per express-rate-limit v8 docs, any
  // custom keyGenerator that incorporates req.ip MUST use this helper.
  keyGenerator: authLimiterKeyGenerator,
  ...storeFor('auth'),
  handler: logRateLimitHandler('auth'),
});

// Per-email limiter — caps brute-force against a single account regardless
// of source IP diversity. 30/hour is high enough that a legitimate user
// fumbling their password won't hit it, low enough that distributed
// credential-stuffing is throttled across the whole attack surface.
// Redis-backed when REDIS_URL is set so the cap holds across instances;
// falls back to in-memory otherwise (per-instance cap, documented gap).
export const loginEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: {
    error: 'Too many login attempts for this account. Please try again later.',
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipFailedRequests: false,
  skip: (_req: Request) => isRateLimitDisabled,
  keyGenerator: loginEmailKey,
  ...storeFor('login-email'),
  handler: logRateLimitHandler('login-email'),
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
