import request from 'supertest';
import crypto from 'crypto';
import UserService from '@/models/User.js';
import EmailVerificationTokenService from '@/models/EmailVerificationToken.js';
import prisma from '@/lib/prisma.js';
import { generateVerificationToken, hashVerificationToken } from '@/lib/tokens.js';
import { AuditAction } from '@/lib/auditActions.js';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
  truncateAuditEntries,
  pollForAuditRow,
} from '../../helpers/testSetup.js';

const app = createTestApp();
const PASSWORD = 'TestPass123!';

const freshEmail = (prefix: string): string => `${prefix}-${crypto.randomUUID()}@example.com`;

const register = (email: string, password: string = PASSWORD) =>
  request(app).post('/auth/register').send({ email, password });

const login = (email: string, password: string = PASSWORD) =>
  request(app).post('/auth/login').send({ email, password });

const verify = (token: string) => request(app).post('/auth/verify').send({ token });

beforeAll(async () => {
  await connectTestDB();
  await truncateAuditEntries();
});

afterEach(async () => {
  await cleanupTestData();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('Email verification — registration gate', () => {
  it('creates the account but leaves it unverified and sessionless', async () => {
    const email = freshEmail('verify-new');

    const res = await register(email);

    expect(res.status).toBe(202);
    expect(res.body.token).toBeUndefined();

    const user = await UserService.findByEmail(email);
    expect(user).not.toBeNull();
    expect(user!.emailVerifiedAt).toBeNull();
  });

  it('refuses login with 403 EMAIL_NOT_VERIFIED until the address is confirmed', async () => {
    const email = freshEmail('verify-gate');
    await register(email);

    const res = await login(email);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('still returns 401 (not 403) for a wrong password on an unverified account', async () => {
    // The verification gate must sit AFTER the password check — otherwise the
    // distinct 403 would tell an attacker the address is registered, which is
    // the oracle the 202 register response exists to close.
    const email = freshEmail('verify-order');
    await register(email);

    const res = await login(email, 'WrongPassword123!');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('issues a verification token on registration', async () => {
    const email = freshEmail('verify-token');
    await register(email);

    const user = await UserService.findByEmail(email);
    const tokens = await prisma.emailVerificationToken.findMany({
      where: { userId: user!.id },
    });

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.consumedAt).toBeNull();
    // Only the hash is persisted; the raw value went out in the email.
    expect(tokens[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Email verification — redemption', () => {
  it('verifies the address and unblocks login', async () => {
    const email = freshEmail('verify-ok');
    await register(email);
    const user = await UserService.findByEmail(email);
    const token = await EmailVerificationTokenService.issue(user!.id);

    const verified = await verify(token);
    expect(verified.status).toBe(200);

    const after = await UserService.findByEmail(email);
    expect(after!.emailVerifiedAt).not.toBeNull();

    const session = await login(email);
    expect(session.status).toBe(200);
    expect(session.body.token).toBeDefined();
  });

  it('rejects an unknown token with 400 VERIFICATION_TOKEN_INVALID', async () => {
    const res = await verify(generateVerificationToken().raw);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_TOKEN_INVALID');
  });

  it('rejects an expired token with 400 VERIFICATION_TOKEN_EXPIRED', async () => {
    const email = freshEmail('verify-expired');
    await register(email);
    const user = await UserService.findByEmail(email);

    // Inserted directly: the service always stamps a future expiry, so the only
    // way to exercise this branch is to plant an already-stale row.
    const { raw, hash } = generateVerificationToken();
    await prisma.emailVerificationToken.create({
      data: {
        tokenHash: hash,
        userId: user!.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await verify(raw);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_TOKEN_EXPIRED');
    // An expired token must not be silently consumed or verify the address.
    const after = await UserService.findByEmail(email);
    expect(after!.emailVerifiedAt).toBeNull();
  });

  it('rejects a replayed token with 400 VERIFICATION_TOKEN_USED', async () => {
    const email = freshEmail('verify-replay');
    await register(email);
    const user = await UserService.findByEmail(email);
    const token = await EmailVerificationTokenService.issue(user!.id);

    expect((await verify(token)).status).toBe(200);
    const replay = await verify(token);

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('VERIFICATION_TOKEN_USED');
  });

  it('lets exactly one of two concurrent redemptions win', async () => {
    const email = freshEmail('verify-race');
    await register(email);
    const user = await UserService.findByEmail(email);
    const token = await EmailVerificationTokenService.issue(user!.id);

    const [a, b] = await Promise.all([verify(token), verify(token)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const after = await UserService.findByEmail(email);
    expect(after!.emailVerifiedAt).not.toBeNull();
  });

  it('audits a successful verification', async () => {
    const email = freshEmail('verify-audit');
    await register(email);
    const user = await UserService.findByEmail(email);
    const token = await EmailVerificationTokenService.issue(user!.id);

    await verify(token);

    const row = await pollForAuditRow<{ entity_id: string; changed_by: string; outcome: string }>(
      `action = $1 AND outcome = $2`,
      [AuditAction.AuthEmailVerify, 'success'],
    );
    expect(row).not.toBeNull();
    expect(row!.entity_id).toBe(user!.id);
    expect(row!.changed_by).toBe(user!.id);
  });
});

describe('Email verification — resend', () => {
  it('invalidates the previous token when a new one is issued', async () => {
    const email = freshEmail('verify-resend');
    await register(email);
    const user = await UserService.findByEmail(email);

    const first = await EmailVerificationTokenService.issue(user!.id);
    const second = await EmailVerificationTokenService.issue(user!.id);

    // The superseded link must stop working — otherwise every mail ever sent
    // stays live until its own expiry.
    expect((await verify(first)).body.error.code).toBe('VERIFICATION_TOKEN_USED');
    expect((await verify(second)).status).toBe(200);
  });

  it('answers identically for a registered and an unknown address', async () => {
    const known = freshEmail('resend-known');
    await register(known);

    const forKnown = await request(app).post('/auth/resend-verification').send({ email: known });
    const forUnknown = await request(app)
      .post('/auth/resend-verification')
      .send({ email: freshEmail('resend-unknown') });

    expect(forKnown.status).toBe(202);
    expect(forUnknown.status).toBe(forKnown.status);
    expect(forUnknown.body).toEqual(forKnown.body);
  });

  it('issues a fresh token for an unverified address', async () => {
    const email = freshEmail('resend-unverified');
    await register(email);
    const user = await UserService.findByEmail(email);

    await request(app).post('/auth/resend-verification').send({ email });

    const live = await prisma.emailVerificationToken.count({
      where: { userId: user!.id, consumedAt: null },
    });
    expect(live).toBe(1);
  });

  it('does not issue anything for an already-verified address', async () => {
    const email = freshEmail('resend-verified');
    await register(email);
    const user = await UserService.findByEmail(email);
    await UserService.markEmailVerified(user!.id);
    await prisma.emailVerificationToken.deleteMany({ where: { userId: user!.id } });

    await request(app).post('/auth/resend-verification').send({ email });

    // Nothing to verify, so re-sending would only enable mail-bombing a
    // known-good inbox.
    const issued = await prisma.emailVerificationToken.count({ where: { userId: user!.id } });
    expect(issued).toBe(0);
  });
});

describe('Email verification — token storage', () => {
  it('never stores the raw token', async () => {
    const email = freshEmail('verify-storage');
    await register(email);
    const user = await UserService.findByEmail(email);
    const raw = await EmailVerificationTokenService.issue(user!.id);

    const rows = await prisma.emailVerificationToken.findMany({ where: { userId: user!.id } });
    const stored = rows.find((r) => r.consumedAt === null);

    expect(stored!.tokenHash).toBe(hashVerificationToken(raw));
    expect(stored!.tokenHash).not.toBe(raw);
    expect(JSON.stringify(rows)).not.toContain(raw);
  });
});
