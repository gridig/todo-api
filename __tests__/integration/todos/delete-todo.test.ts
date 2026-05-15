import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
} from '../../helpers/testSetup.js';
import { createTestTodo, generateFakeUUID } from '../../helpers/todoHelpers.js';
import TodoService from '../../../models/Todo.js';
import UserService from '../../../models/User.js';
import type { Application } from 'express';

const app: Application = createTestApp();

describe('DELETE /todos/:id - Delete Todo', () => {
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
    it('should delete a todo', async () => {
      const response = await request(app)
        .delete(`/todos/${todoId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(204);

      // Verify todo is deleted
      const deletedTodo = await TodoService.findOne({ id: todoId, userId });
      expect(deletedTodo).toBeNull();
    });
  });

  describe('Error Cases', () => {
    it('should return 404 for non-existent todo', async () => {
      const fakeId = generateFakeUUID();

      const response = await request(app)
        .delete(`/todos/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid ID format', async () => {
      const response = await request(app)
        .delete('/todos/invalid-id')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should return 404 for todo belonging to different user', async () => {
      // Create another user's todo
      const { userId: otherUserId } = await createTestUser('other@example.com');
      const otherTodo = await createTestTodo(otherUserId, "Other user's todo");

      const response = await request(app)
        .delete(`/todos/${otherTodo.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Todo not found');
    });

    it('should handle concurrent delete requests gracefully', async () => {
      const deletePromise1 = request(app)
        .delete(`/todos/${todoId}`)
        .set('Authorization', `Bearer ${authToken}`);
      const deletePromise2 = request(app)
        .delete(`/todos/${todoId}`)
        .set('Authorization', `Bearer ${authToken}`);

      const [res1, res2] = await Promise.all([deletePromise1, deletePromise2]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([204, 404]); // One succeeds, one fails
    });
  });
});
