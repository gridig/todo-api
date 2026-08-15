import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import { blindIndex, decryptField, encryptField } from '../lib/crypto/fieldCrypto.js';
import { normalizeEmail } from '../lib/normalizeEmail.js';
import { isUniqueViolation } from '../errors/database.js';
import {
  generateVerificationToken,
  hashVerificationToken,
  verificationTokenExpiry,
} from '../lib/tokens.js';

// `email_taken` is distinct from the token failures: the token was perfectly
// valid, the address just stopped being available between request and
// redemption. The caller turns it into a 409, not a 400.
export type ChangeEmailResult =
  | { status: 'changed'; userId: string; newEmail: string; previousEmail: string }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'already_used' }
  | { status: 'email_taken' };

export const EmailChangeTokenService = {
  // Stage an address change. The address is held as ciphertext + blind index
  // here and does NOT touch users until the token mailed to it is redeemed —
  // that redemption is the entire proof that the new inbox is reachable.
  //
  // Outstanding requests are consumed first, so the most recent request is the
  // only live one. Otherwise a user who fixes a typo would leave the mistyped
  // address still claimable by whoever holds that inbox.
  async issue(userId: string, newEmail: string): Promise<string> {
    const normalized = normalizeEmail(newEmail);
    const { raw, hash } = generateVerificationToken();
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.emailChangeToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.emailChangeToken.create({
        data: {
          tokenHash: hash,
          userId,
          newEmail: encryptField(normalized),
          newEmailHash: blindIndex(normalized),
          expiresAt: verificationTokenExpiry(now),
        },
      });
    });

    return raw;
  },

  // Redeem: claim the token and commit the address in one transaction.
  //
  // Uniqueness is re-checked at this point rather than trusted from request
  // time — the address may have been registered by someone else in between, and
  // the users.email_hash unique index is the only authority. The catch on the
  // unique violation closes the remaining race between the check and the write.
  async verify(rawToken: string): Promise<ChangeEmailResult> {
    const tokenHash = hashVerificationToken(rawToken);
    const token = await prisma.emailChangeToken.findUnique({ where: { tokenHash } });

    if (!token) return { status: 'invalid' };
    if (token.consumedAt !== null) return { status: 'already_used' };
    // Expiry before the claim, so an expired token reports as expired rather
    // than being silently consumed.
    if (token.expiresAt.getTime() <= Date.now()) return { status: 'expired' };

    try {
      return await prisma.$transaction(async (tx) => {
        const claimed = await tx.emailChangeToken.updateMany({
          where: { id: token.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (claimed.count !== 1) return { status: 'already_used' } as const;

        const current = await tx.user.findUnique({
          where: { id: token.userId },
          select: { email: true },
        });
        if (!current) return { status: 'invalid' } as const;

        const taken = await tx.user.findUnique({
          where: { emailHash: token.newEmailHash },
          select: { id: true },
        });
        if (taken && taken.id !== token.userId) return { status: 'email_taken' } as const;

        await tx.user.update({
          where: { id: token.userId },
          data: {
            email: token.newEmail,
            emailHash: token.newEmailHash,
            // A changed address is a re-proven address: the redemption itself is
            // the proof, so an account that was somehow unverified becomes
            // verified here rather than needing a second round trip.
            emailVerifiedAt: new Date(),
          },
        });

        return {
          status: 'changed',
          userId: token.userId,
          newEmail: decryptField(token.newEmail),
          previousEmail: decryptField(current.email),
        } as const;
      });
    } catch (err: unknown) {
      // Lost the race against a concurrent registration/change of the same
      // address. The token is consumed either way — the user must start over,
      // which is correct: that address is gone.
      if (isUniqueViolation(err)) return { status: 'email_taken' };
      throw err;
    }
  },

  async deleteExpired(): Promise<{ count: number }> {
    return prisma.emailChangeToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  },

  // Unscoped wipe — test-suite cleanup only, mirroring the other services.
  async deleteMany(): Promise<{ count: number }> {
    if (env.NODE_ENV !== 'test') {
      throw new Error('EmailChangeTokenService.deleteMany is test-only: it deletes every token');
    }
    return prisma.emailChangeToken.deleteMany();
  },
};

export default EmailChangeTokenService;
