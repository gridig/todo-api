import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import prisma from '@/lib/prisma.js';
import auditLog from '@/lib/auditLog.js';
import TodoService from '@/models/Todo.js';
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

async function registerUser(): Promise<{ token: string; refreshToken: string; userId: string }> {
  const email = `delete-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;
  const res = await request(app).post('/auth/register').send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  const userId = (jwt.decode(res.body.token) as jwt.JwtPayload).sub as string;
  return { token: res.body.token, refreshToken: res.body.refreshToken, userId };
}

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await cleanupTestData();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('DELETE /user/me', () => {
  it('deletes the account and cascades todos + refresh tokens; audit survives', async () => {
    const { token, userId } = await registerUser();
    await TodoService.create({ text: 'to be deleted', userId });

    const res = await request(app)
      .delete('/user/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD });

    expect(res.status).toBe(204);

    // User gone; children cascaded away.
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.todo.findMany({ where: { userId } })).toHaveLength(0);
    expect(await prisma.refreshToken.findMany({ where: { userId } })).toHaveLength(0);

    // The deletion audit row persists (no FK from audit_entries to users).
    const row = await pollForAuditRow('action = $1 AND changed_by = $2', ['user.delete', userId]);
    expect(row).not.toBeNull();
  });

  it('rejects deletion with a wrong current password (401) and keeps the account', async () => {
    const { token, userId } = await registerUser();

    const res = await request(app)
      .delete('/user/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'WrongPass123!' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('rolls back the deletion if the audit write fails', async () => {
    const { token, userId } = await registerUser();
    jest.spyOn(auditLog, 'write').mockRejectedValueOnce(new Error('audit down'));

    const res = await request(app)
      .delete('/user/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD });

    expect(res.status).toBe(500);
    // The transaction rolled back — the user must still exist.
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});
