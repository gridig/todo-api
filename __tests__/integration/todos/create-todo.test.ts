import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
} from '../../helpers/testSetup.js';
import TodoService from '../../../models/Todo.js';
import UserService from '../../../models/User.js';
import type { Application } from 'express';

const app: Application = createTestApp();

describe('POST /todos - Create Todo', () => {
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
    it('should create a new todo', async () => {
      const todoData = { text: 'Buy groceries' };

      const response = await request(app)
        .post('/todos')
        .set('Authorization', `Bearer ${authToken}`)
        .send(todoData);

      expect(response.status).toBe(201);
      expect(response.body.text).toBe('Buy groceries');
      expect(response.body.done).toBe(false);
      expect(response.body.userId).toBe(userId);
    });
  });

  describe('Validation', () => {
    it('should reject empty todo text', async () => {
      const response = await request(app)
        .post('/todos')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ text: '' });

      expect(response.status).toBe(400);
    });

    it('should reject missing text field', async () => {
      const response = await request(app)
        .post('/todos')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
    });

    it('should reject request without auth token', async () => {
      const response = await request(app)
        .post('/todos')
        .send({ text: 'New Todo' });

      expect(response.status).toBe(401);
    });
  });
});
