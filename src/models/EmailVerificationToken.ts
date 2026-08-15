import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import {
  generateVerificationToken,
  hashVerificationToken,
  verificationTokenExpiry,
} from '../lib/tokens.js';

export type VerifyResult =
  | { status: 'verified'; userId: string }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'already_used' };

export const EmailVerificationTokenService = {
  // Issue a fresh single-use token, returning the raw value for the emailed
  // link. Any outstanding tokens for the user are consumed first so a resend
  // invalidates the previous link — otherwise every mail ever sent stays live
  // until its own expiry, widening the window on a leaked inbox.
  async issue(userId: string): Promise<string> {
    const { raw, hash } = generateVerificationToken();
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.emailVerificationToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.emailVerificationToken.create({
        data: { tokenHash: hash, userId, expiresAt: verificationTokenExpiry(now) },
      });
    });
    return raw;
  },

  // Redeem a token and mark the address verified, atomically. The guarded
  // updateMany (consumedAt: null in the filter) is what makes redemption
  // single-use under concurrency: two simultaneous clicks race on the same row
  // and the loser updates zero rows, exactly like refresh-token rotation.
  async verify(rawToken: string): Promise<VerifyResult> {
    const tokenHash = hashVerificationToken(rawToken);
    const token = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });

    if (!token) return { status: 'invalid' };
    if (token.consumedAt !== null) return { status: 'already_used' };
    // Expiry is checked before the claim so an expired token reports as such
    // rather than being silently consumed.
    if (token.expiresAt.getTime() <= Date.now()) return { status: 'expired' };

    return prisma.$transaction(async (tx) => {
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: token.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) return { status: 'already_used' };

      await tx.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: new Date() },
      });
      return { status: 'verified', userId: token.userId };
    });
  },

  async deleteExpired(): Promise<{ count: number }> {
    return prisma.emailVerificationToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  },

  // Unscoped wipe — test-suite cleanup only, mirroring the other services.
  async deleteMany(): Promise<{ count: number }> {
    if (env.NODE_ENV !== 'test') {
      throw new Error(
        'EmailVerificationTokenService.deleteMany is test-only: it deletes every token',
      );
    }
    return prisma.emailVerificationToken.deleteMany();
  },
};

export default EmailVerificationTokenService;
