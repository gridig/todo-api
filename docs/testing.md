# Testing

This guide covers the test framework, structure, helper utilities, database setup, and how to write new tests.

## Overview

| Component     | Tool                                      |
| ------------- | ----------------------------------------- |
| Framework     | Jest 29.7.0                               |
| TypeScript    | ts-jest with ESM support                  |
| HTTP testing  | Supertest 7.1.4                           |
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

# CI mode (coverage + 2 workers)
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
│   ├── auth.test.ts                # Registration and login
│   ├── cors.test.ts                # CORS configuration
│   ├── health.test.ts              # Health check endpoints
│   ├── routes-smoke.test.ts        # Route smoke tests
│   ├── todos.test.ts               # Todo endpoint integration tests
│   └── todos/
│       ├── create-todo.test.ts     # POST /todos
│       ├── delete-todo.test.ts     # DELETE /todos/:id
│       ├── get-single-todo.test.ts # GET /todos/:id
│       ├── get-todos.test.ts       # GET /todos
│       └── update-todo.test.ts     # PATCH /todos/:id
└── unit/
    ├── middleware/
    │   ├── auth.test.ts            # JWT authentication
    │   ├── errorHandler.test.ts    # Centralized error handling
    │   ├── rateLimiter.test.ts     # Rate limiting
    │   ├── requestId.test.ts       # Request ID generation
    │   ├── requestLogger.test.ts   # Request/response logging
    │   └── validation.test.ts      # Joi validation
    └── models/
        ├── Todo.test.ts            # Todo model
        └── User.test.ts            # User model
```

## Coverage Requirements

Minimum **80%** across all four metrics, enforced via Jest thresholds:

| Metric     | Threshold |
| ---------- | --------- |
| Branches   | 80%       |
| Functions  | 80%       |
| Lines      | 80%       |
| Statements | 80%       |

Coverage is collected from `src/models/`, `src/middleware/`, and `src/routes/`. `src/middleware/logger.ts` is excluded (Pino internals are not unit-testable).

Run `pnpm run test:coverage` to generate a report.

## Test Helpers

### `testSetup.ts`

| Function                 | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `generateUniqueId()`     | Returns a `crypto.randomUUID()` for test isolation                |
| `createTestApp()`        | Returns the Express `Application` instance                        |
| `createTestUser(email?)` | Creates a user + JWT token, returns `{ user, authToken, userId }` |
| `connectTestDB()`        | Connects Prisma to the test database                              |
| `disconnectTestDB()`     | Disconnects Prisma and closes the connection pool                 |
| `cleanupTestData()`      | Deletes all todos then all users (respects FK constraints)        |

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

| Variable       | Description                  | Example                                                  |
| -------------- | ---------------------------- | -------------------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/todo_api` |
| `JWT_SECRET`   | JWT signing key (any value)  | `jwt-secret-key-for-testing-only`                        |
| `NODE_ENV`     | Must be `test`               | `test`                                                   |

### Optional (have defaults)

| Variable            | Default                            | Description                                                 |
| ------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `PORT`              | `3001`                             | Server port (tests use Supertest, so the port is not bound) |
| `CORS_ORIGIN`       | `*`                                | Allowed CORS origins                                        |
| `CORS_CREDENTIALS`  | `false`                            | Allow credentials in CORS                                   |
| `CORS_METHODS`      | `GET,HEAD,PUT,PATCH,POST,DELETE`   | Allowed HTTP methods                                        |
| `CORS_HEADERS`      | `Content-Type,Authorization`       | Allowed HTTP headers                                        |
| `CORS_MAX_AGE`      | `86400`                            | Preflight cache duration (seconds)                          |
| `LOG_LEVEL`         | Auto-determined (`silent` in test) | Logging level                                               |
| `LOG_FILE_PATH`     | `./logs/app`                       | Log file base path                                          |
| `LOG_MAX_FILE_SIZE` | `10m`                              | Max log file size before rotation                           |

### Minimal `.env.test`

Most optional variables can be omitted. A minimal file looks like:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/todo_api"
NODE_ENV=test
JWT_SECRET=jwt-secret-key-for-testing-only
PORT=3002
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
# Equivalent to: jest --ci --coverage --maxWorkers=2
```

- `--ci` -- Fails if snapshots are out of date (no interactive update)
- `--coverage` -- Generates coverage report and enforces thresholds
- `--maxWorkers=2` -- Limits parallelism for CI resource constraints

Ensure the CI environment has a PostgreSQL instance available and a `.env.test` with valid `DATABASE_URL`.
