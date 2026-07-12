# Configuration

This guide covers all environment variables, validation behavior, and CORS setup.

## Environment Variable Validation

The application uses `envalid` to validate all environment variables at startup, ensuring the server won't start with missing or invalid configuration.

- Type validation (PORT must be valid port number, DATABASE_URL must be valid PostgreSQL connection string)
- Required vs. optional variable enforcement
- Clear error messages with examples for misconfigured values
- Prevents runtime failures due to configuration issues

**Implementation**: See `src/config/env.ts` for the validation schema and `.env.example` for a template.

## Required Variables

| Variable                     | Type   | Description                                                                                                                                                                                             | Example                                                      |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`               | URL    | PostgreSQL connection string for the runtime app role (`db_app`). The audit-log REVOKE depends on this not being a superuser.                                                                           | `postgresql://db_app:db_app_dev@localhost:5432/todo_api`     |
| `DATABASE_MIGRATE_URL`       | URL    | Optional admin DSN used **only** by `prisma migrate deploy` (`db_admin` — owns the schema, runs DDL + GRANT/REVOKE). Falls back to `DATABASE_URL` if unset.                                             | `postgresql://db_admin:db_admin_dev@localhost:5432/todo_api` |
| `JWT_SECRET`                 | String | Secret key for JWT tokens. **Minimum 32 characters** — the server fails fast at startup if this is shorter.                                                                                             | `your-super-secret-jwt-key-min-32-chars`                     |
| `ENCRYPTION_KEYRING`         | String | Comma-separated `<keyId>:<base64-32-byte-key>` entries for field encryption. New writes use `ENCRYPTION_ACTIVE_KEY_ID`; keep retired keys here until re-encryption drains them. Malformed → boot fails. | `k1:BASE64_32_BYTE_KEY,k2:BASE64_32_BYTE_KEY`                |
| `ENCRYPTION_ACTIVE_KEY_ID`   | String | keyId (must exist in `ENCRYPTION_KEYRING`) used to encrypt new values.                                                                                                                                  | `k1`                                                         |
| `ENCRYPTION_BLIND_INDEX_KEY` | String | base64-encoded 32-byte HMAC key for the email blind index (lookup/uniqueness). Rotating it requires re-hashing every row — see [operations.md](operations.md).                                          | `BASE64_32_BYTE_KEY`                                         |

### Database roles

Audit-log immutability requires three Postgres roles so SOC 2 tamper-evidence (CC7.2 / CC7.4) is enforced at the DB layer, not just the app:

| Role         | Connect via               | What it can do                                                                                                                                   |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db_admin`   | `DATABASE_MIGRATE_URL`    | Owns the `public` schema; CREATE/ALTER/DROP and GRANT/REVOKE. Used only by `prisma migrate deploy`.                                              |
| `db_app`     | `DATABASE_URL`            | Runtime CRUD on app tables; `INSERT` + `SELECT` on `audit_entries` (UPDATE/DELETE/TRUNCATE are REVOKED so an app-layer compromise can't tamper). |
| `db_auditor` | external auditor sessions | `SELECT` on `audit_entries` only.                                                                                                                |

Roles are created by `prisma/sql/bootstrap_roles.sql`. The Docker Compose Postgres service mounts this file into `/docker-entrypoint-initdb.d/`, so a fresh `docker compose up` provisions everything. CI runs the same file via `psql`. Production (Railway) is bootstrapped once with [`prisma/sql/bootstrap_roles_prod.sql`](../prisma/sql/bootstrap_roles_prod.sql) — run as a superuser before the first `prisma migrate deploy` (it takes the role passwords as `psql -v` variables and is idempotent / safe to re-run). A deploy preflight check ([`scripts/preflight-roles.ts`](../scripts/preflight-roles.ts)) runs as part of the Railway pre-deploy command (`railway.json`) and fails the deploy fast with a clear message if the roles are missing, rather than letting the migration crash-loop; transient connection failures are retried with the same `DB_CONNECT_MAX_RETRIES` / `DB_CONNECT_INITIAL_DELAY_MS` / `DB_CONNECTION_TIMEOUT_MS` knobs as the app's startup retry (read leniently, no envalid). See [operations.md](operations.md).

Generate a secure JWT secret for production:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Encryption at rest

Three layers protect confidential data at rest (SOC 2 CC6.1 / C1.1):

1. **Database volume** — the production database runs on a Railway-managed volume; Railway encrypts volume storage at rest at the platform layer. Transparent Data Encryption (TDE) is **not** available on the self-hosted `timescale/timescaledb` image (community PostgreSQL has no built-in TDE), so this platform-managed encryption plus the application-layer field encryption below are the controls of record.
2. **Backups** — pgBackRest encrypts every base backup and archived WAL segment client-side with AES-256-CBC (`PGBACKREST_CIPHER_PASS`) before it lands in the Railway Bucket. See [Database Backups](#database-backups-pgbackrest).
3. **Application-layer field encryption** — the `users.email` PII column is encrypted by the app, not stored in plaintext.

**How field encryption works** (`src/lib/crypto/`):

- `email` stores an **AES-256-GCM** ciphertext envelope: `enc:1:<keyId>:<iv>:<tag>:<ciphertext>` (all base64). The `enc:1:` prefix versions the scheme and lets a mixed plaintext/ciphertext table be read during a backfill.
- Because GCM is randomized, the ciphertext can't back a `UNIQUE` constraint or an equality lookup. A second column, `email_hash`, holds a **keyed HMAC-SHA256 blind index** over the canonical (NFC + lowercase + trim) email. It carries the unique constraint and every `findByEmail` lookup — keyed (not a bare hash) so the column is not an offline-enumerable oracle.
- Keys are supplied as env vars (Railway per-environment secrets) — the same trust model as `JWT_SECRET` and `PGBACKREST_CIPHER_PASS` — behind a `KeyProvider` interface so a managed KMS can be adopted later without touching call sites. Generate a key with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

- **Production refuses to boot** on the committed dev placeholder key (32 zero bytes) — `assertProductionEnv()` in `src/config/env.ts` rejects it. A malformed keyring or an `ENCRYPTION_ACTIVE_KEY_ID` absent from the ring also fails fast at startup.

Key custody, rotation procedures, and the read-side audit (CC6.2) gap versus a managed KMS are documented in [operations.md → Field encryption key management & rotation](operations.md#field-encryption-key-management--rotation).

## Database Backups (pgBackRest)

These variables configure pgBackRest, which runs **co-located in the `timescaledb` service container**
(not the app). They are **not** read by `src/config/env.ts` — set them on the timescaledb Railway
service. Locally, `docker-compose.yml` sets a POSIX repo so no S3 credentials are needed. Design and
build details: [pgbackrest-implementation.md](pgbackrest-implementation.md).

| Variable                        | Default                        | Description                                                                                                                                  |
| ------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGBACKREST_REPO_TYPE`          | `s3`                           | `s3` (prod) or `posix` (local)                                                                                                               |
| `PGBACKREST_REPO_S3_ENDPOINT`   | _(required for s3)_            | Railway Bucket S3 endpoint URL                                                                                                               |
| `PGBACKREST_REPO_S3_BUCKET`     | _(required for s3)_            | Bucket name                                                                                                                                  |
| `PGBACKREST_REPO_S3_KEY`        | _(required for s3)_            | Access key ID                                                                                                                                |
| `PGBACKREST_REPO_S3_KEY_SECRET` | _(required for s3)_            | Secret access key                                                                                                                            |
| `PGBACKREST_REPO_S3_REGION`     | `auto`                         | S3 region                                                                                                                                    |
| `PGBACKREST_REPO_PATH`          | `/var/lib/pgbackrest`          | POSIX repo path (local only)                                                                                                                 |
| `PGBACKREST_CIPHER_PASS`        | _(required)_                   | AES-256 passphrase (32+ chars)                                                                                                               |
| `PGBACKREST_STANZA`             | `todo-api`                     | Stanza name                                                                                                                                  |
| `PGBACKREST_PG1_USER`           | `$POSTGRES_USER` or `postgres` | DB role pgBackRest connects as (cluster superuser); lets root-invoked ops commands work                                                      |
| `PGBACKREST_RETENTION_FULL`     | `35`                           | Daily full backups to retain (≈ PITR window in days)                                                                                         |
| `PGBACKREST_RETENTION_DIFF`     | `14`                           | Differentials to retain                                                                                                                      |
| `PGBACKREST_RETENTION_ARCHIVE`  | `35`                           | Fulls' worth of WAL to retain                                                                                                                |
| `PGBACKREST_PROCESS_MAX`        | `2`                            | Parallel processes for backup/restore                                                                                                        |
| `PGBACKREST_FULL_HOUR_UTC`      | `2`                            | UTC hour for the daily full window                                                                                                           |
| `PGBACKREST_FULL_MAX_AGE_SEC`   | `93600`                        | Hard catch-up ceiling for the daily full (26h) — runs regardless of window once the last full is this old; keep below the 30h full-age alert |
| `PGBACKREST_DIFF_INTERVAL_SEC`  | `21600`                        | Differential interval (seconds)                                                                                                              |
| `PGBACKREST_LOOP_SLEEP_SEC`     | `60`                           | Scheduler check interval (seconds)                                                                                                           |
| `PGBACKREST_RESTORE`            | `0`                            | `1` = restore into PGDATA before Postgres starts (DR only — see [operations.md](operations.md))                                              |
| `PGBACKREST_RESTORE_ARGS`       | _(empty)_                      | Extra restore flags, e.g. `--type=time --target=...`, `--delta`                                                                              |

## Secrets access policy

SOC 2 CC6.1 requires documented, least-privilege key management. This is the access policy for the
platform's secrets.

**Where secrets live.** Production and staging secrets are stored as **Railway per-environment
variables**, encrypted at rest and scoped per environment (`staging` / `production`) — a staging
credential cannot read production data. `DATABASE_URL` is injected from Railway's managed Postgres
reference variable. Deploy tokens (`RAILWAY_TOKEN`) live as **GitHub Environment secrets**, one per
environment, gated by the `production` environment's required-reviewer rule. Nothing sensitive is
committed: `.env*` is gitignored (only `.env.example` / `.env.test` placeholders are tracked), and a
[gitleaks CI job](../.github/workflows/ci.yml) fails the build if a credential is ever committed.

**Inventory of secrets and who may read them.**

| Secret                                                            | Store                        | Who can read                                                        |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `JWT_SECRET` (+ `JWT_SECRET_PREVIOUS` during rotation)            | Railway per-env variable     | The running app service; project members with Railway secret access |
| `DATABASE_URL` / `DATABASE_MIGRATE_URL`                           | Railway managed reference    | The app / migration step; project members with Railway access       |
| `ENCRYPTION_KEYRING`, `ENCRYPTION_ACTIVE_KEY_ID`, `..._BLIND_INDEX_KEY` | Railway per-env variable | The running app service; project members with Railway secret access |
| `METRICS_TOKEN`                                                   | Railway per-env variable     | The app; operators scraping `/metrics`                              |
| `PGBACKREST_CIPHER_PASS` + S3 keys                               | Railway (timescaledb service) | The DB container; project members with Railway access               |
| `RAILWAY_TOKEN` (staging / production)                            | GitHub Environment secret    | The deploy workflow only; production gated by required reviewer      |
| `CODECOV_TOKEN`                                                   | GitHub Actions secret        | CI only                                                             |

**Least privilege.** Application code connects as the restricted `db_app` role (no
UPDATE/DELETE/TRUNCATE on `audit_entries`); only the `db_admin` role used by `prisma migrate deploy`
can run DDL. See [Database roles](#database-roles). Secrets are referenced indirectly by the runtime
(env vars pulled at boot), never baked into the deploy artifact.

**Granting / revoking access.** Access is granted by adding a member to the Railway project (for
runtime/DB secrets) or the GitHub repo/environment (for deploy secrets), and revoked by removing them.
Rotate any secret the departing member could read — at minimum `JWT_SECRET` (see
[operations.md → JWT secret rotation](operations.md#jwt-secret-rotation)) and the DB role passwords.
Review the member list and key access **quarterly** alongside the restore-drill cadence.

> **CC6.2 read-side-audit gap (accepted).** Railway env-var stores gate and encrypt secrets but do not
> log _who read a secret and when_. A managed KMS (AWS Secrets Manager, Vault) would close this; it is
> deferred, and the `KeyProvider` interface keeps that migration cheap. Tracked under the Secrets
> Management roadmap item.

## Optional Variables

### Application

| Variable      | Type   | Default       | Description                                                                                                                                                               |
| ------------- | ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`        | Port   | `3001`        | Server port number                                                                                                                                                        |
| `NODE_ENV`    | String | `development` | Environment (development/production/test)                                                                                                                                 |
| `TRUST_PROXY` | Number | `1`           | Trusted proxy hop count (Express `trust proxy`). Railway / single LB = `1`; add one per extra fronting proxy. Too high lets clients spoof `req.ip` via `X-Forwarded-For`. |

### Authentication

| Variable                    | Type   | Default            | Description                                                                                                                                                              |
| --------------------------- | ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ISSUER`                | String | `todo-api`         | JWT `iss` claim. Set the same value on the sign and verify sides.                                                                                                       |
| `JWT_SECRET_PREVIOUS`       | String | _(unset)_          | Previous signing secret, accepted on **verify only** during a rotation window so in-flight tokens survive the cutover. **Minimum 32 chars** when set. Clear it after `ACCESS_TOKEN_EXPIRY` elapses. See [operations.md → JWT secret rotation](operations.md#jwt-secret-rotation). |
| `JWT_AUDIENCE`              | String | `todo-api-clients` | JWT `aud` claim. Set the same value on the sign and verify sides.                                                                                                       |
| `ACCESS_TOKEN_EXPIRY`       | String | `15m`              | Access-token lifetime (`jsonwebtoken` `expiresIn`, e.g. `15m`, `1h`). Kept short because stateless JWTs cannot be individually revoked — refresh tokens cover sessions. |
| `REFRESH_TOKEN_EXPIRY_DAYS` | Number | `30`               | Refresh-token lifetime in days. Refresh tokens rotate on every `POST /auth/refresh`; this absolute cap bounds a stolen-but-unused token.                                |

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

| Variable                      | Type   | Default | Description                                                                                                                                |
| ----------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DB_POOL_MAX`                 | Number | `10`    | Max connections per instance                                                                                                               |
| `DB_POOL_MIN`                 | Number | `2`     | Min idle connections to keep warm                                                                                                          |
| `DB_CONNECTION_TIMEOUT_MS`    | Number | `5000`  | ms to wait for a free pool connection                                                                                                      |
| `DB_IDLE_TIMEOUT_MS`          | Number | `10000` | ms before an idle connection is released                                                                                                   |
| `DB_QUERY_TIMEOUT_MS`         | Number | `5000`  | ms a single query may run before the connection is killed and returned to the pool                                                         |
| `DB_PROBE_TIMEOUT_MS`         | Number | `1000`  | ms ceiling for the readiness probe's `SELECT 1` (runs on a dedicated single-connection pool, not the application pool — see Observability) |
| `DB_CONNECT_MAX_RETRIES`      | Number | `5`     | Retries after the initial `$connect` at startup before giving up. `0` disables retry (fail fast)                                           |
| `DB_CONNECT_INITIAL_DELAY_MS` | Number | `1000`  | Base delay (ms) for the first startup-connect retry; subsequent delays use decorrelated jitter capped at 30 s                              |

#### Startup connection retry

The initial `prisma.$connect()` at boot is retried with **decorrelated jitter** (AWS SDK style): `delay_n = random(base, min(30s, delay_{n-1} * 3))`. This survives a transient database blip during container startup (network jitter, brief DB maintenance, replica failover) without crashing the process into a `CrashLoopBackOff` against the same root cause. After `DB_CONNECT_MAX_RETRIES + 1` total attempts the last error is re-thrown, the fatal handler logs it, and the orchestrator can take it from there. Set `DB_CONNECT_MAX_RETRIES=0` to skip retry and fail fast — useful in CI where a missing database should be loud. The deploy preflight (`scripts/preflight-roles.ts`) reads the same three knobs directly from env (leniently — unparseable values fall back to the defaults) with its jitter capped at 15 s instead of 30 s.

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

The sizing math above only counts **app-side** consumers. Off-app pools eat the same budget and are easy to forget:

- `prisma migrate deploy` at boot (`db_admin`) — one short-lived connection per replica.
- `pnpm run bench:seed` and other local scripts pointed at the same DB — each spins up its own pg pool (default `max=10`).
- `psql` sessions for ops/debug.
- pgAdmin, Metabase, or any BI tool connected to the same DB.
- Managed-DB extras: Railway, RDS, etc. reserve some slots for `superuser_reserved_connections` (default `3`) plus internal monitoring. **Your usable ceiling is `max_connections − superuser_reserved_connections − platform_overhead`, not `max_connections`.**

#### Diagnostics

When the sizing math is wrong, the symptom is fast 500s under load with this Pino-serialized error:

```
PrismaClientKnownRequestError: Too many database connections opened: remaining
connection slots are reserved for roles with the SUPERUSER attribute
  code: P2037
  meta.driverAdapterError.cause.originalCode: 53300  (Postgres TOO_MANY_CONNECTIONS)
```

Failures are fast (<10ms) because the adapter rejects at `connect()`, not after query work. `db_pool_waiting_clients` stays at `0` — connections are being **refused**, not queued — so the app-side pool metrics can look healthy while the DB is the bottleneck. The signal is the rejected-503-rate, not pool utilization.

To inspect the live state, connect as the platform superuser and run:

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SELECT usename, count(*), state
FROM pg_stat_activity
GROUP BY usename, state
ORDER BY count(*) DESC;
```

The `usename` breakdown tells you which role is over-consuming. Typical fixes, in order of effort: drop `DB_POOL_MAX`, close orphaned `psql` / BI sessions, scale the DB plan, or front Postgres with PgBouncer (transaction mode) so each replica's pool size becomes a logical, not physical, limit.

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

| Variable             | Type    | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_TOKEN`      | String  | `undefined` | Bearer token to protect `GET /metrics`. When set, requests must include `Authorization: Bearer <token>` (header-only — query-string `?token=` is **not** accepted, to avoid leaking the secret into access/proxy logs). **Required in production** — startup aborts if `NODE_ENV=production` and this is unset or shorter than 32 characters. The comparison is constant-time (`crypto.timingSafeEqual`). |
| `DISABLE_DB_METRICS` | Boolean | `false`     | When `true`, disables Prisma query-duration instrumentation (`dbQueryDuration`). Use for benchmarks to avoid per-query timer overhead.                                                                                                                                                                                                                                                                    |

**Generating a production token**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the value in your secrets manager (see `#7.5` in `ROADMAP.md`) and inject it into the runtime — never commit it to `.env`.

### Rate Limiting

| Variable             | Type    | Default | Description                                                                                                                                                 |
| -------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISABLE_RATE_LIMIT` | Boolean | `false` | Disables all rate limiters. Use when running load tests/benchmarks. **Refused in production** — startup aborts if this is `true` and `NODE_ENV=production`. |

All rate limiters (`auth`, `write`, `read`, `global`, `register`, `health`) emit the IETF `draft-7` `RateLimit-*` response headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on 429s). Legacy `X-RateLimit-*` headers are not emitted.

The `/health/ready` endpoint is rate-limited at **60 requests/minute/IP** (`healthLimiter`). This is generous enough for typical ALB/K8s probes (5–30s intervals) but blocks abuse of the `SELECT 1` round-trip against the database.

### Debug & Benchmark Routes

| Variable             | Type    | Default                             | Description                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_ECHO_ROUTES` | Boolean | `true` in non-prod, `false` in prod | Mount the `/echo` benchmark routes. `/echo` bypasses logging and rate limiting. JSON body parsing now honors `BODY_LIMIT` (was: 100kb library default). The default mirrors `NODE_ENV` so production processes hide it unless this flag is explicitly set. If set true in production, startup logs a loud `WARNING` — intended only for dedicated benchmark processes. |

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

The `/health/ready` endpoint returns HTTP 503 only when a **binding constraint** trips: the database is unreachable, or the connection pool is saturated. Memory and CPU are reported as observational sub-checks — they can flip a sub-check to `warning` but never to `error`, and never affect the overall readiness verdict. Thresholds are hardcoded in `src/routes/health.ts` (kept as constants rather than env vars to discourage per-deploy variance in what "healthy" means).

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

The application wires the following defenses in `src/app.ts`:

- **Helmet** (`helmet()` with defaults) sets the full hardening header set: `Strict-Transport-Security` (HSTS, `max-age=15552000; includeSubDomains`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and a strict `Content-Security-Policy`. HSTS only takes effect over HTTPS, so it is a no-op in local development and relies on the load balancer terminating TLS in front of the API in production.
- **`trust proxy = 1`** trusts one upstream proxy hop (ALB / ingress). Required for `req.ip` to reflect the real client IP rather than the proxy, so per-client rate limiting and audit log `sourceIp` are correct.
- **Echo endpoint (`/echo`)** is gated by `ENABLE_ECHO_ROUTES`, which defaults to `true` in non-production and `false` in production. The endpoint bypasses logging and rate limiting (JSON parsing now honours `BODY_LIMIT`), so it must only ever be reachable on a dedicated benchmark process — never on a production instance serving real traffic. To enable in production, pair `ENABLE_ECHO_ROUTES=true` with `ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM=true`; either flag alone aborts startup. See [Debug & Benchmark Routes](#debug--benchmark-routes).
- **Readiness probe (`/health/ready`)** is split into a public lean shape (`{ status, timestamp }`) and an authenticated `/health/ready/detailed` route gated by the `METRICS_TOKEN` bearer token. Orchestrators probe the lean path (200/503 + `Retry-After`); operators and dashboards hit `/detailed` for pool/memory/CPU internals. Splitting denies unauthenticated callers the recon signal previously available for DoS targeting. See [API Reference — Health Check](api.md#health-check).

## Full `.env` Example

```env
# Application
NODE_ENV=development
PORT=3001

# Database (db_app for runtime, db_admin for migrations)
DATABASE_URL=postgresql://db_app:db_app_dev@localhost:5432/todo_api
DATABASE_MIGRATE_URL=postgresql://db_admin:db_admin_dev@localhost:5432/todo_api

# JWT (minimum 32 characters — server fails to start otherwise)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
# ACCESS_TOKEN_EXPIRY=15m       # Access-token lifetime. Keep short.
# REFRESH_TOKEN_EXPIRY_DAYS=30  # Refresh-token lifetime in days (rotated on every /auth/refresh).

# Field-level encryption (users.email). Placeholders below are 32 zero bytes —
# production refuses to boot on them. Generate real keys:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEYRING=k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
ENCRYPTION_ACTIVE_KEY_ID=k1
ENCRYPTION_BLIND_INDEX_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=

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
# DB_CONNECT_MAX_RETRIES=5         # Retries on the initial $connect; 0 disables
# DB_CONNECT_INITIAL_DELAY_MS=1000 # Base delay (ms) for the first retry

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
