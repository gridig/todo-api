import request from 'supertest';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
  registerVerifyAndLogin,
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

describe('POST /auth/logout-all', () => {
  it('revokes every active refresh token for the authenticated user', async () => {
    const email = `logout-all-${Date.now()}@example.com`;
    const password = 'TestPass123!';

    // Two independent sessions for the same user (e.g. two devices).
    const first = await registerVerifyAndLogin(app, email, password);
    const accessToken = first.token;
    const rtA = first.refreshToken;

    const second = await request(app).post('/auth/login').send({ email, password });
    const rtB = second.body.refreshToken as string;

    const res = await request(app)
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${accessToken}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);

    // Both sessions are now dead.
    for (const rt of [rtA, rtB]) {
      const refresh = await request(app).post('/auth/refresh').send({ refreshToken: rt });
      expect(refresh.status).toBe(401);
    }
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/auth/logout-all').send();
    expect(res.status).toBe(401);
  });
});
