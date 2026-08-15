import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
} from '../../helpers/testSetup.js';
import { createTestTodos } from '../../helpers/todoHelpers.js';
import TodoService from '@/models/Todo.js';
import UserService from '@/models/User.js';
import prisma from '@/lib/prisma.js';
import type { Application } from 'express';

const app: Application = createTestApp();

describe('GET /todos - List Todos', () => {
  let authToken: string;
  let userId: string;

  beforeAll(async () => {
    await connectTestDB();
    ({ authToken, userId } = await createTestUser());
  });

  afterEach(async () => {
    await TodoService.deleteMany();
  });

  afterAll(async () => {
    await UserService.deleteMany();
    await disconnectTestDB();
  });

  describe('Success Cases', () => {
    it('should return paginated envelope with empty data when user has no todos', async () => {
      const response = await request(app).get('/todos').set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
      expect(response.body.meta.hasMore).toBe(false);
      expect(response.body.meta.nextCursor).toBeNull();
    });

    it('should return todos in data array with correct meta', async () => {
      await createTestTodos(userId, 3);

      const response = await request(app).get('/todos').set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(3);
      expect(response.body.meta.hasMore).toBe(false);
      expect(response.body.meta.nextCursor).toBeNull();
    });

    it('should respect the limit param', async () => {
      await createTestTodos(userId, 5);

      const response = await request(app)
        .get('/todos?limit=2')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta.hasMore).toBe(true);
      expect(response.body.meta.nextCursor).not.toBeNull();
    });

    // Regression for the missing cursor tiebreaker: created_at is TIMESTAMP(3),
    // so burst inserts share a timestamp, and ordering by createdAt alone leaves
    // the order inside a tie group unconstrained — a page boundary landing in
    // one can drop or repeat rows.
    //
    // Asserting only "no loss, no duplication" is not enough: Postgres happens
    // to return a small unindexed tie group in physical order consistently, so
    // that assertion passes with or without the fix. What the tiebreaker
    // actually guarantees is a *total* order, so assert the exact sequence —
    // id DESC, which random v4 ids make vanishingly unlikely to coincide with
    // insertion order.
    it('should return rows sharing a createdAt in a total, id-tiebroken order', async () => {
      const sharedCreatedAt = new Date('2026-01-01T00:00:00.000Z');
      const created = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          prisma.todo.create({
            data: { text: `tie-${i}`, userId, createdAt: sharedCreatedAt },
          }),
        ),
      );
      const expectedOrder = created.map((todo) => todo.id).sort((a, b) => (a < b ? 1 : -1));

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < created.length; page++) {
        // Annotated to break the inference cycle: cursor's narrowed type would
        // otherwise depend on the response it is assigned from at the loop foot.
        const query: string = cursor ? `/todos?limit=2&cursor=${cursor}` : '/todos?limit=2';
        const response = await request(app).get(query).set('Authorization', `Bearer ${authToken}`);

        expect(response.status).toBe(200);
        seen.push(...response.body.data.map((todo: { id: string }) => todo.id));
        if (!response.body.meta.hasMore) break;
        cursor = response.body.meta.nextCursor;
      }

      expect(seen).toEqual(expectedOrder);
    });

    it('should navigate to the next page using cursor', async () => {
      await createTestTodos(userId, 4);

      const firstPage = await request(app)
        .get('/todos?limit=2')
        .set('Authorization', `Bearer ${authToken}`);

      expect(firstPage.body.data).toHaveLength(2);
      expect(firstPage.body.meta.hasMore).toBe(true);

      const cursor = firstPage.body.meta.nextCursor as string;

      const secondPage = await request(app)
        .get(`/todos?limit=2&cursor=${cursor}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(secondPage.body.data).toHaveLength(2);
      expect(secondPage.body.meta.hasMore).toBe(false);
      expect(secondPage.body.meta.nextCursor).toBeNull();

      const firstPageIds: string[] = firstPage.body.data.map((t: { id: string }) => t.id);
      const secondPageIds: string[] = secondPage.body.data.map((t: { id: string }) => t.id);
      // No row may appear on both pages — a single re-served row is a
      // pagination bug (`not.toEqual(arrayContaining(...))` would only catch
      // page 1 containing EVERY page-2 id).
      const overlap = firstPageIds.filter((id) => secondPageIds.includes(id));
      expect(overlap).toEqual([]);
    });

    it('should default to limit 20 and not exceed it', async () => {
      await createTestTodos(userId, 25);

      const response = await request(app).get('/todos').set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(20);
      expect(response.body.meta.hasMore).toBe(true);
    });

    it('should return todos for the authenticated user only', async () => {
      await createTestTodos(userId, 2);
      const { userId: otherUserId } = await createTestUser();
      await createTestTodos(otherUserId, 3);

      const response = await request(app).get('/todos').set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      response.body.data.forEach((todo: { userId: string }) => {
        expect(todo.userId).toBe(userId);
      });
    });
  });

  describe('Validation', () => {
    it('should reject limit above 100', async () => {
      const response = await request(app)
        .get('/todos?limit=101')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should reject non-integer limit', async () => {
      const response = await request(app)
        .get('/todos?limit=abc')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should reject invalid cursor format', async () => {
      const response = await request(app)
        .get('/todos?cursor=not-a-uuid')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('Authentication', () => {
    it('should reject request without auth token', async () => {
      const response = await request(app).get('/todos');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('No authentication token provided');
    });
  });
});
