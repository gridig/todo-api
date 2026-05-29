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
