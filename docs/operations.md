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

Migrations do **not** run in the app container's start command. Railway runs
[`scripts/preflight-roles.ts`](../scripts/preflight-roles.ts) then `prisma migrate deploy` as the
**pre-deploy command** (`railway.json` → `deploy.preDeployCommand`) — once per deploy, in the built
image with the service env + private network, before the new version goes live. The preflight connects
via `DATABASE_MIGRATE_URL` (falling back to `DATABASE_URL`) and exits non-zero if
`db_admin`/`db_app`/`db_auditor` are missing. Because a failed pre-deploy command aborts the deploy and
keeps the previous version serving, a missing role or broken migration produces one legible failure
instead of crash-looping the app.

Transient connection/query failures are retried with decorrelated-jitter backoff — Railway's
`*.railway.internal` private networking can take a few seconds to come up in a fresh pre-deploy
container, so a single early attempt can time out spuriously. (The retry also makes a _persistent_
failure legible: six spaced attempts all timing out is what exposed the 2026-07-05 outage below as a
down database rather than a blip.) Each
failed attempt is logged with its number and next delay. The knobs are the same as the app's startup
retry, read leniently from plain env (fallback on missing/unparseable values, no envalid):
`DB_CONNECT_MAX_RETRIES` (default 5), `DB_CONNECT_INITIAL_DELAY_MS` (default 1000),
`DB_CONNECTION_TIMEOUT_MS` (default 5000), with the jitter capped at 15 s — worst case ≈ 73 s with
defaults. The deterministic outcomes — missing DSN, missing roles — still fail immediately without
retrying.

### Deploying the timescaledb image (Deploy DB workflow)

Railway services are deliberately **not** connected to the GitHub repo as a source — repo-connected
services build on every push, bypassing CI/CD. All deploys go through GitHub Actions via `railway up`:
the app via `deploy.yml`, the database image via `deploy-db.yml` (triggered by changes under
`docker/timescaledb/**`, or manually). The DB deploy must use
`railway up docker/timescaledb --path-as-root` — `railway up` archives the linked project directory
regardless of cwd, so without `--path-as-root` the app's root `Dockerfile` gets built onto the
timescaledb service.

Lessons from the 2026-06-04 → 2026-07-05 staging outage (DB down a month, every deploy failing at
preflight):

- **Changing service settings does not change the running image.** Setting the start command to
  `/usr/local/bin/pgbackrest-entrypoint.sh` while the service still ran the stock timescale image
  crash-looped the replacement and — because the service is volume-backed, so the old deployment stops
  before the new one starts — took the database down entirely. Ship the image first (Deploy DB
  workflow); avoid start-command overrides that reference files only some images contain.
- **A misnamed `PGBACKREST_*` variable silently disables backups.** The entrypoint treats missing
  repo vars as "not configured" and boots Postgres _without archiving_ by design (a backup
  misconfiguration must never stop the database). After any variable change, check the boot logs: a
  healthy boot shows `stanza-create … completed successfully` and a successful `archive-push`; a
  misconfigured one shows `WARNING: pgBackRest repo not configured (missing: …)`.

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
4. **Verify** (inside the service):
   - `psql -c '\du'` — `db_admin`, `db_app`, `db_auditor` present
   - `psql -c '\dt'` — `users`, `todos`, `audit_entries`, `_prisma_migrations` present
   - Immutability: `SET ROLE db_app; UPDATE audit_entries SET action='x' WHERE false;` → must fail `42501`
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

1. Provision a **throwaway** timescaledb service; restore the latest backup (Scenario A, steps 2–4).
2. Point a scratch `todo-api` at it; run `pnpm test:integration`.
3. Document: date, backup ID (`pgbackrest --stanza=todo-api info`), wall-clock restore time, pass/fail counts.
4. Tear down. File the report as SOC 2 A1.3 evidence.
