import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
} from '../../helpers/testSetup.js';
import { createTestTodo, generateFakeUUID } from '../../helpers/todoHelpers.js';
import TodoService from '@/models/Todo.js';
import UserService from '@/models/User.js';
import type { Application } from 'express';

const app: Application = createTestApp();

describe('GET /todos/:id - Get Single Todo', () => {
  let authToken: string;
  let userId: string;
  let todoId: string;

  beforeAll(async () => {
    await connectTestDB();
    ({ authToken, userId } = await createTestUser());
  });

  beforeEach(async () => {
    const todo = await createTestTodo(userId, 'Test todo for retrieval');
    todoId = todo.id;
  });

  afterEach(async () => {
    await TodoService.deleteMany();
  });

  afterAll(async () => {
    await UserService.deleteMany();
    await disconnectTestDB();
  });

  describe('Success Cases', () => {
    it('should return a specific todo', async () => {
      const response = await request(app)
        .get(`/todos/${todoId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.text).toBe('Test todo for retrieval');
      expect(response.body.userId).toBe(userId);
      expect(response.body.id).toBe(todoId);
      expect(response.body.done).toBe(false);
    });
  });

  describe('Error Cases', () => {
    it('should return 404 for non-existent todo', async () => {
      const fakeId = generateFakeUUID();

      const response = await request(app)
        .get(`/todos/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('TODO_NOT_FOUND');
      expect(response.body.error.message).toBe('Todo not found');
    });

    it('should return 400 for invalid ID format', async () => {
      const response = await request(app)
        .get('/todos/invalid-id-format')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_ID_FORMAT');
      expect(response.body.error.message).toBe('Invalid ID format');
    });

    it('should return 404 for todo belonging to different user', async () => {
      // Create another user's todo
      const { userId: otherUserId } = await createTestUser('other@example.com');
      const otherTodo = await createTestTodo(otherUserId, "Other user's todo");

      const response = await request(app)
        .get(`/todos/${otherTodo.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Todo not found');
    });
  });
});
