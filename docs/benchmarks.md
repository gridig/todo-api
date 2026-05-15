# Benchmark Methodology

This document describes the load testing and benchmarking infrastructure for the Todo API. It covers how to run benchmarks, what they measure, and how to interpret the results.

## Prerequisites

- **k6** v1.6+ installed (`brew install k6`)
- **Docker** and Docker Compose (for container startup benchmarks)
- **PostgreSQL** running and accessible
- The API server running with `DISABLE_RATE_LIMIT=true`

## Quick Start

```bash
# 1. Seed the benchmark database
pnpm bench:seed

# 2. Start the server with rate limiting disabled
DISABLE_RATE_LIMIT=true pnpm run dev

# 3. Run all benchmarks
pnpm bench:all
```

## Benchmark Modes

### Framework Overhead (`bench:echo`)

Hits the `GET /echo` endpoint which returns static JSON. This endpoint bypasses request logging, CORS, rate limiting, JSON body parsing, authentication, and validation. Only the request ID and metrics middleware are active.

**What it measures:** Express routing, middleware dispatch, JSON serialization, and Node.js HTTP overhead in isolation. The response is fully static (`{ "message": "echo" }`) with no dynamic computation.

### Application Performance (`bench:app`)

Authenticates once in `setup()`, then runs a mixed workload per iteration:

1. `GET /todos` — list all todos for the benchmark user
2. `POST /todos` — create a new todo
3. `PATCH /todos/:id` — toggle the created todo
4. `DELETE /todos/:id` — delete the created todo

**What it measures:** Full request lifecycle including JWT verification, Joi validation, Prisma ORM queries, PostgreSQL round-trips, and all middleware.

## Load Levels

Each load level targets a different behavior regime. The level is selected via the `LOAD_LEVEL` environment variable.

| Level    | Target RPS | VUs | Duration | What It Reveals                             |
| -------- | ---------- | --- | -------- | ------------------------------------------- |
| low      | 10         | 10  | 60s      | Baseline latency. Differences are noise.    |
| medium   | 300        | 50  | 60s      | Framework overhead becomes visible.         |
| high     | 1000       | 200 | 60s      | Database saturation dominates.              |
| overload | 3000       | 500 | 60s      | Degradation curve, error rates, resilience. |

Each level is preceded by a **30-second warm-up phase** (10 VUs, constant rate) to allow V8 JIT compilation to stabilize. Warm-up metrics are tagged with `phase:warmup` and excluded from threshold evaluation. Only the `phase:load` data is used for pass/fail decisions.

Thresholds are per-level. Lower levels have tighter latency requirements; the overload level has no thresholds since its purpose is to observe degradation, not pass/fail. When running the full suite (`pnpm bench:all`), a 10-second cooldown separates each run to allow connection pools and GC to settle.

## Metrics Recorded

### Client-Side (k6)

Recorded automatically by k6 and written to JSON result files:

- **Latency:** p50, p95, p99 (aggregate `http_req_duration` + per-endpoint custom trends)
- **Throughput:** Actual achieved requests per second
- **Error rate:** Percentage of non-2xx responses
- **Per-operation latency:** Separate trends for login, list, create, toggle, delete

### Server-Side (Prometheus scrape)

After each benchmark run, `run.sh` scrapes `GET /metrics` and saves the Prometheus snapshot. Key metrics captured:

| Metric                          | Description                                    |
| ------------------------------- | ---------------------------------------------- |
| `process_cpu_seconds_total`     | Total CPU time consumed by the Node.js process |
| `process_resident_memory_bytes` | RSS memory                                     |
| `nodejs_heap_size_used_bytes`   | V8 heap in use                                 |
| `nodejs_heap_size_total_bytes`  | V8 heap allocated                              |
| `http_request_duration_seconds` | Server-measured request latency histogram      |
| `db_query_duration_seconds`     | Database query latency histogram               |
| `active_connections`            | Concurrent HTTP connections gauge              |

Comparing Prometheus snapshots between the start and end of a run gives you delta CPU usage and peak memory.

## Cold Start Measurement

### Process Cold Start

Measures time from k6 script start to the first successful `GET /health/ready` response, polling every 500ms.

```bash
# Start the server in another terminal, then immediately run:
pnpm bench:cold-start
```

### Container Cold Start

Measures time from `docker compose up -d app` to first successful `GET /health/ready` response, polling every 100ms. Builds the image, waits for PostgreSQL readiness via `pg_isready`, then times only the app container startup. The script uses cross-platform millisecond timing (GNU `date`, `python3`, or BSD `date`) and cleans up containers on exit.

```bash
bash benchmarks/container-startup.sh
```

## Pre-Benchmark Verification

Run these before recording any official numbers. They validate that the benchmarking conditions are fair.

### SQL Query Equivalence

```bash
pnpm bench:explain
```

Runs `EXPLAIN ANALYZE` on the three core query patterns using real IDs from the seed data (requires `pnpm bench:seed` first):

1. **`findByUser`** — `SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC`
2. **`findOne`** — `SELECT * FROM todos WHERE id = ? AND user_id = ? LIMIT 1`
3. **`findByEmail`** — `SELECT id, email, password FROM users WHERE email = ? LIMIT 1`

When comparing against alternative implementations, run the same queries through the other ORM and verify the query plans are comparable. If they diverge significantly, document the difference.

### bcrypt Parity

```bash
pnpm bench:bcrypt
```

Runs a warm-up iteration followed by 10 timed iterations of bcrypt hash + compare with 10 salt rounds and reports avg/min/max in milliseconds. Since bcrypt work happens in C (libcrypt), wall-clock time should be nearly identical across language runtimes. Significant deviation indicates a library issue or missing thread offloading.

### Rate Limiting

All rate limiters must be disabled during benchmarks. Start the server with:

```bash
DISABLE_RATE_LIMIT=true pnpm run dev
```

The runner script (`run.sh`) does not set this automatically — it must be configured on the server process. If rate limiting is left enabled, the global limiter (200 requests / 15 minutes) will throttle the benchmark within seconds.

## Running Individual Benchmarks

```bash
# Framework overhead at a specific level
k6 run --env LOAD_LEVEL=high benchmarks/k6/framework-overhead.js

# Application performance at a specific level
k6 run --env LOAD_LEVEL=low benchmarks/k6/application-performance.js

# Custom target URL
k6 run --env BASE_URL=http://staging:3001 --env LOAD_LEVEL=medium benchmarks/k6/framework-overhead.js

# Override benchmark user credentials
k6 run --env BENCH_USER_EMAIL=custom@example.com --env BENCH_USER_PASSWORD='Pass1!' --env LOAD_LEVEL=medium benchmarks/k6/application-performance.js
```

## Seed Data

```bash
pnpm bench:seed
```

Creates 10 users (`benchuser0@example.com` through `benchuser9@example.com`) each with 50 todos (500 total). Password for all users: `BenchPass1!`. The script cleans all existing data before seeding to ensure a consistent starting state.

The application performance benchmark authenticates as `benchuser0@example.com` by default.

## Results

JSON results are written to `benchmarks/results/` (git-ignored). Each full run produces:

| File Pattern                           | Contents                                    |
| -------------------------------------- | ------------------------------------------- |
| `framework-overhead-{level}.json`      | k6 summary for echo endpoint benchmarks     |
| `application-performance-{level}.json` | k6 summary for full API benchmarks          |
| `{mode}-{level}-server-metrics.txt`    | Prometheus snapshot captured after each run |

## Reproducing Results

For valid comparisons, all environment details must be documented. The benchmark runner (`pnpm bench:all`) prints these automatically at the start of each run.

| Component  | How to Check                                                    |
| ---------- | --------------------------------------------------------------- |
| Node.js    | `node --version`                                                |
| Express    | `package.json` dependencies                                     |
| Prisma     | `package.json` dependencies                                     |
| PostgreSQL | `psql --version` or `docker exec todo-postgres psql --version`  |
| k6         | `k6 version`                                                    |
| OS         | `uname -srm`                                                    |
| CPU        | `sysctl -n machdep.cpu.brand_string` (macOS) or `lscpu` (Linux) |
| CPU cores  | `sysctl -n hw.ncpu` (macOS) or `nproc` (Linux)                  |
| RAM        | `sysctl -n hw.memsize` (macOS) or `free -h` (Linux)             |
| Docker     | `docker --version`                                              |

## Fair Comparison Notes

When comparing against alternative implementations (e.g., Python/FastAPI, Go):

1. **Same database** — share the PostgreSQL instance and seed data
2. **Same pool size** — configure identical connection pool settings across implementations
3. **Same hardware** — run on the same machine or identical cloud instances in the same region
4. **Disable rate limiting** — in all implementations being compared
5. **Warm-up period** — 30 seconds before measurement (accounts for V8 JIT; CPython does not need warm-up, so including it slightly favors Python)
6. **Verify query equivalence** — run `EXPLAIN ANALYZE` on each ORM's generated queries
7. **Verify bcrypt parity** — wall-clock time should match across runtimes since the work is in C
8. **Process count normalization** — run both single-process and production-config comparisons and label them clearly

## Available Scripts

| Script                  | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `pnpm bench:seed`       | Seed the database with benchmark data            |
| `pnpm bench:echo`       | Framework overhead benchmark (medium level)      |
| `pnpm bench:app`        | Application performance benchmark (medium level) |
| `pnpm bench:all`        | Full benchmark suite (all levels, both modes)    |
| `pnpm bench:cold-start` | Process cold start measurement                   |
| `pnpm bench:explain`    | Run EXPLAIN ANALYZE on core queries              |
| `pnpm bench:bcrypt`     | bcrypt hash+compare timing verification          |

## Benchmark Results

Results from a local run on macOS (single Node.js process, PostgreSQL). Raw data lives in the JSON files under `benchmarks/results/`. All times are in milliseconds unless noted otherwise.

### Framework Overhead

Hits `GET /echo` (static JSON, minimal middleware). Measures pure Express routing and serialization cost.

| Metric             | Low      | Medium   | High     | Overload  |
| ------------------ | -------- | -------- | -------- | --------- |
| Total Requests     | 917,713  | 944,109  | 982,631  | 1,087,078 |
| Throughput (req/s) | 10,197   | 10,490   | 10,919   | 12,079    |
| Avg Latency        | 0.30     | 0.30     | 0.30     | 0.27      |
| Median             | 0.23     | 0.24     | 0.24     | 0.22      |
| p95                | 0.51     | 0.51     | 0.51     | 0.51      |
| Max                | 76.66    | 36.49    | 13.73    | 27.75     |
| Error Rate         | 0%       | 0%       | 0%       | 0%        |
| Thresholds         | All pass | All pass | All pass | All pass  |

Express + middleware pipeline adds sub-millisecond latency at all load levels, sustaining 10K-12K req/s. The framework is not the bottleneck.

### Application Performance

Each iteration runs an authenticated CRUD workflow: `GET /todos`, `POST /todos`, `PATCH /todos/:id`, `DELETE /todos/:id` (4 HTTP requests per iteration).

#### Overall HTTP Metrics

| Metric              | Low    | Medium  | High    | Overload |
| ------------------- | ------ | ------- | ------- | -------- |
| Total Requests      | 55,445 | 126,617 | 118,081 | 91,513   |
| Throughput (req/s)  | 615    | 1,402   | 1,304   | 996      |
| Iterations (iter/s) | 154    | 351     | 326     | 249      |
| Avg Latency         | 5.63   | 4.17    | 205.32  | 646.12   |
| Median              | 5.19   | 1.92    | 186.30  | 7.59     |
| p95                 | 8.78   | 8.29    | 666.52  | 2,728.06 |
| Max                 | 163.16 | 338.89  | 957.30  | 4,451.82 |
| Error Rate          | 0%     | 0%      | 0%      | 0%       |
| Check Pass Rate     | 100%   | 100%    | 100%    | 100%     |
| Dropped Iterations  | 0      | 49      | 44,249  | 170,241  |

#### Per-Endpoint Latency

**List Todos (GET /todos)**

|     | Low  | Medium | High   | Overload |
| --- | ---- | ------ | ------ | -------- |
| avg | 4.44 | 3.44   | 127.83 | 409.73   |
| med | 4.20 | 1.47   | 182.07 | 5.45     |
| p95 | 6.98 | 5.76   | 277.86 | 1,232.69 |

**Create Todo (POST /todos)**

|     | Low  | Medium | High   | Overload |
| --- | ---- | ------ | ------ | -------- |
| avg | 4.76 | 3.39   | 121.74 | 380.75   |
| med | 4.64 | 1.36   | 178.60 | 5.69     |
| p95 | 6.65 | 6.25   | 271.35 | 1,158.93 |

**Toggle Todo (PATCH /todos/:id)**

|     | Low   | Medium | High   | Overload |
| --- | ----- | ------ | ------ | -------- |
| avg | 7.61  | 5.78   | 341.86 | 1,075.15 |
| med | 7.31  | 2.48   | 543.12 | 8.82     |
| p95 | 10.40 | 9.69   | 740.16 | 3,272.01 |

**Delete Todo (DELETE /todos/:id)**

|     | Low  | Medium | High   | Overload |
| --- | ---- | ------ | ------ | -------- |
| avg | 5.69 | 4.07   | 229.85 | 718.89   |
| med | 5.29 | 1.90   | 357.76 | 7.19     |
| p95 | 8.19 | 7.68   | 502.69 | 2,208.68 |

### Threshold Results

| Threshold      | Low                  | Medium               | High                       | Overload |
| -------------- | -------------------- | -------------------- | -------------------------- | -------- |
| p(50) < target | PASS (5.9ms < 50ms)  | PASS (1.2ms < 100ms) | **FAIL** (323.8ms > 200ms) | N/A      |
| p(95) < target | PASS (8.8ms < 200ms) | PASS (6.6ms < 500ms) | PASS (705ms < 1000ms)      | N/A      |
| p(99) < target | PASS                 | PASS                 | PASS                       | N/A      |
| Error rate     | PASS (0% < 1%)       | PASS (0% < 1%)       | PASS (0% < 5%)             | N/A      |

The only failure is the p50 threshold at the high load level. The median request duration during the load phase was 323.8ms, exceeding the 200ms target. All other thresholds pass across every level.

### Key Findings

1. **Saturation point is ~1,300-1,400 req/s for authenticated CRUD.** At medium load (300 iter/s target) the system comfortably sustains 1,402 req/s with sub-10ms latencies. At high load (1,000 iter/s target) actual throughput drops to 1,304 req/s -- lower than medium -- indicating the system has hit its ceiling.
2. **Bimodal latency distribution under overload.** Median latencies remain low (5-9ms) but p95 climbs to 1-3 seconds. Many requests complete quickly while others queue behind saturated database connections. 88% of target iterations were dropped because the system could not keep up.
3. **Toggle (PATCH) is the slowest operation in these results.** Consistently 1.5-3x slower than other endpoints across all load levels. These benchmarks were recorded when toggle, update, and delete all used two-query transactions (find + mutate). All three have since been converted to single `UPDATE/DELETE...RETURNING` raw queries, so this gap is expected to narrow in subsequent runs.
4. **Zero HTTP errors at all load levels.** The API never returns non-2xx responses even under extreme load. It degrades by increasing latency rather than failing, which is desirable production behavior.
5. **Framework overhead is negligible.** Express middleware adds ~0.3ms per request at 10K-12K req/s. Application latency at low load is ~5ms, meaning the database accounts for roughly 95% of request time.
6. **Database is the bottleneck.** The 40x latency gap between `/echo` (0.3ms) and authenticated CRUD (5ms+) confirms that Prisma + PostgreSQL round-trips dominate. Under high concurrency the database saturates first.

### Potential Optimizations

- **Connection pool tuning** -- verify PgBouncer or Prisma connection pool size is appropriate for the VU count. Connection exhaustion is the most likely cause of the latency cliff between medium and high load.
- **Read caching for GET /todos** -- a short-lived cache (Redis or in-memory, 1-2s TTL) on the list endpoint would reduce database load significantly since it is called every iteration.
- **Composite index on (userId, id)** -- verify this index exists on the todo table; every authenticated query filters by both columns.

> **Note:** Single-query conversion for `PATCH`, `PUT`, and `DELETE` (toggle, update, delete) has been implemented since these results were recorded. All three now use a single `UPDATE/DELETE...RETURNING` raw query instead of a two-query transaction. Re-run benchmarks to measure the impact.
