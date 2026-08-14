import request from 'supertest';
import prisma from '@/lib/prisma.js';
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

let adminToken: string;
let adminId: string;

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(async () => {
  ({ authToken: adminToken, userId: adminId } = await createTestAdmin());
});

afterEach(async () => {
  await cleanupTestData();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('PATCH /admin/users/:id/role', () => {
  it('promotes a user to admin and audits the change', async () => {
    const target = await createTestUser();

    const res = await request(app)
      .patch(`/admin/users/${target.userId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');

    const stored = await prisma.user.findUnique({
      where: { id: target.userId },
      select: { role: true },
    });
    expect(stored?.role).toBe('admin');

    const row = await pollForAuditRow<{
      previous_value: { role: string };
      new_value: { role: string };
    }>('action = $1 AND entity_id = $2 AND changed_by = $3', [
      'admin.user.role.change',
      target.userId,
      adminId,
    ]);
    expect(row).not.toBeNull();
    expect(row?.previous_value.role).toBe('user');
    expect(row?.new_value.role).toBe('admin');
  });

  it('can demote an admin back to user', async () => {
    const target = await createTestAdmin();
    const res = await request(app)
      .patch(`/admin/users/${target.userId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('user');
  });

  it('forbids an admin from changing their own role', async () => {
    const res = await request(app)
      .patch(`/admin/users/${adminId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    // Unchanged.
    const stored = await prisma.user.findUnique({ where: { id: adminId }, select: { role: true } });
    expect(stored?.role).toBe('admin');
  });

  it('rejects an invalid role with 400', async () => {
    const target = await createTestUser();
    const res = await request(app)
      .patch(`/admin/users/${target.userId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'superuser' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown user id', async () => {
    const res = await request(app)
      .patch('/admin/users/00000000-0000-0000-0000-000000000000/role')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});
