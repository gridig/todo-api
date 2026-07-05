-- Production role bootstrap. Run ONCE per environment as a superuser, BEFORE
-- the first `prisma migrate deploy`:
--
--   psql "$SUPERUSER_URL" \
--     -v admin_pw="$DB_ADMIN_PW" -v app_pw="$DB_APP_PW" -v aud_pw="$DB_AUDITOR_PW" \
--     -f prisma/sql/bootstrap_roles_prod.sql
--
-- Unlike prisma/sql/bootstrap_roles.sql (dev/CI: fixed dev passwords, assumes a
-- fresh schema via the docker initdb hook), this script:
--   * takes real passwords as psql variables (never literals in the repo),
--   * is idempotent — skips roles that already exist,
--   * retrofits an EXISTING database (reassigns ownership + grants on tables
--     created before the roles existed), so it doubles as the recovery step for
--     the 2026-05-29 incident where prod ran as a single superuser.
--
-- The three -v passwords are required on the FIRST run. On re-runs (roles already
-- present) they are not referenced, so they can be omitted. See docs/operations.md.

\set ON_ERROR_STOP on

-- 1. Roles — create only if absent (idempotent; does NOT reset an existing password).
SELECT (NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'db_admin'))::text AS _mk_admin \gset
\if :_mk_admin
CREATE ROLE db_admin LOGIN PASSWORD :'admin_pw';
\endif

SELECT (NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'db_app'))::text AS _mk_app \gset
\if :_mk_app
CREATE ROLE db_app LOGIN PASSWORD :'app_pw';
\endif

SELECT (NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'db_auditor'))::text AS _mk_aud \gset
\if :_mk_aud
CREATE ROLE db_auditor LOGIN PASSWORD :'aud_pw';
\endif

-- 2. Schema ownership + usage (mirrors bootstrap_roles.sql; idempotent).
ALTER SCHEMA public OWNER TO db_admin;
GRANT CREATE, USAGE ON SCHEMA public TO db_admin;
GRANT USAGE ON SCHEMA public TO db_app, db_auditor;
DO $$ BEGIN
  EXECUTE 'GRANT CREATE ON DATABASE ' || quote_ident(current_database()) || ' TO db_admin';
END $$;

-- 3. Retrofit existing objects (no-op on a fresh DB): hand them to db_admin so
--    future migrations, which run as db_admin, can ALTER/own them.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO db_admin', r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO db_admin', r.sequence_name);
  END LOOP;
END $$;

-- 4. Default privileges for FUTURE db_admin-created tables. The audit-log
--    migration relies on this: db_app gets full CRUD on the new table, then the
--    migration REVOKEs UPDATE/DELETE/TRUNCATE to leave it append-only.
ALTER DEFAULT PRIVILEGES FOR ROLE db_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO db_app;
ALTER DEFAULT PRIVILEGES FOR ROLE db_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO db_app;

-- 5. Grant db_app on EXISTING tables/sequences — default privileges (step 4)
--    only affect future objects, so retrofit the current ones.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO db_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO db_app;

-- 6. Preserve audit-log immutability if audit_entries already exists. Step 5's
--    blanket grant would re-arm UPDATE/DELETE on it — trim back to append-only
--    and ensure the auditor can read. On a fresh DB this is a no-op (the table
--    does not exist yet; the migration applies the same REVOKE/GRANT on create).
DO $$ BEGIN
  IF to_regclass('public.audit_entries') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_entries FROM db_app;
    GRANT SELECT ON public.audit_entries TO db_auditor;
  END IF;
END $$;
