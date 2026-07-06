# Runtime Correctness Plan

Three areas where the current implementation diverges from correct production behavior, identified during a structured review against common Node.js production patterns. These are not feature gaps — they are correctness bugs or consistency failures that affect any deployment. They should be resolved before Phase A begins.

## Summary

| #   | Area                                                                                                 | Severity | Roadmap overlap   |
| --- | ---------------------------------------------------------------------------------------------------- | -------- | ----------------- |
| 1   | Graceful shutdown — race condition, hang risk, missing K8s delay, no process error handlers          | High     | Supersedes #15    |
| 2   | Connection pool — dead pool, untuned settings, in-memory rate limiters                               | High     | Overlaps #12, #16 |
| 3   | Error handling — P2002 duplicated across route + errorHandler; validation errors bypass errorHandler | Medium   | Net new           |

---

## 1. Graceful Shutdown

### Root Causes

**Race condition (correctness bug).** `server.close()` in `setupGracefulShutdown()` is fire-and-forget. `prisma.$disconnect()` runs immediately in parallel, racing any in-flight requests that `server.close()` is still draining. A request mid-flight loses its database connection before it completes. `process.exit(0)` then fires as soon as the disconnect resolves, not after the HTTP server has confirmed it closed — so the "HTTP server closed" log message likely never prints.

**Hanging shutdown (liveness bug).** `server.close()` stops accepting new connections but does not close existing idle keep-alive connections. Without `server.closeIdleConnections()` (Node 18.2+), an idle connection from a load balancer health check prevents `server.close()` from ever calling its callback, hanging the process indefinitely. (`closeAllConnections()` is the wrong tool here — it also destroys sockets with requests still in flight, defeating the drain.)

**No force-close timeout.** If draining takes longer than expected — slow request, stuck connection — the process hangs forever. No `setTimeout` forces exit after a configurable deadline.

**K8s routing gap.** After a SIGTERM, the process immediately stops accepting connections, but the K8s control plane continues routing traffic to the pod for several seconds while endpoint state propagates to the ingress. This causes 502s during rolling deployments.

**Missing process-level error handlers.** `process.on('unhandledRejection')` and `process.on('uncaughtException')` are not registered anywhere. An unhandled rejection from any async operation — Prisma, JWT, or otherwise — crashes the process in Node 15+ with no structured log, no `requestId`, and no opportunity for graceful cleanup.

### Changes

**`src/config/env.ts`**

Add `num` to the envalid import. Add two new variables:

| Variable              | Type | Default | Purpose                                                   |
| --------------------- | ---- | ------- | --------------------------------------------------------- |
| `SHUTDOWN_DELAY_MS`   | num  | `5000`  | Sleep before closing; covers K8s endpoint propagation lag |
| `SHUTDOWN_TIMEOUT_MS` | num  | `10000` | Force-exit if graceful drain exceeds this duration        |

**`src/index.ts`**

Add process-level error handlers at module scope (after imports, before `startServer`):

```typescript
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
```

Rewrite `setupGracefulShutdown()` with the correct sequence:

1. Register a force-exit `setTimeout` for `SHUTDOWN_TIMEOUT_MS`, marked `.unref()` so it does not prevent a clean exit on its own.
2. `await` a `Promise` that resolves after `SHUTDOWN_DELAY_MS` — during this window the server keeps accepting requests while the load balancer drains its routing table.
3. Call `server.closeIdleConnections()` to terminate idle keep-alive connections that would otherwise block `server.close()` — idle only, so in-flight requests keep their sockets.
4. `await` a promisified `server.close()` — this is the point where the server stops accepting new connections and confirms all in-flight requests have completed.
5. Only then `await prisma.$disconnect()`.
6. Clear the force-exit timer and call `process.exit(0)`.

The corrected control flow in pseudocode:

```
SIGTERM received
  → start SHUTDOWN_TIMEOUT_MS force-exit timer (unref'd)
  → await sleep(SHUTDOWN_DELAY_MS)          ← K8s drain window
  → server.closeIdleConnections()           ← close idle keep-alives
  → await server.close()                    ← drain in-flight requests
  → await prisma.$disconnect()              ← DB only after HTTP is done
  → clearTimeout(forceExitTimer)
  → process.exit(0)
```

---

## 2. Connection Pool

### Root Causes

**Dead pool (wasted connections).** `src/lib/prisma.ts` constructs `new Pool({ connectionString })` on line 8 and `new PrismaPg({ connectionString })` on line 9. `PrismaPg` is passed the connection string directly, so it creates its own internal connection management independent of the explicit `Pool`. The `Pool` on line 8 opens up to 10 connections to Postgres while doing nothing with them. The ROADMAP (#12) describes removing it — the correct fix is to pass it to the adapter instead, making it the live pool whose settings take effect.

**No pool configuration.** Neither pool has `max`, `min`, `connectionTimeoutMillis`, or `idleTimeoutMillis` set. All defaults apply. Under horizontal scaling, each replica's untuned pool pushes Postgres toward `max_connections` limits at traffic spikes — the specific failure mode described in the referenced production patterns discussion.

**In-memory rate limiters.** All five rate limiters use `express-rate-limit`'s default in-memory store. Under horizontal scaling, each replica maintains an independent counter, multiplying the effective limit by the number of replicas. Covered separately in roadmap item #16; included here because the Redis client introduced for the rate limiter store also needs a disconnect in the graceful shutdown sequence.

### Changes

**`src/config/env.ts`**

Add five new variables:

| Variable                   | Type | Default     | Purpose                                                                                   |
| -------------------------- | ---- | ----------- | ----------------------------------------------------------------------------------------- |
| `DB_POOL_MAX`              | num  | `10`        | Max connections per instance — tune based on replica count and Postgres `max_connections` |
| `DB_POOL_MIN`              | num  | `2`         | Idle connections to maintain for fast response under sustained load                       |
| `DB_CONNECTION_TIMEOUT_MS` | num  | `5000`      | ms to wait for a free connection before throwing                                          |
| `DB_IDLE_TIMEOUT_MS`       | num  | `10000`     | ms before an idle connection is released                                                  |
| `REDIS_URL`                | str  | `undefined` | Optional. Enables distributed rate limiting. Falls back to in-memory when not set.        |

Document these in `docs/configuration.md` alongside pool sizing guidance: `DB_POOL_MAX × replica_count` must stay well below Postgres `max_connections` (default 100), with headroom for migrations and admin connections.

**`src/lib/prisma.ts`**

- Import `env` from `src/config/env.ts`.
- Configure the `Pool` constructor with the four new pool env vars.
- Pass the configured `pool` to `new PrismaPg({ pool })` instead of `new PrismaPg({ connectionString })`. This makes the single, explicitly constructed and configured pool the one Prisma actually uses.
- The `export { pool }` stays — it now refers to the live, tuned pool (and the test teardown path that calls `pool.end()` remains correct).

**`src/middleware/rateLimiter.ts`**

- Install `redis` and `rate-limit-redis` packages.
- At module load, if `env.REDIS_URL` is set, create and connect a Redis client. Log connection errors without crashing — rate limiting degrades to in-memory, which is acceptable for single-instance deployments.
- Add a `makeStore(prefix: string)` factory: returns a `RedisStore` when the Redis client is connected, `undefined` otherwise (`rateLimit` treats `undefined` as the default in-memory store).
- Pass `store: makeStore('<limiter-name>')` to each of the five `rateLimit()` calls.
- Export the Redis client so `src/index.ts` can disconnect it during shutdown.

**`src/index.ts`** (shutdown addition)

Add Redis client disconnection to `setupGracefulShutdown()` after `server.close()` resolves and before `prisma.$disconnect()`.

---

## 3. Error Handling

### Root Causes

**P2002 handled at two levels with inconsistent responses.** `src/routes/auth.ts` catches P2002 in the `/register` handler and returns a `DuplicateEmailError` (code: `DUPLICATE_EMAIL`). `src/middleware/errorHandler.ts` also handles P2002, returning an inline object with code `DUPLICATE_VALUE` and a different message format. Since the route catches the error and responds directly — never calling `next(err)` — the central handler's P2002 branch is dead code for the email case. Any future route that surfaces P2002 without a local catch receives a different error code and shape from the same underlying violation.

**Validation errors bypass errorHandler entirely.** `src/middleware/validation.ts` returns `res.status(400).json({ error: errors })` where `errors` is an array: `[{ field, message }]`. All `AppError` subclasses return `{ error: { code, message, details } }` — an object under the `error` key. These are structurally incompatible. Because the response is sent directly via `res.json()` the `errorHandler` is bypassed entirely, so validation error responses carry no `requestId`.

**No process-level error handlers.** The third layer in the layered error strategy — a global handler for unhandled rejections — is absent. Covered in Section 1; changes live in `src/index.ts`.

### Changes

**`src/routes/auth.ts`**

Remove both try/catch blocks from `/register` and `/login`. Express 5 automatically catches rejected async handler promises and forwards them to `next(err)` — the try/catch blocks are opt-in error containment, not required boilerplate. Removing them routes all errors to the central handler. The `/register` P2002 inline handling is deleted. The `/login` handler's early 401 returns for wrong credentials and missing users are not exceptions and are unaffected.

**`src/middleware/validation.ts`**

- Rename the local `interface ValidationError` to `interface FieldError` to avoid shadowing the imported class.
- Import `ValidationError as AppValidationError` from `src/errors/index.ts`.
- Replace `res.status(400).json({ error: errors })` with `return next(new AppValidationError('Validation failed', { fields }))` where `fields` is the mapped array placed in `details.fields`.
- Mark `_res` as unused in the middleware signature.

All validation errors now flow through `errorHandler`, receive a `requestId`, and return the uniform shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": {
      "fields": [{ "field": "email", "message": "..." }]
    }
  },
  "requestId": "..."
}
```

**`src/middleware/errorHandler.ts`**

Update the P2002 handler to construct a `ValidationError` instance (with a dynamic message and `details` derived from `err.meta.target`) and call `.toJSON()` rather than assembling a raw inline JSON object. This makes the P2002 response structurally consistent with all other error responses and eliminates the duplicate handling path.

**`__tests__/`**

Update assertions in any test that currently expects `{ error: [{ field, message }] }` (the old validation array format) to match the new `{ error: { code, message, details: { fields: [...] } } }` shape. No test logic changes — only the expected response structure in assertions.

---

## Relation to Existing Roadmap Items

| This plan                                               | Roadmap item                       | Notes                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Shutdown sequence fix + K8s delay + force-close timeout | #15 Graceful Shutdown Drain Period | This plan is a superset — adds the race condition fix, `closeIdleConnections()`, K8s delay, and force-exit timer       |
| Dead pool fix + pool configuration                      | #12 Connection Pool Configuration  | This plan fixes the root cause differently: passes the configured pool to the adapter rather than removing it          |
| Redis rate limit store                                  | #16 Distributed Rate Limit Store   | Same outcome; roadmap item specifies `ioredis`, this plan uses the official `redis` client — align before implementing |
| Process error handlers + error handling consistency     | No existing item                   | Net new; not currently tracked in the roadmap                                                                          |
