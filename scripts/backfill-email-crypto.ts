// Operator-run data backfill for the email field-encryption rollout. Peer of
// scripts/preflight-roles.ts; run via `node dist/scripts/backfill-email-crypto.js`
// with the app's env present (it imports the crypto layer, so ENCRYPTION_* and
// the other required vars must be set). Connects via DATABASE_MIGRATE_URL (the
// db_admin role) like the migrations do.
//
// The key material must never appear in migration SQL (it would leak into
// db_admin query logs), so the data transform lives here, not in a migration.
//
// Phases (see docs/operations.md → "Field encryption key management & rotation"):
//   --phase=hash     Populate email_hash from the current plaintext email.
//                    Run AFTER migration 20260709000001, BEFORE ..._email_hash_unique.
//   --phase=encrypt  Encrypt plaintext email → ciphertext, and re-encrypt rows
//                    under a retired keyId to the active key. Idempotent.
//   --phase=rehash   Recompute every email_hash with the CURRENT blind-index key
//                    (HMAC-key rotation). Coordinated/maintenance-window only.
//
// Flags: --dry-run (report counts, write nothing), --batch=<n> (default 500).
// Never logs plaintext email.
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import {
  encryptField,
  decryptField,
  blindIndex,
  isEncrypted,
  keyIdOf,
} from '../src/lib/crypto/fieldCrypto.js';
import { keyProvider } from '../src/lib/crypto/keyProvider.js';

type Phase = 'hash' | 'encrypt' | 'rehash';
const PHASES: Phase[] = ['hash', 'encrypt', 'rehash'];

interface UserRow {
  id: string;
  email: string;
  email_hash: string | null;
}

interface Options {
  phase: Phase;
  dryRun: boolean;
  batchSize: number;
}

export function parseArgs(argv: string[]): Options {
  let phase: Phase | undefined;
  let dryRun = false;
  let batchSize = 500;
  for (const arg of argv) {
    if (arg.startsWith('--phase=')) {
      const value = arg.slice('--phase='.length);
      if (!PHASES.includes(value as Phase)) {
        throw new Error(`--phase must be one of ${PHASES.join(', ')} (got "${value}")`);
      }
      phase = value as Phase;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--batch=')) {
      const n = Number.parseInt(arg.slice('--batch='.length), 10);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--batch must be a positive integer`);
      batchSize = n;
    }
  }
  if (!phase) throw new Error(`--phase is required (one of ${PHASES.join(', ')})`);
  return { phase, dryRun, batchSize };
}

// Fail closed if two distinct users would end up with the same blind index.
// Old data was unique on plaintext email (users_email_key) and NFC-normalized,
// so this should never fire — but a silent collision would merge two accounts.
function assertNoHashCollisions(pairs: { id: string; hash: string }[]): void {
  const byHash = new Map<string, string>();
  for (const { id, hash } of pairs) {
    const existing = byHash.get(hash);
    if (existing && existing !== id) {
      throw new Error(
        `email_hash collision: users ${existing} and ${id} map to the same blind index. ` +
          `Reconcile manually before backfilling.`,
      );
    }
    byHash.set(hash, id);
  }
}

const plaintextOf = (email: string): string => (isEncrypted(email) ? decryptField(email) : email);

// Every UPDATE is a compare-and-swap on the email value the row was READ with
// ($3): the app can change a user's email between our unlocked full-table read
// and this write, and an unguarded UPDATE would overwrite that newer value
// with a transform of stale plaintext (lost update). A guarded miss simply
// skips the row — it is counted and reported so the operator re-runs.
async function updateInBatches(
  client: PoolClient,
  sql: string,
  updates: [string, string, string][], // [value, id, emailAtRead]
  batchSize: number,
): Promise<number> {
  let applied = 0;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    await client.query('BEGIN');
    try {
      for (const [value, id, emailAtRead] of batch) {
        const result = await client.query(sql, [value, id, emailAtRead]);
        applied += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }
  return applied;
}

interface RunResult {
  phase: Phase;
  scanned: number;
  changed: number;
  /** Rows whose email changed between read and write (CAS miss) — re-run to cover them. */
  skipped: number;
  dryRun: boolean;
}

// The full-table read is unlocked and in-memory — acceptable at this table's
// scale; move to keyset pagination before running against millions of rows.
export async function runBackfill(pool: Pool, opts: Options): Promise<RunResult> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<UserRow>('SELECT id, email, email_hash FROM users');

    if (opts.phase === 'hash' || opts.phase === 'rehash') {
      // Which rows get a (re)computed hash: null hashes for `hash`, all for `rehash`.
      const targets = opts.phase === 'rehash' ? rows : rows.filter((r) => r.email_hash === null);
      const computed = targets.map((r) => ({
        id: r.id,
        email: r.email,
        hash: blindIndex(plaintextOf(r.email)),
      }));

      // Collision-check the FULL resulting set (recomputed + any untouched hashes).
      const untouched =
        opts.phase === 'rehash'
          ? []
          : rows
              .filter((r) => r.email_hash !== null)
              .map((r) => ({ id: r.id, hash: r.email_hash as string }));
      assertNoHashCollisions([...untouched, ...computed]);

      let applied = computed.length;
      if (!opts.dryRun) {
        applied = await updateInBatches(
          client,
          'UPDATE users SET email_hash = $1 WHERE id = $2 AND email = $3',
          computed.map(({ id, email, hash }) => [hash, id, email] as [string, string, string]),
          opts.batchSize,
        );
      }
      return {
        phase: opts.phase,
        scanned: rows.length,
        changed: applied,
        skipped: computed.length - applied,
        dryRun: opts.dryRun,
      };
    }

    // encrypt: rows still in plaintext, or encrypted under a non-active keyId.
    const activeKeyId = keyProvider.activeEncryptionKeyId();
    const targets = rows.filter((r) => !isEncrypted(r.email) || keyIdOf(r.email) !== activeKeyId);
    const updates = targets.map(
      (r) => [encryptField(plaintextOf(r.email)), r.id, r.email] as [string, string, string],
    );
    let applied = updates.length;
    if (!opts.dryRun) {
      applied = await updateInBatches(
        client,
        'UPDATE users SET email = $1 WHERE id = $2 AND email = $3',
        updates,
        opts.batchSize,
      );
    }
    return {
      phase: opts.phase,
      scanned: rows.length,
      changed: applied,
      skipped: updates.length - applied,
      dryRun: opts.dryRun,
    };
  } finally {
    client.release();
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('backfill-email-crypto: neither DATABASE_MIGRATE_URL nor DATABASE_URL is set.');
    return 1;
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await runBackfill(pool, opts);
    console.log(
      `backfill-email-crypto: phase=${result.phase} scanned=${result.scanned} ` +
        `${result.dryRun ? 'would change' : 'changed'}=${result.changed}` +
        `${result.dryRun ? ' (dry run)' : ''}`,
    );
    if (result.skipped > 0) {
      console.warn(
        `backfill-email-crypto: ${result.skipped} row(s) changed concurrently during the run ` +
          `and were skipped — re-run this phase to cover them.`,
      );
    }
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// Run only when executed directly, so the pure helpers can be imported/tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('backfill-email-crypto: failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
