import request from 'supertest';
import jwt from 'jsonwebtoken';
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

// Register via the endpoint so we get a real access + refresh token pair — the
// refresh token lets us assert the change revokes existing sessions.
async function registerUser(): Promise<{
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}> {
  const email = `pwchange-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;
  const res = await request(app).post('/auth/register').send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  const userId = (jwt.decode(res.body.token) as jwt.JwtPayload).sub as string;
  return { token: res.body.token, refreshToken: res.body.refreshToken, userId, email };
}

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await cleanupTestData();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('PATCH /user/me/password', () => {
  it('changes the password, revokes refresh tokens, and audits the change', async () => {
    const { token, refreshToken, userId, email } = await registerUser();
    const newPassword = 'NewPass456!';

    const res = await request(app)
      .patch('/user/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword });

    expect(res.status).toBe(200);

    // The pre-existing refresh token is now dead.
    const refresh = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);

    // Old password no longer works; the new one does.
    const oldLogin = await request(app).post('/auth/login').send({ email, password: PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/auth/login').send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);

    const row = await pollForAuditRow<{ metadata: { revokedCount: number } }>(
      'action = $1 AND changed_by = $2',
      ['user.password.change', userId],
    );
    expect(row).not.toBeNull();
    expect(row?.metadata.revokedCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects a wrong current password with 401', async () => {
    const { token } = await registerUser();
    const res = await request(app)
      .patch('/user/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'WrongPass123!', newPassword: 'NewPass456!' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a weak new password with 400', async () => {
    const { token } = await registerUser();
    const res = await request(app)
      .patch('/user/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'weak' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
