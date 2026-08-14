import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  createTestAdmin,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
  truncateAuditEntries,
  pollForAuditRow,
} from '../../helpers/testSetup.js';

const app = createTestApp();

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

// Every admin route, exercised as a non-admin, must 403.
const routes = [
  { method: 'get' as const, path: '/admin/users' },
  { method: 'get' as const, path: '/admin/users/00000000-0000-0000-0000-000000000000' },
  {
    method: 'patch' as const,
    path: '/admin/users/00000000-0000-0000-0000-000000000000/role',
    body: { role: 'admin' },
  },
  { method: 'delete' as const, path: '/admin/users/00000000-0000-0000-0000-000000000000' },
];

describe('/admin authorization', () => {
  it.each(routes)('regular user is forbidden: $method $path', async ({ method, path, body }) => {
    const { authToken } = await createTestUser();
    const res = await request(app)
      [method](path)
      .set('Authorization', `Bearer ${authToken}`)
      .send(body ?? {});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each(routes)('unauthenticated is rejected: $method $path', async ({ method, path, body }) => {
    const res = await request(app)
      [method](path)
      .send(body ?? {});
    expect(res.status).toBe(401);
  });

  it('admin is allowed through the guard', async () => {
    const { authToken } = await createTestAdmin();
    const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
  });

  it('records an access.denied audit row when a non-admin is blocked', async () => {
    const { authToken, userId } = await createTestUser();
    await request(app).get('/admin/users').set('Authorization', `Bearer ${authToken}`);

    const row = await pollForAuditRow('action = $1 AND changed_by = $2', ['access.denied', userId]);
    expect(row).not.toBeNull();
  });
});
