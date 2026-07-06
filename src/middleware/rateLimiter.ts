import rateLimit, {
  ipKeyGenerator,
  MemoryStore,
  type Options,
  type RateLimitRequestHandler,
} from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';
import type { Request, Response, NextFunction } from 'express';
import logger from './logger.js';
import { env } from '../config/env.js';
import { rateLimitHitsTotal, rateLimitStoreFallbackTotal } from './metrics.js';
import { FallbackStore } from './rateLimitStore.js';

// Create module-specific logger
const rateLimitLogger = logger.child({ module: 'rate-limiter' });

// Type for the rate limit handler function
type RateLimitHandler = (req: Request, res: Response, next: NextFunction, options: Options) => void;

const isRateLimitDisabled = env.NODE_ENV === 'test' || env.DISABLE_RATE_LIMIT === true;

// Optional Redis client for distributed rate limiting across multiple
// instances. When REDIS_URL is unset, limiters use the library's per-instance
// MemoryStore. When set, each limiter gets a FallbackStore: Redis-backed while
// the client is ready, per-instance memory otherwise — so a Redis outage
// degrades the caps instead of failing every limited request.
let redisClient: ReturnType<typeof createClient> | null = null;

if (env.REDIS_URL) {
  redisClient = createClient({ url: env.REDIS_URL });
  redisClient.on('error', (err) => {
    rateLimitLogger.error({ err }, 'Redis client error');
  });
  // Keep the client on failure: node-redis keeps reconnecting per its
  // strategy, and FallbackStore serves from memory while !isReady.
  redisClient.connect().catch((err) => {
    rateLimitLogger.error(
      { err },
      'Redis connect failed — rate limiters degraded to per-instance memory store',
    );
  });
}

export { redisClient };

// Returns { store: FallbackStore } when Redis is configured, or {} to omit the
// property entirely (library default MemoryStore) — required by
// exactOptionalPropertyTypes.
const storeFor = (prefix: string): { store: FallbackStore } | Record<string, never> =>
  redisClient
    ? {
        store: new FallbackStore(
          new RedisStore({
            sendCommand: (...args: string[]) => redisClient!.sendCommand(args),
            prefix: `rl:${prefix}:`,
          }),
          new MemoryStore(),
          {
            isPrimaryReady: () => redisClient?.isReady === true,
            onFallback: () => rateLimitStoreFallbackTotal.inc({ limiter_type: prefix }),
          },
        ),
      }
    : {};

// Custom handler to log rate limit events
export const logRateLimitHandler = (limitType: string): RateLimitHandler => {
  return (req: Request, res: Response, _next: NextFunction, options: Options): void => {
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

// Base options per limiter, exported through buildLimiter so tests can
// construct a live limiter (skip disabled, memory store) and exercise real
// counting/429 semantics — the module-level exports keep env defaults.
const baseOptions = (limitType: string, overrides: Partial<Options>): Partial<Options> => ({
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (_req: Request) => isRateLimitDisabled,
  handler: logRateLimitHandler(limitType),
  ...storeFor(limitType),
  ...overrides,
});

const limiterDefaults: Record<string, Partial<Options>> = {
  // Compound (ip, email) key. The previous IP-only key let an attacker on a
  // single IP brute-force one account 3× per window then switch accounts.
  // skipSuccessfulRequests only decrements the same (ip, email) bucket under
  // the compound key, so successful logins don't count toward the failed-
  // attempt cap and can't reset any other account's counter — which is why
  // the flag is safe here (it wasn't under the old IP-only key).
  // ipKeyGenerator collapses IPv6 /64 prefixes so a single attacker can't
  // walk a /64 to defeat per-IP limits. Per express-rate-limit v8 docs, any
  // custom keyGenerator that incorporates req.ip MUST use this helper.
  auth: {
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: {
      error: 'Too many login attempts, please try again later.',
    },
    skipSuccessfulRequests: true,
    skipFailedRequests: false,
    keyGenerator: authLimiterKeyGenerator,
  },

  // Per-email limiter — caps brute-force against a single account regardless
  // of source IP diversity. 30/hour is high enough that a legitimate user
  // fumbling their password won't hit it, low enough that distributed
  // credential-stuffing is throttled across the whole attack surface.
  // Redis-backed when REDIS_URL is set so the cap holds across instances;
  // degrades to a per-instance cap while Redis is unavailable.
  'login-email': {
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: {
      error: 'Too many login attempts for this account. Please try again later.',
    },
    skipFailedRequests: false,
    keyGenerator: loginEmailKey,
  },

  write: {
    windowMs: 1 * 60 * 1000,
    max: 30,
    message: {
      error: 'Too many requests. Please slow down.',
    },
  },

  read: {
    windowMs: 1 * 60 * 1000,
    max: 100,
    message: {
      error: 'Too many requests. Please slow down.',
    },
  },

  global: {
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: {
      error: 'Too many requests. Please try again later.',
    },
  },

  // Protects /health/ready (which executes a DB round-trip) from abuse without
  // throttling legitimate orchestrator probes. ALBs/K8s typically probe every
  // 5–30s; 60/min/IP comfortably accommodates that even with multiple LBs.
  health: {
    windowMs: 1 * 60 * 1000,
    max: 60,
    message: {
      error: 'Too many readiness probes. Please slow down.',
    },
  },

  register: {
    windowMs: 60 * 60 * 1000,
    max: 2,
    message: {
      error: 'Too many accounts created. Please try again later.',
    },
  },
};

export const buildLimiter = (
  limitType: keyof typeof limiterDefaults & string,
  overrides: Partial<Options> = {},
): RateLimitRequestHandler =>
  rateLimit(baseOptions(limitType, { ...limiterDefaults[limitType], ...overrides }));

export const authLimiter = buildLimiter('auth');
export const loginEmailLimiter = buildLimiter('login-email');
export const writeLimiter = buildLimiter('write');
export const readLimiter = buildLimiter('read');
export const globalLimiter = buildLimiter('global');
export const healthLimiter = buildLimiter('health');
export const registerLimiter = buildLimiter('register');
