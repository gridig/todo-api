import { cleanEnv, str, port, url, bool, num, makeValidator } from 'envalid';
import dotenv from 'dotenv';

const JWT_SECRET_MIN_LENGTH = 32;

const jwtSecret = makeValidator<string>((value) => {
  if (typeof value !== 'string' || value.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters long`);
  }
  return value;
});

// Load .env file before validation
// In test environment, setup.js handles this
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

/**
 * Validates and provides typed environment variables
 * Throws descriptive errors if required variables are missing or invalid
 */
export const env = cleanEnv(process.env, {
  // Server Configuration
  NODE_ENV: str({
    choices: ['development', 'production', 'test'],
    default: 'development',
    desc: 'Application environment',
  }),

  PORT: port({
    default: 3001,
    desc: 'Port number for the server',
  }),

  // Database Configuration
  DATABASE_URL: url({
    desc: 'PostgreSQL connection string for the runtime app (db_app role)',
    example: 'postgresql://db_app:db_app_dev@localhost:5432/todo_api',
  }),

  // Consumed only by prisma.config.ts during `prisma migrate deploy` so
  // migrations can connect as the schema owner (db_admin) while the app
  // continues to connect as db_app. Unset → falls back to DATABASE_URL.
  DATABASE_MIGRATE_URL: url({
    default: undefined,
    desc: 'Optional admin DSN used only by `prisma migrate deploy`. Required once role separation is in place.',
    example: 'postgresql://db_admin:db_admin_dev@localhost:5432/todo_api',
  }),

  // Authentication
  JWT_SECRET: jwtSecret({
    desc: 'Secret key for JWT token generation (required, minimum 32 characters)',
    example: 'your-super-secret-jwt-key-min-32-chars',
  }),

  JWT_ISSUER: str({
    default: 'todo-api',
    desc: 'JWT `iss` claim. Set both sign and verify sides to the same value.',
  }),

  JWT_AUDIENCE: str({
    default: 'todo-api-clients',
    desc: 'JWT `aud` claim. Set both sign and verify sides to the same value.',
  }),

  JWT_VERIFY_REQUIRE_CLAIMS: bool({
    default: false,
    desc: 'When true, jwt.verify rejects tokens lacking iss/aud claims. Flip to true at least one full 24h-expiry window after the rollout deploy so legacy tokens have aged out. Until then, verify accepts both legacy { userId } and new { sub, iss, aud } payloads.',
  }),

  // CORS Configuration
  CORS_ORIGIN: str({
    // No default: the app must fail fast on a missing CORS policy rather than
    // silently fall into allow-all mode. Set explicitly per environment.
    // Use '*' only when allow-all is genuinely intended (rare in production).
    desc: "Allowed CORS origin(s). Comma-separated list of exact origins, or '*' to disable origin restriction.",
    example: 'https://app.example.com,https://admin.example.com',
  }),

  CORS_CREDENTIALS: str({
    choices: ['true', 'false'],
    default: 'false',
    desc: 'Allow cookies and authorization headers in CORS requests',
  }),

  CORS_METHODS: str({
    // Only methods actually mounted by the API. Extend explicitly per
    // environment if a future route uses PUT/OPTIONS beyond the cors package's
    // built-in preflight handling.
    default: 'GET,HEAD,POST,PATCH,DELETE',
    desc: 'Allowed HTTP methods in CORS requests',
  }),

  CORS_HEADERS: str({
    default: 'Content-Type,Authorization',
    desc: 'Allowed HTTP headers in CORS requests',
  }),

  CORS_MAX_AGE: str({
    default: '86400',
    desc: 'How long preflight requests should be cached (in seconds)',
  }),

  CORS_ALLOW_NO_ORIGIN: bool({
    default: true,
    desc: 'Whether to accept requests without an Origin header (e.g. server-to-server, mobile apps, curl). Set to false in browser-only deployments to require an explicit, allow-listed origin.',
  }),

  // Number of proxy hops Express trusts when deriving req.ip (rate-limit keys,
  // audit sourceIp). Railway / single LB = 1; add one per additional fronting
  // proxy (e.g. CDN in front of the LB = 2).
  TRUST_PROXY: num({
    default: 1,
    desc: 'Trusted proxy hop count for req.ip (Express "trust proxy" setting)',
  }),

  // HTTP Request Body Limit
  BODY_LIMIT: str({
    default: '16kb',
    desc: 'Maximum JSON request body size (bytes string, e.g. "16kb", "1mb"). Requests exceeding the limit are rejected with 413.',
  }),

  // Logging Configuration (Optional)
  LOG_LEVEL: str({
    choices: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
    default: undefined,
    desc: 'Logging level (auto-determined if not set)',
  }),

  DISABLE_RATE_LIMIT: bool({
    default: false,
    desc: 'Disable rate limiting. To enable in production, pair with DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM=true — otherwise startup aborts.',
  }),

  DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM: bool({
    default: false,
    desc: 'Confirmation flag required to set DISABLE_RATE_LIMIT=true in production. Both must be true; either alone fails startup. Document the dedicated-benchmark-process intent in your deploy runbook before flipping these.',
  }),

  ENABLE_ECHO_ROUTES: bool({
    default: process.env.NODE_ENV !== 'production',
    desc: 'Expose the /echo benchmark routes (no logging, no rate limiting). Defaults to true in non-production, false in production. To enable in production, pair with ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM=true — otherwise startup aborts.',
  }),

  ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: bool({
    default: false,
    desc: 'Confirmation flag required to enable ENABLE_ECHO_ROUTES in production. Both must be true; either alone fails startup. Document the dedicated-benchmark-process intent in your deploy runbook before flipping these.',
  }),

  // Shutdown Configuration
  SHUTDOWN_DELAY_MS: num({
    default: 5000,
    desc: 'ms to wait after SIGTERM before closing (K8s endpoint propagation)',
  }),

  SHUTDOWN_TIMEOUT_MS: num({
    default: 10000,
    desc: 'Force-exit if graceful drain exceeds this duration',
  }),

  // Database Pool Configuration
  DB_POOL_MAX: num({
    default: 10,
    desc: 'Max connections per instance',
  }),

  DB_POOL_MIN: num({
    default: 2,
    desc: 'Min idle connections to keep warm',
  }),

  DB_CONNECTION_TIMEOUT_MS: num({
    default: 5000,
    desc: 'ms to wait for a free pool connection',
  }),

  DB_IDLE_TIMEOUT_MS: num({
    default: 10000,
    desc: 'ms before idle connection is released',
  }),

  DB_QUERY_TIMEOUT_MS: num({
    default: 5000,
    desc: 'ms a single query may run before the connection is killed and returned to the pool',
  }),

  DB_PROBE_TIMEOUT_MS: num({
    default: 1000,
    desc: 'ms the readiness probe will wait for SELECT 1 on its dedicated probe connection. Tighter than DB_QUERY_TIMEOUT_MS so probe latency stays well under k8s readiness/liveness timeoutSeconds (default 1s) even under sustained saturation + jitter + GC.',
  }),

  DB_CONNECT_MAX_RETRIES: num({
    default: 5,
    desc: 'Number of times to retry the initial Prisma connection at startup before giving up. Set to 0 to disable retry (fail fast).',
  }),

  DB_CONNECT_INITIAL_DELAY_MS: num({
    default: 1000,
    desc: 'Base delay (ms) for the first startup-connect retry. Subsequent delays use decorrelated jitter capped at 30s.',
  }),

  REDIS_URL: str({
    default: undefined,
    desc: 'Optional Redis URL for distributed rate limiting',
  }),

  // Cluster Configuration
  CLUSTER_WORKERS: num({
    default: 1,
    desc: 'Number of worker processes. 1 = single process (no clustering), 0 = auto-detect CPU count, N = exact worker count',
  }),

  // Metrics Configuration
  METRICS_TOKEN: str({
    default: undefined,
    desc: 'Optional bearer token to protect GET /metrics. If unset, endpoint is unauthenticated. Strongly recommended in production.',
    example: 'a-random-secret-string-32-chars-min',
  }),

  DISABLE_DB_METRICS: bool({
    default: false,
    desc: 'Disable database metrics. If set to true, the database metrics will not be collected.',
  }),

  // HTTP Server Timeout Configuration
  SERVER_HEADERS_TIMEOUT_MS: num({
    default: 60000,
    desc: 'ms for the server to receive the full HTTP request headers (Node default: 60000). Should exceed load balancer idle timeout.',
  }),

  SERVER_REQUEST_TIMEOUT_MS: num({
    default: 30000,
    desc: 'ms for the server to receive the full HTTP request body (Node 18+ default: 300000). Set lower to bound slow clients.',
  }),

  SERVER_KEEP_ALIVE_TIMEOUT_MS: num({
    default: 65000,
    desc: 'ms to keep idle keep-alive connections open. Must exceed load balancer idle timeout (typically 60s) to avoid mid-flight 502s.',
  }),
});

// Production-mode hardening: refuse to boot when a security-sensitive flag is
// in a state that would be a regression in production. cleanEnv() handles the
// per-variable validation; this is cross-cutting policy. Exported as a pure
// function so the rules can be unit-tested with synthetic env shapes without
// spawning a child process for every case.
//
// Writing to stderr (not the logger) below because middleware/logger.ts
// imports this module — using the logger would create an import cycle.

export const METRICS_TOKEN_MIN_LENGTH = 32;

export interface ProductionAssertionInput {
  NODE_ENV: string;
  METRICS_TOKEN?: string | undefined;
  DISABLE_RATE_LIMIT: boolean;
  DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM: boolean;
  ENABLE_ECHO_ROUTES: boolean;
  ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: boolean;
  CORS_ORIGIN: string;
  CORS_CREDENTIALS: string;
}

export interface ProductionAssertionResult {
  errors: string[];
  warnings: string[];
}

export function assertProductionEnv(cfg: ProductionAssertionInput): ProductionAssertionResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (cfg.NODE_ENV !== 'production') return { errors, warnings };

  if (!cfg.METRICS_TOKEN || cfg.METRICS_TOKEN.length < METRICS_TOKEN_MIN_LENGTH) {
    errors.push(
      `METRICS_TOKEN is required in production and must be at least ${METRICS_TOKEN_MIN_LENGTH} characters`,
    );
  }
  if (cfg.DISABLE_RATE_LIMIT && !cfg.DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM) {
    errors.push(
      'DISABLE_RATE_LIMIT=true in production requires DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM=true (confirms this is a dedicated benchmark process, not user-serving)',
    );
  } else if (cfg.DISABLE_RATE_LIMIT && cfg.DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM) {
    warnings.push(
      'DISABLE_RATE_LIMIT=true in production with CONFIRM. Every limiter (global, auth, register, read, write, health) is bypassed — this process must not serve real traffic.',
    );
  }
  if (cfg.CORS_ORIGIN.trim() === '*' && cfg.CORS_CREDENTIALS === 'true') {
    errors.push(
      'CORS_ORIGIN="*" is incompatible with CORS_CREDENTIALS=true (browsers refuse the combination)',
    );
  }
  if (cfg.ENABLE_ECHO_ROUTES && !cfg.ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM) {
    errors.push(
      'ENABLE_ECHO_ROUTES=true in production requires ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM=true (confirms this is a dedicated benchmark process, not user-serving)',
    );
  } else if (cfg.ENABLE_ECHO_ROUTES && cfg.ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM) {
    warnings.push(
      'ENABLE_ECHO_ROUTES=true in production with CONFIRM. /echo bypasses logging and rate limiting — this process must not serve real traffic.',
    );
  }

  return { errors, warnings };
}

const { errors: prodErrors, warnings: prodWarnings } = assertProductionEnv(env);
for (const w of prodWarnings) {
  process.stderr.write(`WARNING: ${w}\n`);
}
if (prodErrors.length > 0) {
  throw new Error(`Invalid production configuration:\n  - ${prodErrors.join('\n  - ')}`);
}
