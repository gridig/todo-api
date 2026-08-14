# API Reference

Base URL: `http://localhost:3001`

## Authentication

### Register a New User

**POST** `/auth/register`

**Rate Limit**: 2 requests per hour

**Request Body**:

```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response** (201 Created):

```json
{
  "token": "<access-token-jwt>",
  "refreshToken": "<refresh-token>"
}
```

- `token` — short-lived access token (default 15m). Send as `Authorization: Bearer <token>`.
- `refreshToken` — opaque long-lived token (default 30 days). Store it securely and exchange it at
  `POST /auth/refresh` for a new access token when the access token expires. Returned **once** — only
  a hash is stored server-side.

**Validation Rules**:

- Email: Valid format, max 72 characters
- Password: 8-72 characters, must contain uppercase, lowercase, number, and special character

---

### Login

**POST** `/auth/login`

**Rate Limit**: 3 failed attempts per 15 minutes (per IP + email), plus 30 attempts per hour per email regardless of source IP

**Request Body**:

```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response** (200 OK):

```json
{
  "token": "<access-token-jwt>",
  "refreshToken": "<refresh-token>"
}
```

**Error Response** (401 Unauthorized):

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "details": {
      "suggestion": "Please check your email and password and try again"
    }
  },
  "requestId": "abc123"
}
```

---

### Refresh Access Token

**POST** `/auth/refresh`

Exchange a refresh token for a new access token. **Rotating**: each call returns a new refresh token
and invalidates the one presented — always store the newly returned `refreshToken`.

**Rate Limit**: 60 requests per 15 minutes (per IP)

**Request Body**:

```json
{
  "refreshToken": "<refresh-token>"
}
```

**Response** (200 OK):

```json
{
  "token": "<access-token-jwt>",
  "refreshToken": "<rotated-refresh-token>"
}
```

**Error Response** (401 Unauthorized): `INVALID_TOKEN` when the refresh token is unknown, expired, or
revoked. **Theft protection**: presenting a token that was already rotated (reuse) revokes **every**
refresh token for that user — all sessions must re-authenticate.

---

### Logout

**POST** `/auth/logout`

Revoke the presented refresh token. Does not require an access token, so a client with an expired
access token can still log out. Always responds 200 (no token-existence oracle).

**Rate Limit**: 60 requests per 15 minutes (per IP)

**Request Body**:

```json
{
  "refreshToken": "<refresh-token>"
}
```

**Response** (200 OK):

```json
{
  "message": "Logged out"
}
```

---

### Logout All Sessions

**POST** `/auth/logout-all`

Revoke **every** active refresh token for the authenticated user (e.g. "sign out of all devices").
Requires a valid access token.

**Auth**: `Authorization: Bearer <token>`

**Rate Limit**: 30 requests per minute (per IP)

**Response** (200 OK):

```json
{
  "message": "All sessions logged out",
  "count": 3
}
```

---

## Todos

All todo endpoints require authentication via JWT token in the `Authorization` header:

```
Authorization: Bearer <your-token>
```

### Get All Todos

**GET** `/todos`

**Rate Limit**: 100 requests per minute

**Query Parameters**:

| Parameter | Type   | Default | Description                                  |
| --------- | ------ | ------- | -------------------------------------------- |
| `limit`   | Number | `20`    | Number of todos to return (1-100)            |
| `cursor`  | String | --      | UUID of the last todo from the previous page |

**Response** (200 OK):

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "text": "Buy groceries",
      "done": false,
      "userId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "meta": {
    "nextCursor": "550e8400-e29b-41d4-a716-446655440001",
    "hasMore": true
  }
}
```

Todos are ordered by `createdAt` descending (newest first). When `hasMore` is `true`, pass `meta.nextCursor` as the `cursor` query parameter to fetch the next page.

---

### Create Todo

**POST** `/todos`

**Rate Limit**: 30 requests per minute

**Request Body**:

```json
{
  "text": "Buy groceries"
}
```

**Response** (201 Created):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Buy groceries",
  "done": false,
  "userId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

**Validation Rules**:

- Text: 1-500 characters, trimmed

---

### Get Single Todo

**GET** `/todos/:id`

**Rate Limit**: 100 requests per minute

**Response** (200 OK):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Buy groceries",
  "done": false,
  "userId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

**Error Response** (404 Not Found):

```json
{
  "error": {
    "code": "TODO_NOT_FOUND",
    "message": "Todo not found",
    "details": {
      "suggestion": "Verify the todo ID exists and belongs to you"
    }
  },
  "requestId": "abc123"
}
```

---

### Toggle Todo Status

**PATCH** `/todos/:id`

**Rate Limit**: 30 requests per minute

**Description**: Toggles the `done` status of a todo (true <> false)

**Response** (200 OK):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Buy groceries",
  "done": true,
  "userId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T11:00:00.000Z"
}
```

---

### Delete Todo

**DELETE** `/todos/:id`

**Rate Limit**: 30 requests per minute

**Response** (204 No Content): Empty body

**Error Response** (404 Not Found):

```json
{
  "error": {
    "code": "TODO_NOT_FOUND",
    "message": "Todo not found",
    "details": {
      "suggestion": "Verify the todo ID exists and belongs to you"
    }
  },
  "requestId": "abc123"
}
```

---

## User

Self-service account management. All `/user` endpoints require authentication via JWT in the
`Authorization` header.

### Get Current Profile

**GET** `/user/me`

**Rate Limit**: 100 requests per minute

**Response** (200 OK):

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "role": "user",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

`name` is `null` until set. The password hash and email blind index are never returned.

---

### Update Profile

**PATCH** `/user/me`

**Rate Limit**: 30 requests per minute

Update the display name. (Email is changed via its own endpoint — see **Change Email** — because it requires
re-authentication.)

**Request Body**:

```json
{
  "name": "Ada Lovelace"
}
```

**Response** (200 OK): the updated profile (same shape as `GET /user/me`).

**Validation Rules**:

- `name`: 1-100 characters, trimmed (required)

**Errors**: `400 VALIDATION_ERROR` (missing/invalid name).

---

### Change Email

**PATCH** `/user/me/email`

**Rate Limit**: 30 requests per minute

Changes the account email. **Requires the current password** (re-authentication against a stolen access
token). The email is re-encrypted at rest and its blind index rotated.

**Request Body**:

```json
{
  "email": "ada.new@example.com",
  "currentPassword": "CurrentPass123!"
}
```

**Response** (200 OK): the updated profile.

**Validation Rules**:

- `email`: valid email, max 72 characters (required)
- `currentPassword`: required

**Errors**: `400 VALIDATION_ERROR` (missing email/password), `401 INVALID_CREDENTIALS` (wrong current
password), `409 DUPLICATE_EMAIL` (email already in use).

---

### Change Password

**PATCH** `/user/me/password`

**Rate Limit**: 30 requests per minute

Verifies the current password, sets the new one, and **revokes every refresh token** for the user
(all devices must log in again). The current access token remains valid until it expires.

**Request Body**:

```json
{
  "currentPassword": "CurrentPass123!",
  "newPassword": "NewPass456!"
}
```

**Response** (200 OK):

```json
{
  "message": "Password changed. Please log in again."
}
```

**Validation Rules**:

- `newPassword`: 8-72 characters, must contain uppercase, lowercase, number, and special character

**Errors**: `400 VALIDATION_ERROR` (weak new password), `401 INVALID_CREDENTIALS` (wrong current password).

---

### Delete Account

**DELETE** `/user/me`

**Rate Limit**: 30 requests per minute

Verifies the current password, then permanently deletes the account. Todos and refresh tokens are
cascade-deleted; the deletion is recorded in the audit log (which is retained).

**Request Body**:

```json
{
  "currentPassword": "CurrentPass123!"
}
```

**Response** (204 No Content): Empty body

**Errors**: `401 INVALID_CREDENTIALS` (wrong current password).

---

### Export Data

**GET** `/user/me/export`

**Rate Limit**: 100 requests per minute

Returns the full profile plus every todo as a downloadable JSON attachment (data portability). The
access is recorded in the audit log.

**Response** (200 OK, `Content-Disposition: attachment; filename="todo-api-export-<userId>.json"`):

```json
{
  "user": {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "role": "user",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  },
  "todos": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "text": "Buy groceries",
      "done": false,
      "userId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

---

## Admin

Administrative user management. All `/admin` endpoints require authentication **and** the `admin` role.
Requests from a non-admin return `403 FORBIDDEN` and are recorded in the audit log.

### Roles & permissions

| Role    | Capabilities                                                                             |
| ------- | ---------------------------------------------------------------------------------------- |
| `user`  | Default. Full access to their own todos and profile (`/todos`, `/user/me`). No `/admin`. |
| `admin` | Everything a `user` can do for their own account, **plus** the `/admin` surface below.   |

Role is stored on the user (`users.role`, default `user`) and checked by a per-request lookup — it is
**not** carried in the JWT, so a role change takes effect immediately. The first admin is created out-of-band
with `scripts/promote-admin.ts` (see [operations.md](operations.md)); thereafter admins manage roles via
`PATCH /admin/users/:id/role`. An admin cannot change their own role or delete their own account through the
admin API (use `/user/me` for self-service).

### List Users

**GET** `/admin/users`

**Auth**: `Authorization: Bearer <token>` (admin) · **Rate Limit**: 100 requests per minute

**Query Parameters**: same as `GET /todos` — `limit` (1-100, default 20) and `cursor` (UUID).

**Response** (200 OK):

```json
{
  "data": [
    {
      "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "name": "Ada Lovelace",
      "email": "ada@example.com",
      "role": "user",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "meta": { "nextCursor": "…", "hasMore": true }
}
```

---

### Get User

**GET** `/admin/users/:id`

**Auth**: admin · **Rate Limit**: 100 requests per minute

**Response** (200 OK): a single user (same shape as a list row). `404 USER_NOT_FOUND` if the id does not exist.

---

### Change User Role

**PATCH** `/admin/users/:id/role`

**Auth**: admin · **Rate Limit**: 30 requests per minute

**Request Body**:

```json
{ "role": "admin" }
```

**Response** (200 OK): the updated user. **Errors**: `400 VALIDATION_ERROR` (role not `user`/`admin`),
`403 FORBIDDEN` (changing your own role), `404 USER_NOT_FOUND`.

---

### Delete User

**DELETE** `/admin/users/:id`

**Auth**: admin · **Rate Limit**: 30 requests per minute

Permanently deletes the target user; their todos and refresh tokens cascade-delete and the action is audited
(`admin.user.delete`).

**Response** (204 No Content). **Errors**: `403 FORBIDDEN` (deleting your own account), `404 USER_NOT_FOUND`.

---

## Health Check

Health check endpoints for monitoring and container orchestration. The liveness probe (`GET /health`) is **not rate limited**, so load balancers can always reach it. The readiness probes (`/health/ready` and `/health/ready/detailed`) are rate-limited at **60 requests/minute/IP** (`healthLimiter`) — generous for typical orchestrator probe intervals, but blocks abuse of the DB round-trip.

### Liveness Probe

**GET** `/health`

**Description**: Basic liveness check -- is the server running?

**Response** (200 OK):

```json
{
  "status": "ok",
  "timestamp": "2024-12-26T10:30:00.000Z",
  "uptime": 3600,
  "version": "1.0.0",
  "environment": "production"
}
```

---

### Readiness Probe (public)

**GET** `/health/ready`

**Description**: Readiness check -- is the server ready to handle traffic right now? Returns 503 when (a) PostgreSQL is unreachable or (b) the DB connection pool is saturated (every connection busy, pool fully grown, clients already queued). Memory and CPU pressure are reported as observational sub-checks on `/health/ready/detailed` but do not affect the readiness verdict — load average lingers after bursts and high heap doesn't mean the process can't serve requests (use the `/health` liveness probe for OOM-style concerns instead).

The database reachability check runs `SELECT 1` on a **dedicated single-connection pool** that is never shared with application traffic. This means probe latency is bounded by `DB_PROBE_TIMEOUT_MS` (default 1s) regardless of how saturated the application pool is, so successive probes can't drift past `failureThreshold × timeoutSeconds` under sustained load.

The public response is intentionally lean — the orchestrator only needs the HTTP code. Internals (pool, memory, CPU) live behind the authenticated `/health/ready/detailed` route below so unauthenticated callers cannot recon process-internal load.

**Response** (200 OK - Healthy):

```json
{
  "status": "ok",
  "timestamp": "2026-05-18T10:30:00.000Z"
}
```

**Response** (503 Service Unavailable - Degraded):

```json
{
  "status": "degraded",
  "timestamp": "2026-05-18T10:30:00.000Z"
}
```

The 503 response includes a `Retry-After` header — `5` seconds for pool saturation (recovers quickly), `30` seconds for an unreachable database. For operators who need to know _which_ condition tripped, hit `/health/ready/detailed`.

---

### Readiness Probe (authenticated, detailed)

**GET** `/health/ready/detailed`

**Auth**: bearer token via `Authorization: Bearer <METRICS_TOKEN>` — same gate as `GET /metrics`. Returns 401 without a token, 401 with a wrong token (constant-time compare).

**Description**: Same probe logic as `/health/ready`, but returns the full payload including database state, pool sizing, memory, and CPU. Intended for operators and dashboards, not for orchestrator probes.

**Response** (200 OK - Healthy):

```json
{
  "status": "ok",
  "timestamp": "2026-05-18T10:30:00.000Z",
  "uptime": 3600,
  "version": "1.0.0",
  "environment": "production",
  "checks": {
    "database": {
      "status": "ok",
      "state": "connected"
    },
    "memory": {
      "status": "ok",
      "heapUsed": "45.23 MB",
      "heapTotal": "68.50 MB",
      "heapUsedPercent": "66.0%",
      "rss": "92.15 MB",
      "external": "2.34 MB"
    },
    "cpu": {
      "status": "ok",
      "loadAverage": {
        "1m": "0.85",
        "5m": "1.20",
        "15m": "1.05"
      },
      "cpuCount": 8,
      "threshold": 8
    },
    "pool": {
      "status": "ok",
      "total": 4,
      "idle": 3,
      "waiting": 0,
      "max": 10,
      "utilization": "10.0%",
      "threshold": "80%"
    }
  }
}
```

**Response** (503 Service Unavailable - Degraded):

Returned when the database is unreachable **or** the DB pool is saturated. The body's sub-checks identify which condition tripped readiness — the example below shows pool saturation. The `Retry-After` header semantics are the same as the public endpoint.

```json
{
  "status": "degraded",
  "timestamp": "2026-05-18T10:30:00.000Z",
  "uptime": 3600,
  "version": "1.0.0",
  "environment": "production",
  "checks": {
    "database": { "status": "ok", "state": "connected" },
    "memory": { "status": "ok", "...": "..." },
    "cpu": { "status": "ok", "...": "..." },
    "pool": {
      "status": "error",
      "total": 10,
      "idle": 0,
      "waiting": 7,
      "max": 10,
      "utilization": "100.0%",
      "threshold": "80%"
    }
  }
}
```

**Check Thresholds**:

| Check      | Threshold                                                      | Sub-check status on breach | Affects readiness? |
| ---------- | -------------------------------------------------------------- | -------------------------- | ------------------ |
| PostgreSQL | `SELECT 1` query must succeed                                  | `error`                    | **Yes (503)**      |
| DB Pool    | `idle === 0` AND `total >= max` AND `waiting > 0` (saturation) | `error`                    | **Yes (503)**      |
| DB Pool    | Utilization ≥ 80% but not saturated                            | `warning`                  | No                 |
| Memory     | Heap usage < 90%                                               | `warning`                  | No                 |
| CPU        | 1-min load average < CPU count                                 | `warning`                  | No                 |

Only the rows marked **Yes** flip the overall body `status` to `"degraded"` and emit the `Health check - readiness probe failed` WARN log. Pool saturation responses include `Retry-After: 5` (recovers quickly as queries drain); DB-unreachable responses include `Retry-After: 30`.

**Kubernetes Configuration Example**:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3001
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

---

## Metrics

Prometheus-compatible metrics endpoint for monitoring and observability. This endpoint is **not rate limited** to ensure monitoring systems can always scrape it.

### Prometheus Metrics

**GET** `/metrics`

**Authentication**: When `METRICS_TOKEN` is set, requests must include `Authorization: Bearer <token>` — header only; a query-string token is **not** accepted (it would leak into access/proxy logs). When unset, the endpoint is unauthenticated — non-production only: in production `METRICS_TOKEN` is **required** (32+ chars) and startup aborts without it.

**Description**: Returns all application and process metrics in Prometheus text exposition format. Intended for scraping by Prometheus, Grafana Agent, or similar monitoring tools.

**Response** (200 OK):

Content-Type: `text/plain; version=0.0.4; charset=utf-8`

**Custom Application Metrics**:

| Metric                            | Type      | Labels                           | Description                                                                  |
| --------------------------------- | --------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `http_request_duration_seconds`   | Histogram | `method`, `route`, `status_code` | Duration of HTTP requests in seconds                                         |
| `http_requests_total`             | Counter   | `method`, `route`, `status_code` | Total number of HTTP requests                                                |
| `rate_limit_hits_total`           | Counter   | `limiter_type`                   | Total number of rate limit hits                                              |
| `rate_limit_store_fallback_total` | Counter   | `limiter_type`                   | Rate-limit checks served by the in-memory fallback store (Redis unavailable) |
| `db_query_duration_seconds`       | Histogram | `operation`, `model`             | Duration of database queries in seconds                                      |
| `active_connections`              | Gauge     | --                               | Number of active HTTP connections                                            |
| `audit_write_failures_total`      | Counter   | `reason`                         | Audit-log writes that failed outside a `$transaction` (auth events)          |
| `db_pool_total_connections`       | Gauge     | --                               | Total connections currently held by the pool (idle + checked out)            |
| `db_pool_idle_connections`        | Gauge     | --                               | Connections sitting idle in the pool                                         |
| `db_pool_waiting_clients`         | Gauge     | --                               | Clients waiting for a connection because the pool is saturated               |
| `db_pool_max_connections`         | Gauge     | --                               | Configured pool maximum (`DB_POOL_MAX`)                                      |

**Default Node.js Metrics** (via `prom-client`):

| Metric                           | Type            | Description                                  |
| -------------------------------- | --------------- | -------------------------------------------- |
| `process_cpu_*_seconds_total`    | Counter         | CPU time (user, system, total)               |
| `process_resident_memory_bytes`  | Gauge           | Resident memory size                         |
| `nodejs_heap_size_*_bytes`       | Gauge           | Heap memory (total, used, external)          |
| `nodejs_eventloop_lag_*_seconds` | Gauge/Histogram | Event loop lag (min, max, mean, percentiles) |
| `nodejs_gc_duration_seconds`     | Histogram       | Garbage collection duration by kind          |
| `nodejs_active_resources`        | Gauge           | Active async resources by type               |
| `nodejs_version_info`            | Gauge           | Node.js version                              |

All metrics include the default label `service="todo-api"`.

**Example**:

```bash
curl http://localhost:3001/metrics
```

**Prometheus Scrape Configuration**:

```yaml
scrape_configs:
  - job_name: 'todo-api'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: /metrics
```

---

## Echo (benchmark)

**GET/POST** `/echo`

Benchmark-only echo routes, mounted **only when `ENABLE_ECHO_ROUTES=true`** (default: `true` outside
production, `false` in production — enabling in production additionally requires
`ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM=true`). They bypass logging and rate limiting, so they must
never be exposed on a process serving real traffic. Used to isolate framework overhead — see
[benchmarks.md](benchmarks.md).

---

## Error Responses

All error responses follow a structured format with error codes for client-side handling:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "suggestion": "Actionable advice for resolving the error"
    }
  },
  "requestId": "unique-request-id"
}
```

### Validation Error (400 Bad Request)

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": {
      "fields": [
        {
          "field": "password",
          "message": "Password must contain uppercase, lowercase, number and special character"
        }
      ]
    }
  },
  "requestId": "abc123"
}
```

### Authentication Error (401 Unauthorized)

```json
{
  "error": {
    "code": "INVALID_TOKEN",
    "message": "Invalid or expired token",
    "details": {
      "suggestion": "Please log in again to get a new token"
    }
  },
  "requestId": "abc123"
}
```

### Not Found Error (404 Not Found)

```json
{
  "error": {
    "code": "TODO_NOT_FOUND",
    "message": "Todo not found",
    "details": {
      "suggestion": "Verify the todo ID exists and belongs to you"
    }
  },
  "requestId": "abc123"
}
```

### Rate Limit Error (429 Too Many Requests)

```json
{
  "error": "Too many requests. Please slow down."
}
```

### Service Unavailable (503)

```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Service temporarily unavailable",
    "details": {
      "suggestion": "Please try again later",
      "retryable": true
    }
  },
  "requestId": "abc123"
}
```

503 responses also carry a `Retry-After` header (seconds) — `30` for an unreachable database (`code: DATABASE_UNAVAILABLE`), `5` for transient pool-pressure errors. Errors with `"retryable": true` in the details are safe to retry with exponential backoff; respect `Retry-After` as the minimum wait. The `DATABASE_UNAVAILABLE` code is emitted when Prisma surfaces a transient connection error (codes P1001/P1002/P1008/P1017) or pool timeout (P2024).

### Error Codes Reference

| Code                     | HTTP Status | Description                                                             |
| ------------------------ | ----------- | ----------------------------------------------------------------------- |
| `INVALID_CREDENTIALS`    | 401         | Wrong email or password                                                 |
| `NO_TOKEN`               | 401         | No authentication token provided                                        |
| `INVALID_TOKEN`          | 401         | Token is invalid or expired                                             |
| `TODO_NOT_FOUND`         | 404         | Todo does not exist or belongs to another user                          |
| `USER_NOT_FOUND`         | 404         | Authenticated user's account no longer exists                           |
| `FORBIDDEN`              | 403         | Authenticated but not authorized (e.g. admin role required)             |
| `ROUTE_NOT_FOUND`        | 404         | API endpoint does not exist                                             |
| `DUPLICATE_EMAIL`        | 409         | Email already registered                                                |
| `DUPLICATE_VALUE`        | 409         | Unique constraint violation                                             |
| `VALIDATION_ERROR`       | 400         | Request failed Joi validation (`details.fields` lists per-field errors) |
| `INVALID_ID_FORMAT`      | 400         | Invalid UUID format                                                     |
| `INVALID_JSON`           | 400         | Request body contains invalid JSON                                      |
| `PAYLOAD_TOO_LARGE`      | 413         | Request body exceeds the configured `BODY_LIMIT` (default 16kb)         |
| `FOREIGN_KEY_CONSTRAINT` | 409.        | Foreign-key constraint violation                                        |
| `SERVICE_UNAVAILABLE`    | 503         | Generic transient unavailability — retry with `Retry-After`             |
| `DATABASE_UNAVAILABLE`   | 503         | Database unreachable or pool exhausted — retry with `Retry-After`       |
| `INTERNAL_ERROR`         | 500         | Unexpected server error                                                 |

### Status Codes

| Code    | Meaning               | Usage                                     |
| ------- | --------------------- | ----------------------------------------- |
| **200** | OK                    | Successful GET, PATCH requests            |
| **201** | Created               | Successful POST (resource created)        |
| **204** | No Content            | Successful DELETE                         |
| **400** | Bad Request           | Validation errors, invalid data           |
| **401** | Unauthorized          | Invalid/missing token, wrong credentials  |
| **404** | Not Found             | Resource doesn't exist                    |
| **409** | Conflict              | Unique constraint violation               |
| **413** | Payload Too Large     | Request body exceeds `BODY_LIMIT`         |
| **429** | Too Many Requests     | Rate limit exceeded                       |
| **500** | Internal Server Error | Server-side errors (not retryable)        |
| **503** | Service Unavailable   | Database unavailable, health check failed |
