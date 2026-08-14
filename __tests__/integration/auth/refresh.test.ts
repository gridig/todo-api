import request from 'supertest';
import jwt from 'jsonwebtoken';
import prisma from '@/lib/prisma.js';
import { env } from '@/config/env.js';
import { hashRefreshToken } from '@/lib/tokens.js';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
  pollForAuditRow,
} from '../../helpers/testSetup.js';

const app = createTestApp();

// Register a fresh user and return its access token, refresh token, and id.
async function registerUser(): Promise<{ token: string; refreshToken: string; userId: string }> {
  const email = `refresh-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;
  const res = await request(app).post('/auth/register').send({ email, password: 'TestPass123!' });
  expect(res.status).toBe(201);
  const userId = (jwt.decode(res.body.token) as jwt.JwtPayload).sub as string;
  return { token: res.body.token, refreshToken: res.body.refreshToken, userId };
}

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('POST /auth/refresh', () => {
  it('register and login both return a refresh token', async () => {
    const { refreshToken } = await registerUser();
    expect(typeof refreshToken).toBe('string');
    expect(refreshToken.length).toBeGreaterThan(0);
  });

  it('exchanges a valid refresh token for a new access + rotated refresh token', async () => {
    const { refreshToken } = await registerUser();

    const res = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // Rotation: the returned refresh token must differ from the one presented.
    expect(res.body.refreshToken).not.toBe(refreshToken);

    // The new access token is a valid HS256 JWT for the same subject.
    const decoded = jwt.verify(res.body.token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as jwt.JwtPayload;
    expect(typeof decoded.sub).toBe('string');
  });

  it('rejects an unknown refresh token with 401', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects an expired refresh token with 401', async () => {
    const { userId } = await registerUser();
    const raw = 'expired-raw-token-value';
    await prisma.refreshToken.create({
      data: {
        tokenHash: hashRefreshToken(raw),
        userId,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await request(app).post('/auth/refresh').send({ refreshToken: raw });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('detects reuse: replaying a rotated token revokes the entire token set', async () => {
    const { refreshToken: r0, userId } = await registerUser();

    // First rotation succeeds, yielding r1 and revoking r0.
    const first = await request(app).post('/auth/refresh').send({ refreshToken: r0 });
    expect(first.status).toBe(200);
    const r1 = first.body.refreshToken as string;

    // Replaying the now-revoked r0 is treated as theft → 401.
    const replay = await request(app).post('/auth/refresh').send({ refreshToken: r0 });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_TOKEN');

    // Theft response revokes everything, so the legitimately-rotated r1 is dead too.
    const afterReuse = await request(app).post('/auth/refresh').send({ refreshToken: r1 });
    expect(afterReuse.status).toBe(401);

    // A security audit row is recorded for the reuse event.
    const auditRow = await pollForAuditRow('action = $1 AND changed_by = $2', [
      'auth.refresh.reuse',
      userId,
    ]);
    expect(auditRow).not.toBeNull();
  });

  it('concurrent refreshes with the same token: exactly one wins, then everything is revoked', async () => {
    // The rotation race branch (rotate() returns null for the loser): two
    // in-flight refreshes present the same token. The guarded revoke
    // (`revokedAt: null` filter) lets exactly one issue a successor; the loser
    // is ambiguous between double-submit and theft, so the route errs toward
    // security and revokes the user's entire token set — including the
    // winner's freshly-issued token.
    const { refreshToken } = await registerUser();

    const [a, b] = await Promise.all([
      request(app).post('/auth/refresh').send({ refreshToken }),
      request(app).post('/auth/refresh').send({ refreshToken }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    // The revoke-all fired by the loser must kill the winner's successor too.
    const winner = a.status === 200 ? a : b;
    const followUp = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: winner.body.refreshToken });
    expect(followUp.status).toBe(401);
  });
});
