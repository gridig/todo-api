-- Encryption-at-rest, EXPAND phase (1/3). Add the blind-index column that will
-- carry account uniqueness + login lookups once email holds ciphertext.
--
-- Nullable here on purpose: on a populated database, run
--   scripts/backfill-email-crypto.ts --phase=hash
-- to populate email_hash from the current plaintext email BEFORE the next
-- migration (20260709000002) enforces NOT NULL + UNIQUE. On an empty database
-- all three phases apply together via `prisma migrate deploy` (backfill no-ops).
-- See docs/operations.md → "Field encryption key management & rotation".
ALTER TABLE "users" ADD COLUMN "email_hash" TEXT;
