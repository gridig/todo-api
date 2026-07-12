import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
} from '../../helpers/testSetup.js';

const app = createTestApp();

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
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('GET /user/me', () => {
  it('returns the current user profile', async () => {
    const res = await request(app).get('/user/me').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(userId);
    expect(typeof res.body.email).toBe('string');
    expect(res.body.email).toContain('@');
    // name defaults to null (never set on registration).
    expect(res.body.name).toBeNull();
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();
    // Never leak the password hash or the blind-index column.
    expect(res.body.password).toBeUndefined();
    expect(res.body.emailHash).toBeUndefined();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/user/me');
    expect(res.status).toBe(401);
  });
});
