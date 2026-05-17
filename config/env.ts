import { cleanEnv, str, port, url, bool, num, makeValidator } from 'envalid';
import dotenv from 'dotenv';

const JWT_SECRET_MIN_LENGTH = 32;

const jwtSecret = makeValidator<string>((value) => {
  if (typeof value !== 'string' || value.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters long`,
    );
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
    desc: 'PostgreSQL connection string (required)',
    example: 'postgresql://user:password@localhost:5432/todo_api',
  }),

  // Authentication
  JWT_SECRET: jwtSecret({
    desc: 'Secret key for JWT token generation (required, minimum 32 characters)',
    example: 'your-super-secret-jwt-key-min-32-chars',
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
    default: 'GET,HEAD,PUT,PATCH,POST,DELETE',
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
    desc: 'Disable rate limiting',
  }),

  ENABLE_ECHO_ROUTES: bool({
    default: process.env.NODE_ENV !== 'production',
    desc: 'Expose the /echo benchmark routes (no logging, no rate limiting, no body parsing). Defaults to true in non-production, false in production. Set to true in production only on a dedicated benchmark process — never on an instance serving real traffic.',
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
