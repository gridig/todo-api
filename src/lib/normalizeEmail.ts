// Canonical email form — NFC + lowercase + trim — and the single source of
// truth for it. The stored ciphertext plaintext, the blind-index HMAC
// (lib/crypto/fieldCrypto.ts), the Joi email schema (middleware/validation.ts),
// and the per-email rate-limit key (middleware/rateLimiter.ts) must all derive
// from the same bytes, or a Unicode-variant input (NFC vs NFD, full-width,
// homoglyph) lands in a different row / bucket than the same address in
// another form. Kept dependency-free (no prisma/bcrypt/env) so middleware can
// import it without pulling in the model or crypto layers. See the prisma
// migration `*_normalize_user_emails` for the one-off backfill of legacy rows.
export const normalizeEmail = (email: string): string =>
  email.normalize('NFC').toLowerCase().trim();
