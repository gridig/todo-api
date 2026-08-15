import { cleanEnv, str, port, url, bool, num, makeValidator } from 'envalid';
import dotenv from 'dotenv';

const JWT_SECRET_MIN_LENGTH = 32;

const jwtSecret = makeValidator<string>((value) => {
  if (typeof value !== 'string' || value.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters long`);
  }
  return value;
});

// Field-encryption key material (see lib/crypto/*). AES-256 and HMAC-SHA256
// both take a 32-byte key. Keys travel as base64 in env vars (Railway per-env
// secrets) — the same trust model as JWT_SECRET and PGBACKREST_CIPHER_PASS.
const ENCRYPTION_KEY_BYTES = 32;
// keyId charset deliberately excludes ':' — the ciphertext envelope
// (enc:1:<keyId>:...) and the keyring entries (<keyId>:<key>) both split on ':'.
const ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The committed dev/test placeholder (32 zero bytes). Real per-environment keys
// must replace it; assertProductionEnv() refuses to boot production on it.
export const ENCRYPTION_DEV_PLACEHOLDER_KEY = Buffer.alloc(ENCRYPTION_KEY_BYTES, 0).toString(
  'base64',
);

const decodeEncryptionKey = (value: string, label: string): void => {
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(`${label} must be a base64-encoded ${ENCRYPTION_KEY_BYTES}-byte key`);
  }
};

// Comma-separated `<keyId>:<base64-32-byte-key>` entries. Validated here so a
// malformed keyring fails at boot, not at the first encrypt/decrypt. The raw
// string is returned; lib/crypto/keyProvider.ts parses it once into a Map.
const encryptionKeyring = makeValidator<string>((value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'ENCRYPTION_KEYRING must be a non-empty comma-separated list of <keyId>:<base64-32-byte-key>',
    );
  }
  const entries = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error('ENCRYPTION_KEYRING must contain at least one <keyId>:<key> entry');
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const sep = entry.indexOf(':');
    if (sep === -1) {
      throw new Error(`ENCRYPTION_KEYRING entry "${entry}" must be <keyId>:<base64-key>`);
    }
    const keyId = entry.slice(0, sep);
    const keyB64 = entry.slice(sep + 1);
    if (!ENCRYPTION_KEY_ID_PATTERN.test(keyId)) {
      throw new Error(
        `ENCRYPTION_KEYRING keyId "${keyId}" must match ${String(ENCRYPTION_KEY_ID_PATTERN)}`,
      );
    }
    if (seen.has(keyId)) {
      throw new Error(`ENCRYPTION_KEYRING has a duplicate keyId "${keyId}"`);
    }
    seen.add(keyId);
    decodeEncryptionKey(keyB64, `ENCRYPTION_KEYRING key for "${keyId}"`);
  }
  return value;
});

const base64Key32 = makeValidator<string>((value) => {
  if (typeof value !== 'string') {
    throw new Error(`must be a base64-encoded ${ENCRYPTION_KEY_BYTES}-byte key`);
  }
  decodeEncryptionKey(value, 'key');
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

  // Optional previous signing secret, honoured on the VERIFY side only. During
  // a JWT_SECRET rotation, set this to the outgoing secret so tokens signed
  // before the cutover keep verifying until they expire (dual-secret window).
  // New tokens are always signed with JWT_SECRET. Clear it once the window
  // (>= ACCESS_TOKEN_EXPIRY) has elapsed. See docs/operations.md → JWT secret rotation.
  JWT_SECRET_PREVIOUS: jwtSecret({
    default: undefined,
    desc: 'Previous JWT secret, accepted on verify only during a rotation window. Minimum 32 characters when set. Unset outside rotations.',
  }),

  JWT_ISSUER: str({
    default: 'todo-api',
    desc: 'JWT `iss` claim. Set both sign and verify sides to the same value.',
  }),

  JWT_AUDIENCE: str({
    default: 'todo-api-clients',
    desc: 'JWT `aud` claim. Set both sign and verify sides to the same value.',
  }),

  // Access tokens are short-lived: revocation of a compromised session is
  // achieved by revoking the refresh token (logout-all / password change) and
  // letting the access token expire within this window — stateless JWTs can't
  // be individually revoked. Value is any `ms`-style string jsonwebtoken accepts.
  ACCESS_TOKEN_EXPIRY: str({
    default: '15m',
    desc: 'Access-token lifetime (jsonwebtoken `expiresIn`, e.g. "15m", "1h"). Keep short — refresh tokens cover long-lived sessions.',
  }),

  REFRESH_TOKEN_EXPIRY_DAYS: num({
    default: 30,
    desc: 'Refresh-token lifetime in days. Rotated on every /auth/refresh; the absolute expiry here caps a stolen-but-unused token.',
  }),

  VERIFICATION_TOKEN_EXPIRY_HOURS: num({
    default: 24,
    desc: 'Email-verification link lifetime in hours. Single-use; a new one is issued by POST /auth/resend-verification.',
  }),

  // Outbound mail (lib/mailer.ts). Unset in dev/CI selects the log transport,
  // which prints the verification link instead of sending it. Production must
  // supply real values — assertProductionEnv refuses to boot otherwise, so a
  // misconfigured deploy fails loudly rather than silently dropping every
  // verification email and locking new users out of their accounts.
  RESEND_API_KEY: str({
    default: undefined,
    desc: 'Resend API key. Required in production; unset selects the dev log transport.',
    example: 're_xxxxxxxxxxxxxxxxxxxxxxxx',
  }),

  MAIL_FROM: str({
    default: undefined,
    desc: 'From address for outbound mail, e.g. "Todo API <noreply@example.com>". Required in production.',
    example: 'Todo API <noreply@example.com>',
  }),

  APP_BASE_URL: str({
    default: 'http://localhost:3000',
    desc: 'Public origin of the frontend, used to build the verification link (<APP_BASE_URL>/verify-email?token=…).',
    example: 'https://app.example.com',
  }),

  // Field-level encryption (see docs/configuration.md → "Encryption at rest").
  // All three are required in every environment (like JWT_SECRET) so the app
  // never silently starts without a key. Dev/test use the committed placeholder
  // from .env.example / .env.test; production must supply real per-env secrets.
  ENCRYPTION_KEYRING: encryptionKeyring({
    desc: 'Comma-separated <keyId>:<base64-32-byte-key> entries. New writes use ENCRYPTION_ACTIVE_KEY_ID; old ciphertext decrypts with whichever keyId it embeds, so keep retired keys here until re-encryption drains them.',
    example: 'k1:BASE64_32_BYTE_KEY,k2:BASE64_32_BYTE_KEY',
  }),

  ENCRYPTION_ACTIVE_KEY_ID: str({
    desc: 'keyId (must exist in ENCRYPTION_KEYRING) used to encrypt new values. Rotating = add a new key to the ring and point this at it.',
    example: 'k1',
  }),

  ENCRYPTION_BLIND_INDEX_KEY: base64Key32({
    desc: 'base64-encoded 32-byte HMAC-SHA256 key for the email blind index (deterministic lookup/uniqueness column). Rotating this requires a full re-hash of users.email_hash — see docs/operations.md.',
    example: 'BASE64_32_BYTE_KEY',
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

export interface EnvInvariantInput {
  SHUTDOWN_DELAY_MS: number;
  SHUTDOWN_TIMEOUT_MS: number;
  DB_POOL_MAX: number;
  DB_POOL_MIN: number;
  JWT_SECRET: string;
  JWT_SECRET_PREVIOUS?: string | undefined;
}

// Cross-field invariants cleanEnv's per-variable validation can't express.
// These hold in every environment: each violation silently degrades behavior at
// runtime instead of failing at the point of use, so they fail the boot instead.
export function assertEnvInvariants(cfg: EnvInvariantInput): string[] {
  const errors: string[] = [];

  // setupGracefulShutdown arms the force-exit timer *before* awaiting the drain
  // delay, so a timeout at or below the delay makes every shutdown a forced
  // exit(1) with no drain window at all.
  if (cfg.SHUTDOWN_TIMEOUT_MS <= cfg.SHUTDOWN_DELAY_MS) {
    errors.push(
      `SHUTDOWN_TIMEOUT_MS (${cfg.SHUTDOWN_TIMEOUT_MS}) must exceed SHUTDOWN_DELAY_MS (${cfg.SHUTDOWN_DELAY_MS}) — the force-exit timer starts before the drain delay, so in-flight requests would get no drain window`,
    );
  }

  if (cfg.DB_POOL_MAX < 1) {
    errors.push(`DB_POOL_MAX (${cfg.DB_POOL_MAX}) must be at least 1`);
  }

  // pg silently accepts min > max and then never reaps down to it.
  if (cfg.DB_POOL_MIN > cfg.DB_POOL_MAX) {
    errors.push(
      `DB_POOL_MIN (${cfg.DB_POOL_MIN}) must not exceed DB_POOL_MAX (${cfg.DB_POOL_MAX})`,
    );
  }

  // Both secrets set to the same value reads as an in-progress rotation while
  // verifying nothing the current secret doesn't already cover.
  if (cfg.JWT_SECRET_PREVIOUS !== undefined && cfg.JWT_SECRET_PREVIOUS === cfg.JWT_SECRET) {
    errors.push(
      'JWT_SECRET_PREVIOUS must differ from JWT_SECRET (identical values hide an incomplete rotation)',
    );
  }

  return errors;
}

export interface ProductionAssertionInput {
  NODE_ENV: string;
  METRICS_TOKEN?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  MAIL_FROM?: string | undefined;
  APP_BASE_URL?: string | undefined;
  DISABLE_RATE_LIMIT: boolean;
  DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM: boolean;
  ENABLE_ECHO_ROUTES: boolean;
  ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: boolean;
  CORS_ORIGIN: string;
  CORS_CREDENTIALS: string;
  ENCRYPTION_KEYRING: string;
  ENCRYPTION_BLIND_INDEX_KEY: string;
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
  // The committed dev/test placeholder key must never protect production PII.
  if (!cfg.ENCRYPTION_KEYRING || cfg.ENCRYPTION_KEYRING.includes(ENCRYPTION_DEV_PLACEHOLDER_KEY)) {
    errors.push(
      'ENCRYPTION_KEYRING must be real per-environment key material in production (the committed dev placeholder key is rejected)',
    );
  }
  if (
    !cfg.ENCRYPTION_BLIND_INDEX_KEY ||
    cfg.ENCRYPTION_BLIND_INDEX_KEY === ENCRYPTION_DEV_PLACEHOLDER_KEY
  ) {
    errors.push(
      'ENCRYPTION_BLIND_INDEX_KEY must be real per-environment key material in production (the committed dev placeholder key is rejected)',
    );
  }

  // Without real mail configuration the app falls back to the log transport,
  // which would silently drop every verification email — and since login is
  // gated on verification, every new production account would be unusable with
  // no error anywhere. Fail at boot instead.
  if (!cfg.RESEND_API_KEY || !cfg.MAIL_FROM) {
    errors.push(
      'RESEND_API_KEY and MAIL_FROM are required in production (without them the mailer falls back to the log transport and no user can ever verify their address)',
    );
  }
  if (!cfg.APP_BASE_URL || cfg.APP_BASE_URL.startsWith('http://localhost')) {
    errors.push(
      'APP_BASE_URL must be the real public origin in production (verification links are built from it)',
    );
  }

  return { errors, warnings };
}

const invariantErrors = assertEnvInvariants(env);
if (invariantErrors.length > 0) {
  throw new Error(`Invalid configuration:\n  - ${invariantErrors.join('\n  - ')}`);
}

const { errors: prodErrors, warnings: prodWarnings } = assertProductionEnv(env);
for (const w of prodWarnings) {
  process.stderr.write(`WARNING: ${w}\n`);
}
if (prodErrors.length > 0) {
  throw new Error(`Invalid production configuration:\n  - ${prodErrors.join('\n  - ')}`);
}
