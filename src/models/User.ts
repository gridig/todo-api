import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import { UserServiceInterface } from '../types/index.js';

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

// NFC + lowercase + trim is the canonical email form across the auth path
// (rate-limit key, Joi validation, and storage). All three must agree or
// Unicode-variant inputs land in different buckets / rows. See the prisma
// migration `*_normalize_user_emails` for the one-off backfill of legacy rows.
export const normalizeEmail = (email: string): string =>
  email.normalize('NFC').toLowerCase().trim();

export const UserService: UserServiceInterface = {
  async create({ email, password }) {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    return prisma.user.create({
      data: {
        email: normalizeEmail(email),
        password: hashedPassword,
      },
    });
  },

  async findByEmail(email) {
    return prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true, email: true, password: true },
    });
  },

  async comparePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
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
