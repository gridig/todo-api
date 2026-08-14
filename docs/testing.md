# Testing

This guide covers the test framework, structure, helper utilities, database setup, and how to write new tests.

## Overview

| Component     | Tool                                      |
| ------------- | ----------------------------------------- |
| Framework     | Jest 30.4.2                               |
| TypeScript    | ts-jest with ESM support                  |
| HTTP testing  | Supertest 7.2.2                           |
| Database      | PostgreSQL with Prisma (isolated test DB) |
| Module system | ES Modules (`--experimental-vm-modules`)  |

## Running Tests

```bash
# Run all tests
pnpm test

# Watch mode
pnpm run test:watch

# Coverage report
pnpm run test:coverage

# Integration tests only
pnpm run test:integration

# Unit tests only
pnpm run test:unit

# CI mode (coverage, single worker — maxWorkers: 1)
pnpm run test:ci
```

## Test Structure

```
__tests__/
├── setup.ts                        # Loads .env.test, sets JWT_SECRET and NODE_ENV
├── helpers/
│   ├── testSetup.ts                # App factory, user creation, DB lifecycle
│   └── todoHelpers.ts              # Todo creation utilities
├── integration/
│   ├── auditLog.test.ts            # Audit-log emission and immutability
│   ├── auth.test.ts                # Registration and login
│   ├── cors.test.ts                # CORS configuration
│   ├── echo.test.ts                # /echo benchmark routes
│   ├── health.test.ts              # Health check endpoints
│   ├── metrics.test.ts             # /metrics endpoint and bearer auth
│   ├── pool-metrics.test.ts        # db_pool_* gauges
│   ├── rateLimit.test.ts           # Rate limiting
│   ├── routes-smoke.test.ts        # Route smoke tests
│   ├── todos.test.ts               # Todo endpoint integration tests
│   ├── admin/                      # /admin surface: authorization, list-users,
│   │                               #   update-role, delete-user
│   ├── auth/                       # refresh, logout, logout-all
│   ├── todos/                      # Per-endpoint CRUD: create, delete,
│   │                               #   get-single, get-all, update
│   └── user/                       # /user/me: get-me, update-profile, change-email,
│                                   #   change-password, delete-account, export
└── unit/
    ├── migrations-guard.test.ts    # Blocks migrations touching audit_entries
    ├── schema-cascade-guard.test.ts # Guards FK cascade declarations in the schema
    ├── config/                     # env-production assertions
    ├── lib/                        # dbConnect, fieldCrypto, retry, tokens
    ├── middleware/                 # auth, cors-helpers, errorHandler, metricsAuth,
    │                               #   rateLimiter (+ Redis store/fallback),
    │                               #   requestId, requestLogger, validation
    ├── models/                     # Todo, User, deleteMany-guard
    ├── routes/                     # auth-helpers
    └── scripts/                    # preflight-roles, promote-admin
```

## Coverage Requirements

Minimum **80%** across all four metrics, enforced via Jest thresholds:

| Metric     | Threshold |
| ---------- | --------- |
| Branches   | 80%       |
| Functions  | 80%       |
| Lines      | 80%       |
| Statements | 80%       |

Coverage is collected from all of `src/**` except `src/index.ts` (process bootstrap), `src/middleware/logger.ts` (Pino transport config), and `src/types/` (no runtime code) — see `collectCoverageFrom` in `jest.config.ts`.

Run `pnpm run test:coverage` to generate a report.

## Test Helpers

### `testSetup.ts`

| Function                          | Purpose                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateUniqueId()`              | Returns a `crypto.randomUUID()` for test isolation                                                                                             |
| `createTestApp()`                 | Returns the Express `Application` instance                                                                                                     |
| `createTestUser(email?)`          | Creates a user + JWT token, returns `{ user, authToken, userId }`                                                                              |
| `createTestAdmin(email?)`         | Like `createTestUser`, then sets the user's role to `admin` (same return shape) — use for `/admin` route tests                                 |
| `connectTestDB()`                 | Connects Prisma to the test database                                                                                                           |
| `disconnectTestDB()`              | Disconnects Prisma and closes the connection pool (incl. the privileged audit-admin pool)                                                      |
| `cleanupTestData()`               | Deletes refresh tokens, then todos, then users (respects FK constraints)                                                                       |
| `truncateAuditEntries()`          | `TRUNCATE audit_entries` via a privileged admin pool — the runtime `db_app` role can't; call in `afterEach` for suites asserting on audit rows |
| `pollForAuditRow(where, params?)` | Polls `audit_entries` for a matching row (audit writes are fire-and-forget, so the row may lag the HTTP response)                              |

### `todoHelpers.ts`

| Function                             | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `createTestTodos(userId, count)`     | Creates `count` todos (alternating `done` status)     |
| `createTestTodo(userId, text, done)` | Creates a single todo with specified text and status  |
| `generateFakeUUID()`                 | Returns a random UUID for testing not-found scenarios |

## Writing Tests

### Integration Test Pattern

Integration tests hit HTTP endpoints via Supertest. Standard lifecycle:

```typescript
import { describe, it, expect, beforeAll, afterEach, afterAll } from '@jest/globals';
import request from 'supertest';
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

afterEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('POST /todos', () => {
  it('should create a todo', async () => {
    const res = await request(app)
      .post('/todos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ text: 'Test todo' });

    expect(res.status).toBe(201);
    expect(res.body.text).toBe('Test todo');
    expect(res.body.done).toBe(false);
  });
});
```

### Unit Test Pattern

Unit tests isolate individual components using Jest mocks:

```typescript
import { describe, it, expect, beforeAll, afterEach, afterAll } from '@jest/globals';
import { connectTestDB, disconnectTestDB, cleanupTestData } from '../helpers/testSetup.js';
import UserService from '../../models/User.js';

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('UserService', () => {
  describe('create', () => {
    it('should hash the password', async () => {
      const user = await UserService.create({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      expect(user.password).not.toBe('TestPass123!');
    });
  });
});
```

### Key Patterns

- **Imports**: Use `@jest/globals` for `describe`, `it`, `expect`, etc.
- **ESM**: Import with `.js` extensions (mapped to `.ts` by Jest config)
- **Cleanup**: Always clean up in `afterEach` to prevent test pollution
- **Disconnect**: Always disconnect in `afterAll` to avoid open handles
- **FK order**: Delete todos before users in cleanup (foreign key constraint)
- **Auth**: Use `createTestUser()` to get a token, pass it via `.set('Authorization', ...)`

## Environment Setup

Tests run against a separate PostgreSQL database configured in `.env.test`. The global setup file (`__tests__/setup.ts`) loads this file before any test suite runs and overrides `JWT_SECRET` and `NODE_ENV=test` in-process.

Create a `.env.test` file in the project root with the following variables:

### Required

| Variable               | Description                                                                                                                                                                                       | Example                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`         | Runtime app connection string (restricted `db_app` role)                                                                                                                                          | `postgresql://db_app:db_app_dev@localhost:5432/todo_api`     |
| `DATABASE_MIGRATE_URL` | Admin DSN (`db_admin`) — used by `prisma migrate deploy` and by the privileged TRUNCATE pool in `testSetup.ts` (audit-log suites fail without it, since `db_app` cannot TRUNCATE `audit_entries`) | `postgresql://db_admin:db_admin_dev@localhost:5432/todo_api` |
| `JWT_SECRET`           | JWT signing key (any value)                                                                                                                                                                       | `jwt-secret-key-for-testing-only`                            |
| `NODE_ENV`             | Must be `test`                                                                                                                                                                                    | `test`                                                       |
| `CORS_ORIGIN`          | Allowed CORS origins — **no default**, the app fails to boot without it; `cors.test.ts` asserts on specific echoed origins                                                                        | `http://localhost:3000,http://localhost:5173`                |

### Optional (have defaults)

| Variable           | Default                            | Description                                                                                                                                     |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`             | `3001`                             | Server port (tests use Supertest, so the port is not bound)                                                                                     |
| `CORS_CREDENTIALS` | `false`                            | Allow credentials in CORS                                                                                                                       |
| `CORS_METHODS`     | `GET,HEAD,POST,PATCH,DELETE`       | Allowed HTTP methods                                                                                                                            |
| `CORS_HEADERS`     | `Content-Type,Authorization`       | Allowed HTTP headers                                                                                                                            |
| `CORS_MAX_AGE`     | `86400`                            | Preflight cache duration (seconds)                                                                                                              |
| `LOG_LEVEL`        | Auto-determined (`silent` in test) | Logging level                                                                                                                                   |
| `METRICS_TOKEN`    | _(unset)_                          | Bearer token for `GET /metrics` and `GET /health/ready/detailed` — the metrics and detailed-readiness integration tests need it set (32+ chars) |

### Minimal `.env.test`

Most optional variables can be omitted. A minimal file looks like:

```env
DATABASE_URL="postgresql://db_app:db_app_dev@localhost:5432/todo_api"
DATABASE_MIGRATE_URL="postgresql://db_admin:db_admin_dev@localhost:5432/todo_api"
NODE_ENV=test
JWT_SECRET=jwt-secret-key-for-testing-only
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
PORT=3002
# Needed by the /metrics and /health/ready/detailed suites:
METRICS_TOKEN=test-metrics-token-please-replace-32-chars
```

`NODE_ENV` and `JWT_SECRET` are also hardcoded in `__tests__/setup.ts` as a safety net, but including them in `.env.test` keeps the file self-documenting.

## Database Setup

Key configuration in `jest.config.ts`:

- **`maxWorkers: 1`** -- Tests run sequentially to prevent database conflicts between suites
- **`testTimeout: 30000`** -- 30-second timeout accommodates database operations
- **`setupFilesAfterEnv`** -- Loads `.env.test` and sets `JWT_SECRET` and `NODE_ENV=test`

## CI Configuration

The `test:ci` script is designed for CI pipelines:

```bash
pnpm run test:ci
# Equivalent to: jest --ci --coverage
```

- `--ci` -- Fails if snapshots are out of date (no interactive update)
- `--coverage` -- Generates coverage report and enforces thresholds
- Parallelism is fixed at `maxWorkers: 1` via `jest.config.ts` (see above), so tests run serially against the shared database

Ensure the CI environment has a PostgreSQL instance available and a `.env.test` with valid `DATABASE_URL`.
