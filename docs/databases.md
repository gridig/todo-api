# Database Extension Feasibility Analysis

## Verdict

**Add both TimescaleDB and Elasticsearch.**

- **TimescaleDB** — Postgres extension, textbook fit for audit logs, directly supports SOC 2 roadmap, one-line Docker image swap.
- **Elasticsearch** — Required for multi-entity search (todos + comments + attachments + notes), faceted filtering, relevance tuning, synonyms, and natural language queries. `pg_trgm` serves as an interim step for basic todo-only search.

---

## Elasticsearch Analysis

### Use Case Fit

The API will support multi-entity search across todos, comments, attachments, and notes. This requires:

- **Cross-entity search** — single query spanning multiple document types with unified ranking
- **Faceted filtering** — results grouped by entity type, status, date range, tags
- **Relevance tuning** — boosting exact matches, recent items, frequently accessed items
- **Fuzzy matching** — typo tolerance across all searchable fields
- **Synonyms** — "groceries" matches "shopping", domain-specific term mapping
- **Natural language queries** — "tasks I added last week" with intent parsing
- **Autocomplete / suggest-as-you-type** — custom analyzers per field
- **Highlighting** — return matched fragments with emphasis markers

These requirements exceed what Postgres can handle efficiently. `pg_trgm` works for basic single-entity substring search but breaks down with cross-entity queries, custom analyzers, and faceted results.

### Phased Approach: pg_trgm → Elasticsearch

**Phase 1 — `pg_trgm` (interim, todo-only search):**

Migration:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_todo_text_trgm ON "Todo" USING GIN (text gin_trgm_ops);
```

Query:

```typescript
const results = await prisma.$queryRaw`
  SELECT * FROM "Todo"
  WHERE "userId" = ${userId}
    AND similarity(text, ${searchTerm}) > 0.3
  ORDER BY similarity(text, ${searchTerm}) DESC
  LIMIT ${limit}
`;
```

This provides basic fuzzy search immediately with zero infrastructure cost. It remains useful as a fallback when ES is unavailable.

**Phase 2 — Elasticsearch (multi-entity search):**

When comments, attachments, and notes entities are added, migrate search to ES. The `pg_trgm` index stays as a degraded-mode fallback.

### Index Design

```json
{
  "settings": {
    "analysis": {
      "analyzer": {
        "todo_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "synonym_filter", "asciifolding"]
        },
        "autocomplete_analyzer": {
          "type": "custom",
          "tokenizer": "edge_ngram_tokenizer",
          "filter": ["lowercase"]
        }
      },
      "tokenizer": {
        "edge_ngram_tokenizer": {
          "type": "edge_ngram",
          "min_gram": 2,
          "max_gram": 15,
          "token_chars": ["letter", "digit"]
        }
      },
      "filter": {
        "synonym_filter": {
          "type": "synonym",
          "synonyms": ["groceries,shopping", "meeting,appointment"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "entity_type": { "type": "keyword" },
      "user_id": { "type": "keyword" },
      "text": {
        "type": "text",
        "analyzer": "todo_analyzer",
        "fields": {
          "autocomplete": {
            "type": "text",
            "analyzer": "autocomplete_analyzer"
          },
          "exact": { "type": "keyword" }
        }
      },
      "done": { "type": "boolean" },
      "created_at": { "type": "date" },
      "updated_at": { "type": "date" },
      "metadata": { "type": "object", "enabled": false }
    }
  }
}
```

A single index with an `entity_type` field (todo, comment, attachment, note) keeps cross-entity search in one query. Separate indices per entity are an option if they grow to very different sizes or need independent scaling.

### Sync Strategy

| Strategy                    | Consistency                               | Complexity                 | Failure Mode                          |
| --------------------------- | ----------------------------------------- | -------------------------- | ------------------------------------- |
| Dual-write                  | Eventual (can diverge on partial failure) | Medium                     | Data inconsistency if one write fails |
| CDC (Debezium)              | Eventual (~seconds lag)                   | High (Kafka/Connect infra) | Infra failure = stale index           |
| Async sync (background job) | Eventual (~minutes lag)                   | Low                        | Missed changes, polling load          |

**Recommended: Dual-write with outbox pattern.**

The app writes to Postgres (source of truth) and enqueues an event to an outbox table in the same transaction. A background worker reads the outbox and syncs to ES. This gives transactional guarantees on the Postgres side while tolerating ES downtime:

```typescript
// Inside a Prisma transaction
await prisma.$transaction(async (tx) => {
  const todo = await tx.todo.create({ data: { text, userId } });
  await tx.searchOutbox.create({
    data: {
      entityType: 'todo',
      entityId: todo.id,
      operation: 'index',
      payload: todo,
    },
  });
  return todo;
});
```

A worker polls the outbox, indexes into ES, and deletes processed entries.

### Failure Handling

- **ES down:** Search endpoint returns results from `pg_trgm` fallback with a header indicating degraded mode. CRUD operations are unaffected — Postgres is the source of truth.
- **Sync lag:** Search results may be stale by seconds/minutes. Acceptable for this use case. The API can return a `X-Search-Freshness` header with the last sync timestamp.
- **Outbox backlog:** Monitor outbox table size. Alert if it exceeds a threshold (e.g., 10K unprocessed entries). Worker retries with exponential backoff.

### Docker Compose

```yaml
elasticsearch:
  image: docker.elastic.co/elasticsearch/elasticsearch:8.17.0
  container_name: todo-elasticsearch
  environment:
    - discovery.type=single-node
    - xpack.security.enabled=false
    - 'ES_JAVA_OPTS=-Xms512m -Xmx512m'
  ports:
    - '9200:9200'
  volumes:
    - elasticsearch_data:/usr/share/elasticsearch/data
  healthcheck:
    test: ['CMD-SHELL', 'curl -f http://localhost:9200/_cluster/health || exit 1']
    interval: 10s
    timeout: 5s
    retries: 5
```

### Meilisearch / Typesense as Alternatives

|                        | Elasticsearch                           | Meilisearch             | Typesense                |
| ---------------------- | --------------------------------------- | ----------------------- | ------------------------ |
| Multi-entity search    | Full support                            | Supported (multi-index) | Supported (multi-search) |
| Custom analyzers       | Full control                            | Limited                 | Limited                  |
| Synonym support        | Yes                                     | Yes                     | Yes                      |
| Faceted filtering      | Yes                                     | Yes                     | Yes                      |
| Relevance tuning       | Full control (function_score, boosting) | Limited (ranking rules) | Moderate (overrides)     |
| Operational complexity | High (JVM, cluster mgmt)                | Low (single binary)     | Low (single binary)      |
| Ecosystem / community  | Massive                                 | Growing                 | Growing                  |
| Learning value         | Highest (industry standard)             | Moderate                | Moderate                 |

Meilisearch or Typesense would be simpler to operate, but Elasticsearch provides the deepest learning and the most control over relevance tuning. For a learning project focused on depth, ES is the right choice.

---

## TimescaleDB Analysis

### Why TimescaleDB Over Native Time-Series Databases

TimescaleDB is a Postgres extension, not a standalone time-series database. There are purpose-built alternatives — here's why TimescaleDB is the right choice for audit logs, and how it fits alongside the existing Prometheus setup.

**Native time-series databases:**

| Database            | Architecture                      | Query Language      | Best For                                                                 |
| ------------------- | --------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| **InfluxDB**        | Standalone, custom storage engine | Flux / InfluxQL     | Metrics, IoT sensor data, high-frequency numeric data (100K+ writes/sec) |
| **Prometheus**      | Standalone, pull-based collection | PromQL              | Infrastructure monitoring, alerting, metrics scraping                    |
| **ClickHouse**      | Standalone, column-oriented       | SQL (dialect)       | Analytics on billions of rows, OLAP, log aggregation at massive scale    |
| **QuestDB**         | Standalone, custom storage engine | SQL (subset)        | High-throughput ingestion (millions/sec), financial tick data            |
| **VictoriaMetrics** | Standalone, Prometheus-compatible | MetricsQL           | Long-term Prometheus storage, high-cardinality metrics                   |
| **TimescaleDB**     | Postgres extension                | Full PostgreSQL SQL | Time-series data that coexists with relational data, moderate scale      |

**Why these alternatives don't fit for audit logs:**

- **Prometheus** — already in the stack (`prom-client` 15.1.3, `/metrics` endpoint with `http_request_duration_seconds`, `http_requests_total`, `db_query_duration_seconds`, `rate_limit_hits_total`, `active_connections`). Prometheus is designed for numeric metrics, not structured event logs. It answers "what is the request latency P95 right now?" not "which user deleted todo X at 3:42 PM and from what IP?" Audit events have UUIDs, JSONB metadata, foreign keys — Prometheus has no concept of these. **Prometheus stays for metrics. TimescaleDB handles audit events. Different data, different tools.**

- **InfluxDB / VictoriaMetrics** — same limitation as Prometheus: designed for numeric time-series (gauges, counters, histograms), not rich structured events. Would force flattening audit data into tag/field pairs, losing queryability.

- **ClickHouse** — built for analytical queries over billions of rows. At 1K–10K events/day (~3.6M/year), it's like renting a warehouse for a bookshelf. ClickHouse also uses its own SQL dialect with different join semantics, no transactions, and no foreign keys.

- **QuestDB** — optimized for extreme write throughput (millions of inserts/sec). The audit log needs maybe 10 inserts/sec at peak. QuestDB's SQL subset lacks CTEs, window functions, and JSONB.

**Why TimescaleDB wins for audit logs:**

| Requirement                                    | TimescaleDB                         | Prometheus (already have)             | Native TSDB (InfluxDB, etc.)          |
| ---------------------------------------------- | ----------------------------------- | ------------------------------------- | ------------------------------------- |
| Rich event schema (UUIDs, JSONB, foreign keys) | Full Postgres types and constraints | No — numeric metrics only             | Limited or no support                 |
| JOINs with app tables (users, todos)           | Same database, standard JOINs       | Not possible                          | Separate database, no JOINs           |
| "Who did what, when, from where?"              | Natural fit                         | Wrong tool entirely                   | Requires denormalization              |
| SQL compatibility                              | Full PostgreSQL                     | PromQL (different paradigm)           | Custom query languages or SQL subsets |
| Prisma / existing ORM                          | Works via `$queryRaw`               | N/A                                   | Requires separate client library      |
| Retention policies                             | `drop_chunks()` — instant           | Built-in (`--storage.tsdb.retention`) | Varies                                |
| Scale ceiling                                  | ~100M–1B rows                       | Millions of time-series               | Billions to trillions of rows         |

**How they coexist in the stack:**

```
┌───────────────────────────────────────────────────────────┐
│                    Observability Stack                    │
├──────────────────┬───────────────────┬────────────────────┤
│   Prometheus     │   TimescaleDB     │   Pino (stdout)    │
│   (metrics)      │   (audit events)  │   (app logs)       │
├──────────────────┼───────────────────┼────────────────────┤
│ "How fast?"      │ "Who did what?"   │ "What happened?"   │
│ "How many?"      │ "When & where?"   │ "Why did it fail?" │
│ "What's the P95?"│ "Show me proof"   │ "Debug this error" │
├──────────────────┼───────────────────┼────────────────────┤
│ Request latency  │ User login from   │ Error stack trace  │
│ Error rate       │ new IP at 3:42 PM │ Request lifecycle  │
│ DB query time    │ Todo deleted by   │ Debug context      │
│ Active conns     │ admin with reason │                    │
├──────────────────┼───────────────────┼────────────────────┤
│ prom-client      │ Prisma $queryRaw  │ Pino logger        │
│ /metrics endpt   │ audit_events tbl  │ req.log.*          │
│ Grafana dashbd   │ SQL queries       │ stdout/file        │
└──────────────────┴───────────────────┴────────────────────┘
```

Prometheus + Grafana (roadmap) answers operational questions. TimescaleDB answers compliance and security questions. Pino handles debugging. No overlap.

### Use Case Fit: Strong

The planned audit log has textbook time-series characteristics:

- **Append-only** (insert-heavy, no updates/deletes)
- **Time-ordered** (every event has a timestamp)
- **Time-range queries** (events from last 24h, 7d, 90d)
- **Retention requirements** (SOC 2: keep for X period, then purge)
- **Aggregation queries** (events per hour, failed logins per day)

### Production Deployment Topology on Railway

Production deploys to Railway via [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Railway's **managed Postgres** product is stock PostgreSQL without the TimescaleDB extension — `CREATE EXTENSION timescaledb` and `create_hypertable()` are unavailable. To use the extension end-to-end, the app DB moves off managed Postgres onto a **self-hosted TimescaleDB service** running the official `timescale/timescaledb:latest-pg16` image on Railway.

```
┌──────────────────── Railway project ────────────────────┐
│                                                         │
│   ┌─────────────┐    ┌──────────────────┐   ┌────────┐  │
│   │  todo-api   │───▶│   timescaledb    │   │ redis  │  │
│   │  (Node app) │    │  (Pg 16 + ext)   │   │        │  │
│   └─────────────┘    └────────┬─────────┘   └────────┘  │
│                               │                         │
│                               │ WAL + base backups      │
│                               ▼                         │
│                      ┌──────────────────┐               │
│                      │   pgbackrest     │               │
│                      │   (sidecar)      │               │
│                      └────────┬─────────┘               │
│                               │                         │
└───────────────────────────────┼─────────────────────────┘
                                ▼
                      ┌──────────────────┐
                      │ Railway Buckets  │  ← encrypted, versioned
                      │   (S3-compat)    │
                      └──────────────────┘
```

|                           | Managed Postgres (was)      | Self-hosted TimescaleDB (chosen)                                                 |
| ------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| **TimescaleDB extension** | Not available               | First-class                                                                      |
| **Backups**               | Managed by Railway (opaque) | Operated via pgBackRest (PITR, verified, in-vendor)                              |
| **Failover**              | Managed                     | Manual unless replica is added — acceptable for current scale                    |
| **Connection pooling**    | Pgbouncer optional          | Application pool (`src/lib/prisma.ts`) — no change                                   |
| **Upgrade cadence**       | Auto                        | Manual image bump — kept aligned with the `timescale/timescaledb:latest-pgN` tag |
| **Cost**                  | Per-GB managed pricing      | Container + volume + Bucket egress (egress within Railway is free)               |

The trade-off is operational ownership of backups in exchange for the hypertable, retention, and compression features the audit workstream depends on. The Backup & DR section below covers the pgBackRest setup that replaces managed-provider backups.

Local dev and CI swap the Postgres image to `timescale/timescaledb:latest-pg16` in [`docker-compose.yml`](../docker-compose.yml) and [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) so every environment exercises the same extension surface.

### Backup & DR with pgBackRest → Railway Buckets

pgBackRest runs as a sidecar service alongside the TimescaleDB container, archiving WAL continuously and taking scheduled base backups. The backup repository lives in a **Railway Bucket** (Cloudflare R2 under the hood, S3-compatible API) — credentials stay inside Railway's secret store and egress between services is free.

```ini
# /etc/pgbackrest/pgbackrest.conf
[global]
repo1-type=s3
repo1-s3-endpoint=${RAILWAY_BUCKET_ENDPOINT}
repo1-s3-bucket=${RAILWAY_BUCKET_NAME}
repo1-s3-region=auto
repo1-s3-key=${RAILWAY_BUCKET_ACCESS_KEY}
repo1-s3-key-secret=${RAILWAY_BUCKET_SECRET}
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=${PGBACKREST_CIPHER_PASS}
repo1-retention-full=7         # 7 daily fulls retained
repo1-retention-diff=4         # 4 diffs between fulls
start-fast=y
process-max=4

[todo-api]
pg1-path=/var/lib/postgresql/data
```

| Setting       | Value                          | Reason                                                  |
| ------------- | ------------------------------ | ------------------------------------------------------- |
| Full backup   | Daily, 02:00 UTC               | Low-traffic window; 7-day rolling window                |
| Differential  | Every 6h                       | Bounds restore time without exploding storage           |
| WAL archiving | Continuous (`archive_command`) | Point-in-time recovery to any second within retention   |
| Encryption    | AES-256-CBC                    | At-rest in Bucket; cipher pass lives in Railway secrets |
| Retention     | 1 year (≥ SOC 2 minimum)       | Verify with Railway Bucket lifecycle policy             |
| Compression   | Default (gz, level 6)          | Built into pgBackRest; trades CPU for storage           |

**Recovery targets:**

- **RPO (data loss tolerance):** ≤ 5 minutes — bounded by WAL archive cadence and `archive_timeout = 60s`
- **RTO (recovery time):** ≤ 30 minutes — restore from latest full + diff + WAL replay against a fresh Railway service

**Verification cadence:**

- **Continuous:** `pgbackrest verify` runs nightly after the full; failures alert via Prometheus + on-call
- **Quarterly:** Full restore drill to a throwaway Railway service. Boot the app against the restored DB, run the smoke suite, document timings. This drill is the evidence SOC 2 A1.3 requires.

**Cross-roadmap note:** Database Backup & DR is the next Phase A item after Audit Logging. This pgBackRest setup is the implementation of that item too — the audit workstream pulls it in early because the new self-hosted TimescaleDB has no managed backups to fall back on. The DR runbook and quarterly drill cadence are owned by the DR item and referenced here.

### Prisma Integration

Prisma manages the table schema. Hypertable creation, retention policies, role grants, and TimescaleDB-specific features use raw SQL inside Prisma migrations (consistent with existing `$queryRaw` usage in [`src/models/Todo.ts`](../src/models/Todo.ts)). Migrations run as the `db_admin` role (see **Database Role Model** below); the application runtime connects as `db_app`.

### Hypertable Design

For ~1K–10K events/day at current scale, scaling cleanly past 1M/day before requiring intervention (see **Scale Planning** below):

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE audit_entries (
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type     TEXT NOT NULL,                  -- 'Todo', 'User', 'AuthAttempt'
  entity_id       UUID,                           -- nullable: e.g. unknown-email login
  action          TEXT NOT NULL,                  -- 'todo.create', 'auth.login', 'access.denied'
  outcome         TEXT NOT NULL,                  -- 'success' | 'failure'
  outcome_reason  TEXT,                           -- 'invalid-credentials', 'cross-user', ...
  changed_by      UUID,                           -- nullable: failed login w/ bad email
  source_ip       INET,                           -- native type; supports subnet queries
  user_agent      TEXT,
  request_id      TEXT,                           -- correlates events from one HTTP request
  previous_value  JSONB,                          -- full snapshot before mutation (NULL for non-mutations)
  new_value       JSONB,                          -- full snapshot after mutation  (NULL for non-mutations)
  metadata        JSONB,                          -- safety valve: HTTP status, path, error code, ...
  PRIMARY KEY (id, changed_at)                    -- hypertables require the time column in PK
);

SELECT create_hypertable('audit_entries', 'changed_at',
  chunk_time_interval => INTERVAL '7 days'
);

CREATE INDEX idx_audit_entity ON audit_entries (entity_type, entity_id, changed_at DESC);
CREATE INDEX idx_audit_actor  ON audit_entries (changed_by,                changed_at DESC);
CREATE INDEX idx_audit_action ON audit_entries (action, outcome,           changed_at DESC);
CREATE INDEX idx_audit_ip     ON audit_entries (source_ip,                 changed_at DESC);
```

**Schema rationale (hybrid + outcome):**

| Column                                             | Why top-level (not in `metadata`)                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity_type`, `entity_id`, `action`, `changed_by` | Auditor queries ("all actions by user X on todo Y") run as plain B-tree index scans, not JSON extraction                                                            |
| `outcome` + `outcome_reason`                       | Splits success/failure as a queryable dimension: one `auth.login` action with two outcomes rather than two distinct actions. Cleaner dashboards, smaller vocabulary |
| `source_ip` (INET)                                 | Native PostgreSQL type — smaller than text, supports `<<` subnet operators for "all events from /24" anomaly queries                                                |
| `previous_value` / `new_value` (JSONB)             | Full before/after snapshots, not deltas — auditors don't need diff-reconstruction logic                                                                             |
| `metadata` (JSONB)                                 | Safety valve for non-standard context (HTTP status, request path, error class) that doesn't justify a column                                                        |

**Chunk interval rationale:** At 10K events/day, a 7-day chunk holds ~70K rows (~5–10 MB). Queries touching "last 24h" scan 1 chunk, not the whole table. ~52 chunks/year keeps management simple.

### Retention Policy

```sql
-- Drop chunks older than 1 year
SELECT add_retention_policy('audit_events', INTERVAL '1 year');
```

For SOC 2, security events may need 3-year retention. Handle with two tables or a continuous aggregate that preserves summaries after the raw data is dropped.

### Query Advantages Over Plain Postgres

| Query                            | Plain Postgres                                     | TimescaleDB                                           |
| -------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Events in last 24h               | Full table scan or manual partitioning             | Chunk pruning, reads 1 chunk                          |
| Failed logins per hour (last 7d) | `GROUP BY date_trunc(...)` on full table           | `time_bucket('1 hour', timestamp)` with chunk pruning |
| P95 response time per day        | Complex window function                            | `percentile_agg()` with continuous aggregates         |
| Month-over-month comparison      | Two full scans                                     | Two chunk scans, can be materialized                  |
| Drop data older than 1 year      | Manual `DELETE` (slow, generates WAL, locks table) | `drop_chunks()` (instant, drops files)                |

### Database Role Model

REVOKE-based immutability only works if the application connects as a non-superuser. The project uses a three-role model that maps directly to the SOC 2 Access Control Policy:

| Role                | Used by                                                   | Privileges                                                                                     |
| ------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `db_admin`        | Prisma migrations (CI deploy step, manual ops)            | Schema OWNER, DDL, all DML                                                                     |
| `db_app`          | Application runtime ([`src/lib/prisma.ts`](../src/lib/prisma.ts)) | `SELECT, INSERT, UPDATE, DELETE` on `users`, `todos`; `SELECT, INSERT` only on `audit_entries` |
| `db_auditor` | Security/compliance dashboards, ad-hoc auditor queries    | `SELECT` on `audit_entries` only                                                               |

```sql
-- Role bootstrap (run once per environment as superuser; prisma/sql/bootstrap_roles.sql)
CREATE ROLE db_admin LOGIN PASSWORD :'ADMIN_PASS';
CREATE ROLE db_app LOGIN PASSWORD :'APP_PASS';
CREATE ROLE db_auditor LOGIN PASSWORD :'READER_PASS';

ALTER SCHEMA public OWNER TO db_admin;
GRANT USAGE ON SCHEMA public TO db_app, db_auditor;

-- Applied alongside the audit_entries migration
GRANT SELECT, INSERT ON audit_entries TO db_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM db_app;
GRANT SELECT ON audit_entries TO db_auditor;
```

Two environment variables wire this up:

- `DATABASE_URL` — the application connection (`db_app`); read by [`src/config/env.ts`](../src/config/env.ts)
- `DATABASE_MIGRATE_URL` — the migrations connection (`db_admin`); used only by `pnpm run migrate:deploy`

**Tests.** [`__tests__/helpers/testSetup.ts`](../__tests__/helpers/testSetup.ts) needs a privileged second pool wired to `DATABASE_MIGRATE_URL` so `cleanupTestData()` can `TRUNCATE audit_entries RESTART IDENTITY CASCADE` — the test role inherits the REVOKE and cannot delete from the table directly. This is by design: it forces the test suite to use the same immutability surface as production.

### Audit Emission Pattern

Audit writes happen **in-line in the service layer**, inside the same Prisma transaction as the mutation they describe. The actor context (user ID, IP, user-agent, request ID) propagates through the call stack via Node's built-in `AsyncLocalStorage` — no signature changes to existing service methods.

```typescript
// lib/requestContext.ts — set once per request, read anywhere downstream
import { AsyncLocalStorage } from 'node:async_hooks';
export const requestContext = new AsyncLocalStorage<{
  requestId: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
}>();
```

A middleware mounted in [`src/app.ts`](../src/app.ts) right after [`src/middleware/requestId.ts`](../src/middleware/requestId.ts) wraps the rest of the request in `requestContext.run({ requestId, ip, userAgent }, next)`; [`src/middleware/auth.ts`](../src/middleware/auth.ts) re-enters the store with `userId` once the JWT is verified.

```typescript
// lib/auditLog.ts — single write() method, no update/delete/batch
import type { Prisma, PrismaClient } from '../prisma/generated/prisma/client.js';
import { getRequestContext } from './requestContext.js';

type Tx = PrismaClient | Prisma.TransactionClient;
export async function write(tx: Tx, event: AuditEvent): Promise<void> {
  const ctx = getRequestContext();
  await tx.auditEntry.create({
    data: {
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      outcome: event.outcome, // 'success' | 'failure'
      outcomeReason: event.outcomeReason ?? null,
      changedBy: event.changedBy ?? ctx?.userId ?? null,
      sourceIp: event.sourceIp ?? ctx?.ip ?? null,
      userAgent: event.userAgent ?? ctx?.userAgent ?? null,
      requestId: event.requestId ?? ctx?.requestId ?? null,
      previousValue: event.previousValue as Prisma.InputJsonValue,
      newValue: event.newValue as Prisma.InputJsonValue,
      metadata: event.metadata as Prisma.InputJsonValue,
    },
  });
}
```

Mutations adopt a uniform `prisma.$transaction` shape that captures before/after snapshots atomically:

```typescript
// models/Todo.ts — replaces the prior raw-SQL UPDATE...RETURNING
async toggleDone({ id, userId }) {
  return prisma.$transaction(async (tx) => {
    const previousValue = await tx.todo.findFirst({ where: { id, userId } });
    if (!previousValue) return null;
    const newValue = await tx.todo.update({
      where: { id },
      data: { done: !previousValue.done },
    });
    await auditLog.write(tx, {
      action: AuditAction.TodoUpdate,
      entityType: 'Todo',
      entityId: id,
      outcome: 'success',
      previousValue,
      newValue,
    });
    return newValue;
  });
}
```

**Why this pattern at scale:**

- **Same transaction = strongest SOC 2 durability.** If the audit insert fails, the mutation rolls back. No "mutated but unaudited" rows are possible.
- **Service layer is hard to forget.** Audit calls live next to the mutation they describe; a missing call is visible in code review.
- **ALS doubles for OpenTelemetry.** The Monitoring & Observability roadmap item adds OTel spans which use the same context mechanism — one pattern serves both workstreams.
- **No magic.** Explicit `auditLog.write()` calls beat a Prisma `$extends` that audits every query: extensions can't easily distinguish audited vs unaudited mutations (migrations, cleanup jobs, test seed data) and obscure what auditors must trace by hand.

The stable action vocabulary lives in `src/lib/auditActions.ts` as exported constants (`AuthLogin`, `AuthRegister`, `TodoCreate`, `AccessDenied`, ...) — typos surface at compile time and the vocabulary is documented in one place.

### Failure Modes & Monitoring

| Failure mode                                               | Detection                                                                                            | Response                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Audit insert fails (constraint, connection)                | Mutation transaction rolls back; client gets 500                                                     | Prometheus counter `audit_write_failures_total` (label: `reason`); alert if rate > 0.1% over 5m                               |
| TimescaleDB extension missing (e.g., wrong image deployed) | Migration fails at `CREATE EXTENSION timescaledb`                                                    | Deploy blocked; alert via CI                                                                                                  |
| Hypertable chunk creation lag                              | `SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='audit_entries'` plateaus | Daily check job; alert if no new chunk in 8 days                                                                              |
| Retention policy disabled / misconfigured                  | `SELECT * FROM timescaledb_information.jobs WHERE proc_name='policy_retention'` returns empty        | Daily check; alert if missing                                                                                                 |
| REVOKE accidentally rolled back                            | Smoke probe attempts `UPDATE audit_entries SET ...` as `db_app` and expects 42501                  | Post-deploy job in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml); fails the deploy if the UPDATE succeeds |
| pgBackRest backup fails                                    | `pgbackrest info` exit code non-zero                                                                 | Sidecar emits Prometheus metric; alert on stale `last_full_backup_age_seconds` > 30h                                          |
| WAL archive lag                                            | `pg_stat_archiver.last_failed_wal` non-null or `last_archived_time` stale                            | Alert if lag > 5 min (RPO budget)                                                                                             |
| Bucket lifecycle policy drift                              | Periodic check against expected retention                                                            | Quarterly review during DR drill                                                                                              |

The post-deploy REVOKE smoke probe is critical: an accidental `GRANT UPDATE` (e.g., from a bad migration) would silently restore mutability and invalidate the SOC 2 control. Fail-the-deploy is the only response that catches it before audit-tampering becomes possible.

### Scale Planning

The hypertable design is sized for ~1K–10K events/day with headroom; the following thresholds trigger revisits:

| Trigger                                                                         | Action                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hypertable > 10 GB                                                              | Enable native compression: `ALTER TABLE audit_entries SET (timescaledb.compress, timescaledb.compress_segmentby = 'entity_type, changed_by')` + `add_compression_policy('audit_entries', INTERVAL '30 days')`. Typical 10–20× ratio for JSONB-heavy audit data. |
| > 1M events / day sustained                                                     | Move audit to a **dedicated TimescaleDB instance** (the path the original design memo described as a future migration). App writes become async via an outbox table; loses same-tx guarantee but isolates audit load.                                           |
| Retention requirement > 2 years                                                 | Add a continuous aggregate (`time_bucket('1 day', changed_at)` rollups by `(action, outcome, changed_by)`) that survives raw-chunk drops; or tier the raw chunks to S3 via TimescaleDB's tiered storage.                                                        |
| > 100 chunks scanned per typical auditor query                                  | Add a covering index on the specific `(actor, action, time)` slice the dashboard hits; consider materialized views for the hottest reports.                                                                                                                     |
| Pool saturation visible in `pg_pool_waiting_clients` correlated with audit load | Split the audit writes onto a dedicated connection pool (separate Prisma client) inside the app process — single instance, two pools — before moving to a separate DB.                                                                                          |

The **outbox migration path** is documented but deliberately deferred: at current scale, same-transaction writes are simpler, more durable, and cheap. Once volume forces decoupling, the existing `src/lib/auditLog.ts` interface becomes the outbox enqueue, the underlying table writes to a `search_outbox`-style staging table, and a worker drains it into the dedicated audit DB. The application code calling `auditLog.write()` does not change.

### SOC 2 Impact

TimescaleDB + the role model + REVOKE provide layered immutability:

- **Application layer.** [`src/lib/auditLog.ts`](../src/lib/auditLog.ts) exposes only `write()`; no `update`, `delete`, or batch methods exist for any caller to misuse.
- **Database layer.** `db_app` has `SELECT, INSERT` only; `REVOKE UPDATE, DELETE, TRUNCATE` ensures that even a compromised application process or SQL-injection payload cannot tamper with the audit trail.
- **Storage layer.** Once a chunk is older than the compression policy threshold (see **Scale Planning**), the chunk's underlying files become read-only and writes raise an error.
- **Retention.** `add_retention_policy('audit_entries', INTERVAL '1 year')` drops chunks via `drop_chunks` — operating on time boundaries, not row-level DELETEs, so it bypasses the REVOKE while remaining auditable: the dropped time range is the retention boundary, deterministic and inspectable in `timescaledb_information.jobs`.
- **Separation of duties.** `db_auditor` is the role auditors and the security team use. Read-only by construction; cannot tamper even with leaked credentials.
- **Tamper evidence.** A post-deploy smoke probe attempts `UPDATE audit_entries` as `db_app` and fails the deploy if the UPDATE succeeds, catching any accidental privilege escalation before it widens the blast radius.

---

## Roadmap Placement

1. **Current priority:** Fix high-priority correctness bugs
2. **Security hardening:** Helmet, HSTS, body size limits (already planned)
3. **Audit logging phase:** TimescaleDB
   - Swap Postgres image to TimescaleDB
   - Create `audit_events` hypertable
   - Build audit middleware capturing security events
   - Add retention and compression policies
4. **Basic search:** `pg_trgm` migration + search route (interim, serves as ES fallback)
5. **Multi-entity search phase:** Elasticsearch
   - Add ES to Docker Compose
   - Design unified search index with custom analyzers
   - Implement outbox-based sync from Postgres to ES
   - Build search API with facets, highlighting, autocomplete
   - Add `pg_trgm` fallback for degraded mode when ES is down

---

## Architecture

```
┌─────────────┐     ┌───────────────────────────────┐     ┌─────────┐
│   Express   │────▶│  PostgreSQL + TimescaleDB     │     │  Redis  │
│   API       │     │                               │     │         │
│             │     │  ┌────────┐  ┌──────────────┐ │     │  Rate   │
│  Todo CRUD ─┼────▶│  │  Todo  │  │ audit_events │ │     │  Limits │
│             │     │  │ (table)│  │ (hypertable) │ │     │         │
│  Audit MW ──┼────▶│  └────────┘  └──────────────┘ │     └─────────┘
│             │     │                               │
│  Search  ───┼────▶│  pg_trgm index on Todo.text   │
│    │        │     │  search_outbox (sync table)   │
│    │        │     └───────────────────────────────┘
│    │        │
│    ▼        │     ┌───────────────────────────────┐
│  Search  ───┼────▶│  Elasticsearch                │
│  (primary)  │     │                               │
│             │     │  unified_search index         │
│             │     │  (todos, comments,            │
│             │     │   attachments, notes)         │
└─────────────┘     └───────────────────────────────┘
```

Search flow: queries hit ES first. If ES is unavailable, falls back to `pg_trgm` in degraded mode. CRUD writes go to Postgres, then sync to ES via outbox worker.

### New Files

**Audit Logging:**

- `prisma/sql/bootstrap_roles.sql` — three-role creation (run once per env as superuser)
- `prisma/migrations/xxx_add_audit_entries/migration.sql` — hypertable + indexes + retention + grants/REVOKE
- `src/lib/requestContext.ts` — AsyncLocalStorage holding `{ requestId, userId, ip, userAgent }`
- `src/middleware/requestContext.ts` — populates the ALS store; mounted after `requestId`
- `src/lib/auditActions.ts` — stable action vocabulary as exported constants
- `src/lib/auditLog.ts` — single `write()` method, no update/delete

**Search:**

- `prisma/migrations/xxx_add_search.sql` — `pg_trgm` extension + GIN index
- `prisma/migrations/xxx_add_search_outbox.sql` — outbox table for ES sync
- `src/lib/elasticsearch.ts` — ES client singleton and index management
- `services/searchSync.ts` — outbox worker that syncs Postgres → ES
- `services/search.ts` — search service with ES primary and `pg_trgm` fallback
- `src/routes/search.ts` — unified search endpoint with facets, highlighting, autocomplete

### Audit Emission (Service Layer + ALS)

Audit writes happen inside the same Prisma transaction as the mutation they describe, with actor context pulled from `AsyncLocalStorage`. No post-response middleware; no Prisma `$extends` magic. See **Audit Emission Pattern** above for the full pattern and rationale.

```typescript
// models/Todo.ts — uniform $transaction shape for audited mutations
async toggleDone({ id, userId }) {
  return prisma.$transaction(async (tx) => {
    const previousValue = await tx.todo.findFirst({ where: { id, userId } });
    if (!previousValue) return null;
    const newValue = await tx.todo.update({
      where: { id },
      data: { done: !previousValue.done },
    });
    await auditLog.write(tx, {
      action: AuditAction.TodoUpdate,
      entityType: 'Todo',
      entityId: id,
      outcome: 'success',
      previousValue,
      newValue,
    });
    return newValue;
  });
}
```

### Search Service Pattern

```typescript
// services/search.ts
export class SearchService {
  async search(userId: string, query: string, options: SearchOptions): Promise<SearchResult> {
    try {
      return await this.elasticsearchSearch(userId, query, options);
    } catch (error) {
      req.log.warn({ error }, 'ES unavailable, falling back to pg_trgm');
      return await this.pgTrigramSearch(userId, query, options);
    }
  }

  private async elasticsearchSearch(userId: string, query: string, options: SearchOptions) {
    const response = await esClient.search({
      index: 'unified_search',
      body: {
        query: {
          bool: {
            must: {
              multi_match: { query, fields: ['text^2', 'text.autocomplete'] },
            },
            filter: { term: { user_id: userId } },
          },
        },
        highlight: { fields: { text: {} } },
        aggs: {
          by_type: { terms: { field: 'entity_type' } },
          by_status: { terms: { field: 'done' } },
        },
      },
    });
    return { hits: response.hits, facets: response.aggregations, mode: 'full' };
  }

  private async pgTrigramSearch(userId: string, query: string, options: SearchOptions) {
    const results = await prisma.$queryRaw`
      SELECT * FROM "Todo"
      WHERE "userId" = ${userId} AND similarity(text, ${query}) > 0.3
      ORDER BY similarity(text, ${query}) DESC
      LIMIT ${options.limit}
    `;
    return { hits: results, facets: null, mode: 'degraded' };
  }
}
```
