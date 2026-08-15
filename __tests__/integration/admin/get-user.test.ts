import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  createTestAdmin,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
  generateUniqueId,
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

describe('GET /admin/users/:id', () => {
  it('returns the target user profile with a decrypted email and no secrets', async () => {
    const { authToken: adminToken } = await createTestAdmin();
    const targetEmail = `admin-get-${generateUniqueId()}@example.com`;
    const { userId: targetId } = await createTestUser(targetEmail);

    const res = await request(app)
      .get(`/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(targetId);
    expect(res.body.email).toBe(targetEmail);
    expect(res.body.role).toBe('user');
    // The email column holds ciphertext at rest; the route must hand back
    // plaintext without ever exposing the hash or password.
    expect(res.body.password).toBeUndefined();
    expect(res.body.emailHash).toBeUndefined();
  });

  it('returns 404 USER_NOT_FOUND for a well-formed id that does not exist', async () => {
    const { authToken: adminToken } = await createTestAdmin();

    const res = await request(app)
      .get(`/admin/users/${generateUniqueId()}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('returns 400 INVALID_ID_FORMAT for a malformed id', async () => {
    const { authToken: adminToken } = await createTestAdmin();

    const res = await request(app)
      .get('/admin/users/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ID_FORMAT');
  });
});
