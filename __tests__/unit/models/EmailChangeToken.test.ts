import prisma from '@/lib/prisma.js';
import UserService from '@/models/User.js';
import EmailChangeTokenService from '@/models/EmailChangeToken.js';
import { blindIndex } from '@/lib/crypto/fieldCrypto.js';
import { connectTestDB, disconnectTestDB, cleanupTestData } from '../../helpers/testSetup.js';

// Service-level cases the HTTP tests can't reach: the housekeeping methods and
// the unique-violation race that only shows up between the pre-check and the
// write. The happy paths live in __tests__/integration/user/change-email.test.ts.

let userId: string;

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(async () => {
  const user = await UserService.create({
    email: `owner-${Date.now()}@example.com`,
    password: 'TestPass123!',
  });
  userId = user.id;
});

afterEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('EmailChangeTokenService.verify', () => {
  it('reports email_taken when the address is claimed mid-flight', async () => {
    const contested = `contested-${Date.now()}@example.com`;
    const token = await EmailChangeTokenService.issue(userId, contested);
    await UserService.create({ email: contested, password: 'TestPass123!' });

    expect(await EmailChangeTokenService.verify(token)).toEqual({ status: 'email_taken' });
  });

  it('does not move the account when the address is taken', async () => {
    const contested = `contested2-${Date.now()}@example.com`;
    const before = (await prisma.user.findUnique({
      where: { id: userId },
      select: { emailHash: true },
    }))!.emailHash;
    const token = await EmailChangeTokenService.issue(userId, contested);
    await UserService.create({ email: contested, password: 'TestPass123!' });

    await EmailChangeTokenService.verify(token);

    const after = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailHash: true },
    });
    expect(after?.emailHash).toBe(before);
    expect(after?.emailHash).not.toBe(blindIndex(contested));
  });

  it('reports invalid when the user was deleted after the token was issued', async () => {
    const token = await EmailChangeTokenService.issue(userId, `gone-${Date.now()}@example.com`);
    await prisma.user.delete({ where: { id: userId } });

    // The token row cascades away with the user, so the lookup misses.
    expect(await EmailChangeTokenService.verify(token)).toEqual({ status: 'invalid' });
  });
});

describe('EmailChangeTokenService.deleteExpired', () => {
  it('drops expired rows and keeps live ones', async () => {
    await EmailChangeTokenService.issue(userId, `live-${Date.now()}@example.com`);
    // Age the row past its expiry, then add a second, live one.
    await prisma.emailChangeToken.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await EmailChangeTokenService.issue(userId, `fresh-${Date.now()}@example.com`);

    const { count } = await EmailChangeTokenService.deleteExpired();

    expect(count).toBe(1);
    const remaining = await prisma.emailChangeToken.findMany({ where: { userId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
