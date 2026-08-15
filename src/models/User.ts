import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import { encryptField, decryptField, blindIndex } from '../lib/crypto/fieldCrypto.js';
import auditLog from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import { DuplicateEmailError, UserNotFoundError } from '../errors/index.js';
// On the users table the only unique column is email_hash, so a P2002 here is
// always a duplicate email.
import { isUniqueViolation } from '../errors/database.js';
import type { UserServiceInterface, UserRole, UserProfile } from '../types/index.js';

// Public profile columns (never password/emailHash). `role` is a String column
// at rest but constrained to the UserRole domain by users_role_check, so the
// cast on read is sound.
const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Map a raw user row (with ciphertext email + string role) to a UserProfile:
// decrypt the email, narrow the role to the UserRole union.
const toProfile = (row: {
  id: string;
  name: string | null;
  email: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}): UserProfile => ({ ...row, email: decryptField(row.email), role: row.role as UserRole });

// Shared audit-then-delete-cascade. Snapshots emailHash for the audit trail
// before the row (and its cascading Todo/RefreshToken children) are gone;
// AuditEntry has no FK to users, so the audit row survives. changedBy/action
// differ between self-service (user.delete) and admin (admin.user.delete).
async function deleteUserTx(
  userId: string,
  opts: { action: string; changedBy: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { emailHash: true } });
    await auditLog.write(tx, {
      action: opts.action,
      outcome: 'success',
      entityType: 'User',
      entityId: userId,
      changedBy: opts.changedBy,
      previousValue: { id: userId, emailHash: user?.emailHash ?? null },
    });
    await tx.user.delete({ where: { id: userId } });
  });
}

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
    // Translate P2002 here rather than letting the raw Prisma error reach the
    // error handler: the registration flow has to branch on "already taken"
    // without leaking it, so it needs a typed error to catch. Callers that let
    // it propagate still get the same 409 DUPLICATE_EMAIL response.
    let user;
    try {
      user = await prisma.user.create({
        data: {
          // email stores ciphertext; emailHash is the deterministic lookup key.
          email: encryptField(normalized),
          emailHash: blindIndex(normalized),
          password: hashedPassword,
        },
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new DuplicateEmailError();
      throw err;
    }
    // Hand callers the plaintext email — ciphertext stays at the DB layer.
    // role is a String column narrowed to the UserRole domain (users_role_check).
    return { ...user, email: normalized, role: user.role as UserRole };
  },

  async findByEmail(email) {
    // Look up by the blind index (the email column is randomized ciphertext),
    // then decrypt on read so callers still get the plaintext address.
    //
    // Selects the password hash, so this is the LOGIN lookup specifically —
    // callers that only need identity or verification state should use
    // findVerificationStateByEmail instead of loading the hash they won't use.
    const user = await prisma.user.findUnique({
      where: { emailHash: blindIndex(email) },
      select: { id: true, email: true, password: true, emailVerifiedAt: true },
    });
    return user ? { ...user, email: decryptField(user.email) } : null;
  },

  // Same lookup, minus the password hash: the resend-verification path needs an
  // address to mail and a flag to decide whether to bother, and nothing else.
  async findVerificationStateByEmail(email) {
    const user = await prisma.user.findUnique({
      where: { emailHash: blindIndex(email) },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    return user ? { ...user, email: decryptField(user.email) } : null;
  },

  // Idempotent by construction: re-verifying an already-verified address just
  // rewrites the timestamp, so a duplicate click is harmless.
  async markEmailVerified(userId) {
    await prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
  },

  async findById(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: PROFILE_SELECT,
    });
    // Decrypt the email column for the caller — same contract as findByEmail.
    return user ? toProfile(user) : null;
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
          select: PROFILE_SELECT,
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
        return toProfile(updated);
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

  // Self-service deletion: audit as user.delete, actor is the user themselves.
  async deleteAccount(userId) {
    await deleteUserTx(userId, { action: AuditAction.UserDelete, changedBy: userId });
  },

  // --- RBAC ---

  async getRole(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user ? (user.role as UserRole) : null;
  },

  async listUsers(params = {}) {
    // Cursor pagination mirrors TodoService.findByUser: over-fetch by one to
    // detect hasMore, order by (createdAt desc, id desc) so ties are stable,
    // cursor on id (skip the cursor row).
    const limit = Math.min(params.limit ?? 20, 100);
    const users = await prisma.user.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
      select: PROFILE_SELECT,
    });
    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;
    return {
      data: page.map(toProfile),
      meta: {
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
      },
    };
  },

  async setRole(targetId, role, adminId) {
    return prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id: targetId },
        select: { role: true },
      });
      // Throwing inside the tx rolls it back (no audit row for a missing user).
      if (!before) throw new UserNotFoundError();
      const updated = await tx.user.update({
        where: { id: targetId },
        data: { role },
        select: PROFILE_SELECT,
      });
      await auditLog.write(tx, {
        action: AuditAction.AdminUserRoleChange,
        outcome: 'success',
        entityType: 'User',
        entityId: targetId,
        changedBy: adminId,
        previousValue: { role: before.role },
        newValue: { role },
      });
      return toProfile(updated);
    });
  },

  // Admin-initiated deletion of another user. Pre-checks existence for a clean
  // 404 (USER_NOT_FOUND) rather than a rolled-back audit-then-P2025; then reuses
  // the shared cascade delete, audited as admin.user.delete with the admin actor.
  async adminDeleteUser(targetId, adminId) {
    const exists = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    });
    if (!exists) throw new UserNotFoundError();
    await deleteUserTx(targetId, { action: AuditAction.AdminUserDelete, changedBy: adminId });
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
