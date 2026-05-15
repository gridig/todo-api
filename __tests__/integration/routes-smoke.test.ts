import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app.js';

describe('Route Smoke Tests', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  describe('Auth Routes', () => {
    it('POST /auth/register - validates input', async () => {
      const response = await request(app)
        .post('/auth/register')
        .send({ email: 'invalid', password: 'weak' });

      expect(response.status).toBe(400);
    });

    it('POST /auth/login - validates input', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'test', password: 'test' });

      expect(response.status).toBe(400);
    });
  });

  describe('Todo Routes', () => {
    it('GET /todos - requires authentication', async () => {
      const response = await request(app).get('/todos');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('NO_TOKEN');
    });

    it('POST /todos - requires authentication', async () => {
      const response = await request(app).post('/todos').send({ text: 'Test' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('NO_TOKEN');
    });
  });

  describe('Health Routes', () => {
    it('GET /health - responds with 200', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/unknown-route');

      expect(response.status).toBe(404);
    });
  });
});
