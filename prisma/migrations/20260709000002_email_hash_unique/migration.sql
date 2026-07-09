-- Encryption-at-rest, ENFORCE phase (2/3). Promote email_hash to the account
-- uniqueness key. Requires every row to already have a non-null email_hash
-- (backfill --phase=hash on a populated DB; automatic on an empty one).
--
-- The plaintext unique index users_email_key is intentionally left in place
-- here as a safety net and is dropped in the CONTRACT migration
-- (20260709000003) after email is fully encrypted.
--
-- Note for a large, live table (not the case today — users is empty): SET NOT
-- NULL and a non-CONCURRENT unique index both take strong locks. Prefer an
-- ADD CONSTRAINT ... CHECK (email_hash IS NOT NULL) NOT VALID → VALIDATE flow
-- and CREATE UNIQUE INDEX CONCURRENTLY (applied outside Prisma's migration
-- transaction, then `prisma migrate resolve`). See docs/operations.md.
ALTER TABLE "users" ALTER COLUMN "email_hash" SET NOT NULL;
CREATE UNIQUE INDEX "users_email_hash_key" ON "users"("email_hash");
