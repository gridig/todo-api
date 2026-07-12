import request from 'supertest';
import { jest } from '@jest/globals';
import prisma from '@/lib/prisma.js';
import auditLog from '@/lib/auditLog.js';
import TodoService from '@/models/Todo.js';
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
  jest.restoreAllMocks();
  await cleanupTestData();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('DELETE /admin/users/:id', () => {
  it('deletes another user, cascades their data, and audits as admin', async () => {
    const target = await createTestUser();
    await TodoService.create({ text: 'target todo', userId: target.userId });

    const res = await request(app)
      .delete(`/admin/users/${target.userId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: target.userId } })).toBeNull();
    expect(await prisma.todo.findMany({ where: { userId: target.userId } })).toHaveLength(0);

    const row = await pollForAuditRow('action = $1 AND entity_id = $2 AND changed_by = $3', [
      'admin.user.delete',
      target.userId,
      adminId,
    ]);
    expect(row).not.toBeNull();
  });

  it('forbids an admin from deleting their own account via the admin API', async () => {
    const res = await request(app)
      .delete(`/admin/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await prisma.user.findUnique({ where: { id: adminId } })).not.toBeNull();
  });

  it('returns 404 for an unknown user id', async () => {
    const res = await request(app)
      .delete('/admin/users/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('rolls back the deletion if the audit write fails', async () => {
    const target = await createTestUser();
    jest.spyOn(auditLog, 'write').mockRejectedValueOnce(new Error('audit down'));

    const res = await request(app)
      .delete(`/admin/users/${target.userId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
    expect(await prisma.user.findUnique({ where: { id: target.userId } })).not.toBeNull();
  });
});
