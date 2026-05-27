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

describe('PATCH /todos/:id - Update Todo', () => {
  let authToken: string;
  let userId: string;
  let todoId: string;

  beforeAll(async () => {
    await connectTestDB();
    ({ authToken, userId } = await createTestUser());
  });

  beforeEach(async () => {
    const todo = await createTestTodo(userId, 'Test todo');
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
    it('should toggle todo completion status', async () => {
      const response = await request(app)
        .patch(`/todos/${todoId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.done).toBe(true);
    });
  });

  describe('Error Cases', () => {
    it('should return 404 for non-existent todo', async () => {
      const fakeId = generateFakeUUID();

      const response = await request(app)
        .patch(`/todos/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid ID format', async () => {
      const response = await request(app)
        .patch('/todos/invalid-id')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should return 404 for todo belonging to different user', async () => {
      // Create another user's todo
      const { userId: otherUserId } = await createTestUser('other@example.com');
      const otherTodo = await createTestTodo(otherUserId, "Other user's todo");

      const response = await request(app)
        .patch(`/todos/${otherTodo.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Todo not found');
    });
  });
});
