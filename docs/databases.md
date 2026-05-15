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
      "entity_type":  { "type": "keyword" },
      "user_id":      { "type": "keyword" },
      "text":         { "type": "text", "analyzer": "todo_analyzer",
                        "fields": {
                          "autocomplete": { "type": "text", "analyzer": "autocomplete_analyzer" },
                          "exact":        { "type": "keyword" }
                        }},
      "done":         { "type": "boolean" },
      "created_at":   { "type": "date" },
      "updated_at":   { "type": "date" },
      "metadata":     { "type": "object", "enabled": false }
    }
  }
}
```

A single index with an `entity_type` field (todo, comment, attachment, note) keeps cross-entity search in one query. Separate indices per entity are an option if they grow to very different sizes or need independent scaling.

### Sync Strategy

| Strategy | Consistency | Complexity | Failure Mode |
|---|---|---|---|
| Dual-write | Eventual (can diverge on partial failure) | Medium | Data inconsistency if one write fails |
| CDC (Debezium) | Eventual (~seconds lag) | High (Kafka/Connect infra) | Infra failure = stale index |
| Async sync (background job) | Eventual (~minutes lag) | Low | Missed changes, polling load |

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
    - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
  ports:
    - "9200:9200"
  volumes:
    - elasticsearch_data:/usr/share/elasticsearch/data
  healthcheck:
    test: ["CMD-SHELL", "curl -f http://localhost:9200/_cluster/health || exit 1"]
    interval: 10s
    timeout: 5s
    retries: 5
```

### Meilisearch / Typesense as Alternatives

| | Elasticsearch | Meilisearch | Typesense |
|---|---|---|---|
| Multi-entity search | Full support | Supported (multi-index) | Supported (multi-search) |
| Custom analyzers | Full control | Limited | Limited |
| Synonym support | Yes | Yes | Yes |
| Faceted filtering | Yes | Yes | Yes |
| Relevance tuning | Full control (function_score, boosting) | Limited (ranking rules) | Moderate (overrides) |
| Operational complexity | High (JVM, cluster mgmt) | Low (single binary) | Low (single binary) |
| Ecosystem / community | Massive | Growing | Growing |
| Learning value | Highest (industry standard) | Moderate | Moderate |

Meilisearch or Typesense would be simpler to operate, but Elasticsearch provides the deepest learning and the most control over relevance tuning. For a learning project focused on depth, ES is the right choice.

---

## TimescaleDB Analysis

### Why TimescaleDB Over Native Time-Series Databases

TimescaleDB is a Postgres extension, not a standalone time-series database. There are purpose-built alternatives — here's why TimescaleDB is the right choice for audit logs, and how it fits alongside the existing Prometheus setup.

**Native time-series databases:**

| Database | Architecture | Query Language | Best For |
|---|---|---|---|
| **InfluxDB** | Standalone, custom storage engine | Flux / InfluxQL | Metrics, IoT sensor data, high-frequency numeric data (100K+ writes/sec) |
| **Prometheus** | Standalone, pull-based collection | PromQL | Infrastructure monitoring, alerting, metrics scraping |
| **ClickHouse** | Standalone, column-oriented | SQL (dialect) | Analytics on billions of rows, OLAP, log aggregation at massive scale |
| **QuestDB** | Standalone, custom storage engine | SQL (subset) | High-throughput ingestion (millions/sec), financial tick data |
| **VictoriaMetrics** | Standalone, Prometheus-compatible | MetricsQL | Long-term Prometheus storage, high-cardinality metrics |
| **TimescaleDB** | Postgres extension | Full PostgreSQL SQL | Time-series data that coexists with relational data, moderate scale |

**Why these alternatives don't fit for audit logs:**

- **Prometheus** — already in the stack (`prom-client` 15.1.3, `/metrics` endpoint with `http_request_duration_seconds`, `http_requests_total`, `db_query_duration_seconds`, `rate_limit_hits_total`, `active_connections`). Prometheus is designed for numeric metrics, not structured event logs. It answers "what is the request latency P95 right now?" not "which user deleted todo X at 3:42 PM and from what IP?" Audit events have UUIDs, JSONB metadata, foreign keys — Prometheus has no concept of these. **Prometheus stays for metrics. TimescaleDB handles audit events. Different data, different tools.**

- **InfluxDB / VictoriaMetrics** — same limitation as Prometheus: designed for numeric time-series (gauges, counters, histograms), not rich structured events. Would force flattening audit data into tag/field pairs, losing queryability.

- **ClickHouse** — built for analytical queries over billions of rows. At 1K–10K events/day (~3.6M/year), it's like renting a warehouse for a bookshelf. ClickHouse also uses its own SQL dialect with different join semantics, no transactions, and no foreign keys.

- **QuestDB** — optimized for extreme write throughput (millions of inserts/sec). The audit log needs maybe 10 inserts/sec at peak. QuestDB's SQL subset lacks CTEs, window functions, and JSONB.

**Why TimescaleDB wins for audit logs:**

| Requirement | TimescaleDB | Prometheus (already have) | Native TSDB (InfluxDB, etc.) |
|---|---|---|---|
| Rich event schema (UUIDs, JSONB, foreign keys) | Full Postgres types and constraints | No — numeric metrics only | Limited or no support |
| JOINs with app tables (users, todos) | Same database, standard JOINs | Not possible | Separate database, no JOINs |
| "Who did what, when, from where?" | Natural fit | Wrong tool entirely | Requires denormalization |
| SQL compatibility | Full PostgreSQL | PromQL (different paradigm) | Custom query languages or SQL subsets |
| Prisma / existing ORM | Works via `$queryRaw` | N/A | Requires separate client library |
| Retention policies | `drop_chunks()` — instant | Built-in (`--storage.tsdb.retention`) | Varies |
| Scale ceiling | ~100M–1B rows | Millions of time-series | Billions to trillions of rows |

**How they coexist in the stack:**

```
┌──────────────────────────────────────────────────────────┐
│                    Observability Stack                     │
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
│ Active conns     │ admin with reason  │                    │
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

### Extension vs Standalone Database

TimescaleDB can run as either a Postgres extension (shared instance) or a dedicated Postgres instance with TimescaleDB pre-installed. Both options use the same TimescaleDB engine — the question is whether audit data shares a Postgres instance with application data or gets its own.

**Option A: Extension on existing Postgres (shared instance)**

```yaml
postgres:
  image: timescale/timescaledb:latest-pg16  # was postgres:16
  # everything else stays identical
```

**Option B: Standalone dedicated instance**

```yaml
postgres:
  image: postgres:16
  # ... app data only

timescaledb:
  image: timescale/timescaledb:latest-pg16
  container_name: todo-timescaledb
  environment:
    POSTGRES_DB: todo_audit
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: postgres
  ports:
    - "5433:5432"
  volumes:
    - timescaledb_data:/var/lib/postgresql/data
```

| | Shared Instance (Extension) | Dedicated Instance (Standalone) |
|---|---|---|
| **Operational overhead** | One database to manage, back up, monitor | Two Postgres instances to manage separately |
| **Resource isolation** | Audit queries compete with CRUD for CPU/memory/IO | Audit heavy aggregations can't slow down CRUD |
| **Connection management** | Single Prisma client, single connection pool | Two connection pools, two Prisma clients or a raw `pg` client for audit |
| **Transactions** | Can write audit events in the same transaction as app writes | Cross-database transactions not possible — audit writes are always async |
| **Backup/restore** | Single backup captures everything | Separate backup schedules (audit data may need different retention) |
| **Scaling** | Vertical only — both workloads scale together | Can scale audit DB independently (bigger disk, more memory for aggregations) |
| **Failure blast radius** | Audit table corruption/bloat affects app DB | Audit DB issues are isolated from app |
| **Docker complexity** | One-line image swap | Additional service, volume, port, healthcheck |
| **Prisma compatibility** | Same Prisma client, hypertable via raw SQL migrations | Separate connection — either a second Prisma schema or raw `pg` client |
| **SOC 2 separation** | Auditor may question audit data living alongside mutable app data | Clean separation satisfies "audit log independence" controls |
| **Memory footprint** | ~0 MB extra (shared Postgres process) | ~100-200 MB extra (second Postgres process) |

**Recommendation for this project:** Start with shared instance (extension). It eliminates connection management complexity and lets audit middleware write synchronously in the same transaction as app writes. If audit query load grows heavy or SOC 2 auditors require separation, migrating to a dedicated instance is straightforward — export the `audit_events` table and point the audit service at the new connection string.

### Prisma Integration

Prisma manages the table schema. Hypertable creation and TimescaleDB-specific features use raw SQL in migrations (already consistent with existing `$queryRaw` usage).

### Hypertable Design

For ~1K–10K events/day:

```sql
CREATE TABLE audit_events (
  id         UUID DEFAULT gen_random_uuid(),
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id   UUID,
  action     TEXT NOT NULL,     -- 'todo.created', 'auth.login_failed'
  resource   TEXT,              -- 'todo', 'user'
  resource_id UUID,
  metadata   JSONB,             -- request context, IP, user agent
  request_id TEXT
);

SELECT create_hypertable('audit_events', 'timestamp',
  chunk_time_interval => INTERVAL '7 days'
);

CREATE INDEX idx_audit_actor ON audit_events (actor_id, timestamp DESC);
CREATE INDEX idx_audit_action ON audit_events (action, timestamp DESC);
CREATE INDEX idx_audit_resource ON audit_events (resource, resource_id, timestamp DESC);
```

**Chunk interval rationale:** At 10K events/day, a 7-day chunk holds ~70K rows (~5–10 MB). Queries touching "last 24h" scan 1 chunk, not the whole table. ~52 chunks/year keeps management simple.

### Retention Policy

```sql
-- Drop chunks older than 1 year
SELECT add_retention_policy('audit_events', INTERVAL '1 year');
```

For SOC 2, security events may need 3-year retention. Handle with two tables or a continuous aggregate that preserves summaries after the raw data is dropped.

### Query Advantages Over Plain Postgres

| Query | Plain Postgres | TimescaleDB |
|---|---|---|
| Events in last 24h | Full table scan or manual partitioning | Chunk pruning, reads 1 chunk |
| Failed logins per hour (last 7d) | `GROUP BY date_trunc(...)` on full table | `time_bucket('1 hour', timestamp)` with chunk pruning |
| P95 response time per day | Complex window function | `percentile_agg()` with continuous aggregates |
| Month-over-month comparison | Two full scans | Two chunk scans, can be materialized |
| Drop data older than 1 year | Manual `DELETE` (slow, generates WAL, locks table) | `drop_chunks()` (instant, drops files) |

### SOC 2 Impact

TimescaleDB helps immutability:
- Compressed chunks become effectively read-only at the storage level
- `drop_chunks` operates on time boundaries, making retention auditable
- Application-layer immutability enforced via Postgres rules:

```sql
CREATE RULE no_update_audit AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE RULE no_delete_audit AS ON DELETE TO audit_events DO INSTEAD NOTHING;
```

`drop_chunks` bypasses rules since it drops the underlying table — retention policies still work.

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
┌─────────────┐     ┌──────────────────────────────┐     ┌─────────┐
│   Express   │────▶│  PostgreSQL + TimescaleDB     │     │  Redis  │
│   API       │     │                                │     │         │
│             │     │  ┌────────┐  ┌──────────────┐ │     │  Rate   │
│  Todo CRUD ─┼────▶│  │  Todo  │  │ audit_events │ │     │  Limits │
│             │     │  │ (table)│  │ (hypertable) │ │     │         │
│  Audit MW ──┼────▶│  └────────┘  └──────────────┘ │     └─────────┘
│             │     │                                │
│  Search  ───┼────▶│  pg_trgm index on Todo.text   │
│    │        │     │  search_outbox (sync table)    │
│    │        │     └──────────────────────────────┘
│    │        │
│    ▼        │     ┌──────────────────────────────┐
│  Search  ───┼────▶│  Elasticsearch                │
│  (primary)  │     │                                │
│             │     │  unified_search index          │
│             │     │  (todos, comments,             │
│             │     │   attachments, notes)          │
└─────────────┘     └──────────────────────────────┘
```

Search flow: queries hit ES first. If ES is unavailable, falls back to `pg_trgm` in degraded mode. CRUD writes go to Postgres, then sync to ES via outbox worker.

### New Files

- `prisma/migrations/xxx_add_audit_events.sql` — hypertable + indexes + retention
- `middleware/audit.ts` — Express middleware capturing security events
- `routes/audit.ts` — Admin endpoints for querying audit logs
- `prisma/migrations/xxx_add_search.sql` — `pg_trgm` extension + GIN index
- `prisma/migrations/xxx_add_search_outbox.sql` — outbox table for ES sync
- `lib/elasticsearch.ts` — ES client singleton and index management
- `services/searchSync.ts` — outbox worker that syncs Postgres → ES
- `services/search.ts` — search service with ES primary and `pg_trgm` fallback
- `routes/search.ts` — unified search endpoint with facets, highlighting, autocomplete

### Audit Middleware Pattern

```typescript
// middleware/audit.ts
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    void recordAuditEvent({
      timestamp: new Date(),
      actorId: req.userId ?? null,
      action: `${req.method.toLowerCase()}.${req.baseUrl}`,
      resource: extractResource(req),
      resourceId: extractResourceId(req),
      metadata: {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        statusCode: res.statusCode,
      },
      requestId: req.id,
    });
  });
  next();
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
            must: { multi_match: { query, fields: ['text^2', 'text.autocomplete'] } },
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
