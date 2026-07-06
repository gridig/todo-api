# Platform Roadmap

This document outlines the infrastructure and production-readiness work required. Items are organized by priority. Items tagged with **[SOC 2]** are required for SOC 2 Type II compliance.

> **SOC 2 Type II is a firm business requirement.** The phasing below is ordered accordingly — all items tagged **[SOC 2]** in Phases A–C must be completed before the observation period can begin.

## HIGH PRIORITY (Production Critical)

### Encryption at Rest **[SOC 2]**

**Priority**: High
**Effort**: Medium
**Impact**: High
**SOC 2**: CC6.1 (Data Protection), C1.1 (Confidential Information Protection)

- [ ] Enable PostgreSQL Transparent Data Encryption (TDE) or use encrypted storage volumes
- [ ] Document encryption-at-rest configuration for the database hosting provider
- [ ] Add field-level encryption for PII fields (email) using a KMS-backed key
- [ ] Implement key rotation strategy for field-level encryption keys
- [ ] Ensure database backups are encrypted
- [ ] Document key management procedures (who has access, how keys are rotated)

**Why**: SOC 2 requires that confidential data is protected at rest (CC6.1, C1.1). Even if the hosting provider encrypts disks, auditors want evidence of deliberate encryption controls and documented key management.

### Secrets Management **[SOC 2]**

**Priority**: High
**Effort**: Low
**Impact**: High
**SOC 2**: CC6.1 (Logical Access Security — Key Management), CC6.7 (Encryption in Transit)

`JWT_SECRET`, `DATABASE_URL`, `METRICS_TOKEN`, and any future API keys must not live as plaintext in CI logs, committed config, or `.env` files. SOC 2 CC6.1 requires documented key management controls with least-privilege access.

- [ ] Store production secrets in an at-rest-encrypted, access-controlled secret store — not in plaintext config files or task definitions **[SOC 2]**
- [ ] Reference secrets indirectly from the deploy artifact (env var pulled from the secret store at runtime, ARN/reference indirection) so secrets do not appear in the artifact itself
- [ ] Define and document a rotation runbook for `JWT_SECRET` covering at least `ACCESS_TOKEN_EXPIRY` dual-secret window so in-flight tokens stay valid mid-rotation
- [ ] Enforce that `.env` is in `.gitignore`; add a CI pre-commit check (e.g., `git-secrets`, Semgrep) to catch accidental secret commits **[SOC 2]**
- [ ] Document the secrets access policy in `docs/configuration.md`: which roles can read which secrets, principle of least privilege applied, how access is revoked

**Current implementation:** secrets are stored as deploy-platform environment variables, scoped per environment (`staging`/`production`); `DATABASE_URL` is provided by the platform's managed Postgres reference variable; deploy tokens live as GitHub Environment secrets. This satisfies the at-rest-encryption and per-environment-scoping bullets above; rotation runbook and read-side audit log are the remaining gaps. A future migration to a managed secrets store (AWS Secrets Manager, HashiCorp Vault, Doppler, Infisical) would close the read-side audit gap if SOC 2 CC6.2 requires it.

**Why**: Plaintext secrets are visible to anyone with config/CI-log read access. An encrypted-at-rest secret store with audited access closes the key-management gap SOC 2 CC6.1 auditors specifically look for.

### User Profile Management **[SOC 2]**

**Priority**: High
**Effort**: Medium
**Impact**: High
**SOC 2**: CC6.1 (Logical Access), P4.1-P4.3 (Privacy — Data Subject Rights)

Core profile endpoints with account lifecycle management. No dependency on email service or refresh tokens.

- [ ] Add `name` field to User model in Prisma schema
- [ ] Add `GET /user/me` endpoint (get current user profile)
- [ ] Add `PATCH /user/me` for profile updates (name, email)
- [ ] Add password change functionality (`PATCH /user/me/password` — requires current password, invalidates all refresh tokens once **JWT Refresh + Token Revocation** is implemented)
- [ ] Add `DELETE /user/me` for account deletion **[SOC 2]** (Privacy: data subject deletion rights)
- [ ] Add `GET /user/me/export` for user data export **[SOC 2]** (Privacy: data portability)
- [ ] On account deletion: cascade delete todos (and refresh tokens once **JWT Refresh + Token Revocation** is implemented), audit log the deletion before executing
- [ ] Implement proper validation for profile updates
- [ ] Add tests for all profile operations

**Why**: Users must have control over their profiles and data. Essential for user autonomy, GDPR compliance, and SOC 2 Privacy criteria.

### JWT Refresh + Token Revocation **[SOC 2]**

**Priority**: High
**Effort**: Medium
**Impact**: High
**SOC 2**: CC6.1 (Logical Access), CC6.2 (User Authentication)

Can ship independently of **User Profile Management**. Requires a `RefreshToken` model in the database.

- [ ] Add `RefreshToken` model to the Prisma schema
- [ ] Implement refresh token mechanism **[SOC 2]**
- [ ] Add `POST /auth/refresh` endpoint
- [ ] Implement token rotation (issue new refresh token on each use) **[SOC 2]**
- [ ] Add refresh token expiration (7-30 days)
- [ ] Blacklist old refresh tokens
- [ ] Add `POST /auth/logout` endpoint (revoke current refresh token) **[SOC 2]**
- [ ] Add `POST /auth/logout-all` endpoint (revoke all user refresh tokens) **[SOC 2]**
- [ ] Document JWT secret rotation strategy for production **[SOC 2]**
- [ ] Add tests for token refresh and logout flows

**Why**: Short-lived access tokens with refresh tokens improve security without hurting UX. Token revocation is required for SOC 2 session management. This is independently valuable and has no dependency on user profile endpoints or email services.

### Email Service Integration

**Priority**: Medium
**Effort**: Medium
**Impact**: Medium

> **Vendor dependency:** This item commits to Loops.so as the email provider. Evaluate Loops.so's pricing, SLAs, and API stability before starting. Consider defining an email service interface (`lib/emailService.ts`) so the provider can be swapped without touching route handlers.

- [ ] Integrate email service (Loops.so)
- [ ] Add email verification on registration
- [ ] Add email change with verification
- [ ] Add tests for email flows

**Why**: Email verification prevents fake account registration and is a prerequisite for **Password Reset Flow**.

### Password Reset Flow

**Priority**: Medium
**Effort**: Low
**Impact**: Medium

Depends on **Email Service Integration**. Cannot ship without a working email provider.

- [ ] Implement `POST /auth/forgot-password` endpoint
- [ ] Generate secure reset tokens with expiration
- [ ] Add `POST /auth/reset-password` endpoint
- [ ] Add rate limiting for reset requests
- [ ] Send email templates via Loops.so
- [ ] Add tests for password reset flow

**Why**: Password reset is a natural extension of the email service and completes the account management story.

### Monitoring & Observability (Beyond Metrics) **[SOC 2]**

**Priority**: High
**Effort**: High
**Impact**: High
**SOC 2**: CC7.2 (Security Event Monitoring), CC7.3 (Incident Detection), A1.2 (Availability Monitoring)

The Prometheus metrics endpoint is already implemented — see `middleware/metrics.ts`. This item covers the remaining operational observability stack.

- [ ] Track API response times **[SOC 2]**
- [ ] Monitor rate limit hits **[SOC 2]** (CC7.2: detect abuse patterns)
- [ ] Track authentication failures **[SOC 2]** (CC7.2: detect brute force / credential stuffing)
- [ ] Set up Grafana dashboards **[SOC 2]**
- [ ] Add alerting for critical issues (error rate spikes, auth failures, downtime) **[SOC 2]**
- [ ] **Backup-failure alerting** (inherited from the completed Backup & DR work) — expose the pgBackRest scheduler's metrics file (`/tmp/pgbackrest-metrics.prom`: `pgbackrest_last_full_backup_age_seconds`, `pgbackrest_last_diff_backup_age_seconds`, `pgbackrest_wal_archive_ok`) via a node_exporter textfile mount or a small HTTP exporter, then alert: no full in 30h → critical; no diff in 7h → warning; `pgbackrest_wal_archive_ok == 0` → critical (RPO at risk). Railway has no native log-content alerting, so this is the *only* backup-failure alert path — there is no interim. **[SOC 2]**
- [ ] Instrument with OpenTelemetry SDK (`@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`) emitting OTLP — vendor-neutral; the same OTLP exporter works with any compatible backend (Jaeger, Honeycomb, Datadog, Grafana Tempo, AWS X-Ray) **[SOC 2]**
- [ ] Ship structured logs to a central aggregator (Grafana Loki, Datadog, or stdout for container orchestrator collection) **[SOC 2]**
- [ ] Define and monitor uptime SLA targets **[SOC 2]** (A1.2: availability commitments)
- [ ] Add threshold-based slow query logging in the Prisma `$extends` query wrapper (`lib/prisma.ts`) — emit `req.log.warn` when any query exceeds `DB_SLOW_QUERY_THRESHOLD_MS` (default: 100ms) with operation, model, and duration context; the Prometheus histogram captures aggregate data but cannot alert inline or correlate with specific requests

**Why**: Essential for production operations and informed scaling decisions. Without dashboards and alerting, you cannot detect issues, measure SLAs, or debug production problems. SOC 2 requires continuous monitoring of security events (CC7.2), incident detection capabilities (CC7.3), and availability measurement (A1.2).

## MEDIUM PRIORITY (Pre-Production Recommended)

### Role-Based Access Control (RBAC) **[SOC 2]**

**Priority**: Medium
**Effort**: Medium
**Impact**: High
**SOC 2**: CC6.1 (Principle of Least Privilege), CC6.3 (Role-Based Access)

Currently all authenticated users have identical permissions. SOC 2 requires principle of least privilege and admin/user separation.

- [ ] Add `role` field to User model (`user` | `admin`, default `user`) **[SOC 2]**
- [ ] Create authorization middleware that checks `role` **[SOC 2]**
- [ ] Separate admin endpoints from user endpoints **[SOC 2]**
- [ ] Ensure regular users cannot access admin operations
- [ ] Add `role` to JWT payload or fetch on each request
- [ ] Add tests for role-based authorization
- [ ] Document role definitions and their permissions
- [ ] **Emit audit-log entries for administrative actions** **[SOC 2]** — add an `admin.*` family of actions to `lib/auditActions.ts` (e.g. `admin.user.role.change`, `admin.user.delete`); wire emissions at each admin endpoint inside `prisma.$transaction` so an audit failure rolls back the privileged action. Migrated from the (now-deleted) Audit Logging roadmap section because the audit infrastructure is already shipped — this remaining bullet only becomes actionable once admin endpoints exist.

**Why**: SOC 2 CC6.1 requires principle of least privilege. CC6.3 requires role-based access controls. Auditors expect to see a clear separation between administrative and standard user capabilities.

### SOC 2 Compliance Documentation **[SOC 2]**

**Priority**: Medium
**Effort**: Medium
**Impact**: High
**SOC 2**: All criteria (organizational policies are prerequisites for every TSC)

These are non-code deliverables that auditors will request. Without them, the audit cannot proceed regardless of how secure the code is.

- [ ] **Information Security Policy** — Organization-wide security stance and commitments
- [ ] **Incident Response Plan** — Detection, triage, containment, eradication, recovery, post-mortem procedures
- [ ] **Business Continuity / Disaster Recovery Plan** — RTO/RPO targets, failover procedures, communication plan
- [ ] **Change Management Policy** — How code moves from dev to production (maps to CI/CD pipeline)
- [ ] **Access Control Policy** — Who can access what, how access is granted/reviewed/revoked
- [ ] **Risk Assessment** — Documented threat model for the API and its infrastructure
- [ ] **Vendor Management Policy** — How third-party services are evaluated (DB hosting, email, etc.)
- [ ] **Data Classification Policy** — What data is confidential, internal, or public
- [ ] **Data Retention & Disposal Policy** — Lifecycle rules for user data, logs, and backups
- [ ] **Employee Security Awareness Training** — Evidence of security training for team members
- [ ] **Annual Penetration Test** — Engage a third-party firm for annual pentest; remediate findings

**Why**: SOC 2 is an organizational audit, not just a technical one. Auditors require documented policies with evidence of implementation. These policies map directly to the Trust Services Criteria and must exist before the audit observation period begins.

### Idempotency Keys

**Priority**: Medium
**Effort**: Low
**Impact**: Medium

POST endpoints that create resources (`POST /todos`, `POST /auth/register`) have no idempotency mechanism. A client retry after a network timeout can create duplicate records. Redis-backed idempotency keys solve this with negligible overhead.

- [ ] Create `middleware/idempotency.ts` — reads `Idempotency-Key` header (UUID); checks Redis for `idempotency:{userId}:{key}`; returns cached response if found; stores `{ status, body }` in Redis with 24h TTL after successful handler execution
- [ ] Return `409 ConflictError` (`IDEMPOTENCY_KEY_MISMATCH`) if the same key is used with a different request body
- [ ] Apply to `POST /api/v1/todos` and `POST /api/v1/auth/register`
- [ ] Document `Idempotency-Key` usage in `docs/api.md`
- [ ] Write tests: cache hit (replay), cache miss (fresh request), key mismatch (409), TTL expiry

**Why**: Without idempotency, a client that retries after a timeout may register twice or create duplicate resources. This is a standard API contract for mutating endpoints. Redis is already in place for rate limiting, so the infrastructure cost is zero.

### Distributed Rate Limit Store

**Priority**: Medium
**Effort**: Medium
**Impact**: High

The Redis store factory is implemented in `middleware/rateLimiter.ts` with graceful in-memory fallback, `REDIS_URL` env var is configured, all five rate limiters use the shared store, and Redis disconnect is wired into graceful shutdown. The remaining work is integration tests. Note: `REDIS_URL` is still commented out in the `app` service env in `docker-compose.yml`, so the compose app does not yet exercise Redis.

- [ ] Add integration tests for shared rate limit counting

**Why**: In a multi-instance deployment, in-memory rate limiting is ineffective — a client can get N times the configured limit by hitting different instances. After a process restart, all counters reset to zero, allowing a burst of previously-limited traffic. Redis provides a shared counter across all instances. The fallback pattern (in-memory when `REDIS_URL` is empty) allows incremental adoption.

### API Versioning

**Priority**: Medium
**Effort**: Medium
**Impact**: High

- [ ] Introduce `/api/v1/` prefix for all existing routes (auth, todos, user, health, metrics)
- [ ] Set up versioned router structure (`routes/v1/`) for future `/api/v2/` additions
- [ ] Add `API-Version: 1` response header to all `/api/v1/` responses — note: `API-Version` not `X-API-Version`; RFC 6648 (2012) deprecated the `X-` prefix convention for new headers
- [ ] Add `Deprecation` and `Sunset` HTTP headers to any deprecated endpoints per RFC 8594 — machine-readable deprecation signals for API clients
- [ ] Document versioning strategy and deprecation policy in `docs/api.md`
- [ ] Update all integration tests and k6 benchmark scripts to use `/api/v1/` paths

**Why**: Much easier to add now than to retrofit later. Prevents breaking existing clients when the API evolves.

### Standardized Response Envelope

**Priority**: Medium
**Effort**: Low
**Impact**: High

- [ ] Define `SuccessResponse<T>` type: `{ data: T; meta: { requestId, timestamp, pagination? } }`
- [ ] Update all route handlers to wrap success responses in the envelope
- [ ] Add pagination metadata to the `meta` field on list endpoints
- [ ] Update all tests to assert on the new envelope structure
- [ ] Error responses keep their existing format — no change

**Why**: The error format is already consistent. A matching success format makes the API predictable for consumers.

### API Documentation

**Priority**: Medium
**Effort**: Medium
**Impact**: Medium

- [ ] Adopt spec-first OpenAPI 3.1 workflow: write the spec in `docs/openapi.yaml` before implementing endpoints — use `express-openapi-validator` middleware to validate all requests and responses against the spec at runtime; the spec is the source of truth, not documentation generated after the fact
- [ ] Serve interactive API explorer via `swagger-ui-express` mounted at `/docs` (behind auth or IP restriction in production)
- [ ] Document all endpoints with request/response examples, authentication flows, rate limits, and error codes in the spec
- [ ] Maintain `CHANGELOG.md` with dated, versioned entries per API version following [Keep a Changelog](https://keepachangelog.com/) format
- [ ] Generate client SDKs from the OpenAPI spec (e.g., `openapi-generator-cli`)

**Why**: Spec-first ensures the spec and implementation never diverge — runtime validation catches drift immediately. An API changelog gives consumers a reliable migration guide. `swagger-ui-express` reduces support burden by making the API self-documenting.

## LOW PRIORITY (Nice to Have)

### Performance Optimizations

**Priority**: Low
**Effort**: Medium
**Impact**: Low-Medium

- [ ] Restrict `User.findByEmail` to select only needed fields when called by future, non-auth code paths — today `findByEmail` is only called by the login route (which legitimately needs `password`) and `middleware/auth.ts` does no database access. There is no live offender; tracked here so that any future caller (e.g. profile lookup, RBAC) selects only what it needs and does not pull the password hash into memory unnecessarily.
- [ ] Apply single-query mutation pattern (`UPDATE...RETURNING`, `DELETE...RETURNING`) to all remaining two-query transactions — proven effective for PATCH `toggleDone`; extend to other mutation paths
- [ ] Apply field projection to all Prisma queries (select only needed fields)
- [ ] Profile and optimize hot paths identified by monitoring

**Why**: k6 load testing identified the database as the primary bottleneck (~95% of request latency). The highest-impact optimizations (indexing, pool sizing/tuning, query reduction, pagination) are already shipped. Field projection for the User model has a security dimension beyond performance: the `password` hash should not be held in memory when only the user ID or email is needed. Slow query logging is tracked in **Monitoring & Observability**.

### Search & Discovery

**Priority**: Medium (post-SOC 2)
**Effort**: Phase 1 Low, Phase 2 High
**Impact**: Medium (Phase 1) → High once multi-entity content exists (Phase 2)

No search capability exists today. Two phases — `pg_trgm` first for immediate single-entity fuzzy search, Elasticsearch later for multi-entity search across todos + future entities (comments, attachments, notes). Full index design, sync strategy (outbox pattern), failure handling, and Meilisearch/Typesense alternatives are in [docs/databases.md](docs/databases.md).

**Phase 1 — `pg_trgm` (interim, todo-only):**

- [ ] Migration: `CREATE EXTENSION IF NOT EXISTS pg_trgm` + GIN index on `Todo.text` with `gin_trgm_ops`
- [ ] Add `GET /todos/search?q=...` route using `similarity()` with a tunable threshold (start at `0.3`); enforce user isolation (`WHERE "userId" = ${req.userId}`)
- [ ] Tests covering fuzzy match, typo tolerance, threshold tuning, and user isolation

**Phase 2 — Elasticsearch (multi-entity, when comments/attachments/notes exist):**

- [ ] Add Elasticsearch service to `docker-compose.yml` (single-node, security off in dev) + `ES_URL` env var
- [ ] Design unified `unified_search` index with `entity_type` keyword, custom analyzer (lowercase + asciifolding + synonyms), and `autocomplete` edge-ngram subfield
- [ ] Outbox-based sync: `search_outbox` table written transactionally with app writes; background worker drains the outbox and indexes into ES
- [ ] `services/search.ts` with ES-primary, `pg_trgm`-fallback (Phase 1 index stays as degraded-mode fallback)
- [ ] `GET /search` endpoint with facets (`by_type`, `by_status`), highlighting, autocomplete; `X-Search-Freshness` and degraded-mode headers
- [ ] Outbox-backlog monitoring + alerts (Prometheus counter, threshold ~10K unprocessed)

**Why**: `pg_trgm` ships fuzzy todo search in a single migration with zero new infrastructure and remains valuable later as the ES fallback. Elasticsearch is justified only once the schema grows to multiple searchable entity types — until then, Postgres is sufficient.

### Database Read Replica Preparation

**Priority**: Low
**Effort**: Low (documentation only)
**Impact**: Medium (when needed)

Single `DATABASE_URL` connects to one PostgreSQL instance for all operations. As traffic grows, read queries (which typically outnumber writes 10:1+) compete with writes for the same database resources.

- [ ] Document read replica strategy: `DATABASE_READ_URL` env var, second Prisma client, read/write routing
- [ ] Identify which queries route to the read client (list endpoints, read-heavy aggregations)
- [ ] Identify which queries must stay on the primary (all mutations)
- [ ] Note prerequisite: only implement after pagination (shipped), indexing (shipped), and pool sizing/tuning (shipped) prove insufficient

**Why**: Read replicas are the next scaling lever after single-instance optimizations are exhausted. Documenting the approach now ensures the team has a plan before it becomes urgent. No code change needed until monitoring shows the database is read-bound after all other optimizations are in place.

> **Note:** Since this is documentation-only with low effort, consider writing it now while the architecture reasoning and benchmark data are fresh — deferring a 1-2 hour task risks losing context that would take longer to reconstruct later.

### UUID Column Type Migration — Verification Follow-ups

**Priority**: Medium
**Effort**: Low
**Impact**: Medium-High at scale

Core migration is complete (`@db.Uuid` on PK/FK fields, `20260313101015_uuid_native` migration in place, indexes rebuilt). Only the verification work remains.

- [ ] Review raw SQL in `toggleDone`/`update`/`delete` (`models/Todo.ts`) — parameterized `${id}` binds work against `uuid` columns via the pg adapter; confirm under integration tests
- [ ] Review `isValidUUID` regex in `routes/todos.ts` — still string-based; harmless but redundant now that the param is validated via Joi `.uuid()` in `schemas.paramsSchema`
- [ ] Run benchmarks before/after to measure index size and query latency improvement
- [ ] Update tests

**Why**: Native `uuid` columns produce ~2.25x smaller B-tree indexes, use binary comparison instead of string comparison, and reduce storage overhead on every PK and FK.

### Read Caching for Hot Paths

**Priority**: Low
**Effort**: Low-Medium
**Impact**: High under load

Redis infrastructure already exists (`docker-compose.yml`, `REDIS_URL` env var, graceful shutdown wired in `index.ts`). Read-heavy endpoints will dominate traffic. A short-lived cache would significantly reduce database load under concurrency.

- [ ] Add short-lived cache (1-5s TTL) for high-frequency read endpoints using Redis
- [ ] Invalidate on write operations scoped to the affected user
- [ ] Add `CACHE_TTL_MS` env var to `config/env.ts`
- [ ] Add cache hit/miss counter to Prometheus metrics (`middleware/metrics.ts`)
- [ ] Graceful degradation: skip cache when Redis is unavailable (same pattern as rate limiter fallback in `middleware/rateLimiter.ts`)
- [ ] Add tests for cache hit, cache miss, invalidation, and Redis-down fallback
- [ ] Note prerequisite: only implement after pool sizing/tuning (shipped) proves insufficient — same gating pattern as **Database Read Replica Preparation**

**Why**: Redis is already deployed for rate limiting, so the infrastructure cost is zero. The short TTL ensures eventual consistency without complex invalidation logic. This is the natural intermediate step between pool tuning (shipped) and read replicas (**Database Read Replica Preparation**).

### Database Circuit Breaker

**Priority**: Low
**Effort**: Medium
**Impact**: Medium (only under sustained DB failure)

Startup resilience (decorrelated-jitter retry in `lib/dbConnect.ts`) and runtime error classification (`errors/database.ts` → `classifyPrismaError()` mapping transient Prisma codes to `DatabaseUnavailableError` 503 + `Retry-After`) have shipped. A circuit breaker would add a third layer: trip after N consecutive failures to short-circuit further DB calls and let the dependency recover.

- [ ] Implement circuit breaker in `lib/circuitBreaker.ts` with configurable thresholds
- [ ] Create `lib/dbClient.ts` wrapper that routes operations through the circuit breaker
- [ ] Add circuit breaker state to `/health/ready` response
- [ ] Add `CircuitOpenError` handling in `errorHandler.ts` (503 + Retry-After)
- [ ] Add environment variables: `DB_CIRCUIT_FAILURE_THRESHOLD`, `DB_CIRCUIT_TIMEOUT_MS`
- [ ] Note prerequisite: only implement after monitoring shows sustained DB failures cascading into latency spikes — same gating pattern as **Read Caching for Hot Paths**

**Why**: A circuit breaker prevents thundering-herd retries against a struggling database — once tripped, every request fails fast with 503 + `Retry-After` instead of queueing on the pool. It is genuinely optional: it pays off only when monitoring shows sustained DB failures cascading into latency spikes. Defer until that evidence exists.

---

## Cross-Cutting Concerns

### Zero-Downtime Migration Strategy

Multiple roadmap items require database schema migrations: **User Profile Management** (User `name` field), **JWT Refresh + Token Revocation** (RefreshToken model), **Role-Based Access Control** (User `role` field). Once the API is serving live traffic, each of these needs a migration plan that avoids downtime. Document a standard approach (e.g., expand-contract pattern, Prisma `migrate deploy` in a pre-deploy step, backward-compatible column additions) before the first post-launch migration.

### PII in Request/Response Logs

Pino is configured to redact passwords, tokens, and auth headers. However, the todo `text` field — which users may populate with PII — is logged in some request/response paths. Audit whether `text` content appears in logs and add redaction or exclusion if so.

### Load Testing in CI

k6 benchmark scripts exist (`benchmarks/k6/`) but are not part of the CI pipeline. Without automated performance regression detection, latency regressions can ship unnoticed. Consider adding a lightweight k6 smoke test to the CI pipeline with a latency threshold gate.

### Deployment Decisions (Non-Goals)

- **Response compression middleware (gzip/brotli) — not added.** The expected production deployment terminates TLS at an edge load balancer (ALB or equivalent), which performs gzip compression at the edge for compressible content types when the client sends `Accept-Encoding: gzip`. The LB will not re-compress responses that already carry `Content-Encoding`, so adding `compression` middleware in the app would just shift CPU cost from the load balancer to the app server. If the deployment topology ever changes (nginx, Caddy, Cloudflare, direct exposure with no edge proxy), revisit this decision and add `compression` at the app layer.

---

## Implementation Order Recommendation

For a SOC 2-compliant production deployment, implement in this order:

### Phase A: Security & Infrastructure Foundation (SOC 2 blocking)

- ~~**Database Connection Resilience**~~ — Startup retry (decorrelated jitter) and runtime Prisma error classification (transient → 503 `DATABASE_UNAVAILABLE` + `Retry-After`) shipped. Optional circuit breaker tracked separately.
- ~~**Database Backup & DR**~~ — Done: pgBackRest live in prod, RPO/RTO defined, first A1.3 restore drill passed 2026-07-06. See **Completed** below. (Backup-failure alerting moved to **Monitoring & Observability**.)
- **Encryption at Rest** — PostgreSQL encryption, key management documentation
- **Secrets Management** — Encrypted-at-rest secret store, indirection from deploy artifact, rotation runbook

### Phase B: Authentication & Access Control (SOC 2 blocking)

- **User Profile Management** — Core profile, account deletion, data export
- **JWT Refresh + Token Revocation** — Refresh tokens, logout, token rotation (independent of User Profile Management)
- **Role-Based Access Control (RBAC)** — Role-based access, admin/user separation (uses `ForbiddenError` from `errors/index.ts`)

### Phase C: Observability & Compliance (SOC 2 blocking)

- **Monitoring & Alerting** — Grafana dashboards, alerting, OpenTelemetry distributed tracing, log aggregation, SLA targets
- **SOC 2 Documentation** — Policies, plans, risk assessment, pentest

### Phase D: Scaling & Deployment Infrastructure

- **Distributed Rate Limit Store** — Integration tests for shared counting
- **UUID Column Type Migration** — Benchmark and test follow-ups

### Phase E: Feature Development

- **API Versioning + Response Envelope** — `/api/v1/` prefix + `{ data, meta }` envelope + `API-Version` header + `Deprecation`/`Sunset` headers
- **Idempotency Keys** — `Idempotency-Key` middleware for POST endpoints
- **Email Service Integration** — Email verification via Loops.so (vendor decision required before starting)
- **Password Reset Flow** — Forgot/reset password flow (depends on Email Service Integration)
- **API Documentation** — Spec-first OpenAPI 3.1 + `CHANGELOG.md`; remaining low-priority items as time permits
- **Search & Discovery** — Phase 1: `pg_trgm` fuzzy todo search. Phase 2: Elasticsearch multi-entity search with outbox sync once comments/attachments/notes entities exist. Design memo: [docs/databases.md](docs/databases.md)

Items tagged **[SOC 2]** in Phases A–C must be completed before the SOC 2 Type II observation period can begin. The user account work is split into four independently trackable sections (User Profile Management, JWT Refresh + Token Revocation, Email Service Integration, Password Reset Flow) with clear dependency boundaries. UUID Column Type Migration is in Phase D because it is not SOC 2 blocking and should not compete with security infrastructure.

---

## Completed

### Database Backup & Disaster Recovery **[SOC 2]** — done 2026-07-06

**SOC 2**: A1.2 (Recovery Objectives), A1.3 (Recovery Testing), C1.1 (Confidential Data Protection).

Co-located pgBackRest (in the TimescaleDB image) is live in production: continuous WAL archiving + scheduled daily fulls / 6h diffs to an encrypted Railway Bucket (AES-256-CBC), self-driving (autonomous daily full + diff observed), 35-day PITR window. RPO ≤ 5 min / RTO ≤ 30 min defined. **First A1.3 restore drill passed 2026-07-06** — recovery mechanism, physical role/schema recovery, and audit immutability all verified (RTO ~112s); evidence: [docs/evidence/restore-drill-2026-07-06.md](docs/evidence/restore-drill-2026-07-06.md). Design/build: [docs/pgbackrest-implementation.md](docs/pgbackrest-implementation.md); runbook + template: [docs/operations.md](docs/operations.md#database-restore-disaster-recovery), [docs/restore-drill-report-template.md](docs/restore-drill-report-template.md).

**Carried into other tracks (not blockers here):**
- **Backup-failure alerting** → **Monitoring & Observability** (Prometheus rules on the pgBackRest metrics file; Railway has no native log-content alerting, so there is no interim).
- **Quarterly restore-drill cadence** — GitHub Actions `.github/workflows/restore-drill-reminder.yml` opens a reminder issue on the 1st of Jan/Apr/Jul/Oct (next ~2026-10-01).
- **Data-fidelity re-run** — repeat the drill with row-count assertions once production holds real user data (the 2026-07-06 drill restored an empty DB, so it proved the mechanism but not row-level fidelity).
