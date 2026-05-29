// Deploy preflight: fail fast with a legible message if the Postgres roles the
// migrations depend on are missing, instead of letting `prisma migrate deploy`
// die at a `REVOKE … FROM db_app` and crash-loop the container on P3009.
//
// Background (2026-05-29 incident): prod was never bootstrapped with the
// db_admin/db_app/db_auditor roles — the model existed only in dev/CI — so the
// first migration to reference them failed and blocked every redeploy. This
// check turns that class of failure into a clear, one-line deploy error.
//
// Runs in the container CMD before migrate. Reads env directly (no envalid) so a
// missing app secret can't mask the role problem.
import { Pool } from 'pg';

// Mirrors prisma.config.ts: migrations connect via DATABASE_MIGRATE_URL when set,
// otherwise DATABASE_URL.
const connectionString = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL;

// Roles the 3-role model and the audit-log migration require to exist.
const REQUIRED_ROLES = ['db_admin', 'db_app', 'db_auditor'];

async function main(): Promise<number> {
  if (!connectionString) {
    console.error(
      'preflight-roles: neither DATABASE_MIGRATE_URL nor DATABASE_URL is set — cannot verify DB roles.',
    );
    return 1;
  }

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const { rows } = await pool.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
      [REQUIRED_ROLES],
    );
    const present = new Set(rows.map((r) => r.rolname));
    const missing = REQUIRED_ROLES.filter((role) => !present.has(role));

    if (missing.length > 0) {
      console.error(
        `preflight-roles: missing required DB role(s): ${missing.join(', ')}.\n` +
          'Run prisma/sql/bootstrap_roles_prod.sql against this database as a superuser ' +
          'before deploying — see docs/operations.md (Database role bootstrap).',
      );
      return 1;
    }

    console.log(`preflight-roles: OK — required roles present (${REQUIRED_ROLES.join(', ')}).`);
    return 0;
  } catch (err) {
    console.error(
      'preflight-roles: could not verify DB roles (connection or query failed):',
      err instanceof Error ? err.message : err,
    );
    return 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('preflight-roles: unexpected failure:', err);
    process.exit(1);
  },
);
