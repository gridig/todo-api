import request from 'supertest';
import type { Application } from 'express';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
} from '../helpers/testSetup.js';
import TodoService from '../../models/Todo.js';
import UserService from '../../models/User.js';
import { jest } from '@jest/globals';
import type { Todo } from '../../types/index.js';

const app: Application = createTestApp();

describe('Todo Error Handling', () => {
  let authToken: string;
  let userId: string;

  beforeAll(async () => {
    await connectTestDB();
    ({ authToken, userId } = await createTestUser());
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await TodoService.deleteMany();
  });

  afterAll(async () => {
    await UserService.deleteMany();
    await disconnectTestDB();
  });

  describe('Server Error Scenarios', () => {
    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should handle database errors when getting todos', async () => {
      const spy = jest
        .spyOn(TodoService, 'findByUser')
        .mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/todos').set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.message).toBe('An unexpected error occurred');

      expect(spy).toHaveBeenCalled();
    });

    it('should handle database errors when creating todos', async () => {
      const spy = jest.spyOn(TodoService, 'create').mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/todos')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ text: 'Test todo' });

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.message).toBe('An unexpected error occurred');

      expect(spy).toHaveBeenCalled();
    });

    it('should handle database errors when updating todos', async () => {
      const todo: Todo = await TodoService.create({
        text: 'Test todo',
        userId,
      });

      const spy = jest
        .spyOn(TodoService, 'toggleDone')
        .mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .patch(`/todos/${todo.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');

      spy.mockRestore();
    });

    it('should handle database errors when deleting todos', async () => {
      const todo: Todo = await TodoService.create({
        text: 'Test todo',
        userId,
      });

      const spy = jest.spyOn(TodoService, 'delete').mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .delete(`/todos/${todo.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');

      spy.mockRestore();
    });
  });
});
