import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
} from '../../helpers/testSetup.js';
import { createTestTodos } from '../../helpers/todoHelpers.js';
import TodoService from '../../../models/Todo.js';
import UserService from '../../../models/User.js';
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

      const firstPageIds = firstPage.body.data.map((t: { id: string }) => t.id);
      const secondPageIds = secondPage.body.data.map((t: { id: string }) => t.id);
      expect(firstPageIds).not.toEqual(expect.arrayContaining(secondPageIds));
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
