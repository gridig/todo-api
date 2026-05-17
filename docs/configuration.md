# Configuration

This guide covers all environment variables, validation behavior, and CORS setup.

## Environment Variable Validation

The application uses `envalid` to validate all environment variables at startup, ensuring the server won't start with missing or invalid configuration.

- Type validation (PORT must be valid port number, DATABASE_URL must be valid PostgreSQL connection string)
- Required vs. optional variable enforcement
- Clear error messages with examples for misconfigured values
- Prevents runtime failures due to configuration issues

**Implementation**: See `config/env.ts` for the validation schema and `.env.example` for a template.

## Required Variables

| Variable       | Type   | Description                                                                                                 | Example                                              |
| -------------- | ------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `DATABASE_URL` | URL    | PostgreSQL connection string                                                                                | `postgresql://user:password@localhost:5432/todo-api` |
| `JWT_SECRET`   | String | Secret key for JWT tokens. **Minimum 32 characters** — the server fails fast at startup if this is shorter. | `your-super-secret-jwt-key-min-32-chars`             |

Generate a secure JWT secret for production:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Optional Variables

### Application

| Variable   | Type   | Default       | Description                               |
| ---------- | ------ | ------------- | ----------------------------------------- |
| `PORT`     | Port   | `3001`        | Server port number                        |
| `NODE_ENV` | String | `development` | Environment (development/production/test) |

### Logging

| Variable    | Type   | Default | Description                                       |
| ----------- | ------ | ------- | ------------------------------------------------- |
| `LOG_LEVEL` | String | Auto    | Logging level (fatal/error/warn/info/debug/trace) |

### Shutdown

| Variable              | Type   | Default | Description                                                |
| --------------------- | ------ | ------- | ---------------------------------------------------------- |
| `SHUTDOWN_DELAY_MS`   | Number | `5000`  | ms to wait after SIGTERM before closing (K8s drain window) |
| `SHUTDOWN_TIMEOUT_MS` | Number | `10000` | Force-exit if graceful drain exceeds this duration         |

### Database Pool

Pool sizing rule: `DB_POOL_MAX × replica_count × CLUSTER_WORKERS` must stay well below the PostgreSQL `max_connections` limit (default 100), with headroom for migrations and admin connections.

| Variable                   | Type   | Default | Description                                                                        |
| -------------------------- | ------ | ------- | ---------------------------------------------------------------------------------- |
| `DB_POOL_MAX`              | Number | `10`    | Max connections per instance                                                       |
| `DB_POOL_MIN`              | Number | `2`     | Min idle connections to keep warm                                                  |
| `DB_CONNECTION_TIMEOUT_MS` | Number | `5000`  | ms to wait for a free pool connection                                              |
| `DB_IDLE_TIMEOUT_MS`       | Number | `10000` | ms before an idle connection is released                                           |
| `DB_QUERY_TIMEOUT_MS`      | Number | `5000`  | ms a single query may run before the connection is killed and returned to the pool |
| `DB_PROBE_TIMEOUT_MS`      | Number | `1000`  | ms ceiling for the readiness probe's `SELECT 1` (runs on a dedicated single-connection pool, not the application pool — see Observability) |

#### Sizing recommendations

Start from the classic PostgreSQL heuristic and adjust downward to stay under the database's connection ceiling:

```
pool_size = (cpu_cores * 2) + effective_spindle_count
```

For SSD-backed databases (Railway, Render, RDS gp3, etc.) `effective_spindle_count` is effectively `1`. So a 4-core Postgres instance lands around `(4 * 2) + 1 = 9` connections per pool — close to the current default of `10`. The default is appropriate for a single app instance against a small managed database.

Recommended starting values by deployment shape:

| Deployment profile                | `DB_POOL_MAX`                                                    | Reasoning                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Single instance, low traffic**  | `10`                                                             | Default. Comfortably under `max_connections=100` with room for migrations and `psql` sessions.                                             |
| **Multi-instance (3 replicas)**   | `15–20`                                                          | Each replica gets its own pool. Up to ~60 total connections against a 100-connection DB leaves headroom for migrations and admin sessions. |
| **Clustered (N workers/replica)** | `floor(max_connections / (CLUSTER_WORKERS × replica_count)) - 1` | Workers don't share a pool — each spawns its own. Same calculation as Railway example below.                                               |
| **Serverless / FaaS**             | `1–3`                                                            | Many short-lived processes; keep pools tiny. Use a connection pooler in front (PgBouncer transaction mode, Supavisor, Neon pooler).        |

Worked example — Railway Hobby (6 replicas, 8 workers each, Postgres `max_connections=100`):

```
DB_POOL_MAX = floor(100 / 8 / 6) - 1 = 1  →  set DB_POOL_MAX=2 with some headroom
```

#### Benchmark evidence

The default `DB_POOL_MAX=10` causes a measurable latency cliff under high load — see [benchmarks.md](benchmarks.md). Average request duration jumps from 4.17ms (1,402 req/s) to 205ms (1,304 req/s) between medium and high load: pool exhaustion forces requests to queue behind the 10 in-flight connections. Sizing per the table above pushes the cliff out, and `DB_QUERY_TIMEOUT_MS` provides a hard backstop so a single slow query cannot exhaust the pool indefinitely.

#### Observability

- `GET /health/ready` returns `checks.pool = { status, total, idle, waiting, max, utilization, threshold }`. `status: 'warning'` when utilization ≥ 80% but the pool can still serve a request (≥ 1 idle slot, or pool not yet at max). `status: 'error'` (and 503 + `Retry-After: 5`) when fully saturated: `idle === 0 && total >= max && waiting > 0`. The probe itself runs `SELECT 1` against a **dedicated single-connection pool** (`DB_PROBE_TIMEOUT_MS`-bounded, default 1s) so probe latency is independent of application pool state — it never queues behind real traffic and never consumes an application-pool slot.
- `GET /metrics` exposes `db_pool_total_connections`, `db_pool_idle_connections`, `db_pool_waiting_clients`, and `db_pool_max_connections` Prometheus gauges (scrape-time reads of live pool state).
- In production, a snapshot is logged every 5 minutes — `level=warn` if utilization > 80%, `level=info` otherwise — so log-aggregator alerts work without a Prometheus alertmanager.

### Redis

| Variable    | Type   | Default     | Description                                                                                                            |
| ----------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | String | `undefined` | Optional Redis URL. Enables distributed rate limiting across multiple instances. Falls back to in-memory when not set. |

### Cluster

| Variable          | Type   | Default | Description                                                                                                              |
| ----------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `CLUSTER_WORKERS` | Number | `1`     | Number of worker processes. `1` = single process (no clustering), `0` = auto-detect CPU count, `N` = exact worker count. |

When clustering is enabled, each worker maintains its own database connection pool. Adjust `DB_POOL_MAX` accordingly — see [Database Pool → Sizing recommendations](#sizing-recommendations).

### Metrics

| Variable             | Type    | Default     | Description                                                                                                                                                                                                                                              |
| -------------------- | ------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_TOKEN`      | String  | `undefined` | Optional bearer token to protect `GET /metrics`. When set, requests must include `Authorization: Bearer <token>` (header-only — query-string `?token=` is **not** accepted, to avoid leaking the secret into access/proxy logs). Required in production. |
| `DISABLE_DB_METRICS` | Boolean | `false`     | When `true`, disables Prisma query-duration instrumentation (`dbQueryDuration`). Use for benchmarks to avoid per-query timer overhead.                                                                                                                   |

**Generating a production token**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the value in your secrets manager (see `#7.5` in `ROADMAP.md`) and inject it into the runtime — never commit it to `.env`.

### Rate Limiting

| Variable             | Type    | Default | Description                                                         |
| -------------------- | ------- | ------- | ------------------------------------------------------------------- |
| `DISABLE_RATE_LIMIT` | Boolean | `false` | Disables all rate limiters. Use when running load tests/benchmarks. |

All rate limiters (`auth`, `write`, `read`, `global`, `register`, `health`) emit the IETF `draft-7` `RateLimit-*` response headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on 429s). Legacy `X-RateLimit-*` headers are not emitted.

The `/health/ready` endpoint is rate-limited at **60 requests/minute/IP** (`healthLimiter`). This is generous enough for typical ALB/K8s probes (5–30s intervals) but blocks abuse of the `SELECT 1` round-trip against the database.

### Debug & Benchmark Routes

| Variable             | Type    | Default                              | Description                                                                                                                                                                                                                                            |
| -------------------- | ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ENABLE_ECHO_ROUTES` | Boolean | `true` in non-prod, `false` in prod  | Mount the `/echo` benchmark routes. `/echo` bypasses logging, rate limiting, and JSON parsing, so it must only be reachable on a benchmark process. The default mirrors `NODE_ENV` so production processes hide it unless this flag is explicitly set. |

See [benchmarks.md → Rate Limiting](benchmarks.md#rate-limiting) for the flag combination required when benchmarking against a production-mode process.

### HTTP Request Body

| Variable     | Type   | Default  | Description                                                                                                                                         |
| ------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BODY_LIMIT` | String | `"16kb"` | Maximum JSON request body size, as a bytes string (e.g. `"16kb"`, `"1mb"`). Requests exceeding the limit are rejected with `413 Payload Too Large`. |

### HTTP Server Timeouts

| Variable                       | Type   | Default | Description                                                                                                                   |
| ------------------------------ | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_HEADERS_TIMEOUT_MS`    | Number | `60000` | ms for the server to receive full HTTP request headers. Should exceed load balancer idle timeout.                             |
| `SERVER_REQUEST_TIMEOUT_MS`    | Number | `30000` | ms for the server to receive the full HTTP request body.                                                                      |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS` | Number | `65000` | ms to keep idle keep-alive connections open. Must exceed load balancer idle timeout (typically 60s) to avoid mid-flight 502s. |

## CORS

The API supports Cross-Origin Resource Sharing (CORS) to allow frontend applications from different origins to access the API.

### Variables

| Variable               | Type    | Default                          | Description                                                                                                                                                                                                                 |
| ---------------------- | ------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGIN`          | String  | `*`                              | Comma-separated list of allowed origins. Use `*` to allow any origin.                                                                                                                                                       |
| `CORS_CREDENTIALS`     | String  | `false`                          | Set to `true` to allow cookies and authorization headers.                                                                                                                                                                   |
| `CORS_METHODS`         | String  | `GET,HEAD,PUT,PATCH,POST,DELETE` | HTTP methods allowed in CORS requests.                                                                                                                                                                                      |
| `CORS_HEADERS`         | String  | `Content-Type,Authorization`     | HTTP headers allowed in CORS requests.                                                                                                                                                                                      |
| `CORS_MAX_AGE`         | String  | `86400`                          | How long preflight request results are cached (in seconds).                                                                                                                                                                 |
| `CORS_ALLOW_NO_ORIGIN` | Boolean | `true`                           | Whether to accept requests without an `Origin` header (server-to-server, mobile apps, `curl`, Postman). Set to `false` in browser-only deployments to require an explicit, allow-listed origin. No-op when `CORS_ORIGIN=*`. |

### Example Configurations

**Development (allow local frontend):**

```env
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
```

**Production (specific domains):**

```env
CORS_ORIGIN=https://app.example.com,https://admin.example.com
```

**Allow all origins (not recommended for production):**

```env
CORS_ORIGIN=*
```

**With credentials (cookies, auth headers):**

```env
CORS_ORIGIN=https://app.example.com
CORS_CREDENTIALS=true
```

### Important Notes

- When using `CORS_CREDENTIALS=true`, you **cannot** use `CORS_ORIGIN=*` due to browser security restrictions.
- Health check endpoints (`/health`, `/health/ready`) also include CORS headers for external monitoring tools.
- Preflight OPTIONS requests are automatically handled by the cors middleware.

## Health Check Thresholds

The `/health/ready` endpoint returns HTTP 503 only when a **binding constraint** trips: the database is unreachable, or the connection pool is saturated. Memory and CPU are reported as observational sub-checks — they can flip a sub-check to `warning` but never to `error`, and never affect the overall readiness verdict. Thresholds are hardcoded in `routes/health.ts` (kept as constants rather than env vars to discourage per-deploy variance in what "healthy" means).

| Check    | Threshold                                                      | Sub-check status on breach | Affects readiness? | Source                                    |
| -------- | -------------------------------------------------------------- | -------------------------- | ------------------ | ----------------------------------------- |
| Database | `SELECT 1` round-trip succeeds                                 | `error`                    | **Yes (503)**      | `probeDatabase()` (dedicated probe pool)  |
| DB Pool  | `idle === 0` AND `total >= max` AND `waiting > 0` (saturation) | `error`                    | **Yes (503)**      | `pg.Pool` counters via `getPoolMetrics()` |
| DB Pool  | Utilization ≥ 80% but not saturated                            | `warning`                  | No                 | `pg.Pool` counters via `getPoolMetrics()` |
| Memory   | Heap usage < 90% of `heapTotal`                                | `warning`                  | No                 | `process.memoryUsage()`                   |
| CPU      | 1-minute load average < `os.cpus().length`                     | `warning`                  | No                 | `os.loadavg()` + `os.cpus()`              |

The CPU threshold uses the system's reported CPU count, so it scales with the deployment shape (single vs. multi-core, dedicated vs. shared). The memory threshold of 90% leaves a 10% headroom before the V8 heap typically starts thrashing the GC.

The DB reachability check runs against a **dedicated single-connection probe pool** so probe latency is independent of application pool state (see [Database Pool → Observability](#observability)). 503 responses include a `Retry-After` header: `5` seconds for pool saturation (drains as queries complete) and `30` seconds for an unreachable database. See [api.md → GET /health/ready](api.md#get-healthready) for full response shapes.

## Security Headers & Proxy Trust

The application wires the following defenses in `app.ts`:

- **Helmet** (`helmet()` with defaults) sets the full hardening header set: `Strict-Transport-Security` (HSTS, `max-age=15552000; includeSubDomains`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and a strict `Content-Security-Policy`. HSTS only takes effect over HTTPS, so it is a no-op in local development and relies on the load balancer terminating TLS in front of the API in production.
- **`trust proxy = 1`** trusts one upstream proxy hop (ALB / ingress). Required for `req.ip` to reflect the real client IP rather than the proxy, so per-client rate limiting and audit log `sourceIp` are correct.
- **Echo endpoint (`/echo`)** is gated by `ENABLE_ECHO_ROUTES`, which defaults to `true` in non-production and `false` in production. The endpoint bypasses logging, rate limiting, and JSON parsing, so it must only ever be reachable on a dedicated benchmark process — never on a production instance serving real traffic. See [Debug & Benchmark Routes](#debug--benchmark-routes).

## Full `.env` Example

```env
# Application
NODE_ENV=development
PORT=3001

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/todo-api

# JWT (minimum 32 characters — server fails to start otherwise)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# HTTP Request Body Limit
BODY_LIMIT=16kb

# CORS
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
CORS_CREDENTIALS=false
CORS_METHODS=GET,HEAD,PUT,PATCH,POST,DELETE
CORS_HEADERS=Content-Type,Authorization
CORS_MAX_AGE=86400
CORS_ALLOW_NO_ORIGIN=true

# Logging
LOG_LEVEL=debug

# Shutdown
SHUTDOWN_DELAY_MS=5000
SHUTDOWN_TIMEOUT_MS=10000

# Database Pool
DB_POOL_MAX=10
DB_POOL_MIN=2
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=10000

# Redis (optional)
# REDIS_URL=redis://localhost:6379

# Cluster (optional)
# CLUSTER_WORKERS=0  # 0 = auto-detect CPU count

# Metrics (optional)
# METRICS_TOKEN=     # Bearer token to protect GET /metrics
# DISABLE_DB_METRICS=false # Set true when running benchmarks

# Rate Limiting
DISABLE_RATE_LIMIT=false

# Debug & Benchmark Routes
# ENABLE_ECHO_ROUTES=    # Defaults to NODE_ENV !== 'production'; set true to expose /echo on a prod-mode benchmark process

# HTTP Server Timeouts
# SERVER_HEADERS_TIMEOUT_MS=60000
# SERVER_REQUEST_TIMEOUT_MS=30000
# SERVER_KEEP_ALIVE_TIMEOUT_MS=65000
```

See `.env.example` in the project root for a ready-to-copy template.
