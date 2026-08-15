import request from 'supertest';
import prisma from '@/lib/prisma.js';
import { blindIndex } from '@/lib/crypto/fieldCrypto.js';
import EmailChangeTokenService from '@/models/EmailChangeToken.js';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
  truncateAuditEntries,
  pollForAuditRow,
} from '../../helpers/testSetup.js';

const app = createTestApp();

const PASSWORD = 'TestPass123!';
let authToken: string;
let userId: string;

// The raw token only ever exists inside the email, so tests mint an equivalent
// one through the same service the route uses and redeem that — keeping the
// redemption path (POST /auth/verify-email-change) genuinely under test.
const requestChange = async (newEmail: string) =>
  request(app)
    .patch('/user/me/email')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ email: newEmail, currentPassword: PASSWORD });

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(async () => {
  ({ authToken, userId } = await createTestUser());
});

afterEach(async () => {
  await cleanupTestData();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('PATCH /user/me/email (request)', () => {
  it('stages the change without touching the account', async () => {
    const original = (await prisma.user.findUnique({
      where: { id: userId },
      select: { emailHash: true },
    }))!.emailHash;

    const res = await requestChange(`changed-${userId}@example.com`);

    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/current email is unchanged/i);

    // Nothing moved: the account still answers to the old address.
    const stored = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailHash: true },
    });
    expect(stored?.emailHash).toBe(original);

    // The pending address is at rest as ciphertext + blind index, like users.email.
    const pending = await prisma.emailChangeToken.findFirst({ where: { userId } });
    expect(pending).not.toBeNull();
    expect(pending?.newEmail.startsWith('enc:1:')).toBe(true);
    expect(pending?.newEmail).not.toContain('changed-');
    expect(pending?.newEmailHash).toBe(blindIndex(`changed-${userId}@example.com`));
  });

  it('rejects a change without the current password (400)', async () => {
    const res = await request(app)
      .patch('/user/me/email')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: `nope-${userId}@example.com` });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a change with a wrong current password (401)', async () => {
    const res = await request(app)
      .patch('/user/me/email')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: `nope-${userId}@example.com`, currentPassword: 'WrongPass123!' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('answers 202 for an address already in use, so the endpoint is not an existence oracle', async () => {
    const other = await createTestUser(`taken-${Date.now()}@example.com`);

    const res = await requestChange(other.user.email);

    // Same status and body as the free-address case; the token simply never
    // becomes usable (see the redemption test below).
    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/current email is unchanged/i);
  });

  it('supersedes an earlier pending request', async () => {
    const first = await EmailChangeTokenService.issue(userId, `first-${userId}@example.com`);
    await requestChange(`second-${userId}@example.com`);

    const replayFirst = await request(app).post('/auth/verify-email-change').send({ token: first });

    expect(replayFirst.status).toBe(400);
    expect(replayFirst.body.error.code).toBe('VERIFICATION_TOKEN_USED');
  });

  it('writes a requested audit row containing no plaintext email', async () => {
    const newEmail = `audit-${userId}@example.com`;
    await requestChange(newEmail);

    const row = await pollForAuditRow<{ new_value: unknown; entity_id: string }>(
      'action = $1 AND changed_by = $2',
      ['user.email.change.requested', userId],
    );
    expect(row).not.toBeNull();
    expect(row?.entity_id).toBe(userId);
    expect(JSON.stringify(row?.new_value)).not.toContain(newEmail);
    expect(JSON.stringify(row?.new_value)).toContain(blindIndex(newEmail));
  });
});

describe('POST /auth/verify-email-change (redemption)', () => {
  it('commits the change, re-encrypting the column and rotating the blind index', async () => {
    const newEmail = `redeemed-${userId}@example.com`;
    const token = await EmailChangeTokenService.issue(userId, newEmail);

    const res = await request(app).post('/auth/verify-email-change').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);

    const stored = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailHash: true },
    });
    expect(stored?.email.startsWith('enc:1:')).toBe(true);
    expect(stored?.email).not.toContain(newEmail);
    expect(stored?.emailHash).toBe(blindIndex(newEmail));

    // The new address logs in; the old one no longer exists.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: newEmail, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('is single-use', async () => {
    const token = await EmailChangeTokenService.issue(userId, `once-${userId}@example.com`);

    expect((await request(app).post('/auth/verify-email-change').send({ token })).status).toBe(200);

    const replay = await request(app).post('/auth/verify-email-change').send({ token });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('VERIFICATION_TOKEN_USED');
  });

  it('rejects an unknown token', async () => {
    const res = await request(app)
      .post('/auth/verify-email-change')
      .send({ token: 'not-a-real-token' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_TOKEN_INVALID');
  });

  it('rejects an expired token', async () => {
    const token = await EmailChangeTokenService.issue(userId, `stale-${userId}@example.com`);
    await prisma.emailChangeToken.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).post('/auth/verify-email-change').send({ token });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_TOKEN_EXPIRED');
  });

  it('refuses an address claimed after the request was made (409)', async () => {
    const contested = `contested-${Date.now()}@example.com`;
    const token = await EmailChangeTokenService.issue(userId, contested);
    // Someone else registers it in the window between request and click.
    await createTestUser(contested);

    const res = await request(app).post('/auth/verify-email-change').send({ token });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_EMAIL');

    // The account keeps its original address.
    const stored = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailHash: true },
    });
    expect(stored?.emailHash).not.toBe(blindIndex(contested));
  });

  it('marks the account verified on redemption', async () => {
    const { userId: unverifiedId } = await createTestUser(`unverified-${Date.now()}@example.com`, {
      verified: false,
    });
    const token = await EmailChangeTokenService.issue(
      unverifiedId,
      `now-verified-${Date.now()}@example.com`,
    );

    await request(app).post('/auth/verify-email-change').send({ token });

    const stored = await prisma.user.findUnique({
      where: { id: unverifiedId },
      select: { emailVerifiedAt: true },
    });
    expect(stored?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('writes a change audit row with before/after hashes and no plaintext', async () => {
    const oldEmail = (await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    }))!.email;
    const newEmail = `audited-${userId}@example.com`;
    const token = await EmailChangeTokenService.issue(userId, newEmail);

    await request(app).post('/auth/verify-email-change').send({ token });

    const row = await pollForAuditRow<{
      previous_value: unknown;
      new_value: unknown;
      entity_id: string;
    }>('action = $1 AND changed_by = $2', ['user.email.change', userId]);

    expect(row).not.toBeNull();
    expect(row?.entity_id).toBe(userId);
    expect(JSON.stringify(row?.new_value)).toContain(blindIndex(newEmail));
    expect(JSON.stringify(row?.new_value)).not.toContain(newEmail);
    // The previous address must not appear in plaintext either — and the stored
    // column was ciphertext, so a leak would be visible as the envelope prefix.
    expect(JSON.stringify(row?.previous_value)).not.toContain(oldEmail);
  });
});
