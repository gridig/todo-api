// Operator-run role change: set a user's authorization role by email. Peer of
// scripts/backfill-email-crypto.ts; run as `node dist/scripts/promote-admin.js
// <email> [--role=admin|user] [--force]` with the app env present (it imports the
// crypto layer to compute the email blind index, so ENCRYPTION_* must be set).
// Connects via DATABASE_MIGRATE_URL (db_admin) like the migrations do.
//
// This is the bootstrap path for the first admin — you cannot reach the /admin
// API without already being an admin. The change is written to audit_entries
// (action admin.user.role.change, metadata.via=promote-admin-script) so a
// script grant appears in the same access-review stream as an API grant.
//
//   node dist/scripts/promote-admin.js alice@example.com            # → admin
//   node dist/scripts/promote-admin.js bob@example.com --role=user  # demote
//   node dist/scripts/promote-admin.js bob@example.com --role=user --force  # demote the last admin
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
// blindIndex normalizes the email internally (NFC + lowercase + trim), so the
// hash matches what UserService.create/findByEmail stored in users.email_hash.
import { blindIndex } from '../src/lib/crypto/fieldCrypto.js';
import { AuditAction } from '../src/lib/auditActions.js';

const ROLES = ['user', 'admin'] as const;
type Role = (typeof ROLES)[number];

export interface Options {
  email: string;
  role: Role;
  force: boolean;
}

export function parseArgs(argv: string[]): Options {
  let email: string | undefined;
  let role: Role = 'admin';
  let force = false;
  for (const arg of argv) {
    if (arg.startsWith('--role=')) {
      const value = arg.slice('--role='.length);
      if (!ROLES.includes(value as Role)) {
        throw new Error(`--role must be one of ${ROLES.join(', ')} (got "${value}")`);
      }
      role = value as Role;
    } else if (arg === '--force') {
      force = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (email === undefined) {
      email = arg;
    } else {
      throw new Error(`unexpected extra argument "${arg}"`);
    }
  }
  if (!email) throw new Error('email is required: promote-admin <email> [--role=admin|user] [--force]');
  return { email, role, force };
}

// host/db from the DSN, for the pre-mutation echo. Best-effort — a DSN that
// doesn't parse just yields a placeholder, never an error.
function describeTarget(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}/${u.pathname.replace(/^\//, '') || '(default)'}`;
  } catch {
    return '(unparseable DSN)';
  }
}

async function main(): Promise<number> {
  const { email, role, force } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('promote-admin: neither DATABASE_MIGRATE_URL nor DATABASE_URL is set.');
    return 1;
  }
  // Name the target DB up front so a mis-pointed env is caught by eye.
  console.log(`promote-admin: connecting to ${describeTarget(connectionString)}`);

  const emailHash = blindIndex(email);
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the target row so a concurrent change can't race the guard below.
    const found = await client.query<{ id: string; role: string }>(
      'SELECT id, role FROM users WHERE email_hash = $1 FOR UPDATE',
      [emailHash],
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      // Never echo the raw email beyond this operator invocation's own argv.
      console.error('promote-admin: no user found for the given email.');
      return 1;
    }
    const target = found.rows[0]!;
    if (target.role === role) {
      await client.query('ROLLBACK');
      console.log(`promote-admin: user ${target.id} already has role=${role}; nothing to do.`);
      return 0;
    }

    // Last-admin guard: refuse to demote the only remaining admin (which would
    // lock everyone out of /admin) unless the operator passes --force.
    if (target.role === 'admin' && role === 'user') {
      const admins = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM users WHERE role = 'admin'",
      );
      if ((admins.rows[0]?.n ?? 0) <= 1 && !force) {
        await client.query('ROLLBACK');
        console.error(
          'promote-admin: refusing to demote the last admin (would lock out /admin). Re-run with --force to override.',
        );
        return 1;
      }
    }

    await client.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2', [
      role,
      target.id,
    ]);

    // Audit the grant so script changes are visible to access reviews, same as
    // the API path. Written as db_admin (only db_app is REVOKE'd from audit
    // writes); changed_by is NULL — the actor is an operator, not an app user.
    await client.query(
      `INSERT INTO audit_entries
         (action, entity_type, entity_id, outcome, changed_by, previous_value, new_value, metadata)
       VALUES ($1, 'User', $2, 'success', NULL, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        AuditAction.AdminUserRoleChange,
        target.id,
        JSON.stringify({ role: target.role }),
        JSON.stringify({ role }),
        JSON.stringify({ via: 'promote-admin-script', role }),
      ],
    );

    await client.query('COMMIT');
    console.log(`promote-admin: set role=${role} for user ${target.id} (was ${target.role}).`);
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

// Run only when executed directly, so parseArgs can be imported/tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('promote-admin: failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
