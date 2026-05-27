-- Run as superuser once per environment, before `prisma migrate deploy`.
-- Dev-only passwords; production roles are created via the platform's
-- secrets UI and this file is not run there.

CREATE ROLE db_admin WITH LOGIN PASSWORD 'db_admin_dev';
CREATE ROLE db_app WITH LOGIN PASSWORD 'db_app_dev';
CREATE ROLE db_auditor WITH LOGIN PASSWORD 'db_auditor_dev';

ALTER SCHEMA public OWNER TO db_admin;
GRANT CREATE, USAGE ON SCHEMA public TO db_admin;
GRANT USAGE ON SCHEMA public TO db_app, db_auditor;

-- Postgres 15+ stripped CREATE on database from PUBLIC. Prisma's `0_init`
-- migration does `CREATE SCHEMA IF NOT EXISTS "public"` which trips the
-- database-level CREATE check even when the schema already exists.
DO $$ BEGIN
  EXECUTE 'GRANT CREATE ON DATABASE ' || quote_ident(current_database()) || ' TO db_admin';
END $$;

-- Tables created by db_admin auto-grant runtime CRUD to db_app. A migration
-- run under any other role produces an un-granted table — surfaces the
-- misconfiguration loudly instead of silently locking out the app.
ALTER DEFAULT PRIVILEGES FOR ROLE db_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO db_app;
ALTER DEFAULT PRIVILEGES FOR ROLE db_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO db_app;
