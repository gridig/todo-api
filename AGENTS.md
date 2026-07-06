# AGENTS.md - Todo API

Instructions for AI agents working with this codebase.

## Project Overview

A production-ready RESTful API for managing todos with user authentication.

**Stack:**

- TypeScript 6.0.3 (strict mode, ES Modules)
- Node.js 24+ with Express 5.2.1
- PostgreSQL with Prisma ORM 7.x
- JWT authentication (jsonwebtoken 9.0.3)
- Bcrypt password hashing (6.0.0, 12 salt rounds)
- Joi validation (18.x)
- Pino structured logging (10.x)
- Express-rate-limit (8.5.2)
- Testing: Jest 30.4.2, ts-jest, Supertest

**Architecture:**

- `src/index.ts` - Server startup, database connection, graceful shutdown
- `src/app.ts` - Express app factory, middleware pipeline, route mounting
- `src/config/env.ts` - Environment variable validation with envalid
- `src/types/` - TypeScript type definitions (index.ts, express.d.ts)
- `src/errors/` - Custom error classes (AppError, AuthError, ValidationError, NotFoundError)
- `src/lib/` - Prisma client, DB connection, audit logging, request context
- `src/models/` - Prisma models (User, Todo)
- `src/routes/` - Express routers (auth, todos, health)
- `src/middleware/` - Auth, validation, rate limiting, logging, error handling

## Build and Test Commands

```bash
# Development
pnpm run dev           # Start with tsx watch (hot reload)

# Build
pnpm run build         # Compile TypeScript to dist/
pnpm run build:watch   # Watch mode compilation
pnpm run typecheck     # Type check without emitting

# Testing
pnpm test              # Run all tests
pnpm run test:watch    # Watch mode
pnpm run test:coverage # Coverage report
pnpm run test:integration # Integration tests only
pnpm run test:unit     # Unit tests only
pnpm run test:ci       # CI mode (coverage, single worker — maxWorkers: 1; parallel workers would corrupt the shared-DB truncation cleanup)

# Linting
pnpm run lint          # Check for issues
pnpm run lint:fix      # Auto-fix issues

# Benchmarking
pnpm run bench:seed    # Seed benchmark users and todos
pnpm run bench:all     # Full suite (all levels, both modes)
pnpm run bench:echo    # Framework overhead only (medium level)
pnpm run bench:app     # Application performance only (medium level)

# Production
pnpm run start         # Run compiled JS from dist/
pnpm run start:prod    # Run in production mode
```

## Code Style Guidelines

### TypeScript

- All source files use `.ts` extension
- Strict mode enabled (`strict: true` in tsconfig.json)
- Use types from `src/types/index.ts` for consistency
- Avoid `any` - use proper types or `unknown` with type guards
- Use `Request`, `Response`, `NextFunction` from express for handlers

### Module System

- Use ES Modules: `import/export` syntax throughout
- Named exports for middleware functions
- Default exports for models and routers
- Import with `.js` extension for Node.js compatibility (e.g., `import { auth } from './middleware/auth.js'`)

### Async Operations

- Always use `async/await` (no raw Promises or callbacks)
- Wrap async route handlers in try/catch

### Logging

- Use `req.log` (Pino child logger with request context)
- Available methods: `req.log.info()`, `req.log.warn()`, `req.log.error()`, `req.log.debug()`
- First argument is context object, second is message string:
  ```typescript
  req.log.info({ userId: user.id, todoId: todo.id }, 'Todo created');
  ```

### Validation

- Use Joi schemas defined in `src/middleware/validation.ts`
- Add new schemas to the `schemas` object
- Apply with `validate(schemas.schemaName)` middleware

### Error Handling

- Use custom error classes from `src/errors/index.ts` for consistent error responses
- Available error classes:
  - `AppError` - Base class for all custom errors
  - `AuthError`, `InvalidCredentialsError`, `NoTokenError`, `InvalidTokenError` - Authentication errors (401)
  - `ValidationError`, `InvalidIdFormatError` - Validation errors (400)
  - `ForbiddenError` - Authorization errors (403)
  - `NotFoundError`, `TodoNotFoundError`, `RouteNotFoundError` - Not found errors (404)
  - `ConflictError`, `DuplicateEmailError`, `DuplicateValueError` - Conflict errors (409)
  - `InternalServerError` - Server errors (500)
  - `ServiceUnavailableError`, `DatabaseUnavailableError` - Transient errors (503, sets Retry-After)
- Return early for error conditions
- Log errors with full context before responding
- Error response format:
  ```typescript
  const error = new TodoNotFoundError();
  return res.status(error.statusCode).json({
    ...error.toJSON(),
    requestId: req.id,
  });
  ```

### Naming Conventions

- camelCase for variables and functions
- PascalCase for models and classes
- Descriptive names for clarity

## Testing Instructions

For the full testing guide (structure, helpers reference, writing tests, database setup, CI), see `docs/testing.md`.

### Framework

- Jest 30.4.2 with TypeScript support (ts-jest, ESM)
- PostgreSQL with Prisma for isolated testing
- Supertest for HTTP assertions

### Writing Tests

1. Use helper utilities from `__tests__/helpers/testSetup.ts`:

   ```typescript
   import {
     createTestApp,
     createTestUser,
     connectTestDB,
     disconnectTestDB,
     cleanupTestData,
   } from '../helpers/testSetup.js';

   const app = createTestApp();

   let authToken: string;
   let userId: string;

   beforeAll(async () => {
     await connectTestDB();
     ({ authToken, userId } = await createTestUser());
   });
   ```

2. Clean up after tests:

   ```typescript
   afterEach(async () => {
     await cleanupTestData();
   });

   afterAll(async () => {
     await disconnectTestDB();
   });
   ```

3. Test file naming: `*.test.ts` under `__tests__/`

### Coverage Requirements

- Minimum 80% coverage for branches, functions, lines, and statements
- The gate covers all of `src/**` except `src/index.ts` (process bootstrap), `src/middleware/logger.ts` (transport config), and `src/types/` (no runtime code) — see `collectCoverageFrom` in `jest.config.ts`
- Run `pnpm run test:coverage` to verify

## Security Considerations

### Critical Rules

1. **Never log sensitive data**
   - Passwords, tokens, and authorization headers are automatically redacted
   - Redaction configured in `src/middleware/logger.ts`
   - Do not bypass or disable redaction

2. **User isolation**
   - All database queries MUST include `user: req.userId`
   - Never allow cross-user data access
   - Example: `Todo.find({ user: req.userId })` not `Todo.find({})`

3. **Password handling**
   - Passwords hashed with bcrypt (12 salt rounds, OWASP 2024+ floor)
   - Legacy cost-10 hashes are valid (bcrypt embeds cost in the hash); the login flow opportunistically re-hashes them at the current cost via `UserService.updatePassword`
   - Never store or return plain text passwords
   - Use `user.comparePassword()` method for verification

4. **JWT tokens**
   - 24-hour expiration, HS256 only
   - Payload carries the standard `sub` claim (subject = user id), plus `iss` and `aud` (set via `JWT_ISSUER` / `JWT_AUDIENCE`)
   - Verification has 5-second `clockTolerance` for cross-instance drift
   - `JWT_VERIFY_REQUIRE_CLAIMS=false` during the rollout grace window — `src/middleware/auth.ts` still accepts legacy `{ userId }` payloads. Flip to `true` ≥24h after deploy; once stable, drop the back-compat branch
   - JWT_SECRET must be strong (32+ characters in production)
   - Tokens validated in `src/middleware/auth.ts`

5. **Rate limiting**
   - Global: 200 requests per 15 minutes (per IP)
   - Register: 2 requests per hour (per IP)
   - Login per (IP, email): 3 failed attempts per 15 minutes
   - Login per email: 30 attempts per hour (caps single-account brute-force regardless of source IP)
   - Read operations: 100 per minute (per IP)
   - Write operations: 30 per minute (per IP)
   - With `REDIS_URL` set, limiters are Redis-backed (cross-instance); if Redis is unavailable they degrade to a per-instance memory store (`src/middleware/rateLimitStore.ts`) rather than failing requests — watch `rate_limit_store_fallback_total`
   - Rate limiting is skipped in the `test` environment and when `DISABLE_RATE_LIMIT=true`. In production (`NODE_ENV=production`) the latter requires the paired `DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM=true` flag — startup aborts otherwise. Use only on a dedicated benchmark process.

### Input Validation

- All inputs validated with Joi schemas before processing
- Validation middleware strips unknown fields (`stripUnknown: true`)
- Email: max 72 characters, valid format
- Password: 8-72 characters, must contain uppercase, lowercase, number, special character
- Todo text: 1-500 characters, trimmed

## Environment Setup

For the full configuration reference (all variables, CORS, examples), see `docs/configuration.md`.

### Required Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/todo-api  # PostgreSQL connection string
JWT_SECRET=your-secret-key-min-32-chars                          # JWT signing secret
PORT=3001                                                         # Server port
```

### Setup Steps

1. Copy `.env.example` to `.env`
2. Configure environment variables (see `docs/configuration.md` for all options)
3. Ensure PostgreSQL is running (local or cloud instance)
4. Run `pnpm install`
5. Run `pnpm exec prisma migrate dev` to setup database
6. Run `pnpm run dev`

### Schema changes

The `audit_entries` hypertable, its `idx_audit_*` indexes, retention policy, and append-only REVOKE
exist only in raw migration SQL — `schema.prisma` does not describe them, so Prisma's diff engine
will generate SQL to drop them. Two hard rules (details: `docs/operations.md` → "Migration hazards"):

- **Never run `prisma db push`.**
- **Create migrations with `prisma migrate dev --create-only`** and hand-review the generated SQL;
  delete any statement touching `audit_entries` unless deliberate. A guard test
  (`__tests__/unit/migrations-guard.test.ts`) fails CI on violations.

## Commit Guidelines

### Format

```
<type>: <description>

[optional body]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Adding or updating tests
- `refactor`: Code refactoring (no feature change)
- `chore`: Maintenance tasks

### Examples

```
feat: add pagination to GET /todos endpoint
fix: handle duplicate email error in registration
test: add unit tests for auth middleware
docs: update API documentation for rate limits
```

## Pull Request Guidelines

1. Ensure all tests pass: `pnpm test`
2. Maintain high coverage: `pnpm run test:coverage`
3. Fix linting issues: `pnpm run lint:fix`
4. Update documentation if API changes (see Documentation section below)
5. Reference related issues in PR description

## Deployment

GitHub Actions deploys to Railway. Workflow: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

- **Staging**: automatic on push to `main`.
- **Production**: manual `workflow_dispatch` from the Actions tab; gated by the `production` GitHub Environment's required-reviewer rule.

The deploy step runs `railway up --ci --service todo-api`. The Railway project has three services (`todo-api`, `Postgres`, `Redis`); `--service todo-api` pins deploys to the app only.

`RAILWAY_TOKEN` is a Railway Project Token scoped per environment, stored as an environment-scoped secret in GitHub Environments (one token for `staging`, one for `production`). Never put Railway tokens in repo-level secrets or commit them. Railway's native auto-deploy is disabled — the Actions workflow is the only path to either environment, so the required-reviewer gate cannot be bypassed.

Do not propose adding deploy steps to other workflows or re-enabling Railway auto-deploy.

## Dependency Updates

Dependabot configuration: [`.github/dependabot.yml`](.github/dependabot.yml). Auto-merge policy: [`.github/workflows/dependabot-auto-merge.yml`](.github/workflows/dependabot-auto-merge.yml).

- **npm patch + minor** and **github-actions patch + minor** auto-merge after CI passes. The workflow approves the PR as `github-actions[bot]` and enables GitHub's auto-merge; the approval satisfies the `main protection` ruleset's required-review rule. This is the documented SOC 2 change-management policy — the workflow file is the audit artifact.
- **Majors** (any ecosystem) stay manual. Review the diff, the changelog, and run the test suite locally before merging.
- **Docker ecosystem** stays manual. Node base-image bumps have repeatedly broken the build (Node 26 unbundled Corepack; etc.) — never auto-merge them.
- **Security advisories** stay manual regardless of bump type.

Do not manually merge Dependabot PRs that the auto-merge workflow would handle — let the workflow run. If a Dependabot PR is failing CI due to stale main, comment `@dependabot rebase` rather than rebasing manually.

## Roadmap Workflow

The benchmark comparison infrastructure is complete. The current focus is cross-language performance comparison, not feature development.

### Current State

- **`ROADMAP.md`** tracks completed work and optional performance optimizations only
- The TypeScript implementation satisfies the [Fair Comparison Requirements](plans/alternatives/FAIR-COMPARISON-REQUIREMENTS.md) spec
- Do not implement features that are not in the roadmap unless explicitly requested by the user

### After Implementation

When an item from the roadmap is completed:

1. **Move to the Completed section** in `ROADMAP.md`
2. **Update docs if needed** - API changes go in `docs/api.md`, new env vars in `docs/configuration.md`, etc.
3. **Ensure all tests pass** - Run `pnpm test` and maintain high coverage
4. **Commit with proper format** - Use `feat:` for new features, see Commit Guidelines

## Documentation

Detailed reference docs live in `docs/`. The README is a landing page with summaries and links.

| File                          | Content                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `README.md`                   | Quickstart, architecture, features, summary tables                                              |
| `docs/api.md`                 | Full API endpoint reference, error codes, status codes                                          |
| `docs/configuration.md`       | All environment variables, CORS setup, `.env` examples                                          |
| `docs/docker.md`              | Docker build, run, production config, troubleshooting                                           |
| `docs/operations.md`          | Deploy runbooks: DB role bootstrap, deploy preflight, failed-migration (P3009) recovery         |
| `docs/benchmarks.md`          | Benchmark methodology, k6 scripts, load levels, reproduction                                    |
| `docs/testing.md`             | Test framework, helpers, writing tests, CI config                                               |
| `docs/runtime-correctness.md` | Production runtime correctness plan (shutdown, pool, error handling)                            |
| `docs/databases.md`           | Design memo for the audit-log (TimescaleDB) and future search (pg_trgm → Elasticsearch) workstreams |
| `ROADMAP.md`                  | Phased platform/production-readiness plan (SOC 2 priorities, open vs. done)                     |

When changing API endpoints, update `docs/api.md`. When adding environment variables, update `docs/configuration.md`. When changing test infrastructure, update `docs/testing.md`. When changing benchmark infrastructure, update `docs/benchmarks.md`.

## Key Files Quick Reference

| File                             | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| `src/index.ts`                   | Server startup, DB connection, graceful shutdown  |
| `src/app.ts`                     | Express app factory, middleware pipeline          |
| `src/config/env.ts`              | Environment variable validation                   |
| `src/types/index.ts`             | Core TypeScript type definitions                  |
| `src/types/express.d.ts`         | Express Request/Response augmentation             |
| `src/errors/index.ts`            | Custom error classes (AppError, AuthError, etc.)  |
| `src/middleware/auth.ts`         | JWT authentication                                |
| `src/middleware/errorHandler.ts` | Centralized error handling with structured format |
| `src/middleware/validation.ts`   | Joi schemas and validation middleware             |
| `src/middleware/rateLimiter.ts`  | Rate limiting configuration                       |
| `src/middleware/logger.ts`       | Pino logger setup                                 |
| `src/models/User.ts`             | User model with password hashing                  |
| `src/models/Todo.ts`             | Todo model                                        |
| `src/routes/auth.ts`             | Register and login endpoints                      |
| `src/routes/health.ts`           | Health check endpoints (liveness/readiness)       |
| `src/routes/todos.ts`            | CRUD operations for todos                         |
| `tsconfig.json`                  | TypeScript compiler configuration                 |
| `tsconfig.test.json`             | TypeScript config for tests                       |
