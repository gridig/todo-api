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
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Validation Rules**:

- Email: Valid format, max 72 characters
- Password: 8-72 characters, must contain uppercase, lowercase, number, and special character

---

### Login

**POST** `/auth/login`

**Rate Limit**: 3 failed attempts per 15 minutes

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
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
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

## Health Check

Health check endpoints for monitoring and container orchestration. These endpoints are **not rate limited** to ensure load balancers can always reach them.

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

### Readiness Probe

**GET** `/health/ready`

**Description**: Comprehensive readiness check -- is the server ready to handle requests? Checks PostgreSQL connection, memory usage, and CPU load.

**Response** (200 OK - Healthy):

```json
{
  "status": "ok",
  "timestamp": "2024-12-26T10:30:00.000Z",
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
    }
  }
}
```

**Response** (503 Service Unavailable - Degraded):

```json
{
  "status": "degraded",
  "timestamp": "2024-12-26T10:30:00.000Z",
  "uptime": 3600,
  "version": "1.0.0",
  "environment": "production",
  "checks": {
    "database": {
      "status": "error",
      "state": "disconnected"
    },
    "memory": { "status": "ok", "...": "..." },
    "cpu": { "status": "ok", "...": "..." }
  }
}
```

**Check Thresholds**:

| Check      | Threshold                      | Status on Failure |
| ---------- | ------------------------------ | ----------------- |
| PostgreSQL | `SELECT 1` query must succeed  | `error`           |
| Memory     | Heap usage < 90%               | `warning`         |
| CPU        | 1-min load average < CPU count | `warning`         |

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

**Authentication**: Optional. When `METRICS_TOKEN` is set, requests must include `Authorization: Bearer <token>` or `?token=<token>`. When unset, the endpoint is unauthenticated.

**Description**: Returns all application and process metrics in Prometheus text exposition format. Intended for scraping by Prometheus, Grafana Agent, or similar monitoring tools.

**Response** (200 OK):

Content-Type: `text/plain; version=0.0.4; charset=utf-8`

**Custom Application Metrics**:

| Metric                          | Type      | Labels                           | Description                             |
| ------------------------------- | --------- | -------------------------------- | --------------------------------------- |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Duration of HTTP requests in seconds    |
| `http_requests_total`           | Counter   | `method`, `route`, `status_code` | Total number of HTTP requests           |
| `rate_limit_hits_total`         | Counter   | `limiter_type`                   | Total number of rate limit hits         |
| `db_query_duration_seconds`     | Histogram | `operation`, `model`             | Duration of database queries in seconds |
| `active_connections`            | Gauge     | --                               | Number of active HTTP connections       |

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
  "error": [
    {
      "field": "password",
      "message": "Password must contain uppercase, lowercase, number and special character"
    }
  ]
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

Errors with `"retryable": true` in the details are safe to retry with exponential backoff.

### Error Codes Reference

| Code                  | HTTP Status | Description                                    |
| --------------------- | ----------- | ---------------------------------------------- |
| `INVALID_CREDENTIALS` | 401         | Wrong email or password                        |
| `NO_TOKEN`            | 401         | No authentication token provided               |
| `INVALID_TOKEN`       | 401         | Token is invalid or expired                    |
| `TODO_NOT_FOUND`      | 404         | Todo does not exist or belongs to another user |
| `ROUTE_NOT_FOUND`     | 404         | API endpoint does not exist                    |
| `DUPLICATE_EMAIL`     | 409         | Email already registered                       |
| `DUPLICATE_VALUE`     | 409         | Unique constraint violation                    |
| `INVALID_ID_FORMAT`   | 400         | Invalid UUID format                            |
| `INVALID_JSON`        | 400         | Request body contains invalid JSON             |
| `INTERNAL_ERROR`      | 500         | Unexpected server error                        |

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
| **429** | Too Many Requests     | Rate limit exceeded                       |
| **500** | Internal Server Error | Server-side errors (not retryable)        |
| **503** | Service Unavailable   | Database unavailable, health check failed |
