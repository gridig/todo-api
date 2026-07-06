// Deploy preflight: fail fast with a legible message if the Postgres roles the
// migrations depend on are missing, instead of letting `prisma migrate deploy`
// die at a `REVOKE … FROM db_app` and crash-loop the container on P3009.
//
// Background (2026-05-29 incident): prod was never bootstrapped with the
// db_admin/db_app/db_auditor roles — the model existed only in dev/CI — so the
// first migration to reference them failed and blocked every redeploy. This
// check turns that class of failure into a clear, one-line deploy error.
//
// Runs via railway.json's `deploy.preDeployCommand`
// (`node dist/scripts/preflight-roles.js && pnpm exec prisma migrate deploy`);
// the Dockerfile CMD starts the app only. Reads env directly (no envalid) so a
// missing app secret can't mask the role problem — for the same reason it must
// not import src/config/env.ts or the pino logger, only the dependency-free
// retry helper (src/lib/retry.ts).
//
// Transient connection/query failures are retried with jittered backoff
// (2026-07-05 incident: Railway's *.railway.internal private networking takes
// a few seconds to come up in fresh pre-deploy containers, and a single 5s
// attempt at boot lost that race and aborted the deploy). The deterministic
// outcomes — missing DSN, missing roles — still fail immediately.
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { flattenErrorMessage, retryWithBackoff } from '../src/lib/retry.js';

// Roles the 3-role model and the audit-log migration require to exist.
const REQUIRED_ROLES = ['db_admin', 'db_app', 'db_auditor'];

// Tighter jitter cap than the app's 30s: keeps the worst case with default
// knobs (6 attempts × 5s timeout + sleeps of 1+3+9+15+15s) around 73s — a
// sane budget for a pre-deploy step.
const PREFLIGHT_MAX_DELAY_MS = 15_000;

type Env = Record<string, string | undefined>;

interface PreflightLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// Lenient by design (no envalid): missing/empty/NaN/negative → fallback.
const envInt = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
};

// Fresh pool per attempt: a client kept across the retry sleep could emit an
// unhandled pool 'error' (e.g. server-side kill) and crash the process
// mid-retry; each attempt dials a fresh TCP connection either way.
const defaultQueryRoles = async (
  connectionString: string,
  connectionTimeoutMillis: number,
): Promise<string[]> => {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis });
  try {
    const { rows } = await pool.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
      [REQUIRED_ROLES],
    );
    return rows.map((r) => r.rolname);
  } finally {
    // end() failing must not mask the query/connect error.
    await pool.end().catch(() => undefined);
  }
};

export interface PreflightOptions {
  env?: Env;
  queryRoles?: (connectionString: string, connectionTimeoutMillis: number) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: PreflightLogger;
}

export async function runPreflight(options: PreflightOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const queryRoles = options.queryRoles ?? defaultQueryRoles;
  const log = options.log ?? console;

  // Mirrors prisma.config.ts: migrations connect via DATABASE_MIGRATE_URL when
  // set, otherwise DATABASE_URL. || not ??: an explicitly-empty
  // DATABASE_MIGRATE_URL must fall back too.
  const connectionString = env.DATABASE_MIGRATE_URL || env.DATABASE_URL;
  if (!connectionString) {
    log.error(
      'preflight-roles: neither DATABASE_MIGRATE_URL nor DATABASE_URL is set — cannot verify DB roles.',
    );
    return 1;
  }

  // Same knob names and defaults as src/config/env.ts.
  const maxRetries = envInt(env, 'DB_CONNECT_MAX_RETRIES', 5);
  const initialDelayMs = envInt(env, 'DB_CONNECT_INITIAL_DELAY_MS', 1000);
  const connectionTimeoutMs = envInt(env, 'DB_CONNECTION_TIMEOUT_MS', 5000);

  let roleNames: string[];
  try {
    roleNames = await retryWithBackoff(() => queryRoles(connectionString, connectionTimeoutMs), {
      maxRetries,
      initialDelayMs,
      maxDelayMs: PREFLIGHT_MAX_DELAY_MS,
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.random && { random: options.random }),
      onFailedAttempt: ({ error, attempt, nextDelayMs }) => {
        log.error(
          `preflight-roles: connection attempt ${attempt}/${maxRetries + 1} failed ` +
            `(${flattenErrorMessage(error)}); retrying in ${nextDelayMs}ms`,
        );
      },
    });
  } catch (err) {
    log.error(
      `preflight-roles: could not verify DB roles (connection or query failed, ` +
        `${maxRetries + 1} attempt(s)):`,
      flattenErrorMessage(err),
    );
    return 1;
  }

  const present = new Set(roleNames);
  const missing = REQUIRED_ROLES.filter((role) => !present.has(role));

  if (missing.length > 0) {
    log.error(
      `preflight-roles: missing required DB role(s): ${missing.join(', ')}.\n` +
        'Run prisma/sql/bootstrap_roles_prod.sql against this database as a superuser ' +
        'before deploying — see docs/operations.md (Database role bootstrap).',
    );
    return 1;
  }

  log.log(`preflight-roles: OK — required roles present (${REQUIRED_ROLES.join(', ')}).`);
  return 0;
}

// Run only when executed directly, so tests can import runPreflight.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPreflight().then(
    (code) => process.exit(code),
    (err) => {
      console.error('preflight-roles: unexpected failure:', err);
      process.exit(1);
    },
  );
}
