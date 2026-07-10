# Operations

Runbooks for deploying and recovering the database. See [configuration.md](configuration.md)
for the env-var reference and [databases.md](databases.md) for the role-model rationale.

## Database role bootstrap (once per environment)

The app uses three Postgres roles — `db_admin` (migrations / schema owner), `db_app` (runtime,
append-only on `audit_entries`), `db_auditor` (read-only). REVOKE-based audit immutability and the
startup tamper-probe (`src/index.ts`) only work if the app connects as the non-superuser `db_app`,
so **these roles must exist before the first `prisma migrate deploy`.**

- **Dev:** created automatically — `docker-compose.yml` mounts `prisma/sql/bootstrap_roles.sql` into
  the Postgres `docker-entrypoint-initdb.d` hook.
- **CI:** `.github/workflows/ci.yml` runs the same file via `psql`.
- **Production (Railway):** run [`prisma/sql/bootstrap_roles_prod.sql`](../prisma/sql/bootstrap_roles_prod.sql)
  once, as a superuser, with real passwords from your secret store:

  ```bash
  psql "$SUPERUSER_URL" \
    -v admin_pw="$DB_ADMIN_PW" -v app_pw="$DB_APP_PW" -v aud_pw="$DB_AUDITOR_PW" \
    -f prisma/sql/bootstrap_roles_prod.sql
  ```

  It is idempotent (skips roles that already exist) and safe against a populated DB (it also
  reassigns existing-table ownership to `db_admin` and grants `db_app`). Then set the service vars:

  ```
  DATABASE_URL=postgresql://db_app:<app_pw>@<host>:5432/<db>
  DATABASE_MIGRATE_URL=postgresql://db_admin:<admin_pw>@<host>:5432/<db>
  ```

  Railway's private `*.railway.internal` host is only reachable in-network; for one-off `psql` from a
  laptop, use the service's **public TCP proxy** URL instead.

### Deploy preflight & migrations (Railway pre-deploy command)

Migrations do **not** run in the app container's start command. Railway runs a single pre-deploy
entrypoint — [`scripts/predeploy.ts`](../scripts/predeploy.ts) (`node dist/scripts/predeploy.js`, wired
in `railway.json` → `deploy.preDeployCommand`) — once per deploy, in the built image with the service
env + private network, before the new version goes live. It runs three gates in order, each aborting the
deploy (non-zero exit → Railway keeps the previous version serving) on failure:

1. **Roles present** — [`runPreflight`](../scripts/preflight-roles.ts) connects via `DATABASE_MIGRATE_URL`
   (falling back to `DATABASE_URL`) and exits non-zero if `db_admin`/`db_app`/`db_auditor` are missing.
2. **`prisma migrate deploy`** — apply pending migrations.
3. **`prisma migrate status`** — assert the schema is fully up to date. This is the gate that guarantees a
   release can never go live against an unmigrated database (the 2026-07-10 incident: a build shipped with
   its migrations unapplied, so every register/login 500'd against the missing `email_hash` column). The
   three steps run in one Node process with explicit exit codes rather than a chained `A && B` shell
   string, so the migrate/verify gate can't be silently skipped.

**Multi-phase (expand → backfill → contract) migrations** — e.g. the email-encryption rollout — require an
operator-run data backfill *between* migrations that `prisma migrate deploy` cannot perform, so step 2
fails and **correctly blocks auto-deploy**. Roll them out manually: apply the expand migration, run the
backfill (`node dist/scripts/backfill-email-crypto.js --phase=…`), then apply the enforce/contract
migrations (see "Field encryption key management & rotation" below), and only then redeploy. Do **not**
expect these to ship via a plain push-to-`main`.

Transient connection/query failures are retried with decorrelated-jitter backoff — Railway's
`*.railway.internal` private networking can take a few seconds to come up in a fresh pre-deploy
container (the 2026-07-05 deploy failure), so a single early attempt can time out spuriously. Each
failed attempt is logged with its number and next delay. The knobs are the same as the app's startup
retry, read leniently from plain env (fallback on missing/unparseable values, no envalid):
`DB_CONNECT_MAX_RETRIES` (default 5), `DB_CONNECT_INITIAL_DELAY_MS` (default 1000),
`DB_CONNECTION_TIMEOUT_MS` (default 5000), with the jitter capped at 15 s — worst case ≈ 73 s with
defaults. The deterministic outcomes — missing DSN, missing roles — still fail immediately without
retrying.

## Recovering a failed migration (Prisma P3009)

When a migration fails partway, Prisma records it as failed and **every subsequent deploy aborts with
P3009** until it's resolved (https://pris.ly/d/migrate-resolve). The 2026-05-29 incident — migration
`20260526000001_add_audit_entries` failed on `REVOKE … FROM db_app` because prod had no `db_*` roles —
was recovered as follows. Run against the prod DB as a superuser (via the public TCP proxy).

1. **Freeze deploys** so the crash-loop and pushes don't fight the recovery.
2. **Assess** (read-only): which migration row is unfinished (`finished_at IS NULL` in
   `_prisma_migrations`), whether the migration's objects partially landed (`to_regclass`, hypertable,
   row count), and which roles/owners exist (`pg_roles`, `pg_tables`). **Inspect — don't assume:**
   TimescaleDB calls (`create_hypertable`, `add_retention_policy`) commit mid-migration, so a "failed"
   migration can still have created the table.
3. **Provision the missing roles** with `bootstrap_roles_prod.sql` (above) if they're the cause.
4. **Clear the partial state.** If the migration's new table is empty (verify `count(*) = 0`), drop it
   so the rerun is clean: `DROP TABLE <t> CASCADE;` (irreversible — only at row count 0).
5. **Mark rolled back, then rerun as `db_admin`** (so default privileges grant `db_app`, and DDL is
   owned by `db_admin`):

   ```bash
   export DATABASE_MIGRATE_URL="postgresql://db_admin:<pw>@<proxy-host>:<port>/<db>"
   pnpm exec prisma migrate resolve --rolled-back <migration_name>
   pnpm exec prisma migrate deploy
   ```

   Use `--rolled-back` only after the partial objects are gone (else the rerun hits "already exists").
   If you instead completed the changes by hand, use `--applied` and Prisma won't re-run the SQL.

6. **Repoint + redeploy:** set `DATABASE_URL`→`db_app`, `DATABASE_MIGRATE_URL`→`db_admin`, re-enable
   deploys. The app boots as `db_app`; confirm the logs show `Audit-log tamper-evidence probe passed`
   and `Server started successfully`, and `/health/ready` returns 200.
7. **Verify immutability** as `db_app`: `UPDATE`/`TRUNCATE` on `audit_entries` must return
   `permission denied` (42501); `INSERT`/`SELECT` succeed.

> **Never edit a committed, already-attempted migration** to work around this — Prisma checksums each
> migration file, so editing one breaks every environment that already ran it. Fix the environment, or
> add a new migration.

## Migration hazards

Two standing hazards in the committed migration chain. Neither can be edited away (see the checksum
warning above); they are documented so nobody trips them.

### `0_init` must never be baselined alone

`20260131221639_init` begins with `DROP TABLE "Todo"` / `DROP TABLE "User"` — it replaces the
PascalCase tables that `0_init` creates with the snake_case `todos`/`users` schema. On the normal
fresh-database chain this is harmless (the dropped tables are seconds old and empty). It becomes
**data loss** if `0_init` is ever baselined onto an existing database that holds data in those
tables: `prisma migrate resolve --applied 0_init` followed by `migrate deploy` runs the DROPs
against live data.

Rule: **baseline all migrations or none.** When adopting an existing database, mark the full chain
applied (or restore-and-replay); never mark a prefix of it.

(A squash-baseline that removes the pair entirely was considered and deferred: rewriting the chain
risks divergence across the three live environments for a bug that is latent-only.)

### `audit_entries` guarantees live outside `schema.prisma`

The audit table's hypertable conversion, its four `idx_audit_*` indexes, the 1-year retention
policy, and the append-only `REVOKE UPDATE, DELETE, TRUNCATE … FROM db_app` exist **only** in raw
SQL (`prisma/migrations/20260526000001_add_audit_entries/migration.sql`). Prisma's schema knows
none of them, so schema-diffing tools will try to "fix" the difference:

- **Never run `prisma db push`** against any database with the audit table — it diffs live DB
  against `schema.prisma` and will drop the indexes and can desync the REVOKE.
- **Always create migrations with `prisma migrate dev --create-only`** and hand-review the generated
  SQL before applying. Delete any generated statement that touches `audit_entries` (`DROP INDEX
idx_audit_*`, `ALTER TABLE audit_entries …`) unless the change is deliberate.

A guard test (`__tests__/unit/migrations-guard.test.ts`) fails CI if a committed migration contains
such statements — that is the enforcement point; this section is the explanation.

## Field encryption key management & rotation

The `users.email` PII column is encrypted at the application layer (SOC 2 CC6.1 / C1.1). Design
overview: [configuration.md → Encryption at rest](configuration.md#encryption-at-rest). This section
is the operational runbook.

### Keys and custody

Three env vars, held as **Railway per-environment secrets** (never committed; distinct values for
`staging` and `production`):

- `ENCRYPTION_KEYRING` — `<keyId>:<base64-32-byte-key>` entries. The keyring can hold several keys at
  once; each ciphertext embeds the keyId it was written with.
- `ENCRYPTION_ACTIVE_KEY_ID` — the keyId new writes use.
- `ENCRYPTION_BLIND_INDEX_KEY` — the HMAC key behind `users.email_hash`.

Generate any key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Access is governed by Railway's secret-access controls.

> **CC6.2 read-side-audit gap (accepted).** Env-var secret stores (Railway) encrypt secrets at rest
> and gate access, but do **not** log _who read a key and when_. A managed KMS (AWS KMS, Vault) would
> close that read-side audit gap. It is deferred: the `KeyProvider` interface (`src/lib/crypto/keyProvider.ts`)
> lets a KMS backend drop in later with no call-site changes. Review key access as part of the
> quarterly access review until then. Tracked under the Secrets Management roadmap item.

> **A bad keyring is a login outage.** If `ENCRYPTION_ACTIVE_KEY_ID` is missing from the ring, or a
> retired key still referenced by stored ciphertext is dropped, boot fails (active-key check) or
> `findByEmail` decrypt throws (`UnknownKeyIdError`). Retire a key only after a re-encryption sweep
> (below) confirms no rows reference it.

### Initial rollout (migrations + backfill)

Three migrations stage the change (`20260709000001`/`_2`/`_3`). The key material must never appear in
migration SQL (it would leak into `db_admin` logs), so the data transform is
[`scripts/backfill-email-crypto.ts`](../scripts/backfill-email-crypto.ts), run as an operator with the
app env present (it connects via `DATABASE_MIGRATE_URL`).

**Empty database (current production):** `users` is empty (verify `SELECT count(*) FROM users` = 0), so
`prisma migrate deploy` applies all three migrations in one step and the backfill phases are no-ops.
Nothing else to do.

**Populated database (zero-downtime):**

1. Apply migration `..._add_email_hash` (adds nullable `email_hash`).
2. `node dist/scripts/backfill-email-crypto.js --phase=hash` — populates `email_hash` from the current
   plaintext email. Collision-checked (fails closed).
3. Apply migration `..._email_hash_unique` **with the app deploy that reads by blind index** (NOT NULL
   - `UNIQUE`). For a large table, swap the in-migration `SET NOT NULL` / `CREATE UNIQUE INDEX` for the
     `CHECK … NOT VALID` → `VALIDATE` and `CREATE UNIQUE INDEX CONCURRENTLY` variants noted in the
     migration SQL (`CONCURRENTLY` can't run inside Prisma's migration transaction).
4. `node dist/scripts/backfill-email-crypto.js --phase=encrypt` — encrypts remaining plaintext rows.
5. Apply migration `..._drop_email_unique` (drops the old plaintext unique index).

Use `--dry-run` to preview counts; `--batch=<n>` to tune batch size.

### Rotating the ciphertext key (lazy, low-risk)

Old ciphertext keeps its embedded keyId, so old and new keys coexist:

1. Add a new key to `ENCRYPTION_KEYRING` (keep the old one).
2. Point `ENCRYPTION_ACTIVE_KEY_ID` at the new keyId and deploy — new writes use it immediately.
3. Re-encrypt existing rows to the active key: `node dist/scripts/backfill-email-crypto.js --phase=encrypt`
   (it also re-encrypts rows whose keyId ≠ active).
4. After the sweep, remove the old key from the keyring.

### Rotating the blind-index (HMAC) key (eager, coordinated)

`email_hash` must be a single deterministic value per row, so this key cannot rotate lazily — changing
it invalidates every lookup until all rows are re-hashed. Do it in a maintenance window:

1. Set the new `ENCRYPTION_BLIND_INDEX_KEY`.
2. Immediately run `node dist/scripts/backfill-email-crypto.js --phase=rehash` — it decrypts each email
   and recomputes `email_hash` with the new key (collision-checked). Logins that land mid-run miss until
   their row is rehashed, hence the maintenance window. Rotate this key rarely.

## Database restore (disaster recovery)

The TimescaleDB service runs pgBackRest co-located in its container, archiving WAL continuously and
taking scheduled base backups to a Railway Bucket. Design and build details are in
[databases.md](databases.md) and [pgbackrest-implementation.md](pgbackrest-implementation.md).

### Recovery targets

| Metric | Target       | Bounded by                                     |
| ------ | ------------ | ---------------------------------------------- |
| RPO    | ≤ 5 minutes  | `archive_timeout = 60s` + WAL push latency     |
| RTO    | ≤ 30 minutes | Provision + restore + WAL replay + app repoint |

> pgBackRest takes **physical** backups of the whole cluster — `pg_authid` (roles + passwords), all
> databases, and the `REVOKE`-based audit immutability are included. A restore does **not** need role
> re-bootstrap (that is only for logical `pg_dump` restores); `bootstrap_roles*.sql` does not run on a
> restored volume and does not need to.

### Scenario A: full database loss

1. **Stop writes** — stop the `todo-api` service so nothing writes during recovery.
2. **Provision a fresh timescaledb service** from `docker/timescaledb/Dockerfile` with an **empty** data
   volume and the same `PGBACKREST_*` env (same bucket, keys, cipher pass, stanza).
3. **Set restore env** on that service and deploy: `PGBACKREST_RESTORE=1`. The entrypoint restores into
   the empty `PGDATA` before Postgres starts; Postgres then replays WAL to the latest point and promotes.
4. **Verify** (inside the service via `railway ssh --service <svc> "..."`):
   - `psql -c '\du'` — `db_admin`, `db_app`, `db_auditor` present
   - `psql -c '\dt'` — `users`, `todos`, `audit_entries`, `_prisma_migrations` present
   - Immutability: `psql -c "SET ROLE db_app; UPDATE audit_entries SET action='x' WHERE false;"` → must fail `42501`
5. **Clear restore env** — set `PGBACKREST_RESTORE=0` (or remove it) and redeploy, so the service does
   not re-restore on its next restart.
6. **Repoint the app** — point `DATABASE_URL` / `DATABASE_MIGRATE_URL` at the restored service and
   redeploy `todo-api`. Confirm startup logs: `preflight-roles: OK`, `Audit-log tamper-evidence probe
passed`, `Server started successfully`, and `/health/ready` → 200.

### Scenario B: point-in-time recovery (bad migration / data corruption)

Same as Scenario A, but in step 3 also set
`PGBACKREST_RESTORE_ARGS=--type=time --target="2026-06-01 12:00:00+00"`. Add `--target-exclusive` to
stop _before_ the bad event; use `--delta` instead of an empty volume to restore in place over existing
data.

### Quarterly restore drill (SOC 2 A1.3)

Restores real production backups into a throwaway service, proves the data + audit
immutability came back, and files an evidence report. Copy
[restore-drill-report-template.md](restore-drill-report-template.md) and fill it as you go.

**Repo isolation (important).** The drill service runs the same entrypoint as prod — it starts
`backup-scheduler.sh` and enables `archive_mode=on`, so pointed at the **production** repo it could
push WAL / take backups into it and, after promotion, fork a new timeline. The clean isolation is a
**separate scratch bucket holding a copy of the repo**: the drill reads and writes only the copy and
physically cannot touch prod. (Read-only credentials would also isolate it in principle, but **Railway
Buckets issue only one full-access key pair — there are no read-only scoped keys** — so the copy is the
practical path.)

1. **Record the target.** `railway ssh --service timescaledb "pgbackrest --stanza=todo-api info"` —
   note the latest full backup ID (e.g. `20260706-020047F`) and the current `wal archive max` (pins the
   restore point + lets you compute achieved RPO). Also grab the prod repo's S3 keys/endpoint/bucket:
   `railway variables --service timescaledb --json | jq -r '.PGBACKREST_REPO_S3_KEY, .PGBACKREST_REPO_S3_KEY_SECRET, .PGBACKREST_REPO_S3_ENDPOINT, .PGBACKREST_REPO_S3_BUCKET'`
   (use `--json`/`jq` or `--kv`, not the plain table — it truncates long secrets).
2. **Copy the repo to a scratch bucket.** Provision a second Railway Bucket (e.g. `todo-api-drill`);
   note its keys/bucket name. Then copy the prod repo across with two `rclone` S3 remotes (same
   endpoint):
   ```bash
   rclone config create prodbkt  s3 provider Other endpoint <ENDPOINT> region auto \
     access_key_id "<PROD_KEY>"  secret_access_key "<PROD_SECRET>"
   rclone config create drillbkt s3 provider Other endpoint <ENDPOINT> region auto \
     access_key_id "<DRILL_KEY>" secret_access_key "<DRILL_SECRET>"
   rclone sync prodbkt:<prod-bucket> drillbkt:<drill-bucket> --progress
   rclone ls drillbkt:<drill-bucket> | head   # expect backup/todo-api/... + archive/todo-api/...
   ```
   The repo is encrypted — `rclone sync` copies the **ciphertext byte-for-byte**, so the drill must use
   the **same `PGBACKREST_CIPHER_PASS`**. Do not re-encrypt or change the cipher pass.
3. **Provision a throwaway `timescaledb-drill` service** (staging environment or a scratch project)
   from `docker/timescaledb/Dockerfile`, empty volume, pointed at the **scratch** bucket:
   - `PGBACKREST_*` repo config for the **scratch** bucket (its endpoint, region, name, keys) + the
     **same** `PGBACKREST_CIPHER_PASS` and `PGBACKREST_STANZA=todo-api` as prod;
   - `PGBACKREST_RESTORE=1`;
   - `PGBACKREST_PG1_USER=railway` — the restored cluster's superuser (Railway-origin clusters have
     `railway`, not `postgres`); without it the post-restore scheduler logs harmless but noisy
     `role "postgres" does not exist` on its backup attempts;
   - Stamp the start time (`date -u`) — the RTO clock starts at the deploy trigger.
     Build with `railway up docker/timescaledb --path-as-root --ci --service timescaledb-drill`
     (`--path-as-root` is load-bearing — else it builds the app's root Dockerfile onto the service).
4. **Deploy and watch logs:** expect `=== RESTORE MODE: restoring 'todo-api' ...`, then Postgres start
   - WAL replay (`restored log file ...`), then `database system is ready to accept connections`
     (the image is `PostgreSQL 16` — if you see `PostgreSQL 18` / `wrapper:` lines it's Railway's managed
     image, not ours).
5. **Verify data + immutability** (via `railway ssh --service timescaledb-drill "psql -U railway -d railway -c '...'"`):
   - `\du` — `db_admin`, `db_app`, `db_auditor` present (roles restored physically).
   - `\dt` — `users`, `todos`, `audit_entries`, `_prisma_migrations` present.
   - Row sanity: `SELECT count(*) FROM users; SELECT count(*) FROM todos; SELECT count(*), max(changed_at) FROM audit_entries;`
     — compare against prod (note: `audit_entries`' time column is `changed_at`, not `createdAt`); the
     newest audit row bounds achieved RPO.
   - Immutability probe: `SET ROLE db_app; UPDATE audit_entries SET action='x' WHERE false;`
     → **must** fail `42501` (`permission denied for table audit_entries`).
   - `pgbackrest --stanza=todo-api info` shows the backup set used.
6. **App-level check.** Point a scratch `todo-api` at the drill DB (`DATABASE_URL` /
   `DATABASE_MIGRATE_URL`), deploy, confirm startup logs (`preflight-roles: OK`,
   `Audit-log tamper-evidence probe passed`, `/health/ready → 200`), then run
   `pnpm test:integration` against it → green.
7. **Stop the RTO clock** at the first `/health/ready → 200`. Wall-clock = step-3 trigger → here.
   Compare to the RTO ≤ 30 min target.
8. **Tear down** the scratch `todo-api`, the `timescaledb-drill` service + volume, **and the scratch
   bucket**.
9. **File evidence** — complete the report template and commit it as
   `docs/evidence/restore-drill-YYYY-MM-DD.md`.
