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

   Edit `.env`: set `DATABASE_URL` to your PostgreSQL instance and `JWT_SECRET` to a secure value (32+ characters). For a local Postgres:

   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/todo_api"
   JWT_SECRET=your-super-secret-key-min-32-chars
   ```

3. **Create database and run migrations**

   Ensure PostgreSQL is running, then:

   ```bash
   pnpm exec prisma migrate dev
   ```

   This applies the schema and generates the Prisma client.

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

# Response: {"token":"eyJhbGc..."}

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
│                         Client Application                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ HTTP/HTTPS
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                         Express Server                           │
│                          (index.ts)                              │
├─────────────────────────────────────────────────────────────────┤
│                     Middleware Pipeline                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  1. Request ID Generation (requestId.ts)                  │  │
│  │  2. Metrics Instrumentation (metrics.ts)                  │  │
│  │  3. Echo Route (/echo — benchmark only, no logging)       │  │
│  │  4. Request Logger (requestLogger.ts)                     │  │
│  │  5. CORS Handler (cors.ts)                                │  │
│  │  6. Health Routes (/health — exempt from rate limiting)   │  │
│  │  7. Metrics Route (/metrics — optional token auth)        │  │
│  │  8. Global Rate Limiter (rateLimiter.ts)                  │  │
│  │  9. JSON Body Parser                                      │  │
│  │  10. Route Handlers (per-route auth, validation, limits)  │  │
│  │  11. 404 Handler                                          │  │
│  │  12. Error Handler (errorHandler.ts)                      │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                          Routes Layer                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐          │
│  │ /health  │ │ /metrics │ │  /auth   │ │  /todos   │          │
│  │ (public) │ │ (token)  │ │ (public) │ │(protected)│          │
│  └────┬─────┘ └──────────┘ └────┬─────┘ └─────┬─────┘          │
├────────┼──────────────┼──────────────┼──────────────────────────┤
│        │              │              │                           │
│        │              ▼              ▼                           │
│        │      ┌───────────────────────────┐                     │
│        │      │     Models Layer          │                     │
│        │      │  ┌─────────┐ ┌─────────┐ │                     │
│        │      │  │ User.ts │ │ Todo.ts │ │                     │
│        │      │  └────┬────┘ └────┬────┘ │                     │
│        │      └───────┼───────────┼───────┘                     │
└────────┼──────────────┼───────────┼───────────────────────────────┘
         │              │           │
         │              └─────┬─────┘
         │                    │
         │              ┌─────▼──────┐
         │              │   Prisma   │
         │              │  (ORM/DB   │
         │              │   Client)  │
         │              └─────┬──────┘
         │                    │
         ▼                    ▼
┌────────────────┐   ┌────────────────┐
│  Health Checks │   │  PostgreSQL    │
│   - Liveness   │   │   - Users      │
│   - Readiness  │   │   - Todos      │
│                │   │                │
└────────────────┘   └────────────────┘

Key Components:
• Config (env.ts): Environment variable validation
• Errors: Custom error classes (AppError, AuthError, ValidationError, etc.)
• Logging: Structured JSON logs (Pino) with request correlation
• Security: JWT auth, bcrypt hashing, rate limiting, input validation
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

- **User Authentication**: JWT-based auth with secure password hashing (bcrypt, 10 salt rounds)
- **Todo Management**: Full CRUD operations with user isolation and cursor-based pagination (limit/cursor, default 20, max 100)
- **Input Validation**: Comprehensive Joi-based validation on all endpoints
- **Rate Limiting**: Multi-tiered protection (global, auth, read, write) with optional Redis-backed distributed rate limiting via `REDIS_URL`
- **Clustering**: Optional multi-process mode via `CLUSTER_WORKERS` (auto-detect CPUs or exact count)
- **Environment Variable Validation**: Runtime validation with envalid (startup failures for misconfiguration)
- **CORS Configuration**: Configurable Cross-Origin Resource Sharing with origin validation
- **Prometheus Metrics**: Application and process metrics via `/metrics` endpoint (request duration, throughput, DB query timing, rate limit hits, active connections)
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
- **Tokens**: JWT with 24-hour expiration

### Rate Limits

| Limiter      | Window     | Max Requests      | Applied To        |
| ------------ | ---------- | ----------------- | ----------------- |
| **Global**   | 15 minutes | 200               | All routes        |
| **Register** | 1 hour     | 2                 | Account creation  |
| **Login**    | 15 minutes | 3 (failures only) | Authentication    |
| **Read**     | 1 minute   | 100               | GET operations    |
| **Write**    | 1 minute   | 30                | POST/PATCH/DELETE |

## Technology Stack

- **TypeScript** 5.9.3 (strict mode, ES Modules)
- **Node.js** 24+ + **Express** 5.2.1
- **PostgreSQL** + **Prisma ORM** 7.2.0
- **Authentication**: jsonwebtoken 9.0.3, bcrypt 6.0.0
- **Validation**: joi 18.0.2, validator 13.15.26, envalid 8.1.1
- **Logging**: pino 10.1.0, pino-pretty 13.1.3
- **Database Driver**: pg 8.16.3, @prisma/adapter-pg 7.2.0
- **Rate Limiting**: express-rate-limit 8.2.1, rate-limit-redis (optional Redis store)
- **Metrics**: prom-client 15.1.3 (Prometheus-compatible process and application metrics)
- **CORS**: cors 2.8.5 (origin validation, preflight handling)
- **Testing**: Jest 29.7.0, Supertest 7.1.4, ts-jest 29.4.6
- **Development**: tsx 4.21.0 (hot reload via `tsx watch`)

## Configuration

All environment variables are validated at startup with `envalid`. The server will not start with missing or invalid configuration.

**Required**:

| Variable       | Description                    | Example                                              |
| -------------- | ------------------------------ | ---------------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string   | `postgresql://user:password@localhost:5432/todo-api` |
| `JWT_SECRET`   | JWT signing secret (32+ chars) | `your-super-secret-jwt-key-min-32-chars`             |

**Optional**: `PORT`, `NODE_ENV`, `LOG_LEVEL`, `CORS_ORIGIN`, database pool tuning, clustering, and more.

See [`docs/configuration.md`](docs/configuration.md) for the full reference including all optional variables, CORS setup, and example `.env` files.

## Security

### Implemented Measures

- Bcrypt password hashing with 10 salt rounds
- JWT tokens with 24-hour expiration
- Multi-tiered rate limiting (global + endpoint-specific)
- Comprehensive input validation (Joi schemas)
- Environment variable validation at startup (prevents misconfiguration)
- User isolation at database level
- No cross-user data access

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

| Method     | Path             | Auth  | Description            |
| ---------- | ---------------- | ----- | ---------------------- |
| **POST**   | `/auth/register` | No    | Create account         |
| **POST**   | `/auth/login`    | No    | Get JWT token          |
| **GET**    | `/todos`         | Yes   | List todos (paginated) |
| **POST**   | `/todos`         | Yes   | Create todo            |
| **GET**    | `/todos/:id`     | Yes   | Get single todo        |
| **PATCH**  | `/todos/:id`     | Yes   | Toggle done status     |
| **DELETE** | `/todos/:id`     | Yes   | Delete todo            |
| **GET**    | `/health`        | No    | Liveness probe         |
| **GET**    | `/health/ready`  | No    | Readiness probe        |
| **GET**    | `/metrics`       | Token | Prometheus metrics     |

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
├── types/                      # TypeScript type definitions
│   ├── index.ts               # Core types (models, requests, responses)
│   └── express.d.ts           # Express augmentation
├── errors/                     # Custom error classes
│   └── index.ts               # AppError, AuthError, ValidationError, NotFoundError, ConflictError, and 12 more
├── middleware/                 # Express middleware
│   ├── auth.ts                # JWT authentication
│   ├── cors.ts                # CORS configuration and origin validation
│   ├── errorHandler.ts        # Centralized error handling
│   ├── logger.ts              # Pino logger configuration
│   ├── metrics.ts             # Prometheus metrics (prom-client)
│   ├── rateLimiter.ts         # Rate limiting
│   ├── requestId.ts           # Request ID tracking
│   ├── requestLogger.ts       # Request/response logging
│   └── validation.ts          # Joi validation schemas
├── models/                     # Data access layer (Prisma wrappers)
│   ├── User.ts                # User model with password hashing
│   └── Todo.ts                # Todo model
├── routes/                     # Express routes
│   ├── auth.ts                # Authentication routes
│   ├── echo.ts                # Benchmark echo endpoint
│   ├── health.ts              # Health check endpoints
│   └── todos.ts               # Todo CRUD routes
├── config/                     # Configuration
│   └── env.ts                 # Environment variable validation (envalid)
├── lib/                        # Shared utilities
│   └── prisma.ts              # Prisma client singleton
├── prisma/                     # Prisma schema and migrations
│   ├── schema.prisma          # Database schema
│   ├── generated/             # Generated Prisma types
│   └── migrations/            # Database migrations
├── logs/                       # Log files (generated)
├── dist/                       # Compiled JavaScript (generated)
├── app.ts                      # Express app configuration
├── index.ts                    # Server startup and DB connection
├── tsconfig.json              # TypeScript configuration
├── tsconfig.test.json         # TypeScript config for tests
├── jest.config.ts             # Jest configuration
├── Dockerfile                 # Multi-stage Docker build (tsc compilation + compiled JS runtime)
├── .dockerignore              # Docker build context exclusions
├── docker-compose.yml         # Full stack: Postgres, Redis, app
├── benchmarks/                 # Load testing infrastructure
│   ├── k6/                    # k6 benchmark scripts
│   ├── seed.ts                # Benchmark database seeding
│   ├── run.sh                 # Full benchmark suite runner
│   ├── explain-queries.ts     # EXPLAIN ANALYZE for generated SQL
│   ├── bcrypt-timing.ts       # Bcrypt hash/compare timing
│   └── container-startup.sh   # Container startup measurement
├── plans/                      # Architecture and comparison specs
│   └── alternatives/          # Fair comparison requirements, greenfield architecture
├── docs/
│   ├── api.md                     # Full API endpoint reference
│   ├── benchmarks.md              # Benchmark methodology and reproduction
│   ├── configuration.md           # Environment variables and CORS setup
│   ├── docker.md                  # Docker setup, commands, production config
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
