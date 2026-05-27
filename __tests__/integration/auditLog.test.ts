import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import UserService from '../../models/User.js';
import TodoService from '../../models/Todo.js';
import auditLog from '../../lib/auditLog.js';
import { AuditAction } from '../../lib/auditActions.js';
import prisma from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
  truncateAuditEntries,
  pollForAuditRow,
} from '../helpers/testSetup.js';

const app = createTestApp();

interface AuditRow {
  id: string;
  changed_at: Date;
  entity_type: string;
  entity_id: string | null;
  action: string;
  outcome: string;
  outcome_reason: string | null;
  changed_by: string | null;
  source_ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  previous_value: unknown;
  new_value: unknown;
  metadata: unknown;
}

const hashEmail = (email: string): string =>
  createHash('sha256').update(email.toLowerCase().trim()).digest('hex');

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await TodoService.deleteMany();
  await UserService.deleteMany();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('Audit log — auth emissions', () => {
  it('emits AuthRegister on successful registration with entity + actor', async () => {
    const email = `audit-reg-${Date.now()}@example.com`;
    const res = await request(app).post('/auth/register').send({ email, password: 'TestPass123!' });
    expect(res.status).toBe(201);

    const row = await pollForAuditRow<AuditRow>(`action = $1 AND outcome = $2`, [
      AuditAction.AuthRegister,
      'success',
    ]);
    expect(row).not.toBeNull();
    expect(row!.entity_type).toBe('User');
    expect(row!.entity_id).toBeTruthy();
    expect(row!.changed_by).toBe(row!.entity_id);
    expect((row!.new_value as { email: string }).email).toBe(email.toLowerCase());
    expect(row!.request_id).toBeTruthy();
  });

  it('emits AuthLogin success with changedBy populated', async () => {
    const email = `audit-login-${Date.now()}@example.com`;
    await UserService.create({ email, password: 'TestPass123!' });

    const res = await request(app).post('/auth/login').send({ email, password: 'TestPass123!' });
    expect(res.status).toBe(200);

    const row = await pollForAuditRow<AuditRow>(`action = $1 AND outcome = $2`, [
      AuditAction.AuthLogin,
      'success',
    ]);
    expect(row).not.toBeNull();
    expect(row!.entity_type).toBe('User');
    expect(row!.changed_by).toBeTruthy();
  });

  it('emits AuthLogin failure with emailHash, never raw email', async () => {
    const email = `audit-fail-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/auth/login')
      .send({ email, password: 'NotTheRightPassword!' });
    expect(res.status).toBe(401);

    const row = await pollForAuditRow<AuditRow>(`action = $1 AND outcome = $2`, [
      AuditAction.AuthLogin,
      'failure',
    ]);
    expect(row).not.toBeNull();
    expect(row!.outcome_reason).toBe('invalid-credentials');
    expect(row!.changed_by).toBeNull();
    const md = row!.metadata as { emailHash: string };
    expect(md.emailHash).toBe(hashEmail(email));
    // PII guard: the audit row must never carry the raw email.
    expect(JSON.stringify(row!.metadata)).not.toContain(email);
  });

  it('emits AuthNoToken on a request without an Authorization header', async () => {
    const res = await request(app).get('/todos');
    expect(res.status).toBe(401);

    const row = await pollForAuditRow<AuditRow>(`action = $1`, [AuditAction.AuthNoToken]);
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe('failure');
    expect(row!.outcome_reason).toBe('no-auth-header');
    expect(row!.changed_by).toBeNull();
  });

  it('emits AuthTokenInvalid with a truncated reason', async () => {
    const res = await request(app).get('/todos').set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);

    const row = await pollForAuditRow<AuditRow>(`action = $1`, [AuditAction.AuthTokenInvalid]);
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe('failure');
    expect(row!.outcome_reason).toBeTruthy();
    expect(row!.outcome_reason!.length).toBeLessThanOrEqual(100);
  });
});

describe('Audit log — todo mutations', () => {
  it('emits TodoCreate with newValue and changedBy', async () => {
    const { authToken, userId } = await createTestUser();
    const res = await request(app)
      .post('/todos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ text: 'Audit me' });
    expect(res.status).toBe(201);
    const todoId = res.body.id as string;

    const row = await pollForAuditRow<AuditRow>(`action = $1 AND entity_id = $2`, [
      AuditAction.TodoCreate,
      todoId,
    ]);
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe('success');
    expect(row!.entity_type).toBe('Todo');
    expect(row!.changed_by).toBe(userId);
    const newVal = row!.new_value as { id: string; text: string; done: boolean };
    expect(newVal.id).toBe(todoId);
    expect(newVal.text).toBe('Audit me');
    expect(newVal.done).toBe(false);
    expect(row!.previous_value).toBeNull();
  });

  it('emits TodoUpdate on toggle with new_value only (previous derivable)', async () => {
    const { authToken, userId } = await createTestUser();
    const todo = await TodoService.create({ text: 'Toggle me', userId });

    const res = await request(app)
      .patch(`/todos/${todo.id}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);

    const row = await pollForAuditRow<AuditRow>(`action = $1 AND entity_id = $2`, [
      AuditAction.TodoUpdate,
      todo.id,
    ]);
    expect(row).not.toBeNull();
    expect(row!.changed_by).toBe(userId);
    const newVal = row!.new_value as { done: boolean };
    expect(newVal.done).toBe(true);
    // Memory rule: boolean flip — previous_value is derivable from new_value.done.
    expect(row!.previous_value).toBeNull();
  });

  it('emits TodoDelete with previous_value and null new_value', async () => {
    const { authToken, userId } = await createTestUser();
    const todo = await TodoService.create({ text: 'Delete me', userId });

    const res = await request(app)
      .delete(`/todos/${todo.id}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(204);

    const row = await pollForAuditRow<AuditRow>(`action = $1 AND entity_id = $2`, [
      AuditAction.TodoDelete,
      todo.id,
    ]);
    expect(row).not.toBeNull();
    expect(row!.changed_by).toBe(userId);
    const prevVal = row!.previous_value as { id: string; text: string };
    expect(prevVal.id).toBe(todo.id);
    expect(prevVal.text).toBe('Delete me');
    expect(row!.new_value).toBeNull();
  });
});

describe('Audit log — cross-user access denials', () => {
  it('emits AccessDenied when user A GETs user B\'s todo', async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const todoB = await TodoService.create({ text: 'B owns me', userId: userB.userId });

    const res = await request(app)
      .get(`/todos/${todoB.id}`)
      .set('Authorization', `Bearer ${userA.authToken}`);
    expect(res.status).toBe(404);

    const row = await pollForAuditRow<AuditRow>(
      `action = $1 AND entity_id = $2 AND changed_by = $3`,
      [AuditAction.AccessDenied, todoB.id, userA.userId],
    );
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe('failure');
    expect(row!.entity_type).toBe('Todo');
  });

  it('emits AccessDenied when user A toggles user B\'s todo', async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const todoB = await TodoService.create({ text: 'B owns me', userId: userB.userId });

    const res = await request(app)
      .patch(`/todos/${todoB.id}`)
      .set('Authorization', `Bearer ${userA.authToken}`);
    expect(res.status).toBe(404);

    const row = await pollForAuditRow<AuditRow>(
      `action = $1 AND entity_id = $2 AND changed_by = $3`,
      [AuditAction.AccessDenied, todoB.id, userA.userId],
    );
    expect(row).not.toBeNull();
  });

  it('emits AccessDenied when user A deletes user B\'s todo', async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const todoB = await TodoService.create({ text: 'B owns me', userId: userB.userId });

    const res = await request(app)
      .delete(`/todos/${todoB.id}`)
      .set('Authorization', `Bearer ${userA.authToken}`);
    expect(res.status).toBe(404);

    const row = await pollForAuditRow<AuditRow>(
      `action = $1 AND entity_id = $2 AND changed_by = $3`,
      [AuditAction.AccessDenied, todoB.id, userA.userId],
    );
    expect(row).not.toBeNull();
  });
});

describe('Audit log — tamper-evidence & rollback', () => {
  it('rejects UPDATE on audit_entries from the app pool (REVOKE in force)', async () => {
    // The runtime PrismaClient connects as db_app; UPDATE was REVOKEd in the
    // audit_entries migration. Postgres returns SQLSTATE 42501.
    await expect(
      prisma.$executeRaw`UPDATE audit_entries SET action = 'tamper' WHERE FALSE`,
    ).rejects.toThrow(/permission denied/i);
  });

  it('rejects DELETE on audit_entries from the app pool', async () => {
    await expect(
      prisma.$executeRaw`DELETE FROM audit_entries WHERE FALSE`,
    ).rejects.toThrow(/permission denied/i);
  });

  it('rolls back the parent mutation when the audit insert throws', async () => {
    const { userId } = await createTestUser();
    const todo = await TodoService.create({ text: 'Rollback me', userId, done: false });
    await truncateAuditEntries();

    const spy = jest
      .spyOn(auditLog, 'write')
      .mockRejectedValue(new Error('simulated audit insert failure'));

    await expect(TodoService.toggleDone({ id: todo.id, userId })).rejects.toThrow(
      /simulated audit insert failure/,
    );

    // The toggle must NOT have flipped — $transaction rolled it back.
    const after = await prisma.todo.findUnique({ where: { id: todo.id } });
    expect(after).not.toBeNull();
    expect(after!.done).toBe(false);

    // And no audit row exists for that toggle.
    const row = await pollForAuditRow<AuditRow>(
      `action = $1 AND entity_id = $2`,
      [AuditAction.TodoUpdate, todo.id],
      { maxAttempts: 4, intervalMs: 25 },
    );
    expect(row).toBeNull();

    spy.mockRestore();
  });
});

describe('Audit log — request context propagation', () => {
  it('captures source_ip, user_agent, and request_id from the request scope', async () => {
    const { user } = await createTestUser();
    const authToken = jwt.sign({ sub: user.id }, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    const customRequestId = 'audit-ctx-test-' + Date.now();
    const res = await request(app)
      .post('/todos')
      .set('Authorization', `Bearer ${authToken}`)
      .set('X-Request-ID', customRequestId)
      .set('User-Agent', 'audit-log-test/1.0')
      .send({ text: 'Context propagation' });
    expect(res.status).toBe(201);
    const todoId = res.body.id as string;

    const row = await pollForAuditRow<AuditRow>(`action = $1 AND entity_id = $2`, [
      AuditAction.TodoCreate,
      todoId,
    ]);
    expect(row).not.toBeNull();
    expect(row!.request_id).toBe(customRequestId);
    expect(row!.user_agent).toBe('audit-log-test/1.0');
    expect(row!.source_ip).toBeTruthy();
  });
});
