import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GDPR erasure guard. Account deletion (UserService.deleteAccount) relies on
// DB-level FK cascade to erase every row that references a user — it does not
// loop over child tables in application code. So the moment a new model gains a
// foreign key to User *without* `onDelete: Cascade`, that model's rows survive
// the delete and we silently under-erase a data subject's PII (or, for
// Restrict/NoAction, block deletion entirely). This test parses schema.prisma
// and fails if any owning-side relation to User is not Cascade.
//
// If a future table legitimately must NOT cascade (e.g. it holds no personal
// data and should outlive its user with a nulled FK), add "Model.field" to
// ALLOWLIST with a comment justifying why erasure does not require deleting it.
const SCHEMA_PATH = join(process.cwd(), 'prisma', 'schema.prisma');

const ALLOWLIST = new Set<string>([
  // e.g. 'SomeModel.user',  // reason: no PII, retained with userId set null
]);

interface UserRelation {
  model: string;
  field: string;
  args: string;
}

// Extract every owning-side relation field whose type is `User` (i.e. the child
// side that carries the foreign key via `@relation(fields: [...], ...)`).
function findUserRelations(schema: string): UserRelation[] {
  const relations: UserRelation[] = [];
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let model: RegExpExecArray | null;
  while ((model = modelRe.exec(schema)) !== null) {
    const [, modelName, body] = model;
    // Field line like: `user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)`
    const fieldRe = /^\s*(\w+)\s+User\??\s+@relation\(([^)]*)\)/gm;
    let field: RegExpExecArray | null;
    while ((field = fieldRe.exec(body ?? '')) !== null) {
      const [, fieldName, args] = field;
      // Only the owning side declares `fields:` — the parent-side `User[]` has no @relation args.
      if (/fields\s*:/.test(args ?? '')) {
        relations.push({ model: modelName ?? '', field: fieldName ?? '', args: args ?? '' });
      }
    }
  }
  return relations;
}

describe('schema guard: user-linked tables cascade on delete (GDPR erasure)', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const relations = findUserRelations(schema);

  it('finds the known user-owned relations (anchors the parser)', () => {
    const keys = relations.map((r) => `${r.model}.${r.field}`);
    // Todo and RefreshToken both FK-reference User today; if the parser stops
    // finding them, the guard below would pass vacuously.
    expect(keys).toEqual(expect.arrayContaining(['Todo.user', 'RefreshToken.user']));
  });

  it('every foreign key to User declares onDelete: Cascade', () => {
    const offenders = relations
      .filter((r) => !ALLOWLIST.has(`${r.model}.${r.field}`))
      .filter((r) => !/onDelete\s*:\s*Cascade/.test(r.args));

    if (offenders.length > 0) {
      const list = offenders.map((r) => `${r.model}.${r.field}`).join(', ');
      throw new Error(
        `These relations reference User without onDelete: Cascade: ${list}. ` +
          `Account deletion erases child rows via FK cascade, so a non-cascading FK ` +
          `leaves a data subject's PII behind (GDPR Art. 17). Add onDelete: Cascade, ` +
          `or allowlist the field with a justification in ${'schema-cascade-guard.test.ts'}.`,
      );
    }
  });

  it('fixture: detects a new user-linked table that forgets to cascade', () => {
    const synthetic = `
      model Comment {
        id     String @id @default(uuid()) @db.Uuid
        userId String @map("user_id") @db.Uuid
        user   User   @relation(fields: [userId], references: [id])
      }
    `;
    const found = findUserRelations(synthetic);
    expect(found).toHaveLength(1);
    expect(found[0]?.model).toBe('Comment');
    // No onDelete: Cascade in the args → this is exactly what the guard rejects.
    expect(/onDelete\s*:\s*Cascade/.test(found[0]?.args ?? '')).toBe(false);
  });
});
