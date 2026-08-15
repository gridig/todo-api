import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import UserService from '@/models/User.js';
import prisma from '@/lib/prisma.js';
import { env } from '@/config/env.js';
import { encryptField, blindIndex } from '@/lib/crypto/fieldCrypto.js';
import { normalizeEmail } from '@/lib/normalizeEmail.js';
import { createTestApp, connectTestDB, disconnectTestDB } from '../helpers/testSetup.js';
import { jest } from '@jest/globals';

const app = createTestApp();

// Login refuses to issue tokens for an unverified address, so suites that just
// need a usable account create one and mark it verified directly. The
// verification flow itself is covered in auth/email-verification.test.ts.
async function createVerifiedUser(email: string, password = 'TestPass123!') {
  const user = await UserService.create({ email, password });
  await UserService.markEmailVerified(user.id);
  return user;
}

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await UserService.deleteMany();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('Authentication Endpoints', () => {
  describe('POST /auth/register', () => {
    it('should accept a new registration without issuing a session', async () => {
      const response = await request(app).post('/auth/register').send({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      // 202, not 201: the account exists but is inert until verified, and no
      // tokens are handed out — that is what makes the response identical for
      // an address that was already taken.
      expect(response.status).toBe(202);
      expect(response.body.token).toBeUndefined();
      expect(response.body.refreshToken).toBeUndefined();
      expect(response.body.message).toBeDefined();

      // Encryption-at-rest: the stored email column is AES-256-GCM ciphertext,
      // never the plaintext address; the blind index carries the lookup.
      const stored = await prisma.user.findUnique({
        where: { emailHash: blindIndex('test@example.com') },
        select: { email: true },
      });
      expect(stored).not.toBeNull();
      expect(stored!.email.startsWith('enc:1:')).toBe(true);
      expect(stored!.email).not.toContain('test@example.com');
    });

    it('should reject weak password', async () => {
      const response = await request(app).post('/auth/register').send({
        email: 'test@example.com',
        password: 'weak',
      });

      expect(response.status).toBe(400);
    });

    // The account-existence oracle this endpoint used to be: a 409
    // DUPLICATE_EMAIL confirmed whether any address was registered, undoing the
    // anti-enumeration work done on login. Both responses must now be byte-identical.
    it('does not reveal whether an address is already registered', async () => {
      const fresh = await request(app).post('/auth/register').send({
        email: 'duplicate@example.com',
        password: 'TestPass123!',
      });

      const duplicate = await request(app).post('/auth/register').send({
        email: 'duplicate@example.com',
        password: 'AnotherPass123!',
      });

      expect(duplicate.status).toBe(fresh.status);
      expect(duplicate.body).toEqual(fresh.body);
      expect(duplicate.status).toBe(202);
      expect(duplicate.body.error).toBeUndefined();
    });

    it('does not overwrite the existing account when the address is taken', async () => {
      await request(app)
        .post('/auth/register')
        .send({ email: 'squat@example.com', password: 'TestPass123!' });
      const before = await UserService.findByEmail('squat@example.com');

      await request(app)
        .post('/auth/register')
        .send({ email: 'squat@example.com', password: 'AttackerPass123!' });
      const after = await UserService.findByEmail('squat@example.com');

      // Same row, same credentials — a second registration must not reset the
      // password or hand the address to whoever asked last.
      expect(after!.id).toBe(before!.id);
      expect(after!.password).toBe(before!.password);
    });
  });

  describe('POST /auth/login', () => {
    it('should login a user', async () => {
      await createVerifiedUser('test@example.com');

      const response = await request(app).post('/auth/login').send({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(200);
      expect(response.body.token).toBeDefined();
    });

    it('should reject invalid credentials (wrong password)', async () => {
      // First, create a user with known credentials
      await createVerifiedUser('existing@example.com', 'CorrectPass123!');

      // Now try to login with WRONG password
      const response = await request(app).post('/auth/login').send({
        email: 'existing@example.com',
        password: 'WrongPassword123!',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid email or password');
    });

    it('should reject invalid email', async () => {
      const response = await request(app).post('/auth/login').send({
        email: 'invalidemail',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(400);
    });

    it('should reject non-existent user', async () => {
      const response = await request(app).post('/auth/login').send({
        email: 'nonexistent@example.com',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid email or password');
    });

    it('runs bcrypt even when the email is unknown (timing-oracle guard)', async () => {
      // Direct timing assertions are flaky on shared CI runners, so we
      // verify the call-graph property that produces timing parity:
      // comparePassword must be invoked even when findByEmail returns null.
      // If a future refactor reintroduces the short-circuit, this test fires.
      // try/finally so a failed assertion can't leave the spy installed for
      // the rest of the file.
      const compareSpy = jest.spyOn(UserService, 'comparePassword');
      try {
        await request(app).post('/auth/login').send({
          email: 'never-registered@example.com',
          password: 'Whatever123!',
        });

        expect(compareSpy).toHaveBeenCalledTimes(1);
        const [, hashedPassword] = compareSpy.mock.calls[0]!;
        // Confirm the hash passed is a real bcrypt hash (not '' or undefined)
        expect(hashedPassword).toMatch(/^\$2[aby]?\$\d+\$/);
      } finally {
        compareSpy.mockRestore();
      }
    });

    it('should treat emails as case-insensitive', async () => {
      await createVerifiedUser('Test@EXAMPLE.com');

      const response = await request(app).post('/auth/login').send({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(200);
      expect(response.body.token).toBeDefined();
    });

    it('should treat NFC and NFD Unicode forms of the same email as equivalent', async () => {
      // Build both forms via String.fromCodePoint so source-file editor or
      // pipeline normalization cannot collapse them accidentally.
      // NFC: 'caf' + U+00E9. NFD: 'caf' + U+0065 + U+0301 (combining acute).
      const nfc = 'caf' + String.fromCodePoint(0x00e9) + '@example.com';
      const nfd = 'caf' + String.fromCodePoint(0x0065, 0x0301) + '@example.com';
      expect(nfc).not.toBe(nfd);
      expect(nfc.length).not.toBe(nfd.length);

      const registerResponse = await request(app).post('/auth/register').send({
        email: nfc,
        password: 'TestPass123!',
      });
      expect(registerResponse.status).toBe(202);
      // Verify via the NFC form; the login below then uses NFD.
      const registered = await UserService.findByEmail(nfc);
      await UserService.markEmailVerified(registered!.id);

      const loginResponse = await request(app).post('/auth/login').send({
        email: nfd,
        password: 'TestPass123!',
      });
      expect(loginResponse.status).toBe(200);
      expect(loginResponse.body.token).toBeDefined();
    });
  });

  describe('JWT payload shape and bcrypt rehash', () => {
    it('issues tokens with sub/iss/aud claims and HS256', async () => {
      const email = `claims-${Date.now()}@example.com`;
      await createVerifiedUser(email);
      const loginResponse = await request(app)
        .post('/auth/login')
        .send({ email, password: 'TestPass123!' });
      expect(loginResponse.status).toBe(200);

      const decoded = jwt.decode(loginResponse.body.token, {
        complete: true,
      });
      expect(decoded).not.toBeNull();
      expect(decoded?.header.alg).toBe('HS256');
      const payload = decoded?.payload as Record<string, unknown>;
      expect(typeof payload.sub).toBe('string');
      expect(payload.iss).toBe(env.JWT_ISSUER);
      expect(payload.aud).toBe(env.JWT_AUDIENCE);
      expect(typeof payload.exp).toBe('number');
    });

    it('rejects legacy { userId } tokens with 401 INVALID_TOKEN', async () => {
      // Post-migration: iss/aud are enforced and the { userId } back-compat
      // path is gone, so pre-rollout tokens no longer verify.
      const { user } = await (await import('../helpers/testSetup.js')).createTestUser();
      const legacyToken = jwt.sign({ userId: user.id }, env.JWT_SECRET, {
        expiresIn: '24h',
        algorithm: 'HS256',
      });

      const response = await request(app)
        .get('/todos')
        .set('Authorization', `Bearer ${legacyToken}`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });

    it('rehashes a legacy cost-10 password on next successful login', async () => {
      // Pre-create the user via Prisma with a cost-10 hash, bypassing
      // UserService.create (which would already hash at the current
      // SALT_ROUNDS). Email/emailHash still go through the field-crypto helpers
      // so the login-by-blind-index lookup can find the row. Then login and
      // confirm the stored hash upgraded.
      const email = `rehash-${Date.now()}@example.com`;
      const password = 'TestPass123!';
      const legacyHash = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: {
          email: encryptField(normalizeEmail(email)),
          emailHash: blindIndex(email),
          password: legacyHash,
        },
        select: { id: true, password: true },
      });
      expect(bcrypt.getRounds(user.password)).toBe(10);
      await UserService.markEmailVerified(user.id);

      const loginResponse = await request(app).post('/auth/login').send({
        email,
        password,
      });
      expect(loginResponse.status).toBe(200);

      // Rehash is fire-and-forget — give it a moment to land in the DB.
      // Poll briefly rather than fixed sleep to keep the test snappy.
      let after: { password: string } | null = null;
      for (let i = 0; i < 20; i++) {
        after = await prisma.user.findUnique({
          where: { id: user.id },
          select: { password: true },
        });
        if (after && bcrypt.getRounds(after.password) >= 12) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(after).not.toBeNull();
      expect(bcrypt.getRounds(after!.password)).toBeGreaterThanOrEqual(12);
      // Sanity: the rehashed value still authenticates the same plaintext.
      expect(await bcrypt.compare(password, after!.password)).toBe(true);
    });
  });
});

describe('Error Handling', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should handle unexpected error during registration', async () => {
    const spy = jest
      .spyOn(UserService, 'create')
      .mockRejectedValue(new Error('Database connection failed'));

    const response = await request(app).post('/auth/register').send({
      email: 'test@example.com',
      password: 'TestPass123!',
    });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');

    spy.mockRestore();
  });

  it('should handle unexpected error during login', async () => {
    const spy = jest
      .spyOn(UserService, 'findByEmail')
      .mockRejectedValue(new Error('Database connection failed'));

    const response = await request(app).post('/auth/login').send({
      email: 'test@example.com',
      password: 'TestPass123!',
    });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');

    spy.mockRestore();
  });
});
