import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  createTestAdmin,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
} from '../../helpers/testSetup.js';

const app = createTestApp();

let adminToken: string;

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('GET /admin/users', () => {
  it('returns a paginated list of users including role, without secrets', async () => {
    ({ authToken: adminToken } = await createTestAdmin());
    await createTestUser();
    await createTestUser();

    const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    expect(res.body.meta).toHaveProperty('hasMore');
    expect(res.body.meta).toHaveProperty('nextCursor');

    const row = res.body.data[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('email');
    expect(['user', 'admin']).toContain(row.role);
    expect(row.password).toBeUndefined();
    expect(row.emailHash).toBeUndefined();
  });

  it('honors the limit and returns a cursor when more remain', async () => {
    ({ authToken: adminToken } = await createTestAdmin());
    await createTestUser();
    await createTestUser();

    const res = await request(app)
      .get('/admin/users?limit=2')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.hasMore).toBe(true);
    expect(typeof res.body.meta.nextCursor).toBe('string');

    // The cursor fetches the next page without overlap.
    const next = await request(app)
      .get(`/admin/users?limit=2&cursor=${res.body.meta.nextCursor}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(next.status).toBe(200);
    const firstIds = res.body.data.map((u: { id: string }) => u.id);
    const nextIds = next.body.data.map((u: { id: string }) => u.id);
    expect(nextIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });
});
