// Operator-run break-glass: mark a user's address verified without the emailed
// token. Peer of scripts/promote-admin.ts; run as
// `node dist/scripts/verify-email.js <email> [--dry-run]` with the app env
// present (it imports the crypto layer to compute the email blind index, so
// ENCRYPTION_* must be set). Connects via DATABASE_MIGRATE_URL (db_admin).
//
// This exists because login is gated on a verified address: if mail delivery is
// broken, every new account is stranded and the only alternative is hand-written
// SQL, which writes no audit row. The change is written to audit_entries
// (action admin.user.email.verify, metadata.via=verify-email-script) under an
// action distinct from the self-service auth.email.verify, so an access review
// can tell an operator assertion from a user-proven address.
//
// It does NOT prove the address is reachable. Use it only when delivery is
// known-broken and the account's identity is established some other way; the
// normal recovery is POST /auth/resend-verification.
//
//   node dist/scripts/verify-email.js alice@example.com
//   node dist/scripts/verify-email.js alice@example.com --dry-run
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
// blindIndex normalizes the email internally (NFC + lowercase + trim), so the
// hash matches what UserService.create stored in users.email_hash.
import { blindIndex } from '../src/lib/crypto/fieldCrypto.js';
import { AuditAction } from '../src/lib/auditActions.js';

export interface Options {
  email: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Options {
  let email: string | undefined;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (email === undefined) {
      email = arg;
    } else {
      throw new Error(`unexpected extra argument "${arg}"`);
    }
  }
  if (!email) throw new Error('email is required: verify-email <email> [--dry-run]');
  return { email, dryRun };
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
  const { email, dryRun } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('verify-email: neither DATABASE_MIGRATE_URL nor DATABASE_URL is set.');
    return 1;
  }
  // Name the target DB up front so a mis-pointed env is caught by eye.
  console.log(`verify-email: connecting to ${describeTarget(connectionString)}`);

  const emailHash = blindIndex(email);
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the target row so a concurrent redemption can't race the guard below.
    const found = await client.query<{ id: string; email_verified_at: Date | null }>(
      'SELECT id, email_verified_at FROM users WHERE email_hash = $1 FOR UPDATE',
      [emailHash],
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      // Never echo the raw email beyond this operator invocation's own argv.
      console.error('verify-email: no user found for the given email.');
      return 1;
    }
    const target = found.rows[0]!;
    if (target.email_verified_at !== null) {
      await client.query('ROLLBACK');
      console.log(
        `verify-email: user ${target.id} was already verified at ${target.email_verified_at.toISOString()}; nothing to do.`,
      );
      return 0;
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log(`verify-email: [dry-run] would mark user ${target.id} verified.`);
      return 0;
    }

    const updated = await client.query<{ email_verified_at: Date }>(
      'UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING email_verified_at',
      [target.id],
    );

    // Consume any outstanding verification tokens: the address is now verified,
    // so a live link in an inbox is a credential with nothing left to authorize.
    const consumed = await client.query(
      'UPDATE email_verification_tokens SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL',
      [target.id],
    );

    // Audit so the out-of-band verification shows up in the same review stream as
    // the self-service path. Written as db_admin (only db_app is REVOKE'd from
    // audit writes); changed_by is NULL — the actor is an operator, not an app user.
    await client.query(
      `INSERT INTO audit_entries
         (action, entity_type, entity_id, outcome, changed_by, previous_value, new_value, metadata)
       VALUES ($1, 'User', $2, 'success', NULL, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        AuditAction.AdminUserEmailVerify,
        target.id,
        JSON.stringify({ emailVerifiedAt: null }),
        JSON.stringify({
          emailVerifiedAt: updated.rows[0]?.email_verified_at?.toISOString() ?? null,
        }),
        JSON.stringify({
          via: 'verify-email-script',
          tokensConsumed: consumed.rowCount ?? 0,
        }),
      ],
    );

    await client.query('COMMIT');
    console.log(
      `verify-email: marked user ${target.id} verified (${consumed.rowCount ?? 0} outstanding token(s) consumed).`,
    );
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
      console.error('verify-email: failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
