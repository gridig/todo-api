import request from 'supertest';
import prisma from '@/lib/prisma.js';
import { blindIndex } from '@/lib/crypto/fieldCrypto.js';
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

describe('PATCH /user/me', () => {
  it('updates the display name without requiring a password', async () => {
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Ada Lovelace' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Ada Lovelace');

    const check = await request(app).get('/user/me').set('Authorization', `Bearer ${authToken}`);
    expect(check.body.name).toBe('Ada Lovelace');
  });

  it('changes the email, re-encrypting the column and rotating the blind index', async () => {
    const newEmail = `changed-${userId}@example.com`;
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: newEmail, currentPassword: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(newEmail);

    // At rest: ciphertext envelope in `email`, blind index matching the new email.
    const stored = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailHash: true },
    });
    expect(stored?.email.startsWith('enc:1:')).toBe(true);
    expect(stored?.email).not.toContain(newEmail);
    expect(stored?.emailHash).toBe(blindIndex(newEmail));

    // The new address is usable for login.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: newEmail, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('rejects an email change without the current password (400)', async () => {
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: `nope-${userId}@example.com` });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an email change with a wrong current password (401)', async () => {
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: `nope-${userId}@example.com`, currentPassword: 'WrongPass123!' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects changing to an email already in use (409)', async () => {
    const other = await createTestUser(`taken-${Date.now()}@example.com`);

    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: other.user.email, currentPassword: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_EMAIL');
  });

  it('rejects an empty patch (neither name nor email) with 400', async () => {
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('writes a user.update audit row that contains no plaintext email', async () => {
    const newEmail = `audit-${userId}@example.com`;
    await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: newEmail, currentPassword: PASSWORD });

    const row = await pollForAuditRow<{ metadata: unknown; entity_id: string }>(
      'action = $1 AND changed_by = $2',
      ['user.update', userId],
    );
    expect(row).not.toBeNull();
    expect(row?.entity_id).toBe(userId);
    // Blind-index hash may be present, but the raw address must never be.
    expect(JSON.stringify(row?.metadata)).not.toContain(newEmail);
  });
});
