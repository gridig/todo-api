import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import { encryptField, decryptField, blindIndex } from '../lib/crypto/fieldCrypto.js';
import auditLog from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import { DuplicateEmailError } from '../errors/index.js';
import { UserServiceInterface } from '../types/index.js';

// P2002 = unique-constraint violation. On the users table the only unique
// column is email_hash, so a P2002 here is always a duplicate email.
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';

// Bcrypt cost factor. OWASP 2024+ floor for new deployments. Existing
// users keep their cost-10 hashes (bcrypt embeds cost in the hash, so
// mixed cost is valid); the login flow opportunistically re-hashes at
// SALT_ROUNDS on next successful auth. See UserService.updatePassword.
const SALT_ROUNDS = 12;

// Precomputed bcrypt hash of a deliberately unmatchable plaintext, used by the
// login flow to equalize CPU work between the unknown-email and known-email
// branches (closes the timing oracle that would otherwise let an attacker
// enumerate registered addresses by response-time delta). hashSync is fine
// because this fires once at module load, not per request.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  '!unmatchable!__dummy_for_timing_only__',
  SALT_ROUNDS,
);

// Guardrail: if a future change splits these constants (e.g. hard-coding the
// dummy hash for determinism, moving it to a different module), the cost
// factors must still match or the timing oracle re-opens.
if (bcrypt.getRounds(DUMMY_PASSWORD_HASH) !== SALT_ROUNDS) {
  throw new Error(
    'DUMMY_PASSWORD_HASH cost factor must match SALT_ROUNDS to preserve login timing equivalence',
  );
}

// Canonical email form lives in one place now (lib/normalizeEmail.ts).
// Re-exported here so existing importers (routes/auth.ts, tests) keep working.
export { normalizeEmail } from '../lib/normalizeEmail.js';
import { normalizeEmail } from '../lib/normalizeEmail.js';

export const UserService: UserServiceInterface = {
  async create({ email, password }) {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const normalized = normalizeEmail(email);
    const user = await prisma.user.create({
      data: {
        // email stores ciphertext; emailHash is the deterministic lookup key.
        email: encryptField(normalized),
        emailHash: blindIndex(normalized),
        password: hashedPassword,
      },
    });
    // Hand callers the plaintext email — ciphertext stays at the DB layer.
    return { ...user, email: normalized };
  },

  async findByEmail(email) {
    // Look up by the blind index (the email column is randomized ciphertext),
    // then decrypt on read so callers still get the plaintext address.
    const user = await prisma.user.findUnique({
      where: { emailHash: blindIndex(email) },
      select: { id: true, email: true, password: true },
    });
    return user ? { ...user, email: decryptField(user.email) } : null;
  },

  async findById(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
    });
    // Decrypt the email column for the caller — same contract as findByEmail.
    return user ? { ...user, email: decryptField(user.email) } : null;
  },

  async comparePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
  },

  // Re-auth check: fetch just the hash for this user and compare. Returns false
  // (not throw) for a missing user so callers uniformly treat "no such user" and
  // "wrong password" as the same InvalidCredentials outcome.
  async verifyPassword(userId, plainPassword) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    if (!user) return false;
    return bcrypt.compare(plainPassword, user.password);
  },

  async updateProfile(userId, patch) {
    // email arrives normalized from validation; re-normalize so this method is
    // safe to call directly (tests, future callers) and always keys the
    // ciphertext + blind index off the same canonical bytes as create().
    const data: { name?: string; email?: string; emailHash?: string } = {};
    if (patch.name !== undefined) data.name = patch.name;
    let newEmailHash: string | undefined;
    if (patch.email !== undefined) {
      const normalized = normalizeEmail(patch.email);
      newEmailHash = blindIndex(normalized);
      // Both columns move together, exactly as in create(): randomized
      // ciphertext in `email`, deterministic blind index carrying uniqueness.
      data.email = encryptField(normalized);
      data.emailHash = newEmailHash;
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: { id: userId },
          data,
          select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
        });
        await auditLog.write(tx, {
          action: AuditAction.UserUpdate,
          outcome: 'success',
          entityType: 'User',
          entityId: userId,
          changedBy: userId,
          // Never record the raw address — the blind-index hash correlates the
          // change without putting PII in the (unencrypted) audit JSONB.
          metadata: { fields: Object.keys(patch), ...(newEmailHash && { newEmailHash }) },
        });
        return { ...updated, email: decryptField(updated.email) };
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new DuplicateEmailError();
      throw err;
    }
  },

  // Change password and revoke every live refresh token in one transaction, so a
  // password change can't leave a stolen session alive. Mirrors
  // RefreshTokenService.revokeAllForUser's query but on the tx client for atomicity.
  async changePassword(userId, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    return prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { password: hashedPassword } });
      const { count } = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await auditLog.write(tx, {
        action: AuditAction.UserPasswordChange,
        outcome: 'success',
        entityType: 'User',
        entityId: userId,
        changedBy: userId,
        metadata: { revokedCount: count },
      });
      return { revokedCount: count };
    });
  },

  // Audit-then-delete in one transaction. Todo and RefreshToken rows cascade
  // away via their FK onDelete: Cascade; AuditEntry has no FK to users, so the
  // deletion record survives (that is the point — SOC 2 deletion evidence).
  async deleteAccount(userId) {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { emailHash: true },
      });
      await auditLog.write(tx, {
        action: AuditAction.UserDelete,
        outcome: 'success',
        entityType: 'User',
        entityId: userId,
        changedBy: userId,
        previousValue: { id: userId, emailHash: user?.emailHash ?? null },
      });
      await tx.user.delete({ where: { id: userId } });
    });
  },

  // Re-hash and persist a user's password at the current SALT_ROUNDS.
  // Called from the login flow when bcrypt.getRounds(user.password) <
  // SALT_ROUNDS so legacy lower-cost hashes upgrade transparently.
  async updatePassword(userId, plainPassword) {
    const hashedPassword = await bcrypt.hash(plainPassword, SALT_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
  },

  // Cheap signal for the rehash-on-login path. Centralized so callers
  // don't import bcrypt directly just to peek at the cost factor.
  needsRehash(hashedPassword) {
    return bcrypt.getRounds(hashedPassword) < SALT_ROUNDS;
  },

  // Unscoped wipe — test-suite cleanup only. Guarded so a stray call can never
  // truncate a real environment.
  async deleteMany() {
    if (env.NODE_ENV !== 'test') {
      throw new Error('UserService.deleteMany is test-only: it deletes every user');
    }
    return prisma.user.deleteMany();
  },
};

export default UserService;
