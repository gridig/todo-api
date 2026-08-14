# Todo API

A production-ready RESTful API for managing todos with user authentication, built with TypeScript, Node.js, Express, and PostgreSQL. Features high test coverage, robust security measures, and modern architectural patterns. Internal use; package manager: **pnpm**.

## Quickstart

From a clean checkout, with Node.js 24+ and PostgreSQL available:

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` to set `JWT_SECRET` (32+ chars) and the two database URLs. The runtime app uses `db_app`; migrations use the schema-owning `db_admin` role so it can run DDL and the `REVOKE` that makes `audit_entries` append-only:

   ```env
   DATABASE_URL="postgresql://db_app:db_app_dev@localhost:5432/todo_api"
   DATABASE_MIGRATE_URL="postgresql://db_admin:db_admin_dev@localhost:5432/todo_api"
   JWT_SECRET=your-super-secret-key-min-32-chars
   ```

   The three roles (`db_admin`, `db_app`, `db_auditor`) are created by `prisma/sql/bootstrap_roles.sql`, which runs automatically the first time the Docker Compose Postgres volume initialises. See [`docs/configuration.md`](docs/configuration.md#database-roles) for the role model.

   > **Note:** `.env.example` ships with `NODE_ENV=development` and dev placeholder keys so the quickstart boots as-is. Production deployments additionally require `METRICS_TOKEN` (32+ chars) and real `ENCRYPTION_*` keys — `NODE_ENV=production` enforces both at startup.

3. **Create database and run migrations**

   Start Postgres (Docker Compose mounts `bootstrap_roles.sql` into `/docker-entrypoint-initdb.d/` so a fresh volume provisions the three roles automatically), then apply migrations:

   ```bash
   docker compose up -d postgres
   pnpm exec prisma migrate deploy
   ```

   `prisma.config.ts` picks `DATABASE_MIGRATE_URL` if set, falling back to `DATABASE_URL`. For an existing dev DB where tables are already owned by the superuser, `docker compose down -v` first so the volume re-initialises against the bootstrap script.

4. **Start the API**
   ```bash
   pnpm run dev
   ```
   API runs at `http://localhost:3001`. Use the [Quick Start Example](#quick-start-example) below to register, login, and call todo endpoints.

### Quick Start Example

```bash
# Register a new user
curl -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"SecurePass123!"}'

# Response: {"token":"eyJhbGc...","refreshToken":"..."}
# The access token is short-lived (15m); use POST /auth/refresh with the
# refreshToken to rotate it, and /auth/logout[-all] to revoke.

# Login
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"SecurePass123!"}'

# Create a todo (replace TOKEN with your JWT)
curl -X POST http://localhost:3001/todos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"text":"Buy groceries"}'

# Get all todos
curl http://localhost:3001/todos \
  -H "Authorization: Bearer TOKEN"
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Application                       │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTP/HTTPS
┌────────────────────────────────▼────────────────────────────────┐
│                    Express Server  (index.ts)                   │
├─────────────────────────────────────────────────────────────────┤
│  Middleware pipeline (applied in order):                        │
│    1 Trust Proxy     2 Helmet          3 Request ID             │
│    4 Request Context 5 Metrics         6 /echo (benchmark)      │
│    7 Request Logger  8 CORS            9 /health (ready 60/min) │
│   10 /metrics (token) 11 Rate Limiter 12 JSON Body Parser       │
│   13 Route Handlers (per-route auth · validation · limits)      │
│   14 404 Handler    15 Error Handler                            │
└────────────────────────────────┬────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────┐
│                          Routes Layer                           │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐   public / token-gated │
│   │ /health  │ │ /metrics │ │  /auth   │                        │
│   └──────────┘ └──────────┘ └──────────┘                        │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐   JWT-protected        │
│   │  /todos  │ │  /user   │ │  /admin  │   (/admin: admin role) │
│   └──────────┘ └──────────┘ └──────────┘                        │
│   /health → liveness (/) + readiness (/ready, probes Postgres)  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────┐
│                          Models Layer                           │
│       ┌─────────┐    ┌─────────┐    ┌──────────────────┐        │
│       │ User.ts │    │ Todo.ts │    │ RefreshToken.ts  │        │
│       └─────────┘    └─────────┘    └──────────────────┘        │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                        ┌────────▼────────┐
                        │   Prisma (ORM)  │
                        └────────┬────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────┐
│                     PostgreSQL (TimescaleDB)                    │
│   users (email encrypted) · todos · refresh_tokens              │
│   audit_entries hypertable:                                     │
│     INSERT/SELECT for db_app · UPDATE/DELETE REVOKEd            │
│     SELECT for db_auditor                                       │
└─────────────────────────────────────────────────────────────────┘

Key Components:
• Config (env.ts): Environment variable validation; two DSNs (DATABASE_URL → db_app, DATABASE_MIGRATE_URL → db_admin)
• Errors: Custom error classes (AppError, AuthError, ValidationError, ForbiddenError, UserNotFoundError, etc.)
• Logging: Structured JSON logs (Pino) with request correlation
• Auth: short-lived access JWTs + rotating refresh tokens with reuse/theft detection (lib/tokens.ts, models/RefreshToken.ts, routes/auth.ts)
• Authorization: user/admin RBAC — middleware/authorize.ts (requireRole) fetches the role per request; admin surface in routes/admin.ts
• Encryption at rest: user email is AES-256-GCM ciphertext with a keyed HMAC blind index for lookups (lib/crypto/)
• Security: JWT auth, bcrypt hashing, rate limiting, input validation, three-role DB model, field encryption
• Audit Log: lib/auditLog.ts (write inside $transaction, writeOrLog for non-blocking auth events); emissions in middleware/auth.ts, middleware/authorize.ts, routes/auth.ts, routes/todos.ts, routes/user.ts, routes/admin.ts, models/Todo.ts, models/User.ts
• Request Context: lib/requestContext.ts AsyncLocalStorage holds requestId / ip / userAgent / userId for downstream audit writes
• Startup Probes: index.ts refuses to boot if TimescaleDB extension is missing or audit_entries UPDATE does not return 42501
• Types: Full TypeScript type definitions (types/index.ts, types/express.d.ts)
```

## Table of Contents

- [Quickstart](#quickstart)
- [Architecture Diagram](#architecture-diagram)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [Configuration](#configuration)
- [Security](#security)
- [Docker](#docker)
- [Benchmarks](#benchmarks)
- [Testing](#testing)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)

## Features

### Core Functionality

- **User Authentication**: JWT-based auth with secure password hashing (bcrypt, 12 salt rounds), short-lived access tokens + **rotating refresh tokens** with reuse/theft detection (`/auth/refresh`, `/auth/logout`, `/auth/logout-all`)
- **User Profile Management** (SOC 2 CC6.1 / Privacy): `GET`/`PATCH /user/me` (display name), `PATCH /user/me/email` (re-auth required), `PATCH /user/me/password` (revokes all refresh tokens), `DELETE /user/me` (cascade delete + audit), `GET /user/me/export` (data portability)
- **Role-Based Access Control** (SOC 2 CC6.1 / CC6.3): `user` / `admin` roles with a separated `/admin` user-management surface; role checked per request (not carried in the JWT), so demotion is immediate. Bootstrap the first admin with `scripts/promote-admin.ts`
- **Field Encryption at Rest** (SOC 2 CC6.1 / C1.1): user email stored as AES-256-GCM ciphertext with a keyed HMAC blind index carrying uniqueness and lookups
- **Todo Management**: Full CRUD operations with user isolation and cursor-based pagination (limit/cursor, default 20, max 100)
- **Input Validation**: Comprehensive Joi-based validation on all endpoints
- **Rate Limiting**: Multi-tiered protection (global, auth, read, write) with optional Redis-backed distributed rate limiting via `REDIS_URL`
- **Clustering**: Optional multi-process mode via `CLUSTER_WORKERS` (auto-detect CPUs or exact count)
- **Environment Variable Validation**: Runtime validation with envalid (startup failures for misconfiguration)
- **CORS Configuration**: Configurable Cross-Origin Resource Sharing with origin validation
- **Prometheus Metrics**: Application and process metrics via `/metrics` endpoint (request duration, throughput, DB query timing, rate limit hits, active connections, `audit_write_failures_total`)
- **Immutable Audit Log** (SOC 2 CC7.2 / CC7.4 / CC6.2): every authentication event, authorization denial (`access.denied`), profile/account change (`user.*`), administrative action (`admin.*`), and todo mutation writes a row to the `audit_entries` TimescaleDB hypertable. The runtime DB role (`db_app`) can `INSERT` and `SELECT` only — `UPDATE`/`DELETE`/`TRUNCATE` are REVOKED so a compromised app cannot tamper with history. Mutation audits run inside `prisma.$transaction` so an audit failure rolls the mutation back; auth-event audits fire-and-forget and surface failures through the Prometheus counter. Two startup probes refuse to boot if either guarantee is missing
- **TypeScript**: Full type safety with strict mode, custom type definitions, and ES Modules

### Logging System

- **Structured JSON Logging**: Production-grade Pino logging (5-10x faster than Winston)
- **Request Tracking**: Unique request IDs for distributed tracing
- **Response Time Logging**: Automatic tracking of request duration
- **Sensitive Data Redaction**: Automatic redaction of passwords, tokens, and auth headers
- **Environment-Aware**:
  - Development: Pretty-printed colored output to console
  - Production: structured JSON to stdout (platform handles routing)
  - Tests: Silent mode to avoid log pollution

### Authentication Requirements

- **Email**: Valid format, max 72 characters
- **Password**: 8-72 characters, must contain uppercase, lowercase, number, and special character
- **Tokens**: Short-lived access JWTs (`ACCESS_TOKEN_EXPIRY`, default 15m, HS256) + opaque rotating refresh tokens (`REFRESH_TOKEN_EXPIRY_DAYS`, default 30). `/auth/refresh` rotates the pair; `/auth/logout` and `/auth/logout-all` revoke

### Rate Limits

| Limiter      | Window     | Max Requests               | Applied To                                                          |
| ------------ | ---------- | -------------------------- | ------------------------------------------------------------------- |
| **Global**   | 15 minutes | 200                        | All routes                                                          |
| **Register** | 1 hour     | 2                          | Account creation                                                    |
| **Login**    | 15 minutes | 3 (failures, per IP+email) | Authentication (a per-email 30/hour cap also applies)               |
| **Refresh**  | 15 minutes | 60                         | `/auth/refresh`, `/auth/logout` (`/auth/logout-all` uses **Write**) |
| **Read**     | 1 minute   | 100                        | GET operations                                                      |
| **Write**    | 1 minute   | 30                         | POST/PATCH/DELETE                                                   |

## Technology Stack

- **TypeScript** 6.0.3 (strict mode, ES Modules)
- **Node.js** 24+ + **Express** 5.2.1
- **PostgreSQL** + **Prisma ORM** 7.9.1
- **Authentication**: jsonwebtoken 9.0.3, bcrypt 6.0.0
- **Security Headers**: helmet 8.x
- **Validation**: joi 18.2.3, envalid 8.2.0
- **Logging**: pino 10.3.1, pino-pretty 13.1.3
- **Database Driver**: pg 8.22.0, @prisma/adapter-pg 7.9.1
- **Rate Limiting**: express-rate-limit 8.6.1, rate-limit-redis 5.x (optional Redis store)
- **Metrics**: prom-client 15.1.3 (Prometheus-compatible process and application metrics)
- **CORS**: cors 2.8.6 (origin validation, preflight handling)
- **IDs**: uuid 14.0.1
- **Testing**: Jest 30.4.2, Supertest 7.2.2, ts-jest 29.4.12
- **Development**: tsx 4.23.1 (hot reload via `tsx watch`)

## Configuration

All environment variables are validated at startup with `envalid`. The server will not start with missing or invalid configuration.

**Required**:

| Variable               | Description                                                                               | Example                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`         | Runtime app connection (use the restricted `db_app` role)                                 | `postgresql://db_app:db_app_dev@localhost:5432/todo_api`     |
| `DATABASE_MIGRATE_URL` | Admin DSN used only by `prisma migrate deploy` (`db_admin`). Falls back to `DATABASE_URL` | `postgresql://db_admin:db_admin_dev@localhost:5432/todo_api` |
| `JWT_SECRET`           | JWT signing secret (32+ chars)                                                            | `your-super-secret-jwt-key-min-32-chars`                     |
| `CORS_ORIGIN`          | Allowed CORS origin(s), comma-separated (or `*`). No default — startup fails without it   | `http://localhost:3000,http://localhost:5173`                |

**Optional**: `PORT`, `NODE_ENV`, `LOG_LEVEL`, database pool tuning, clustering, and more.

See [`docs/configuration.md`](docs/configuration.md) for the full reference including all optional variables, CORS setup, and example `.env` files.

## Security

### Implemented Measures

- Bcrypt password hashing with 12 salt rounds
- Secure HTTP response headers via Helmet
- Short-lived access JWTs (15m default) + **rotating refresh tokens** with reuse/theft detection (replaying a revoked token revokes the user's entire session set)
- **Field-level encryption at rest** for user email (AES-256-GCM) with a keyed HMAC blind index for lookups/uniqueness — keys via an env-var keyring behind a `KeyProvider` interface (KMS-ready); production refuses to boot on the dev placeholder key
- **Role-based access control** (`user`/`admin`) with a per-request role check on `/admin` routes and `access.denied` audit events on forbidden attempts
- Multi-tiered rate limiting (global + endpoint-specific)
- Comprehensive input validation (Joi schemas)
- Environment variable validation at startup (prevents misconfiguration)
- User isolation at database level
- No cross-user data access
- **Three-role DB model** (`db_admin` / `db_app` / `db_auditor`) so SOC 2 audit-trail immutability is enforced by Postgres `REVOKE`, not by app code that an attacker could bypass
- **Immutable audit log** of authentication, authorization, and data-mutation events in a TimescaleDB hypertable with 1-year retention. Mutation audits live inside `prisma.$transaction` so an audit failure rolls back the mutation; auth audits fire-and-forget and alert via `audit_write_failures_total`
- **Startup tamper-evidence probe**: the server attempts `UPDATE audit_entries SET action='probe' WHERE FALSE` at boot and refuses to start unless Postgres rejects it with `42501 permission denied` — catches a missing `REVOKE` or a wrong `DATABASE_URL` (superuser DSN) before the process serves traffic
- **TimescaleDB extension probe** at boot — the audit retention policy is meaningless without the extension, so the server refuses to start if it's not installed
- **Login-failure email hashing**: failed-login audit rows store a **keyed HMAC blind index** of the email in `metadata` (the same value as `users.email_hash`), not the raw address and not a bare SHA-256 — so the audit table is never an offline-enumerable oracle for guessed addresses

### Best Practices

- Passwords never stored in plain text
- JWT secrets in environment variables
- Runtime validation of all required configuration
- Unique email constraint at database level
- Graceful error messages (no sensitive info leakage)

## Docker

Full containerization with a two-stage Dockerfile, Postgres, and Redis. See [`docs/docker.md`](docs/docker.md) for the complete setup guide, production configuration, and troubleshooting.

### Quick Start

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm -u root app npx prisma migrate deploy
docker compose up -d
curl http://localhost:3001/health/ready
```

## Benchmarks

k6-based load testing with two benchmark modes across four load levels (low/medium/high/overload). Each run includes a 30-second warm-up phase for V8 JIT stabilization.

- **Framework overhead** (`bench:echo`): Static JSON echo endpoint -- isolates Express routing, middleware dispatch, and serialization
- **Application performance** (`bench:app`): Full CRUD workload with JWT auth, Joi validation, and Prisma/PostgreSQL queries

```bash
pnpm bench:seed                        # Seed benchmark users and todos
DISABLE_RATE_LIMIT=true pnpm run dev   # Start server (separate terminal)
pnpm bench:all                         # Run full suite (all levels, both modes)
```

See [`docs/benchmarks.md`](docs/benchmarks.md) for the full methodology, metric definitions, reproduction steps, and fair comparison guidelines.

## Testing

Minimum **80%** coverage required across branches, functions, lines, and statements. Enforced via Jest thresholds.

```bash
pnpm test              # Run all tests
pnpm run test:coverage # Coverage report
pnpm run test:ci       # CI mode
```

See [`docs/testing.md`](docs/testing.md) for the full guide including test structure, helper utilities, writing new tests, database setup, and CI configuration.

## API Reference

Base URL: `http://localhost:3001` -- full documentation in [`docs/api.md`](docs/api.md).

| Method       | Path                     | Auth  | Description                                                                                                                                                                |
| ------------ | ------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **POST**     | `/auth/register`         | No    | Create account (returns access + refresh token)                                                                                                                            |
| **POST**     | `/auth/login`            | No    | Get access + refresh token                                                                                                                                                 |
| **POST**     | `/auth/refresh`          | No\*  | Rotate the refresh token, get a new access token                                                                                                                           |
| **POST**     | `/auth/logout`           | No\*  | Revoke the presented refresh token                                                                                                                                         |
| **POST**     | `/auth/logout-all`       | Yes   | Revoke every refresh token for the user                                                                                                                                    |
| **GET**      | `/user/me`               | Yes   | Get current profile                                                                                                                                                        |
| **PATCH**    | `/user/me`               | Yes   | Update display name                                                                                                                                                        |
| **PATCH**    | `/user/me/email`         | Yes   | Change email (requires current password)                                                                                                                                   |
| **PATCH**    | `/user/me/password`      | Yes   | Change password (revokes all refresh tokens)                                                                                                                               |
| **DELETE**   | `/user/me`               | Yes   | Delete account (cascade + audit)                                                                                                                                           |
| **GET**      | `/user/me/export`        | Yes   | Export profile + todos (JSON)                                                                                                                                              |
| **GET**      | `/admin/users`           | Admin | List users (paginated)                                                                                                                                                     |
| **GET**      | `/admin/users/:id`       | Admin | Get a user                                                                                                                                                                 |
| **PATCH**    | `/admin/users/:id/role`  | Admin | Change a user's role                                                                                                                                                       |
| **DELETE**   | `/admin/users/:id`       | Admin | Delete a user (cascade + audit)                                                                                                                                            |
| **GET**      | `/todos`                 | Yes   | List todos (paginated)                                                                                                                                                     |
| **POST**     | `/todos`                 | Yes   | Create todo                                                                                                                                                                |
| **GET**      | `/todos/:id`             | Yes   | Get single todo                                                                                                                                                            |
| **PATCH**    | `/todos/:id`             | Yes   | Toggle done status                                                                                                                                                         |
| **DELETE**   | `/todos/:id`             | Yes   | Delete todo                                                                                                                                                                |
| **GET**      | `/health`                | No    | Liveness probe                                                                                                                                                             |
| **GET**      | `/health/ready`          | No    | Readiness probe                                                                                                                                                            |
| **GET**      | `/health/ready/detailed` | Token | Detailed readiness (memory/CPU/pool)                                                                                                                                       |
| **GET**      | `/metrics`               | Token | Prometheus metrics                                                                                                                                                         |
| **GET/POST** | `/echo`                  | No    | Benchmark echo — mounted only when `ENABLE_ECHO_ROUTES=true` (default: non-production); bypasses logging and rate limiting. See [`docs/benchmarks.md`](docs/benchmarks.md) |

\* `/auth/refresh` and `/auth/logout` take the refresh token in the body — they don't require a (possibly expired) access token; `/auth/logout-all` requires a valid access token.

## Project Structure

```
todo-api/
├── __tests__/                  # Test suite (TypeScript)
│   ├── setup.ts               # Jest configuration
│   ├── helpers/               # Test utilities
│   │   ├── testSetup.ts       # Reusable test helpers
│   │   └── todoHelpers.ts     # Todo-specific helpers
│   ├── integration/           # API endpoint tests
│   └── unit/                  # Isolated component tests
├── src/                        # Application source
│   ├── app.ts                 # Express app configuration
│   ├── index.ts               # Server startup and DB connection
│   ├── types/                 # TypeScript type definitions
│   │   ├── index.ts           # Core types (models, requests, responses)
│   │   └── express.d.ts       # Express augmentation
│   ├── errors/                # Custom error classes
│   │   └── index.ts           # AppError, AuthError, ValidationError, ForbiddenError, NotFoundError/UserNotFoundError, ConflictError, and more
│   ├── middleware/            # Express middleware
│   │   ├── auth.ts            # JWT authentication + AuthNoToken/AuthTokenInvalid audit emission
│   │   ├── authorize.ts       # requireRole/requireAdmin role guard (per-request role lookup; access.denied audit)
│   │   ├── cors.ts            # CORS configuration and origin validation
│   │   ├── errorHandler.ts    # Centralized error handling
│   │   ├── logger.ts          # Pino logger configuration
│   │   ├── metrics.ts         # Prometheus metrics incl. audit_write_failures_total
│   │   ├── rateLimiter.ts     # Rate limiting
│   │   ├── requestContext.ts  # AsyncLocalStorage wrapper (requestId/ip/userAgent for downstream audit writes)
│   │   ├── requestId.ts       # Request ID tracking
│   │   ├── requestLogger.ts   # Request/response logging
│   │   └── validation.ts      # Joi validation schemas
│   ├── models/                # Data access layer (Prisma wrappers)
│   │   ├── User.ts            # User model (password hashing, email field-encryption, profile/role mutations)
│   │   ├── Todo.ts            # Todo model (mutations wrapped in $transaction with audit insert)
│   │   └── RefreshToken.ts    # Refresh-token issue/verify/rotate/revoke + reuse/theft detection
│   ├── routes/                # Express routes
│   │   ├── auth.ts            # Auth routes: register, login, refresh, logout, logout-all (with audit emissions)
│   │   ├── user.ts            # Self-service profile: /user/me, email/password change, delete, export
│   │   ├── admin.ts           # Admin user management (/admin/users, role change, delete) behind requireAdmin
│   │   ├── echo.ts            # Benchmark echo endpoint
│   │   ├── health.ts          # Health check endpoints
│   │   └── todos.ts           # Todo CRUD routes (AccessDenied audit at cross-user 404 sites)
│   ├── config/                # Configuration
│   │   └── env.ts             # Environment variable validation (envalid)
│   └── lib/                   # Shared utilities
│       ├── prisma.ts          # Prisma client singleton
│       ├── tokens.ts          # Access-token sign/verify + refresh-token generation/hashing
│       ├── crypto/            # Field encryption: fieldCrypto.ts (AES-256-GCM + blind index), keyProvider.ts
│       ├── normalizeEmail.ts  # Canonical email form (NFC + lowercase + trim)
│       ├── dbConnect.ts       # Startup connect-with-retry (decorrelated jitter)
│       ├── requestContext.ts  # AsyncLocalStorage instance + getRequestContext() reader
│       ├── auditActions.ts    # Audit action vocabulary constants (auth.*, todo.*, user.*, admin.*)
│       └── auditLog.ts        # write() (transactional) and writeOrLog() (non-blocking)
├── prisma/                     # Prisma schema and migrations
│   ├── schema.prisma          # Database schema (User incl. name/role, Todo, RefreshToken, AuditEntry)
│   ├── generated/             # Generated Prisma types
│   ├── migrations/            # Database migrations (incl. 20260526000001_add_audit_entries)
│   └── sql/
│       └── bootstrap_roles.sql # Creates db_admin / db_app / db_auditor + default privileges
├── scripts/                    # Operational scripts
│   ├── preflight-roles.ts     # Pre-deploy DB role/privilege verification
│   ├── promote-admin.ts       # Grant/revoke the admin role by email (RBAC bootstrap)
│   ├── backfill-email-crypto.ts # Email field-encryption backfill (hash/encrypt/rehash phases)
│   └── predeploy.ts           # Pre-deploy orchestration
├── docker/
│   └── timescaledb/           # Custom TimescaleDB + pgBackRest image and backup scripts
├── dist/                       # Compiled JavaScript (generated)
├── tsconfig.json              # TypeScript configuration
├── tsconfig.test.json         # TypeScript config for tests
├── jest.config.ts             # Jest configuration
├── Dockerfile                 # Multi-stage Docker build (tsc compilation + compiled JS runtime)
├── .dockerignore              # Docker build context exclusions
├── docker-compose.yml         # Full stack: Postgres, Redis, app
├── railway.json               # Railway deploy config (pre-deploy migrations)
├── benchmarks/                 # Load testing infrastructure
│   ├── k6/                    # k6 benchmark scripts
│   ├── seed.ts                # Benchmark database seeding
│   ├── run.sh                 # Full benchmark suite runner
│   ├── explain-queries.ts     # EXPLAIN ANALYZE for generated SQL
│   ├── bcrypt-timing.ts       # Bcrypt hash/compare timing
│   └── container-startup.sh   # Container startup measurement
├── docs/
│   ├── api.md                     # Full API endpoint reference
│   ├── benchmarks.md              # Benchmark methodology and reproduction
│   ├── configuration.md           # Environment variables and CORS setup
│   ├── databases.md               # Audit-log (TimescaleDB) and search design memo
│   ├── docker.md                  # Docker setup, commands, production config
│   ├── operations.md              # Deploy/DB runbooks (role bootstrap, P3009 recovery)
│   ├── pgbackrest-implementation.md # pgBackRest backup and disaster-recovery guide
│   ├── runtime-correctness.md     # Production runtime correctness plan
│   └── testing.md                 # Test framework, helpers, writing tests
├── eslint.config.js           # ESLint configuration
├── package.json               # Dependencies and scripts
├── ROADMAP.md                 # Planned improvements and roadmap
├── prisma.config.ts           # Prisma configuration
├── AGENTS.md                  # AI agent instructions
├── .env.example               # Environment variables template
└── .env                       # Environment variables (not in repo)
```
