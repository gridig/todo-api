import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// The audit_entries hypertable, its idx_audit_* indexes, retention policy, and
// append-only REVOKE exist only in raw migration SQL — schema.prisma knows
// nothing of them, so `prisma migrate dev` (or db push) happily generates SQL
// that drops them. This guard fails the suite when a committed migration
// carries such a statement. Rationale + workflow: docs/operations.md
// ("Migration hazards").
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

// The migration that legitimately creates/configures the audit table.
const AUDIT_MIGRATION = '20260526000001_add_audit_entries';

const FORBIDDEN = [
  /DROP\s+INDEX\s+(IF\s+EXISTS\s+)?"?idx_audit_/i,
  /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?"?audit_entries"?/i,
  /ALTER\s+TABLE\s+"?audit_entries"?/i,
];

describe('migrations guard: audit_entries immutability', () => {
  const migrationDirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== AUDIT_MIGRATION)
    .map((entry) => entry.name);

  it('finds the migrations directory', () => {
    expect(migrationDirs.length).toBeGreaterThan(0);
  });

  it.each(migrationDirs)('%s does not touch audit_entries guarantees', (dir) => {
    const sqlPath = join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!existsSync(sqlPath)) return;
    const sql = readFileSync(sqlPath, 'utf8');

    for (const pattern of FORBIDDEN) {
      if (pattern.test(sql)) {
        throw new Error(
          `${dir}/migration.sql matches ${pattern} — it drops or alters audit_entries ` +
            `guarantees that live outside schema.prisma. If this is deliberate, update the ` +
            `guard; otherwise remove the statement. See docs/operations.md → "Migration hazards".`,
        );
      }
    }
  });

  it('regex fixtures: catches the statements prisma migrate dev would generate', () => {
    const generated = [
      'DROP INDEX "idx_audit_entity";',
      'DROP INDEX IF EXISTS "idx_audit_changed_by";',
      'ALTER TABLE "audit_entries" DROP CONSTRAINT "audit_entries_pkey";',
      'DROP TABLE "audit_entries";',
    ];
    for (const stmt of generated) {
      expect(FORBIDDEN.some((p) => p.test(stmt))).toBe(true);
    }

    const benign = [
      'CREATE TABLE "todos" (id uuid);',
      'CREATE INDEX "idx_audit_entity" ON audit_entries (entity_type);',
      'DROP INDEX "todos_user_id_idx";',
    ];
    for (const stmt of benign) {
      expect(FORBIDDEN.some((p) => p.test(stmt))).toBe(false);
    }
  });
});
