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
import { blindIndex } from '../lib/crypto/fieldCrypto.js';

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

// Derive the per-email rate-limit key. The validator runs after the limiter
// (we don't want to spend validation work on rate-limited traffic), so the
// limiter must canonicalize the email itself. We return the keyed blind index
// (HMAC over the NFC+lowercase+trim form — the same transform used by the Joi
// schema in middleware/validation.ts and the stored blind index in
// models/User.ts) rather than the raw address, so the plaintext email never
// lands in a Redis rate-limit key. Because blindIndex normalizes internally,
// Unicode variants (NFC vs NFD, full-width, IDN homoglyph) of one address still
// share a bucket. Returns '' when no parsable email is present (the empty-key
// bucket then catches malformed/empty-email floods globally — that traffic is
// also a quasi-attack signal).
export const loginEmailKey = (req: Request): string => {
  const body = req.body as { email?: unknown } | undefined;
  if (body && typeof body.email === 'string') {
    return blindIndex(body.email);
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
  // Compound (ip, email) key, adopted to make skipSuccessfulRequests safe:
  // that flag decrements the bucket on success, so under the old IP-only key an
  // attacker could refill their brute-force budget by logging into an account
  // they control. Under the compound key a success only decrements that same
  // (ip, email) bucket and can't touch any other account's counter.
  //
  // The cost is real and deliberate: because the email is in the key, rotating
  // the target mints a fresh 3-attempt bucket, so this limiter does NOT bound
  // credential stuffing spread across many accounts from one IP — only the
  // global limiter does, two orders of magnitude higher. A dedicated per-IP
  // login cap is the missing layer; see SCRUTINY.md M4.
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

  // Pure per-IP failure cap, layered under the compound limiter above. Because
  // the compound key includes the email, rotating targets mints a fresh bucket
  // per account, so nothing there bounds credential stuffing spread across many
  // accounts from one source — only the global limiter did, at ~800/hour.
  // Failures only (skipSuccessfulRequests), so ordinary logins from a shared
  // egress IP (corporate NAT, mobile CGNAT) never consume the budget; 60 failed
  // logins per 15 minutes from one address is already anomalous.
  //
  // Note this cap is per-instance unless REDIS_URL is set: N instances or
  // CLUSTER_WORKERS=N multiply the effective ceiling by N.
  'login-ip': {
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: {
      error: 'Too many failed login attempts from this network. Please try again later.',
    },
    skipSuccessfulRequests: true,
    skipFailedRequests: false,
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

  // Refresh + logout are refresh-token operations, keyed by IP (no email in the
  // body). Refresh tokens are 256-bit random, so blind guessing is futile; this
  // cap exists to bound abuse, not to gate legitimate multi-device users who
  // refresh every access-token window (~4/hour/device).
  refresh: {
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: {
      error: 'Too many token refresh attempts. Please try again later.',
    },
  },

  // Token redemption. The token is 256-bit random so guessing is futile; this
  // bounds abuse of the lookup rather than protecting the token itself.
  'verify-email': {
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: {
      error: 'Too many verification attempts. Please try again later.',
    },
  },

  // Resend triggers an outbound email, so the cost of abuse is someone else's
  // inbox (and our sender reputation) rather than CPU. Keyed by the blind index
  // of the address — the same canonicalization the login limiter uses — so
  // flooding one victim can't be spread across IPs.
  'resend-verification': {
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: {
      error: 'Too many verification emails requested. Please try again later.',
    },
    keyGenerator: loginEmailKey,
  },

  // Data export loads a user's entire history into memory and serializes it.
  // Under the generic read cap one account could replay that 100×/minute, so
  // the amplification — not any single response — is what needs bounding.
  // Keyed by user rather than IP so the limit follows the account whose data is
  // being read; auth runs before this limiter, so userId is always present.
  'user-export': {
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: {
      error: 'Too many export requests. Please try again later.',
    },
    keyGenerator: (req: Request): string => req.userId ?? ipKeyGenerator(req.ip ?? 'unknown'),
  },
};

export const buildLimiter = (
  limitType: keyof typeof limiterDefaults & string,
  overrides: Partial<Options> = {},
): RateLimitRequestHandler =>
  rateLimit(baseOptions(limitType, { ...limiterDefaults[limitType], ...overrides }));

export const authLimiter = buildLimiter('auth');
export const loginEmailLimiter = buildLimiter('login-email');
export const loginIpLimiter = buildLimiter('login-ip');
export const exportLimiter = buildLimiter('user-export');
export const verifyEmailLimiter = buildLimiter('verify-email');
export const resendVerificationLimiter = buildLimiter('resend-verification');
export const writeLimiter = buildLimiter('write');
export const readLimiter = buildLimiter('read');
export const globalLimiter = buildLimiter('global');
export const healthLimiter = buildLimiter('health');
export const registerLimiter = buildLimiter('register');
export const refreshLimiter = buildLimiter('refresh');
