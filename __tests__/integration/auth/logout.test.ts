import request from 'supertest';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
} from '../../helpers/testSetup.js';

const app = createTestApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('POST /auth/logout', () => {
  it('revokes the presented refresh token', async () => {
    const email = `logout-${Date.now()}@example.com`;
    const register = await request(app)
      .post('/auth/register')
      .send({ email, password: 'TestPass123!' });
    const { refreshToken } = register.body;

    const logout = await request(app).post('/auth/logout').send({ refreshToken });
    expect(logout.status).toBe(200);

    // The revoked token can no longer be refreshed.
    const refresh = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('INVALID_TOKEN');
  });

  it('responds 200 for an unknown token (no existence oracle)', async () => {
    const res = await request(app)
      .post('/auth/logout')
      .send({ refreshToken: 'never-issued-token' });
    expect(res.status).toBe(200);
  });

  it('rejects a request with no refresh token (400)', async () => {
    const res = await request(app).post('/auth/logout').send({});
    expect(res.status).toBe(400);
  });
});
