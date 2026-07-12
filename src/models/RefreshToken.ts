import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
} from '../lib/tokens.js';
import type { RefreshTokenServiceInterface } from '../types/index.js';

export const RefreshTokenService: RefreshTokenServiceInterface = {
  async issue(userId) {
    const { raw, hash } = generateRefreshToken();
    await prisma.refreshToken.create({
      data: { tokenHash: hash, userId, expiresAt: refreshTokenExpiry() },
    });
    return raw;
  },

  async verify(rawToken) {
    const token = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(rawToken) },
    });
    if (!token) return { status: 'not_found' };
    // Order matters: a revoked token that is also expired is still reuse — the
    // revoked branch must win so theft detection fires.
    if (token.revokedAt !== null) return { status: 'revoked', token };
    if (token.expiresAt.getTime() <= Date.now()) return { status: 'expired' };
    return { status: 'valid', token };
  },

  async rotate(oldToken) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const { raw, hash } = generateRefreshToken();
      // Guarded revoke: `revokedAt: null` in the filter means two concurrent
      // refreshes presenting the same token can't both succeed — the loser
      // updates 0 rows and we bail without issuing a successor, so the route
      // handles it as reuse. Revoke BEFORE create so a lost race leaves no
      // orphaned successor token behind.
      const revoked = await tx.refreshToken.updateMany({
        where: { id: oldToken.id, revokedAt: null },
        data: { revokedAt: now, replacedByHash: hash },
      });
      if (revoked.count !== 1) return null;
      await tx.refreshToken.create({
        data: { tokenHash: hash, userId: oldToken.userId, expiresAt: refreshTokenExpiry(now) },
      });
      return raw;
    });
  },

  async revoke(rawToken) {
    const result = await prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  },

  // Revoke every live token for a user — logout-all, reuse/theft response, and
  // (once wired) password change. Idempotent: already-revoked tokens are
  // excluded by the filter.
  async revokeAllForUser(userId) {
    return prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  // Housekeeping: hard-delete tokens past their absolute expiry. Safe to run on
  // a schedule; revoked-but-unexpired rows are kept so reuse detection still
  // has a hash to match against until they age out.
  async deleteExpired() {
    return prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  },

  // Unscoped wipe — test-suite cleanup only. Guarded so a stray call can never
  // truncate a real environment.
  async deleteMany() {
    if (env.NODE_ENV !== 'test') {
      throw new Error('RefreshTokenService.deleteMany is test-only: it deletes every refresh token');
    }
    return prisma.refreshToken.deleteMany();
  },
};

export default RefreshTokenService;
